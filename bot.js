// ─────────────────────────────────────────────────────────────────────────────
//  RFID Access Control — Discord Bot MODULE
//  Entry point: server.js  |  Exports: startBot(), notifyDiscord()
// ─────────────────────────────────────────────────────────────────────────────
 
require("dotenv").config();

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
} = require("discord.js");

const {
  getMember,
  upsertMember,
  updateRole,
  logScan,
  getRecentLog,
  getStats,
  isGrantedToday,
  grantDay,
  revokeDay,
  pushCommand,
  getPendingMembers,
  getApprovedMembers,
  saveChannelId,
  getChannelId,
} = require("./database");

// ─── Config ──────────────────────────────────────────────────────────────────
const TOKEN     = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID  = process.env.GUILD_ID;

// Canonical role values stored in DB (must match ESP32 strcmp checks exactly)
const VALID_ROLES = ["President", "ExclusiveBoard", "Leader", "Member"];

// Human-readable labels for Discord display
const ROLE_LABELS = {
  President:      "President",
  ExclusiveBoard: "Exclusive Board",
  Leader:         "Leader",
  Member:         "Member",
  banned:         "Banned",
  pending:        "Pending",
};
const roleLabel = (r) => ROLE_LABELS[r] || r || "?";

// ─── Discord client ───────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── Helper: fetch notify channel ────────────────────────────────────────────
async function getNotifyChannel() {
  const id = getChannelId();
  if (!id) return null;
  return client.channels.fetch(id).catch(() => null);
}

// ─── Embed builders ───────────────────────────────────────────────────────────
function unknownEmbed(uid, name, role, result) {
  const isBanned = result === "BANNED" || role === "banned";
  return new EmbedBuilder()
    .setTitle(isBanned ? "🚫 Banned Card Scanned" : "❓ Unknown / Pending Card")
    .setColor(isBanned ? 0xff0000 : 0xffa500)
    .addFields(
      { name: "UID",    value: uid || "—",           inline: true },
      { name: "Name",   value: name || "—",           inline: true },
      { name: "Role",   value: roleLabel(role),        inline: true },
      { name: "Time",   value: new Date().toLocaleTimeString("fr-DZ", { hour: "2-digit", minute: "2-digit" }), inline: true },
      { name: "Result", value: result || "—",          inline: true },
    )
    .setTimestamp();
}

function accessEmbed(uid, name, role, result) {
  const granted = result.startsWith("GRANTED");
  const color   = granted ? 0x00cc44 : result === "BANNED" ? 0xff0000 : 0xff4444;
  const icon    = granted ? "✅" : result === "BANNED" ? "🚫" : "❌";

  const LABELS = {
    GRANTED_LEADER:     "access granted (within hours)",
    GRANTED_PRESIDENT:  "access granted (24/7)",
    GRANTED_BOARD:      "access granted (24/7)",
    GRANTED_ONCE:       "one-time access granted",
    GRANTED_REMOTE:     "door opened remotely",
    GRANTED_LEADER_DAY: "access granted (day grant)",
    DENIED_HOURS:       "denied — outside access hours",
    DENIED_BANNED:      "denied — banned",
    DENIED_MANUAL:      "denied — manual",
    BANNED:             "banned card scanned",
    NOT_IN_LIST:        "unknown card scanned",
  };
  const label = LABELS[result] || result;

  return new EmbedBuilder()
    .setColor(color)
    .setDescription(`${icon} **${name || uid}** *(${roleLabel(role)})* — ${label}`)
    .setTimestamp();
}

// ─── Button row factory ───────────────────────────────────────────────────────
// disabled: array of action IDs to disable. "add_member" is never disabled.
function actionRows(uid, disabled = []) {
  const d = (id) => disabled.includes(id);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`grant_day:${uid}`).setLabel("Grant 1 Day")  .setStyle(ButtonStyle.Success)  .setDisabled(d("grant_day")),
      new ButtonBuilder().setCustomId(`access_once:${uid}`).setLabel("Access Once").setStyle(ButtonStyle.Primary)  .setDisabled(d("access_once")),
      new ButtonBuilder().setCustomId(`add_member:${uid}`).setLabel("Add Member")  .setStyle(ButtonStyle.Secondary).setDisabled(false),
      new ButtonBuilder().setCustomId(`deny:${uid}`).setLabel("Deny")              .setStyle(ButtonStyle.Danger)   .setDisabled(d("deny")),
      new ButtonBuilder().setCustomId(`ban:${uid}`).setLabel("Ban")                .setStyle(ButtonStyle.Danger)   .setDisabled(d("ban")),
    ),
  ];
}

const ACCESS_TAKEN_DISABLE = ["grant_day", "access_once", "deny", "ban"];

// ─── notifyDiscord — called by server.js ─────────────────────────────────────
async function notifyDiscord({ uid, name, result, askButtons = false, statusData, members, pending, log, reportData }) {
  const channel = await getNotifyChannel();
  if (!channel) {
    console.warn("[Bot] No notify channel set. Use /setchannel in Discord.");
    return;
  }

  // ── STATUS_REPLY ────────────────────────────────────────────────────────────
  if (result === "STATUS_REPLY" && statusData) {
    const embed = new EmbedBuilder()
      .setTitle("🔌 ESP32 Status")
      .setColor(0x0099ff)
      .addFields(
        { name: "IP",         value: statusData.ip        || "—", inline: true },
        { name: "RSSI",       value: statusData.rssi != null ? `${statusData.rssi} dBm` : "—", inline: true },
        { name: "Uptime",     value: statusData.uptime    || "—", inline: true },
        { name: "Members",    value: String(statusData.memberCount ?? "—"), inline: true },
        { name: "Free Heap",  value: statusData.freeHeap != null ? `${statusData.freeHeap} B` : "—", inline: true },
        { name: "LCD",        value: statusData.lcd       || "—", inline: true },
      )
      .setTimestamp();
    await channel.send({ embeds: [embed] }).catch(console.error);
    return;
  }

  // ── LIST_REPLY ───────────────────────────────────────────────────────────────
  if (result === "LIST_REPLY" && members) {
    const lines = members.map(m => `\`${m.uid}\` **${m.name}** — ${roleLabel(m.role)}`).join("\n") || "No members.";
    await channel.send({ embeds: [new EmbedBuilder().setTitle("📋 Members (ESP32)").setDescription(lines).setColor(0x0099ff)] }).catch(console.error);
    return;
  }

  // ── PENDING_REPLY ────────────────────────────────────────────────────────────
  if (result === "PENDING_REPLY" && pending) {
    const lines = pending.map(p => `\`${p.uid}\` **${p.name || "?"}**`).join("\n") || "None.";
    await channel.send({ embeds: [new EmbedBuilder().setTitle("⏳ Pending Cards").setDescription(lines).setColor(0xffa500)] }).catch(console.error);
    return;
  }

  // ── LOG_REPLY ────────────────────────────────────────────────────────────────
  if (result === "LOG_REPLY" && log) {
    const lines = log.map(l => `\`${l.uid}\` **${l.name}** — ${l.result}`).join("\n") || "No logs.";
    await channel.send({ embeds: [new EmbedBuilder().setTitle("📜 Recent Log").setDescription(lines).setColor(0x888888)] }).catch(console.error);
    return;
  }

  // ── REPORT_REPLY ─────────────────────────────────────────────────────────────
  if (result === "REPORT_REPLY") {
    const stats = getStats();
    const embed = new EmbedBuilder()
      .setTitle("📊 Access Report")
      .setColor(0x0099ff)
      .addFields(
        { name: "Total scans",  value: String(stats.total      ?? 0), inline: true },
        { name: "Granted",      value: String(stats.granted    ?? 0), inline: true },
        { name: "Denied",       value: String(stats.denied     ?? 0), inline: true },
        { name: "Banned scans", value: String(stats.banned     ?? 0), inline: true },
        { name: "Unknown",      value: String(stats.unknown    ?? 0), inline: true },
        { name: "Day grants",   value: String(stats.day_grants ?? 0), inline: true },
      )
      .setTimestamp();
    await channel.send({ embeds: [embed] }).catch(console.error);
    return;
  }

  // ── NOT_IN_LIST / unknown card — show action buttons ─────────────────────────
  if (result === "NOT_IN_LIST" || askButtons) {
    const member = getMember(uid);
    const embed  = unknownEmbed(uid, member?.name || name, member?.role || "pending", result);
    await channel.send({ embeds: [embed], components: actionRows(uid) }).catch(console.error);
    return;
  }

  // ── BANNED — silent embed, no buttons ────────────────────────────────────────
  if (result === "BANNED" || result === "DENIED_BANNED") {
    const member = getMember(uid);
    await channel.send({ embeds: [accessEmbed(uid, member?.name || name, "banned", result)] }).catch(console.error);
    return;
  }

  // ── All other GRANTED_* / DENIED_* ───────────────────────────────────────────
  const member = getMember(uid);
  await channel.send({ embeds: [accessEmbed(uid, member?.name || name, member?.role || "?", result)] }).catch(console.error);
}

// ─── Slash command definitions ────────────────────────────────────────────────
const roleChoices = [
  { name: "President",       value: "President"      },
  { name: "Exclusive Board", value: "ExclusiveBoard" },
  { name: "Leader",          value: "Leader"         },
  { name: "Member",          value: "Member"         },
];

const commands = [
  new SlashCommandBuilder().setName("setchannel").setDescription("Set this channel for card scan alerts"),

  new SlashCommandBuilder().setName("add").setDescription("Add a new member")
    .addStringOption(o => o.setName("uid").setDescription("Card UID").setRequired(true))
    .addStringOption(o => o.setName("name").setDescription("Member name").setRequired(true))
    .addStringOption(o => o.setName("role").setDescription("Role").setRequired(true).addChoices(...roleChoices)),

  new SlashCommandBuilder().setName("ban").setDescription("Ban a member permanently")
    .addStringOption(o => o.setName("uid").setDescription("Card UID").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

  new SlashCommandBuilder().setName("unban").setDescription("Unban — restores to Leader")
    .addStringOption(o => o.setName("uid").setDescription("Card UID").setRequired(true)),

  new SlashCommandBuilder().setName("grant_day").setDescription("Grant full-day access today")
    .addStringOption(o => o.setName("uid").setDescription("Card UID").setRequired(true)),

  new SlashCommandBuilder().setName("revoke_day").setDescription("Revoke day grant")
    .addStringOption(o => o.setName("uid").setDescription("Card UID").setRequired(true)),

  new SlashCommandBuilder().setName("open_door").setDescription("Open door on demand"),

  new SlashCommandBuilder().setName("setrole").setDescription("Change member role")
    .addStringOption(o => o.setName("uid").setDescription("Card UID").setRequired(true))
    .addStringOption(o => o.setName("role").setDescription("New role").setRequired(true).addChoices(...roleChoices)),

  new SlashCommandBuilder().setName("rename").setDescription("Rename a member")
    .addStringOption(o => o.setName("uid").setDescription("Card UID").setRequired(true))
    .addStringOption(o => o.setName("name").setDescription("New name").setRequired(true)),

  new SlashCommandBuilder().setName("list").setDescription("List approved members"),
  new SlashCommandBuilder().setName("pending").setDescription("Show pending / unknown cards"),
  new SlashCommandBuilder().setName("log").setDescription("Recent scan log")
    .addIntegerOption(o => o.setName("count").setDescription("How many (default 10, max 25)").setRequired(false)),
  new SlashCommandBuilder().setName("report").setDescription("Access statistics"),
  new SlashCommandBuilder().setName("status").setDescription("Request ESP32 vitals"),
  new SlashCommandBuilder().setName("help").setDescription("All commands explained"),
].map(c => c.toJSON());

// ─── Interaction handler ──────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {

  // ── Slash commands ─────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    const cmd = interaction.commandName;

    // /setchannel
    if (cmd === "setchannel") {
      saveChannelId(interaction.channelId);
      await interaction.editReply(`✅ Scan alerts will now be posted in <#${interaction.channelId}>`);
    }

    // /add
    else if (cmd === "add") {
      const uid  = interaction.options.getString("uid").toUpperCase();
      const name = interaction.options.getString("name").trim();
      const role = interaction.options.getString("role");
      upsertMember(uid, name, role, interaction.user.tag);
      pushCommand(`add_${uid}_${Date.now()}`, "add_member", uid, name, role);
      logScan(uid, name, `ADDED_${role.toUpperCase()}`);
      await interaction.editReply(`✅ Added **${name}** as **${roleLabel(role)}** — UID: \`${uid}\``);
    }

    // /ban
    else if (cmd === "ban") {
      const uid    = interaction.options.getString("uid").toUpperCase();
      const reason = interaction.options.getString("reason") || "No reason given";
      const m      = getMember(uid);
      if (!m) return interaction.editReply("❌ UID not found in database.");
      updateRole(uid, "banned");
      pushCommand(`ban_${uid}_${Date.now()}`, "ban", uid, m.name, "banned");
      logScan(uid, m.name, "BANNED");
      await interaction.editReply(`🚫 Banned **${m.name}** (\`${uid}\`) — ${reason}`);
    }

    // /unban
    else if (cmd === "unban") {
      const uid = interaction.options.getString("uid").toUpperCase();
      const m   = getMember(uid);
      if (!m) return interaction.editReply("❌ UID not found in database.");
      updateRole(uid, "Leader");
      pushCommand(`unban_${uid}_${Date.now()}`, "update_member", uid, m.name, "Leader");
      await interaction.editReply(`✅ Unbanned **${m.name}** — restored to Leader`);
    }

    // /grant_day
    else if (cmd === "grant_day") {
      const uid = interaction.options.getString("uid").toUpperCase();
      const m   = getMember(uid);
      if (!m) return interaction.editReply("❌ UID not found in database.");
      grantDay(uid);
      pushCommand(`grant_day_${uid}_${Date.now()}`, "grant_day", uid, m.name, m.role);
      logScan(uid, m.name, "GRANTED_LEADER_DAY");
      await interaction.editReply(`✅ Day grant given to **${m.name}** — valid until midnight`);
    }

    // /revoke_day
    else if (cmd === "revoke_day") {
      const uid = interaction.options.getString("uid").toUpperCase();
      const m   = getMember(uid);
      if (!m) return interaction.editReply("❌ UID not found in database.");
      revokeDay(uid);                                         // ← actually remove from DB
      pushCommand(`revoke_day_${uid}_${Date.now()}`, "revoke_day", uid, m.name, m.role);
      await interaction.editReply(`✅ Day grant revoked for **${m.name}**`);
    }

    // /open_door
    else if (cmd === "open_door") {
      pushCommand(`open_door_${Date.now()}`, "open_door");
      logScan("ADMIN", "Admin", "GRANTED_REMOTE");
      await interaction.editReply("🚪 Door open command queued for ESP32 (valid for 60 s)");
    }

    // /setrole
    else if (cmd === "setrole") {
      const uid  = interaction.options.getString("uid").toUpperCase();
      const role = interaction.options.getString("role");
      const m    = getMember(uid);
      if (!m) return interaction.editReply("❌ UID not found in database.");
      updateRole(uid, role);
      pushCommand(`setrole_${uid}_${Date.now()}`, "update_member", uid, m.name, role);
      await interaction.editReply(`✅ **${m.name}** role changed to **${roleLabel(role)}**`);
    }

    // /rename
    else if (cmd === "rename") {
      const uid  = interaction.options.getString("uid").toUpperCase();
      const name = interaction.options.getString("name").trim();
      const m    = getMember(uid);
      if (!m) return interaction.editReply("❌ UID not found in database.");
      upsertMember(uid, name, m.role, interaction.user.tag);
      pushCommand(`rename_${uid}_${Date.now()}`, "update_member", uid, name, m.role);
      await interaction.editReply(`✅ Renamed to **${name}** (\`${uid}\`)`);
    }

    // /list
    else if (cmd === "list") {
      const list = getApprovedMembers();
      if (!list.length) return interaction.editReply("No approved members yet.");
      const lines = list.map(m =>
        `\`${m.uid}\` **${m.name}** — ${roleLabel(m.role)}${isGrantedToday(m.uid) ? " 🌞" : ""}`
      ).join("\n");
      const embed = new EmbedBuilder().setTitle("📋 Approved Members").setDescription(lines).setColor(0x0099ff);
      await interaction.editReply({ embeds: [embed] });
    }

    // /pending
    else if (cmd === "pending") {
      const list = getPendingMembers();
      if (!list.length) return interaction.editReply("No pending cards.");
      const lines = list.map(m => `\`${m.uid}\` **${m.name || "?"}** — pending since <t:${m.added_at}:R>`).join("\n");
      const embed = new EmbedBuilder().setTitle("⏳ Pending Cards").setDescription(lines).setColor(0xffa500);
      await interaction.editReply({ embeds: [embed] });
    }

    // /log
    else if (cmd === "log") {
      const n    = Math.min(interaction.options.getInteger("count") || 10, 25);
      const logs = getRecentLog(n);
      if (!logs.length) return interaction.editReply("No logs yet.");
      const lines = logs.map(l => {
        const icon = l.result.startsWith("GRANTED") ? "✅" : l.result === "BANNED" ? "🚫" : "❌";
        return `${icon} <t:${l.scanned_at}:t> **${l.name}** (\`${l.uid}\`) — ${l.result}`;
      }).join("\n");
      const embed = new EmbedBuilder().setTitle(`📜 Last ${n} Scans`).setDescription(lines).setColor(0x888888);
      await interaction.editReply({ embeds: [embed] });
    }

    // /report
    else if (cmd === "report") {
      const stats = getStats();
      const embed = new EmbedBuilder()
        .setTitle("📊 Access Report")
        .setColor(0x0099ff)
        .addFields(
          { name: "Total scans",  value: String(stats.total      ?? 0), inline: true },
          { name: "Granted",      value: String(stats.granted    ?? 0), inline: true },
          { name: "Denied",       value: String(stats.denied     ?? 0), inline: true },
          { name: "Banned scans", value: String(stats.banned     ?? 0), inline: true },
          { name: "Unknown",      value: String(stats.unknown    ?? 0), inline: true },
          { name: "Day grants",   value: String(stats.day_grants ?? 0), inline: true },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // /status
    else if (cmd === "status") {
      pushCommand(`status_${Date.now()}`, "get_status");
      await interaction.editReply("📡 Status request sent to ESP32 — response will appear in the notify channel shortly.");
    }

    // /help
    else if (cmd === "help") {
      const embed = new EmbedBuilder()
        .setTitle("📖 RFID Access Bot — Commands")
        .setColor(0x0099ff)
        .setDescription(
          "**Setup**\n" +
          "`/setchannel` — Set notification channel for this server\n\n" +
          "**Members**\n" +
          "`/add <uid> <name> <role>` — Add new member\n" +
          "`/ban <uid> [reason]` — Ban permanently\n" +
          "`/unban <uid>` — Unban, restore to Leader\n" +
          "`/setrole <uid> <role>` — Change role\n" +
          "`/rename <uid> <name>` — Rename member\n\n" +
          "**Access**\n" +
          "`/grant_day <uid>` — Grant full-day access (resets midnight)\n" +
          "`/revoke_day <uid>` — Remove day grant\n" +
          "`/open_door` — Open door now (60s window)\n\n" +
          "**Info**\n" +
          "`/list` — All approved members\n" +
          "`/pending` — Unknown/pending cards\n" +
          "`/log [count]` — Recent scans\n" +
          "`/report` — Stats summary\n" +
          "`/status` — ESP32 hardware vitals\n\n" +
          "**Roles**\n" +
          "🟣 President — 24/7 | 🔵 Exclusive Board — 24/7\n" +
          "🟢 Leader — 10:00–16:00 | 🟡 Member — 10:00–16:00\n\n" +
          "**Buttons (on unknown scan)**\n" +
          "Grant 1 Day · Access Once · Add Member · Deny · Ban"
        );
      await interaction.editReply({ embeds: [embed] });
    }
  }

  // ── Button interactions ────────────────────────────────────────────────────
  else if (interaction.isButton()) {
    const colonIdx = interaction.customId.indexOf(":");
    const action   = interaction.customId.slice(0, colonIdx);
    const uid      = interaction.customId.slice(colonIdx + 1);

    // grant_day ───────────────────────────────────────────────────────────────
    if (action === "grant_day") {
      await interaction.deferUpdate();
      const m = getMember(uid) || {};
      grantDay(uid);
      pushCommand(`grant_day_${uid}_${Date.now()}`, "grant_day", uid, m.name || uid, m.role || "Member");
      logScan(uid, m.name || uid, "GRANTED_LEADER_DAY");
      await interaction.message.edit({ components: actionRows(uid, ACCESS_TAKEN_DISABLE) });
      const ch = await getNotifyChannel();
      if (ch) await ch.send({ embeds: [accessEmbed(uid, m.name || uid, m.role, "GRANTED_LEADER_DAY")] }).catch(console.error);
    }

    // access_once ─────────────────────────────────────────────────────────────
    else if (action === "access_once") {
      await interaction.deferUpdate();
      const m = getMember(uid) || {};
      pushCommand(`access_once_${uid}_${Date.now()}`, "open_door", uid, m.name || uid, m.role || "?");
      logScan(uid, m.name || uid, "GRANTED_ONCE");
      await interaction.message.edit({ components: actionRows(uid, ACCESS_TAKEN_DISABLE) });
      const ch = await getNotifyChannel();
      if (ch) await ch.send({ embeds: [accessEmbed(uid, m.name || uid, m.role, "GRANTED_ONCE")] }).catch(console.error);
    }

    // add_member — show modal (does NOT disable other buttons) ────────────────
    else if (action === "add_member") {
      const modal = new ModalBuilder().setCustomId(`modal_add:${uid}`).setTitle("Add Member");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("name").setLabel("Full Name").setStyle(TextInputStyle.Short)
            .setRequired(true).setPlaceholder("e.g. Amira Bensalem")
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("role").setLabel("Role").setStyle(TextInputStyle.Short)
            .setRequired(true).setPlaceholder("President / ExclusiveBoard / Leader / Member")
        ),
      );
      await interaction.showModal(modal);
    }

    // deny ────────────────────────────────────────────────────────────────────
    else if (action === "deny") {
      await interaction.deferUpdate();
      const m = getMember(uid) || {};
      pushCommand(`deny_${uid}_${Date.now()}`, "deny", uid, m.name || uid, m.role || "?");
      logScan(uid, m.name || uid, "DENIED_MANUAL");
      await interaction.message.edit({ components: actionRows(uid, ACCESS_TAKEN_DISABLE) });
      const ch = await getNotifyChannel();
      if (ch) await ch.send({ embeds: [accessEmbed(uid, m.name || uid, m.role, "DENIED_MANUAL")] }).catch(console.error);
    }

    // ban ─────────────────────────────────────────────────────────────────────
    else if (action === "ban") {
      await interaction.deferUpdate();
      const m = getMember(uid) || {};
      upsertMember(uid, m.name || uid, "banned", "bot");
      pushCommand(`ban_${uid}_${Date.now()}`, "ban", uid, m.name || uid, "banned");
      logScan(uid, m.name || uid, "BANNED");
      // Disable ALL action buttons
      await interaction.message.edit({ components: actionRows(uid, ["grant_day", "access_once", "add_member", "deny", "ban"]) });
      const ch = await getNotifyChannel();
      if (ch) await ch.send({ embeds: [accessEmbed(uid, m.name || uid, "banned", "BANNED")] }).catch(console.error);
    }
  }

  // ── Modal submissions ──────────────────────────────────────────────────────
  else if (interaction.isModalSubmit()) {
    const colonIdx = interaction.customId.indexOf(":");
    const modalType = interaction.customId.slice(0, colonIdx);
    const uid       = interaction.customId.slice(colonIdx + 1);

    if (modalType === "modal_add") {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const name    = interaction.fields.getTextInputValue("name").trim();
      const roleRaw = interaction.fields.getTextInputValue("role").trim();
      const roleMap = {
        president:      "President",
        exclusiveboard: "ExclusiveBoard",
        "exclusive board": "ExclusiveBoard",
        leader:         "Leader",
        member:         "Member",
      };
      const role = roleMap[roleRaw.toLowerCase().replace(/\s+/g, " ").trim()] || "Member";
      upsertMember(uid, name, role, interaction.user.tag);
      pushCommand(`add_${uid}_${Date.now()}`, "add_member", uid, name, role);
      logScan(uid, name, `ADDED_${role.toUpperCase()}`);
      await interaction.editReply(
        `✅ Added **${name}** as **${roleLabel(role)}** (UID: \`${uid}\`)\n` +
        `Other buttons (Grant Day / Access Once / Deny / Ban) are still active.`
      );
    }
  }
});

// ─── startBot — called by server.js ──────────────────────────────────────────
async function startBot() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("[Bot] Slash commands registered");
  } catch (e) {
    console.error("[Bot] Command registration failed:", e.message);
  }
  await client.login(TOKEN);
}

client.once("ready", () => console.log(`[Bot] Ready as ${client.user.tag}`));

module.exports = { startBot, notifyDiscord };
