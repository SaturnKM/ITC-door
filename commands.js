// ============================================================
//  commands.js — Slash command definitions & handlers
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
const ASSIGNABLE_ROLES = ['President', 'ExclusiveBoard', 'Leader', 'Member'];

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
    if (interaction.deferred) {
      return await interaction.editReply(payload);
    }
    if (interaction.replied) {
      return;
    }
    return await interaction.reply(payload);
  } catch (e) {
    if (e.code === 10062 || e.code === 40060) return;
    console.error('[CMD] respond() unexpected error:', e.message);
  }
}

// ─── COMMAND DEFINITIONS ─────────────────────────────────────
const commandDefs = [

  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a new member')
    .addStringOption(o => o.setName('name').setDescription('Full name').setRequired(true))
    .addStringOption(o => o.setName('uid').setDescription('10-digit RFID UID').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('Role (default: Member)').setRequired(false)
      .addChoices(...ASSIGNABLE_ROLES.map(r => ({ name: r, value: r })))),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member permanently')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a member and restore their role')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('Role to restore (default: Member)').setRequired(false)
      .addChoices(...ASSIGNABLE_ROLES.map(r => ({ name: r, value: r })))),

  new SlashCommandBuilder()
    .setName('grant_day')
    .setDescription('Grant a Leader/Member access for today only')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID').setRequired(true)),

  new SlashCommandBuilder()
    .setName('revoke_day')
    .setDescription('Revoke a day grant')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID or Name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('revoke_access')
    .setDescription('Revoke all temporary access for a member')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID or Name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('open_door')
    .setDescription('Remotely open the door for 8 seconds'),

  new SlashCommandBuilder()
    .setName('setrole')
    .setDescription('Change a member\'s role')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID').setRequired(true))
    .addStringOption(o => o.setName('role').setDescription('New role').setRequired(true)
      .addChoices(...ASSIGNABLE_ROLES.map(r => ({ name: r, value: r }))))
    .addStringOption(o => o.setName('name').setDescription('Also update name (optional)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('rename')
    .setDescription('Rename a member')
    .addStringOption(o => o.setName('uid').setDescription('RFID UID').setRequired(true))
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

      case 'add': {
        const name    = interaction.options.getString('name');
        const uid     = interaction.options.getString('uid').trim();
        const role    = interaction.options.getString('role') || 'Member';
        if (!ASSIGNABLE_ROLES.includes(role))
          return interaction.editReply(`❌ Invalid role **${role}**.`);
        const normUID = uid.length <= 10 ? uid.padStart(10, '0') : uid;
        const res     = storage.addMember(name, normUID, role);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply({ embeds: [memberEmbed(res.member, `✅ Added: ${name}`)] });
        break;
      }

      case 'ban': {
        const uid = interaction.options.getString('uid').trim();
        const res = storage.banMember(uid);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply({ embeds: [memberEmbed(res.member, `🔨 Banned: ${res.member.name}`)] });
        break;
      }

      case 'unban': {
        const uid         = interaction.options.getString('uid').trim();
        const restoreRole = interaction.options.getString('role') || 'Member';
        const res         = storage.unbanMember(uid, restoreRole);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply({
          embeds: [memberEmbed(res.member, `✅ Unbanned: ${res.member.name} → restored as **${restoreRole}**`)],
        });
        break;
      }

      case 'grant_day': {
        const uid = interaction.options.getString('uid').trim();
        const res = storage.grantDay(uid);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply({ embeds: [memberEmbed(res.member, `📅 Day grant: ${res.member.name}`)] });
        break;
      }

      case 'revoke_day': {
        const input = interaction.options.getString('uid').trim();
        let m = storage.findByUID(input);
        if (!m) {
          const byName = storage.findByName(input);
          if (byName.length === 1) m = byName[0];
          else if (byName.length > 1)
            return interaction.editReply(`❌ Multiple members match "${input}" — use UID instead.`);
        }
        if (!m) return interaction.editReply(`❌ Member not found: \`${input}\``);
        if (!m.dayGrant) return interaction.editReply(`ℹ️ **${m.name}** has no active day grant.`);
        const res = storage.revokeDay(m.uid);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply({ embeds: [memberEmbed(res.member, `🔒 Day grant revoked: ${res.member.name}`)] });
        break;
      }

      case 'revoke_access': {
        const input = interaction.options.getString('uid').trim();
        let m = storage.findByUID(input);
        if (!m) {
          const byName = storage.findByName(input);
          if (byName.length === 1) m = byName[0];
          else if (byName.length > 1)
            return interaction.editReply(`❌ Multiple members match "${input}" — use UID instead.`);
        }
        if (!m) return interaction.editReply(`❌ Member not found: \`${input}\``);
        let changed = false;
        if (m.dayGrant) { storage.revokeDay(m.uid); changed = true; }
        if (['Pending', 'Banned'].includes(m.role)) { storage.setRole(m.uid, 'Member'); changed = true; }
        if (!changed) return interaction.editReply(`ℹ️ **${m.name}** has no active temporary access.`);
        const updated = storage.findByUID(m.uid);
        await interaction.editReply({ embeds: [memberEmbed(updated, `🔒 Access revoked: ${updated.name}`)] });
        break;
      }

      case 'open_door': {
        api.queueDoorCommand('open_door');
        await respond(interaction, {
          content: '🔓 Door open command sent — ESP will open within **8 seconds**.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'setrole': {
        const uid     = interaction.options.getString('uid').trim();
        const role    = interaction.options.getString('role');
        const newName = interaction.options.getString('name');

        if (newName) {
          const renameRes = storage.renameMember(uid, newName);
          if (!renameRes.ok) return interaction.editReply(`❌ Rename failed: ${renameRes.reason}`);
        }

        const res = storage.setRole(uid, role);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);

        const updated = storage.findByUID(uid);
        await interaction.editReply({ embeds: [memberEmbed(updated, `🔄 Role updated: ${updated.name}`)] });
        break;
      }

      case 'rename': {
        const uid  = interaction.options.getString('uid').trim();
        const name = interaction.options.getString('name');
        const res  = storage.renameMember(uid, name);
        if (!res.ok) return interaction.editReply(`❌ ${res.reason}`);
        await interaction.editReply(`✅ Renamed to **${name}**.`);
        break;
      }

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

      case 'report': {
        const all     = storage.getAllMembers();
        const logs    = storage.getRecentLogs(500);
        const byRole  = {};
        for (const m of all) byRole[m.role] = (byRole[m.role] || 0) + 1;
        const granted = logs.filter(l => l.event === 'granted').length;
        const denied  = logs.filter(l => l.event === 'denied').length;
        const banned  = all.filter(m => m.banned).length;
        const dayG    = all.filter(m => m.dayGrant).length;
        const embed   = new EmbedBuilder()
          .setColor(0x1ABC9C)
          .setTitle('📊 Access Control Report')
          .addFields(
            { name: 'Total Members',     value: String(all.length), inline: true },
            { name: '🔴 Banned',         value: String(banned),     inline: true },
            { name: '📅 Day Grants',     value: String(dayG),       inline: true },
            { name: '✅ Granted',        value: String(granted),    inline: true },
            { name: '🚫 Denied',         value: String(denied),     inline: true },
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

      case 'status': {
        const allMembers  = storage.getAllMembers();
        const bannedCount = allMembers.filter(m => m.banned).length;
        const dayGCount   = allMembers.filter(m => m.dayGrant).length;
        const pending     = api.getActivePending();
        const queueItems  = storage.peekQueue();
        const embed       = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle('🟢 System Status')
          .addFields(
            { name: '🤖 Bot',           value: '✅ Online',                    inline: true },
            { name: '⏱ Uptime',         value: formatUptime(process.uptime()), inline: true },
            { name: '🕐 Server Time',    value: new Date().toLocaleString(),    inline: true },
            { name: '👥 Total Members',  value: String(allMembers.length),     inline: true },
            { name: '🔴 Banned',         value: String(bannedCount),           inline: true },
            { name: '📅 Day Grants',     value: String(dayGCount),             inline: true },
            { name: '📡 Sync Queue',     value: `${queueItems.length} pending`,inline: true },
            { name: '⏳ Pending',        value: pending
                ? `UID \`${pending.uid}\` — ${Math.floor((Date.now()-pending.createdAt)/1000)}s ago`
                : 'None', inline: true },
          )
          .setFooter({ text: 'ESP32 heartbeat every 60 s' })
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'sync': {
        const all = storage.getAllMembers();
        for (const m of all) storage.queueUpdate(m);
        await respond(interaction, {
          content: `✅ **${all.length}** members queued for re-sync — ESP will update within 30 s.`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'help': {
        const embed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle('📖 RFID Access Control — Commands')
          .setDescription([
            '`/add <n> <uid> [role]` — Add a new member',
            '`/ban <uid>` — Permanently ban a member',
            '`/unban <uid> [role]` — Unban and restore role (default: Member)',
            '`/grant_day <uid>` — Grant today-only access (Leader/Member)',
            '`/revoke_day <uid>` — Revoke day grant',
            '`/revoke_access <uid>` — Revoke all temporary access',
            '`/open_door` — Remotely open the door',
            '`/setrole <uid> <role> [name]` — Change role (and optionally rename)',
            '`/rename <uid> <n>` — Rename a member',
            '`/list [role]` — List members grouped by role',
            '`/pending` — Show active pending request',
            '`/log [n]` — Show recent access logs',
            '`/report` — Full access report',
            '`/status` — System status',
            '`/sync` — Force re-push all members to ESP32',
            '`/help` — This message',
          ].join('\n'));
        await respond(interaction, { embeds: [embed], flags: MessageFlags.Ephemeral });
        break;
      }

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
