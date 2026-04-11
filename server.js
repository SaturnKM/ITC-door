// ============================================================
// SERVER.JS — Express API
// ESP32 talks here. This talks to Discord via bot.js.
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

const app  = express();
app.use(express.json());

const PORT    = process.env.PORT    || 3000;
const API_KEY = process.env.API_KEY || "changeme123";

// ── API key middleware ────────────────────────────────────────
const checkKey = (req, res, next) => {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// ════════════════════════════════════════════════════════════
// POST /discord/check
// ESP32 reports a known-member scan result (post-decision).
// Body: { uid, name?, result }
// ════════════════════════════════════════════════════════════
app.post("/discord/check", checkKey, async (req, res) => {
  const { uid, name, result } = req.body;
  if (!uid || !result) return res.status(400).json({ error: "uid and result required" });

  const resolvedName = name || getMember(uid)?.name || "Unknown";
  logScan(uid, resolvedName, result);
  notifyDiscord({ uid, name: resolvedName, result }).catch(e =>
    console.error("[Discord notify error]", e.message)
  );
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// POST /discord/check/scan
// Called on every card scan BEFORE local decision.
// Known members → return role + day_grant so ESP decides locally.
// Unknown/pending → notify Discord with buttons every time.
// Body: { uid }
// ════════════════════════════════════════════════════════════
app.post("/discord/check/scan", checkKey, async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: "uid required" });

  const member = getMember(uid);

  if (member && member.role !== "pending") {
    return res.json({
      known:     true,
      uid:       member.uid,
      name:      member.name,
      role:      member.role,
      day_grant: isGrantedToday(uid),
    });
  }

  // Unknown or still pending — alert Discord every time, never auto-save
  logScan(uid, member?.name || "Unknown", "NOT_IN_LIST");
  notifyDiscord({ uid, name: member?.name || "Unknown", result: "NOT_IN_LIST", askButtons: true })
    .catch(e => console.error("[Discord notify error]", e.message));

  res.json({ known: false, uid, role: "unknown" });
});

// ════════════════════════════════════════════════════════════
// GET /discord/check/commands
// ESP32 polls every UPDATE_INTERVAL ms for pending commands.
// ════════════════════════════════════════════════════════════
app.get("/discord/check/commands", checkKey, (req, res) => {
  res.json({ commands: getPendingCommands() });
});

// ════════════════════════════════════════════════════════════
// POST /discord/check/ack
// ESP32 confirms command receipt.
// Body: { id, ok }
// ════════════════════════════════════════════════════════════
app.post("/discord/check/ack", checkKey, (req, res) => {
  const { id, ok } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });
  ackCommand(id);
  console.log(`[ACK] ${id} ok=${ok}`);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// POST /discord/check/status-reply
// ════════════════════════════════════════════════════════════
app.post("/discord/check/status-reply", checkKey, async (req, res) => {
  notifyDiscord({ result: "STATUS_REPLY", statusData: req.body }).catch(console.error);
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
