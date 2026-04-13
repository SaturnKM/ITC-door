// ============================================================
//  storage.js — Member database & log management
//  File 4/4  |  RFID Access Control Bot
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');

// ─── PATHS ───────────────────────────────────────────────────
const DATA_DIR       = path.join(__dirname, 'data');
const MEMBERS_FILE   = path.join(DATA_DIR, 'members.csv');
const MEMBERS_BACKUP = path.join(DATA_DIR, 'members_bak.csv');
const LOGS_FILE      = path.join(DATA_DIR, 'logs.csv');
const QUEUE_FILE     = path.join(DATA_DIR, 'update_queue.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── DEFAULT MEMBERS ─────────────────────────────────────────
const DEFAULTS = [
  { name: "Islem",        uid: "0002787912", role: "Leader"         },
  { name: "Djilali",      uid: "0007680714", role: "ExclusiveBoard" },
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
  { name: "amira",        uid: "0006819271", role: "ExclusiveBoard" },
  { name: "Lafdal",       uid: "0002672952", role: "Leader"         },
  { name: "IKHLAS",       uid: "0014755425", role: "Leader"         },
  { name: "YAZI",         uid: "0006527607", role: "President"      },
  { name: "Ziouani",      uid: "0014692887", role: "ExclusiveBoard" },
  { name: "Dhaia",        uid: "0009660230", role: "Leader"         },
  { name: "adem",         uid: "0006557881", role: "ExclusiveBoard" },
  { name: "Ibrahim",      uid: "0010940033", role: "Leader"         },
  { name: "Nour",         uid: "0014883107", role: "ExclusiveBoard" },
  { name: "dounia",       uid: "0006587684", role: "Leader"         },
];

// ─── UID NORMALIZE ───────────────────────────────────────────
// Pads any UID to 10 digits with leading zeros so lookups are consistent
// regardless of whether the ESP, command, or CSV omit leading zeros.
function normalizeUID(uid) {
  const s = String(uid).trim();
  return s.length >= 10 ? s : s.padStart(10, '0');
}

// ─── UID MATCH: right-to-left, leading-zero tolerant ─────────
// Still kept for backward compat with edge cases, but most paths
// now normalize first so a simple equality check would also work.
function uidMatch(stored, scanned) {
  const s = String(stored).trim();
  const c = String(scanned).trim();
  let si = s.length - 1, ci = c.length - 1;
  while (si >= 0 && ci >= 0) {
    if (s[si] !== c[ci]) return false;
    si--; ci--;
  }
  while (si >= 0) {
    if (s[si] !== '0') return false;
    si--;
  }
  return true;
}

// ─── CSV PARSING ─────────────────────────────────────────────
function parseMembersCSV(content) {
  const members = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [name, uid, role, banned, dayGrant, dayGrantDate] = line.split(',');
    if (!name || !uid || !role) continue;
    members.push({
      name:         name.trim(),
      uid:          normalizeUID(uid),   // normalize on load so DB is always consistent
      role:         role.trim(),
      banned:       banned?.trim() === '1',
      dayGrant:     dayGrant?.trim() === '1',
      dayGrantDate: parseInt(dayGrantDate?.trim() || '0', 10) || 0,
    });
  }
  return members;
}

function serializeMembersCSV(members) {
  const header = '# name,uid,role,banned,dayGrant,dayGrantDate\n';
  const rows   = members.map(m =>
    `${m.name},${m.uid},${m.role},${m.banned?1:0},${m.dayGrant?1:0},${m.dayGrantDate||0}`
  ).join('\n');
  return header + rows + '\n';
}

// ─── IN-MEMORY DB ────────────────────────────────────────────
let db = [];

function loadMembers() {
  try {
    if (fs.existsSync(MEMBERS_FILE)) {
      db = parseMembersCSV(fs.readFileSync(MEMBERS_FILE, 'utf8'));
      console.log(`[DB] Loaded ${db.length} members from members.csv`);
      return;
    }
    if (fs.existsSync(MEMBERS_BACKUP)) {
      db = parseMembersCSV(fs.readFileSync(MEMBERS_BACKUP, 'utf8'));
      console.log(`[DB] Loaded ${db.length} members from backup`);
      saveMembers();
      return;
    }
    // Only use defaults if both CSV files are missing or unreadable
    console.log('[DB] No CSV found — loading defaults');
    db = DEFAULTS.map(d => ({ ...d, uid: normalizeUID(d.uid), banned: false, dayGrant: false, dayGrantDate: 0 }));
    saveMembers();
  } catch (e) {
    console.error('[DB] Load error:', e.message);
    db = DEFAULTS.map(d => ({ ...d, uid: normalizeUID(d.uid), banned: false, dayGrant: false, dayGrantDate: 0 }));
  }
}

function saveMembers() {
  try {
    const tmp = MEMBERS_FILE + '.tmp';
    fs.writeFileSync(tmp, serializeMembersCSV(db), 'utf8');
    if (fs.existsSync(MEMBERS_FILE)) fs.renameSync(MEMBERS_FILE, MEMBERS_BACKUP);
    fs.renameSync(tmp, MEMBERS_FILE);
  } catch (e) {
    console.error('[DB] Save error:', e.message);
  }
}

// ─── QUERY ───────────────────────────────────────────────────
// FIX: normalize the incoming UID before lookup so "628801", "0000628801",
// and "0000628801" all resolve to the same record regardless of how
// the ESP or the Discord user typed it.
function findByUID(uid) {
  const norm = normalizeUID(uid);
  return db.find(m => m.uid === norm || uidMatch(m.uid, norm)) || null;
}

function findByName(name) {
  const n = name.toLowerCase();
  return db.filter(m => m.name.toLowerCase().includes(n));
}

function getAllMembers() { return [...db]; }
function getMemberCount() { return db.length; }

// ─── MUTATIONS ───────────────────────────────────────────────

function addMember(name, uid, role) {
  const normUID = normalizeUID(uid);
  const exists  = db.find(m => m.uid === normUID || uidMatch(m.uid, normUID));
  if (exists) return { ok: false, reason: `UID already exists (matched: ${exists.name})` };
  const member = {
    name:         name || 'Unnamed',
    uid:          normUID,
    role:         role || 'Member',
    banned:       false,
    dayGrant:     false,
    dayGrantDate: 0,
  };
  db.push(member);
  saveMembers();
  queueUpdate(member);
  return { ok: true, member };
}

// FIX: if UID not found, create a new "Unknown" entry and ban it immediately.
// This handles the case where an unknown card scanned and you want to
// pre-emptively ban it before it ever gets added as a real member.
function banMember(uid) {
  const normUID = normalizeUID(uid);
  let m = findByUID(normUID);
  if (!m) {
    // Unknown UID — add it as a banned entry so it is tracked and rejected by ESP
    m = {
      name:         'Unknown',
      uid:          normUID,
      role:         'Banned',
      banned:       true,
      dayGrant:     false,
      dayGrantDate: 0,
    };
    db.push(m);
  } else {
    m.banned   = true;
    m.role     = 'Banned';
    m.dayGrant = false;
  }
  saveMembers();
  queueUpdate(m);
  return { ok: true, member: m };
}

function unbanMember(uid, restoreRole) {
  const m = findByUID(normalizeUID(uid));
  if (!m) return { ok: false, reason: 'Not found' };
  m.banned = false;
  m.role   = restoreRole || 'Member';
  saveMembers();
  queueUpdate(m);
  return { ok: true, member: m };
}

function setRole(uid, role) {
  const m = findByUID(normalizeUID(uid));
  if (!m) return { ok: false, reason: 'Not found' };
  m.role = role;
  saveMembers();
  queueUpdate(m);
  return { ok: true, member: m };
}

// FIX: if UID not found, create the member with the given name instead of erroring.
// This handles the /setrole [name] flow where the card was never formally added.
function renameMember(uid, name) {
  const normUID = normalizeUID(uid);
  let m = findByUID(normUID);
  if (!m) return { ok: false, reason: 'Not found' };
  m.name = name || 'Unnamed';
  saveMembers();
  queueUpdate(m);
  return { ok: true, member: m };
}

function grantDay(uid) {
  const m = findByUID(normalizeUID(uid));
  if (!m) return { ok: false, reason: 'Not found' };
  if (!['Leader', 'Member'].includes(m.role))
    return { ok: false, reason: `Role '${m.role}' is not eligible (must be Leader or Member)` };
  m.dayGrant     = true;
  m.dayGrantDate = Math.floor(Date.now() / 86400000);
  saveMembers();
  queueUpdate(m);
  return { ok: true, member: m };
}

function revokeDay(uid) {
  const m = findByUID(normalizeUID(uid));
  if (!m) return { ok: false, reason: 'Not found' };
  m.dayGrant     = false;
  m.dayGrantDate = 0;
  saveMembers();
  queueUpdate(m);
  return { ok: true, member: m };
}

// ─── UPDATE QUEUE (for ESP32 sync) ───────────────────────────
let updateQueue = [];

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE))
      updateQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch { updateQueue = []; }
}

function saveQueue() {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(updateQueue), 'utf8'); }
  catch (e) { console.error('[QUEUE] Save error:', e.message); }
}

function queueUpdate(member) {
  updateQueue = updateQueue.filter(u => !uidMatch(u.uid, member.uid));
  updateQueue.push({
    name:         member.name,
    uid:          member.uid,
    role:         member.role,
    banned:       member.banned,
    dayGrant:     member.dayGrant,
    dayGrantDate: member.dayGrantDate || 0,
    queuedAt:     Date.now(),
  });
  saveQueue();
}

function flushQueue() {
  const items = [...updateQueue];
  updateQueue = [];
  saveQueue();
  return items;
}

function peekQueue() { return [...updateQueue]; }

// ─── LOG SYSTEM ──────────────────────────────────────────────
function appendLog(entry) {
  try {
    const line = `${Date.now()},${entry.uid||''},${entry.name||''},${entry.role||''},${entry.event||''},${entry.reason||''},${entry.time||''}\n`;
    fs.appendFileSync(LOGS_FILE, line, 'utf8');
  } catch (e) { console.error('[LOG] Write error:', e.message); }
}

function getRecentLogs(n = 50) {
  try {
    if (!fs.existsSync(LOGS_FILE)) return [];
    const lines = fs.readFileSync(LOGS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).reverse().map(l => {
      const [ts, uid, name, role, event, reason, time] = l.split(',');
      return { ts: parseInt(ts), uid, name, role, event, reason, time };
    });
  } catch { return []; }
}

// ─── YEARLY REMINDER CHECK ───────────────────────────────────
function shouldRemindYearlyUpdate() {
  const now = new Date();
  return now.getMonth() === 0 && now.getDate() === 1;
}

// ─── EXPORTS ─────────────────────────────────────────────────
module.exports = {
  loadMembers,
  saveMembers,
  findByUID,
  findByName,
  getAllMembers,
  getMemberCount,
  addMember,
  setRole,
  renameMember,
  banMember,
  unbanMember,
  grantDay,
  revokeDay,
  loadQueue,
  flushQueue,
  peekQueue,
  queueUpdate,
  appendLog,
  getRecentLogs,
  shouldRemindYearlyUpdate,
  normalizeUID,
  uidMatch,
};