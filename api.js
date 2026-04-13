// ============================================================
//  api.js — Express REST API for ESP32 <-> Bot communication
//  File 3/4  |  RFID Access Control Bot
// ============================================================
'use strict';

const express = require('express');
const storage = require('./storage');

const router = express.Router();

// ─── CONSTANTS ───────────────────────────────────────────────
const PENDING_TTL_MS  = 65_000;
const DOOR_CMD_TTL_MS =  8_000;

// ─── STATE ───────────────────────────────────────────────────
let pendingRequest = null;
let pendingDoorCmd = null;
let doorCmdSetAt   = 0;
let _client        = null;
let _channel       = null;

function setClient(client, channel) {
  _client  = client;
  _channel = channel;
}

// ─── MIDDLEWARE ──────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}
router.use(requireApiKey);

// ─── HELPERS ─────────────────────────────────────────────────
function isPendingExpired(req) {
  return !req || (Date.now() - req.createdAt > PENDING_TTL_MS);
}

function makeTimestamp() { return Math.floor(Date.now() / 1000); }

// ─── DISCORD HELPERS ─────────────────────────────────────────
async function postPendingToDiscord(uid, request_id) {
  if (!_channel) return null;
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

  const normUID = storage.normalizeUID(uid);
  const member  = storage.findByUID(normUID);

  // ── Banned card: red embed with Unban/Ignore buttons only ──
  if (member?.banned) {
    const embed = new EmbedBuilder()
      .setColor(0xE74C3C)
      .setTitle('🔴 Banned Card Scanned')
      .setDescription('A banned member attempted to enter.')
      .addFields(
        { name: 'Name',       value: member.name,          inline: true  },
        { name: 'UID',        value: `\`${normUID}\``,     inline: true  },
        { name: 'Role',       value: member.role,          inline: true  },
        { name: 'Request ID', value: `\`${request_id}\``,  inline: false },
      )
      .setTimestamp()
      .setFooter({ text: 'Expires in 60 seconds' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`unban_open::${request_id}`)
        .setLabel('✅ Unban & Open Door')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`unban::${request_id}`)
        .setLabel('🔓 Unban Only')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`deny::${request_id}`)
        .setLabel('❌ Ignore')
        .setStyle(ButtonStyle.Danger),
    );

    const msg = await _channel.send({ embeds: [embed], components: [row] });
    return msg.id;
  }

  // ── FIX: Known member (Leader/Member) waiting for approval: blue embed ──
  // Previously ALL non-banned cards showed "Unknown Card Scanned" even when
  // the member existed in the DB. Now we distinguish properly.
  if (member) {
    const embed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('🔵 Known Member – Awaiting Approval')
      .setDescription(`**${member.name}** _(${member.role})_ is requesting entry.`)
      .addFields(
        { name: 'UID',        value: `\`${normUID}\``,        inline: true  },
        { name: 'Name',       value: member.name,             inline: true  },
        { name: 'Role',       value: member.role,             inline: true  },
        { name: 'Request ID', value: `\`${request_id}\``,     inline: false },
      )
      .setTimestamp()
      .setFooter({ text: 'Expires in 60 seconds' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`grant_day::${request_id}`).setLabel('✅ Grant 1 Day').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`access_once::${request_id}`).setLabel('🔓 Access Once').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`deny::${request_id}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ban::${request_id}`).setLabel('🔨 Ban').setStyle(ButtonStyle.Danger),
    );

    const msg = await _channel.send({ embeds: [embed], components: [row] });
    return msg.id;
  }

  // ── Truly unknown card: yellow embed + full action buttons ──
  const embed = new EmbedBuilder()
    .setColor(0xF5A623)
    .setTitle('🔔 Unknown Card Scanned')
    .setDescription('A card not in the database was presented at the door.')
    .addFields(
      { name: 'UID',        value: `\`${normUID}\``,   inline: true  },
      { name: 'Known Name', value: '_None_',            inline: true  },
      { name: 'Request ID', value: `\`${request_id}\``, inline: false },
    )
    .setTimestamp()
    .setFooter({ text: 'Expires in 60 seconds' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`grant_day::${request_id}`).setLabel('✅ Grant 1 Day').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`access_once::${request_id}`).setLabel('🔓 Access Once').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`add_member::${request_id}`).setLabel('➕ Add Member').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`deny::${request_id}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ban::${request_id}`).setLabel('🔨 Ban').setStyle(ButtonStyle.Danger),
  );

  const msg = await _channel.send({ embeds: [embed], components: [row] });
  return msg.id;
}

async function disableButtons(messageId, keptAction) {
  if (!_channel || !messageId) return;
  try {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const msg  = await _channel.messages.fetch(messageId);
    const orig = msg.components[0]?.components || [];
    const row  = new ActionRowBuilder().addComponents(
      orig.map(btn => {
        const keep = btn.customId?.startsWith(keptAction);
        return ButtonBuilder.from(btn).setDisabled(true)
          .setStyle(keep ? ButtonStyle.Success : ButtonStyle.Secondary);
      })
    );
    await msg.edit({ components: [row] });
  } catch (e) {
    console.error('[API] disableButtons error:', e.message);
  }
}

async function expireMessage(messageId) {
  if (!_channel || !messageId) return;
  try {
    const { EmbedBuilder } = require('discord.js');
    const msg   = await _channel.messages.fetch(messageId);
    const embed = EmbedBuilder.from(msg.embeds[0])
      .setColor(0x95A5A6)
      .setTitle('⌛ Request Expired')
      .setFooter({ text: 'Auto-denied after timeout' });
    await msg.edit({ embeds: [embed], components: [] });
  } catch {}
}

// ─── ROUTES ──────────────────────────────────────────────────

// POST /api/scan — ESP32 reports a new card scan
router.post('/scan', async (req, res) => {
  const { uid, request_id, timestamp } = req.body;
  if (!uid || !request_id)
    return res.status(400).json({ error: 'Missing uid or request_id' });

  const normUID = storage.normalizeUID(uid);
  console.log(`[API] Scan: uid=${normUID} req=${request_id}`);

  const member = storage.findByUID(normUID);

  // ── Auto-grant: known member with active day pass (not banned) ──
  if (member && !member.banned && member.dayGrant) {
    const todayDay = Math.floor(Date.now() / 86400000);
    if (member.dayGrantDate === todayDay) {
      console.log(`[API] Auto-grant (day pass): ${member.name} uid=${normUID}`);
      if (pendingRequest && !isPendingExpired(pendingRequest))
        expireMessage(pendingRequest.messageId).catch(() => {});
      pendingRequest = {
        uid: normUID, request_id, timestamp,
        decision: { action: 'open', decidedAt: Date.now() },
        createdAt: Date.now(), messageId: null,
      };
      return res.json({ ok: true, queued: true, auto: 'day_pass' });
    } else {
      console.log(`[API] Day pass expired for ${member.name}, revoking`);
      storage.revokeDay(normUID);
    }
  }

  // ── Normal flow: post to Discord for manual decision ──
  if (pendingRequest && !isPendingExpired(pendingRequest))
    expireMessage(pendingRequest.messageId).catch(() => {});

  pendingRequest = { uid: normUID, request_id, timestamp, decision: null, createdAt: Date.now(), messageId: null };

  try {
    pendingRequest.messageId = await postPendingToDiscord(normUID, request_id);
  } catch (e) {
    console.error('[API] Discord post error:', e.message);
  }

  res.json({ ok: true, queued: true });
});

// GET /api/pending/:request_id — ESP32 polls for decision
router.get('/pending/:request_id', (req, res) => {
  const { request_id } = req.params;

  if (!pendingRequest || pendingRequest.request_id !== request_id)
    return res.json({ action: null, reason: 'no_match' });

  if (isPendingExpired(pendingRequest)) {
    expireMessage(pendingRequest.messageId).catch(() => {});
    pendingRequest = null;
    return res.json({ action: 'deny', reason: 'expired' });
  }

  if (pendingRequest.decision) {
    const { action } = pendingRequest.decision;
    pendingRequest   = null;
    return res.json({ action });
  }

  return res.json({ action: null, reason: 'waiting' });
});

// POST /api/log — ESP32 sends access log entry
router.post('/log', async (req, res) => {
  const { uid, name, role, event, reason, time, timestamp } = req.body;
  const normUID = storage.normalizeUID(uid || '');
  storage.appendLog({ uid: normUID, name, role, event, reason, time });

  if (_channel) {
    try {
      const { EmbedBuilder } = require('discord.js');
      const displayName = name && name !== uid && name !== 'N/A' ? name : (normUID || 'Unknown');
      let color, emoji, desc;
      if (event === 'granted') {
        color = 0x2ECC71; emoji = '✅';
        desc  = `**${displayName}** _(${role})_ entered at **${time || '??:??'}**`;
      } else {
        color = 0xE74C3C; emoji = '🚫';
        desc  = `**${displayName}** _(${role})_ was denied — ${reason || 'unknown'}`;
      }
      const embed = new EmbedBuilder()
        .setColor(color)
        .setDescription(`${emoji} ${desc}`)
        .setTimestamp(timestamp ? timestamp * 1000 : Date.now())
        .setFooter({ text: `UID: ${normUID || 'N/A'}` });
      await _channel.send({ embeds: [embed] });
    } catch (e) {
      console.error('[API] Log post error:', e.message);
    }
  }

  res.json({ ok: true });
});

// GET /api/updates — ESP32 polls for member changes + door commands
router.get('/updates', (req, res) => {
  const members = storage.flushQueue();
  let doorCmd   = null;
  if (pendingDoorCmd && Date.now() - doorCmdSetAt < DOOR_CMD_TTL_MS) {
    doorCmd        = pendingDoorCmd;
    pendingDoorCmd = null;
  }
  res.json({ members, door_cmd: doorCmd, has_queue: storage.peekQueue().length > 0 });
});

// POST /api/status — ESP32 heartbeat
router.post('/status', (req, res) => {
  const { members, wifi, timeValid, timestamp } = req.body;
  console.log(`[ESP] Heartbeat — members:${members} wifi:${wifi} time:${timeValid} ts:${timestamp}`);
  res.json({ ok: true, serverTime: makeTimestamp() });
});

// ─── INTERNAL API ────────────────────────────────────────────
function queueDoorCommand(cmd) {
  pendingDoorCmd = cmd;
  doorCmdSetAt   = Date.now();
}

// Button interaction handler
async function handleButtonDecision(interaction) {
  const { MessageFlags } = require('discord.js');
  const [action, request_id] = interaction.customId.split('::');

  if (!pendingRequest || pendingRequest.request_id !== request_id)
    return interaction.reply({ content: '⚠️ This request is no longer active.', flags: MessageFlags.Ephemeral });

  if (isPendingExpired(pendingRequest)) {
    expireMessage(pendingRequest.messageId).catch(() => {});
    pendingRequest = null;
    return interaction.reply({ content: '⌛ This request has expired.', flags: MessageFlags.Ephemeral });
  }

  if (pendingRequest.decision)
    return interaction.reply({ content: '✅ Already decided.', flags: MessageFlags.Ephemeral });

  // Add Member → show modal (no decision yet)
  if (action === 'add_member') {
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
    const modal = new ModalBuilder()
      .setCustomId(`modal_add::${request_id}`)
      .setTitle('Add New Member');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('member_name').setLabel('Full Name')
          .setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('member_role')
          .setLabel('Role (Leader / Member / ExclusiveBoard / President)')
          .setStyle(TextInputStyle.Short).setPlaceholder('Member').setRequired(false)
      ),
    );
    return interaction.showModal(modal);
  }

  // FIX: Do NOT set pendingRequest.decision here with the raw action string.
  // The old code set it to `action` ("access_once") immediately, then
  // overwrote it inside each branch. If the ESP polled between those two
  // lines it received the un-mapped string "access_once" which the firmware
  // doesn't handle, falling through to "No decision" and denying entry.
  // Now each branch sets the decision exactly once with the correct value.

  const uid   = pendingRequest.uid; // already normalized
  const msgId = pendingRequest.messageId;

  if (action === 'grant_day') {
    storage.grantDay(uid);
    // Set decision to 'open' so the ESP opens the door for this scan,
    // and future scans today will auto-grant locally without Discord.
    pendingRequest.decision = { action: 'open', decidedAt: Date.now() };
    await interaction.reply({ content: `✅ 1-day access granted for \`${uid}\` — door opening now.` });
    disableButtons(msgId, 'grant_day').catch(() => {});

  } else if (action === 'access_once') {
    // FIX: Set decision to 'open' — the string the ESP firmware understands.
    // The old code set it to 'open' correctly in this branch but only AFTER
    // the premature assignment on line 312 (now removed) had already set it
    // to 'access_once', creating a race window where the ESP could read the
    // wrong action string and call denyAccess("No decision").
    pendingRequest.decision = { action: 'open', decidedAt: Date.now() };
    await interaction.reply({ content: `🔓 One-time access granted for \`${uid}\` — door opening now.` });
    disableButtons(msgId, 'access_once').catch(() => {});

  } else if (action === 'deny') {
    pendingRequest.decision = { action: 'deny', decidedAt: Date.now() };
    await interaction.reply({ content: `❌ Access denied for \`${uid}\`` });
    disableButtons(msgId, 'deny').catch(() => {});

  } else if (action === 'ban') {
    pendingRequest.decision = { action: 'deny', decidedAt: Date.now() };
    storage.banMember(uid);
    await interaction.reply({ content: `🔨 \`${uid}\` has been banned.` });
    disableButtons(msgId, 'ban').catch(() => {});

  } else if (action === 'unban_open') {
    const member = storage.findByUID(uid);
    const role   = member?.role === 'Banned' ? 'Member' : (member?.role || 'Member');
    storage.unbanMember(uid, role);
    pendingRequest.decision = { action: 'open', decidedAt: Date.now() };
    await interaction.reply({ content: `✅ \`${uid}\` unbanned and door opened.` });
    disableButtons(msgId, 'unban_open').catch(() => {});

  } else if (action === 'unban') {
    const member = storage.findByUID(uid);
    const role   = member?.role === 'Banned' ? 'Member' : (member?.role || 'Member');
    storage.unbanMember(uid, role);
    pendingRequest.decision = { action: 'deny', decidedAt: Date.now() };
    await interaction.reply({ content: `🔓 \`${uid}\` has been unbanned as **${role}**.` });
    disableButtons(msgId, 'unban').catch(() => {});
  }
}

// Modal submit handler (add_member flow)
async function handleModalSubmit(interaction) {
  const { MessageFlags } = require('discord.js');
  const [, request_id] = interaction.customId.split('::');
  const name = interaction.fields.getTextInputValue('member_name');
  const role = interaction.fields.getTextInputValue('member_role') || 'Member';

  if (!pendingRequest || pendingRequest.request_id !== request_id)
    return interaction.reply({ content: '⚠️ Request no longer active.', flags: MessageFlags.Ephemeral });

  const uid    = pendingRequest.uid; // already normalized
  const result = storage.addMember(name, uid, role);

  if (!result.ok)
    return interaction.reply({ content: `❌ ${result.reason}`, flags: MessageFlags.Ephemeral });

  pendingRequest.decision = { action: 'open', decidedAt: Date.now() };
  await interaction.reply({ content: `✅ **${name}** added as **${role}** and granted access.` });
}

function getActivePending() { return pendingRequest; }

module.exports = {
  router,
  setClient,
  queueDoorCommand,
  handleButtonDecision,
  handleModalSubmit,
  getActivePending,
};