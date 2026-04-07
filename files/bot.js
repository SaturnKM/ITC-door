// ============================================================
// BOT.JS — Discord.js v14 Bot
// Handles: slash commands, button interactions, notifications
// Guild ID: 800009861982191617
// ============================================================
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require("discord.js");

const {
  getMember,
  getAllMembers,
  getApprovedMembers,
  getPendingMembers,
  upsertMember,
  updateRole,
  logScan,
  getRecentLog,
  getStats,
  grantDay,
  isGrantedToday,
  pushCommand,
} = require("./database");

// ── Config ───────────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN;
const GUILD_ID   = "800009861982191617";
const CHANNEL_ID = process.env.CHANNEL_ID; // Set this after you create the channel

if (!BOT_TOKEN) {
  console.error("[Bot] ERROR: BOT_TOKEN not set in .env");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

let notifyChannel = null;

// ════════════════════════════════════════════════════════════
// SLASH COMMANDS DEFINITION
// ════════════════════════════════════════════════════════════
const commands = [
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Add a new member to the access list")
    .addStringOption((o) =>
      o.setName("uid").setDescription("Card UID (10 digits)").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("name").setDescription("Full name").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("role")
        .setDescription("Role to assign")
        .setRequired(true)
        .addChoices(
          { name: "Leader",         value: "Leader"         },
          { name: "Exclusive board", value: "Exclusive board" },
          { name: "President",      value: "President"      },
          { name: "Pending",        value: "pending"        }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a card by UID")
    .addStringOption((o) =>
      o.setName("uid").setDescription("Card UID").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Restore a banned card to Leader role")
    .addStringOption((o) =>
      o.setName("uid").setDescription("Card UID").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("grant_day")
    .setDescription("Give a Leader full-day access (resets at midnight)")
    .addStringOption((o) =>
      o.setName("uid").setDescription("Card UID").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("setrole")
    .setDescription("Change the role of an existing member")
    .addStringOption((o) =>
      o.setName("uid").setDescription("Card UID").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("role")
        .setDescription("New role")
        .setRequired(true)
        .addChoices(
          { name: "Leader",         value: "Leader"         },
          { name: "Exclusive board", value: "Exclusive board" },
          { name: "President",      value: "President"      },
          { name: "Pending",        value: "pending"        },
          { name: "Banned",         value: "banned"         }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("list")
    .setDescription("Show the approved member list")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("pending")
    .setDescription("Show all pending (unapproved) cards")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("log")
    .setDescription("Show recent scan log")
    .addIntegerOption((o) =>
      o.setName("count").setDescription("Number of entries (default 10)").setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("report")
    .setDescription("Show full access statistics report")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Request live ESP32 device status")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("setchannel")
    .setDescription("Set this channel as the RFID notification channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

// ════════════════════════════════════════════════════════════
// REGISTER SLASH COMMANDS
// ════════════════════════════════════════════════════════════
const registerCommands = async () => {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  try {
    console.log("[Bot] Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log("[Bot] Slash commands registered OK");
  } catch (err) {
    console.error("[Bot] Command registration failed:", err.message);
  }
};

// ════════════════════════════════════════════════════════════
// HELPERS — Embeds & formatting
// ════════════════════════════════════════════════════════════

const roleEmoji = (role) => {
  switch (role) {
    case "President":      return "👑";
    case "Exclusive board": return "⭐";
    case "Leader":         return "🔑";
    case "banned":         return "🚫";
    case "pending":        return "⏳";
    default:               return "❓";
  }
};

const resultColor = (result) => {
  if (result.startsWith("GRANTED")) return 0x00c853; // green
  if (result === "BANNED")           return 0xd50000; // red
  if (result === "NOT_IN_LIST")      return 0xff6d00; // orange
  return 0xffab00;                                   // yellow
};

const resultLabel = (result) => {
  const map = {
    GRANTED_LEADER:       "✅ Access Granted (Leader)",
    GRANTED_LEADER_DAY:   "✅ Access Granted (Full Day)",
    GRANTED_BOARD:        "✅ Access Granted (Exclusive Board)",
    GRANTED_PRESIDENT:    "✅ Access Granted (President 👑)",
    DENIED_HOURS:         "⏰ Denied — Outside Hours",
    DENIED_PENDING:       "⏳ Denied — Awaiting Approval",
    DENIED_ROLE:          "❌ Denied — Invalid Role",
    BANNED:               "🚫 BANNED Card Attempted Entry",
    NOT_IN_LIST:          "❓ Unknown Card Scanned",
  };
  return map[result] || result;
};

const formatUID = (uid) => String(uid).padStart(10, "0");

const unknownButtons = (uid) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`grant_day_${uid}`)
      .setLabel("Grant 1 Day")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`approve_${uid}`)
      .setLabel("Approve as Leader")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ban_${uid}`)
      .setLabel("Ban Card")
      .setStyle(ButtonStyle.Danger)
  );

// ════════════════════════════════════════════════════════════
// notifyDiscord — called from server.js
// ════════════════════════════════════════════════════════════
const notifyDiscord = async (payload) => {
  if (!notifyChannel) {
    // Try to find channel from env if not cached yet
    if (CHANNEL_ID) {
      try {
        notifyChannel = await client.channels.fetch(CHANNEL_ID);
      } catch {
        // Channel not found yet — silent fail, bot logs to console
        console.warn("[Bot] Notify channel not found:", CHANNEL_ID);
        return;
      }
    } else {
      console.warn("[Bot] No CHANNEL_ID set. Use /setchannel in Discord.");
      return;
    }
  }

  const { uid, name, result, askButtons, statusData, members, pending, log, reportData } = payload;

  // ── STATUS REPLY ──────────────────────────────────────────
  if (result === "STATUS_REPLY" && statusData) {
    const embed = new EmbedBuilder()
      .setTitle("📡 ESP32 Status")
      .setColor(0x2196f3)
      .addFields(
        { name: "Uptime",      value: `${statusData.uptime_h}h ${statusData.uptime_m}m ${statusData.uptime_s}s`, inline: true },
        { name: "Free Heap",   value: `${statusData.free_heap} bytes`, inline: true },
        { name: "WiFi RSSI",   value: `${statusData.wifi_rssi} dBm`,   inline: true },
        { name: "Event Queue", value: `${statusData.queue_count}`,      inline: true },
        { name: "Day Grants",  value: `${statusData.day_grants}`,       inline: true },
        { name: "Clock Sync",  value: statusData.time_ready ? "✅ Yes" : "❌ No", inline: true }
      )
      .setTimestamp();
    return notifyChannel.send({ embeds: [embed] });
  }

  // ── LIST REPLY ────────────────────────────────────────────
  if (result === "LIST_REPLY" && members) {
    const lines = members
      .map((m) => `${roleEmoji(m.role)} **${m.name}** — \`${m.uid}\` (${m.role})`)
      .join("\n") || "_No approved members_";
    const embed = new EmbedBuilder()
      .setTitle("📋 Approved Member List")
      .setColor(0x00c853)
      .setDescription(lines)
      .setTimestamp();
    return notifyChannel.send({ embeds: [embed] });
  }

  // ── PENDING REPLY ─────────────────────────────────────────
  if (result === "PENDING_REPLY" && pending) {
    const lines = pending
      .map((m) => `⏳ **${m.name}** — \`${m.uid}\``)
      .join("\n") || "_No pending cards_";
    const embed = new EmbedBuilder()
      .setTitle("⏳ Pending Cards")
      .setColor(0xffab00)
      .setDescription(lines)
      .setTimestamp();
    return notifyChannel.send({ embeds: [embed] });
  }

  // ── LOG REPLY ─────────────────────────────────────────────
  if (result === "LOG_REPLY" && log) {
    const lines = log
      .map(
        (e) =>
          `\`${e.uid}\` **${e.name}** — ${resultLabel(e.result)}`
      )
      .join("\n") || "_No log entries_";
    const embed = new EmbedBuilder()
      .setTitle("📜 Recent Scan Log")
      .setColor(0x2196f3)
      .setDescription(lines)
      .setTimestamp();
    return notifyChannel.send({ embeds: [embed] });
  }

  // ── REPORT REPLY ──────────────────────────────────────────
  if (result === "REPORT_REPLY" && reportData) {
    const embed = new EmbedBuilder()
      .setTitle("📊 Access Report")
      .setColor(0x9c27b0)
      .addFields(
        { name: "Total Scans",  value: `${reportData.total}`,   inline: true },
        { name: "✅ Granted",   value: `${reportData.granted}`, inline: true },
        { name: "❌ Denied",    value: `${reportData.denied}`,  inline: true },
        { name: "🚫 Banned",    value: `${reportData.banned}`,  inline: true },
        { name: "❓ Unknown",   value: `${reportData.unknown}`, inline: true },
        { name: "🌞 Day Grants",value: `${reportData.day_grants}`, inline: true }
      )
      .setTimestamp();
    return notifyChannel.send({ embeds: [embed] });
  }

  // ── SCAN EVENT ────────────────────────────────────────────
  if (uid && result) {
    const embed = new EmbedBuilder()
      .setTitle(resultLabel(result))
      .setColor(resultColor(result))
      .addFields(
        { name: "Name", value: name || "Unknown", inline: true },
        { name: "UID",  value: `\`${formatUID(uid)}\``, inline: true }
      )
      .setTimestamp();

    const msgOptions = { embeds: [embed] };

    // Unknown card — add action buttons
    if (askButtons || result === "NOT_IN_LIST") {
      msgOptions.components = [unknownButtons(formatUID(uid))];
    }

    return notifyChannel.send(msgOptions);
  }
};

// ════════════════════════════════════════════════════════════
// INTERACTION HANDLER
// ════════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {

  // ── BUTTON INTERACTIONS ───────────────────────────────────
  if (interaction.isButton()) {
  await interaction.deferReply({ ephemeral: true });
  return handleButton(interaction);
  }

  // ── SLASH COMMANDS ────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  await interaction.deferReply({ ephemeral: true });

  try {
    switch (commandName) {

      // ── /setchannel ──────────────────────────────────────
      case "setchannel": {
        notifyChannel = interaction.channel;
        // Also persist to env hint in console
        console.log(`[Bot] Notify channel set: ${interaction.channelId}`);
        return interaction.editReply(
          `✅ Notifications will now be sent to <#${interaction.channelId}>.\n` +
          `Set \`CHANNEL_ID=${interaction.channelId}\` in your Railway environment variables to persist this across restarts.`
        );
      }

      // ── /add ─────────────────────────────────────────────
      case "add": {
        const uid  = formatUID(interaction.options.getString("uid").trim());
        const name = interaction.options.getString("name").trim();
        const role = interaction.options.getString("role");

        const existing = getMember(uid);
        if (existing && existing.role !== "pending") {
          return interaction.editReply(
            `⚠️ UID \`${uid}\` already exists as **${existing.name}** (${existing.role}).`
          );
        }

        upsertMember(uid, name, role, interaction.user.tag);

        // Queue command so ESP32 updates its CSV too
        const cmdId = `add_${Date.now()}`;
        pushCommand(cmdId, "add", uid, name, role);

        return interaction.editReply(
          `✅ **${name}** added with role **${role}** (UID: \`${uid}\`)`
        );
      }

      // ── /ban ─────────────────────────────────────────────
      case "ban": {
        const uid = formatUID(interaction.options.getString("uid").trim());
        const member = getMember(uid);

        if (!member) {
          return interaction.editReply(`❌ UID \`${uid}\` not found in database.`);
        }

        updateRole(uid, "banned");
        const cmdId = `ban_${Date.now()}`;
        pushCommand(cmdId, "ban", uid, member.name);

        return interaction.editReply(
          `🚫 **${member.name}** (UID: \`${uid}\`) has been **banned**.`
        );
      }

      // ── /unban ───────────────────────────────────────────
      case "unban": {
        const uid = formatUID(interaction.options.getString("uid").trim());
        const member = getMember(uid);

        if (!member) {
          return interaction.editReply(`❌ UID \`${uid}\` not found in database.`);
        }

        updateRole(uid, "Leader");
        const cmdId = `unban_${Date.now()}`;
        pushCommand(cmdId, "unban", uid, member.name);

        return interaction.editReply(
          `✅ **${member.name}** (UID: \`${uid}\`) has been **unbanned** and restored to Leader.`
        );
      }

      // ── /grant_day ───────────────────────────────────────
      case "grant_day": {
        const uid = formatUID(interaction.options.getString("uid").trim());
        const member = getMember(uid);

        if (!member) {
          return interaction.editReply(`❌ UID \`${uid}\` not found in database.`);
        }
        if (member.role === "banned") {
          return interaction.editReply(`🚫 **${member.name}** is banned. Unban first.`);
        }

        grantDay(uid);
        const cmdId = `grantday_${Date.now()}`;
        pushCommand(cmdId, "grant_day", uid, member.name);

        return interaction.editReply(
          `🌞 **${member.name}** (UID: \`${uid}\`) has been granted full-day access. Resets at midnight.`
        );
      }

      // ── /setrole ─────────────────────────────────────────
      case "setrole": {
        const uid  = formatUID(interaction.options.getString("uid").trim());
        const role = interaction.options.getString("role");
        const member = getMember(uid);

        if (!member) {
          return interaction.editReply(`❌ UID \`${uid}\` not found in database.`);
        }

        updateRole(uid, role);
        const cmdId = `setrole_${Date.now()}`;
        // Map to existing ESP32 commands
        const espAction = role === "banned" ? "ban" : "unban";
        pushCommand(cmdId, espAction, uid, member.name, role);

        return interaction.editReply(
          `✅ **${member.name}** role changed to **${role}** (UID: \`${uid}\`)`
        );
      }

      // ── /list ────────────────────────────────────────────
      case "list": {
        const members = getApprovedMembers();
        if (members.length === 0) {
          return interaction.editReply("_No approved members found._");
        }

        const byRole = {};
        for (const m of members) {
          if (!byRole[m.role]) byRole[m.role] = [];
          byRole[m.role].push(m);
        }

        const embed = new EmbedBuilder()
          .setTitle("📋 Approved Members")
          .setColor(0x00c853)
          .setTimestamp();

        for (const [role, list] of Object.entries(byRole)) {
          embed.addFields({
            name: `${roleEmoji(role)} ${role} (${list.length})`,
            value: list.map((m) => `**${m.name}** — \`${m.uid}\``).join("\n"),
          });
        }

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /pending ─────────────────────────────────────────
      case "pending": {
        const pendingList = getPendingMembers();
        if (pendingList.length === 0) {
          return interaction.editReply("✅ No pending cards.");
        }

        const embed = new EmbedBuilder()
          .setTitle(`⏳ Pending Cards (${pendingList.length})`)
          .setColor(0xffab00)
          .setTimestamp();

        const rows = [];
        for (const m of pendingList) {
          rows.push(`**${m.name}** — \`${m.uid}\``);
          // Add action buttons for each pending card
          rows.push(
            `> Use \`/grant_day uid:${m.uid}\` · \`/add\` to approve · \`/ban uid:${m.uid}\` to ban`
          );
        }
        embed.setDescription(rows.join("\n"));

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /log ─────────────────────────────────────────────
      case "log": {
        const count = interaction.options.getInteger("count") || 10;
        const entries = getRecentLog(Math.min(count, 30));

        if (entries.length === 0) {
          return interaction.editReply("_No scan log entries yet._");
        }

        const lines = entries.map((e) => {
          const ts = new Date(e.scanned_at * 1000).toLocaleTimeString("fr-DZ", {
            hour: "2-digit", minute: "2-digit", second: "2-digit"
          });
          return `\`${ts}\` \`${e.uid}\` **${e.name}** — ${resultLabel(e.result)}`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`📜 Last ${entries.length} Scans`)
          .setColor(0x2196f3)
          .setDescription(lines.join("\n"))
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /report ──────────────────────────────────────────
      case "report": {
        const stats = getStats();
        const total = stats.total || 0;
        const grantPct = total ? ((stats.granted / total) * 100).toFixed(1) : "0.0";

        const embed = new EmbedBuilder()
          .setTitle("📊 Access Control Report")
          .setColor(0x9c27b0)
          .addFields(
            { name: "Total Scans",  value: `${total}`,          inline: true },
            { name: "✅ Granted",   value: `${stats.granted || 0} (${grantPct}%)`, inline: true },
            { name: "❌ Denied",    value: `${stats.denied  || 0}`, inline: true },
            { name: "🚫 Banned",    value: `${stats.banned  || 0}`, inline: true },
            { name: "❓ Unknown",   value: `${stats.unknown || 0}`, inline: true }
          )
          .setTimestamp();

        // Also queue get_report so ESP32 sends its own stats
        const cmdId = `rpt_${Date.now()}`;
        pushCommand(cmdId, "get_report");

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /status ──────────────────────────────────────────
      case "status": {
        const cmdId = `status_${Date.now()}`;
        pushCommand(cmdId, "get_status");
        return interaction.editReply(
          "📡 Status request sent to ESP32. Response will appear in the notification channel within ~5 seconds."
        );
      }

      default:
        return interaction.editReply("Unknown command.");
    }

  } catch (err) {
    console.error(`[Bot] Command error (${commandName}):`, err);
    return interaction.editReply("❌ An error occurred. Check server logs.");
  }
});

// ════════════════════════════════════════════════════════════
// BUTTON HANDLER (extracted for clarity)
// ════════════════════════════════════════════════════════════
async function handleButton(interaction) {
  const id = interaction.customId;

  // grant_day_<uid>
  if (id.startsWith("grant_day_")) {
    const uid = id.replace("grant_day_", "");
    grantDay(uid);
    const cmdId = `grantday_${Date.now()}`;
    pushCommand(cmdId, "grant_day", uid);

    await interaction.editReply(`🌞 Full-day access granted for UID \`${uid}\`.`);

    // Update the original message buttons to disabled
    try {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`grant_day_${uid}`).setLabel("✅ Day Granted").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId(`approve_${uid}`).setLabel("Approve as Leader").setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId(`ban_${uid}`).setLabel("Ban Card").setStyle(ButtonStyle.Danger).setDisabled(true)
      );
      await interaction.message.edit({ components: [row] });
    } catch {}

  // approve_<uid>
  } else if (id.startsWith("approve_")) {
    const uid = id.replace("approve_", "");
    upsertMember(uid, "Unknown", "Leader", interaction.user.tag);
    const cmdId = `approve_${Date.now()}`;
    pushCommand(cmdId, "add", uid, "Unknown", "Leader");

    await interaction.editReply(`✅ UID \`${uid}\` approved as **Leader**. Use \`/setrole\` to rename them.`);

    try {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`grant_day_${uid}`).setLabel("Grant 1 Day").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId(`approve_${uid}`).setLabel("✅ Approved").setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId(`ban_${uid}`).setLabel("Ban Card").setStyle(ButtonStyle.Danger).setDisabled(true)
      );
      await interaction.message.edit({ components: [row] });
    } catch {}

  // ban_<uid>
  } else if (id.startsWith("ban_")) {
    const uid = id.replace("ban_", "");
    upsertMember(uid, "Unknown", "banned", interaction.user.tag);
    updateRole(uid, "banned");
    const cmdId = `ban_${Date.now()}`;
    pushCommand(cmdId, "ban", uid);

    await interaction.editReply(`🚫 UID \`${uid}\` has been **banned**.`);

    try {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`grant_day_${uid}`).setLabel("Grant 1 Day").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId(`approve_${uid}`).setLabel("Approve as Leader").setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId(`ban_${uid}`).setLabel("🚫 Banned").setStyle(ButtonStyle.Danger).setDisabled(true)
      );
      await interaction.message.edit({ components: [row] });
    } catch {}

  } else {
    await interaction.editReply("Unknown button action.");
  }
}

// ════════════════════════════════════════════════════════════
// BOT READY
// ════════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  await registerCommands();

  // Cache the notify channel if CHANNEL_ID is set
  if (CHANNEL_ID) {
    try {
      notifyChannel = await client.channels.fetch(CHANNEL_ID);
      console.log(`[Bot] Notify channel loaded: #${notifyChannel.name}`);
    } catch (e) {
      console.warn("[Bot] Could not load CHANNEL_ID:", e.message);
    }
  } else {
    console.warn("[Bot] CHANNEL_ID not set. Use /setchannel in Discord to configure.");
  }
});

// ════════════════════════════════════════════════════════════
// START BOT
// ════════════════════════════════════════════════════════════
const startBot = async () => {
  await client.login(BOT_TOKEN);
};

module.exports = { startBot, notifyDiscord };
