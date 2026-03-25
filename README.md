# ITC-door

/*
 * ============================================================
 *  RFID ACCESS CONTROL - @exlusif_board EDITION
 *  Platform : ESP32-C3 Mini
 *  Phase    : 2 (WiFi on-demand + API + Discord live)
 * ============================================================
 *
 *  PIN WIRING (ESP32-C3 Mini)
 * ┌─────────────────────────────────────────────────────────┐
 *  [RDM6300 RFID]   VCC->5V  GND->GND  TX->GPIO20(RX)
 *  [LCD 16x2 I2C]   VCC->5V  GND->GND
 *                   SDA->GPIO6   SCL->GPIO7
 *  [RELAY]          Signal->GPIO4
 *  [BUZZER+LED]     Both wired in parallel -> GPIO3
 *                   !! PASSIVE BUZZER for tones !!
 *                   Set ACTIVE_BUZZER true if yours is active
 * └─────────────────────────────────────────────────────────┘
 *
 *  WIFI BEHAVIOUR:
 *  - Exclusive Board and President: fully local, NO WiFi needed.
 *  - Leader, banned, unknown, pending: WiFi connects on scan
 *    (if not already connected), sends event, then stays
 *    connected so it can poll bot commands every 5s.
 *  - If WiFi fails, the scan still works locally. Events are
 *    queued and flushed automatically when WiFi returns on
 *    the next non-board scan.
 *  - NTP time is synced on first WiFi connect and kept in
 *    the ESP's internal clock after that.
 *
 *  TIME RULES:
 *  Leader          -> 10:00 - 16:00 only
 *                     (unless granted full day by bot)
 *  Exclusive board -> 24/7  (no WiFi needed)
 *  President       -> 24/7  (no WiFi needed) + fun message
 *
 *  CSV format : Full Name,UID,Role
 *  Roles      : Exclusive board | President | Leader | banned | pending
 *
 *  BOT COMMANDS (received via /commands poll, only active
 *  when WiFi is already connected after a non-board scan):
 *  grant_day  -> gives a Leader full-day access (resets midnight)
 *  ban        -> bans a card
 *  unban      -> restores Leader role
 *  add        -> adds a new member
 *  get_status -> sends uptime / heap / wifi info
 *  get_list   -> sends approved member list
 *  get_pending-> sends pending list
 *  get_log    -> sends recent scan log
 *  get_report -> sends full stats report
 *
 * ============================================================
 */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <time.h>

// ════════════════════════════════════════════════════════════
//  PIN DEFINITIONS
// ════════════════════════════════════════════════════════════
#define RELAY         4
#define SIGNAL_PIN    3

#define RFID_SERIAL   Serial1
#define RFID_RX_PIN   20
#define RFID_TX_PIN   21

// ════════════════════════════════════════════════════════════
//  CONFIGURATION
// ════════════════════════════════════════════════════════════
#define ACTIVE_BUZZER   false   // true = active buzzer (no tones)
#define SKIP_TIME_CHECK false   // true = bypass 10AM-4PM check (testing only)
#define FORCE_REWRITE   false   // true = overwrite access.csv on boot

const char* WIFI_SSID    = "DOOR_ACCESS";
const char* WIFI_PASS    = "DOOR_ACCESS";
const char* API_BASE_URL = "http://localhost:3000/discord/check";  // <- change me 

const int   ACCESS_HOUR_START  = 10;
const int   ACCESS_HOUR_END    = 16;

const unsigned long SCAN_COOLDOWN_MS  = 8000;
const unsigned long DOOR_OPEN_MS      = 3000;
const unsigned long LED_HOLD_MS       = 1500;
const unsigned long POLL_INTERVAL_MS  = 5000;

#define QUEUE_MAX 30

// ════════════════════════════════════════════════════════════
//  EMBEDDED ACCESS LIST
// ════════════════════════════════════════════════════════════
const char* DEFAULT_CSV =
  "Full Name,UID,Role\n"
  "Islem,2787912,Leader\n"
  "Djilali,7680714,Exclusive board\n"
  "Ibtissem,6505824,Leader\n"
  "Feriel,9860301,Leader\n"
  "Ismail,7875382,Leader\n"
  "Khadidja,3752638,Leader\n"
  "abdelmadjid,10619675,Leader\n"
  "Abdellah,6579751,Leader\n"
  "Mahdi,8321581,Leader\n"
  "Anis,7869479,Leader\n"
  "maroua,9686941,Leader\n"
  "djamel,14351112,Leader\n"
  "Abd Erraouf,4022966,Leader\n"
  "amira,6819271,Exclusive board\n"
  "Lafdal,2672952,Leader\n"
  "IKHLAS,14755425,Leader\n"
  "YAZI,6527607,President\n"
  "Ziouani,14692887,Exclusive board\n"
  "Dhaia,9660230,Leader\n"
  "adem,6557881,Exclusive board\n"
  "Ibrahim,10940033,Leader\n"
  "Nour,14883107,Exclusive board\n"
  "dounia,6587684,Leader\n";

// ════════════════════════════════════════════════════════════
//  PRESIDENT MESSAGES
// ════════════════════════════════════════════════════════════
const char* PRESIDENT_MSGS[] = {
  "THE BOSS IS IN",
  "WELCOME CHIEF!",
  "VIP ACCESS :)",
  "BOSS MODE  ON",
  "MAKE WAY !!!",
  "YES SIR!!!!!"
};
const int PRESIDENT_MSG_COUNT = 6;
int presidentMsgIdx = 0;

// ════════════════════════════════════════════════════════════
//  SOUND TYPES
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
//  GLOBALS
// ════════════════════════════════════════════════════════════
LiquidCrystal_I2C lcd(0x27, 16, 2);

unsigned long lastScanTime     = 0;
unsigned long lastPollTime     = 0;
unsigned long lastClockRefresh = 0;
bool          fsReady          = false;
bool          wifiConnected    = false;
bool          timeReady        = false;

// ── Offline event queue ────────────────────────────────────
struct QueueEntry {
  unsigned long uid;
  char name[24];
  char status[24];
};
QueueEntry eventQueue[QUEUE_MAX];
int queueCount = 0;

// ── Stats counters ─────────────────────────────────────────
unsigned long statTotal   = 0;
unsigned long statGranted = 0;
unsigned long statDenied  = 0;
unsigned long statBanned  = 0;
unsigned long statUnknown = 0;
unsigned long bootTime    = 0;

// ── Temporary full-day grants (set by bot) ────────────────
#define GRANT_LIST_MAX 20
unsigned long grantedUIDs[GRANT_LIST_MAX];
int grantedCount = 0;
int grantedDay   = -1;

// ════════════════════════════════════════════════════════════
//  FORWARD DECLARATIONS
// ════════════════════════════════════════════════════════════
void   lcdPrint(String line1, String line2);
String centerName(String name);
String padUID(unsigned long uid);
void   playSound(int soundType);
void   showIdle();
void   openDoor();
bool   ensureWifi();
void   checkAccess(unsigned long uid);
void   flushQueue();
bool   sendToAPI(unsigned long uid, String name, String result);
void   pollCommands();
bool   executeCommand(String action, String uid, String name, String role, int count);
void   sendAck(String cmdId, bool ok);
bool   updateRole(unsigned long targetUID, String newRole);
bool   addToCSV(String uid, String name, String role);
bool   sendStatus();
bool   sendApprovedList();
bool   sendPendingList();
bool   sendRecentLog(int count);
bool   sendFullReport();
bool   isGrantedToday(unsigned long uid);
bool   grantDayAccess(unsigned long uid);
void   accessGrantedLeader(String name, bool dayGrant);
void   accessGrantedBoard(String name);
void   accessGrantedPresident(String name);
void   accessBanned(String name);
void   accessDeniedHours(String name);
void   accessUnknown(unsigned long uid);
void   accessDenied(String name, String reason);
void   queueEvent(unsigned long uid, String name, String status);
unsigned long readUID();
void   flushRFID();
bool   isWithinAccessHours();

// ════════════════════════════════════════════════════════════
//  SETUP
// ════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  bootTime = millis();

  RFID_SERIAL.begin(9600, SERIAL_8N1, RFID_RX_PIN, RFID_TX_PIN);

  pinMode(RELAY,      OUTPUT);
  pinMode(SIGNAL_PIN, OUTPUT);
  digitalWrite(RELAY,      HIGH);
  digitalWrite(SIGNAL_PIN, LOW);

  Wire.begin(6, 7);
  lcd.init();
  lcd.backlight();
  lcdPrint(" @exlusif_board", "  Booting...");
  delay(800);

  // ── LittleFS ──────────────────────────────────────────────
  if (!LittleFS.begin(true)) {
    Serial.println(F("STARTUP_ERROR: LittleFS failed"));
    lcdPrint("  Flash Error!", " Re-flash ESP32");
    playSound(SND_ERROR);
    delay(3000);
  } else {
    fsReady = true;
    Serial.println(F("STARTUP_OK: LittleFS mounted"));
    if (!LittleFS.exists("/access.csv") || FORCE_REWRITE) {
      lcdPrint(" Writing list...", "  Please wait");
      File f = LittleFS.open("/access.csv", "w");
      if (f) { f.print(DEFAULT_CSV); f.close(); Serial.println(F("access.csv written OK")); }
      else   { lcdPrint("  Write Failed", "  Check flash"); playSound(SND_ERROR); delay(3000); }
    } else {
      Serial.println(F("access.csv found in flash"));
    }
  }

  // ── NO WiFi on boot — connects on first non-board scan ────
  showIdle();
  Serial.println(F("SYSTEM_READY"));
}

// ════════════════════════════════════════════════════════════
//  MAIN LOOP
// ════════════════════════════════════════════════════════════
void loop() {

  // ── RFID scan ─────────────────────────────────────────────
  if (RFID_SERIAL.available()) {
    unsigned long uid = readUID();
    if (uid > 0) {
      if (millis() - lastScanTime < SCAN_COOLDOWN_MS) { flushRFID(); return; }
      lastScanTime = millis();
      Serial.print(F("SCAN_EVENT: ")); Serial.println(padUID(uid));
      lcdPrint("  Scanning...", "  Please wait");
      if (!fsReady) { lcdPrint("  Flash Error!", " Cannot check"); playSound(SND_ERROR); }
      else           checkAccess(uid);
      flushRFID();
      delay(400);
      showIdle();
    }
  }

  // ── Flush offline queue (only if WiFi already up) ─────────
  if (wifiConnected && queueCount > 0) flushQueue();

  // ── Poll bot commands (only if WiFi already up) ───────────
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
//  WIFI — connects on demand, only when a non-board scan fires
// ════════════════════════════════════════════════════════════
bool ensureWifi() {
  if (wifiConnected && WiFi.status() == WL_CONNECTED) return true;

  wifiConnected = false;
  lcdPrint(" Connecting...", "  WiFi...");
  Serial.print(F("WIFI: Connecting to ")); Serial.println(WIFI_SSID);

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 20) {
    delay(500); Serial.print("."); tries++;
  }

  wifiConnected = (WiFi.status() == WL_CONNECTED);

  if (wifiConnected) {
    Serial.println(F("\nWIFI: CONNECTED"));
    Serial.print(F("IP: ")); Serial.println(WiFi.localIP());

    // Sync NTP only on first successful connect
    if (!timeReady) {
      configTime(3600, 0, "pool.ntp.org", "time.nist.gov");  // UTC+1, no DST
      struct tm t;
      if (getLocalTime(&t, 8000)) {
        timeReady  = true;
        grantedDay = t.tm_yday;
        Serial.println(F("NTP: Time synced"));
      } else {
        Serial.println(F("NTP: Sync failed"));
      }
    }

    playSound(SND_WIFI_OK);
  } else {
    Serial.println(F("\nWIFI: FAILED"));
    lcdPrint("  WiFi Failed", " Offline Mode");
    delay(1200);
  }

  return wifiConnected;
}

// ════════════════════════════════════════════════════════════
//  IDLE SCREEN
// ════════════════════════════════════════════════════════════
void showIdle() {
  if (timeReady) {
    struct tm t;
    if (getLocalTime(&t)) {
      char timeBuf[17];
      strftime(timeBuf, 17, "    %H:%M:%S    ", &t);
      lcdPrint(" Ready to Scan", timeBuf);
      return;
    }
  }
  lcdPrint(" Ready to Scan", "  No Clock Yet");
}

// ════════════════════════════════════════════════════════════
//  TIME CHECK
// ════════════════════════════════════════════════════════════
bool isWithinAccessHours() {
  if (SKIP_TIME_CHECK) return true;
  if (!timeReady) return false;
  struct tm t;
  if (!getLocalTime(&t)) return false;
  int totalMin = t.tm_hour * 60 + t.tm_min;
  return (totalMin >= ACCESS_HOUR_START * 60 && totalMin < ACCESS_HOUR_END * 60);
}

// ════════════════════════════════════════════════════════════
//  FULL-DAY GRANT HELPERS
// ════════════════════════════════════════════════════════════
bool isGrantedToday(unsigned long uid) {
  if (timeReady) {
    struct tm t;
    if (getLocalTime(&t)) {
      if (grantedDay != t.tm_yday) {
        grantedCount = 0;
        grantedDay   = t.tm_yday;
        Serial.println(F("GRANT_LIST: midnight reset"));
      }
    }
  }
  for (int i = 0; i < grantedCount; i++) {
    if (grantedUIDs[i] == uid) return true;
  }
  return false;
}

bool grantDayAccess(unsigned long uid) {
  if (isGrantedToday(uid)) {
    Serial.print(F("DAY_GRANT: already granted - ")); Serial.println(padUID(uid));
    return true;
  }
  if (grantedCount >= GRANT_LIST_MAX) {
    Serial.println(F("DAY_GRANT: list full"));
    return false;
  }
  grantedUIDs[grantedCount++] = uid;
  Serial.print(F("DAY_GRANT: added - ")); Serial.println(padUID(uid));
  return true;
}

// ════════════════════════════════════════════════════════════
//  RFID
// ════════════════════════════════════════════════════════════
unsigned long readUID() {
  String data = "";
  unsigned long start = millis();
  while (millis() - start < 200) {
    while (RFID_SERIAL.available()) {
      char c = RFID_SERIAL.read();
      if (isHexadecimalDigit(c)) data += c;
    }
  }
  if (data.length() >= 10) {
    String hexPart = data.substring(2, 10);
    char buf[9]; hexPart.toCharArray(buf, 9);
    return strtoul(buf, NULL, 16);
  }
  return 0;
}

void flushRFID() { while (RFID_SERIAL.available()) RFID_SERIAL.read(); }

String padUID(unsigned long uid) {
  String s = String(uid);
  while (s.length() < 10) s = "0" + s;
  return s;
}

// ════════════════════════════════════════════════════════════
//  ACCESS CHECK
// ════════════════════════════════════════════════════════════
void checkAccess(unsigned long uid) {
  File f = LittleFS.open("/access.csv", "r");
  if (!f) {
    lcdPrint(" No access.csv", " Upload via IDE");
    Serial.println(F("ERROR: /access.csv missing"));
    playSound(SND_ERROR);
    return;
  }

  bool found = false, firstLine = true;
  String scannedStr = padUID(uid);

  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;
    if (firstLine) { firstLine = false; if (!isDigit(line.charAt(0))) continue; }

    int c1 = line.indexOf(',');          if (c1 == -1) continue;
    int c2 = line.indexOf(',', c1 + 1);  if (c2 == -1) continue;

    String name      = line.substring(0, c1);        name.trim();
    String csvUIDStr = line.substring(c1 + 1, c2);   csvUIDStr.trim();
    String role      = line.substring(c2 + 1);        role.trim();

    if (padUID(strtoul(csvUIDStr.c_str(), NULL, 10)) != scannedStr) continue;

    statTotal++;

    // ── Exclusive Board: 100% local, door opens instantly ──
    if (role == "Exclusive board") {
      statGranted++;
      accessGrantedBoard(name);
      // Queue for logging — will upload if WiFi comes up later
      queueEvent(uid, name, "GRANTED_BOARD");

    // ── President: 100% local, door opens instantly ────────
    } else if (role == "President") {
      statGranted++;
      accessGrantedPresident(name);
      queueEvent(uid, name, "GRANTED_PRESIDENT");

    // ── Leader: local decision, WiFi triggered for logging ─
    } else if (role == "Leader") {
      lcdPrint(centerName(name), "Status: Pending");
      bool dayGrant = isGrantedToday(uid);
      if (isWithinAccessHours() || dayGrant) {
        statGranted++;
        String evtStatus = dayGrant ? "GRANTED_LEADER_DAY" : "GRANTED_LEADER";
        accessGrantedLeader(name, dayGrant);
        ensureWifi();
        queueEvent(uid, name, evtStatus);
        flushQueue();
      } else {
        statDenied++;
        accessDeniedHours(name);
        ensureWifi();
        queueEvent(uid, name, "DENIED_HOURS");
        flushQueue();
      }

    // ── Banned ────────────────────────────────────────────
    } else if (role == "banned") {
      statBanned++;
      accessBanned(name);
      ensureWifi();
      queueEvent(uid, name, "BANNED");
      flushQueue();

    // ── Pending ───────────────────────────────────────────
    } else if (role == "pending") {
      statDenied++;
      accessDenied(name, "Not Approved");
      ensureWifi();
      queueEvent(uid, name, "DENIED_PENDING");
      flushQueue();

    // ── Invalid role ──────────────────────────────────────
    } else {
      statDenied++;
      accessDenied(name, "Invalid Role");
      ensureWifi();
      queueEvent(uid, name, "DENIED_ROLE");
      flushQueue();
    }

    found = true;
    break;
  }
  f.close();

  // ── Unknown card ───────────────────────────────────────────
  if (!found) {
    statTotal++; statUnknown++;
    accessUnknown(uid);
    ensureWifi();
    queueEvent(uid, "Unknown", "NOT_IN_LIST");
    flushQueue();
  }
}

// ════════════════════════════════════════════════════════════
//  ACCESS OUTCOMES
// ════════════════════════════════════════════════════════════
void accessGrantedLeader(String name, bool dayGrant) {
  String line2;
  if (dayGrant) {
    line2 = "Leader|Full Day";
  } else if (timeReady) {
    struct tm t;
    if (getLocalTime(&t)) {
      char tb[6]; strftime(tb, 6, "%H:%M", &t);
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
  lcdPrint(centerName(name), " Excl. Board  *");
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

void accessUnknown(unsigned long uid) {
  lcdPrint("? Unknown Card", padUID(uid));
  playSound(SND_UNKNOWN);
}

void accessDenied(String name, String reason) {
  lcdPrint(centerName(name), reason);
  playSound(SND_DENIED);
}

void openDoor() {
  digitalWrite(RELAY, LOW);
  delay(DOOR_OPEN_MS);
  digitalWrite(RELAY, HIGH);
}

// ════════════════════════════════════════════════════════════
//  SOUND ENGINE
// ════════════════════════════════════════════════════════════
void playSound(int soundType) {
  if (ACTIVE_BUZZER) {
    int times = 1;
    if (soundType == SND_BANNED  || soundType == SND_ERROR)        times = 3;
    else if (soundType == SND_UNKNOWN || soundType == SND_DENIED)  times = 2;
    else if (soundType == SND_GRANTED_PRESIDENT)                   times = 3;
    else if (soundType == SND_WIFI_OK)                             times = 2;
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
//  RAM EVENT QUEUE
// ════════════════════════════════════════════════════════════
void queueEvent(unsigned long uid, String name, String status) {
  Serial.print(F("EVENT: ")); Serial.print(padUID(uid));
  Serial.print(F(" | ")); Serial.print(name);
  Serial.print(F(" | ")); Serial.println(status);

  if (queueCount >= QUEUE_MAX) {
    for (int i = 0; i < QUEUE_MAX - 1; i++) eventQueue[i] = eventQueue[i + 1];
    queueCount = QUEUE_MAX - 1;
  }
  eventQueue[queueCount].uid = uid;
  name.toCharArray(eventQueue[queueCount].name, 24);
  status.toCharArray(eventQueue[queueCount].status, 24);
  queueCount++;
}

// ════════════════════════════════════════════════════════════
//  API — PUSH EVENTS
// ════════════════════════════════════════════════════════════
void flushQueue() {
  int i = 0;
  while (i < queueCount && wifiConnected) {
    bool ok = sendToAPI(
      eventQueue[i].uid,
      String(eventQueue[i].name),
      String(eventQueue[i].status)
    );
    if (ok) {
      for (int j = i; j < queueCount - 1; j++) eventQueue[j] = eventQueue[j + 1];
      queueCount--;
    } else {
      i++;
    }
  }
}

bool sendToAPI(unsigned long uid, String name, String result) {
  if (!wifiConnected) return false;

  HTTPClient http;
  // Direct Discord API v10 URL
  String url = "https://discord.com/api/v10/channels/YOUR_CHANNEL_ID/messages";
  
  http.begin(url);
  http.addHeader("Authorization", "Bot YOUR_BOT_TOKEN");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);

  // This body creates the buttons in the Discord UI
  String body = "{"
    "\"content\": \"**Access Request**\\n**User:** " + name + "\\n**UID:** " + padUID(uid) + "\","
    "\"components\": [{"
      "\"type\": 1," // Action Row
      "\"components\": ["
        "{\"type\": 2, \"label\": \"Grant 1 Day\", \"style\": 1, \"custom_id\": \"grant_day_" + padUID(uid) + "\"},"
        "{\"type\": 2, \"label\": \"Ban\", \"style\": 4, \"custom_id\": \"ban_" + padUID(uid) + "\"}"
      "]"
    "}]"
  "}";

  int code = http.POST(body);
  http.end();

  if (code < 200 || code >= 300) {
    wifiConnected = false; // Fallback to offline if Discord is unreachable
    WiFi.disconnect();
    return false;
  }
  return true;
}

// ════════════════════════════════════════════════════════════
//  API — POLL COMMANDS (only when WiFi already connected)
// ════════════════════════════════════════════════════════════
void pollCommands() {
  HTTPClient http;
  http.begin(String(API_BASE_URL) + "/commands");
  http.setTimeout(4000);
  int code = http.GET();

  if (code != 200) {
    http.end();
    if (code > 0) {
      Serial.print(F("POLL error: ")); Serial.println(code);
      lcdPrint(" API Unreachable", "  Cmd poll fail");
      delay(1200);
      showIdle();
    }
    return;
  }

  String payload = http.getString();
  http.end();

  // Minimal JSON parser — no ArduinoJson needed
  // Expects: {"commands":[{"id":"x","action":"ban","uid":"y",...},...]}

  int pos = 0;
  while (true) {
    int idStart = payload.indexOf("\"id\"", pos);
    if (idStart == -1) break;

    int q1 = payload.indexOf('"', idStart + 5);
    int q2 = payload.indexOf('"', q1 + 1);
    String cmdId = payload.substring(q1 + 1, q2);

    int actStart = payload.indexOf("\"action\"", idStart);
    int aq1 = payload.indexOf('"', actStart + 8);
    int aq2 = payload.indexOf('"', aq1 + 1);
    String action = payload.substring(aq1 + 1, aq2);

    int nextBlock = payload.indexOf("\"id\"", idStart + 4);
    if (nextBlock == -1) nextBlock = payload.length();

    String uid = "";
    int uidStart = payload.indexOf("\"uid\"", idStart);
    if (uidStart != -1 && uidStart < nextBlock) {
      int uq1 = payload.indexOf('"', uidStart + 5);
      int uq2 = payload.indexOf('"', uq1 + 1);
      uid = payload.substring(uq1 + 1, uq2);
    }

    String name = "";
    int nameStart = payload.indexOf("\"name\"", idStart);
    if (nameStart != -1 && nameStart < nextBlock) {
      int nq1 = payload.indexOf('"', nameStart + 6);
      int nq2 = payload.indexOf('"', nq1 + 1);
      name = payload.substring(nq1 + 1, nq2);
    }

    String role = "";
    int roleStart = payload.indexOf("\"role\"", idStart);
    if (roleStart != -1 && roleStart < nextBlock) {
      int rq1 = payload.indexOf('"', roleStart + 6);
      int rq2 = payload.indexOf('"', rq1 + 1);
      role = payload.substring(rq1 + 1, rq2);
    }

    int count = 10;
    int countStart = payload.indexOf("\"count\"", idStart);
    if (countStart != -1 && countStart < nextBlock) {
      int colonPos = payload.indexOf(':', countStart + 7);
      count = payload.substring(colonPos + 1, nextBlock).toInt();
    }

    Serial.print(F("CMD: ")); Serial.print(cmdId);
    Serial.print(F(" -> ")); Serial.println(action);

    bool ok = executeCommand(action, uid, name, role, count);
    sendAck(cmdId, ok);

    pos = idStart + 4;
  }
}

// ════════════════════════════════════════════════════════════
//  COMMAND EXECUTOR
// ════════════════════════════════════════════════════════════
bool executeCommand(String action, String uid, String name, String role, int count) {

  if (action == "ban") {
    unsigned long targetUID = strtoul(uid.c_str(), NULL, 10);
    return updateRole(targetUID, "banned");

  } else if (action == "unban") {
    unsigned long targetUID = strtoul(uid.c_str(), NULL, 10);
    return updateRole(targetUID, "Leader");

  } else if (action == "add") {
    return addToCSV(uid, name, role);

  } else if (action == "grant_day") {
    unsigned long targetUID = strtoul(uid.c_str(), NULL, 10);
    bool ok = grantDayAccess(targetUID);
    if (ok) {
      lcdPrint(" Bot Grant OK", " Full Day Accs");
      delay(1500);
      showIdle();
    }
    return ok;

  } else if (action == "get_status") {
    return sendStatus();

  } else if (action == "get_list") {
    return sendApprovedList();

  } else if (action == "get_pending") {
    return sendPendingList();

  } else if (action == "get_log") {
    return sendRecentLog(count);

  } else if (action == "get_report") {
    return sendFullReport();
  }

  return false;
}

// ════════════════════════════════════════════════════════════
//  ACK
// ════════════════════════════════════════════════════════════
void sendAck(String cmdId, bool ok) {
  if (!wifiConnected) return;
  HTTPClient http;
  http.begin(String(API_BASE_URL) + "/ack");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);
  String body = "{\"id\":\"" + cmdId + "\",\"ok\":" + (ok ? "true" : "false") + "}";
  http.POST(body);
  http.end();
}

// ════════════════════════════════════════════════════════════
//  CSV OPERATIONS
// ════════════════════════════════════════════════════════════
bool updateRole(unsigned long targetUID, String newRole) {
  File src = LittleFS.open("/access.csv", "r");
  File tmp = LittleFS.open("/tmp.csv", "w");
  if (!src || !tmp) return false;

  bool found = false;
  while (src.available()) {
    String line = src.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    int c1 = line.indexOf(',');
    int c2 = line.indexOf(',', c1 + 1);
    String entryName = line.substring(0, c1);
    unsigned long entryUID = strtoul(line.substring(c1 + 1, c2).c_str(), NULL, 10);

    if (entryUID == targetUID) {
      tmp.print(entryName); tmp.print(",");
      tmp.print(entryUID);  tmp.print(",");
      tmp.println(newRole);
      found = true;
    } else {
      tmp.println(line);
    }
  }
  src.close(); tmp.close();
  LittleFS.remove("/access.csv");
  LittleFS.rename("/tmp.csv", "/access.csv");
  Serial.print(F("ROLE_UPDATED: ")); Serial.print(targetUID);
  Serial.print(F(" -> ")); Serial.println(newRole);
  return found;
}

bool addToCSV(String uid, String name, String role) {
  if (uid.length() == 0 || name.length() == 0 || role.length() == 0) return false;
  File f = LittleFS.open("/access.csv", "a");
  if (!f) return false;
  f.print(name); f.print(",");
  f.print(uid);  f.print(",");
  f.println(role);
  f.close();
  Serial.print(F("ADDED: ")); Serial.print(name);
  Serial.print(F(" uid=")); Serial.print(uid);
  Serial.print(F(" role=")); Serial.println(role);
  return true;
}

// ════════════════════════════════════════════════════════════
//  REPLY SENDERS
// ════════════════════════════════════════════════════════════
bool sendStatus() {
  if (!wifiConnected) return false;

  unsigned long uptimeMs = millis() - bootTime;
  unsigned long upSec = uptimeMs / 1000;
  unsigned long upMin = upSec / 60;
  unsigned long upHr  = upMin / 60;
  upMin %= 60; upSec %= 60;

  HTTPClient http;
  http.begin(String(API_BASE_URL) + "/status-reply");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);
  String body = "{\"uptime_h\":" + String(upHr)
              + ",\"uptime_m\":" + String(upMin)
              + ",\"uptime_s\":" + String(upSec)
              + ",\"queue_count\":" + String(queueCount)
              + ",\"wifi_rssi\":" + String(WiFi.RSSI())
              + ",\"free_heap\":" + String(ESP.getFreeHeap())
              + ",\"time_ready\":" + String(timeReady ? "true" : "false")
              + ",\"day_grants\":" + String(grantedCount)
              + "}";
  int code = http.POST(body);
  http.end();
  return (code >= 200 && code < 300);
}

bool sendApprovedList() {
  if (!wifiConnected) return false;
  File f = LittleFS.open("/access.csv", "r");
  if (!f) return false;

  String json = "{\"members\":[";
  bool first = true, firstLine = true;
  while (f.available()) {
    String line = f.readStringUntil('\n'); line.trim();
    if (line.length() == 0) continue;
    if (firstLine) { firstLine = false; if (!isDigit(line.charAt(0))) continue; }
    int c1 = line.indexOf(',');
    int c2 = line.indexOf(',', c1 + 1);
    String n = line.substring(0, c1);
    String u = line.substring(c1 + 1, c2);
    String r = line.substring(c2 + 1);
    n.trim(); u.trim(); r.trim();
    if (r == "banned" || r == "pending") continue;
    if (!first) json += ",";
    json += "{\"name\":\"" + n + "\",\"uid\":\"" + padUID(strtoul(u.c_str(),NULL,10)) + "\",\"role\":\"" + r + "\"}";
    first = false;
  }
  f.close();
  json += "]}";

  HTTPClient http;
  http.begin(String(API_BASE_URL) + "/list-reply");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(6000);
  int code = http.POST(json);
  http.end();
  return (code >= 200 && code < 300);
}

bool sendPendingList() {
  if (!wifiConnected) return false;
  File f = LittleFS.open("/access.csv", "r");
  if (!f) return false;

  String json = "{\"pending\":[";
  bool first = true, firstLine = true;
  while (f.available()) {
    String line = f.readStringUntil('\n'); line.trim();
    if (line.length() == 0) continue;
    if (firstLine) { firstLine = false; if (!isDigit(line.charAt(0))) continue; }
    int c1 = line.indexOf(',');
    int c2 = line.indexOf(',', c1 + 1);
    String n = line.substring(0, c1);
    String u = line.substring(c1 + 1, c2);
    String r = line.substring(c2 + 1);
    n.trim(); u.trim(); r.trim();
    if (r != "pending") continue;
    if (!first) json += ",";
    json += "{\"name\":\"" + n + "\",\"uid\":\"" + padUID(strtoul(u.c_str(),NULL,10)) + "\"}";
    first = false;
  }
  f.close();
  json += "]}";

  HTTPClient http;
  http.begin(String(API_BASE_URL) + "/pending-reply");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);
  int code = http.POST(json);
  http.end();
  return (code >= 200 && code < 300);
}

bool sendRecentLog(int count) {
  if (!wifiConnected) return false;
  if (count <= 0 || count > QUEUE_MAX) count = 10;

  String json = "{\"log\":[";
  int start = max(0, queueCount - count);
  for (int i = start; i < queueCount; i++) {
    if (i > start) json += ",";
    json += "{\"uid\":\"" + padUID(eventQueue[i].uid) + "\""
            ",\"name\":\"" + String(eventQueue[i].name) + "\""
            ",\"result\":\"" + String(eventQueue[i].status) + "\"}";
  }
  json += "]}";

  HTTPClient http;
  http.begin(String(API_BASE_URL) + "/log-reply");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);
  int code = http.POST(json);
  http.end();
  return (code >= 200 && code < 300);
}

bool sendFullReport() {
  if (!wifiConnected) return false;
  HTTPClient http;
  http.begin(String(API_BASE_URL) + "/report-reply");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);
  String body = "{\"total\":"    + String(statTotal)
              + ",\"granted\":"  + String(statGranted)
              + ",\"denied\":"   + String(statDenied)
              + ",\"banned\":"   + String(statBanned)
              + ",\"unknown\":"  + String(statUnknown)
              + ",\"day_grants\":" + String(grantedCount)
              + "}";
  int code = http.POST(body);
  http.end();
  return (code >= 200 && code < 300);
}

// ════════════════════════════════════════════════════════════
//  LCD HELPERS
// ════════════════════════════════════════════════════════════
String centerName(String name) {
  if (name.length() >= 16) return name.substring(0, 16);
  int pad = (16 - name.length()) / 2;
  String out = "";
  for (int i = 0; i < pad; i++) out += " ";
  out += name;
  return out;
}

void lcdPrint(String line1, String line2) {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1); lcd.print(line2.substring(0, 16));
}
