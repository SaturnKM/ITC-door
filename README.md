# RFID Door Access System — Setup Guide

## System Overview

```
Discord ← bot.js → server.js (Express) ← ESP32-C3 Super Mini
                         ↕
                    SQLite (access.db)
```

The ESP32 scans cards → asks the server → server checks DB → returns role.  
The ESP32 decides access locally and posts the result back for Discord logging.  
Unknown cards trigger Discord buttons; admins respond within 60 s.

---

## Hardware — ESP32-C3 Super Mini Pin Map

| Component         | ESP32 Pin | Notes                                    |
|-------------------|-----------|------------------------------------------|
| RDM6300 TX        | GPIO 20   | UART1 RX — only this wire needed         |
| RDM6300 VCC       | 5V        | Module needs 5 V                         |
| RDM6300 GND       | GND       |                                          |
| LCD SDA           | GPIO 8    | I²C SDA                                  |
| LCD SCL           | GPIO 9    | I²C SCL                                  |
| LCD VCC           | 3.3 V or 5 V | Check your backpack datasheet         |
| LCD GND           | GND       |                                          |
| Green LED (grant) | GPIO 5    | 220–330 Ω resistor to GND               |
| Red   LED (deny)  | GPIO 6    | 220–330 Ω resistor to GND               |
| Yellow LED (busy) | GPIO 7    | 220–330 Ω resistor to GND               |
| Green LED (WiFi)  | GPIO 4    | 220–330 Ω resistor to GND               |
| Red   LED (error) | GPIO 3    | 220–330 Ω resistor to GND               |
| Buzzer            | GPIO 2    | Active buzzer or passive (5V tolerant)  |
| Door relay IN     | GPIO 10   | Active-HIGH, 500 ms pulse               |

> **LCD I²C address**: Most PCF8574 backpacks are `0x27`. Some are `0x3F`.  
> Change `LCD_ADDR` in the sketch if the display stays blank.

---

## Server Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your env file

Copy `config.env` → `.env` and fill in:

```
BOT_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
GUILD_ID=your_discord_server_id
PORT=3000
API_KEY=your_secret_api_key   # must match API_KEY in the .ino sketch
```

### 3. Start the server

```bash
npm start
# or with PM2 for production:
pm2 start server.js --name rfid-bot
```

### 4. Set the notification channel

In Discord, run:
```
/setchannel
```
in the channel where you want scan alerts.

---

## ESP32 Arduino Setup

### Libraries (install via Arduino Library Manager)
- **ArduinoJson** by Benoit Blanchon (v7.x)
- **LiquidCrystal I2C** by Frank de Brabander
- **LittleFS** — comes with ESP32 board package (no install needed)

### Board settings (Arduino IDE)
- Board: `ESP32C3 Dev Module`
- Flash Size: `4MB (32Mb)`
- Partition Scheme: `Default 4MB with spiffs` (or `No OTA`)
- Upload Speed: `115200` or `921600`

### Edit sketch before uploading
```cpp
#define WIFI_SSID       "your_wifi"
#define WIFI_PASSWORD   "your_password"
#define SERVER_URL      "https://your-server.com"
#define API_KEY         "your_secret_api_key"
#define LCD_ADDR        0x27   // change to 0x3F if blank
```

---

## Role Reference

| Role           | Access hours | Requires WiFi for logging |
|----------------|-------------|--------------------------|
| President      | 24/7        | No (works offline)        |
| ExclusiveBoard | 24/7        | No (works offline)        |
| Leader         | 10:00–16:00 | Yes (for logging)         |
| Member         | 10:00–16:00 | Yes (for logging)         |
| pending        | None        | N/A — shows Discord buttons |
| banned         | None        | Silent Discord notify      |

---

## Discord Commands

| Command | Description |
|---------|-------------|
| `/setchannel` | Set notification channel |
| `/add <uid> <name> <role>` | Add member |
| `/ban <uid> [reason]` | Ban permanently |
| `/unban <uid>` | Restore to Leader |
| `/setrole <uid> <role>` | Change role |
| `/rename <uid> <name>` | Rename member |
| `/grant_day <uid>` | Full-day access (resets midnight) |
| `/revoke_day <uid>` | Remove day grant |
| `/open_door` | Open door now (60 s window) |
| `/list` | Approved members |
| `/pending` | Unknown/pending cards |
| `/log [n]` | Last n scans (default 10) |
| `/report` | Access statistics |
| `/status` | ESP32 vitals |
| `/help` | All commands |

---

## Discord Buttons (unknown card scan)

| Button | Effect | Disables |
|--------|--------|----------|
| Grant 1 Day | Access today only, resets midnight | Grant 1 Day, Access Once, Deny, Ban |
| Access Once | Opens door once (60 s ESP window) | Grant 1 Day, Access Once, Deny, Ban |
| Add Member | Opens modal: enter name + role | Nothing (other buttons stay active) |
| Deny | Logs denial, notifies | Grant 1 Day, Access Once, Deny, Ban |
| Ban | Bans permanently | All buttons |

---

## LCD Display States

| State | Line 1 | Line 2 |
|-------|--------|--------|
| Idle | `Scan your card` | *(blank)* |
| Scanning | `Scanning...` | UID |
| Granted | Member name (scrolls if long) | Role + `>` |
| Denied  | Member name | Role + `X` |
| Waiting | `Waiting...` | `Check Discord` / countdown |
| Boot | `RFID Access` | `Booting...` |
| WiFi fail | `WiFi Failed` | `Offline mode` |

---

## Troubleshooting

**LCD blank after power-on**  
→ Try changing `LCD_ADDR` to `0x3F` in the sketch.  
→ Check I²C wiring (SDA=8, SCL=9).  
→ Run an I²C scanner sketch to find the correct address.

**Cards not reading**  
→ RDM6300 needs 5 V VCC — do not use 3.3 V.  
→ Only connect the TX wire from the module to GPIO 20.

**ESP32 always in offline mode**  
→ Check WIFI_SSID/PASSWORD match exactly (case-sensitive).  
→ ESP32-C3 is 2.4 GHz only — 5 GHz networks will not work.

**Bot not responding to commands**  
→ Ensure CLIENT_ID and GUILD_ID are correct in `.env`.  
→ Bot needs `applications.commands` scope and `bot` scope when invited.

**`/revoke_day` not working**  
→ Updated `database.js` now properly deletes the day grant row.  
Previous version only queued the command without removing the DB record.

**Role mismatch between DB and ESP32**  
→ DB stores `ExclusiveBoard` (one word, no space). The old seed used  
`"Exclusive board"` which the ESP32 did not recognise. Reseed from  
scratch or run:
```sql
UPDATE members SET role='ExclusiveBoard' WHERE role='Exclusive board';
```
