// ============================================================
//  api.js — Express REST API for ESP32 <-> Bot communication
//  RFID Access Control Bot  |  v3.2
// ============================================================
'use strict';

const express = require('express');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const storage = require('./storage');

const router = express.Router();

// ─── CONSTANTS ───────────────────────────────────────────────
const PENDING_TTL_MS         = 60_000;
const DOOR_CMD_TTL_MS        =  8_000;
const RECENT_DECISION_TTL_MS = 5 * 60_000;

const ROLE_EMOJI = {
  President: '👑', ExclusiveBoard: '⭐', Leader: '🔑',
  Member: '👤', Pending: '⏳', Banned: '🔨',
};
const ROLE_COLOR = {
  President: 0xF1C40F, ExclusiveBoard: 0x9B59B6, Leader: 0x3498DB,
  Member: 0x2ECC71, Pending: 0xF39C12, Banned: 0xE74C3C,
};

// What the card looks like after someone clicks a button
const OUTCOMES = {
  grant_day:   { color: 0x2ECC71, icon: '✅', title: 'Day pass granted' },
  access_once: { color: 0x2ECC71, icon: '🔓', title: 'Let in (once)' },
  add_member:  { color: 0x2ECC71, icon: '➕', title: 'Added & let in' },
  add_only:    { color: 0x3498DB, icon: '➕', title: 'Added (door not opened)' },
  deny:        { color: 0xE74C3C, icon: '❌', title: 'Denied' },
  ban:         { color: 0x992D22, icon: '🔨', title: 'Banned' },
  unban_open:  { color: 0x2ECC71, icon: '✅', title: 'Unbanned & let in' },
  unban:       { color: 0x3498DB, icon: '🔓', title: 'Unbanned (door not opened)' },
};

// ─── STATE ───────────────────────────────────────────────────
const pendingRequests = new Map();
const recentDecisions = new Map(); // uid -> { by, byId, action, at }
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

function validUID(uid) {
  return typeof uid === 'string' && /^\d{6,12}$/.test(uid);
}

// Accepts "member", "Board", "exclusive board", "PRESIDENT", "" ...
function parseRole(text) {
  const t = String(text || '').toLowerCase().replace(/[\s_-]/g, '');
  if (!t || t === 'member' || t === 'members') return 'Member';
  if (t === 'leader') return 'Leader';
  if (t === 'president') return 'President';
  if (['exclusiveboard', 'exclusive', 'board'].includes(t)) return 'ExclusiveBoard';
  return null;
}

function whoLabel(member, uid) {
  if (member && member.name && member.name !== 'Unknown') return member.name;
  return `Unknown card ${uid}`;
}

function recordDecision(uid, action, by, byId) {
  recentDecisions.set(uid, { by, byId: byId || null, action, at: Date.now() });
}

function getRecentDecision(uid) {
  const d = recentDecisions.get(uid);
  if (!d) return null;
  if (Date.now() - d.at > RECENT_DECISION_TTL_MS) {
    recentDecisions.delete(uid);
    return null;
  }
  return d;
}

function actorName(interaction) {
  return interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
}

// ─── REQUEST CARD ────────────────────────────────────────────
function buildRequestMessage(uid, request_id) {
  const member    = storage.findByUID(uid);
  const expiresTs = Math.floor((Date.now() + PENDING_TTL_MS) / 1000);

  // ── Banned card ──
  if (member?.banned) {
    const embed = new EmbedBuilder()
      .setColor(0xE74C3C)
      .setTitle(`🔴 ${member.name} — BANNED member at the door`)
      .setDescription('🔨 **Banned** — this person is on the ban list.')
      .addFields(
        { name: 'Name',    value: member.name,      inline: true },
        { name: 'UID',     value: `\`${uid}\``,     inline: true },
        { name: 'Expires', value: `<t:${expiresTs}:R>`, inline: true },
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`unban_open::${request_id}`).setLabel('Unban & Open Door').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`unban::${request_id}`).setLabel('Unban Only').setEmoji('🔓').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`deny::${request_id}`).setLabel('Ignore').setEmoji('❌').setStyle(ButtonStyle.Danger),
    );
    return {
      content: `🔴 **${member.name}** (banned) is at the door`,
      embeds: [embed], components: [row],
    };
  }

  // ── Registered member that needs approval ──
  if (member) {
    const emoji = ROLE_EMOJI[member.role] || '👤';
    const embed = new EmbedBuilder()
      .setColor(ROLE_COLOR[member.role] || 0x2ECC71)
      .setTitle(`🔔 ${member.name} wants to enter`)
      .setDescription(`✅ **Registered member** · ${emoji} ${member.role}`)
      .addFields(
        { name: 'Name',    value: member.name,           inline: true },
        { name: 'Role',    value: `${emoji} ${member.role}`, inline: true },
        { name: 'UID',     value: `\`${uid}\``,          inline: true },
        { name: 'Expires', value: `<t:${expiresTs}:R>`,  inline: true },
      )
      .setTimestamp();

    const buttons = [
      new ButtonBuilder().setCustomId(`access_once::${request_id}`).setLabel('Let In Once').setEmoji('🔓').setStyle(ButtonStyle.Success),
    ];
    if (['Leader', 'Member'].includes(member.role)) {
      buttons.push(
        new ButtonBuilder().setCustomId(`grant_day::${request_id}`).setLabel('Grant 1 Day').setEmoji('📅').setStyle(ButtonStyle.Primary),
      );
    }
    buttons.push(
      new ButtonBuilder().setCustomId(`deny::${request_id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ban::${request_id}`).setLabel('Ban').setEmoji('🔨').setStyle(ButtonStyle.Secondary),
    );
    return {
      content: `🔔 **${member.name}** is at the door`,
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(buttons)],
    };
  }

  // ── Unknown card ──
  const embed = new EmbedBuilder()
    .setColor(0xF5A623)
    .setTitle('🔔 Unknown card wants to enter')
    .setDescription('⚠️ **Not registered** — this card is not in the member list.\nDecide below — you\'ll be asked if you want to add them afterwards.')
    .addFields(
      { name: 'UID',     value: `\`${uid}\``,         inline: true },
      { name: 'Expires', value: `<t:${expiresTs}:R>`, inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`access_once::${request_id}`).setLabel('Let In').setEmoji('🔓').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`deny::${request_id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ban::${request_id}`).setLabel('Ban').setEmoji('🔨').setStyle(ButtonStyle.Secondary),
  );
  return {
    content: `🔔 **Unknown card** \`${uid}\` is at the door`,
    embeds: [embed], components: [row],
  };
}

async function postPendingToDiscord(uid, request_id) {
  if (!_channel) return null;
  const msg = await _channel.send(buildRequestMessage(uid, request_id));
  return msg.id;
}

// Card after a decision: buttons removed, colour + "decided by" shown
function decidedEmbed(oldEmbed, outcomeKey, who, actor, note) {
  const o  = OUTCOMES[outcomeKey];
  const ts = Math.floor(Date.now() / 1000);
  const embed = EmbedBuilder.from(oldEmbed)
    .setColor(o.color)
    .setTitle(`${o.icon} ${who} — ${o.title}`)
    .setDescription(`**${o.title}** by <@${actor.id}> at <t:${ts}:T>${note ? `\n${note}` : ''}`)
    .setFields((oldEmbed.fields || []).filter(f => f.name !== 'Expires'))
    .setFooter({ text: `Decided by ${actor.name}` })
    .setTimestamp();
  return embed;
}

// Expired request: gray card; unregistered cards keep an Add Member button
async function expirePending(request_id) {
  const pending = pendingRequests.get(request_id);
  if (!pending || pending.expiredHandled) return;
  pending.expiredHandled = true;
  pendingRequests.delete(request_id);

  if (!_channel || !pending.messageId) return;
  try {
    const msg = await _channel.messages.fetch(pending.messageId);
    if (!msg.embeds[0]) return;
    const embed = EmbedBuilder.from(msg.embeds[0])
      .setColor(0x95A5A6)
      .setTitle(`⌛ ${pending.who} — Request expired`)
      .setDescription('Nobody answered in time, so the door stayed closed.')
      .setFields((msg.embeds[0].fields || []).filter(f => f.name !== 'Expires'));

    const payload = { content: `⌛ ${pending.who} — expired`, embeds: [embed], components: [] };
    if (!storage.findByUID(pending.uid)) {
      payload.components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`add_member::${request_id}::${pending.uid}`)
          .setLabel('Add Member')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Primary),
      )];
    }
    await msg.edit(payload);
  } catch (e) {
    console.error('[API] expirePending error:', e.message);
  }
}

// ─── ADD-MEMBER FORM ─────────────────────────────────────────
// customId "modal_add::<request>::<uid>"  → card from a scan (UID known)
// customId "modal_new"                    → /addmember (asks for the UID too)
function buildAddModal(customId, uid) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(uid ? `Add member · card ${uid}` : 'Add new member');

  const rows = [
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('member_name').setLabel('Full name')
        .setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true)
    ),
  ];
  if (!uid) {
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('member_uid').setLabel('Card UID (digits only)')
        .setStyle(TextInputStyle.Short).setPlaceholder('e.g. 0002787912')
        .setMinLength(6).setMaxLength(12).setRequired(true)
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('member_role').setLabel('Role (leave empty = Member)')
      .setStyle(TextInputStyle.Short).setPlaceholder('Member / Leader / Board / President').setRequired(false)
  ));
  modal.addComponents(...rows);
  return modal;
}

// ─── ROUTES ──────────────────────────────────────────────────

router.post('/scan', async (req, res) => {
  const { uid, request_id, timestamp } = req.body;

  if (!uid || !request_id)
    return res.status(400).json({ error: 'Missing uid or request_id' });
  if (!validUID(uid))
    return res.status(400).json({ error: 'Invalid uid format' });

  const normUID = storage.normalizeUID(uid);
  console.log(`[API] Scan: uid=${normUID} req=${request_id}`);

  const member = storage.findByUID(normUID);

  if (member && !member.banned && member.dayGrant) {
    const todayDay = Math.floor(Date.now() / 86400000);
    if (member.dayGrantDate === todayDay) {
      console.log(`[API] Auto-grant (day pass): ${member.name} uid=${normUID}`);
      recordDecision(normUID, 'auto_day_pass', 'Automatic (day pass)', null);
      pendingRequests.set(request_id, {
        uid: normUID, request_id, timestamp,
        decision: { action: 'access_once', decidedAt: Date.now() },
        createdAt: Date.now(), messageId: null, who: whoLabel(member, normUID),
      });
      return res.json({ ok: true, queued: true, auto: 'day_pass' });
    } else {
      console.log(`[API] Day pass expired for ${member.name}, revoking`);
      storage.revokeDay(normUID);
    }
  }

  const pending = {
    uid: normUID, request_id, timestamp,
    decision: null, createdAt: Date.now(), messageId: null,
    who: whoLabel(member, normUID),
  };
  pendingRequests.set(request_id, pending);

  try {
    pending.messageId = await postPendingToDiscord(normUID, request_id);
  } catch (e) {
    console.error('[API] Discord post error:', e.message);
  }

  // Make sure the card is cleaned up even if the ESP stops polling
  const timer = setTimeout(() => {
    const p = pendingRequests.get(request_id);
    if (p && !p.decision && isPendingExpired(p)) expirePending(request_id).catch(() => {});
  }, PENDING_TTL_MS + 1500);
  if (timer.unref) timer.unref();

  res.json({ ok: true, queued: true });
});

router.get('/pending/:request_id', (req, res) => {
  const { request_id } = req.params;

  const pending = pendingRequests.get(request_id);
  if (!pending)
    return res.json({ action: null, reason: 'no_match' });

  if (pending.decision) {
    const action = pending.decision.espAction || pending.decision.action;
    pendingRequests.delete(request_id);
    return res.json({ action });
  }

  if (isPendingExpired(pending)) {
    expirePending(request_id).catch(() => {});
    return res.json({ action: 'deny', reason: 'expired' });
  }

  return res.json({ action: null, reason: 'waiting' });
});

router.post('/log', async (req, res) => {
  const { uid, name, role, event, reason, time, timestamp } = req.body;
  const normUID = storage.normalizeUID(uid || '');

  // Who approved / denied this entry? (button click in the last few minutes)
  const decision  = normUID ? getRecentDecision(normUID) : null;
  let decidedBy = '';
  if (decision) decidedBy = decision.by;
  else if (event === 'granted') decidedBy = 'Automatic (registered card)';

  storage.appendLog({ uid: normUID, name, role, event, reason, time, decidedBy });

  if (_channel) {
    try {
      const displayName = name && name !== uid && name !== 'N/A' ? name : (normUID || 'Unknown');
      let color, emoji, desc;
      if (event === 'granted') {
        color = 0x2ECC71; emoji = '✅';
        desc  = `**${displayName}** _(${role})_ entered at **${time || '??:??'}**`;
      } else {
        color = 0xE74C3C; emoji = '🚫';
        desc  = `**${displayName}** _(${role})_ was denied — ${reason || 'unknown'}`;
      }
      if (decision) {
        const label = event === 'granted' ? 'Approved by' : 'Decided by';
        const who   = decision.byId ? `<@${decision.byId}>` : decision.by;
        desc += `\n${label} ${who}`;
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

router.get('/updates', (req, res) => {
  const members = storage.flushQueue();
  let doorCmd   = null;
  if (pendingDoorCmd && Date.now() - doorCmdSetAt < DOOR_CMD_TTL_MS) {
    doorCmd        = pendingDoorCmd;
    pendingDoorCmd = null;
  }
  res.json({ members, door_cmd: doorCmd, has_queue: storage.peekQueue().length > 0 });
});

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

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral };
}

async function handleButtonDecision(interaction) {
  const [action, request_id, extraUid] = interaction.customId.split('::');
  const actor = { id: interaction.user.id, name: actorName(interaction) };

  // ── Add Member: works even if the scan already expired / was decided ──
  // add_member = expired card, add_after = card that was just accepted/denied
  if (action === 'add_member' || action === 'add_after') {
    const uid = extraUid || pendingRequests.get(request_id)?.uid;
    if (!uid) return interaction.reply(ephemeral('⚠️ Could not find the card UID for this request.'));

    const existing = storage.findByUID(uid);
    if (existing) {
      return interaction.reply(ephemeral(
        `ℹ️ This card is already registered as **${existing.name}** (${existing.role}).`
      ));
    }
    const modalKind = action === 'add_after' ? 'modal_addafter' : 'modal_add';
    return interaction.showModal(buildAddModal(`${modalKind}::${request_id}::${uid}`, uid));
  }

  const pending = pendingRequests.get(request_id);
  if (!pending)
    return interaction.reply(ephemeral('⚠️ This request is no longer active.'));

  if (isPendingExpired(pending)) {
    expirePending(request_id).catch(() => {});
    return interaction.reply(ephemeral('⌛ This request has expired.'));
  }

  if (pending.decision)
    return interaction.reply(ephemeral(`✅ Already decided by ${pending.decision.by || 'someone else'}.`));

  const uid = pending.uid;
  const wasUnknown = !storage.findByUID(uid);
  let note  = '';

  if (action === 'grant_day') {
    const r = storage.grantDay(uid);
    if (!r.ok) return interaction.reply(ephemeral(`❌ ${r.reason}`));
    note = 'Day pass is valid for today only.';

  } else if (action === 'access_once' || action === 'deny') {
    // nothing extra to do

  } else if (action === 'ban') {
    storage.banMember(uid);

  } else if (action === 'unban_open' || action === 'unban') {
    const member = storage.findByUID(uid);
    const role   = member?.role === 'Banned' ? 'Member' : (member?.role || 'Member');
    storage.unbanMember(uid, role);
    note = `Restored as **${role}**.`;

  } else {
    return interaction.reply(ephemeral('❓ Unknown action.'));
  }

  pending.decision = { action, decidedAt: Date.now(), by: actor.name, byId: actor.id };
  recordDecision(uid, action, actor.name, actor.id);

  const o = OUTCOMES[action];

  // Unregistered card that was let in or denied → ask if they should be added
  let components = [];
  if (wasUnknown && (action === 'access_once' || action === 'deny')) {
    note = (note ? note + '\n' : '') + '➕ Not registered yet — do you want to add them as a member?';
    components = [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`add_after::${request_id}::${uid}`)
        .setLabel('Add as Member')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary),
    )];
  }

  await interaction.update({
    content: `${o.icon} **${pending.who}** — ${o.title} (by ${actor.name})`,
    embeds: [decidedEmbed(interaction.message.embeds[0], action, pending.who, actor, note)],
    components,
  });
}

async function handleModalSubmit(interaction) {
  const [kind, request_id, uidFromId] = interaction.customId.split('::');
  const actor = { id: interaction.user.id, name: actorName(interaction) };

  const name = interaction.fields.getTextInputValue('member_name').trim();
  if (!name) return interaction.reply(ephemeral('❌ Please enter a name.'));

  const roleText = interaction.fields.getTextInputValue('member_role');
  const role     = parseRole(roleText);
  if (!role) {
    return interaction.reply(ephemeral(
      `❌ I don't know the role **${roleText}**. Use: Member, Leader, Board, or President (or leave it empty for Member).`
    ));
  }

  // UID comes from the card (scan) or from the form (/addmember)
  let uid = uidFromId;
  if (kind === 'modal_new') {
    const digits = interaction.fields.getTextInputValue('member_uid').replace(/\D/g, '');
    if (!validUID(digits))
      return interaction.reply(ephemeral('❌ The UID must be 6–12 digits.'));
    uid = digits;
  }

  const existing = storage.findByUID(uid);
  if (existing) {
    return interaction.reply(ephemeral(
      `ℹ️ This card is already registered as **${existing.name}** (${existing.role}).`
    ));
  }

  const result = storage.addMember(name, uid, role);
  if (!result.ok) return interaction.reply(ephemeral(`❌ ${result.reason}`));
  const normUID = result.member.uid;

  // ── Added from /addmember: simple confirmation ──
  if (kind === 'modal_new') {
    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle(`➕ Member added: ${name}`)
      .addFields(
        { name: 'Role', value: `${ROLE_EMOJI[role] || '👤'} ${role}`, inline: true },
        { name: 'UID',  value: `\`${normUID}\``,                      inline: true },
      )
      .setFooter({ text: `Added by ${actor.name}` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── Added after the card was already accepted/denied: keep that result, add a line ──
  if (kind === 'modal_addafter') {
    const ts = Math.floor(Date.now() / 1000);
    const old = interaction.message?.embeds?.[0];
    const line = `➕ **${name}** (${role}) registered by <@${actor.id}> at <t:${ts}:T>`;
    if (interaction.isFromMessage() && old) {
      const embed = EmbedBuilder.from(old)
        .setDescription(String(old.description || '').replace(/\n?➕ Not registered yet[^\n]*/g, '') + `\n${line}`)
        .setTitle(String(old.title || '').replace(/^(\S+) .*? — /, `$1 ${name} — `));
      return interaction.update({
        content: `${interaction.message.content || ''} · ➕ registered as ${name}`,
        embeds: [embed],
        components: [],
      });
    }
    return interaction.reply({ content: line });
  }

  // ── Added from a scan card ──
  const pending = pendingRequests.get(request_id);
  const live    = pending && !pending.decision && !isPendingExpired(pending);

  let outcomeKey, note;
  if (live) {
    pending.decision = {
      action: 'add_member', espAction: 'access_once',
      decidedAt: Date.now(), by: actor.name, byId: actor.id,
    };
    recordDecision(normUID, 'add_member', actor.name, actor.id);
    outcomeKey = 'add_member';
    note = `Registered as **${name}** (${role}) and the door is opening.`;
  } else {
    outcomeKey = 'add_only';
    note = `Registered as **${name}** (${role}). The scan had already ended, so the door was **not** opened — ask them to scan again.`;
    if (pending) pendingRequests.delete(request_id);
  }

  const o = OUTCOMES[outcomeKey];
  if (interaction.isFromMessage() && interaction.message?.embeds?.[0]) {
    return interaction.update({
      content: `${o.icon} **${name}** — ${o.title} (by ${actor.name})`,
      embeds: [decidedEmbed(interaction.message.embeds[0], outcomeKey, name, actor, note)],
      components: [],
    });
  }
  return interaction.reply({ content: `${o.icon} **${name}** — ${o.title} (by ${actor.name})` });
}

function getActivePending() {
  let latest = null;
  for (const p of pendingRequests.values()) {
    if (isPendingExpired(p)) continue;
    if (!latest || p.createdAt > latest.createdAt) latest = p;
  }
  return latest;
}

module.exports = {
  router,
  setClient,
  queueDoorCommand,
  handleButtonDecision,
  handleModalSubmit,
  getActivePending,
  buildAddModal,
};
