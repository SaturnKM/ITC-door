# RFID Access Control System

![System Architecture](https://img.shields.io/badge/Architecture-ESP32--C3%20%2B%20Node.js%20%2B%20Discord-blue)
![License](https://img.shields.io/badge/License-Unlicense-green)
![Status](https://img.shields.io/badge/Status-Production--Ready-brightgreen)

An offline-first, production-ready door access system using an **ESP32-C3 Super Mini**, **RDM6300 RFID reader**, and a **Node.js/Discord bot** management interface.

> ⚠️ **Note:** This project was built with the assistance of AI. It is a complete, fully functioning system, but you should review the codebase prior to trusting it with critical physical security. Feel free to fork, adapt, or build upon it!

---

## 🌟 Key Features

* **Offline-First Access:** Presidents and Exclusive Board members can unlock doors instantly without an internet or local network connection.
* **Discord Integration:** Approve, deny, or manage door access requests using Discord slash commands and interactive buttons from anywhere.
* **Concurrent Scanning:** Multi-user request queuing ensures simultaneous scans do not overwrite or block one another.
* **Local Storage & Backup:** Automatic multi-tier CSV back-ups across both the host server and local ESP32 filesystem (`LittleFS`).
* **Time-Based Access Control:** Built-in configurable time-window rules (disabled by default for flexible club schedules).

---

## 🏗️ Architecture Overview

```
┌─────────────┐     WiFi/HTTP     ┌──────────────┐    WebSocket   ┌───────────────┐
│  ESP32-C3   │  ───────────────▶ │  Node.js bot │ ─────────────▶ │    Discord    │
│  + RDM6300  │ ◀───────────────  │  (Express)   │ ◀───────────── │    (admin)    │
│  + LCD/LED  │   poll for answer │              │   button click │               │
└─────────────┘                   └──────────────┘                └───────────────┘
        │
        └──▶ Relay ──▶ Door lock
```

### Access Rules

| Role | Access Level | Internet Required | Day-Grant Eligible |
| :--- | :--- | :---: | :---: |
| **`President`** | Always | ❌ No | ❌ No |
| **`ExclusiveBoard`**| Always | ❌ No | ❌ No |
| **`Leader`** | Pending or Day-Grant | ⚠️ For Escalation | 🔑 Yes |
| **`Member`** | Pending or Day-Grant | ⚠️ For Escalation | 🔑 Yes |
| **`Pending`** | Never | — | ❌ No |
| **`Banned`** | Never | — | ❌ No |

---

## 📂 Repository Structure

```
bot/
├── bot.js          # Entry point — Discord client + Express server
├── commands.js     # Discord slash commands execution (16 commands)
├── api.js          # REST API endpoints for the ESP32 controller
├── storage.js      # Member CSV database, logging, & sync queue logic
├── .env            # Private configuration environment variables
├── data/           # Runtime persistent state (auto-created)
│   ├── members.csv
│   ├── members_bak.csv
│   ├── logs.csv
│   └── update_queue.json
└── README.md       # Project documentation
```

---

## 📋 Prerequisites

* **Node.js** `v18.0.0` or higher
* A registered **Discord Bot Application** with `bot` and `applications.commands` scopes
* Discord Bot permissions: `Send Messages`, `Embed Links`, `Read Message History`
* Host PC on the local network (or accessible remotely via dynamic DNS, e.g., DuckDNS)
* Arduino IDE (or PlatformIO) configured for ESP32 target boards

---

## 🚀 Discord Bot Setup

1. Navigate to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create a **New Application** and set a name.
3. Under the **Bot** tab, select **Reset Token** and copy the generated token string.
4. Go to **OAuth2 → URL Generator**:
   * Select scopes: `bot`, `applications.commands`.
   * Select permissions: `Send Messages`, `Embed Links`, `Read Message History`.
5. Open the generated invite URL to add the bot to your Discord server.
6. Enable **Developer Mode** in your Discord client, right-click your administrative log channel, and click **Copy Channel ID**.

### Environment Configuration (`.env`)

Create a `.env` file in the `bot/` directory with the following contents:

```env
BOT_TOKEN=your_bot_token_here
CHANNEL_ID=your_log_channel_id
GUILD_ID=your_server_id
API_KEY=pick_a_long_random_string
PORT=3000
```

> 🔐 **Important:** The `API_KEY` defined here must match the key hardcoded into your ESP32 microcontroller firmware.

---

## 📦 Installation & Bot Startup

```bash
cd bot
npm install
npm start
```

Upon successful startup, the console will output the following operational logs:

```text
[DB] Loaded 24 members
[HTTP] API server listening on port 3000
[BOT] Logged in as YourBot#1234
[BOT] Logging to channel: #door-logs
[CMD] Registered 16 commands to guild 123456789
```

---

## 🛠️ Microcontroller Setup (ESP32-C3)

### Required Arduino Libraries

* **ArduinoJson** (`>= 7.x`) by Benoit Blanchon
* **LiquidCrystal I2C** by Frank de Brabander
* **LittleFS** *(Built-in to ESP32 core)*

### Arduino IDE Board Settings

* **Board:** `ESP32C3 Dev Module`
* **USB CDC On Boot:** `Enabled`
* **Flash Size:** `4MB`
* **Partition Scheme:** `Default 4MB with spiffs`

### Pin Mapping

| Component Pin | ESP32-C3 Pin | Notes |
| :--- | :--- | :--- |
| **RDM6300 TX** | `GPIO 20` | Level-shifted / voltage divided if required |
| **RDM6300 GND** | `GND` | Common ground |
| **RDM6300 VCC** | `5V` | **Requires 5V, do not use 3.3V** |
| **LCD SDA** | Default I2C SDA | Varies per Super Mini board revision |
| **LCD SCL** | Default I2C SCL | Varies per Super Mini board revision |
| **Green LED (Access)** | `GPIO 5` | Controls door relay switch |
| **Red LED (Access)** | `GPIO 6` | Access denied indicator |
| **Yellow LED (Status)**| `GPIO 7` | Pending access state |
| **Green LED (WiFi)** | `GPIO 8` | Network connectivity indicator |
| **Red LED (Error)** | `GPIO 9` | File system fault indicator |
| **Buzzer** | `GPIO 10` | Audible notification feedback |

> ⚠️ **Pinout Caution:** Pinouts vary between vendor board revisions. If your LCD display fails to initialize, explicitly declare pins in `setup()`: `Wire.begin(SDA_PIN, SCL_PIN);`.

### Firmware Configuration (`ITC_DOOR.ino`)

```cpp
#define WIFI_SSID           "YOUR_2.4GHZ_SSID"
#define WIFI_PASSWORD       "YOUR_WIFI_PASSWORD"

#define SERVER_URL          "ITCDOOR.duckdns.org"  // Or local LAN IP
#define SERVER_PORT         3000
#define USE_HTTPS           false                  // Plain HTTP for local/DuckDNS setups

#define API_KEY             "must_match_.env_exactly"
#define TIMEZONE_STR        "CET-1CEST,M3.5.0,M10.5.0/3"
#define DISABLE_TIME_RULES  true
```

> 📶 **Network Note:** ESP32-C3 modules operate strictly on **2.4 GHz** Wi-Fi networks.

---

## ⚡ Discord Slash Commands

| Command | Action |
| :--- | :--- |
| `/add <name> <uid> [role]` | Registers a new access card |
| `/ban <uid>` | Revokes access permanently |
| `/unban <uid> [role]` | Restores access permissions |
| `/grant_day <uid>` | Authorizes access until midnight |
| `/revoke_day <uid>` | Cancels an active single-day grant |
| `/revoke_access <uid>` | Strips all temporary door permissions |
| `/open_door` | Remotely triggers door relay (8-second window) |
| `/setrole <uid> <role>` | Updates a user's permission group |
| `/rename <uid> <name>` | Updates cardholder description |
| `/list [role]` | Displays registered members by category |
| `/pending` | Shows active authorization requests |
| `/log [n]` | Returns real-time entry logs |
| `/report` | Summarizes access stats |
| `/status` | Returns system diagnostics |
| `/sync` | Re-pushes member databases to the controller |
| `/help` | Returns full command reference |

---

## 🔄 Unknown Card Workflow

When an unassigned card (or member without day-access) is scanned:

1. ESP32 sends a payload to `POST /api/scan` containing `uid` + `request_id`.
2. Bot renders a Discord notification card with action options:
   * **✅ Grant 1 Day** — Authorizes access until midnight.
   * **🔓 Access Once** — Single entry authorization (60s timer).
   * **➕ Add Member** — Displays registration modal.
   * **❌ Deny** — Denies access request.
   * **🔨 Ban** — Blacklists card UID.
3. ESP32 polls `GET /api/pending/:request_id` every 3 seconds.
4. Requests automatically expire after 60 seconds if no action is taken.

---

## 💾 Storage Architecture

Data is stored redundantly across local storage mediums:

| Target File | Device Location | Role |
| :--- | :--- | :--- |
| `data/members.csv` | Host Server PC | Primary database |
| `data/members_bak.csv` | Host Server PC | Automatic fallback backup |
| `data/logs.csv` | Host Server PC | Entry/exit activity audit log |
| `data/update_queue.json` | Host Server PC | Offline synchronization queue |
| `/members.csv` | ESP32 `LittleFS` | Offline hardware access database |
| `/members_bak.csv` | ESP32 `LittleFS` | ESP hardware backup |
| `/logs.csv` | ESP32 `LittleFS` | Offline denial logs |

---

## 🔒 Security Best Practices

* All API requests require a matching `x-api-key` header parameter.
* Request IDs prevent replay attacks and race condition overrides.
* CSV writes use atomic file replacement routines to avoid data corruption.
* Input fields are sanitized against character injection attacks.

> 🚨 **HTTPS Warning:** For public internet deployments, place a reverse proxy (such as Caddy or Nginx with Let's Encrypt TLS) in front of the Express server.

---

## 📄 License

This repository is released into the [Public Domain / Unlicense](LICENSE). You are free to modify, distribute, or use this software for any purpose.