// ============================================================
//  RFID ACCESS CONTROL SYSTEM -- ESP32-C3 Super Mini
//  Single-file Arduino sketch  |  v1.6  |  Production-ready
// ============================================================

// ---- USER CONFIG --------------------------------------------
#define WIFI_SSID              "DOOR_ACCESS"
#define WIFI_PASSWORD          "DOOR_ACCESS"
#define SERVER_URL             "http://192.168.1.8:3000"
#define API_KEY                "hgougYUGTYOUGGyouyouTYOUg54f564sd51414..45_+__+"

// FIX: Algeria (Algiers) is UTC+1 with NO daylight saving time.
// The old string "CET-1CEST,M3.5.0,M10.5.0/3" applied CEST (+1 summer DST)
// which made the clock show UTC+2 in summer — one hour ahead.
// "WAT-1" = West Africa Time = UTC+1 year-round, no DST. Correct for DZ.
#define TIMEZONE_STR           "WAT-1"
#define DISABLE_TIME_RULES     true

// ---- PIN DEFINITIONS ----------------------------------------
#define PIN_RFID_RX     20
#define PIN_LED_A_GREEN  5
#define PIN_LED_A_RED    6
#define PIN_LED_YELLOW   7
#define PIN_LED_WIFI     8
#define PIN_LED_ERROR    9
#define PIN_BUZZER      10
// NOTE: PIN_LED_A_GREEN is wired to the door relay.
// The relay is active-HIGH: HIGH = door unlocked, LOW = door locked.
// openDoor() sets it HIGH for DOOR_OPEN_MS then LOW -- non-blocking via millis().

// ---- SYSTEM CONSTANTS ---------------------------------------
#define MAX_MEMBERS       400
#define CSV_PATH          "/members.csv"
#define CSV_BACKUP_PATH   "/members_bak.csv"
#define LOG_PATH          "/logs.csv"
#define MAX_LOGS          100
#define PENDING_TIMEOUT   60000UL
#define POLL_INTERVAL_MS   3000UL
#define UPDATE_INTERVAL   30000UL
#define STATUS_INTERVAL   60000UL
#define ACCESS_HOUR_START    7
#define ACCESS_HOUR_END      16
#define DOOR_OPEN_MS       5000UL
#define DEBOUNCE_MS        20000UL
#define RFID_PACKET_LEN      14

// ---- INCLUDES -----------------------------------------------
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <HardwareSerial.h>
#include <time.h>
#include <esp_sntp.h>

// ---- STATE MACHINE ------------------------------------------
enum State {
  STATE_IDLE,
  STATE_SCANNED,
  STATE_PENDING,
  STATE_GRANTED,
  STATE_DENIED,
  STATE_ERROR
};
volatile State currentState = STATE_IDLE;

// ---- MEMBER STRUCT ------------------------------------------
struct Member {
  char     name[32];
  char     uid[12];
  char     role[20];
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

// Non-blocking door control via millis()
bool          doorOpen      = false;
unsigned long doorOpenStart = 0;

unsigned long lastScanTime = 0;

bool          wifiConnected    = false;
unsigned long lastUpdatePoll   = 0;
unsigned long lastStatusReport = 0;
bool          urgentPoll       = false;

bool     timeValid    = false;
uint32_t lastDayStamp = 0;

LiquidCrystal_I2C lcd(0x27, 16, 2);
unsigned long lcdIdleTimer = 0;
unsigned long lcdBootAnim  = 0;
int           lcdBootStep  = 0;
bool          bootDone     = false;

HardwareSerial rfidSerial(1);
uint8_t        rfidBuf[RFID_PACKET_LEN];
int            rfidBufPos = 0;

struct LogEntry { char msg[80]; uint32_t ts; };
LogEntry logBuf[MAX_LOGS];
int      logHead  = 0;
int      logCount = 0;

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
  return true;
}

void genRequestId(char* out, size_t len) {
  snprintf(out, len, "req_%lu_%u", millis(), (unsigned)random(10000, 99999));
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
  // Only turns off status LEDs -- do NOT touch green/relay while door is open
  if (!doorOpen) digitalWrite(PIN_LED_A_GREEN, LOW);
  digitalWrite(PIN_LED_A_RED,  LOW);
  digitalWrite(PIN_LED_YELLOW, LOW);
}
void ledGranted()        { digitalWrite(PIN_LED_A_RED, LOW); digitalWrite(PIN_LED_YELLOW, LOW); digitalWrite(PIN_LED_A_GREEN, HIGH); }
void ledDenied()         { digitalWrite(PIN_LED_A_GREEN, LOW); digitalWrite(PIN_LED_YELLOW, LOW); digitalWrite(PIN_LED_A_RED, HIGH); }
void ledPending()        { digitalWrite(PIN_LED_A_GREEN, LOW); digitalWrite(PIN_LED_A_RED, LOW); digitalWrite(PIN_LED_YELLOW, HIGH); }
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
    case 2: if (elapsed >= 1400) { lcd.setCursor(0,0); for(int i=0;i<16;i++) lcd.print('\xFF'); lcdBootStep = 3; } break;
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
//  DOOR CONTROL  (non-blocking)
// ============================================================
void openDoor() {
  if (doorOpen) return;
  doorOpen      = true;
  doorOpenStart = millis();
  digitalWrite(PIN_LED_A_GREEN, HIGH);  // relay ON
  Serial.println(F("[DOOR] OPENED"));
}

void closeDoor() {
  doorOpen = false;
  digitalWrite(PIN_LED_A_GREEN, LOW);   // relay OFF
  Serial.println(F("[DOOR] CLOSED"));
}

void updateDoor() {
  if (doorOpen && millis() - doorOpenStart >= DOOR_OPEN_MS) closeDoor();
}

// ============================================================
//  LOG SYSTEM
// ============================================================
void addLog(const char* msg) {
  LogEntry& e = logBuf[logHead];
  strncpy(e.msg, msg, 79); e.msg[79] = '\0';
  e.ts    = timeValid ? (uint32_t)time(nullptr) : 0;
  logHead = (logHead + 1) % MAX_LOGS;
  if (logCount < MAX_LOGS) logCount++;
  File f = LittleFS.open(LOG_PATH, "a");
  if (f) { f.printf("%lu,%s\n", (unsigned long)e.ts, msg); f.close(); }
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
    strncpy(m.name, tok, 31); tok = strtok(nullptr, ",");
    if (!tok) continue;
    strncpy(m.uid,  tok, 11); tok = strtok(nullptr, ",");
    if (!tok) continue;
    strncpy(m.role, tok, 19); tok = strtok(nullptr, ",");
    m.banned       = tok ? atoi(tok) != 0 : false; tok = strtok(nullptr, ",");
    m.dayGrant     = tok ? atoi(tok) != 0 : false; tok = strtok(nullptr, ",");
    m.dayGrantDate = tok ? (uint32_t)atol(tok) : 0;
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
      m.name, m.uid, m.role,
      m.banned   ? 1 : 0,
      m.dayGrant ? 1 : 0,
      (unsigned long)m.dayGrantDate);
  }
  f.close();
  if (LittleFS.exists(CSV_PATH)) LittleFS.rename(CSV_PATH, CSV_BACKUP_PATH);
  LittleFS.rename(TMP, CSV_PATH);
  Serial.println(F("[CSV] Saved OK"));
}

void clearCSV() {
  if (LittleFS.exists(CSV_PATH))        LittleFS.remove(CSV_PATH);
  if (LittleFS.exists(CSV_BACKUP_PATH)) LittleFS.remove(CSV_BACKUP_PATH);
  memberCount = 0;
  Serial.println(F("[CSV] Cleared -- waiting for server re-sync"));
}

void addDefaultMembers() {
  struct { const char* name; const char* uid; const char* role; } D[] = {
    {"Islem",        "0002787912", "Leader"},
    {"Djilali",      "0007680714", "ExclusiveBoard"},
    {"Ibtissem",     "0006505824", "Leader"},
    {"Feriel",       "0009860301", "Leader"},
    {"Ismail",       "0007875382", "Leader"},
    {"Khadidja",     "0003752638", "Leader"},
    {"abdelmadjid",  "0010619675", "Leader"},
    {"Abdellah",     "0006579751", "Leader"},
    {"Mahdi",        "0008321581", "Leader"},
    {"Anis",         "0007869479", "Leader"},
    {"maroua",       "0009686941", "Leader"},
    {"djamel",       "0014351112", "Leader"},
    {"Abd Erraouf",  "0004022966", "Leader"},
    {"amira",        "0006819271", "ExclusiveBoard"},
    {"Lafdal",       "0002672952", "Leader"},
    {"IKHLAS",       "0014755425", "Leader"},
    {"YAZI",         "0006527607", "President"},
    {"Ziouani",      "0014692887", "ExclusiveBoard"},
    {"Dhaia",        "0009660230", "Leader"},
    {"adem",         "0006557881", "ExclusiveBoard"},
    {"Ibrahim",      "0010940033", "Leader"},
    {"Nour",         "0014883107", "ExclusiveBoard"},
    {"dounia",       "0006587684", "Leader"},
  };
  memberCount = 0;
  int n = sizeof(D) / sizeof(D[0]);
  for (int i = 0; i < n && i < MAX_MEMBERS; i++) {
    Member& m = members[i];
    memset(&m, 0, sizeof(m));
    strncpy(m.name, D[i].name, 31);
    strncpy(m.uid,  D[i].uid,  11);
    strncpy(m.role, D[i].role, 19);
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

void rfidFlush() {
  unsigned long deadline = millis() + 200;
  while (millis() < deadline) { while (rfidSerial.available()) rfidSerial.read(); delay(10); }
  rfidBufPos = 0;
}

String parseRFIDPacket(uint8_t* buf) {
  if (buf[0] != 0x02 || buf[13] != 0x03) return "";
  uint8_t data[5];
  for (int i = 0; i < 5; i++) data[i] = hexByte(buf[1+i*2], buf[2+i*2]);
  uint8_t chk  = hexByte(buf[11], buf[12]);
  uint8_t calc = data[0]^data[1]^data[2]^data[3]^data[4];
  if (calc != chk) { Serial.printf("[RFID] Checksum fail: calc=0x%02X got=0x%02X\n", calc, chk); return ""; }
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
      if (uid.length() > 0) { rfidFlush(); outUID = uid; return true; }
    }
  }
  return false;
}

// ============================================================
//  HTTP / API
// ============================================================
bool httpPost(const char* endpoint, JsonDocument& body, JsonDocument& resp) {
  if (!wifiConnected) return false;
  HTTPClient http;
  http.setTimeout(8000);
  http.begin(String(SERVER_URL) + endpoint);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);
  String payload; serializeJson(body, payload);
  int code = http.POST(payload);
  bool ok  = (code == 200);
  if (ok) deserializeJson(resp, http.getString());
  http.end();
  return ok;
}

bool httpGet(const char* endpoint, JsonDocument& resp) {
  if (!wifiConnected) return false;
  HTTPClient http;
  http.setTimeout(8000);
  http.begin(String(SERVER_URL) + endpoint);
  http.addHeader("x-api-key", API_KEY);
  int code = http.GET();
  bool ok  = (code == 200);
  if (ok) deserializeJson(resp, http.getString());
  http.end();
  return ok;
}

void sendScanToBot(const char* uid) {
  StaticJsonDocument<256> body, resp;
  genRequestId(pendingRequestId, sizeof(pendingRequestId));
  body["uid"]        = uid;
  body["action"]     = "unknown_scan";
  body["timestamp"]  = (long)time(nullptr);
  body["request_id"] = pendingRequestId;
  httpPost("/api/scan", body, resp);
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

void pollUpdates() {
  StaticJsonDocument<6144> resp;
  if (!httpGet("/api/updates", resp)) return;

  urgentPoll = resp["has_queue"] | false;

  JsonArray updates = resp["members"].as<JsonArray>();
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
      strncpy(m->name, name, 31);
      strncpy(m->role, role, 19);
      m->banned       = banned;
      m->dayGrant     = dg;
      m->dayGrantDate = (dg && dgDate == 0) ? getDayStamp() : dgDate;
    } else if (strlen(uid) > 0 && memberCount < MAX_MEMBERS) {
      Member& nm = members[memberCount++];
      memset(&nm, 0, sizeof(nm));
      strncpy(nm.name, name, 31);
      strncpy(nm.uid,  uid,  11);
      strncpy(nm.role, role, 19);
      nm.banned       = banned;
      nm.dayGrant     = dg;
      nm.dayGrantDate = (dg && dgDate == 0) ? getDayStamp() : dgDate;
    }
    changed = true;
  }
  if (changed) writeCSV();

  const char* dcmd = resp["door_cmd"] | "";
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
  lcdShowGranted(name);
  openDoor();
  lcdShowDoorOpen(name);

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
  currentState = STATE_SCANNED;
  lcdShowScanning();
  ledPending();

  // ---- STEP 1: local lookup -----------------------------------
  Member* m = findByUID(uid);

  // ---- STEP 2: known card ------------------------------------
  if (m) {
    // Banned: escalate to Discord so admin can unban in real-time
    if (m->banned) {
      if (!wifiConnected) {
        denyAccess(uid, m->name, m->role, "Banned");
        return;
      }
      strncpy(pendingUID, uid, 11); pendingUID[11] = '\0';
      hasPending   = true;
      pendingStart = millis();
      currentState = STATE_PENDING;
      sendScanToBot(uid);
      buzzPending();
      Serial.printf("[BANNED PENDING] UID=%s  reqId=%s\n", uid, pendingRequestId);
      return;
    }

    if (!strcmp(m->role, "President") || !strcmp(m->role, "ExclusiveBoard")) {
      grantAccess(uid, m->name, m->role);
      return;
    }

    if (!strcmp(m->role, "Leader") || !strcmp(m->role, "Member")) {
      bool hasDayGrant = m->dayGrant && (m->dayGrantDate == getDayStamp());
      if (hasDayGrant) {
        grantAccess(uid, m->name, m->role);
        return;
      }
      // No day grant -> escalate to Discord for approval
      if (!wifiConnected) {
        denyAccess(uid, m->name, m->role, "No WiFi/Grant");
        return;
      }
      strncpy(pendingUID, uid, 11); pendingUID[11] = '\0';
      hasPending   = true;
      pendingStart = millis();
      currentState = STATE_PENDING;
      sendScanToBot(uid);
      buzzPending();
      Serial.printf("[PENDING] Leader/Member no grant UID=%s reqId=%s\n", uid, pendingRequestId);
      return;
    }
    // Unrecognised role -> fall through to Discord escalation
  }

  // ---- STEP 3: unknown UID -> escalate to Discord ------------
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

  sendScanToBot(uid);
  buzzPending();
  Serial.printf("[PENDING] UID=%s  reqId=%s\n", uid, pendingRequestId);
}

void processPendingDecision(const String& action) {
  hasPending = false;

  Member* m = findByUID(pendingUID);
  const char* dname = m ? m->name : pendingUID;
  const char* drole = m ? m->role : "Unknown";

  if (action == "grant_day") {
    if (m) {
      m->dayGrant     = true;
      m->dayGrantDate = getDayStamp();
      writeCSV();
    }
    grantAccess(pendingUID, dname, drole);

  // FIX: The server sends "open" for both access_once and grant_day decisions.
  // Previously only "grant_day" and "add_member" called grantAccess() here;
  // "access_once" was never handled so it fell through to the final else
  // branch which called denyAccess("No decision"). Now "open" is handled
  // explicitly and "access_once" is kept as an alias for safety.
  } else if (action == "open" || action == "access_once") {
    grantAccess(pendingUID, dname, drole);

  } else if (action == "add_member") {
    // Member was added by bot; re-fetch so we have the new name/role
    Member* fresh = findByUID(pendingUID);
    grantAccess(pendingUID, fresh ? fresh->name : dname, fresh ? fresh->role : drole);

  // FIX: "unban_open" = unban AND open door
  } else if (action == "unban_open") {
    if (m) {
      m->banned = false;
      if (!strcmp(m->role, "Banned")) strncpy(m->role, "Member", 19);
      writeCSV();
    }
    grantAccess(pendingUID, m ? m->name : dname, m ? m->role : "Member");

  // FIX: "unban" = unban only, do NOT open door
  } else if (action == "unban") {
    if (m) {
      m->banned = false;
      if (!strcmp(m->role, "Banned")) strncpy(m->role, "Member", 19);
      writeCSV();
    }
    denyAccess(pendingUID, m ? m->name : dname, m ? m->role : "Member", "Unbanned (no entry)", true);

  } else if (action == "deny") {
    denyAccess(pendingUID, dname, drole, "Admin deny");

  } else if (action == "ban") {
    if (m) {
      m->banned = true;
      strncpy(m->role, "Banned", 19);
      writeCSV();
    } else if (memberCount < MAX_MEMBERS) {
      Member& nm = members[memberCount++];
      memset(&nm, 0, sizeof(nm));
      strncpy(nm.uid,  pendingUID, 11);
      strncpy(nm.name, pendingUID, 31);
      strncpy(nm.role, "Banned",   19);
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
  Serial.println(F("\n[BOOT]  ITC Access Control v1.6"));

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
  updateDoor();          // non-blocking door close check
  checkMidnightReset();

  // ---- IDLE ------------------------------------------------
  if (currentState == STATE_IDLE) {
    lcdShowIdle();

    String uid;
    if (rfidRead(uid) && (now - lastScanTime > DEBOUNCE_MS)) {
      lastScanTime = now;
      handleScan(uid.c_str());
      rfidFlush();
    }

    {
      unsigned long pollInterval = urgentPoll ? 5000UL : UPDATE_INTERVAL;
      if (wifiConnected && now - lastUpdatePoll > pollInterval) {
        lastUpdatePoll = now;
        pollUpdates();
      }
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
      if (rfidRead(uid) && (now - lastScanTime > DEBOUNCE_MS)) {
        lastScanTime = now;
        hasPending   = false;
        handleScan(uid.c_str());
        rfidFlush();
      } else if (now - lastUpdatePoll > POLL_INTERVAL_MS) {
        lastUpdatePoll = now;
        String action = pollForDecision();
        if (action.length() > 0) processPendingDecision(action);
      }
    }
  }

  // ---- SAFETY RESET ----------------------------------------
  else if (currentState != STATE_GRANTED && currentState != STATE_DENIED) {
    static unsigned long errorTimer = 0;
    if (errorTimer == 0) errorTimer = now;
    if (now - errorTimer > 5000) { errorTimer = 0; currentState = STATE_IDLE; }
  }

  delay(10);
}
