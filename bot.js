// ─────────────────────────────────────────────────────────────────────────────
//  RFID Access Control — Discord Bot + ESP32 API Server
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config({ path: './config.env' });

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder
} = require('discord.js');
const express = require('express');
const fs      = require('fs');
const path    = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const TOKEN      = process.env.BOT_TOKEN;
const CLIENT_ID  = process.env.CLIENT_ID;
const GUILD_ID   = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const API_KEY    = process.env.API_KEY;
const PORT       = parseInt(process.env.PORT) || 3000;

const MEMBERS_FILE = path.join(__dirname, 'members.json');
const LOGS_FILE    = path.join(__dirname, 'logs.json');
const MAX_LOGS     = 200;

// ─── Discord + Express init ───────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app    = express();
app.use(express.json());

// ─── In-memory state ─────────────────────────────────────────────────────────
// members  : { [uid]: { uid, name, role, dayGrant, dayGrantDate } }
// pendingScans: { [uid]: { ts, messageId } }
// commandQueue: { [uid]: [{ cmd, data, ts }] }  ← consumed by ESP during 60s window
// updateQueue : [{ type, uid, name, role, dayGrant, dayGrantDate }] ← polled by ESP
// globalCmds  : [{ cmd, ts }]                   ← e.g. open_door without UID
let members       = {};
let pendingScans  = {};
let commandQueue  = {};
let updateQueue   = [];
let globalCmds    = [];
let scanLogs      = [];
let espStatus     = { lastSeen: null, uptime: 0, memberCount: 0, rssi: 0, ip: '' };

// ─── Persistence helpers ──────────────────────────────────────────────────────
function saveMembers() {
  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2));
}
function saveLogs() {
  fs.writeFileSync(LOGS_FILE, JSON.stringify(scanLogs.slice(-MAX_LOGS), null, 2));
}
function loadData() {
  if (fs.existsSync(MEMBERS_FILE)) members  = JSON.parse(fs.readFileSync(MEMBERS_FILE));
  if (fs.existsSync(LOGS_FILE))    scanLogs = JSON.parse(fs.readFileSync(LOGS_FILE));
}

function addLog(entry) {
  entry.ts = new Date().toISOString();
  scanLogs.unshift(entry);
  if (scanLogs.length > MAX_LOGS) scanLogs.length = MAX_LOGS;
  saveLogs();
}

// ─── Roles ───────────────────────────────────────────────────────────────────
const VALID_ROLES = ['President', 'ExclusiveBoard', 'Leader', 'Member'];

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function queueEspUpdate(update) {
  updateQueue.push({ ...update, ts: Date.now() });
}

// ─── Member helpers ───────────────────────────────────────────────────────────
function getMember(uid) { return members[uid.toUpperCase()] || null; }

function upsertMember(uid, fields) {
  uid = uid.toUpperCase();
  members[uid] = { uid, name: 'Unknown', role: 'pending', dayGrant: false, dayGrantDate: '', ...members[uid], ...fields };
  saveMembers();
  return members[uid];
}

function findByName(name) {
  return Object.values(members).find(m => m.name.toLowerCase() === name.toLowerCase());
}

// ─── Discord embed + button builders ─────────────────────────────────────────
function unknownEmbed(uid, name, role, reason) {
  const title = role === 'banned' ? '🚫 Banned Card Scanned' : '❓ Unknown / Pending Card';
  const color = role === 'banned' ? 0xff0000 : 0xffa500;
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: 'UID',    value: uid,             inline: true },
      { name: 'Name',   value: name || '—',     inline: true },
      { name: 'Role',   value: role || 'Unknown', inline: true },
      { name: 'Time',   value: new Date().toLocaleTimeString(), inline: true },
      { name: 'Reason', value: reason || '—',   inline: true }
    )
    .setTimestamp();
}

function actionRows(uid, disabled = []) {
  const d = (id) => disabled.includes(id);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`grant_day:${uid}`).setLabel('Grant 1 Day').setStyle(ButtonStyle.Success).setDisabled(d('grant_day')),
    new ButtonBuilder().setCustomId(`access_once:${uid}`).setLabel('Access Once').setStyle(ButtonStyle.Primary).setDisabled(d('access_once')),
    new ButtonBuilder().setCustomId(`add_member:${uid}`).setLabel('Add Member').setStyle(ButtonStyle.Secondary).setDisabled(false),
    new ButtonBuilder().setCustomId(`deny:${uid}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(d('deny')),
    new ButtonBuilder().setCustomId(`ban:${uid}`).setLabel('Ban').setStyle(ButtonStyle.Danger).setDisabled(d('ban'))
  );
  return [row1];
}

function allDisabledRows(uid) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`grant_day:${uid}`).setLabel('Grant 1 Day').setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId(`access_once:${uid}`).setLabel('Access Once').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId(`add_member:${uid}`).setLabel('Add Member').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`deny:${uid}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(true),
    new ButtonBuilder().setCustomId(`ban:${uid}`).setLabel('Ban').setStyle(ButtonStyle.Danger).setDisabled(true)
  )];
}

async function notifyAccess(uid, name, role, action, reason) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;
  const color = action === 'granted' ? 0x00cc44 : action === 'denied' ? 0xff4444 : 0x888888;
  const icon  = action === 'granted' ? '✅' : action === 'denied' ? '❌' : 'ℹ️';
  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(`${icon} **${name || uid}** *(${role})* — ${reason}`)
    .setTimestamp();
  await channel.send({ embeds: [embed] }).catch(console.error);
}

// ─── Slash command definitions ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('add').setDescription('Add a new member')
    .addStringOption(o => o.setName('uid').setDescription('Card UID').setRequired(true))
    .addStringOption(o => o.setName('name').setDescription('Member name').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('Role').setRequired(true)
      .addChoices(
        { name: 'President',      value: 'President' },
        { name: 'Exclusive Board',value: 'ExclusiveBoard' },
        { name: 'Leader',         value: 'Leader' },
        { name: 'Member',         value: 'Member' },
      )),

  new SlashCommandBuilder().setName('ban').setDescription('Ban a member')
    .addStringOption(o => o.setName('uid').setDescription('Card UID').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('unban').setDescription('Unban — restores to Leader')
    .addStringOption(o => o.setName('uid').setDescription('Card UID').setRequired(true)),

  new SlashCommandBuilder().setName('grant_day').setDescription('Grant full-day access')
    .addStringOption(o => o.setName('uid').setDescription('Card UID').setRequired(true)),

  new SlashCommandBuilder().setName('revoke_day').setDescription('Revoke day grant')
    .addStringOption(o => o.setName('uid').setDescription('Card UID').setRequired(true)),

  new SlashCommandBuilder().setName('open_door').setDescription('Open door on demand'),

  new SlashCommandBuilder().setName('setrole').setDescription('Change member role')
    .addStringOption(o => o.setName('uid').setDescription('Card UID').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('New role').setRequired(true)
      .addChoices(
        { name: 'President',      value: 'President' },
        { name: 'Exclusive Board',value: 'ExclusiveBoard' },
        { name: 'Leader',         value: 'Leader' },
        { name: 'Member',         value: 'Member' },
      )),

  new SlashCommandBuilder().setName('rename').setDescription('Rename a member')
    .addStringOption(o => o.setName('uid').setDescription('Card UID').setRequired(true))
    .addStringOption(o => o.setName('name').setDescription('New name').setRequired(true)),

  new SlashCommandBuilder().setName('list').setDescription('List approved members'),
  new SlashCommandBuilder().setName('pending').setDescription('Show pending / unknown cards'),
  new SlashCommandBuilder().setName('log').setDescription('Recent scan log')
    .addIntegerOption(o => o.setName('count').setDescription('How many (default 10)').setRequired(false)),
  new SlashCommandBuilder().setName('report').setDescription('Access statistics'),
  new SlashCommandBuilder().setName('status').setDescription('ESP32 status'),
  new SlashCommandBuilder().setName('help').setDescription('All commands explained'),
].map(c => c.toJSON());

// ─── Register slash commands on ready ────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot ready: ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (e) { console.error('Command registration failed:', e); }
});

// ─── Interaction handler ──────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── Slash commands ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    const cmd = interaction.commandName;

    // ── /add ──────────────────────────────────────────────────────────────────
    if (cmd === 'add') {
      const uid  = interaction.options.getString('uid').toUpperCase();
      const name = interaction.options.getString('name');
      const role = interaction.options.getString('role');
      upsertMember(uid, { name, role, dayGrant: false, dayGrantDate: '' });
      queueEspUpdate({ type: 'add_member', uid, name, role, dayGrant: false, dayGrantDate: '' });
      addLog({ uid, name, role, action: 'added', reason: `Added by admin` });
      await interaction.editReply(`✅ Added **${name}** (${role}) — UID: \`${uid}\``);
    }

    // ── /ban ──────────────────────────────────────────────────────────────────
    else if (cmd === 'ban') {
      const uid    = interaction.options.getString('uid').toUpperCase();
      const reason = interaction.options.getString('reason') || 'No reason';
      const m      = getMember(uid);
      if (!m) return interaction.editReply('❌ UID not found.');
      upsertMember(uid, { role: 'banned' });
      queueEspUpdate({ type: 'update_member', uid, role: 'banned' });
      addLog({ uid, name: m.name, role: 'banned', action: 'banned', reason });
      await notifyAccess(uid, m.name, 'banned', 'denied', `Banned — ${reason}`);
      await interaction.editReply(`🚫 Banned **${m.name}** (\`${uid}\`)`);
    }

    // ── /unban ────────────────────────────────────────────────────────────────
    else if (cmd === 'unban') {
      const uid = interaction.options.getString('uid').toUpperCase();
      const m   = getMember(uid);
      if (!m) return interaction.editReply('❌ UID not found.');
      upsertMember(uid, { role: 'Leader' });
      queueEspUpdate({ type: 'update_member', uid, role: 'Leader' });
      addLog({ uid, name: m.name, role: 'Leader', action: 'unbanned', reason: 'Restored to Leader' });
      await interaction.editReply(`✅ Unbanned **${m.name}** — restored to Leader`);
    }

    // ── /grant_day ────────────────────────────────────────────────────────────
    else if (cmd === 'grant_day') {
      const uid = interaction.options.getString('uid').toUpperCase();
      const m   = getMember(uid);
      if (!m) return interaction.editReply('❌ UID not found.');
      const d   = today();
      upsertMember(uid, { dayGrant: true, dayGrantDate: d });
      queueEspUpdate({ type: 'update_member', uid, dayGrant: true, dayGrantDate: d });
      addLog({ uid, name: m.name, role: m.role, action: 'day_grant', reason: 'Granted by admin' });
      await interaction.editReply(`✅ Day grant given to **${m.name}** for ${d}`);
    }

    // ── /revoke_day ───────────────────────────────────────────────────────────
    else if (cmd === 'revoke_day') {
      const uid = interaction.options.getString('uid').toUpperCase();
      const m   = getMember(uid);
      if (!m) return interaction.editReply('❌ UID not found.');
      upsertMember(uid, { dayGrant: false, dayGrantDate: '' });
      queueEspUpdate({ type: 'update_member', uid, dayGrant: false, dayGrantDate: '' });
      await interaction.editReply(`✅ Day grant revoked for **${m.name}**`);
    }

    // ── /open_door ────────────────────────────────────────────────────────────
    else if (cmd === 'open_door') {
      globalCmds.push({ cmd: 'open_door', ts: Date.now() });
      addLog({ uid: 'ADMIN', name: 'Admin', role: 'admin', action: 'open_door', reason: 'Manual open via /open_door' });
      await interaction.editReply('🚪 Open door command queued for ESP32');
    }

    // ── /setrole ──────────────────────────────────────────────────────────────
    else if (cmd === 'setrole') {
      const uid  = interaction.options.getString('uid').toUpperCase();
      const role = interaction.options.getString('role');
      const m    = getMember(uid);
      if (!m) return interaction.editReply('❌ UID not found.');
      upsertMember(uid, { role });
      queueEspUpdate({ type: 'update_member', uid, role });
      await interaction.editReply(`✅ **${m.name}** role changed to ${role}`);
    }

    // ── /rename ───────────────────────────────────────────────────────────────
    else if (cmd === 'rename') {
      const uid  = interaction.options.getString('uid').toUpperCase();
      const name = interaction.options.getString('name');
      const m    = getMember(uid);
      if (!m) return interaction.editReply('❌ UID not found.');
      upsertMember(uid, { name });
      queueEspUpdate({ type: 'update_member', uid, name });
      await interaction.editReply(`✅ Renamed to **${name}**`);
    }

    // ── /list ─────────────────────────────────────────────────────────────────
    else if (cmd === 'list') {
      const list = Object.values(members).filter(m => !['pending','banned'].includes(m.role));
      if (!list.length) return interaction.editReply('No approved members yet.');
      const lines = list.map(m => `\`${m.uid}\` **${m.name}** — ${m.role}${m.dayGrant ? ' 🌞' : ''}`).join('\n');
      const embed = new EmbedBuilder().setTitle('📋 Approved Members').setDescription(lines).setColor(0x0099ff);
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /pending ──────────────────────────────────────────────────────────────
    else if (cmd === 'pending') {
      const list = Object.values(members).filter(m => m.role === 'pending');
      const unkn = Object.entries(pendingScans).filter(([uid]) => !members[uid]);
      if (!list.length && !unkn.length) return interaction.editReply('No pending cards.');
      const lines = [
        ...list.map(m => `\`${m.uid}\` **${m.name}** — pending`),
        ...unkn.map(([uid]) => `\`${uid}\` — Unknown (scanned recently)`)
      ].join('\n');
      const embed = new EmbedBuilder().setTitle('⏳ Pending Cards').setDescription(lines).setColor(0xffa500);
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /log ──────────────────────────────────────────────────────────────────
    else if (cmd === 'log') {
      const n = Math.min(interaction.options.getInteger('count') || 10, 25);
      if (!scanLogs.length) return interaction.editReply('No logs yet.');
      const lines = scanLogs.slice(0, n).map(l => {
        const t = new Date(l.ts).toLocaleTimeString();
        const icon = l.action === 'granted' ? '✅' : l.action === 'denied' ? '❌' : 'ℹ️';
        return `${icon} \`${t}\` **${l.name || l.uid}** (${l.role}) — ${l.reason}`;
      }).join('\n');
      const embed = new EmbedBuilder().setTitle(`📜 Last ${n} Logs`).setDescription(lines).setColor(0x888888);
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /report ───────────────────────────────────────────────────────────────
    else if (cmd === 'report') {
      const todayStr  = today();
      const todayLogs = scanLogs.filter(l => l.ts && l.ts.startsWith(todayStr));
      const granted   = todayLogs.filter(l => l.action === 'granted').length;
      const denied    = todayLogs.filter(l => l.action === 'denied').length;
      const totalM    = Object.values(members);
      const embed = new EmbedBuilder()
        .setTitle('📊 Access Report')
        .setColor(0x0099ff)
        .addFields(
          { name: 'Total members',    value: `${totalM.filter(m => !['pending','banned'].includes(m.role)).length}`, inline: true },
          { name: 'Pending',          value: `${totalM.filter(m => m.role === 'pending').length}`,  inline: true },
          { name: 'Banned',           value: `${totalM.filter(m => m.role === 'banned').length}`,   inline: true },
          { name: 'Granted today',    value: `${granted}`,  inline: true },
          { name: 'Denied today',     value: `${denied}`,   inline: true },
          { name: 'Day grants active',value: `${totalM.filter(m => m.dayGrant && m.dayGrantDate === todayStr).length}`, inline: true },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /status ───────────────────────────────────────────────────────────────
    else if (cmd === 'status') {
      const seen = espStatus.lastSeen ? new Date(espStatus.lastSeen).toLocaleString() : 'Never';
      const up   = espStatus.uptime ? `${Math.floor(espStatus.uptime / 3600)}h ${Math.floor((espStatus.uptime % 3600) / 60)}m` : '—';
      const embed = new EmbedBuilder()
        .setTitle('🔌 ESP32 Status')
        .setColor(espStatus.lastSeen && Date.now() - espStatus.lastSeen < 120000 ? 0x00cc44 : 0xff4444)
        .addFields(
          { name: 'Last seen',    value: seen,                                  inline: true },
          { name: 'IP',           value: espStatus.ip || '—',                   inline: true },
          { name: 'RSSI',         value: espStatus.rssi ? `${espStatus.rssi} dBm` : '—', inline: true },
          { name: 'Uptime',       value: up,                                    inline: true },
          { name: 'Members (ESP)',value: `${espStatus.memberCount}`,             inline: true },
          { name: 'Pending cmds', value: `${updateQueue.length + globalCmds.length}`, inline: true },
        );
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /help ─────────────────────────────────────────────────────────────────
    else if (cmd === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('📖 Bot Commands')
        .setColor(0x0099ff)
        .setDescription(
          '`/add <uid> <name> <role>` — Add a new member\n' +
          '`/ban <uid> [reason]` — Ban a member permanently\n' +
          '`/unban <uid>` — Unban, restores to Leader\n' +
          '`/grant_day <uid>` — Grant full-day access (resets midnight)\n' +
          '`/revoke_day <uid>` — Revoke day grant\n' +
          '`/open_door` — Open the door on demand\n' +
          '`/setrole <uid> <role>` — Change member role\n' +
          '`/rename <uid> <name>` — Rename a member\n' +
          '`/list` — Show approved members\n' +
          '`/pending` — Show pending/unknown cards\n' +
          '`/log [count]` — Recent scan events\n' +
          '`/report` — Access statistics\n' +
          '`/status` — ESP32 vitals\n' +
          '`/help` — This message\n\n' +
          '**Roles:** President (24/7), ExclusiveBoard (24/7), Leader (10–16), Member (10–16)\n' +
          '**Buttons (on unknown scan):** Grant 1 Day · Access Once · Add Member · Deny · Ban'
        );
      await interaction.editReply({ embeds: [embed] });
    }
  }

  // ── Button interactions ─────────────────────────────────────────────────────
  else if (interaction.isButton()) {
    const [action, uid] = interaction.customId.split(':');

    // ── grant_day button ─────────────────────────────────────────────────────
    if (action === 'grant_day') {
      await interaction.deferUpdate();
      const d  = today();
      const m  = getMember(uid);
      const name = m?.name || uid;
      upsertMember(uid, { role: m?.role || 'Member', dayGrant: true, dayGrantDate: d });
      commandQueue[uid] = commandQueue[uid] || [];
      commandQueue[uid].push({ cmd: 'grant_day', data: { dayGrant: true, dayGrantDate: d }, ts: Date.now() });
      queueEspUpdate({ type: 'update_member', uid, name, role: m?.role || 'Member', dayGrant: true, dayGrantDate: d });
      addLog({ uid, name, role: m?.role || '?', action: 'day_grant', reason: 'Day grant via Discord button' });
      const disabledButtons = ['grant_day', 'access_once', 'deny', 'ban'];
      await interaction.message.edit({ components: actionRows(uid, disabledButtons) });
      await notifyAccess(uid, name, m?.role || '?', 'granted', `Day grant — ${d}`);
    }

    // ── access_once button ───────────────────────────────────────────────────
    else if (action === 'access_once') {
      await interaction.deferUpdate();
      const m    = getMember(uid);
      const name = m?.name || uid;
      commandQueue[uid] = commandQueue[uid] || [];
      commandQueue[uid].push({ cmd: 'open_door', data: {}, ts: Date.now() });
      addLog({ uid, name, role: m?.role || '?', action: 'access_once', reason: 'One-time access via Discord button' });
      const disabledButtons = ['grant_day', 'access_once', 'deny', 'ban'];
      await interaction.message.edit({ components: actionRows(uid, disabledButtons) });
      await notifyAccess(uid, name, m?.role || 'Unknown', 'granted', 'One-time access granted');
    }

    // ── add_member button ────────────────────────────────────────────────────
    else if (action === 'add_member') {
      const modal = new ModalBuilder()
        .setCustomId(`modal_add:${uid}`)
        .setTitle('Add Member');
      const nameInput = new TextInputBuilder()
        .setCustomId('name').setLabel('Name').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('John Doe');
      const roleInput = new TextInputBuilder()
        .setCustomId('role').setLabel('Role').setStyle(TextInputStyle.Short).setRequired(true)
        .setPlaceholder('President / ExclusiveBoard / Leader / Member');
      modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(roleInput)
      );
      await interaction.showModal(modal);
    }

    // ── deny button ──────────────────────────────────────────────────────────
    else if (action === 'deny') {
      await interaction.deferUpdate();
      const m    = getMember(uid);
      const name = m?.name || uid;
      commandQueue[uid] = commandQueue[uid] || [];
      commandQueue[uid].push({ cmd: 'deny', data: {}, ts: Date.now() });
      addLog({ uid, name, role: m?.role || '?', action: 'denied', reason: 'Denied via Discord button' });
      const disabledButtons = ['grant_day', 'access_once', 'deny', 'ban'];
      await interaction.message.edit({ components: actionRows(uid, disabledButtons) });
      await notifyAccess(uid, name, m?.role || 'Unknown', 'denied', 'Denied via Discord');
    }

    // ── ban button ───────────────────────────────────────────────────────────
    else if (action === 'ban') {
      await interaction.deferUpdate();
      const m    = getMember(uid);
      const name = m?.name || uid;
      upsertMember(uid, { role: 'banned' });
      commandQueue[uid] = commandQueue[uid] || [];
      commandQueue[uid].push({ cmd: 'ban', data: {}, ts: Date.now() });
      queueEspUpdate({ type: 'update_member', uid, role: 'banned' });
      addLog({ uid, name, role: 'banned', action: 'banned', reason: 'Banned via Discord button' });
      await interaction.message.edit({ components: allDisabledRows(uid) });
      await notifyAccess(uid, name, 'banned', 'denied', '🚫 Permanently banned');
    }
  }

  // ── Modal submission ────────────────────────────────────────────────────────
  else if (interaction.isModalSubmit()) {
    const [modalType, uid] = interaction.customId.split(':');

    if (modalType === 'modal_add') {
      await interaction.deferReply({ ephemeral: true });
      const name     = interaction.fields.getTextInputValue('name').trim();
      const roleRaw  = interaction.fields.getTextInputValue('role').trim();
      const roleMap  = { president:'President', exclusiveboard:'ExclusiveBoard', leader:'Leader', member:'Member' };
      const role     = roleMap[roleRaw.toLowerCase().replace(/\s+/g,'')] || 'Member';
      upsertMember(uid, { name, role, dayGrant: false, dayGrantDate: '' });
      queueEspUpdate({ type: 'add_member', uid, name, role, dayGrant: false, dayGrantDate: '' });
      addLog({ uid, name, role, action: 'added', reason: 'Added via Discord modal button' });
      await interaction.editReply(`✅ Added **${name}** as **${role}** (UID: \`${uid}\`). Other action buttons are still active.`);
    }
  }
});

// ─── Express API Middleware ───────────────────────────────────────────────────
function authCheck(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.use('/api', authCheck);

// ─── ESP32 API Routes ─────────────────────────────────────────────────────────

// POST /api/scan — ESP reports a card scan (known, unknown, or banned)
app.post('/api/scan', async (req, res) => {
  const { uid, name, role, action, reason } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid required' });
  const UID = uid.toUpperCase();

  addLog({ uid: UID, name: name || UID, role: role || 'Unknown', action, reason });

  // Unknown or pending → post Discord alert with buttons
  if (!role || role === 'unknown' || role === 'pending') {
    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (channel) {
      const m = getMember(UID);
      const embed = unknownEmbed(UID, m?.name || name || null, m?.role || role || 'Unknown', reason);
      const msg   = await channel.send({ embeds: [embed], components: actionRows(UID) }).catch(console.error);
      if (msg) pendingScans[UID] = { ts: Date.now(), messageId: msg.id };
    }
    return res.json({ queued: true });
  }

  // Banned → silent notify, no buttons
  if (role === 'banned') {
    await notifyAccess(UID, name, 'banned', 'denied', reason || 'Banned card scanned');
    return res.json({ ok: true });
  }

  // Known member access log (granted / denied)
  if (action === 'granted') {
    await notifyAccess(UID, name, role, 'granted', reason || `${name} (${role}) entered at ${new Date().toLocaleTimeString()}`);
  } else if (action === 'denied') {
    await notifyAccess(UID, name, role, 'denied', reason || 'Denied');
  }

  res.json({ ok: true });
});

// GET /api/command/:uid — ESP polls during its 60s pending window
app.get('/api/command/:uid', (req, res) => {
  const uid  = req.params.uid.toUpperCase();
  const cmds = commandQueue[uid];
  if (!cmds || !cmds.length) return res.json({ command: null });
  const cmd = cmds.shift();
  if (!cmds.length) delete commandQueue[uid];
  // Clean up pending scan tracking
  if (pendingScans[uid]) delete pendingScans[uid];
  res.json({ command: cmd.cmd, data: cmd.data });
});

// GET /api/updates — ESP polls regularly for member list changes + global cmds
app.get('/api/updates', (req, res) => {
  const updates = [...updateQueue];
  const globals  = [...globalCmds];
  updateQueue.length  = 0;
  globalCmds.length   = 0;
  res.json({ updates, globalCommands: globals });
});

// POST /api/status — ESP reports its vitals
app.post('/api/status', (req, res) => {
  const { uptime, rssi, memberCount, ip } = req.body;
  espStatus = { lastSeen: Date.now(), uptime, rssi, memberCount, ip };
  res.json({ ok: true, serverTime: Math.floor(Date.now() / 1000) });
});

// GET /api/members — ESP can request full member list on boot/resync
app.get('/api/members', (req, res) => {
  const list = Object.values(members).map(m => ({
    uid: m.uid, name: m.name, role: m.role,
    dayGrant: m.dayGrant, dayGrantDate: m.dayGrantDate || ''
  }));
  res.json({ members: list });
});

// ─── Start ────────────────────────────────────────────────────────────────────
loadData();
client.login(TOKEN);
app.listen(PORT, () => console.log(`🌐 API server running on port ${PORT}`));

// Clean up expired pending scans every minute
setInterval(() => {
  const now = Date.now();
  for (const [uid, scan] of Object.entries(pendingScans)) {
    if (now - scan.ts > 120000) delete pendingScans[uid];  // 2 min TTL
  }
  // Clean expired global commands (> 5 min old)
  const idx = globalCmds.findIndex(c => now - c.ts > 300000);
  if (idx !== -1) globalCmds.splice(0, idx + 1);
}, 60000);
