// ============================================================
// DATABASE — SQLite via better-sqlite3
// FIXED: unixepoch() compatibility, stats fields
// ============================================================
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "access.db");
const db = new Database(DB_PATH);

// ── Enable WAL mode for reliability ─────────────────────────
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Helper for Unix timestamp (compatible with older SQLite)
const nowUnix = () => Math.floor(Date.now() / 1000);

// ── Schema ───────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    uid       TEXT    NOT NULL UNIQUE,
    role      TEXT    NOT NULL DEFAULT 'pending',
    added_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    added_by  TEXT    NOT NULL DEFAULT 'system'
  );

  CREATE TABLE IF NOT EXISTS scan_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    uid       TEXT    NOT NULL,
    name      TEXT    NOT NULL DEFAULT 'Unknown',
    result    TEXT    NOT NULL,
    scanned_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS day_grants (
    uid       TEXT    NOT NULL,
    granted_day INTEGER NOT NULL,
    PRIMARY KEY (uid, granted_day)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_commands (
    id        TEXT    PRIMARY KEY,
    action    TEXT    NOT NULL,
    uid       TEXT    NOT NULL DEFAULT '',
    name      TEXT    NOT NULL DEFAULT '',
    role      TEXT    NOT NULL DEFAULT '',
    count     INTEGER NOT NULL DEFAULT 10,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    acked     INTEGER NOT NULL DEFAULT 0
  );
`);

// ── Seed default members from original CSV if table is empty ─
const seedMembers = () => {
  const count = db.prepare("SELECT COUNT(*) as c FROM members").get().c;
  if (count > 0) return;

  const defaults = [
    { name: "Islem",        uid: "0002787912", role: "Leader"         },
    { name: "Djilali",      uid: "0007680714", role: "Exclusive board" },
    { name: "Ibtissem",     uid: "0006505824", role: "Leader"         },
    { name: "Feriel",       uid: "0009860301", role: "Leader"         },
    { name: "Ismail",       uid: "0007875382", role: "Leader"         },
    { name: "Khadidja",     uid: "0003752638", role: "Leader"         },
    { name: "abdelmadjid",  uid: "0010619675", role: "Leader"         },
    { name: "Abdellah",     uid: "0006579751", role: "Leader"         },
    { name: "Mahdi",        uid: "0008321581", role: "Leader"         },
    { name: "Anis",         uid: "0007869479", role: "Leader"         },
    { name: "maroua",       uid: "0009686941", role: "Leader"         },
    { name: "djamel",       uid: "0014351112", role: "Leader"         },
    { name: "Abd Erraouf",  uid: "0004022966", role: "Leader"         },
    { name: "amira",        uid: "0006819271", role: "Exclusive board" },
    { name: "Lafdal",       uid: "0002672952", role: "Leader"         },
    { name: "IKHLAS",       uid: "0014755425", role: "Leader"         },
    { name: "YAZI",         uid: "0006527607", role: "President"      },
    { name: "Ziouani",      uid: "0014692887", role: "Exclusive board" },
    { name: "Dhaia",        uid: "0009660230", role: "Leader"         },
    { name: "adem",         uid: "0006557881", role: "Exclusive board" },
    { name: "Ibrahim",      uid: "0010940033", role: "Leader"         },
    { name: "Nour",         uid: "0014883107", role: "Exclusive board" },
    { name: "dounia",       uid: "0006587684", role: "Leader"         },
  ];

  const insert = db.prepare(
    "INSERT OR IGNORE INTO members (name, uid, role, added_by) VALUES (?, ?, ?, 'seed')"
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insert.run(r.name, r.uid, r.role);
  });
  insertMany(defaults);
  console.log(`[DB] Seeded ${defaults.length} default members`);
};

seedMembers();

// ════════════════════════════════════════════════════════════
// MEMBER QUERIES
// ════════════════════════════════════════════════════════════

const getMember = (uid) =>
  db.prepare("SELECT * FROM members WHERE uid = ?").get(uid);

const getApprovedMembers = () =>
  db
    .prepare(
      "SELECT * FROM members WHERE role NOT IN ('banned','pending') ORDER BY name COLLATE NOCASE"
    )
    .all();

const getPendingMembers = () =>
  db.prepare("SELECT * FROM members WHERE role = 'pending' ORDER BY added_at DESC").all();

const getAllMembers = () =>
  db.prepare("SELECT * FROM members ORDER BY name COLLATE NOCASE").all();

const upsertMember = (uid, name, role, addedBy = "bot") => {
  db.prepare(`
    INSERT INTO members (uid, name, role, added_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET name=excluded.name, role=excluded.role
  `).run(uid, name, role, addedBy);
};

const updateRole = (uid, newRole) => {
  const result = db
    .prepare("UPDATE members SET role = ? WHERE uid = ?")
    .run(newRole, uid);
  return result.changes > 0;
};

// ════════════════════════════════════════════════════════════
// SCAN LOG
// ════════════════════════════════════════════════════════════

const logScan = (uid, name, result) =>
  db.prepare("INSERT INTO scan_log (uid, name, result) VALUES (?, ?, ?)").run(uid, name, result);

const getRecentLog = (n = 10) =>
  db
    .prepare(
      "SELECT * FROM scan_log ORDER BY scanned_at DESC LIMIT ?"
    )
    .all(n);

// FIXED: Added missing stats fields
const getStats = () =>
  db
    .prepare(`
      SELECT
        COUNT(*)                                          AS total,
        SUM(result LIKE 'GRANTED%')                      AS granted,
        SUM(result LIKE 'DENIED%')                       AS denied,
        SUM(result = 'BANNED')                           AS banned,
        SUM(result = 'NOT_IN_LIST')                      AS unknown,
        SUM(result = 'GRANTED_ONCE')                     AS once,
        SUM(result = 'GRANTED_REMOTE')                   AS remote,
        SUM(result = 'GRANTED_LEADER_DAY')               AS day_grants
      FROM scan_log
    `)
    .get();

// ════════════════════════════════════════════════════════════
// DAY GRANTS (FIXED: uses UTC consistently)
// ════════════════════════════════════════════════════════════

const todayDOY = () => {
  const now = new Date();
  // Use UTC to avoid timezone issues
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 0));
  const diff = now.getTime() - start.getTime();
  return Math.floor(diff / 86400000);
};

const isGrantedToday = (uid) => {
  const row = db
    .prepare("SELECT 1 FROM day_grants WHERE uid = ? AND granted_day = ?")
    .get(uid, todayDOY());
  return !!row;
};

const grantDay = (uid) => {
  db
    .prepare(
      "INSERT OR IGNORE INTO day_grants (uid, granted_day) VALUES (?, ?)"
    )
    .run(uid, todayDOY());
};

// ════════════════════════════════════════════════════════════
// PENDING COMMANDS
// ════════════════════════════════════════════════════════════

const pushCommand = (id, action, uid = "", name = "", role = "", count = 10) => {
  db.prepare(`
    INSERT OR IGNORE INTO pending_commands (id, action, uid, name, role, count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, action, uid, name, role, count);
};

const getPendingCommands = () =>
  db
    .prepare("SELECT * FROM pending_commands WHERE acked = 0 ORDER BY created_at ASC")
    .all();

const ackCommand = (id) =>
  db.prepare("UPDATE pending_commands SET acked = 1 WHERE id = ?").run(id);

// ════════════════════════════════════════════════════════════
// CLEANUP
// ════════════════════════════════════════════════════════════
setInterval(() => {
  const deleted = db
    .prepare(
      "DELETE FROM pending_commands WHERE acked = 1 AND created_at < strftime('%s', 'now') - 86400"
    )
    .run();
  if (deleted.changes > 0)
    console.log(`[DB] Cleaned up ${deleted.changes} old commands`);
}, 3600_000);

// ════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════

const saveSetting = (key, value) =>
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);

const getSetting = (key) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
};

const saveChannelId = (channelId) => saveSetting("notify_channel_id", channelId);
const getChannelId = () => getSetting("notify_channel_id");

module.exports = {
  db,
  getMember,
  getApprovedMembers,
  getPendingMembers,
  getAllMembers,
  upsertMember,
  updateRole,
  logScan,
  getRecentLog,
  getStats,
  isGrantedToday,
  grantDay,
  pushCommand,
  getPendingCommands,
  ackCommand,
  saveSetting,
  getSetting,
  saveChannelId,
  getChannelId,
};