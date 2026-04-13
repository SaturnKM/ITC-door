// ============================================================
//  commands.js — Slash command definitions & handlers
//  File 2/4  |  RFID Access Control Bot
// ============================================================
'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

const storage = require('./storage');
const api     = require('./api');

// ─── VALID ROLES ─────────────────────────────────────────────
const VALID_ROLES = ['President', 'ExclusiveBoard', 'Leader', 'Member', 'Pending', 'Banned'];

// ─── ROLE META ───────────────────────────────────────────────
const ROLE_META = {
  President:      { emoji: '👑', color: 0xF1C40F, label: 'President'      },
  ExclusiveBoard: { emoji: '⭐', color: 0x9B59B6, label: 'Exclusive board' },
  Leader:         { emoji: '🔑', color: 0x3498DB, label: 'Leader'          },
  Member:         { emoji: '👤', color: 0x2ECC71, label: 'Member'          },
  Pending:        { emoji: '⏳', color: 0xF39C12, label: 'Pending'         },
  Banned:         { emoji: '🔨', color: 0xE74C3C, label: 'Banned'          },
};

function roleColor(role) {
  return (ROLE_META[role] || {}).color || 0x95A5A6;
}

function memberEmbed(m, title) {
  return new EmbedBuilder()
    .setColor(m.banned ? 0xE74C3C : roleColor(m.role))
    .setTitle(title || m.name)
    .addFields(
      { name: 'Name',      value: m.name,                         inline: true },
      { name: 'UID',       value: `\`${m.uid}\``,                 inline: true },
      { name: 'Role',      value: m.role,                         inline: true },
      { name: 'Banned',    value: m.banned ? '🔴 Yes' : '🟢 No', inline: true },
      { name: 'Day Grant', value: m.dayGrant ? '✅ Active' : '—', inline: true },
    );
}

// ─── RESPOND HELPER ──────────────────────────────────────────
async function respond(interaction, payload) {
  try {
    if (interaction.deferred) return await interaction.editReply(payload);
    if (interaction.replied)  return;
    return await interaction.reply(payload);
  } catch (e) {
    if (e.code === 10062 || e.code === 40060) return;
    console.error('[CMD] respond() unexpected error:', e.message);
  }
}

// ─── NAME-OR-UID LOOKUP HELPER ───────────────────────────────
// Tries UID first, then name. Returns { m, err } where err is a
// ready-to-send error string if the lookup failed.
function resolveTarget(input) {
  let m = storage.findByUID(input);
  if (m) return { m, err: null };
  const byName = storage.findByName(input);
  if (byName.length === 1)  return { m: byName[0], err: null };
  if (byName.length  >  1)  return { m: null, err: `❌ Multiple members match **"${input}"** — use the UID instead.` };
  return { m: null, err: `❌ Member not found: \`${input}\`` };
}

// ─── COMMAND DEFINITIONS ─────────────────────────────────────
const commandDefs = [

  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a new member')
    .addStringOption(o => o.setName('name').setDescription('Full name').setRequired(true))
    .addStringOption(o => o.setName('uid').setDescription('10-digit RFID UID').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('Role (default: Member)').setRequired(false)
      .addChoices(...VALID_ROLES.map(r => ({ name: r, value: r })))),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member permanently')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID or Name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a member and restore their role')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID or Name').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('Role to restore (default: Leader)').setRequired(false)
      .addChoices(...VALID_ROLES.filter(r => r !== 'Banned').map(r => ({ name: r, value: r })))),

  new SlashCommandBuilder()
    .setName('grant_day')
    .setDescription('Grant a Leader/Member access for today only')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID or Name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('revoke_day')
    .setDescription('Revoke a day grant (member must have one active)')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID or Name').setRequired(true)),

  // FIX: /revoke_access now also sets the role to Pending so the ESP forces
  // Discord approval on the next scan, even if there was no day grant to clear.
  // This handles the "Access Once was granted but we want to block further scans"
  // case — previously it would say "no active temporary access" and do nothing.
  new SlashCommandBuilder()
    .setName('revoke_access')
    .setDescription('Block further scans today — revokes day grant and requires Discord approval on next scan')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID or Name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('open_door')
    .setDescription('Remotely open the door for 5 seconds'),

  new SlashCommandBuilder()
    .setName('setrole')
    .setDescription('Change a member\'s role')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID or Name').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('New role').setRequired(true)
      .addChoices(...VALID_ROLES.map(r => ({ name: r, value: r }))))
    .addStringOption(o => o.setName('name').setDescription('Also update name (optional)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('rename')
    .setDescription('Rename a member')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID or Name').setRequired(true))
    .addStringOption(o => o.setName('name').setDescription('New name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('list')
    .setDescription('List all members grouped by role')
    .addStringOption(o => o.setName('role').setDescription('Filter by role').setRequired(false)
      .addChoices(...VALID_ROLES.map(r => ({ name: r, value: r })))),

  new SlashCommandBuilder()
    .setName('pending')
    .setDescription('Show the current pending access request'),

  new SlashCommandBuilder()
    .setName('log')
    .setDescription('Show recent access logs')
    .addIntegerOption(o => o.setName('n').setDescription('Number of entries (default 20)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Generate access report summary'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show system status'),

  new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Force re-push all members to ESP32 (fixes cleared/corrupted CSV)'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands'),
];

// ─── COMMAND HANDLER ─────────────────────────────────────────
async function handleCommand(interaction) {
  const { commandName } = interaction;

  const NEEDS_DEFER = [
    'add', 'ban', 'unban', 'grant_day', 'revoke_day', 'revoke_access',
    'setrole', 'rename', 'list', 'log', 'report', 'status',
  ];
  const IS_PUBLIC = ['list', 'log', 'report'];

  if (NEEDS_DEFER.includes(commandName)) {
    try {
      await interaction.deferReply(
        IS_PUBLIC.includes(commandName) ? {} : { flags: MessageFlags.Ephemeral }
      );
    } catch (e) {
      if (e.code === 10062 || e.code === 40060) return;
      console.error(`[CMD] deferReply failed for /${commandName}:`, e.message);
      return;
    }
  }

  try {
    switch (commandName) {

      // ── /add ───────────────────────────────────────────────
      case 'add': {
        const name    = interaction.options.getString('name');
        const uid     = interaction.options.getString('uid').trim();
        const role    = interaction.options.getString('role') || 'Member';
        const normUID = uid.length <= 10 ? uid.padStart(10, '0') : uid;
        const res     = storage.addMember(name, normUID, role);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply({ embeds: [memberEmbed(res.member, `✅ Added: ${name}`)] });
        break;
      }

      // ── /ban ───────────────────────────────────────────────
      case 'ban': {
        const input = interaction.options.getString('uid').trim();
        // Try by UID first; if that fails, resolve by name
        let uid = input;
        if (!storage.findByUID(input)) {
          const { m, err } = resolveTarget(input);
          if (err) return interaction.editReply(err);
          uid = m.uid;
        }
        const res = storage.banMember(uid);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply({ embeds: [memberEmbed(res.member, `🔨 Banned: ${res.member.name}`)] });
        break;
      }

      // ── /unban ─────────────────────────────────────────────
      case 'unban': {
        const input       = interaction.options.getString('uid').trim();
        const restoreRole = interaction.options.getString('role') || 'Leader';
        const { m, err }  = resolveTarget(input);
        if (err) return interaction.editReply(err);
        const res = storage.unbanMember(m.uid, restoreRole);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply({
          embeds: [memberEmbed(res.member, `✅ Unbanned: ${res.member.name} → restored as **${restoreRole}**`)],
        });
        break;
      }

      // ── /grant_day ─────────────────────────────────────────
      case 'grant_day': {
        const input      = interaction.options.getString('uid').trim();
        const { m, err } = resolveTarget(input);
        if (err) return interaction.editReply(err);
        // If the member is Pending, restore their real role first so grantDay() passes the role check.
        // Pending members have their real role stored as Leader/Member before being set to Pending.
        // We default to Leader since that's the most common escalated role in this club.
        if (m.role === 'Pending') {
          storage.setRole(m.uid, 'Leader');
        }
        const fresh = storage.findByUID(m.uid);
        const res   = storage.grantDay(fresh.uid);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply({ embeds: [memberEmbed(res.member, `📅 Day grant: ${res.member.name}`)] });
        break;
      }

      // ── /revoke_day ────────────────────────────────────────
      case 'revoke_day': {
        const input      = interaction.options.getString('uid').trim();
        const { m, err } = resolveTarget(input);
        if (err) return interaction.editReply(err);
        if (!m.dayGrant) return interaction.editReply(`ℹ️ **${m.name}** has no active day grant.`);
        const res = storage.revokeDay(m.uid);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply({ embeds: [memberEmbed(res.member, `🔒 Day grant revoked: ${res.member.name}`)] });
        break;
      }

      // ── /revoke_access ─────────────────────────────────────
      // FIX: The old version only checked m.dayGrant and Pending/Banned role,
      // so if a member used "Access Once" (no day grant stored) it would say
      // "no active temporary access" and do nothing — leaving them free to
      // scan again immediately and get another pending request.
      //
      // New behaviour:
      //   1. Revoke any active day grant (if present).
      //   2. Set role to "Pending" regardless of current state (unless already Banned).
      //      This forces the ESP to escalate to Discord on the next scan, giving
      //      admins full control over whether to let them in again.
      //   3. Queue the update so the ESP receives it within 30 s.
      //
      // To undo: use /grant_day (which also clears Pending and restores Leader)
      //          or /setrole to manually restore their role.
      case 'revoke_access': {
        const input      = interaction.options.getString('uid').trim();
        const { m, err } = resolveTarget(input);
        if (err) return interaction.editReply(err);

        if (m.banned) {
          return interaction.editReply(`ℹ️ **${m.name}** is already banned — use \`/unban\` to manage them.`);
        }

        // Revoke day grant if present
        if (m.dayGrant) storage.revokeDay(m.uid);

        // Set to Pending so ESP forces Discord approval on next scan
        // (skip if already Pending — nothing to change on the role)
        if (m.role !== 'Pending') {
          storage.setRole(m.uid, 'Pending');
        }

        const updated = storage.findByUID(m.uid);
        const embed   = memberEmbed(updated, `🔒 Access blocked: ${updated.name}`)
          .setDescription('Role set to **Pending** — next scan will require Discord approval.\nUse `/grant_day` or `/setrole` to restore access.');
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      // ── /open_door ─────────────────────────────────────────
      case 'open_door': {
        api.queueDoorCommand('open_door');
        await respond(interaction, {
          content: '🔓 Door open command sent — ESP will open within **8 seconds**.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      // ── /setrole ───────────────────────────────────────────
      case 'setrole': {
        const input   = interaction.options.getString('uid').trim();
        const role    = interaction.options.getString('role');
        const newName = interaction.options.getString('name');
        const { m, err } = resolveTarget(input);
        if (err) return interaction.editReply(err);

        if (newName) {
          const renameRes = storage.renameMember(m.uid, newName);
          if (!renameRes.ok) return interaction.editReply(`❌ Rename failed: ${renameRes.reason}`);
        }

        const res = storage.setRole(m.uid, role);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);

        const updated = storage.findByUID(m.uid);
        await interaction.editReply({ embeds: [memberEmbed(updated, `🔄 Role updated: ${updated.name}`)] });
        break;
      }

      // ── /rename ────────────────────────────────────────────
      case 'rename': {
        const input      = interaction.options.getString('uid').trim();
        const name       = interaction.options.getString('name');
        const { m, err } = resolveTarget(input);
        if (err) return interaction.editReply(err);
        const res = storage.renameMember(m.uid, name);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply(`✅ Renamed **${m.name}** → **${name}**.`);
        break;
      }

      // ── /list ──────────────────────────────────────────────
      case 'list': {
        const roleFilter = interaction.options.getString('role');
        const allMembers = storage.getAllMembers();
        const ORDER      = ['President', 'ExclusiveBoard', 'Leader', 'Member', 'Pending', 'Banned'];

        const groups = {};
        for (const m of allMembers) {
          const key = m.banned ? 'Banned' : m.role;
          if (!groups[key]) groups[key] = [];
          groups[key].push(m);
        }
        for (const key of Object.keys(groups))
          groups[key].sort((a, b) => a.name.localeCompare(b.name));

        if (roleFilter) {
          const list = groups[roleFilter] || [];
          if (!list.length) return interaction.editReply(`No members with role **${roleFilter}**.`);
          const meta = ROLE_META[roleFilter] || { emoji: '👤', label: roleFilter };
          const embed = new EmbedBuilder()
            .setColor(roleFilter === 'Banned' ? 0xE74C3C : roleColor(roleFilter))
            .setTitle(`${meta.emoji} ${meta.label} (${list.length})`)
            .setDescription(list.map(m =>
              `${m.banned ? '🔴 ' : ''}**${m.name}** — \`${m.uid}\`${m.dayGrant ? ' 📅' : ''}`
            ).join('\n'));
          return interaction.editReply({ embeds: [embed] });
        }

        const lines = [];
        for (const role of ORDER) {
          const list = groups[role];
          if (!list || !list.length) continue;
          const meta = ROLE_META[role] || { emoji: '👤', label: role };
          lines.push(`\n${meta.emoji} **${meta.label} (${list.length})**`);
          for (const m of list)
            lines.push(`${m.banned ? '🔴 ' : ''}${m.name} — \`${m.uid}\`${m.dayGrant ? ' 📅' : ''}`);
        }

        const activeCount = allMembers.filter(m => !m.banned).length;
        const embed = new EmbedBuilder()
          .setColor(0x2C2F33)
          .setTitle('📋 Approved Members')
          .setDescription(lines.join('\n').slice(0, 4000))
          .setFooter({ text: `${activeCount} active · ${allMembers.length} total` })
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      // ── /pending ───────────────────────────────────────────
      case 'pending': {
        const p = api.getActivePending();
        if (!p) {
          return respond(interaction, { content: '✅ No pending requests.', flags: MessageFlags.Ephemeral });
        }
        const age    = Math.floor((Date.now() - p.createdAt) / 1000);
        const member = storage.findByUID(p.uid);
        const embed  = new EmbedBuilder()
          .setColor(0xF5A623)
          .setTitle('⏳ Active Pending Request')
          .addFields(
            { name: 'UID',    value: `\`${p.uid}\``,                                        inline: true },
            { name: 'Name',   value: member?.name || '_Unknown_',                            inline: true },
            { name: 'Req ID', value: `\`${p.request_id}\``,                                 inline: true },
            { name: 'Age',    value: `${age}s / 60s`,                                       inline: true },
            { name: 'Status', value: p.decision ? `✅ ${p.decision.action}` : '⏳ Waiting', inline: true },
          );
        await respond(interaction, { embeds: [embed], flags: MessageFlags.Ephemeral });
        break;
      }

      // ── /log ───────────────────────────────────────────────
      case 'log': {
        const n    = Math.min(interaction.options.getInteger('n') || 20, 50);
        const logs = storage.getRecentLogs(n);
        if (!logs.length) return interaction.editReply('No logs found.');
        const lines = logs.map(l => {
          const serverDate = new Date(l.ts).toLocaleString('en-GB', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          });
          const icon    = l.event === 'granted' ? '✅' : '🚫';
          const espTime = l.time && l.time.trim() && !['undefined','--:--','N/A'].includes(l.time.trim())
            ? ` **${l.time.trim()}**` : '';
          const reason  = l.reason && l.reason.trim() && !['undefined','N/A',''].includes(l.reason.trim())
            ? ` — _${l.reason.trim()}_` : '';
          const display = l.name && !['undefined','N/A',''].includes(l.name) ? l.name : l.uid;
          return `${icon} **${display}** _(${l.role || '?'})_${espTime}${reason} · ${serverDate}`;
        });
        const embed = new EmbedBuilder()
          .setColor(0x34495E)
          .setTitle(`📜 Last ${logs.length} Access Log Entries`)
          .setDescription(lines.join('\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      // ── /report ────────────────────────────────────────────
      case 'report': {
        const all     = storage.getAllMembers();
        const logs    = storage.getRecentLogs(500);
        const byRole  = {};
        for (const m of all) byRole[m.role] = (byRole[m.role] || 0) + 1;
        const granted = logs.filter(l => l.event === 'granted').length;
        const denied  = logs.filter(l => l.event === 'denied').length;
        const banned  = all.filter(m => m.banned).length;
        const dayG    = all.filter(m => m.dayGrant).length;
        const pending = all.filter(m => m.role === 'Pending' && !m.banned).length;
        const embed   = new EmbedBuilder()
          .setColor(0x1ABC9C)
          .setTitle('📊 Access Control Report')
          .addFields(
            { name: 'Total Members',     value: String(all.length),  inline: true },
            { name: '🔴 Banned',         value: String(banned),      inline: true },
            { name: '⏳ Pending',         value: String(pending),     inline: true },
            { name: '📅 Day Grants',     value: String(dayG),        inline: true },
            { name: '✅ Granted',        value: String(granted),     inline: true },
            { name: '🚫 Denied',         value: String(denied),      inline: true },
            { name: 'Role Breakdown',
              value: Object.entries(byRole)
                .map(([r, n]) => `${(ROLE_META[r]||{}).emoji||'•'} ${r}: ${n}`)
                .join('\n') || '—',
              inline: false },
          )
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      // ── /status ────────────────────────────────────────────
      case 'status': {
        const allMembers  = storage.getAllMembers();
        const bannedCount = allMembers.filter(m => m.banned).length;
        const dayGCount   = allMembers.filter(m => m.dayGrant).length;
        const pendingBlocked = allMembers.filter(m => m.role === 'Pending' && !m.banned).length;
        const pending     = api.getActivePending();
        const queueItems  = storage.peekQueue();
        const embed       = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle('🟢 System Status')
          .addFields(
            { name: '🤖 Bot',            value: '✅ Online',                    inline: true },
            { name: '⏱ Uptime',          value: formatUptime(process.uptime()), inline: true },
            { name: '🕐 Server Time',     value: new Date().toLocaleString(),    inline: true },
            { name: '👥 Total Members',   value: String(allMembers.length),     inline: true },
            { name: '🔴 Banned',          value: String(bannedCount),           inline: true },
            { name: '📅 Day Grants',      value: String(dayGCount),             inline: true },
            { name: '⏳ Blocked/Pending', value: String(pendingBlocked),        inline: true },
            { name: '📡 Sync Queue',      value: `${queueItems.length} pending`,inline: true },
            { name: '🔔 Active Request',  value: pending
                ? `UID \`${pending.uid}\` — ${Math.floor((Date.now()-pending.createdAt)/1000)}s ago`
                : 'None', inline: true },
          )
          .setFooter({ text: 'ESP32 heartbeat every 60 s' })
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      // ── /sync ──────────────────────────────────────────────
      case 'sync': {
        const all = storage.getAllMembers();
        for (const m of all) storage.queueUpdate(m);
        await respond(interaction, {
          content: `✅ **${all.length}** members queued for re-sync — ESP will update within 30 s.`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      // ── /help ──────────────────────────────────────────────
      case 'help': {
        const embed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle('📖 RFID Access Control — Commands')
          .setDescription([
            '**Access Management**',
            '`/grant_day <uid|name>` — Grant today-only access (Leader/Member)',
            '`/revoke_day <uid|name>` — Revoke an active day grant',
            '`/revoke_access <uid|name>` — Block further scans (sets role to Pending, requires Discord approval on next scan)',
            '`/open_door` — Remotely open the door now',
            '',
            '**Member Management**',
            '`/add <name> <uid> [role]` — Add a new member',
            '`/ban <uid|name>` — Permanently ban a member',
            '`/unban <uid|name> [role]` — Unban and restore role (default: Leader)',
            '`/setrole <uid|name> <role> [name]` — Change role (and optionally rename)',
            '`/rename <uid|name> <name>` — Rename a member',
            '',
            '**Info**',
            '`/list [role]` — List members grouped by role',
            '`/pending` — Show active pending request',
            '`/log [n]` — Show recent access logs (default: 20)',
            '`/report` — Full access report',
            '`/status` — System status',
            '`/sync` — Force re-push all members to ESP32',
            '',
            '> 💡 After using `/revoke_access`, the member\'s next scan will appear in Discord for approval. Use `/grant_day` to restore them.',
          ].join('\n'));
        await respond(interaction, { embeds: [embed], flags: MessageFlags.Ephemeral });
        break;
      }

      // ── unknown ────────────────────────────────────────────
      default: {
        await respond(interaction, { content: '❓ Unknown command.', flags: MessageFlags.Ephemeral });
        break;
      }
    }

  } catch (e) {
    if (e.code === 10062 || e.code === 40060) return;
    console.error(`[CMD] Error in /${commandName}:`, e);
    await respond(interaction, { content: '❌ An error occurred.', flags: MessageFlags.Ephemeral });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────
function formatUptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h}h ${m}m ${s}s`;
}

// ─── REGISTER COMMANDS ───────────────────────────────────────
async function registerCommands(client) {
  try {
    const guildId = process.env.GUILD_ID;
    if (guildId) {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(commandDefs);
      console.log(`[CMD] Registered ${commandDefs.length} commands to guild ${guildId} (instant)`);
    } else {
      console.warn('[CMD] GUILD_ID not set — global registration (up to 1 hour delay).');
      await client.application.commands.set(commandDefs);
    }
  } catch (e) {
    console.error('[CMD] Registration error:', e);
  }
}

module.exports = { handleCommand, registerCommands };