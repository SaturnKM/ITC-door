// ============================================================
//  storage.js — Member database & log management
//  File 4/4  |  RFID Access Control Bot  |  v3.1
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
  { name: "Islem",        uid: "0002787912", role: "Member" },
  { name: "Djilali",      uid: "0007680714", role: "Member" },
  { name: "Ibtissem",     uid: "0006505824", role: "Member" },
  { name: "Feriel",       uid: "0009860301", role: "Member" },
  { name: "Ismail",       uid: "0007875382", role: "Member" },
  { name: "Khadidja",     uid: "0003752638", role: "Member" },
  { name: "abdelmadjid",  uid: "0010619675", role: "Member" },
  { name: "Abdellah",     uid: "0006579751", role: "Member" },
  { name: "Mahdi",        uid: "0008321581", role: "Member" },
  { name: "Anis",         uid: "0007869479", role: "Member" },
  { name: "maroua",       uid: "0009686941", role: "Member" },
  { name: "djamel",       uid: "0014351112", role: "Member" },
  { name: "Abd Erraouf",  uid: "0004022966", role: "Member" },
  { name: "amira",        uid: "0006819271", role: "Member" },
  { name: "Lafdal",       uid: "0002672952", role: "Member" },
  { name: "IKHLAS",       uid: "0014755425", role: "Member" },
  { name: "YAZI",         uid: "0006527607", role: "Member" },
  { name: "Ziouani",      uid: "0014692887", role: "Member" },
  { name: "Dhaia",        uid: "0009660230", role: "Member" },
  { name: "adem",         uid: "0006557881", role: "Member" },
  { name: "Ibrahim",      uid: "0010940033", role: "President" },
  { name: "Nour",         uid: "0014883107", role: "Member" },
  { name: "dounia",       uid: "0006587684", role: "Member" },
  { name: "amani",        uid: "0009962268", role: "Member" },
];

// ─── UID NORMALIZE ───────────────────────────────────────────
function normalizeUID(uid) {
  const s = String(uid).trim().replace(/\D/g, '');
  if (!s) return '';
  return s.slice(-10).padStart(10, '0');
}

// ─── UID MATCH: right-to-left, leading-zero tolerant ─────────
function uidMatch(stored, scanned) {
  const s = String(stored).trim();
  const c = String(scanned).trim();
  if (!s || !c) return false;
  let si = s.length - 1, ci = c.length - 1;
  while (si >= 0 && ci >= 0) {
    if (s[si] !== c[ci]) return false;
    si--; ci--;
  }
  while (si >= 0) {
    if (s[si] !== '0') return false;
    si--;
  }
  return ci < 0;
}

// ─── CSV FIELD SANITIZER ─────────────────────────────────────
function csvField(v) {
  return String(v == null ? '' : v).replace(/,/g, ';').replace(/\r?\n/g, ' ');
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
      uid:          normalizeUID(uid),
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
    `${csvField(m.name)},${csvField(m.uid)},${csvField(m.role)},${m.banned?1:0},${m.dayGrant?1:0},${m.dayGrantDate||0}`
  ).join('\n');
  return header + rows + '\n';
}

// ─── IN-MEMORY DB ────────────────────────────────────────────
let db = [];

function loadMembers() {
  try {
    if (fs.existsSync(MEMBERS_FILE)) {
      db = parseMembersCSV(fs.readFileSync(MEMBERS_FILE, 'utf8'));
      if (db.length > 0) { console.log(`[DB] Loaded ${db.length} members`); return; }
    }
    if (fs.existsSync(MEMBERS_BACKUP)) {
      db = parseMembersCSV(fs.readFileSync(MEMBERS_BACKUP, 'utf8'));
      if (db.length > 0) { console.log(`[DB] Loaded ${db.length} from backup`); saveMembers(); return; }
    }
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
function findByUID(uid) {
  const norm = normalizeUID(uid);
  if (!norm) return null;
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
  if (!normUID) return { ok: false, reason: 'Invalid UID' };
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

function banMember(uid) {
  const normUID = normalizeUID(uid);
  if (!normUID) return { ok: false, reason: 'Invalid UID' };
  let m = findByUID(normUID);
  if (!m) {
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
    if (!fs.existsSync(LOGS_FILE)) {
      fs.writeFileSync(LOGS_FILE, 'timestamp,uid,name,role,event,reason,esp_time\n', 'utf8');
    }
    const line = `${Date.now()},${csvField(entry.uid)},${csvField(entry.name)},${csvField(entry.role)},${csvField(entry.event)},${csvField(entry.reason)},${csvField(entry.time)}\n`;
    fs.appendFileSync(LOGS_FILE, line, 'utf8');
  } catch (e) { console.error('[LOG] Write error:', e.message); }
}

function getRecentLogs(n = 50) {
  try {
    if (!fs.existsSync(LOGS_FILE)) return [];
    const lines = fs.readFileSync(LOGS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const dataLines = lines[0]?.startsWith('timestamp,') ? lines.slice(1) : lines;
    return dataLines.slice(-n).reverse().map(l => {
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
