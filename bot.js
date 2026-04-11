// ============================================================
// BOT.JS — Discord.js v14 Bot
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
  saveChannelId,
  getChannelId,
} = require("./database");

// ── Config ───────────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

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
          { name: "Leader",          value: "Leader"          },
          { name: "Exclusive board", value: "Exclusive board" },
          { name: "President",       value: "President"       },
          { name: "Member",          value: "Member"          }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Permanently ban a card by UID")
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
    .setDescription("Give a member full-day access (resets at midnight)")
    .addStringOption((o) =>
      o.setName("uid").setDescription("Card UID").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("open_door")
    .setDescription("Remotely open the door right now (no card needed)")
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
          { name: "Leader",          value: "Leader"          },
          { name: "Exclusive board", value: "Exclusive board" },
          { name: "President",       value: "President"       },
          { name: "Member",          value: "Member"          },
          { name: "Banned",          value: "banned"          }
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
    console.log("[Bot] Registering global slash commands...");
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log("[Bot] Global slash commands registered OK");
  } catch (err) {
    console.error("[Bot] Command registration failed:", err.message);
  }
};

// ════════════════════════════════════════════════════════════
// HELPERS — Embeds & formatting
// ════════════════════════════════════════════════════════════
const roleEmoji = (role) => {
  switch (role) {
    case "President":       return "👑";
    case "Exclusive board": return "⭐";
    case "Leader":          return "🔑";
    case "banned":          return "🚫";
    case "pending":         return "⏳";
    case "Member":          return "👤";
    default:                return "❓";
  }
};

const resultColor = (result) => {
  if (result.startsWith("GRANTED"))    return 0x00c853;
  if (result === "BANNED")             return 0xd50000;
  if (result === "NOT_IN_LIST")        return 0xff6d00;
  if (result === "DENIED_BLOCKED_DAY") return 0xff6d00;
  return 0xffab00;
};

const resultLabel = (result) => {
  const map = {
    GRANTED_LEADER:      "✅ Access Granted (Leader)",
    GRANTED_LEADER_DAY:  "✅ Access Granted (Full Day)",
    GRANTED_BOARD:       "✅ Access Granted (Exclusive Board)",
    GRANTED_PRESIDENT:   "✅ Access Granted (President 👑)",
    GRANTED_ONCE:        "✅ Access Granted (Once — Unknown Card)",
    GRANTED_REMOTE:      "🔓 Door Opened Remotely (Bot Command)",
    DENIED_HOURS:        "⏰ Denied — Outside Hours",
    DENIED_PENDING:      "⏳ Denied — Awaiting Approval",
    DENIED_ROLE:         "❌ Denied — Invalid Role",
    DENIED_BLOCKED_DAY:  "🚫 Denied — Blocked for Today",
    BANNED:              "🚫 BANNED Card Attempted Entry",
    NOT_IN_LIST:         "❓ Unknown Card Scanned",
  };
  return map[result] || result;
};

const formatUID = (uid) => String(uid).padStart(10, "0");

// ════════════════════════════════════════════════════════════
// BUTTONS FOR UNKNOWN CARDS
// ════════════════════════════════════════════════════════════
const unknownButtons = (uid) => {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`grant_once_${uid}`)
      .setLabel("Grant Once")
      .setEmoji("🟢")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`grant_day_${uid}`)
      .setLabel("Grant 1 Day")
      .setEmoji("🟡")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`block_day_${uid}`)
      .setLabel("Block Today")
      .setEmoji("⚫")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`add_member_${uid}`)
      .setLabel("Add Member")
      .setEmoji("👤")
      .setStyle(ButtonStyle.Secondary)
  );
};

const disabledButtons = (uid, activeLabel, activeStyle) => {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`disabled1_${uid}`)
      .setLabel("Grant Once")
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`disabled2_${uid}`)
      .setLabel("Grant 1 Day")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`disabled3_${uid}`)
      .setLabel("Block Today")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`disabled4_${uid}`)
      .setLabel(activeLabel)
      .setStyle(activeStyle)
      .setDisabled(true)
  );
};

// ════════════════════════════════════════════════════════════
// BUTTON HANDLER
// ════════════════════════════════════════════════════════════
async function handleButton(interaction) {
  const id           = interaction.customId;
  const uid          = id.split("_").pop();
  const formattedUid = formatUID(uid);

  try {
    if (id.startsWith("grant_once_")) {
      pushCommand(`once_${Date.now()}`, "grant_once", formattedUid, "", "", 0);
      await interaction.editReply(`🟢 **Once Granted** for UID: \`${formattedUid}\`. Door will open on next scan.`);
      await interaction.message.edit({ components: [disabledButtons(formattedUid, "🟢 Granted", ButtonStyle.Success)] }).catch(() => {});

    } else if (id.startsWith("grant_day_")) {
      grantDay(formattedUid);
      pushCommand(`day_${Date.now()}`, "grant_day", formattedUid, "", "", 0);
      await interaction.editReply(`🟡 **Day Granted** for UID: \`${formattedUid}\`. Valid until midnight.`);
      await interaction.message.edit({ components: [disabledButtons(formattedUid, "🟡 Day Granted", ButtonStyle.Primary)] }).catch(() => {});

    } else if (id.startsWith("block_day_")) {
      pushCommand(`block_${Date.now()}`, "block_day", formattedUid, "", "", 0);
      await interaction.editReply(`⚫ **Blocked for Today** for UID: \`${formattedUid}\`.`);
      await interaction.message.edit({ components: [disabledButtons(formattedUid, "⚫ Blocked", ButtonStyle.Danger)] }).catch(() => {});

    } else if (id.startsWith("add_member_")) {
      upsertMember(formattedUid, "New Member", "Member", interaction.user.tag);
      pushCommand(`add_${Date.now()}`, "add", formattedUid, "New Member", "Member", 0);
      await interaction.editReply(`👤 UID \`${formattedUid}\` added as a **Member**. They can now scan for access.`);
      await interaction.message.edit({ components: [disabledButtons(formattedUid, "👤 Member Added", ButtonStyle.Secondary)] }).catch(() => {});
    }
  } catch (error) {
    console.error("[Button Handler Error]", error);
    await interaction.editReply("❌ An error occurred processing the button.").catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════
// notifyDiscord — called from server.js
// ════════════════════════════════════════════════════════════
const notifyDiscord = async (payload) => {
  if (!notifyChannel) {
    if (CHANNEL_ID) {
      try {
        notifyChannel = await client.channels.fetch(CHANNEL_ID);
      } catch {
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
      .map((e) => `\`${e.uid}\` **${e.name}** — ${resultLabel(e.result)}`)
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
        { name: "Total Scans",   value: `${reportData.total}`,      inline: true },
        { name: "✅ Granted",    value: `${reportData.granted}`,    inline: true },
        { name: "❌ Denied",     value: `${reportData.denied}`,     inline: true },
        { name: "🚫 Banned",     value: `${reportData.banned}`,     inline: true },
        { name: "❓ Unknown",    value: `${reportData.unknown}`,    inline: true },
        { name: "🌞 Day Grants", value: `${reportData.day_grants}`, inline: true }
      )
      .setTimestamp();
    return notifyChannel.send({ embeds: [embed] });
  }

  // ── SCAN EVENT ────────────────────────────────────────────
  if (uid && result) {
    logScan(uid, name || "Unknown", result);

    const embed = new EmbedBuilder()
      .setTitle(resultLabel(result))
      .setColor(resultColor(result))
      .addFields(
        { name: "Name", value: name || "Unknown",          inline: true },
        { name: "UID",  value: `\`${formatUID(uid)}\``,   inline: true }
      )
      .setTimestamp();

    const msgOptions = { embeds: [embed] };

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
    await interaction.deferReply({ ephemeral: false });
    return handleButton(interaction);
  }

  // ── SLASH COMMANDS ────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  await interaction.deferReply({ ephemeral: false });

  try {
    switch (commandName) {

      case "setchannel": {
        notifyChannel = interaction.channel;
        saveChannelId(interaction.channelId);
        console.log(`[Bot] Notify channel set and saved: ${interaction.channelId}`);
        return interaction.editReply(
          `✅ Notifications will now be sent to <#${interaction.channelId}>.\n` +
          `This channel has been saved and will persist across restarts.`
        );
      }

      case "add": {
        const uid  = formatUID(interaction.options.getString("uid").trim());
        const name = interaction.options.getString("name").trim();
        const role = interaction.options.getString("role");

        upsertMember(uid, name, role, interaction.user.tag);
        pushCommand(`add_${Date.now()}`, "add", uid, name, role, 0);

        return interaction.editReply(
          `✅ **${name}** added as **${role}** (UID: \`${uid}\`)`
        );
      }

      case "ban": {
        const uid    = formatUID(interaction.options.getString("uid").trim());
        const member = getMember(uid);
        if (!member) return interaction.editReply(`❌ UID \`${uid}\` not found.`);

        updateRole(uid, "banned");
        pushCommand(`ban_${Date.now()}`, "ban", uid, member.name, "banned", 0);

        return interaction.editReply(`🚫 **${member.name}** has been banned (UID: \`${uid}\`).`);
      }

      case "unban": {
        const uid    = formatUID(interaction.options.getString("uid").trim());
        const member = getMember(uid);
        if (!member) return interaction.editReply(`❌ UID \`${uid}\` not found.`);

        updateRole(uid, "Leader");
        pushCommand(`unban_${Date.now()}`, "unban", uid, member.name, "Leader", 0);

        return interaction.editReply(`✅ **${member.name}** unbanned and restored to **Leader**.`);
      }

      case "grant_day": {
        const uid    = formatUID(interaction.options.getString("uid").trim());
        const member = getMember(uid);
        if (!member) return interaction.editReply(`❌ UID \`${uid}\` not found in database.`);
        if (member.role === "banned") return interaction.editReply(`🚫 **${member.name}** is banned. Unban first.`);

        grantDay(uid);
        logScan(uid, member.name, "GRANTED_LEADER_DAY");
        pushCommand(`grantday_${Date.now()}`, "grant_day", uid, member.name, "", 0);

        return interaction.editReply(
          `🌞 **${member.name}** (UID: \`${uid}\`) granted full-day access. Resets at midnight.`
        );
      }

      case "open_door": {
        pushCommand(`opendoor_${Date.now()}`, "open_door", "", "Remote", "", 0);
        logScan("0000000000", `Remote (${interaction.user.tag})`, "GRANTED_REMOTE");

        return interaction.editReply(
          `🔓 **${interaction.user.tag}** opened the door remotely. Command sent to ESP32.`
        );
      }

      case "setrole": {
        const uid    = formatUID(interaction.options.getString("uid").trim());
        const role   = interaction.options.getString("role");
        const member = getMember(uid);
        if (!member) return interaction.editReply(`❌ UID \`${uid}\` not found in database.`);

        updateRole(uid, role);
        const espAction = role === "banned" ? "ban" : "setrole";
        pushCommand(`setrole_${Date.now()}`, espAction, uid, member.name, role, 0);

        return interaction.editReply(
          `✅ **${member.name}** role changed to **${role}** (UID: \`${uid}\`)`
        );
      }

      case "list": {
        const members = getApprovedMembers();
        if (!members.length) return interaction.editReply("_No approved members found._");

        await notifyDiscord({ result: "LIST_REPLY", members });
        return interaction.editReply("📋 Member list sent.");
      }

      case "pending": {
        const pending = getPendingMembers();
        if (!pending.length) return interaction.editReply("_No pending cards._");

        await notifyDiscord({ result: "PENDING_REPLY", pending });
        return interaction.editReply("⏳ Pending list sent.");
      }

      case "log": {
        const count = interaction.options.getInteger("count") || 10;
        const log   = getRecentLog(count);
        if (!log.length) return interaction.editReply("_No log entries found._");

        await notifyDiscord({ result: "LOG_REPLY", log });
        return interaction.editReply(`📜 Last ${count} log entries sent.`);
      }

      case "report": {
        const reportData = getStats();
        await notifyDiscord({ result: "REPORT_REPLY", reportData });
        return interaction.editReply("📊 Report sent.");
      }

      case "status": {
        pushCommand(`status_${Date.now()}`, "status", "", "", "", 0);
        return interaction.editReply("📡 Status request sent to ESP32. Response will appear shortly.");
      }

      default:
        return interaction.editReply("❓ Unknown command.");
    }
  } catch (err) {
    console.error(`[Bot] Error handling /${commandName}:`, err);
    return interaction.editReply("❌ An error occurred. Check server logs.").catch(() => {});
  }
});

// ════════════════════════════════════════════════════════════
// CLIENT READY
// ════════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);

  // Restore saved notification channel from DB
  const savedChannelId = getChannelId();
  if (savedChannelId) {
    try {
      notifyChannel = await client.channels.fetch(savedChannelId);
      console.log(`[Bot] Restored notify channel: ${savedChannelId}`);
    } catch {
      console.warn(`[Bot] Could not restore channel ${savedChannelId}`);
    }
  }

  await registerCommands();
});

// ════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════
module.exports = { client, notifyDiscord };
