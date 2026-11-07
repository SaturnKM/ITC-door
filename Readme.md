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
* **Name-First Notifications:** The request card shows *who* is at the door (name, role, "Registered" / "Not registered") so admins can decide at a glance.
* **Decision Audit Trail:** Every accept/deny shows **who decided and when**, on the card, in the log channel, and in `/log`.
* **Easy Member Adding:** Add people through a pop-up form (no hard-coded command format), right after a decision or with `/addmember`.
* **Concurrent Scanning:** Multi-user request queuing ensures simultaneous scans do not overwrite or block one another.
* **Local Storage & Backup:** Automatic multi-tier CSV back-ups across both the host server and local ESP32 filesystem (`LittleFS`).
* **Time-Based Access Control:** Built-in configurable time-window rules (disabled by default for flexible club schedules).
* **No Tunnels Required:** The bot runs on a dedicated server hosted by **Robo**, so no ngrok, DuckDNS, or other tunneling/dynamic DNS service is needed.
* **🔮 Coming Soon:** Team-based access with scheduled sessions (Robotics, Web, ...). See [Roadmap](#-roadmap-upcoming-updates).

---

## 🏗️ Architecture Overview

```
┌─────────────┐     WiFi/HTTP     ┌──────────────────┐    WebSocket   ┌───────────────┐
│  ESP32-C3   │  ───────────────▶ │  Node.js bot     │ ─────────────▶ │    Discord    │
│  + RDM6300  │ ◀───────────────  │  (Express)       │ ◀───────────── │    (admin)    │
│  + LCD/LED  │   poll for answer │  hosted by Robo  │   button click │               │
└─────────────┘                   └──────────────────┘                └───────────────┘
        │
        └──▶ Relay ──▶ Door lock
```

### Access Rules

| Role | Access Level | Internet Required | Day-Grant Eligible |
| :--- | :--- | :---: | :---: |
| **`President`** | Always | ❌ No | ❌ No |
| **`ExclusiveBoard`**| Always | ❌ No | ❌ No |
| **`Leader`** | Pending or Day-Grant *(+ team sessions, planned)* | ⚠️ For Escalation | 🔑 Yes |
| **`Member`** | Pending or Day-Grant *(+ team sessions, planned)* | ⚠️ For Escalation | 🔑 Yes |
| **`Pending`** | Never | — | ❌ No |
| **`Banned`** | Never | — | ❌ No |

---

## 🖥️ Hosting (Robo's Server)

The bot server is hosted by **Robo**, a friend of the club. This replaces any previous tunnel or dynamic-DNS setup (ngrok, DuckDNS, etc.).

* The bot (`npm start`) runs permanently on Robo's machine/server, ideally under a process manager such as **pm2** or **systemd** so it restarts automatically after a reboot or crash.
* Robo exposes port `3000` (or places the bot behind a reverse proxy) and gives the club a stable **address** (domain or static IP). The ESP32 firmware points at that address.
* Only Robo needs to maintain the host. The club only has to keep the ESP32 firmware's `SERVER_URL` and `API_KEY` in sync with what Robo runs.
* Robo should keep the `.env` file private and back up the `data/` folder regularly.

### Hand-off checklist for Robo

1. Install **Node.js v18+**.
2. Copy the `bot/` folder and create the `.env` file (see below).
3. Run `npm install`, then start with `pm2 start bot.js --name door-bot` (or `npm start`).
4. Open/forward port `3000` (or set up a reverse proxy with HTTPS).
5. Send the club the final address so it can be put in the firmware.

---

## 📂 Repository Structure

```
bot/
├── bot.js          # Entry point — Discord client + Express server
├── commands.js     # Discord slash commands execution (17 commands)
├── api.js          # REST API for the ESP32 + request cards, buttons & forms
├── storage.js      # Member CSV database, logging, & sync queue logic
├── .env            # Private configuration environment variables
├── data/           # Runtime persistent state (auto-created)
│   ├── members.csv
│   ├── members_bak.csv
│   ├── logs.csv
│   ├── update_queue.json
│   └── sessions.csv        # (planned) team session schedule
├── LICENSE         # Unlicense (public domain)
└── README.md       # Project documentation
```

---

## 📋 Prerequisites

* **Node.js** `v18.0.0` or higher
* A registered **Discord Bot Application** with `bot` and `applications.commands` scopes
* Discord Bot permissions: `Send Messages`, `Embed Links`, `Read Message History`
* A host reachable by the ESP32: **Robo's server** (stable domain or static IP, port `3000` open)
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

Create a `.env` file in the `bot/` directory (on Robo's server) with the following contents:

```env
DISCORD_TOKEN=your_bot_token_here
CHANNEL_ID=your_log_channel_id
GUILD_ID=your_server_id
API_KEY=pick_a_long_random_string
PORT=3000
```

> 🔐 **Important:** The `API_KEY` defined here must match the key hardcoded into your ESP32 microcontroller firmware. Share it with Robo privately, never in a public channel.

---

## 📦 Installation & Bot Startup

```bash
cd bot
npm install
npm start
```

For permanent hosting (recommended for Robo):

```bash
npm install -g pm2
pm2 start bot.js --name door-bot
pm2 save
pm2 startup
```

Upon successful startup, the console will output the following operational logs:

```text
[DB] Loaded 24 members
[HTTP] API server listening on port 3000
[BOT] Logged in as YourBot#1234
[BOT] Logging to channel: #door-logs
[CMD] Registered 17 commands to guild 123456789
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

#define SERVER_URL          "ROBO_SERVER_ADDRESS"  // Domain or IP given by Robo
#define SERVER_PORT         3000
#define USE_HTTPS           false                  // Set true if Robo puts the bot behind HTTPS

#define API_KEY             "must_match_.env_exactly"
#define TIMEZONE_STR        "CET-1CEST,M3.5.0,M10.5.0/3"
#define DISABLE_TIME_RULES  true                   // Must be false once team sessions are enabled
```

> 📶 **Network Note:** ESP32-C3 modules operate strictly on **2.4 GHz** Wi-Fi networks.

---

## ⚡ Discord Slash Commands

| Command | Action |
| :--- | :--- |
| `/addmember` | Opens a pop-up form to register a member (name, card UID, role) |
| `/add <name> <uid> [role]` | Registers a new access card (one-line version) |
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
| `/log [n]` | Returns recent entry logs, including who approved each one |
| `/report` | Summarizes access stats |
| `/status` | Returns system diagnostics |
| `/sync` | Re-pushes member databases to the controller |
| `/help` | Returns full command reference |

In the `/addmember` form, the role is plain text and not case-sensitive: `member`, `leader`, `board` (or `exclusive board`), `president`. Leave it empty for `Member`.

### 🔮 Planned commands (team access)

| Command | Action |
| :--- | :--- |
| `/team_add <uid> <team>` | Adds a member to a team (e.g. `robotics`, `web`) |
| `/team_remove <uid> <team>` | Removes a member from a team |
| `/team_list [team]` | Lists members of a team |
| `/session_add <team> <day> <start> <end>` | Creates a recurring weekly session |
| `/session_remove <id>` | Deletes a session |
| `/session_list [team]` | Shows the session schedule |

---

## 🔄 Access Request Workflow

When a card that needs approval is scanned (unregistered card, or a member without a day pass):

1. ESP32 sends a payload to `POST /api/scan` containing `uid` + `request_id`.
2. The bot posts a Discord card with the **name as the headline** and a clear status:
   * **Registered member:** `🔔 Sara wants to enter`, with role and a "✅ Registered member" line.
     Buttons: **🔓 Let In Once**, **📅 Grant 1 Day** (Leader/Member only), **❌ Deny**, **🔨 Ban**.
   * **Unknown card:** `🔔 Unknown card wants to enter`, with a "⚠️ Not registered" line.
     Buttons: **🔓 Let In**, **❌ Deny**, **🔨 Ban**.
   * **Banned member:** `🔴 Name — BANNED member at the door`.
     Buttons: **Unban & Open Door**, **Unban Only**, **Ignore**.
3. When an admin clicks, the card is updated in place: it turns green (accepted), red (denied) or dark red (banned), the buttons are removed, and it shows **who decided and when**.
4. For an **unknown card that was let in or denied**, the card keeps one **➕ Add as Member** button. It opens a form (name, optional role) and registers the card without changing the decision.
5. ESP32 polls `GET /api/pending/:request_id` every 3 seconds.
6. Requests expire after 60 seconds if nobody answers. An expired card for an unregistered person keeps an **➕ Add Member** button, so they can still be registered (the door is not opened, they scan again).
7. The log-channel message for the entry also shows who approved or denied it, and `/log` stores it in the `decided_by` column of `logs.csv`.

---

## 🗺️ Roadmap (Upcoming Updates)

### 1. Team-based access with scheduled sessions (formations)

Members can open the door **without admin approval**, but only for their own team's scheduled sessions. For example, Robotics members during a Robotics session, Web developers during a Web session.

**Teams**
* A new `teams` column in `members.csv` (e.g. `robotics`, `web`, or `robotics|web`).
* Managed with `/team_add`, `/team_remove`, `/team_list`.

**Sessions**
* A new `data/sessions.csv` with the columns `team, day, start, end`:

  | team | day | start | end |
  | :--- | :--- | :--- | :--- |
  | robotics | Saturday | 14:00 | 17:00 |
  | web | Sunday | 10:00 | 13:00 |

* Managed with `/session_add`, `/session_remove`, `/session_list`.

**Access rule**

A card opens the door without admin approval only if all of these are true:

1. The member's role is accepted (`Member` or `Leader`, not `Pending` or `Banned`).
2. The member belongs to a team that has a session running right now.
3. The current time is inside that session's window.

Otherwise the normal Discord approval flow applies. `President` and `ExclusiveBoard` keep unrestricted access.

**Offline behavior**
* The ESP32 stores `/sessions.csv` in LittleFS next to `/members.csv`, so team access keeps working when the server is down.
* Requires `DISABLE_TIME_RULES false` and an NTP-synced clock.
* `/sync` pushes both `members.csv` and `sessions.csv` to the controller.

**Notifications for denied scans**

When a scan is not covered by a session (wrong team or outside hours), the Discord card shows the member's name, role, teams, and the reason, e.g. "Web member scanned during a Robotics session". Admins can still grant one day or access once. Team badges will also be added next to the name on request cards.

**Open questions**
* Should the door open early or stay open late around a session (e.g. 15 minutes before and after)?
* Can Leaders open for their own team outside session hours?
* Are one-off sessions on a specific date needed, or only weekly recurring ones?

### 2. Hosting

* Moving from DuckDNS to **Robo's dedicated server**. No tunneling or dynamic DNS service is used anymore.

---

## 💾 Storage Architecture

Data is stored redundantly across local storage mediums:

| Target File | Device Location | Role |
| :--- | :--- | :--- |
| `data/members.csv` | Robo's server | Primary database |
| `data/members_bak.csv` | Robo's server | Automatic fallback backup |
| `data/logs.csv` | Robo's server | Entry/exit activity audit log (includes who approved) |
| `data/update_queue.json` | Robo's server | Offline synchronization queue |
| `data/sessions.csv` *(planned)* | Robo's server | Team session schedule |
| `/members.csv` | ESP32 `LittleFS` | Offline hardware access database |
| `/members_bak.csv` | ESP32 `LittleFS` | ESP hardware backup |
| `/logs.csv` | ESP32 `LittleFS` | Offline denial logs |
| `/sessions.csv` *(planned)* | ESP32 `LittleFS` | Offline session schedule |

---

## 🔒 Security Best Practices

* All API requests require a matching `x-api-key` header parameter.
* Request IDs prevent replay attacks and race condition overrides.
* CSV writes use atomic file replacement routines to avoid data corruption.
* Input fields are sanitized against character injection attacks.
* Only Robo and the club admins should have access to the `.env` file and `data/` folder.

> 🚨 **HTTPS Warning:** Since the bot is reachable over the internet from Robo's server, place a reverse proxy (such as Caddy or Nginx with Let's Encrypt TLS) in front of the Express server and set `USE_HTTPS true` in the firmware.

---

## 📄 License

This repository is released into the [Public Domain / Unlicense](LICENSE). You are free to modify, distribute, or use this software for any purpose.
