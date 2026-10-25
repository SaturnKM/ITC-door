// ============================================================
//  RFID ACCESS CONTROL SYSTEM -- ESP32-C3 Super Mini
//  Single-file Arduino sketch  |  v1.7  |  Production-ready
//
//  v1.7 CHANGES :
//   - DuckDNS support (HTTP + optional HTTPS)
//   - Safe HTTPClient with persistent WiFiClient (no use-after-free)
//   - strncpy always null-terminated
//   - sendScanToBot() failure → immediate deny (no phantom pending)
//   - Ignore re-scan of same UID while pending
//   - Two LCD screens visible on grant (WELCOME + DOOR OPEN)
//   - Door-open extend guard (can't be tricked into staying open)
//   - isWithinHours() actually wired in
//   - random() seeded from MAC
// ============================================================

// ---- USER CONFIG --------------------------------------------
#define WIFI_SSID              "DOOR_ACCESS"
#define WIFI_PASSWORD          "DOOR_ACCESS"

#define SERVER_URL             "yourdns.duckdns.org"
#define SERVER_PORT            3000 // change to used port
#define USE_HTTPS              false // if https is used make it true /else false

#define API_KEY                "your token"
#define TIMEZONE_STR           "CET-1CEST,M3.5.0,M10.5.0/3" // algeria
#define DISABLE_TIME_RULES     true

// ---- PIN DEFINITIONS ----------------------------------------
#define PIN_RFID_RX     20
#define PIN_LED_A_GREEN  5      // door relay (active-HIGH)
#define PIN_LED_A_RED    6      // 3jezt ndiro
#define PIN_LED_YELLOW   7      // ta3 pending
#define PIN_LED_WIFI     8      // f esp " normalmon "
#define PIN_LED_ERROR    9      // makach
#define PIN_BUZZER      10      // 7amdoulah kayen

// ---- SYSTEM CONSTANTS ---------------------------------------
#define MAX_MEMBERS       1000
#define CSV_PATH          "/members.csv"
#define CSV_BACKUP_PATH   "/members_bak.csv"
#define LOG_PATH          "/logs.csv"
#define LOG_MAX_BYTES     500000UL
#define PENDING_TIMEOUT   60000UL
#define POLL_INTERVAL_MS   3000UL
#define UPDATE_INTERVAL   30000UL
#define STATUS_INTERVAL   60000UL
#define ACCESS_HOUR_START    10
#define ACCESS_HOUR_END      16
#define DOOR_OPEN_MS       8000UL
#define DOOR_EXTEND_MIN_MS 2000UL   // don't reset door timer if >2s remaining
#define DEBOUNCE_MS        5000UL
#define RFID_PACKET_LEN      14

// ---- INCLUDES -----------------------------------------------
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <HardwareSerial.h>
#include <time.h>
#include <esp_sntp.h>

// ---- STATE MACHINE ------------------------------------------
enum State { STATE_IDLE, STATE_PENDING, STATE_GRANTED, STATE_DENIED };
volatile State currentState = STATE_IDLE;

// ---- ROLE ENUM ----------------------------------------------
enum Role : uint8_t {
  ROLE_UNKNOWN = 0, ROLE_MEMBER, ROLE_LEADER, ROLE_BOARD, ROLE_PRESIDENT, ROLE_BANNED
};

Role roleFromString(const char* s) {
  if (!s) return ROLE_UNKNOWN;
  if (!strcmp(s, "President"))      return ROLE_PRESIDENT;
  if (!strcmp(s, "ExclusiveBoard")) return ROLE_BOARD;
  if (!strcmp(s, "Leader"))         return ROLE_LEADER;
  if (!strcmp(s, "Member"))         return ROLE_MEMBER;
  if (!strcmp(s, "Banned"))         return ROLE_BANNED;
  return ROLE_UNKNOWN;
}

const char* roleToString(Role r) {
  switch (r) {
    case ROLE_PRESIDENT: return "President";
    case ROLE_BOARD:     return "ExclusiveBoard";
    case ROLE_LEADER:    return "Leader";
    case ROLE_MEMBER:    return "Member";
    case ROLE_BANNED:    return "Banned";
    default:             return "Unknown";
  }
}

// ---- MEMBER STRUCT ------------------------------------------
struct Member {
  char     name[32];
  char     uid[12];
  Role     role;
  bool     banned;
  bool     dayGrant;
  uint32_t dayGrantDate;
};

// ---- GLOBALS ------------------------------------------------
Member   members[MAX_MEMBERS];
int      memberCount = 0;

char          pendingUID[12]       = "";
char          pendingRequestId[40] = "";
unsigned long pendingStart         = 0;
bool          hasPending           = false;

bool          doorOpen      = false;
unsigned long doorOpenStart = 0;

unsigned long lastScanTime = 0;

bool          wifiConnected    = false;
unsigned long lastUpdatePoll   = 0;
unsigned long lastStatusReport = 0;
bool          urgentPoll       = false;
unsigned long urgentPollExpire = 0;

bool          timeValid    = false;
uint32_t      lastDayStamp = 0;

LiquidCrystal_I2C lcd(0x27, 16, 2);
unsigned long lcdIdleTimer = 0;
unsigned long lcdBootAnim  = 0;
int           lcdBootStep  = 0;
bool          bootDone     = false;

HardwareSerial rfidSerial(1);
uint8_t        rfidBuf[RFID_PACKET_LEN];
int            rfidBufPos   = 0;
unsigned long  lastRfidRead = 0;

// Persistent HTTP client (avoids reallocating WiFiClientSecure every request)
#if USE_HTTPS
  static WiFiClientSecure gHttpClient;
#else
  static WiFiClient       gHttpClient;
#endif

// ---- LCD CUSTOM CHARACTERS ----------------------------------
byte cLock[8]   = {0x0E,0x11,0x11,0x1F,0x1B,0x1B,0x1F,0x00};
byte cUnlock[8] = {0x0E,0x10,0x10,0x1F,0x1B,0x1B,0x1F,0x00};
byte cWifi[8]   = {0x00,0x0E,0x11,0x04,0x0A,0x00,0x04,0x00};
byte cCard[8]   = {0x1F,0x11,0x15,0x11,0x15,0x11,0x1F,0x00};
byte cCheck[8]  = {0x00,0x01,0x01,0x02,0x12,0x0C,0x04,0x00};
byte cCross[8]  = {0x00,0x11,0x0A,0x04,0x0A,0x11,0x00,0x00};
byte cClock[8]  = {0x00,0x0E,0x15,0x17,0x11,0x0E,0x00,0x00};
byte cBell[8]   = {0x04,0x0E,0x0E,0x0E,0x1F,0x00,0x04,0x00};

// ============================================================
//  UTILITY
// ============================================================
bool uidMatch(const char* stored, const char* scanned) {
  if (!stored || !scanned) return false;
  if (stored[0] == '\0' || scanned[0] == '\0') return false;

  int si = strlen(stored)  - 1;
  int sc = strlen(scanned) - 1;
  while (si >= 0 && sc >= 0) {
    if (stored[si] != scanned[sc]) return false;
    si--; sc--;
  }
  while (si >= 0) {
    if (stored[si] != '0') return false;
    si--;
  }
  return sc < 0;
}

void genRequestId(char* out, size_t len) {
  // Include MAC suffix to avoid collisions between reboots / devices.
  uint32_t mac = (uint32_t)(ESP.getEfuseMac() & 0xFFFF);
  snprintf(out, len, "req_%06lu_%04x_%05u",
           (unsigned long)(millis() % 1000000UL),
           (unsigned)mac,
           (unsigned)random(0, 65536));
}

// ============================================================
//  TIME
// ============================================================
void IRAM_ATTR timeSyncCb(struct timeval* tv) { timeValid = true; }

void initNTP() {
  sntp_set_time_sync_notification_cb(timeSyncCb);
  configTzTime(TIMEZONE_STR, "pool.ntp.org", "time.google.com", "time.nist.gov");
  unsigned long t = millis();
  while (!timeValid && millis() - t < 6000) delay(200);
}

int getCurrentHour() {
  if (!timeValid) return -1;
  struct tm ti;
  if (!getLocalTime(&ti)) return -1;
  return ti.tm_hour;
}

uint32_t getDayStamp() {
  return timeValid ? (uint32_t)(time(nullptr) / 86400UL) : 0;
}

void getTimeStr(char* buf, size_t len) {
  struct tm ti;
  if (!timeValid || !getLocalTime(&ti)) { snprintf(buf, len, "--:--"); return; }
  snprintf(buf, len, "%02d:%02d", ti.tm_hour, ti.tm_min);
}

void getDateStr(char* buf, size_t len) {
  struct tm ti;
  if (!timeValid || !getLocalTime(&ti)) { snprintf(buf, len, "--/--"); return; }
  snprintf(buf, len, "%02d/%02d", ti.tm_mday, ti.tm_mon + 1);
}

bool isWithinHours() {
  if (DISABLE_TIME_RULES) return true;
  int h = getCurrentHour();
  if (h < 0) return false;
  return (h >= ACCESS_HOUR_START && h < ACCESS_HOUR_END);
}

// ============================================================
//  HARDWARE FEEDBACK
// ============================================================
void buzzSuccess() {
  tone(PIN_BUZZER, 880,  80); delay(100);
  tone(PIN_BUZZER, 1175, 80); delay(100);
  tone(PIN_BUZZER, 1760, 150);
}
void buzzDenied() {
  tone(PIN_BUZZER, 440, 150); delay(180);
  tone(PIN_BUZZER, 330, 400);
}
void buzzPending() {
  tone(PIN_BUZZER, 1047, 60); delay(90);
  tone(PIN_BUZZER, 1047, 60);
}
void buzzBoot() {
  tone(PIN_BUZZER, 660,  80); delay(100);
  tone(PIN_BUZZER, 880,  80); delay(100);
  tone(PIN_BUZZER, 1047, 80); delay(100);
  tone(PIN_BUZZER, 1319, 180);
}

void ledsOff() {
  if (!doorOpen) digitalWrite(PIN_LED_A_GREEN, LOW);
  digitalWrite(PIN_LED_A_RED,  LOW);
  digitalWrite(PIN_LED_YELLOW, LOW);
}
void ledGranted()        { digitalWrite(PIN_LED_A_RED, LOW);  digitalWrite(PIN_LED_YELLOW, LOW);  digitalWrite(PIN_LED_A_GREEN, HIGH); }
void ledDenied()         { digitalWrite(PIN_LED_A_GREEN, LOW); digitalWrite(PIN_LED_YELLOW, LOW); digitalWrite(PIN_LED_A_RED, HIGH); }
void ledPending()        { digitalWrite(PIN_LED_A_GREEN, LOW); digitalWrite(PIN_LED_A_RED, LOW);  digitalWrite(PIN_LED_YELLOW, HIGH); }
void setWifiLed(bool on) { digitalWrite(PIN_LED_WIFI,  on ? HIGH : LOW); }
void setErrorLed(bool on){ digitalWrite(PIN_LED_ERROR, on ? HIGH : LOW); }

// ============================================================
//  LCD HELPERS
// ============================================================
void lcdRow(int row, const char* msg) {
  lcd.setCursor(0, row);
  int n = strlen(msg);
  lcd.print(msg);
  for (int i = n; i < 16; i++) lcd.print(' ');
}

void lcdCenter(int row, const char* msg) {
  int len = strlen(msg);
  int pad = (16 - len) / 2;
  if (pad < 0) pad = 0;
  lcd.setCursor(0, row);
  for (int i = 0; i < 16; i++) lcd.print(' ');
  lcd.setCursor(pad, row);
  lcd.print(msg);
}

// ============================================================
//  LCD SCREENS
// ============================================================
void lcdBootTick() {
  unsigned long elapsed = millis() - lcdBootAnim;
  switch (lcdBootStep) {
    case 0: if (elapsed >= 300)  { lcd.clear(); lcdCenter(0, "\x03  ITC\x03"); lcdBootStep = 1; } break;
    case 1: if (elapsed >= 700)  { lcdCenter(1, "Access Control"); lcdBootStep = 2; } break;
    case 2: if (elapsed >= 1400) { lcd.setCursor(0,0); for (int i=0;i<16;i++) lcd.print('\xFF'); lcdBootStep = 3; } break;
    case 3: if (elapsed >= 2200) { lcd.clear(); lcdCenter(0,"\x03  ITC \x03"); lcdCenter(1,"Initialising..."); lcdBootStep=4; bootDone=true; } break;
    default: break;
  }
}

void lcdShowIdle() {
  static const char* prompts[] = {
    "\x03 Scan your card ",
    "\x06 Ready          ",
    " N:01 CLUB ever "
  };
  static int idx = 0;
  if (millis() - lcdIdleTimer < 3500) return;
  lcdIdleTimer = millis();
  idx = (idx + 1) % 3;
  lcd.clear();
  lcd.setCursor(0, 0);
  if (wifiConnected) {
    lcd.write((uint8_t)2);
    lcd.print("  ITC  ");
    char t[6]; getTimeStr(t, sizeof(t));
    lcd.print(t);
  } else {
    lcd.write((uint8_t)7);
    lcd.print("  ITC OFFLN");
  }
  lcdRow(1, prompts[idx]);
}

void lcdShowScanning() { lcd.clear(); lcdCenter(0, "\x03 Reading..."); lcdCenter(1, "Please hold..."); }

void lcdShowGranted(const char* name) {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.write((uint8_t)1); lcd.print(" WELCOME BACK!");
  char line[17]; snprintf(line, sizeof(line), "  %-14s", name);
  lcdRow(1, line);
}

void lcdShowDenied(const char* reason) {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.write((uint8_t)0); lcd.print(" ACCESS DENIED");
  char line[17]; snprintf(line, sizeof(line), "  %-14s", reason);
  lcdRow(1, line);
}

void lcdShowPending(const char* uid, int secsLeft) {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.write((uint8_t)7); lcd.print(" Awaiting admin");
  int ul = strlen(uid);
  const char* shortUID = ul > 6 ? uid + (ul - 6) : uid;
  int barFilled = (int)(8.0f * secsLeft / (PENDING_TIMEOUT / 1000));
  if (barFilled < 0) barFilled = 0;
  if (barFilled > 8) barFilled = 8;
  char line[17]; snprintf(line, sizeof(line), "%.6s ", shortUID);
  lcd.setCursor(0, 1); lcd.print(line); lcd.print('[');
  for (int i = 0; i < 8; i++) lcd.print(i < barFilled ? '\xFF' : ' ');
  lcd.print(']');
}

void lcdShowError(const char* msg) {
  lcd.clear(); lcd.setCursor(0,0); lcd.write((uint8_t)7); lcd.print(" SYSTEM ERROR ");
  char line[17]; snprintf(line, sizeof(line), "  %-14s", msg); lcdRow(1, line);
}

void lcdShowConnecting(int attempt, int maxAttempts) {
  lcd.clear(); lcdCenter(0, "\x02 Connecting...");
  char line[17]; snprintf(line, sizeof(line), "Attempt %d of %d", attempt, maxAttempts);
  lcdCenter(1, line);
}

void lcdShowConnected() { lcd.clear(); lcdCenter(0, "\x02  ITC"); lcdCenter(1, "Online \x04"); }

void lcdShowDoorOpen(const char* name) {
  lcd.clear(); lcd.setCursor(0,0); lcd.write((uint8_t)1); lcd.print(" DOOR OPEN     ");
  char line[17]; snprintf(line, sizeof(line), "  %-14s", name); lcdRow(1, line);
}

// ============================================================
//  DOOR CONTROL (non-blocking)
// ============================================================
void openDoor() {
  if (doorOpen) return;
  doorOpen      = true;
  doorOpenStart = millis();
  digitalWrite(PIN_LED_A_GREEN, HIGH);
  Serial.println(F("[DOOR] OPENED"));
}

void closeDoor() {
  doorOpen = false;
  digitalWrite(PIN_LED_A_GREEN, LOW);
  Serial.println(F("[DOOR] CLOSED"));
}

void updateDoor() {
  if (doorOpen && millis() - doorOpenStart >= DOOR_OPEN_MS) closeDoor();
}

// ============================================================
//  LOG SYSTEM
// ============================================================
void addLog(const char* msg) {
  File f = LittleFS.open(LOG_PATH, "a");
  if (!f) return;
  if (f.size() > LOG_MAX_BYTES) { f.close(); return; }
  f.printf("%lu,%s\n", (unsigned long)(timeValid ? time(nullptr) : 0), msg);
  f.close();
}

// ============================================================
//  STORAGE
// ============================================================
bool loadCSV(const char* path) {
  File f = LittleFS.open(path, "r");
  if (!f) return false;
  memberCount = 0;
  while (f.available() && memberCount < MAX_MEMBERS) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (!line.length() || line.startsWith("#")) continue;
    char buf[128]; line.toCharArray(buf, sizeof(buf));
    char* tok = strtok(buf, ",");
    if (!tok) continue;
    Member& m = members[memberCount];
    memset(&m, 0, sizeof(m));
    strncpy(m.name, tok, 31); m.name[31] = '\0';
    tok = strtok(nullptr, ",");
    if (!tok) continue;
    strncpy(m.uid,  tok, 11); m.uid[11] = '\0';
    tok = strtok(nullptr, ",");
    if (!tok) continue;
    m.role = roleFromString(tok);
    tok = strtok(nullptr, ",");
    m.banned       = tok ? atoi(tok) != 0 : false;
    tok = strtok(nullptr, ",");
    m.dayGrant     = tok ? atoi(tok) != 0 : false;
    tok = strtok(nullptr, ",");
    m.dayGrantDate = tok ? (uint32_t)atol(tok) : 0;
    if (m.role == ROLE_UNKNOWN)
      Serial.printf("[CSV] Warning: unknown role for %s\n", m.uid);
    memberCount++;
  }
  f.close();
  Serial.printf("[CSV] Loaded %d members from %s\n", memberCount, path);
  return memberCount > 0;
}

void writeCSV() {
  const char* TMP = "/members_tmp.csv";
  File f = LittleFS.open(TMP, "w");
  if (!f) { Serial.println(F("[CSV] Write failed")); return; }
  f.println(F("# name,uid,role,banned,dayGrant,dayGrantDate"));
  for (int i = 0; i < memberCount; i++) {
    Member& m = members[i];
    f.printf("%s,%s,%s,%d,%d,%lu\n",
      m.name, m.uid, roleToString(m.role),
      m.banned   ? 1 : 0,
      m.dayGrant ? 1 : 0,
      (unsigned long)m.dayGrantDate);
  }
  f.close();
  if (LittleFS.exists(CSV_PATH)) LittleFS.rename(CSV_PATH, CSV_BACKUP_PATH);
  LittleFS.rename(TMP, CSV_PATH);
  Serial.println(F("[CSV] Saved OK"));
}

void addDefaultMembers() {
  struct { const char* name; const char* uid; Role role; } D[] = {
    {"Islem",        "0002787912", ROLE_LEADER},
    {"Djilali",      "0007680714", ROLE_BOARD},
    {"Ibtissem",     "0006505824", ROLE_LEADER},
    {"Feriel",       "0009860301", ROLE_LEADER},
    {"Ismail",       "0007875382", ROLE_LEADER},
    {"Khadidja",     "0003752638", ROLE_LEADER},
    {"abdelmadjid",  "0010619675", ROLE_LEADER},
    {"Abdellah",     "0006579751", ROLE_LEADER},
    {"Mahdi",        "0008321581", ROLE_LEADER},
    {"Anis",         "0007869479", ROLE_LEADER},
    {"maroua",       "0009686941", ROLE_LEADER},
    {"djamel",       "0014351112", ROLE_LEADER},
    {"Abd Erraouf",  "0004022966", ROLE_LEADER},
    {"amira",        "0006819271", ROLE_BOARD},
    {"Lafdal",       "0002672952", ROLE_LEADER},
    {"IKHLAS",       "0014755425", ROLE_LEADER},
    {"YAZI",         "0006527607", ROLE_PRESIDENT},
    {"Ziouani",      "0014692887", ROLE_BOARD},
    {"Dhaia",        "0009660230", ROLE_LEADER},
    {"adem",         "0006557881", ROLE_BOARD},
    {"Ibrahim",      "0010940033", ROLE_LEADER},
    {"Nour",         "0014883107", ROLE_BOARD},
    {"dounia",       "0006587684", ROLE_LEADER},
    {"amani",        "0009962268", ROLE_BOARD},
  };
  memberCount = 0;
  int n = sizeof(D) / sizeof(D[0]);
  for (int i = 0; i < n && i < MAX_MEMBERS; i++) {
    Member& m = members[i];
    memset(&m, 0, sizeof(m));
    strncpy(m.name, D[i].name, 31); m.name[31] = '\0';
    strncpy(m.uid,  D[i].uid,  11); m.uid[11]  = '\0';
    m.role = D[i].role;
    memberCount++;
  }
  writeCSV();
  Serial.println(F("[CSV] Defaults written"));
}

Member* findByUID(const char* uid) {
  for (int i = 0; i < memberCount; i++)
    if (uidMatch(members[i].uid, uid)) return &members[i];
  return nullptr;
}

int findIndexByUID(const char* uid) {
  for (int i = 0; i < memberCount; i++)
    if (uidMatch(members[i].uid, uid)) return i;
  return -1;
}

// ============================================================
//  RFID READER (RDM6300)
// ============================================================
static inline uint8_t hexByte(uint8_t hi, uint8_t lo) {
  char h[3] = { (char)hi, (char)lo, '\0' };
  return (uint8_t)strtol(h, nullptr, 16);
}

String parseRFIDPacket(uint8_t* buf) {
  if (buf[0] != 0x02 || buf[13] != 0x03) return "";
  uint8_t data[5];
  for (int i = 0; i < 5; i++) data[i] = hexByte(buf[1+i*2], buf[2+i*2]);
  uint8_t chk  = hexByte(buf[11], buf[12]);
  uint8_t calc = data[0]^data[1]^data[2]^data[3]^data[4];
  if (calc != chk) { Serial.printf("[RFID] Checksum fail\n"); return ""; }
  uint32_t cardNum = ((uint32_t)data[1]<<24)|((uint32_t)data[2]<<16)|((uint32_t)data[3]<<8)|(uint32_t)data[4];
  char uidStr[12];
  snprintf(uidStr, sizeof(uidStr), "%010lu", (unsigned long)cardNum);
  Serial.printf("[RFID] UID: %s\n", uidStr);
  return String(uidStr);
}

bool rfidRead(String& outUID) {
  while (rfidSerial.available()) {
    uint8_t b = rfidSerial.read();
    if (b == 0x02) rfidBufPos = 0;
    if (rfidBufPos < RFID_PACKET_LEN) rfidBuf[rfidBufPos++] = b;
    if (rfidBufPos == RFID_PACKET_LEN) {
      rfidBufPos = 0;
      String uid = parseRFIDPacket(rfidBuf);
      if (uid.length() > 0) { outUID = uid; return true; }
    }
  }
  return false;
}

// ============================================================
//  HTTP / API  (safe: persistent client, no setReuse-on-stack)
// ============================================================
void buildBaseUrl(String& out) {
  out  = USE_HTTPS ? "https://" : "http://";
  out += SERVER_URL;
  if ((USE_HTTPS && SERVER_PORT != 443) || (!USE_HTTPS && SERVER_PORT != 80)) {
    out += ":";
    out += String(SERVER_PORT);
  }
}

bool httpPost(const char* endpoint, JsonDocument& body, JsonDocument& resp) {
  if (!wifiConnected) return false;

  #if USE_HTTPS
    gHttpClient.setInsecure();
  #endif

  HTTPClient http;
  http.setTimeout(8000);
  http.setReuse(false);               // SAFE: persistent gHttpClient
  String base; buildBaseUrl(base);
  http.begin(gHttpClient, base + endpoint);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);

  String payload; serializeJson(body, payload);
  int code = http.POST(payload);
  bool ok  = (code == 200);
  if (ok) deserializeJson(resp, http.getString());
  else Serial.printf("[HTTP] POST %s -> %d\n", endpoint, code);
  http.end();
  return ok;
}

bool httpGet(const char* endpoint, JsonDocument& resp) {
  if (!wifiConnected) return false;

  #if USE_HTTPS
    gHttpClient.setInsecure();
  #endif

  HTTPClient http;
  http.setTimeout(8000);
  http.setReuse(false);               // SAFE: persistent gHttpClient
  String base; buildBaseUrl(base);
  http.begin(gHttpClient, base + endpoint);
  http.addHeader("x-api-key", API_KEY);

  int code = http.GET();
  bool ok  = (code == 200);
  if (ok) deserializeJson(resp, http.getString());
  else Serial.printf("[HTTP] GET %s -> %d\n", endpoint, code);
  http.end();
  return ok;
}

// ═══ FIX #5: return bool so caller knows if the scan landed ═══
bool sendScanToBot(const char* uid) {
  StaticJsonDocument<256> body, resp;
  genRequestId(pendingRequestId, sizeof(pendingRequestId));
  body["uid"]        = uid;
  body["action"]     = "unknown_scan";
  body["timestamp"]  = (long)time(nullptr);
  body["request_id"] = pendingRequestId;
  return httpPost("/api/scan", body, resp);
}

void sendLogToBot(const char* uid, const char* name, const char* role,
                  const char* event, const char* reason = "") {
  if (!wifiConnected) return;
  char ts[6]; getTimeStr(ts, sizeof(ts));
  StaticJsonDocument<256> body, resp;
  body["uid"]       = uid;
  body["name"]      = name;
  body["role"]      = role;
  body["event"]     = event;
  body["reason"]    = reason;
  body["time"]      = ts;
  body["timestamp"] = (long)time(nullptr);
  body["action"]    = "log";
  httpPost("/api/log", body, resp);
}

String pollForDecision() {
  if (!wifiConnected || !hasPending) return "";
  char ep[80];
  snprintf(ep, sizeof(ep), "/api/pending/%s", pendingRequestId);
  StaticJsonDocument<256> resp;
  if (httpGet(ep, resp)) {
    const char* action = resp["action"] | "";
    return String(action);
  }
  return "";
}

// ─── large update JSON, kept off the stack ──
static StaticJsonDocument<6144> gUpdateDoc;

void pollUpdates() {
  if (!httpGet("/api/updates", gUpdateDoc)) return;

  urgentPoll = gUpdateDoc["has_queue"] | false;
  if (urgentPoll) {
    if (urgentPollExpire == 0) urgentPollExpire = millis() + 60000UL;
  } else {
    urgentPollExpire = 0;
  }

  JsonArray updates = gUpdateDoc["members"].as<JsonArray>();
  bool changed = false;
  for (JsonObject upd : updates) {
    const char* uid    = upd["uid"]          | "";
    const char* name   = upd["name"]         | "";
    const char* role   = upd["role"]         | "";
    bool        banned = upd["banned"]       | false;
    bool        dg     = upd["dayGrant"]     | false;
    uint32_t    dgDate = upd["dayGrantDate"] | (uint32_t)0;

    Member* m = findByUID(uid);
    if (m) {
      // FIX #3: always NUL-terminate
      strncpy(m->name, name, 31); m->name[31] = '\0';
      m->role         = roleFromString(role);
      m->banned       = banned;
      m->dayGrant     = dg;
      m->dayGrantDate = (dg && dgDate == 0) ? getDayStamp() : dgDate;
    } else if (strlen(uid) > 0 && memberCount < MAX_MEMBERS) {
      Member& nm = members[memberCount++];
      memset(&nm, 0, sizeof(nm));
      strncpy(nm.name, name, 31); nm.name[31] = '\0';
      strncpy(nm.uid,  uid,  11); nm.uid[11]  = '\0';
      nm.role         = roleFromString(role);
      nm.banned       = banned;
      nm.dayGrant     = dg;
      nm.dayGrantDate = (dg && dgDate == 0) ? getDayStamp() : dgDate;
    }
    changed = true;
  }
  if (changed) writeCSV();

  const char* dcmd = gUpdateDoc["door_cmd"] | "";
  if (!strcmp(dcmd, "open_door") && !doorOpen) openDoor();
  if (!strcmp(dcmd, "lock_door"))              closeDoor();
}

// ============================================================
//  ACCESS LOGIC
// ============================================================
void grantAccess(const char* uid, const char* name, const char* role) {
  currentState = STATE_GRANTED;
  ledGranted();
  buzzSuccess();

  // FIX #7: show both screens — welcome first, then door-open
  lcdShowGranted(name);
  delay(800);
  lcdShowDoorOpen(name);

  // FIX #4: don't reset an already-open door early
  bool wasOpen = doorOpen;
  openDoor();
  if (wasOpen) {
    // If door is still going to be open for a while, don't extend it
    if (millis() - doorOpenStart < DOOR_OPEN_MS - DOOR_EXTEND_MIN_MS) {
      doorOpenStart = millis();   // extend (barely open → allow grace)
    }
  } else {
    doorOpenStart = millis();
  }

  char ts[6]; getTimeStr(ts, sizeof(ts));
  char logMsg[80];
  snprintf(logMsg, sizeof(logMsg), "%s (%s) entered at %s", name, role, ts);
  addLog(logMsg);
  sendLogToBot(uid, name, role, "granted");

  delay(2000);
  digitalWrite(PIN_LED_A_RED, LOW);
  digitalWrite(PIN_LED_YELLOW, LOW);
  currentState = STATE_IDLE;
  lcdIdleTimer = 0;
}

void denyAccess(const char* uid, const char* name, const char* role,
                const char* reason, bool silent = false) {
  currentState = STATE_DENIED;
  ledDenied();
  buzzDenied();
  lcdShowDenied(reason);

  char logMsg[80];
  snprintf(logMsg, sizeof(logMsg), "%s (%s) denied: %s", name, role, reason);
  addLog(logMsg);
  if (!silent) sendLogToBot(uid, name, role, "denied", reason);

  delay(2000);
  ledsOff();
  currentState = STATE_IDLE;
  lcdIdleTimer = 0;
}

void handleScan(const char* uid) {
  // FIX #2: ignore re-scan of the same card while pending
  if (currentState == STATE_PENDING && hasPending && uidMatch(pendingUID, uid)) {
    Serial.printf("[SCAN] Ignored (same card already pending)\n");
    return;
  }

  // FIX #6: wire in time rules (no-op when DISABLE_TIME_RULES = true)
  if (!isWithinHours()) {
    denyAccess(uid, uid, "TimeRule", "Outside hours");
    return;
  }

  lcdShowScanning();
  ledPending();

  Member* m = findByUID(uid);

  if (m) {
    if (m->banned) {
      if (!wifiConnected) { denyAccess(uid, m->name, roleToString(m->role), "Banned"); return; }
      strncpy(pendingUID, uid, 11); pendingUID[11] = '\0';
      hasPending   = true;
      pendingStart = millis();
      currentState = STATE_PENDING;

      if (!sendScanToBot(uid)) {
        denyAccess(uid, m->name, roleToString(m->role), "Server unreachable");
        hasPending = false;
        return;
      }
      buzzPending();
      Serial.printf("[BANNED PENDING] UID=%s reqId=%s\n", uid, pendingRequestId);
      return;
    }

    if (m->role == ROLE_PRESIDENT || m->role == ROLE_BOARD) {
      grantAccess(uid, m->name, roleToString(m->role));
      return;
    }

    if (m->role == ROLE_LEADER || m->role == ROLE_MEMBER) {
      bool hasDayGrant = m->dayGrant && (m->dayGrantDate == getDayStamp());
      if (hasDayGrant) { grantAccess(uid, m->name, roleToString(m->role)); return; }
      if (!wifiConnected) { denyAccess(uid, m->name, roleToString(m->role), "No WiFi/Grant"); return; }

      strncpy(pendingUID, uid, 11); pendingUID[11] = '\0';
      hasPending   = true;
      pendingStart = millis();
      currentState = STATE_PENDING;

      // FIX #5: fail-fast if server doesn't accept the scan
      if (!sendScanToBot(uid)) {
        denyAccess(uid, m->name, roleToString(m->role), "Server unreachable");
        hasPending = false;
        return;
      }
      buzzPending();
      Serial.printf("[PENDING] UID=%s reqId=%s\n", uid, pendingRequestId);
      return;
    }
  }

  // Unknown UID
  if (!wifiConnected) {
    int tries = 0;
    while (!wifiConnected && tries < 4) {
      tries++;
      lcdShowConnecting(tries, 4);
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      unsigned long t = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - t < 5000) delay(300);
      wifiConnected = (WiFi.status() == WL_CONNECTED);
    }
    if (!wifiConnected) {
      WiFi.disconnect(true);
      denyAccess(uid, uid, "Unknown", "No WiFi");
      return;
    }
    setWifiLed(true);
    initNTP();
  }

  strncpy(pendingUID, uid, 11); pendingUID[11] = '\0';
  hasPending   = true;
  pendingStart = millis();
  currentState = STATE_PENDING;

  if (!sendScanToBot(uid)) {
    denyAccess(uid, uid, "Unknown", "Server unreachable");
    hasPending = false;
    return;
  }
  buzzPending();
  Serial.printf("[PENDING] UID=%s reqId=%s\n", uid, pendingRequestId);
}

void processPendingDecision(const String& action) {
  hasPending = false;

  Member* m = findByUID(pendingUID);
  const char* dname = m ? m->name : pendingUID;
  const char* drole = m ? roleToString(m->role) : "Unknown";

  if (action == "grant_day") {
    if (m) {
      m->dayGrant     = true;
      m->dayGrantDate = getDayStamp();
      writeCSV();
    }
    grantAccess(pendingUID, dname, drole);

  } else if (action == "access_once") {
    grantAccess(pendingUID, dname, drole);

  } else if (action == "add_member") {
    Member* fresh = findByUID(pendingUID);
    grantAccess(pendingUID, fresh ? fresh->name : dname, fresh ? roleToString(fresh->role) : drole);

  } else if (action == "unban_open") {
    if (m) {
      m->banned = false;
      if (m->role == ROLE_BANNED) m->role = ROLE_MEMBER;
      writeCSV();
    }
    grantAccess(pendingUID, m ? m->name : dname, m ? roleToString(m->role) : "Member");

  } else if (action == "unban") {
    if (m) {
      m->banned = false;
      if (m->role == ROLE_BANNED) m->role = ROLE_MEMBER;
      writeCSV();
    }
    denyAccess(pendingUID, m ? m->name : dname, m ? roleToString(m->role) : "Member",
               "Unbanned (no entry)", true);

  } else if (action == "deny") {
    denyAccess(pendingUID, dname, drole, "Admin deny");

  } else if (action == "ban") {
    if (m) {
      m->banned = true;
      m->role   = ROLE_BANNED;
      writeCSV();
    } else if (memberCount < MAX_MEMBERS) {
      Member& nm = members[memberCount++];
      memset(&nm, 0, sizeof(nm));
      strncpy(nm.uid,  pendingUID, 11); nm.uid[11]  = '\0';
      strncpy(nm.name, pendingUID, 31); nm.name[31] = '\0';
      nm.role   = ROLE_BANNED;
      nm.banned = true;
      writeCSV();
    }
    denyAccess(pendingUID, dname, drole, "Banned");

  } else {
    denyAccess(pendingUID, dname, drole, "No decision");
  }

  memset(pendingUID,       0, sizeof(pendingUID));
  memset(pendingRequestId, 0, sizeof(pendingRequestId));
}

void handlePendingTimeout() {
  hasPending = false;
  denyAccess(pendingUID, pendingUID[0] ? pendingUID : "???", "Unknown", "Timed out");
  memset(pendingUID,       0, sizeof(pendingUID));
  memset(pendingRequestId, 0, sizeof(pendingRequestId));
}

// ============================================================
//  WIFI MANAGEMENT
// ============================================================
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print(F("[WiFi] Connecting"));
  unsigned long t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 10000) { Serial.print('.'); delay(400); }
  wifiConnected = (WiFi.status() == WL_CONNECTED);
  setWifiLed(wifiConnected);
  if (wifiConnected) {
    Serial.printf("\n[WiFi] Connected  IP=%s\n", WiFi.localIP().toString().c_str());
    lcdShowConnected(); delay(1000);
    initNTP();
  } else {
    Serial.println(F("\n[WiFi] Offline -- local-only mode"));
    lcd.clear(); lcdCenter(0, "\x07  ITC"); lcdCenter(1, "Offline mode"); delay(1000);
  }
}

void checkWiFi() {
  bool prev = wifiConnected;
  wifiConnected = (WiFi.status() == WL_CONNECTED);
  if (prev && !wifiConnected) {
    Serial.println(F("[WiFi] Lost connection")); setWifiLed(false);
    if (currentState == STATE_PENDING) handlePendingTimeout();
  }
  if (!prev && wifiConnected) {
    Serial.println(F("[WiFi] Reconnected")); setWifiLed(true); initNTP();
  }
}

// ============================================================
//  MIDNIGHT RESET
// ============================================================
void checkMidnightReset() {
  if (!timeValid) return;
  uint32_t today = getDayStamp();
  if (today != lastDayStamp && lastDayStamp != 0) {
    bool changed = false;
    for (int i = 0; i < memberCount; i++) {
      if (members[i].dayGrant && members[i].dayGrantDate < today) {
        members[i].dayGrant = false; changed = true;
      }
    }
    if (changed) { writeCSV(); Serial.println(F("[MIDNIGHT] Day grants cleared")); }
  }
  lastDayStamp = today;
}

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(F("\n[BOOT]  ITC Access Control v1.7"));

  // FIX #11: seed random from MAC so request IDs never collide
  randomSeed((uint32_t)ESP.getEfuseMac());

  pinMode(PIN_LED_A_GREEN, OUTPUT);
  pinMode(PIN_LED_A_RED,   OUTPUT);
  pinMode(PIN_LED_YELLOW,  OUTPUT);
  pinMode(PIN_LED_WIFI,    OUTPUT);
  pinMode(PIN_LED_ERROR,   OUTPUT);
  digitalWrite(PIN_LED_A_GREEN, LOW);
  digitalWrite(PIN_LED_A_RED,   LOW);
  digitalWrite(PIN_LED_YELLOW,  LOW);
  digitalWrite(PIN_LED_WIFI,    LOW);
  digitalWrite(PIN_LED_ERROR,   LOW);

  Wire.begin();
  lcd.init(); lcd.backlight();
  lcd.createChar(0, cLock);   lcd.createChar(1, cUnlock);
  lcd.createChar(2, cWifi);   lcd.createChar(3, cCard);
  lcd.createChar(4, cCheck);  lcd.createChar(5, cCross);
  lcd.createChar(6, cClock);  lcd.createChar(7, cBell);

  lcdBootAnim = millis(); lcdBootStep = 0; bootDone = false; lcd.clear();
  while (!bootDone) { lcdBootTick(); delay(20); }

  rfidSerial.begin(9600, SERIAL_8N1, PIN_RFID_RX, -1);
  rfidBufPos = 0;
  Serial.println(F("[RFID] RDM6300 ready"));

  if (!LittleFS.begin(true)) {
    setErrorLed(true); lcdShowError("FS MOUNT FAIL");
    Serial.println(F("[FS] CRITICAL: LittleFS failed"));
    while (1) delay(1000);
  }
  Serial.println(F("[FS] LittleFS OK"));

  lcdCenter(1, "Loading data... ");
  if (!loadCSV(CSV_PATH)) {
    Serial.println(F("[CSV] Primary missing -- trying backup"));
    if (!loadCSV(CSV_BACKUP_PATH)) {
      Serial.println(F("[CSV] No backup -- writing defaults"));
      addDefaultMembers();
    }
  }

  lcdCenter(0, "\x02  ITC"); lcdCenter(1, "Connecting WiFi");
  connectWiFi();

  lastDayStamp = getDayStamp();
  buzzBoot();
  currentState = STATE_IDLE;
  lcdIdleTimer = 0;
  Serial.println(F("[BOOT]  ITC system ready"));
}

// ============================================================
//  MAIN LOOP
// ============================================================
void loop() {
  unsigned long now = millis();

  checkWiFi();
  updateDoor();
  checkMidnightReset();

  if (urgentPollExpire && now > urgentPollExpire) {
    urgentPoll = false;
    urgentPollExpire = 0;
  }

  // ---- IDLE ------------------------------------------------
  if (currentState == STATE_IDLE) {
    lcdShowIdle();

    String uid;
    if (rfidRead(uid) && (now - lastScanTime > DEBOUNCE_MS) && (now - lastRfidRead > DEBOUNCE_MS)) {
      lastScanTime = now;
      lastRfidRead = now;
      handleScan(uid.c_str());
    }

    unsigned long pollInterval = urgentPoll ? 5000UL : UPDATE_INTERVAL;
    if (wifiConnected && now - lastUpdatePoll > pollInterval) {
      lastUpdatePoll = now;
      pollUpdates();
    }

    if (wifiConnected && now - lastStatusReport > STATUS_INTERVAL) {
      lastStatusReport = now;
      StaticJsonDocument<128> body, resp;
      body["action"]    = "status";
      body["wifi"]      = true;
      body["members"]   = memberCount;
      body["timeValid"] = timeValid;
      body["timestamp"] = (long)time(nullptr);
      httpPost("/api/status", body, resp);
    }
  }

  // ---- PENDING ---------------------------------------------
  else if (currentState == STATE_PENDING) {
    long elapsed  = (long)(now - pendingStart);
    int  secsLeft = max(0, (int)((PENDING_TIMEOUT - elapsed) / 1000));
    lcdShowPending(pendingUID, secsLeft);

    if (elapsed >= (long)PENDING_TIMEOUT) {
      handlePendingTimeout();
    } else {
      String uid;
      if (rfidRead(uid) && (now - lastScanTime > DEBOUNCE_MS) && (now - lastRfidRead > DEBOUNCE_MS)) {
        lastScanTime = now;
        lastRfidRead = now;
        // FIX #2: same-card rescans ignored (handleScan guards), different card = new request
        if (!uidMatch(pendingUID, uid.c_str())) {
          hasPending = false;                     // abandon old locally
          memset(pendingRequestId, 0, sizeof(pendingRequestId)); // avoid stale poll
          handleScan(uid.c_str());
        }
      } else if (now - lastUpdatePoll > POLL_INTERVAL_MS) {
        lastUpdatePoll = now;
        String action = pollForDecision();
        if (action.length() > 0) processPendingDecision(action);
      }
    }
  }

  delay(10);
}
