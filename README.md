# RFID Access Control System

Discord bot + ESP32-C3 + RDM6300 RFID reader

---

## Hardware

| Component        | Connection                          |
|------------------|-------------------------------------|
| RDM6300 TX       | ESP32-C3 GPIO 1 (UART1 RX)         |
| RDM6300 VCC      | 5V                                  |
| RDM6300 GND      | GND                                 |
| LED Green (access granted) | GPIO 2 → 330Ω → GND     |
| LED Red (access denied)    | GPIO 3 → 330Ω → GND     |
| LED Yellow (scanning)      | GPIO 4 → 330Ω → GND     |
| LED Green (WiFi state)     | GPIO 5 → 330Ω → GND     |
| LED Red (error state)      | GPIO 10 → 330Ω → GND    |
| Buzzer           | GPIO 6 → Buzzer+ (active LOW/HIGH) |
| Door relay       | See openDoor() in .ino — add GPIO  |

---

## Bot Setup

```bash
cd access_bot
npm install
```

### config.env
Fill in all fields:
```
BOT_TOKEN=        # From Discord Developer Portal
CLIENT_ID=        # Application ID
GUILD_ID=         # Your server ID (right-click server → Copy ID)
CHANNEL_ID=       # Channel for scan alerts
PORT=3000
API_KEY=          # Any strong random string — must match ESP32 sketch
```

### Run
```bash
node bot.js
```

---

## ESP32 Arduino IDE Setup

### Required libraries (Library Manager)
- **ArduinoJson** by Benoit Blanchon

### Built-in (ESP32 core)
- LittleFS, WiFi, HTTPClient, time.h

### Board settings
- Board: `ESP32C3 Dev Module` (or `ESP32-C3 SuperMini`)
- USB CDC On Boot: Enabled
- Flash Size: 4MB
- Partition Scheme: Default 4MB with spiffs (or Huge APP)

### Edit in rfid_access.ino
```cpp
#define WIFI_SSID       "YOUR_WIFI_SSID"
#define WIFI_PASSWORD   "YOUR_WIFI_PASSWORD"
#define SERVER_URL      "http://192.168.x.x:3000"  // Bot server LAN IP
#define API_KEY         "same_key_as_config_env"
#define TIMEZONE_STR    "CET-1CEST,M3.5.0,M10.5.0/3"  // Algeria
```

Add your door relay to `openDoor()` function.

---

## Role Logic

| Role           | Access Hours | WiFi Required | Notes                    |
|----------------|-------------|---------------|--------------------------|
| President      | 24/7        | No            | Always local             |
| ExclusiveBoard | 24/7        | No            | Always local             |
| Leader         | 10:00–16:00 | For logging   | Local time decision      |
| Member         | 10:00–16:00 | For logging   | Same as Leader           |
| pending        | Never       | Yes           | Shows Discord buttons    |
| banned         | Never       | For notify    | Silent Discord notify    |
| Unknown        | Never       | Yes           | Shows Discord buttons    |

### Day Grant
- Overrides time restriction — access all day
- Resets automatically at midnight (ESP checks date on each scan)
- Admin can revoke with `/revoke_day`

---

## Discord Buttons (Unknown/Pending scan)

| Button      | Effect                                          | Disables                        |
|-------------|------------------------------------------------|---------------------------------|
| Grant 1 Day | Access today, reset midnight                   | Itself, Access Once, Deny, Ban  |
| Access Once | ESP opens door once (1 min pickup window)      | Itself, Grant 1 Day, Deny, Ban  |
| Add Member  | Opens modal: name + role                       | Nothing (can still use others)  |
| Deny        | Logs denial, notifies                          | Itself, Grant 1 Day, Access Once, Ban |
| Ban         | Permanent ban, queues ESP update               | All buttons                     |

---

## Slash Commands

| Command              | Description                              |
|----------------------|------------------------------------------|
| `/add uid name role` | Add member, sync to ESP                  |
| `/ban uid [reason]`  | Ban permanently                          |
| `/unban uid`         | Restore to Leader                        |
| `/grant_day uid`     | Full-day access                          |
| `/revoke_day uid`    | Remove day grant                         |
| `/open_door`         | Open door on demand                      |
| `/setrole uid role`  | Change role, sync to ESP                 |
| `/rename uid name`   | Rename member                            |
| `/list`              | Approved members                         |
| `/pending`           | Pending/unknown cards                    |
| `/log [count]`       | Recent scan events                       |
| `/report`            | Stats for today                          |
| `/status`            | ESP32 vitals                             |
| `/help`              | All commands explained                   |

---

## ESP32 ↔ Bot API

| Endpoint              | Method | Purpose                               |
|-----------------------|--------|---------------------------------------|
| `/api/scan`           | POST   | ESP reports card scan / unknown card  |
| `/api/command/:uid`   | GET    | ESP polls for command (60s window)    |
| `/api/updates`        | GET    | ESP polls for member changes (30s)    |
| `/api/status`         | POST   | ESP reports vitals (60s)              |
| `/api/members`        | GET    | ESP fetches full list on boot         |

All requests require `x-api-key` header matching `API_KEY` in config.env.

---

## LED States

| LED           | State           | Meaning                       |
|---------------|-----------------|-------------------------------|
| Yellow        | On / blinking   | Scanning / waiting for Discord|
| Green (access)| On 2s then off  | Access granted                |
| Red (access)  | On 2s then off  | Access denied                 |
| Green (WiFi)  | Solid           | WiFi connected                |
| Green (WiFi)  | Off             | No WiFi                       |
| Red (error)   | Solid           | Error / problem               |

## Buzzer Patterns
- **2 short beeps** — Access granted
- **1 long beep** — Access denied
- **3 short beeps** — Error
