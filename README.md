# ITC-door

offline mode code test1

// --- wiring
/* * ============================================================
 * RFID ACCESS CONTROL - @exlusif_board EDITION
 * ============================================================
 * * [RDM6300 RFID READER]  VCC->5V, GND->GND, TX->Pin 6
 * * [SD CARD MODULE]       VCC->5V, GND->GND, MISO->12, MOSI->11, SCK->13, CS->10
 * * [LCD 16x2 I2C]         VCC->5V, GND->GND, SDA->A4, SCL->A5
 * * [OUTPUTS]              RELAY->4, BUZZER->2, LED->7
 * ============================================================
 */

#include <SPI.h>
#include <SD.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <SoftwareSerial.h>

#define SD_CS 10
#define RELAY 4
#define BUZZER 2
#define LED 7

SoftwareSerial rfid(6, 255); 
LiquidCrystal_I2C lcd(0x27, 16, 2);

// --- Anti-Double Scan Variables ---
unsigned long lastScanTime = 0;
const unsigned long scanDelay = 5000; // 5 seconds wait between scans

void setup() {
  Serial.begin(9600);
  rfid.begin(9600);
  
  pinMode(RELAY, OUTPUT); 
  pinMode(BUZZER, OUTPUT); 
  pinMode(LED, OUTPUT);
  
  digitalWrite(RELAY, HIGH); 
  digitalWrite(LED, LOW);    
  
  lcd.init(); 
  lcd.backlight();

  Serial.println(F("ONLINE_MODE: ACTIVE"));
  
  if (!SD.begin(SD_CS)) {
    Serial.println(F("STARTUP_ERROR: NO_SD"));
  }

  lcd.clear();
  lcd.print("Ready to Scan");
}

void loop() {
  // Only allow scanning if the 'scanDelay' time has passed
  if (rfid.available() && (millis() - lastScanTime > scanDelay)) {
    unsigned long scannedNum = readUIDAsNumber();
    
    if (scannedNum > 0) {
      lastScanTime = millis(); // Record the time of this successful scan
      
      Serial.print(F("SCAN_EVENT: ")); Serial.println(scannedNum);
      
      lcd.clear();
      lcd.print("Checking...");

      // STEP 1: RE-CHECK SD HARDWARE LIVE
      if (!SD.begin(SD_CS)) {
        displaySDError();
      } 
      else {
        checkAccess(scannedNum);
      }
      
      // Clear any data that arrived while the door was opening
      while(rfid.available()) rfid.read(); 
      
      delay(1000); 
      lcd.clear();
      lcd.print("Ready to Scan");
    }
  } else if (rfid.available()) {
    // If a card is detected during the cooldown, just discard the data
    rfid.read();
  }
}

unsigned long readUIDAsNumber() {
  String data = "";
  delay(150); 
  while (rfid.available()) {
    char c = rfid.read();
    if (isHexadecimalDigit(c)) data += c;
  }
  if(data.length() >= 10) {
    String hexPart = data.substring(2, 10);
    char charBuf[9];
    hexPart.toCharArray(charBuf, 9);
    return strtoul(charBuf, NULL, 16); 
  }
  return 0;
}

void checkAccess(unsigned long targetNum) {
  File file = SD.open("access.csv");
  
  if (!file) {
    displaySDError();
    return;
  }

  bool found = false;
  while (file.available()) {
    String line = file.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    int firstComma = line.indexOf(',');
    if (firstComma == -1) continue;

    String csvUidStr = line.substring(0, firstComma);
    unsigned long csvNum = strtoul(csvUidStr.c_str(), NULL, 10);

    if (csvNum == targetNum) {
      int secondComma = line.indexOf(',', firstComma + 1);
      String name = line.substring(firstComma + 1, secondComma);
      String role = line.substring(secondComma + 1);
      name.trim(); role.trim();

      if (role.indexOf("exlusif_board") >= 0) {
        logEvent(targetNum, name, "GRANTED");
        accessGranted(name);
      } else {
        logEvent(targetNum, name, "DENIED_ROLE");
        accessDenied("Wrong Role");
      }
      found = true;
      break;
    }
  }
  
  if (!found) {
    displaySDError(); 
    logEvent(targetNum, "Unknown", "NOT_IN_SD");
  }
  
  file.close();
}

void displaySDError() {
  Serial.println(F("CONN_REQUIRED: NO_SD_OR_UID"));
  lcd.clear();
  lcd.print("no sd card found");
  lcd.setCursor(0, 1);
  lcd.print("need online conn");
  
  for(int i=0; i<3; i++) {
    digitalWrite(BUZZER, HIGH); delay(100); digitalWrite(BUZZER, LOW); delay(50);
  }
}

void logEvent(unsigned long uid, String name, String status) {
  File logFile = SD.open("log.txt", FILE_WRITE);
  if (logFile) {
    logFile.print(uid);
    logFile.print(" | ");
    logFile.print(name);
    logFile.print(" | ");
    logFile.println(status);
    logFile.close();
  }
}

void accessGranted(String name) {
  lcd.clear();
  lcd.print(name);
  lcd.setCursor(0, 1);
  lcd.print("Access Granted");

  digitalWrite(LED, HIGH);      
  digitalWrite(RELAY, LOW);     
  tone(BUZZER, 1000, 200);      
  
  delay(3000); 
  
  digitalWrite(RELAY, HIGH);    
  digitalWrite(LED, LOW);       
}

void accessDenied(String reason) {
  lcd.clear();
  lcd.print("Access Denied");
  lcd.setCursor(0, 1);
  lcd.print(reason);
  tone(BUZZER, 200, 500);
}
