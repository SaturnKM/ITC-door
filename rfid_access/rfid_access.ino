// ─────────────────────────────────────────────────────────────────────────────
//  RFID Access Control — ESP32-C3 Super Mini  v4.0
//  Hardware:
//    RDM6300 RFID (TX→GPIO20), LCD 16×2 I²C (SDA=8,SCL=9)
//    LEDs: Green-access(5) Red-access(6) Yellow-busy(7) Green-WiFi(4) Red-err(3)
//    Buzzer(2)  Door-relay(10, active-HIGH)
//  Libraries: ArduinoJson, LiquidCrystal_I2C (Frank de Brabander)
// ─────────────────────────────────────────────────────────────────────────────

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "LittleFS.h"
#include <time.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ─── USER CONFIG ──────────────────────────────────────────────────────────────
#define WIFI_SSID        "DOOR_ACCESS"
#define WIFI_PASSWORD    "DOOR_ACCESS"
#define SERVER_URL       "https://rfid.robtic.org"
#define API_KEY          "hgougYUGTYOUGGyouyouTYOUg54f564sd51414..45_+__+"
#define TIMEZONE_STR     "CET-1"          // Algeria UTC+1, no DST

// ─── PINS ─────────────────────────────────────────────────────────────────────
#define PIN_RFID_RX      20
#define PIN_LED_A_GREEN   5
#define PIN_LED_A_RED     6
#define PIN_LED_YELLOW    7
#define PIN_LED_WIFI      4
#define PIN_LED_ERROR     3
#define PIN_BUZZER        2
#define PIN_RELAY        10

// ─── LCD ──────────────────────────────────────────────────────────────────────
#define LCD_ADDR  0x27   // try 0x3F if blank
#define LCD_COLS  16
#define LCD_ROWS   2
#define I2C_SDA    8
#define I2C_SCL    9
LiquidCrystal_I2C lcd(LCD_ADDR, LCD_COLS, LCD_ROWS);

// ─── CUSTOM LCD CHARACTERS (CGRAM slots 0-5) ──────────────────────────────────
byte CC_LOCK[8]   = {0x0E,0x11,0x11,0x1F,0x1B,0x1B,0x1F,0x00};
byte CC_UNLOCK[8] = {0x0E,0x10,0x10,0x1F,0x1B,0x1B,0x1F,0x00};
byte CC_WIFI[8]   = {0x00,0x0E,0x11,0x04,0x0A,0x00,0x04,0x00};
byte CC_BELL[8]   = {0x04,0x0E,0x0E,0x0E,0x1F,0x00,0x04,0x00};
byte CC_PERSON[8] = {0x04,0x0E,0x04,0x0E,0x15,0x04,0x0A,0x11};
byte CC_DOOR[8]   = {0x0F,0x09,0x0B,0x09,0x0F,0x09,0x09,0x1F};

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
#define MAX_MEMBERS        400
#define CSV_PATH           "/members.csv"
#define PENDING_TIMEOUT    60000UL
#define POLL_INTERVAL_MS    3000UL
#define UPDATE_INTERVAL    30000UL
#define STATUS_INTERVAL    60000UL
#define IDLE_CLOCK_INTERVAL 5000UL
#define ACCESS_HOUR_START     10
#define ACCESS_HOUR_END       16

// ─── MEMBER RECORD ────────────────────────────────────────────────────────────
struct Member {
  char uid[12];
  char name[33];
  char role[20];
  bool dayGrant;
  char dayGrantDate[11];
};

Member members[MAX_MEMBERS];
int    memberCount = 0;

// ─── DEFAULT SEED — built into firmware, loaded if CSV missing ────────────────
struct Seed { const char* uid; const char* name; const char* role; };
const Seed DEFAULTS[] = {
  {"0002787912", "Islem",       "Leader"       },
  {"0007680714", "Djilali",     "ExclusiveBoard"},
  {"0006505824", "Ibtissem",    "Leader"       },
  {"0009860301", "Feriel",      "Leader"       },
  {"0007875382", "Ismail",      "Leader"       },
  {"0003752638", "Khadidja",    "Leader"       },
  {"0010619675", "abdelmadjid", "Leader"       },
  {"0006579751", "Abdellah",    "Leader"       },
  {"0008321581", "Mahdi",       "Leader"       },
  {"0007869479", "Anis",        "Leader"       },
  {"0009686941", "maroua",      "Leader"       },
  {"0014351112", "djamel",      "Leader"       },
  {"0004022966", "Abd Erraouf", "Leader"       },
  {"0006819271", "amira",       "ExclusiveBoard"},
  {"0002672952", "Lafdal",      "Leader"       },
  {"0014755425", "IKHLAS",      "Leader"       },
  {"0006527607", "YAZI",        "President"    },
  {"0014692887", "Ziouani",     "ExclusiveBoard"},
  {"0009660230", "Dhaia",       "Leader"       },
  {"0006557881", "adem",        "ExclusiveBoard"},
  {"0010940033", "Ibrahim",     "Leader"       },
  {"0014883107", "Nour",        "ExclusiveBoard"},
  {"0006587684", "dounia",      "Leader"       },
};
const int DEFAULTS_COUNT = (int)(sizeof(DEFAULTS)/sizeof(DEFAULTS[0]));

// ─── RFID ─────────────────────────────────────────────────────────────────────
HardwareSerial rfidSerial(1);
#define RFID_BAUD  9600
#define RFID_STX   0x02
#define RFID_ETX   0x03
#define RFID_LEN   14
uint8_t rfidBuf[RFID_LEN];
int     rfidPos = 0;

// ─── TIMERS ───────────────────────────────────────────────────────────────────
unsigned long lastUpdatePoll = 0;
unsigned long lastStatusPost = 0;
unsigned long lastIdleClock  = 0;
unsigned long bootMillis     = 0;
bool          wifiAvailable  = false;

// ─── FORWARD DECLARATIONS ────────────────────────────────────────────────────
void  seedDefaults();
void  loadCSV();
void  saveCSV();
int   findMember(const char*);
void  upsertMember(const char*,const char*,const char*,bool,const char*);
void  removeDayGrantsIfNewDay();
bool  tryConnectWiFi();
bool  checkScan(const char*,char*,bool*);
bool  postScan(const char*,const char*,const char*);
bool  pollCommands();
void  postStatus();
void  processCard(const char*);
void  handleUnknownCard(const char*,const char*,const char*);
void  grantAccess(const char*,const char*,const char*,const char*);
void  denyAccess(const char*,const char*,const char*,const char*);
void  openDoor();
void  buzz(int);
void  ledAccess(bool,unsigned long);
void  setWifiLed(bool); void setErrorLed(bool); void setYellow(bool);
bool  parseRFID(char*);
void  getToday(char*); int currentHour(); bool inAccessWindow();
bool  is247Role(const char*); bool isTimeRole(const char*);
const char* shortRole(const char*);
void  lcdInit(); void lcdMsg(const char*,const char*);
void  lcdPrint16(int,const char*); void lcdScroll(int,const char*,int,int);
void  lcdAnimateBoot(); void lcdIdle();
void  lcdScanning(const char*);
void  lcdGranted(const char*,const char*);
void  lcdDenied(const char*,const char*);
void  lcdPending(unsigned long);
void  lcdWifiConnecting(); void lcdOffline();
static uint8_t h2n(uint8_t);

// ─────────────────────────────────────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(400);

  const uint8_t outPins[] = {PIN_LED_A_GREEN,PIN_LED_A_RED,PIN_LED_YELLOW,
                              PIN_LED_WIFI,PIN_LED_ERROR,PIN_BUZZER,PIN_RELAY};
  for (uint8_t p : outPins) { pinMode(p,OUTPUT); digitalWrite(p,LOW); }

  Wire.begin(I2C_SDA, I2C_SCL);
  lcdInit();
  lcdAnimateBoot();

  rfidSerial.begin(RFID_BAUD, SERIAL_8N1, PIN_RFID_RX, -1);

  if (!LittleFS.begin(true)) {
    Serial.println("[FS] Mount failed");
    setErrorLed(true);
    lcdMsg("  FS  ERROR!  ", " Check flash...");
    delay(2000); setErrorLed(false);
  }

  loadCSV();
  bootMillis = millis();

  lcdWifiConnecting();
  wifiAvailable = tryConnectWiFi();

  if (wifiAvailable) {
    configTzTime(TIMEZONE_STR, "pool.ntp.org", "time.cloudflare.com");
    lcdMsg(" Syncing time  ", "  please wait  ");
    delay(2000);
    pollCommands();
  } else {
    lcdOffline();
    delay(1500);
  }

  Serial.printf("[Boot] Ready — %d members  WiFi=%s\n",
                memberCount, wifiAvailable?"YES":"NO");

  for (int i=0;i<3;i++){setYellow(true);delay(120);setYellow(false);delay(120);}
  lcdIdle();
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  removeDayGrantsIfNewDay();

  if (now - lastUpdatePoll >= UPDATE_INTERVAL) {
    lastUpdatePoll = now;
    if (WiFi.status()==WL_CONNECTED) {
      pollCommands(); wifiAvailable=true; setWifiLed(true);
    } else {
      wifiAvailable = tryConnectWiFi();
    }
  }

  if (now - lastStatusPost >= STATUS_INTERVAL) {
    lastStatusPost = now;
    if (WiFi.status()==WL_CONNECTED) postStatus();
  }

  if (now - lastIdleClock >= IDLE_CLOCK_INTERVAL) {
    lastIdleClock = now;
    lcdIdle();
  }

  char uid[12] = {0};
  if (parseRFID(uid)) {
    setYellow(true);
    lcdScanning(uid);
    processCard(uid);
    setYellow(false);
    delay(1200);
    while (rfidSerial.available()) rfidSerial.read();
    lcdIdle();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CARD PROCESSING
// ─────────────────────────────────────────────────────────────────────────────
void processCard(const char* uid) {

  // ── Online ────────────────────────────────────────────────────────────────
  if (WiFi.status()==WL_CONNECTED) {
    char sRole[20]={0}; bool dg=false;
    if (checkScan(uid,sRole,&dg)) {
      int idx=findMember(uid);
      const char* nm=(idx>=0)?members[idx].name:uid;

      if (strcmp(sRole,"banned")==0) {
        denyAccess(uid,nm,sRole,"Banned");
        postScan(uid,nm,"BANNED"); return;
      }
      if (dg) {
        grantAccess(uid,nm,sRole,"Day grant");
        postScan(uid,nm,"GRANTED_LEADER_DAY"); return;
      }
      if (is247Role(sRole)) {
        const char* res=strcmp(sRole,"President")==0?"GRANTED_PRESIDENT":"GRANTED_BOARD";
        grantAccess(uid,nm,sRole,"24/7 access");
        postScan(uid,nm,res); return;
      }
      if (isTimeRole(sRole)) {
        if (!inAccessWindow()) {
          denyAccess(uid,nm,sRole,"Outside hours");
          postScan(uid,nm,"DENIED_HOURS"); return;
        }
        grantAccess(uid,nm,sRole,"Within hours");
        postScan(uid,nm,"GRANTED_LEADER"); return;
      }
      handleUnknownCard(uid,nm,sRole); return;
    }
    handleUnknownCard(uid,uid,"unknown"); return;
  }

  // ── Offline ───────────────────────────────────────────────────────────────
  int idx=findMember(uid);
  if (idx<0) {
    denyAccess(uid,uid,"unknown","Not in list");
    setErrorLed(true); delay(1500); setErrorLed(false); return;
  }
  Member& m=members[idx];
  if (strcmp(m.role,"banned")==0)   { denyAccess(uid,m.name,m.role,"Banned"); return; }
  if (strcmp(m.role,"pending")==0)  { denyAccess(uid,m.name,m.role,"Pending-no WiFi"); return; }
  if (m.dayGrant) {
    char today[11]; getToday(today);
    if (today[0]!='\0' && strcmp(m.dayGrantDate,today)==0) {
      grantAccess(uid,m.name,m.role,"Day grant"); return;
    }
    m.dayGrant=false; m.dayGrantDate[0]='\0'; saveCSV();
  }
  if (is247Role(m.role))  { grantAccess(uid,m.name,m.role,"24/7"); return; }
  if (isTimeRole(m.role)) {
    if (!inAccessWindow()) { denyAccess(uid,m.name,m.role,"Outside hours"); return; }
    grantAccess(uid,m.name,m.role,"Offline OK"); return;
  }
  denyAccess(uid,m.name,m.role,"Unknown role");
}

// ─────────────────────────────────────────────────────────────────────────────
//  PENDING WINDOW
// ─────────────────────────────────────────────────────────────────────────────
void handleUnknownCard(const char* uid, const char* name, const char* role) {
  Serial.printf("[Pending] %s — waiting 60s\n", uid);

  if (WiFi.status()!=WL_CONNECTED) {
    denyAccess(uid,name,role,"Unknown+no WiFi"); return;
  }

  unsigned long deadline = millis()+PENDING_TIMEOUT;

  while (millis()<deadline) {
    lcdPending(deadline);
    delay(POLL_INTERVAL_MS);

    HTTPClient http;
    http.begin(String(SERVER_URL)+"/discord/check/commands");
    http.setTimeout(3000);
    http.addHeader("x-api-key",API_KEY);
    int code=http.GET();

    if (code==200) {
      DynamicJsonDocument doc(8192);
      if (!deserializeJson(doc,http.getStream())) {
        for (JsonObject cmd : doc["commands"].as<JsonArray>()) {
          const char* id    =cmd["id"];
          const char* action=cmd["action"];
          const char* cuid  =cmd["uid"] |"";
          const char* cname =cmd["name"]|"";
          const char* crole =cmd["role"]|"";

          if (id&&id[0]) {
            HTTPClient ack;
            ack.begin(String(SERVER_URL)+"/discord/check/ack");
            ack.setTimeout(2000);
            ack.addHeader("Content-Type","application/json");
            ack.addHeader("x-api-key",API_KEY);
            StaticJsonDocument<128> ad; ad["id"]=id; ad["ok"]=true;
            String ab; serializeJson(ad,ab);
            ack.POST(ab); ack.end();
          }

          bool forUs=(strlen(cuid)==0||strcasecmp(cuid,uid)==0);
          if (!forUs||!action) continue;

          http.end(); setYellow(false);

          if (strcmp(action,"open_door")==0) {
            grantAccess(uid,name,role,"One-time (Discord)"); return;
          }
          if (strcmp(action,"grant_day")==0) {
            char today[11]; getToday(today);
            upsertMember(uid,cname[0]?cname:name,crole[0]?crole:role,true,today);
            saveCSV();
            grantAccess(uid,name,role,"Day grant (Discord)"); return;
          }
          if (strcmp(action,"deny")==0) {
            denyAccess(uid,name,role,"Denied via Discord"); return;
          }
          if (strcmp(action,"ban")==0) {
            upsertMember(uid,cname[0]?cname:name,"banned",false,"");
            saveCSV();
            denyAccess(uid,name,"banned","Banned via Discord"); return;
          }
          if (strcmp(action,"add_member")==0) {
            upsertMember(uid,cname[0]?cname:name,crole[0]?crole:"Member",false,"");
            saveCSV();
            // Don't return — keep waiting for access command
          }
        }
      }
    }
    http.end();
  }

  setYellow(false);
  denyAccess(uid,name,role,"Discord timeout");
}

// ─────────────────────────────────────────────────────────────────────────────
//  ACCESS ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
void grantAccess(const char* uid,const char* name,const char* role,const char* reason) {
  Serial.printf("[GRANT] %s (%s) — %s\n",name,role,reason);
  lcdGranted(name,role);
  openDoor();
  ledAccess(true,2000);
  buzz(0);
}
void denyAccess(const char* uid,const char* name,const char* role,const char* reason) {
  Serial.printf("[DENY]  %s (%s) — %s\n",name,role,reason);
  lcdDenied(name,reason);
  ledAccess(false,2000);
  buzz(1);
}
void openDoor() {
  Serial.println("[DOOR] Open");
  digitalWrite(PIN_RELAY,HIGH); delay(500); digitalWrite(PIN_RELAY,LOW);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROLE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
bool is247Role(const char* r) {
  return strcmp(r,"President")==0||strcmp(r,"ExclusiveBoard")==0;
}
bool isTimeRole(const char* r) {
  return strcmp(r,"Leader")==0||strcmp(r,"Member")==0;
}
const char* shortRole(const char* r) {
  if (strcmp(r,"President")==0)      return "President";
  if (strcmp(r,"ExclusiveBoard")==0) return "Excl.Board";
  if (strcmp(r,"Leader")==0)         return "Leader";
  if (strcmp(r,"Member")==0)         return "Member";
  if (strcmp(r,"banned")==0)         return "BANNED";
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
//  LCD
// ─────────────────────────────────────────────────────────────────────────────
void lcdInit() {
  lcd.init(); lcd.backlight();
  lcd.createChar(0,CC_LOCK);
  lcd.createChar(1,CC_UNLOCK);
  lcd.createChar(2,CC_WIFI);
  lcd.createChar(3,CC_BELL);
  lcd.createChar(4,CC_PERSON);
  lcd.createChar(5,CC_DOOR);
}

void lcdPrint16(int row,const char* text) {
  lcd.setCursor(0,row);
  char buf[17]; snprintf(buf,sizeof(buf),"%-16s",text); lcd.print(buf);
}

void lcdMsg(const char* l1,const char* l2) {
  lcdPrint16(0,l1); lcdPrint16(1,l2);
}

void lcdScroll(int row,const char* text,int dly,int passes) {
  int len=strlen(text);
  if (len<=16) { lcdPrint16(row,text); return; }
  for (int p=0;p<passes;p++) {
    for (int off=0;off<=len-16;off++) {
      lcd.setCursor(0,row);
      for (int i=0;i<16;i++) lcd.print(text[off+i]);
      delay(dly);
    }
    delay(dly*4);
    for (int off=len-16;off>=0;off--) {
      lcd.setCursor(0,row);
      for (int i=0;i<16;i++) lcd.print(text[off+i]);
      delay(dly/2);
    }
  }
}

void lcdAnimateBoot() {
  lcd.clear();
  // Type out title on row 0
  const char* title = " RFID  ACCESS  ";
  for (int i=0;i<15;i++) { lcd.setCursor(i,0); lcd.print(title[i]); delay(55); }
  // Fill row 1 with lock icons
  for (int i=0;i<16;i++) { lcd.setCursor(i,1); lcd.write((uint8_t)0); delay(35); }
  delay(350);
  // Clear row 1, write ready
  lcdPrint16(1,"  System Ready  ");
  delay(600);
}

void lcdIdle() {
  struct tm t;
  bool hasTime=getLocalTime(&t,50);
  bool online=(WiFi.status()==WL_CONNECTED);

  char row0[17],row1[17];

  if (hasTime) {
    strftime(row0,sizeof(row0),"%H:%M  %d/%m/%y",&t);
  } else {
    // door icon + Scan card + lock icon
    row0[0]=(char)5; row0[1]=' ';
    strncpy(row0+2,"Scan your card",14); row0[16]='\0';
  }

  // Row1: person icon + member count + WiFi or lock icon
  snprintf(row1,sizeof(row1),"%c MB:%-3d  %s   ",
           (char)4, memberCount, online?"Online":"Offln");
  // Overwrite last char with wifi or lock icon
  row1[15] = online ? (char)2 : (char)0;
  row1[16] = '\0';

  lcdPrint16(0,row0);
  lcdPrint16(1,row1);
}

void lcdScanning(const char* uid) {
  char row0[17]; row0[0]=(char)3; row0[1]=' ';
  strncpy(row0+2,"Reading...    ",14); row0[16]='\0';
  lcdPrint16(0,row0);
  // UID on row1
  char row1[17]; snprintf(row1,sizeof(row1),"%-16s",uid);
  lcdPrint16(1,row1);
}

void lcdGranted(const char* name,const char* role) {
  // Row0: unlock icon + "ACCESS GRANTED"
  char row0[17]; row0[0]=(char)1; strncpy(row0+1," ACCESS GRANT! ",15); row0[16]='\0';
  lcdPrint16(0,row0);
  // Row1: role short
  char row1[17]; snprintf(row1,sizeof(row1),"%-16s",shortRole(role));
  lcdPrint16(1,row1);
  delay(500);
  // Row0: person icon + name (scroll if long)
  char nameRow[33]; snprintf(nameRow,sizeof(nameRow),"%c %-30s",(char)4,name);
  nameRow[32]='\0';
  int nl=strlen(nameRow);
  if (nl<=16) { lcdPrint16(0,nameRow); delay(1800); }
  else lcdScroll(0,nameRow,220,1);
}

void lcdDenied(const char* name,const char* reason) {
  char row0[17]; row0[0]=(char)0; strncpy(row0+1,"  ACCESS DENY  ",15); row0[16]='\0';
  lcdPrint16(0,row0);
  char row1[17]; snprintf(row1,sizeof(row1),"%-16s",reason);
  lcdPrint16(1,row1);
  delay(600);
  // Show name briefly
  char nameRow[17]; snprintf(nameRow,sizeof(nameRow),"%-16s",name);
  lcdPrint16(1,nameRow);
  delay(1600);
}

// Progress bar countdown — called in the 60s polling loop
void lcdPending(unsigned long deadlineMs) {
  unsigned long ms = (deadlineMs>millis())?(deadlineMs-millis()):0;
  unsigned long secs = ms/1000;

  char row0[17]; row0[0]=(char)3;
  snprintf(row0+1,sizeof(row0)-1," Discord? %2lus  ",secs);
  row0[16]='\0';
  lcdPrint16(0,row0);

  // 10-char shrinking bar
  int filled=(int)(secs*10/(PENDING_TIMEOUT/1000));
  if (filled>10) filled=10;
  char row1[17];
  for (int i=0;i<10;i++) row1[i]=(i<filled)?(char)0xFF:'.';
  row1[10]=' '; row1[11]='W'; row1[12]='a'; row1[13]='i'; row1[14]='t'; row1[15]=' ';
  row1[16]='\0';
  lcdPrint16(1,row1);
}

void lcdWifiConnecting() {
  char row0[17]; row0[0]=(char)2; strncpy(row0+1," Connecting... ",15); row0[16]='\0';
  lcdMsg(row0,WIFI_SSID);
}

void lcdOffline() {
  char row0[17]; row0[0]=(char)0; strncpy(row0+1,"  WiFi Failed  ",15); row0[16]='\0';
  lcdMsg(row0," Offline  mode  ");
}

// ─────────────────────────────────────────────────────────────────────────────
//  LED & BUZZER
// ─────────────────────────────────────────────────────────────────────────────
void ledAccess(bool granted,unsigned long ms) {
  digitalWrite(PIN_LED_A_GREEN,granted?HIGH:LOW);
  digitalWrite(PIN_LED_A_RED,!granted?HIGH:LOW);
  delay(ms);
  digitalWrite(PIN_LED_A_GREEN,LOW); digitalWrite(PIN_LED_A_RED,LOW);
}
void buzz(int p) {
  switch(p) {
    case 0: for(int i=0;i<2;i++){digitalWrite(PIN_BUZZER,HIGH);delay(90);digitalWrite(PIN_BUZZER,LOW);delay(90);} break;
    case 1: digitalWrite(PIN_BUZZER,HIGH);delay(600);digitalWrite(PIN_BUZZER,LOW); break;
    default:for(int i=0;i<3;i++){digitalWrite(PIN_BUZZER,HIGH);delay(70);digitalWrite(PIN_BUZZER,LOW);delay(70);}
  }
}
void setWifiLed(bool on)  {digitalWrite(PIN_LED_WIFI,  on?HIGH:LOW);}
void setErrorLed(bool on) {digitalWrite(PIN_LED_ERROR, on?HIGH:LOW);}
void setYellow(bool on)   {digitalWrite(PIN_LED_YELLOW,on?HIGH:LOW);}

// ─────────────────────────────────────────────────────────────────────────────
//  RFID PARSER — RDM6300
//
//  Frame: STX [10 ASCII-hex bytes] [2 ASCII-hex XOR checksum] ETX  (14 bytes)
//  Decoded into 5 raw bytes:  facility | B1 | B2 | B3 | CHK
//  10-digit decimal UID = big-endian uint32 of raw[0..3]
//  Checksum = raw[0] XOR raw[1] XOR raw[2] XOR raw[3]
//
//  UID format matches card sticker and DB seed values (e.g. "0007680714")
// ─────────────────────────────────────────────────────────────────────────────
static uint8_t h2n(uint8_t c) {
  if(c>='0'&&c<='9') return c-'0';
  if(c>='A'&&c<='F') return c-'A'+10;
  if(c>='a'&&c<='f') return c-'a'+10;
  return 0xFF;
}

bool parseRFID(char* uidOut) {
  while (rfidSerial.available()) {
    uint8_t b=rfidSerial.read();

    if (b==RFID_STX) { rfidPos=0; rfidBuf[rfidPos++]=b; continue; }
    if (rfidPos==0) continue;
    if (rfidPos>=RFID_LEN) { rfidPos=0; continue; }
    rfidBuf[rfidPos++]=b;
    if (rfidPos<RFID_LEN) continue;

    rfidPos=0;

    if (rfidBuf[RFID_LEN-1]!=RFID_ETX) {
      Serial.printf("[RFID] Bad ETX 0x%02X\n",rfidBuf[RFID_LEN-1]); continue;
    }

    bool ok=true;
    for (int i=1;i<=10;i++) if(h2n(rfidBuf[i])==0xFF){ok=false;break;}
    if (!ok) { Serial.println("[RFID] Bad hex"); continue; }

    uint8_t raw[5];
    for (int i=0;i<5;i++)
      raw[i]=(h2n(rfidBuf[1+i*2])<<4)|h2n(rfidBuf[2+i*2]);

    uint8_t chk=raw[0]^raw[1]^raw[2]^raw[3];
    if (chk!=raw[4]) {
      Serial.printf("[RFID] Chk fail: calc=%02X got=%02X | %02X %02X %02X %02X %02X\n",
                    chk,raw[4],raw[0],raw[1],raw[2],raw[3],raw[4]);
      Serial.print("[RFID] Frame: ");
      for(int i=1;i<=12;i++) Serial.print((char)rfidBuf[i]);
      Serial.println();
      continue;
    }

    // 10-digit zero-padded decimal — matches DB seed UIDs
    uint32_t num=((uint32_t)raw[0]<<24)|((uint32_t)raw[1]<<16)|
                 ((uint32_t)raw[2]<<8)|(uint32_t)raw[3];
    snprintf(uidOut,12,"%010lu",(unsigned long)num);
    Serial.printf("[RFID] UID=%s  raw=%02X%02X%02X%02X  chk=%02X\n",
                  uidOut,raw[0],raw[1],raw[2],raw[3],raw[4]);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MEMBER DATABASE
// ─────────────────────────────────────────────────────────────────────────────
int findMember(const char* uid) {
  for (int i=0;i<memberCount;i++)
    if(strcasecmp(members[i].uid,uid)==0) return i;
  return -1;
}
void upsertMember(const char* uid,const char* name,const char* role,bool dg,const char* dgd) {
  int idx=findMember(uid);
  if (idx<0) {
    if(memberCount>=MAX_MEMBERS){Serial.println("[DB] Full!");return;}
    idx=memberCount++;
    strncpy(members[idx].uid,uid,11); members[idx].uid[11]='\0';
  }
  Member& m=members[idx];
  if(name&&name[0]){strncpy(m.name,name,32);m.name[32]='\0';}
  if(role&&role[0]){strncpy(m.role,role,19);m.role[19]='\0';}
  m.dayGrant=dg;
  if(dgd){strncpy(m.dayGrantDate,dgd,10);m.dayGrantDate[10]='\0';}
}

void seedDefaults() {
  for (int i=0;i<DEFAULTS_COUNT;i++)
    upsertMember(DEFAULTS[i].uid,DEFAULTS[i].name,DEFAULTS[i].role,false,"");
  saveCSV();
  Serial.printf("[DB] Seeded %d defaults\n",DEFAULTS_COUNT);
}

// ─────────────────────────────────────────────────────────────────────────────
//  CSV
// ─────────────────────────────────────────────────────────────────────────────
void loadCSV() {
  memberCount=0;
  File f=LittleFS.open(CSV_PATH,"r");
  if (!f) { Serial.println("[CSV] No file — seeding"); seedDefaults(); return; }
  while (f.available()&&memberCount<MAX_MEMBERS) {
    String line=f.readStringUntil('\n'); line.trim();
    if (!line.length()) continue;
    char buf[128]; line.toCharArray(buf,sizeof(buf));
    char uid[12],name[33],role[20],dgs[4],dgd[11];
    char* tok=strtok(buf,",");
    if(!tok) continue; strncpy(uid, tok,11);uid[11] ='\0';
    tok=strtok(NULL,",");if(!tok)continue;strncpy(name,tok,32);name[32]='\0';
    tok=strtok(NULL,",");if(!tok)continue;strncpy(role,tok,19);role[19]='\0';
    tok=strtok(NULL,",");if(!tok)continue;strncpy(dgs, tok, 3);dgs[3]  ='\0';
    tok=strtok(NULL,",");strncpy(dgd,tok?tok:"",10);dgd[10]='\0';
    upsertMember(uid,name,role,atoi(dgs)==1,dgd);
  }
  f.close();
  Serial.printf("[CSV] Loaded %d members\n",memberCount);
  if (memberCount==0) { Serial.println("[CSV] Empty — seeding"); seedDefaults(); }
}

void saveCSV() {
  File f=LittleFS.open(CSV_PATH,"w");
  if (!f){Serial.println("[CSV] Write failed");return;}
  for(int i=0;i<memberCount;i++)
    f.printf("%s,%s,%s,%d,%s\n",
      members[i].uid,members[i].name,members[i].role,
      members[i].dayGrant?1:0,members[i].dayGrantDate);
  f.close();
  Serial.printf("[CSV] Saved %d members\n",memberCount);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MIDNIGHT RESET
// ─────────────────────────────────────────────────────────────────────────────
static char lastCheckedDate[11]="";
void removeDayGrantsIfNewDay() {
  char today[11]; getToday(today);
  if(today[0]=='\0'||strcmp(today,lastCheckedDate)==0) return;
  strncpy(lastCheckedDate,today,10);
  bool ch=false;
  for(int i=0;i<memberCount;i++)
    if(members[i].dayGrant&&strcmp(members[i].dayGrantDate,today)!=0)
      {members[i].dayGrant=false;members[i].dayGrantDate[0]='\0';ch=true;}
  if(ch){saveCSV();Serial.println("[Day] Grants cleared");}
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP
// ─────────────────────────────────────────────────────────────────────────────
bool postScan(const char* uid,const char* name,const char* result) {
  int idx=findMember(uid);
  const char* n=(idx>=0&&members[idx].name[0])?members[idx].name:name;
  HTTPClient http;
  http.begin(String(SERVER_URL)+"/discord/check");
  http.setTimeout(3000);
  http.addHeader("Content-Type","application/json");
  http.addHeader("x-api-key",API_KEY);
  StaticJsonDocument<256> doc;
  doc["uid"]=uid;doc["name"]=n;doc["result"]=result;
  String body;serializeJson(doc,body);
  int code=http.POST(body); http.end(); return code==200;
}

bool checkScan(const char* uid,char* roleOut,bool* dgOut) {
  HTTPClient http;
  http.begin(String(SERVER_URL)+"/discord/check/scan");
  http.setTimeout(4000);
  http.addHeader("Content-Type","application/json");
  http.addHeader("x-api-key",API_KEY);
  StaticJsonDocument<128> req; req["uid"]=uid;
  String body;serializeJson(req,body);
  int code=http.POST(body);
  if(code!=200){http.end();return false;}
  DynamicJsonDocument res(512);
  if(deserializeJson(res,http.getStream())){http.end();return false;}
  http.end();
  if(res["known"]|false){
    strncpy(roleOut,res["role"]|"Member",19);
    *dgOut=res["day_grant"]|false;
    return true;
  }
  return false;
}

bool pollCommands() {
  HTTPClient http;
  http.begin(String(SERVER_URL)+"/discord/check/commands");
  http.setTimeout(3000);
  http.addHeader("x-api-key",API_KEY);
  int code=http.GET();
  if(code!=200){http.end();return false;}
  DynamicJsonDocument doc(8192);
  if(deserializeJson(doc,http.getStream())){http.end();return false;}
  http.end();

  bool changed=false;
  for (JsonObject cmd:doc["commands"].as<JsonArray>()) {
    const char* id    =cmd["id"];
    const char* action=cmd["action"];
    const char* uid   =cmd["uid"] |"";
    const char* name  =cmd["name"]|"";
    const char* role  =cmd["role"]|"";
    if(!action) continue;
    Serial.printf("[Cmd] %s uid=%s\n",action,uid);

    if      (strcmp(action,"open_door")    ==0)          {openDoor();ledAccess(true,1200);buzz(0);}
    else if (strcmp(action,"grant_day")    ==0&&uid[0])  {upsertMember(uid,name,role,true,"");changed=true;}
    else if (strcmp(action,"revoke_day")   ==0&&uid[0])  {
      int i=findMember(uid);
      if(i>=0){members[i].dayGrant=false;members[i].dayGrantDate[0]='\0';changed=true;}
    }
    else if (strcmp(action,"add_member")   ==0&&uid[0])  {upsertMember(uid,name,role,false,"");changed=true;}
    else if (strcmp(action,"update_member")==0&&uid[0])  {upsertMember(uid,name,role,false,"");changed=true;}
    else if (strcmp(action,"ban")          ==0&&uid[0])  {upsertMember(uid,name,"banned",false,"");changed=true;}
    else if (strcmp(action,"get_status")   ==0)          {postStatus();}

    if(id&&id[0]){
      HTTPClient ack;
      ack.begin(String(SERVER_URL)+"/discord/check/ack");
      ack.setTimeout(2000);
      ack.addHeader("Content-Type","application/json");
      ack.addHeader("x-api-key",API_KEY);
      StaticJsonDocument<128> ad;ad["id"]=id;ad["ok"]=true;
      String ab;serializeJson(ad,ab);
      ack.POST(ab);ack.end();
    }
  }
  if(changed) saveCSV();
  return true;
}

void postStatus() {
  HTTPClient http;
  http.begin(String(SERVER_URL)+"/discord/check/status-reply");
  http.setTimeout(3000);
  http.addHeader("Content-Type","application/json");
  http.addHeader("x-api-key",API_KEY);
  char tb[20]="No NTP"; struct tm t;
  if(getLocalTime(&t)) strftime(tb,sizeof(tb),"%H:%M %d/%m/%y",&t);
  StaticJsonDocument<256> doc;
  doc["uptime"]=String((millis()-bootMillis)/1000)+"s";
  doc["rssi"]=WiFi.RSSI();
  doc["memberCount"]=memberCount;
  doc["ip"]=WiFi.localIP().toString();
  doc["freeHeap"]=ESP.getFreeHeap();
  doc["lcd"]=tb;
  String body;serializeJson(doc,body);
  http.POST(body);http.end();
}

// ─────────────────────────────────────────────────────────────────────────────
//  WIFI — quick non-blocking attempt (5 s max)
// ─────────────────────────────────────────────────────────────────────────────
bool tryConnectWiFi() {
  if(WiFi.status()==WL_CONNECTED){setWifiLed(true);return true;}
  Serial.print("[WiFi] Trying");
  WiFi.begin(WIFI_SSID,WIFI_PASSWORD);
  for(int i=0;i<10;i++){
    delay(500);Serial.print(".");setWifiLed(i%2);
    if(WiFi.status()==WL_CONNECTED) break;
  }
  if(WiFi.status()==WL_CONNECTED){
    Serial.printf(" OK %s\n",WiFi.localIP().toString().c_str());
    setWifiLed(true);setErrorLed(false);return true;
  }
  Serial.println(" failed");
  setWifiLed(false);setErrorLed(true);return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TIME
// ─────────────────────────────────────────────────────────────────────────────
void getToday(char* out){
  struct tm t;
  if(!getLocalTime(&t,100)){out[0]='\0';return;}
  strftime(out,11,"%Y-%m-%d",&t);
}
int currentHour(){
  struct tm t;
  if(!getLocalTime(&t,100)) return -1;
  return t.tm_hour;
}
bool inAccessWindow(){
  int h=currentHour();
  if(h<0) return true;  // no NTP yet — allow (offline safe)
  return h>=ACCESS_HOUR_START&&h<ACCESS_HOUR_END;
}
