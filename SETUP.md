# RFID Access Control — Setup Guide

## What you need
- Your Discord bot token (you have this ✅)
- A GitHub account (free)
- A Railway account (free at railway.app)
- Arduino IDE with ESP32 board support

---

## STEP 1 — Set up the Discord Bot

### 1.1 — Enable required permissions
Go to https://discord.com/developers/applications
Click your bot → **Bot** tab:
- Turn ON: **Server Members Intent**
- Turn ON: **Message Content Intent**

### 1.2 — Invite the bot to your server
Go to **OAuth2 → URL Generator**:
- Scopes: ✅ `bot` ✅ `applications.commands`
- Bot Permissions: ✅ Send Messages ✅ Embed Links ✅ Read Message History ✅ Use Slash Commands

Copy the generated URL → open it → select server **800009861982191617** → Authorize.

---

## STEP 2 — Deploy to Railway

### 2.1 — Push code to GitHub
Create a new GitHub repository (can be private).
Upload these files to it:
```
server.js
bot.js
database.js
package.json
.env.example
```

### 2.2 — Create Railway project
1. Go to https://railway.app → **New Project**
2. Choose **Deploy from GitHub repo** → select your repo
3. Railway will detect Node.js and deploy automatically

### 2.3 — Add environment variables
In Railway → your project → **Variables** tab, add:

| Variable    | Value                                      |
|-------------|-------------------------------------------|
| BOT_TOKEN   | Your Discord bot token                    |
| API_KEY     | A random password (e.g. `rfid_door_2024`) |
| CHANNEL_ID  | Leave blank for now (set via /setchannel) |
| PORT        | 3000                                      |

### 2.4 — Add a volume for the database (so it survives redeploys)
Railway → your project → **+ New** → **Volume**
- Mount path: `/app`  
- This keeps `access.db` alive between deployments

### 2.5 — Get your Railway URL
Railway → your project → **Settings** → copy the public domain.
It looks like: `https://rfid-server-production.up.railway.app`

---

## STEP 3 — Configure the ESP32 firmware

Open `rfid_access.ino` in Arduino IDE and change these lines:

```cpp
const char* WIFI_SSID  = "YOUR_WIFI_NAME";
const char* WIFI_PASS  = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL = "https://YOUR_RAILWAY_URL.up.railway.app";
const char* API_KEY    = "rfid_door_2024"; // must match Railway variable
```

### Required Arduino library
Install via **Sketch → Include Library → Manage Libraries**:
- Search: `ArduinoJson` by Benoit Blanchon → Install (v7.x)

### Board settings
- Board: **ESP32C3 Dev Module**
- Flash Mode: QIO
- Upload Speed: 921600

---

## STEP 4 — Set the notification channel in Discord

After the bot is running and in your server:
1. Go to the channel where you want RFID notifications
2. Type `/setchannel`
3. The bot will confirm and start sending notifications there

Copy the channel ID shown and add it to Railway variables as `CHANNEL_ID`
so it persists after redeploys.

---

## STEP 5 — Test it

1. Flash the ESP32
2. Open Serial Monitor (115200 baud)
3. You should see: `SYSTEM_READY`
4. Scan a card → watch Serial Monitor + Discord channel

---

## Available Discord Commands

| Command              | What it does                                |
|----------------------|---------------------------------------------|
| `/add`               | Add a new member (name, UID, role)          |
| `/ban uid:`          | Ban a card by UID                           |
| `/unban uid:`        | Restore banned card to Leader               |
| `/grant_day uid:`    | Give full-day access (resets midnight)      |
| `/setrole uid: role:`| Change any member's role                   |
| `/list`              | Show all approved members                   |
| `/pending`           | Show cards waiting for approval             |
| `/log`               | Show recent scans (add `count:20` for more) |
| `/report`            | Show access statistics                      |
| `/status`            | Request live ESP32 device info              |
| `/setchannel`        | Set current channel for notifications       |

All commands require **Manage Server** permission.

---

## Unknown Card Flow

When someone scans a card not in the database:
1. LCD shows `? Unknown Card` + UID
2. ESP32 asks Railway server
3. Server asks Discord → message appears with 3 buttons:
   - **Grant 1 Day** — lets them in today only, asks Discord next time
   - **Approve as Leader** — adds them permanently
   - **Ban Card** — blocks them permanently
4. ESP32 picks up the decision on its next 5s poll

---

## Troubleshooting

**Bot not responding to slash commands:**
- Check BOT_TOKEN in Railway variables
- Make sure you enabled Server Members Intent and Message Content Intent

**ESP32 WiFi fails:**
- Check WIFI_SSID and WIFI_PASS in the .ino file
- Board/President cards still work 100% offline

**Clock not showing:**
- NTP retries every 30 seconds automatically after WiFi connects
- Make sure SERVER_URL and API_KEY are correct (WiFi must actually connect)

**`access.csv` not found:**
- Set `FORCE_REWRITE true` in the .ino, flash once, then set back to `false`

**Railway database wiped after redeploy:**
- Make sure you added the Volume with mount path `/app`
- Add `DB_PATH=/app/access.db` to Railway variables
