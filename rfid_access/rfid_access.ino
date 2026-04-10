/*
============================================================
RFID ACCESS CONTROL - @exlusif_board EDITION
Platform : ESP32-C3 Mini
============================================================
CHANGES vs previous version:
  - Unknown cards: NEVER saved to DB/CSV — Discord asked
    every single time, no memory between scans
  - Grant 1 Day: saves to ESP RAM, door opens next scan
  - Block Today: saves UID to RAM block list until midnight
  - Permanent ban still works via ban button / /ban command
  - All bot replies are now PUBLIC (visible to everyone)
============================================================ */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <ArduinoJson.h>

// ════════════════════════════════════════════════════════════
// PIN DEFINITIONS
// ════════════════════════════════════════════════════════════
#define RELAY       4
#define SIGNAL_PIN  3

#define RFID_SERIAL  Serial1
#define RFID_RX_PIN  20
#define RFID_TX_PIN  21

// ════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════
#define ACTIVE_BUZZER   false
#define SKIP_TIME_CHECK false
#define FORCE_REWRITE   false

const char* WIFI_SSID  = "DOOR_ACCESS";
const char* WIFI_PASS  = "DOOR_ACCESS";
const char* SERVER_URL = "https://rfid.robtic.org";   // NO trailing slash
const char* API_KEY    = "hgougYUGTYOUGGyouyouTYOUg54f564sd51414..45_+__+";

const int ACCESS_HOUR_START = 10;
const int ACCESS_HOUR_END   = 16;

const long  NTP_GMT_OFFSET_SEC  = 3600;
const int   NTP_DAYLIGHT_OFFSET = 0;

const unsigned long SCAN_COOLDOWN_MS = 8000;
const unsigned long DOOR_OPEN_MS     = 3000;
const unsigned long LED_HOLD_MS      = 1500;
const unsigned long POLL_INTERVAL_MS = 5000;
const unsigned long NTP_RETRY_MS     = 30000;

#define QUEUE_MAX 30

// ════════════════════════════════════════════════════════════
// EMBEDDED ACCESS LIST (offline cache for board/president)
// ════════════════════════════════════════════════════════════
const char* DEFAULT_CSV =
  "Full Name,UID,Role\n"
  "Islem,0002787912,Leader\n"
  "Djilali,0007680714,Exclusive board\n"
  "Ibtissem,0006505824,Leader\n"
  "Feriel,0009860301,Leader\n"
  "Ismail,0007875382,Leader\n"
  "Khadidja,0003752638,Leader\n"
  "abdelmadjid,0010619675,Leader\n"
  "Abdellah,0006579751,Leader\n"
  "Mahdi,0008321581,Leader\n"
  "Anis,0007869479,Leader\n"
  "maroua,0009686941,Leader\n"
  "djamel,0014351112,Leader\n"
  "Abd Erraouf,0004022966,Leader\n"
  "amira,0006819271,Exclusive board\n"
  "Lafdal,0002672952,Leader\n"
  "IKHLAS,0014755425,Leader\n"
  "YAZI,0006527607,President\n"
  "Ziouani,0014692887,Exclusive board\n"
  "Dhaia,0009660230,Leader\n"
  "adem,0006557881,Exclusive board\n"
  "Ibrahim,0010940033,Leader\n"
  "Nour,0014883107,Exclusive board\n"
  "dounia,0006587684,Leader\n";

// ════════════════════════════════════════════════════════════
// PRESIDENT MESSAGES
// ════════════════════════════════════════════════════════════
const char* PRESIDENT_MSGS[] = {
  "THE BOSS IS IN",
  "WELCOME CHIEF!",
  "VIP ACCESS :)",
  "BOSS MODE ON",
  "MAKE WAY !!!",
  "YES SIR!!!!!"
};
const int PRESIDENT_MSG_COUNT = 6;
int presidentMsgIdx = 0;

// ════════════════════════════════════════════════════════════
// SOUND TYPES
// ════════════════════════════════════════════════════════════
#define SND_GRANTED_LEADER    1
#define SND_GRANTED_BOARD     2
#define SND_GRANTED_PRESIDENT 3
#define SND_BANNED            4
#define SND_UNKNOWN           5
#define SND_DENIED            6
#define SND_ERROR             7
#define SND_WIFI_OK           8

// ════════════════════════════════════════════════════════════
// GLOBALS
// ════════════════════════════════════════════════════════════
LiquidCrystal_I2C lcd(0x27, 16, 2);

unsigned long lastScanTime     = 0;
unsigned long lastPollTime     = 0;
unsigned long lastClockRefresh = 0;
unsigned long lastNtpAttempt   = 0;

bool fsReady       = false;
bool wifiConnected = false;
bool timeReady     = false;

// ── Offline event queue ──────────────────────────────────────
struct QueueEntry {
  char uid[11];
  char name[24];
  char result[28];
};
QueueEntry eventQueue[QUEUE_MAX];
int queueCount = 0;

// ── Day grant list (RAM only, resets at midnight) ─────────────
#define GRANT_LIST_MAX 20
char grantedUIDs[GRANT_LIST_MAX][11];
int  grantedCount = 0;
int  grantedDay   = -1;

// ── Day block list (RAM only, resets at midnight) ─────────────
// UIDs where Discord chose "Block Today" — cleared at midnight
#define BLOCK_LIST_MAX 20
char blockedUIDs[BLOCK_LIST_MAX][11];
int  blockedCount = 0;
int  blockedDay   = -1;

// ════════════════════════════════════════════════════════════
// FORWARD DECLARATIONS
// ════════════════════════════════════════════════════════════
void     lcdPrint(const char* l1, const char* l2);
void     lcdPrint(String l1, String l2);
String   centerName(String name);
String   padUID(unsigned long uid);
void     playSound(int soundType);
void     showIdle();
void     openDoor();
bool     ensureWifi();
bool     syncNTP();
void     checkAccess(unsigned long uid);
void     flushQueue();
bool     sendToServer(const char* uid, const char* name, const char* result);
bool     scanUnknown(const char* uid);
String   checkWithServer(const char* uid, const char* name);
void     pollCommands();
bool     executeCommand(const String& action, const String& uid,
                        const String& name, const String& role, int count);
void     sendAck(const String& cmdId, bool ok);
bool     updateRoleInCSV(const String& targetUID, const String& newRole);
bool     addToCSV(const String& uid, const String& name, const String& role);
bool     isGrantedToday(const char* uid);
void     grantDayAccess(const char* uid);
bool     isBlockedToday(const char* uid);
void     blockDayAccess(const char* uid);
void     checkMidnightReset();
void     accessGrantedLeader(String name, bool dayGrant);
void     accessGrantedBoard(String name);
void     accessGrantedPresident(String name);
void     accessBanned(String name);
void     accessDeniedHours(String name);
void     accessDeniedBlocked(String name);
void     accessUnknown(unsigned long uid);
void     accessDenied(String name, const char* reason);
void     queueEvent(const char* uid, const char* name, const char* result);
unsigned long readUID();
void     flushRFID();
bool     isWithinAccessHours();
String   buildURL(const char* path);
int      httpPost(const String& url, const String& body);
int      httpGet(const String& url, String& responseOut);

// ════════════════════════════════════════════════════════════
// SETUP
// ════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);

  RFID_SERIAL.begin(9600, SERIAL_8N1, RFID_RX_PIN, RFID_TX_PIN);

  pinMode(RELAY, OUTPUT);
  pinMode(SIGNAL_PIN, OUTPUT);
  digitalWrite(RELAY, HIGH);
  digitalWrite(SIGNAL_PIN, LOW);

  Wire.begin(6, 7);
  lcd.init();
  lcd.backlight();
  lcdPrint(" @exlusif_board", "  Booting...");
  delay(800);

  if (!LittleFS.begin(true)) {
    Serial.println(F("STARTUP_ERROR: LittleFS failed"));
    lcdPrint(" Flash Error!", " Re-flash ESP32");
    playSound(SND_ERROR);
    delay(3000);
  } else {
    fsReady = true;
    Serial.println(F("STARTUP_OK: LittleFS mounted"));

    if (!LittleFS.exists("/access.csv") || FORCE_REWRITE) {
      lcdPrint(" Writing list...", " Please wait");
      File f = LittleFS.open("/access.csv", "w");
      if (f) {
        f.print(DEFAULT_CSV);
        f.close();
        Serial.println(F("access.csv written OK"));
      } else {
        lcdPrint(" Write Failed", " Check flash");
        playSound(SND_ERROR);
        delay(3000);
      }
    } else {
      Serial.println(F("access.csv found in flash"));
    }
  }

  showIdle();
  Serial.println(F("SYSTEM_READY"));
}

// ════════════════════════════════════════════════════════════
// MAIN LOOP
// ════════════════════════════════════════════════════════════
void loop() {

  // ── RFID scan ─────────────────────────────────────────────
  if (RFID_SERIAL.available()) {
    unsigned long uid = readUID();
    if (uid > 0) {
      if (millis() - lastScanTime < SCAN_COOLDOWN_MS) {
        flushRFID();
        return;
      }
      lastScanTime = millis();
      String uidStr = padUID(uid);
      Serial.print(F("SCAN: ")); Serial.println(uidStr);
      lcdPrint(" Scanning...", " Please wait");

      if (!fsReady) {
        lcdPrint(" Flash Error!", " Cannot check");
        playSound(SND_ERROR);
      } else {
        checkAccess(uid);
      }

      flushRFID();
      delay(400);
      showIdle();
    }
  }

  // ── Retry NTP if not synced ───────────────────────────────
  if (!timeReady && wifiConnected &&
      millis() - lastNtpAttempt > NTP_RETRY_MS) {
    syncNTP();
  }

  // ── Flush offline queue ───────────────────────────────────
  if (wifiConnected && queueCount > 0) flushQueue();

  // ── Poll bot commands ─────────────────────────────────────
  if (wifiConnected && millis() - lastPollTime > POLL_INTERVAL_MS) {
    lastPollTime = millis();
    pollCommands();
  }

  // ── Refresh idle clock every second ──────────────────────
  if (millis() - lastClockRefresh > 1000) {
    lastClockRefresh = millis();
    showIdle();
  }
}

// ════════════════════════════════════════════════════════════
// URL BUILDER
// ════════════════════════════════════════════════════════════
String buildURL(const char* path) {
  return String(SERVER_URL) + String(path);
}

// ════════════════════════════════════════════════════════════
// WIFI
// ════════════════════════════════════════════════════════════
bool ensureWifi() {
  if (wifiConnected && WiFi.status() == WL_CONNECTED) return true;

  wifiConnected = false;
  lcdPrint(" Connecting...", " WiFi...");
  Serial.print(F("WIFI: Connecting..."));

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 24) {
    delay(500);
    Serial.print(".");
    tries++;
  }

  wifiConnected = (WiFi.status() == WL_CONNECTED);

  if (wifiConnected) {
    Serial.println(F("\nWIFI: CONNECTED"));
    Serial.print(F("IP: ")); Serial.println(WiFi.localIP());
    if (!timeReady) syncNTP();
    playSound(SND_WIFI_OK);
  } else {
    Serial.println(F("\nWIFI: FAILED — offline mode"));
    lcdPrint(" WiFi Failed", " Offline Mode");
    delay(1200);
  }

  return wifiConnected;
}

// ════════════════════════════════════════════════════════════
// NTP
// ════════════════════════════════════════════════════════════
bool syncNTP() {
  lastNtpAttempt = millis();
  configTime(NTP_GMT_OFFSET_SEC, NTP_DAYLIGHT_OFFSET,
             "pool.ntp.org", "time.nist.gov", "time.google.com");

  Serial.print(F("NTP: Syncing"));
  struct tm t;
  int retries = 0;
  while (!getLocalTime(&t, 1000) && retries < 10) {
    Serial.print(".");
    retries++;
    delay(500);
  }

  if (getLocalTime(&t, 100)) {
    timeReady  = true;
    grantedDay = t.tm_yday;
    blockedDay = t.tm_yday;
    Serial.println(F("... OK"));
    char buf[32];
    strftime(buf, 32, "%H:%M:%S %d/%m/%Y", &t);
    Serial.println(buf);
    return true;
  }

  Serial.println(F(" FAILED (will retry)"));
  return false;
}

// ════════════════════════════════════════════════════════════
// IDLE SCREEN
// ════════════════════════════════════════════════════════════
void showIdle() {
  if (timeReady) {
    struct tm t;
    if (getLocalTime(&t, 100)) {
      char timeBuf[17];
      strftime(timeBuf, 17, "   %H:%M:%S", &t);
      lcdPrint(" Ready to Scan", timeBuf);
      return;
    }
  }
  lcdPrint(" Ready to Scan", " No Clock Yet");
}

// ════════════════════════════════════════════════════════════
// TIME CHECK
// ════════════════════════════════════════════════════════════
bool isWithinAccessHours() {
  if (SKIP_TIME_CHECK) return true;
  if (!timeReady) return false;
  struct tm t;
  if (!getLocalTime(&t, 100)) return false;
  int totalMin = t.tm_hour * 60 + t.tm_min;
  return (totalMin >= ACCESS_HOUR_START * 60 &&
          totalMin <  ACCESS_HOUR_END   * 60);
}

// ════════════════════════════════════════════════════════════
// MIDNIGHT RESET — clears grant and block lists at new day
// ════════════════════════════════════════════════════════════
void checkMidnightReset() {
  if (!timeReady) return;
  struct tm t;
  if (!getLocalTime(&t, 100)) return;

  if (grantedDay != t.tm_yday) {
    grantedCount = 0;
    grantedDay   = t.tm_yday;
    Serial.println(F("GRANT: midnight reset"));
  }
  if (blockedDay != t.tm_yday) {
    blockedCount = 0;
    blockedDay   = t.tm_yday;
    Serial.println(F("BLOCK: midnight reset"));
  }
}

// ════════════════════════════════════════════════════════════
// DAY GRANT HELPERS
// ════════════════════════════════════════════════════════════
bool isGrantedToday(const char* uid) {
  checkMidnightReset();
  for (int i = 0; i < grantedCount; i++) {
    if (strcmp(grantedUIDs[i], uid) == 0) return true;
  }
  return false;
}

void grantDayAccess(const char* uid) {
  if (isGrantedToday(uid)) {
    Serial.print(F("GRANT: already granted ")); Serial.println(uid);
    return;
  }
  if (grantedCount >= GRANT_LIST_MAX) {
    memmove(grantedUIDs[0], grantedUIDs[1],
            sizeof(grantedUIDs[0]) * (GRANT_LIST_MAX - 1));
    grantedCount = GRANT_LIST_MAX - 1;
  }
  strncpy(grantedUIDs[grantedCount++], uid, 10);
  grantedUIDs[grantedCount - 1][10] = '\0';
  Serial.print(F("GRANT: added ")); Serial.println(uid);
}

// ════════════════════════════════════════════════════════════
// DAY BLOCK HELPERS
// ════════════════════════════════════════════════════════════
bool isBlockedToday(const char* uid) {
  checkMidnightReset();
  for (int i = 0; i < blockedCount; i++) {
    if (strcmp(blockedUIDs[i], uid) == 0) return true;
  }
  return false;
}

void blockDayAccess(const char* uid) {
  if (isBlockedToday(uid)) {
    Serial.print(F("BLOCK: already blocked ")); Serial.println(uid);
    return;
  }
  if (blockedCount >= BLOCK_LIST_MAX) {
    memmove(blockedUIDs[0], blockedUIDs[1],
            sizeof(blockedUIDs[0]) * (BLOCK_LIST_MAX - 1));
    blockedCount = BLOCK_LIST_MAX - 1;
  }
  strncpy(blockedUIDs[blockedCount++], uid, 10);
  blockedUIDs[blockedCount - 1][10] = '\0';
  Serial.print(F("BLOCK: added ")); Serial.println(uid);
}

// ════════════════════════════════════════════════════════════
// RFID READ
// ════════════════════════════════════════════════════════════
unsigned long readUID() {
  String data = "";
  unsigned long start = millis();
  while (millis() - start < 250) {
    while (RFID_SERIAL.available()) {
      char c = RFID_SERIAL.read();
      if (isHexadecimalDigit(c)) data += c;
    }
  }
  if (data.length() >= 10) {
    String hexPart = data.substring(2, 10);
    char buf[9];
    hexPart.toCharArray(buf, 9);
    return strtoul(buf, NULL, 16);
  }
  return 0;
}

void flushRFID() {
  while (RFID_SERIAL.available()) RFID_SERIAL.read();
}

String padUID(unsigned long uid) {
  String s = String(uid);
  while (s.length() < 10) s = "0" + s;
  return s;
}

// ════════════════════════════════════════════════════════════
// HTTP HELPERS
// ════════════════════════════════════════════════════════════
int httpPost(const String& url, const String& body) {
  if (!wifiConnected) return -1;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);
  http.setTimeout(5000);

  int code = http.POST(body);
  http.end();
  return code;
}

int httpGet(const String& url, String& responseOut) {
  if (!wifiConnected) return -1;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, url);
  http.addHeader("x-api-key", API_KEY);
  http.setTimeout(5000);

  int code = http.GET();
  if (code == 200) responseOut = http.getString();
  http.end();
  return code;
}

// ════════════════════════════════════════════════════════════
// CHECK WITH SERVER
// Ask server for verdict on a known member.
// Returns verdict string or "" on failure (local fallback).
// ════════════════════════════════════════════════════════════
String checkWithServer(const char* uid, const char* name) {
  StaticJsonDocument<128> doc;
  doc["uid"]  = uid;
  doc["name"] = name;

  String body;
  serializeJson(doc, body);

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, buildURL("/discord/check/scan"));
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);
  http.setTimeout(5000);

  int code = http.POST(body);
  if (code != 200) {
    http.end();
    Serial.printf("SERVER CHECK FAIL: %d\n", code);
    return "";
  }

  String resp = http.getString();
  http.end();

  StaticJsonDocument<256> respDoc;
  DeserializationError err = deserializeJson(respDoc, resp);
  if (err) {
    Serial.print(F("SERVER CHECK JSON ERR: ")); Serial.println(err.c_str());
    return "";
  }

  bool   known    = respDoc["known"]     | false;
  String role     = respDoc["role"]      | "";
  bool   dayGrant = respDoc["day_grant"] | false;

  Serial.printf("SERVER: known=%d role=%s dayGrant=%d\n",
                known, role.c_str(), dayGrant);

  if (!known)                    return "NOT_IN_LIST";
  if (role == "banned")          return "BANNED";
  if (role == "pending")         return "DENIED_PENDING";
  if (role == "Exclusive board") return "GRANTED_BOARD";
  if (role == "President")       return "GRANTED_PRESIDENT";

  if (dayGrant)              return "GRANTED_LEADER_DAY";
  if (isWithinAccessHours()) return "GRANTED_LEADER";
  return "DENIED_HOURS";
}

// ════════════════════════════════════════════════════════════
// ACCESS CHECK
// Flow:
//   1. Check block list (unknown cards blocked today)
//   2. Read CSV — Board/President: local. Leader: ask server.
//   3. Not in CSV: check block list again, then ask Discord
// ════════════════════════════════════════════════════════════
void checkAccess(unsigned long uid) {
  String uidStr = padUID(uid);

  // ── Early exit: blocked today ─────────────────────────────
  if (isBlockedToday(uidStr.c_str())) {
    accessDeniedBlocked("Unknown");
    queueEvent(uidStr.c_str(), "Unknown", "DENIED_BLOCKED_DAY");
    if (ensureWifi()) flushQueue();
    return;
  }

  File f = LittleFS.open("/access.csv", "r");
  if (!f) {
    lcdPrint("  No access.csv", " Upload via IDE");
    Serial.println(F("ERROR: /access.csv missing"));
    playSound(SND_ERROR);
    return;
  }

  bool found     = false;
  bool firstLine = true;

  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    if (firstLine) {
      firstLine = false;
      if (line.startsWith("Full Name") || line.startsWith("full name")) continue;
    }

    int c1 = line.indexOf(',');           if (c1 == -1) continue;
    int c2 = line.indexOf(',', c1 + 1);  if (c2 == -1) continue;

    String name   = line.substring(0, c1);       name.trim();
    String csvUID = line.substring(c1 + 1, c2);  csvUID.trim();
    String role   = line.substring(c2 + 1);       role.trim();

    unsigned long csvUIDLong = strtoul(csvUID.c_str(), NULL, 10);
    String csvUIDPadded = padUID(csvUIDLong);

    if (csvUIDPadded != uidStr) continue;

    found = true;

    // ── Exclusive Board: 100% local ───────────────────────
    if (role == "Exclusive board") {
      accessGrantedBoard(name);
      queueEvent(uidStr.c_str(), name.c_str(), "GRANTED_BOARD");
      if (ensureWifi()) flushQueue();

    // ── President: 100% local ─────────────────────────────
    } else if (role == "President") {
      accessGrantedPresident(name);
      queueEvent(uidStr.c_str(), name.c_str(), "GRANTED_PRESIDENT");
      if (ensureWifi()) flushQueue();

    // ── Leader: ask server first, local fallback ──────────
    } else if (role == "Leader") {
      lcdPrint(centerName(name), " Checking...");

      if (ensureWifi()) {
        String verdict = checkWithServer(uidStr.c_str(), name.c_str());

        if (verdict == "GRANTED_LEADER") {
          accessGrantedLeader(name, false);
          sendToServer(uidStr.c_str(), name.c_str(), "GRANTED_LEADER");

        } else if (verdict == "GRANTED_LEADER_DAY") {
          accessGrantedLeader(name, true);
          sendToServer(uidStr.c_str(), name.c_str(), "GRANTED_LEADER_DAY");

        } else if (verdict == "DENIED_HOURS") {
          accessDeniedHours(name);
          sendToServer(uidStr.c_str(), name.c_str(), "DENIED_HOURS");

        } else if (verdict == "BANNED") {
          accessBanned(name);
          sendToServer(uidStr.c_str(), name.c_str(), "BANNED");

        } else if (verdict == "DENIED_PENDING") {
          accessDenied(name, "Not Approved");
          sendToServer(uidStr.c_str(), name.c_str(), "DENIED_PENDING");

        } else {
          // Server unreachable — local fallback
          Serial.println(F("SERVER UNREACHABLE: local fallback"));
          bool dayGrant = isGrantedToday(uidStr.c_str());
          if (isWithinAccessHours() || dayGrant) {
            const char* evtResult = dayGrant ? "GRANTED_LEADER_DAY" : "GRANTED_LEADER";
            accessGrantedLeader(name, dayGrant);
            queueEvent(uidStr.c_str(), name.c_str(), evtResult);
            flushQueue();
          } else {
            accessDeniedHours(name);
            queueEvent(uidStr.c_str(), name.c_str(), "DENIED_HOURS");
            flushQueue();
          }
        }

      } else {
        // WiFi down — fully local
        Serial.println(F("WIFI DOWN: local fallback for Leader"));
        bool dayGrant = isGrantedToday(uidStr.c_str());
        if (isWithinAccessHours() || dayGrant) {
          const char* evtResult = dayGrant ? "GRANTED_LEADER_DAY" : "GRANTED_LEADER";
          accessGrantedLeader(name, dayGrant);
          queueEvent(uidStr.c_str(), name.c_str(), evtResult);
        } else {
          accessDeniedHours(name);
          queueEvent(uidStr.c_str(), name.c_str(), "DENIED_HOURS");
        }
      }

    // ── Banned ────────────────────────────────────────────
    } else if (role == "banned") {
      accessBanned(name);
      queueEvent(uidStr.c_str(), name.c_str(), "BANNED");
      if (ensureWifi()) flushQueue();

    } else {
      accessDenied(name, "Invalid Role");
      queueEvent(uidStr.c_str(), name.c_str(), "DENIED_ROLE");
      if (ensureWifi()) flushQueue();
    }

    break;
  }
  f.close();

  // ── Unknown card ─────────────────────────────────────────
  // Ask Discord EVERY TIME — no DB/CSV save, no memory.
  // If blocked today, deny silently.
  if (!found) {
    if (isBlockedToday(uidStr.c_str())) {
      accessDeniedBlocked("Unknown");
      queueEvent(uidStr.c_str(), "Unknown", "DENIED_BLOCKED_DAY");
      if (ensureWifi()) flushQueue();
      return;
    }

    accessUnknown(uid);
    if (ensureWifi()) {
      Serial.println(F("-> asking Discord for unknown card"));
      bool serverKnows = scanUnknown(uidStr.c_str());
      Serial.print(F("-> serverKnows=")); Serial.println(serverKnows);
      if (!serverKnows) {
        // Truly unknown — Discord was notified with buttons
        queueEvent(uidStr.c_str(), "Unknown", "NOT_IN_LIST");
        flushQueue();
      }
    } else {
      queueEvent(uidStr.c_str(), "Unknown", "NOT_IN_LIST");
    }
  }
}

// ════════════════════════════════════════════════════════════
// ACCESS OUTCOMES
// ════════════════════════════════════════════════════════════
void accessGrantedLeader(String name, bool dayGrant) {
  String line2;
  if (dayGrant) {
    line2 = "Leader|Full Day";
  } else if (timeReady) {
    struct tm t;
    if (getLocalTime(&t, 100)) {
      char tb[6];
      strftime(tb, 6, "%H:%M", &t);
      line2 = "Leader | ";
      line2 += tb;
    } else {
      line2 = "Leader | OK";
    }
  } else {
    line2 = "Leader | OK";
  }
  lcdPrint(centerName(name), line2);
  playSound(SND_GRANTED_LEADER);
  openDoor();
}

void accessGrantedBoard(String name) {
  lcdPrint(centerName(name), " Excl. Board *");
  playSound(SND_GRANTED_BOARD);
  openDoor();
}

void accessGrantedPresident(String name) {
  lcdPrint(centerName(name), PRESIDENT_MSGS[presidentMsgIdx]);
  presidentMsgIdx = (presidentMsgIdx + 1) % PRESIDENT_MSG_COUNT;
  playSound(SND_GRANTED_PRESIDENT);
  openDoor();
}

void accessBanned(String name) {
  lcdPrint("!! BANNED !!", centerName(name));
  playSound(SND_BANNED);
}

void accessDeniedHours(String name) {
  lcdPrint(centerName(name), " 10AM-4PM Only");
  playSound(SND_DENIED);
}

void accessDeniedBlocked(String name) {
  lcdPrint("? Blocked Today", " Try Tomorrow");
  playSound(SND_DENIED);
}

void accessUnknown(unsigned long uid) {
  lcdPrint("? Unknown Card", padUID(uid));
  playSound(SND_UNKNOWN);
}

void accessDenied(String name, const char* reason) {
  lcdPrint(centerName(name), reason);
  playSound(SND_DENIED);
}

void openDoor() {
  digitalWrite(RELAY, LOW);
  delay(DOOR_OPEN_MS);
  digitalWrite(RELAY, HIGH);
}

// ════════════════════════════════════════════════════════════
// SOUND ENGINE
// ════════════════════════════════════════════════════════════
void playSound(int soundType) {
  if (ACTIVE_BUZZER) {
    int times = 1;
    if (soundType == SND_BANNED || soundType == SND_ERROR)        times = 3;
    else if (soundType == SND_UNKNOWN || soundType == SND_DENIED) times = 2;
    else if (soundType == SND_GRANTED_PRESIDENT)                  times = 3;
    else if (soundType == SND_WIFI_OK)                            times = 2;
    for (int i = 0; i < times; i++) {
      digitalWrite(SIGNAL_PIN, HIGH); delay(200);
      digitalWrite(SIGNAL_PIN, LOW);
      if (i < times - 1) delay(150);
    }
  } else {
    switch (soundType) {
      case SND_GRANTED_LEADER:
        tone(SIGNAL_PIN, 880, 200); delay(220); noTone(SIGNAL_PIN); break;
      case SND_GRANTED_BOARD:
        tone(SIGNAL_PIN, 784, 150); delay(160);
        tone(SIGNAL_PIN, 1175, 280); delay(300); noTone(SIGNAL_PIN); break;
      case SND_GRANTED_PRESIDENT:
        tone(SIGNAL_PIN, 523, 100); delay(120);
        tone(SIGNAL_PIN, 659, 100); delay(120);
        tone(SIGNAL_PIN, 784, 100); delay(120);
        tone(SIGNAL_PIN, 1047, 350); delay(370); noTone(SIGNAL_PIN); break;
      case SND_BANNED:
        tone(SIGNAL_PIN, 400, 350); delay(370);
        tone(SIGNAL_PIN, 250, 350); delay(370);
        tone(SIGNAL_PIN, 150, 500); delay(520); noTone(SIGNAL_PIN); break;
      case SND_UNKNOWN:
        tone(SIGNAL_PIN, 440, 180); delay(220);
        tone(SIGNAL_PIN, 440, 180); delay(200); noTone(SIGNAL_PIN); break;
      case SND_DENIED:
        tone(SIGNAL_PIN, 330, 180); delay(220);
        tone(SIGNAL_PIN, 280, 180); delay(200); noTone(SIGNAL_PIN); break;
      case SND_ERROR:
        tone(SIGNAL_PIN, 200, 200); delay(230);
        tone(SIGNAL_PIN, 200, 200); delay(230);
        tone(SIGNAL_PIN, 200, 200); delay(230); noTone(SIGNAL_PIN); break;
      case SND_WIFI_OK:
        tone(SIGNAL_PIN, 600, 120); delay(140);
        tone(SIGNAL_PIN, 900, 200); delay(220); noTone(SIGNAL_PIN); break;
    }
  }
  digitalWrite(SIGNAL_PIN, HIGH);
  delay(LED_HOLD_MS);
  digitalWrite(SIGNAL_PIN, LOW);
}

// ════════════════════════════════════════════════════════════
// EVENT QUEUE
// ════════════════════════════════════════════════════════════
void queueEvent(const char* uid, const char* name, const char* result) {
  Serial.printf("EVENT: %s | %s | %s\n", uid, name, result);

  if (queueCount >= QUEUE_MAX) {
    memmove(&eventQueue[0], &eventQueue[1],
            sizeof(QueueEntry) * (QUEUE_MAX - 1));
    queueCount = QUEUE_MAX - 1;
  }

  strncpy(eventQueue[queueCount].uid,    uid,    10); eventQueue[queueCount].uid[10]    = '\0';
  strncpy(eventQueue[queueCount].name,   name,   23); eventQueue[queueCount].name[23]   = '\0';
  strncpy(eventQueue[queueCount].result, result, 27); eventQueue[queueCount].result[27] = '\0';
  queueCount++;
}

// ════════════════════════════════════════════════════════════
// SEND EVENT TO SERVER
// ════════════════════════════════════════════════════════════
bool sendToServer(const char* uid, const char* name, const char* result) {
  StaticJsonDocument<256> doc;
  doc["uid"]    = uid;
  doc["name"]   = name;
  doc["result"] = result;

  String body;
  serializeJson(doc, body);

  int code = httpPost(buildURL("/discord/check"), body);
  if (code < 200 || code >= 300) {
    Serial.printf("SERVER ERR: %d\n", code);
    wifiConnected = false;
    return false;
  }
  return true;
}

// ════════════════════════════════════════════════════════════
// SCAN UNKNOWN — server checks DB and notifies Discord
// Returns true if server already knew this card
// ════════════════════════════════════════════════════════════
bool scanUnknown(const char* uid) {
  StaticJsonDocument<128> doc;
  doc["uid"] = uid;

  String body;
  serializeJson(doc, body);

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, buildURL("/discord/check/scan"));
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);
  http.setTimeout(5000);

  int code = http.POST(body);
  if (code != 200) {
    http.end();
    Serial.printf("scanUnknown ERR: %d\n", code);
    return false;
  }

  String resp = http.getString();
  http.end();

  StaticJsonDocument<256> respDoc;
  DeserializationError err = deserializeJson(respDoc, resp);
  if (err) return false;

  return respDoc["known"] | false;
}

// ════════════════════════════════════════════════════════════
// FLUSH QUEUE
// ════════════════════════════════════════════════════════════
void flushQueue() {
  int i = 0;
  while (i < queueCount && wifiConnected) {
    bool ok = sendToServer(
      eventQueue[i].uid,
      eventQueue[i].name,
      eventQueue[i].result
    );
    if (ok) {
      memmove(&eventQueue[i], &eventQueue[i + 1],
              sizeof(QueueEntry) * (queueCount - i - 1));
      queueCount--;
    } else {
      i++;
    }
  }
}

// ════════════════════════════════════════════════════════════
// POLL COMMANDS
// ════════════════════════════════════════════════════════════
void pollCommands() {
  String payload;
  int code = httpGet(buildURL("/discord/check/commands"), payload);

  if (code != 200) {
    if (code > 0) {
      Serial.printf("POLL ERR: %d\n", code);
      wifiConnected = false;
    }
    return;
  }

  DynamicJsonDocument doc(2048);
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.print(F("JSON parse err: ")); Serial.println(err.c_str());
    return;
  }

  JsonArray commands = doc["commands"].as<JsonArray>();
  for (JsonObject cmd : commands) {
    String cmdId  = cmd["id"]     | "";
    String action = cmd["action"] | "";
    String uid    = cmd["uid"]    | "";
    String name   = cmd["name"]   | "";
    String role   = cmd["role"]   | "";
    int    count  = cmd["count"]  | 10;

    if (cmdId.length() == 0 || action.length() == 0) continue;

    Serial.printf("CMD: %s -> %s\n", cmdId.c_str(), action.c_str());
    bool ok = executeCommand(action, uid, name, role, count);
    sendAck(cmdId, ok);
  }
}

// ════════════════════════════════════════════════════════════
// COMMAND EXECUTOR
// ════════════════════════════════════════════════════════════
bool executeCommand(const String& action, const String& uid,
                   const String& name, const String& role, int count) {

  if (action == "ban") {
    return updateRoleInCSV(uid, "banned");

  } else if (action == "unban") {
    return updateRoleInCSV(uid, "Leader");

  } else if (action == "add") {
    return addToCSV(uid, name, role);

  } else if (action == "grant_day") {
    grantDayAccess(uid.c_str());
    lcdPrint(" Bot: Day Grant!", " Full Day Accs");
    delay(1500);
    showIdle();
    return true;

  } else if (action == "block_day") {
    // Block this UID for today only — RAM, clears at midnight
    blockDayAccess(uid.c_str());
    lcdPrint(" Bot: Blocked!", " Until Midnight");
    delay(1500);
    showIdle();
    return true;

  } else if (action == "get_status") {
    unsigned long uptimeMs = millis();
    unsigned long upHr  = uptimeMs / 3600000;
    unsigned long upMin = (uptimeMs % 3600000) / 60000;
    unsigned long upSec = (uptimeMs % 60000) / 1000;

    StaticJsonDocument<256> doc;
    doc["uptime_h"]    = upHr;
    doc["uptime_m"]    = upMin;
    doc["uptime_s"]    = upSec;
    doc["queue_count"] = queueCount;
    doc["wifi_rssi"]   = WiFi.RSSI();
    doc["free_heap"]   = ESP.getFreeHeap();
    doc["time_ready"]  = timeReady;
    doc["day_grants"]  = grantedCount;

    String body;
    serializeJson(doc, body);
    int code = httpPost(buildURL("/discord/check/status-reply"), body);
    return (code >= 200 && code < 300);

  } else if (action == "get_report") {
    StaticJsonDocument<128> doc;
    doc["queue_count"] = queueCount;
    doc["free_heap"]   = ESP.getFreeHeap();
    String body;
    serializeJson(doc, body);
    int code = httpPost(buildURL("/discord/check/report-reply"), body);
    return (code >= 200 && code < 300);
  }

  return false;
}

// ════════════════════════════════════════════════════════════
// ACK
// ════════════════════════════════════════════════════════════
void sendAck(const String& cmdId, bool ok) {
  if (!wifiConnected) return;

  StaticJsonDocument<128> doc;
  doc["id"] = cmdId;
  doc["ok"] = ok;

  String body;
  serializeJson(doc, body);
  httpPost(buildURL("/discord/check/ack"), body);
}

// ════════════════════════════════════════════════════════════
// CSV — UPDATE ROLE
// ════════════════════════════════════════════════════════════
bool updateRoleInCSV(const String& targetUID, const String& newRole) {
  File src = LittleFS.open("/access.csv", "r");
  File tmp = LittleFS.open("/tmp.csv",    "w");
  if (!src || !tmp) return false;

  bool found     = false;
  bool firstLine = true;

  while (src.available()) {
    String line = src.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) { tmp.println(); continue; }

    if (firstLine) {
      firstLine = false;
      if (line.startsWith("Full Name")) {
        tmp.println(line);
        continue;
      }
    }

    int c1 = line.indexOf(',');
    int c2 = line.indexOf(',', c1 + 1);
    if (c1 == -1 || c2 == -1) { tmp.println(line); continue; }

    String entryName = line.substring(0, c1);       entryName.trim();
    String entryUID  = line.substring(c1 + 1, c2);  entryUID.trim();

    unsigned long entryUIDLong  = strtoul(entryUID.c_str(),  NULL, 10);
    unsigned long targetUIDLong = strtoul(targetUID.c_str(), NULL, 10);

    if (entryUIDLong == targetUIDLong) {
      tmp.print(entryName); tmp.print(",");
      tmp.print(padUID(entryUIDLong)); tmp.print(",");
      tmp.println(newRole);
      found = true;
    } else {
      tmp.println(line);
    }
  }
  src.close();
  tmp.close();

  LittleFS.remove("/access.csv");
  LittleFS.rename("/tmp.csv", "/access.csv");

  Serial.printf("ROLE_UPDATED: %s -> %s\n", targetUID.c_str(), newRole.c_str());
  return found;
}

// ════════════════════════════════════════════════════════════
// CSV — ADD NEW MEMBER
// ════════════════════════════════════════════════════════════
bool addToCSV(const String& uid, const String& name, const String& role) {
  if (uid.length() == 0 || name.length() == 0 || role.length() == 0) return false;

  String uidPadded = padUID(strtoul(uid.c_str(), NULL, 10));
  File check = LittleFS.open("/access.csv", "r");
  if (check) {
    while (check.available()) {
      String line = check.readStringUntil('\n');
      if (line.indexOf(uidPadded) != -1) {
        check.close();
        return updateRoleInCSV(uid, role);
      }
    }
    check.close();
  }

  File f = LittleFS.open("/access.csv", "a");
  if (!f) return false;
  f.print(name);      f.print(",");
  f.print(uidPadded); f.print(",");
  f.println(role);
  f.close();

  Serial.printf("ADDED: %s uid=%s role=%s\n",
                name.c_str(), uidPadded.c_str(), role.c_str());
  return true;
}

// ════════════════════════════════════════════════════════════
// LCD HELPERS
// ════════════════════════════════════════════════════════════
String centerName(String name) {
  if (name.length() >= 16) return name.substring(0, 16);
  int pad = (16 - name.length()) / 2;
  String out = "";
  for (int i = 0; i < pad; i++) out += " ";
  out += name;
  return out;
}

void lcdPrint(const char* l1, const char* l2) {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(l1);
  lcd.setCursor(0, 1); lcd.print(l2);
}

void lcdPrint(String l1, String l2) {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(l1.substring(0, 16));
  lcd.setCursor(0, 1); lcd.print(l2.substring(0, 16));
}