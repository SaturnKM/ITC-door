// ============================================================
// SERVER.JS — Express API
// ESP32 talks to this. This talks to Discord via bot.js.
// ============================================================
require("dotenv").config();
const express = require("express");
const { startBot, notifyDiscord } = require("./bot");
const {
  getMember,
  upsertMember,
  updateRole,
  logScan,
  getRecentLog,
  getStats,
  isGrantedToday,
  grantDay,
  getPendingCommands,
  ackCommand,
  getApprovedMembers,
  getPendingMembers,
} = require("./database");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Simple API key check (ESP32 sends this as header) ────────
const API_KEY = process.env.API_KEY || "changeme123";
const checkKey = (req, res, next) => {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// ════════════════════════════════════════════════════════════
// POST /discord/check
// ESP32 sends a scan event. We look up the member in SQLite,
// decide access, log it, and notify Discord.
// Body: { uid: "0012345678", name?: "...", result: "GRANTED_LEADER" }
// ════════════════════════════════════════════════════════════
app.post("/discord/check", checkKey, async (req, res) => {
  const { uid, name, result } = req.body;

  if (!uid || !result) {
    return res.status(400).json({ error: "uid and result required" });
  }

  const resolvedName = name || "Unknown";

  // Log to DB
  logScan(uid, resolvedName, result);

  // Notify Discord (fire and forget — don't block ESP32)
  notifyDiscord({ uid, name: resolvedName, result }).catch((e) =>
    console.error("[Discord notify error]", e.message)
  );

  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// POST /discord/check/scan
// Called when an UNKNOWN card is scanned.
// Posts a Discord message with Grant / Ban buttons.
// Body: { uid: "0012345678" }
// ════════════════════════════════════════════════════════════
app.post("/discord/check/scan", checkKey, async (req, res) => {
  const { uid } = req.body;

  if (!uid) return res.status(400).json({ error: "uid required" });

  // Check if we know this person already
  const member = getMember(uid);

  if (member) {
    // Already in DB — return their info so ESP32 can decide locally
    return res.json({
      known: true,
      uid: member.uid,
      name: member.name,
      role: member.role,
      day_grant: isGrantedToday(uid),
    });
  }

  // Truly unknown — add as pending and ask Discord
  upsertMember(uid, "Unknown", "pending", "esp32-scan");
  logScan(uid, "Unknown", "NOT_IN_LIST");

  notifyDiscord({
    uid,
    name: "Unknown",
    result: "NOT_IN_LIST",
    askButtons: true, // triggers Grant/Ban/Add buttons in Discord
  }).catch((e) => console.error("[Discord notify error]", e.message));

  res.json({ known: false, uid, role: "pending" });
});

// ════════════════════════════════════════════════════════════
// GET /discord/check/commands
// ESP32 polls this every 5 seconds.
// Returns pending commands that haven't been acked yet.
// ════════════════════════════════════════════════════════════
app.get("/discord/check/commands", checkKey, (req, res) => {
  const commands = getPendingCommands();
  res.json({ commands });
});

// ════════════════════════════════════════════════════════════
// POST /discord/check/ack
// ESP32 confirms it received + executed a command.
// Body: { id: "cmd_xxx", ok: true }
// ════════════════════════════════════════════════════════════
app.post("/discord/check/ack", checkKey, (req, res) => {
  const { id, ok } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });
  ackCommand(id);
  console.log(`[ACK] Command ${id} acknowledged (ok=${ok})`);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// POST /discord/check/status-reply
// ESP32 sends its status info, we forward to Discord
// ════════════════════════════════════════════════════════════
app.post("/discord/check/status-reply", checkKey, async (req, res) => {
  const data = req.body;
  notifyDiscord({ result: "STATUS_REPLY", statusData: data }).catch(console.error);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// POST /discord/check/list-reply
// ════════════════════════════════════════════════════════════
app.post("/discord/check/list-reply", checkKey, async (req, res) => {
  const { members } = req.body;
  notifyDiscord({ result: "LIST_REPLY", members }).catch(console.error);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// POST /discord/check/pending-reply
// ════════════════════════════════════════════════════════════
app.post("/discord/check/pending-reply", checkKey, async (req, res) => {
  const { pending } = req.body;
  notifyDiscord({ result: "PENDING_REPLY", pending }).catch(console.error);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// POST /discord/check/log-reply
// ════════════════════════════════════════════════════════════
app.post("/discord/check/log-reply", checkKey, async (req, res) => {
  const { log } = req.body;
  notifyDiscord({ result: "LOG_REPLY", log }).catch(console.error);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// POST /discord/check/report-reply
// ════════════════════════════════════════════════════════════
app.post("/discord/check/report-reply", checkKey, async (req, res) => {
  const data = req.body;
  notifyDiscord({ result: "REPORT_REPLY", reportData: data }).catch(console.error);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// Health check
// ════════════════════════════════════════════════════════════
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`[Server] Listening on port ${PORT}`);
  await startBot();
});

module.exports = app;
