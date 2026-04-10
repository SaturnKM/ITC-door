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
          { name: "Leader",          value: "Leader"         },
          { name: "Exclusive board", value: "Exclusive board" },
          { name: "President",       value: "President"      },
          { name: "Member", value: "Member" }
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
          { name: "Leader",          value: "Leader"         },
          { name: "Exclusive board", value: "Exclusive board"},
          { name: "President",       value: "President"      },
          { name: "Member",          value: "Member"         },
          { name: "Banned",          value: "banned"         }
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
    case "Member":           return "👤";
    default:                return "❓";
  }
};

const resultColor = (result) => {
  if (result.startsWith("GRANTED")) return 0x00c853; // green
  if (result === "BANNED")           return 0xd50000; // red
  if (result === "NOT_IN_LIST")      return 0xff6d00; // orange
  if (result === "DENIED_BLOCKED_DAY") return 0xff6d00; // orange
  return 0xffab00;                                    // yellow
};

const resultLabel = (result) => {
  const map = {
    GRANTED_LEADER:       "✅ Access Granted (Leader)",
    GRANTED_LEADER_DAY:   "✅ Access Granted (Full Day)",
    GRANTED_BOARD:        "✅ Access Granted (Exclusive Board)",
    GRANTED_PRESIDENT:    "✅ Access Granted (President 👑)",
    GRANTED_ONCE:         "✅ Access Granted (Once — Unknown Card)",
    GRANTED_REMOTE:       "🔓 Door Opened Remotely (Bot Command)",
    DENIED_HOURS:         "⏰ Denied — Outside Hours",
    DENIED_PENDING:       "⏳ Denied — Awaiting Approval",
    DENIED_ROLE:          "❌ Denied — Invalid Role",
    DENIED_BLOCKED_DAY:   "🚫 Denied — Blocked for Today",
    BANNED:               "🚫 BANNED Card Attempted Entry",
    NOT_IN_LIST:          "❓ Unknown Card Scanned",
  };
  return map[result] || result;
};

const formatUID = (uid) => String(uid).padStart(10, "0");

// ════════════════════════════════════════════════════════════
// BUTTONS FOR UNKNOWN CARDS
// 4 buttons (Discord max per row = 5, we use 4):
//   Grant Once | Grant 1 Day | Block Today | Ban Card
// "Grant Once" opens door immediately, no memory saved.
// "Grant 1 Day" saves to ESP RAM until midnight.
// "Block Today" blocks UID in ESP RAM until midnight.
// "Ban Card"    permanently bans UID in DB + ESP CSV.
// ════════════════════════════════════════════════════════════
// 🟢 Grant Once | 🟡 Grant 1 Day | ⚫ Denied | 👤 Add Member
const unknownButtons = (uid) =>
  new ActionRowBuilder().addComponents(
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
      .setLabel("Denied")
      .setEmoji("⚫")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`add_member_${uid}`)
      .setLabel("Add Member")
      .setEmoji("👤")
      .setStyle(ButtonStyle.Primary)
  );

const disabledButtons = (uid, activeLabel, activeStyle) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`btn1_${uid}`).setLabel("Grant Once").setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`btn2_${uid}`).setLabel("Grant 1 Day").setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`btn3_${uid}`).setLabel("Denied").setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`btn4_${uid}`).setLabel(activeLabel).setStyle(activeStyle).setDisabled(true)
  );

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
    // Always log every scan event to the bot DB
    logScan(uid, name || "Unknown", result);

    const embed = new EmbedBuilder()
      .setTitle(resultLabel(result))
      .setColor(resultColor(result))
      .addFields(
        { name: "Name", value: name || "Unknown", inline: true },
        { name: "UID",  value: `\`${formatUID(uid)}\``, inline: true }
      )
      .setTimestamp();

    const msgOptions = { embeds: [embed] };

    // Show buttons only for truly unknown cards asking for a decision
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

      // ── /setchannel ──────────────────────────────────────
      case "setchannel": {
        notifyChannel = interaction.channel;
        saveChannelId(interaction.channelId);
        console.log(`[Bot] Notify channel set and saved: ${interaction.channelId}`);
        return interaction.editReply(
          `✅ Notifications will now be sent to <#${interaction.channelId}>.\n` +
          `This channel has been saved and will persist across restarts.`
        );
      }

      // ── /add ─────────────────────────────────────────────
     case "add": {
        const uid  = formatUID(interaction.options.getString("uid").trim());
        const name = interaction.options.getString("name").trim();
        const role = interaction.options.getString("role"); // Use the role SELECTED in the command

        upsertMember(uid, name, role, interaction.user.tag);
        pushCommand(`add_${Date.now()}`, "add", uid, name, role); 

        return interaction.editReply(`✅ **${name}** added as **${role}**.`);
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
        if (!member) return interaction.editReply(`❌ UID \`${uid}\` not found.`);

        // Instead of forcing "Leader", we set it to 'pending' 
        // so you can use /setrole to give them the right rank.
        updateRole(uid, "pending"); 
        pushCommand(`unban_${Date.now()}`, "unban", uid, member.name);

        return interaction.editReply(`✅ **${member.name}** unbanned. Use \`/setrole\` to assign a rank.`);
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
        logScan(uid, member.name, "GRANTED_LEADER_DAY");
        const cmdId = `grantday_${Date.now()}`;
        pushCommand(cmdId, "grant_day", uid, member.name);

        return interaction.editReply(
          `🌞 **${member.name}** (UID: \`${uid}\`) granted full-day access. Resets at midnight.`
        );
      }

      // ── /open_door ───────────────────────────────────────
      case "open_door": {
        const cmdId = `opendoor_${Date.now()}`;
        // Push open_door command with no UID — ESP handles it
        pushCommand(cmdId, "open_door", "", "Remote", "");
        // Log the remote open in the bot DB immediately
        logScan("0000000000", `Remote (${interaction.user.tag})`, "GRANTED_REMOTE");

        return interaction.editReply(
          `🔓 **${interaction.user.tag}** opened the door remotely. Command sent to ESP32.`
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
        const espAction = role === "banned" ? "ban" : "add";
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
          rows.push(`**${m.name || "Unknown"}** — \`${m.uid}\``);
          rows.push(
            `> \`/grant_day uid:${m.uid}\` to give day access · \`/ban uid:${m.uid}\` to ban permanently`
          );
        }
        embed.setDescription(rows.join("\n"));

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /log ─────────────────────────────────────────────
      case "log": {
        const count = interaction.options.getInteger("count") || 10;
        const entries = getRecentLog(Math.min(count, 50));

        if (entries.length === 0) return interaction.editReply("_No scans yet._");

        const lines = entries.map((e) => {
          // resultLabel is a helper function in your bot.js that 
          // converts codes like "GRANTED_REMOTE" into "🔓 Door Opened"
          const status = resultLabel(e.result); 
          return `\`${e.uid}\` **${e.name}**: ${status}`;
        });

        const embed = new EmbedBuilder()
          .setTitle("📜 Door Access History")
          .setColor(0x2196f3)
          .setDescription(lines.join("\n"));

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
            { name: "Total Scans",     value: `${total}`,                              inline: true },
            { name: "✅ Granted",      value: `${stats.granted  || 0} (${grantPct}%)`, inline: true },
            { name: "❌ Denied",       value: `${stats.denied   || 0}`,                inline: true },
            { name: "🚫 Banned",       value: `${stats.banned   || 0}`,                inline: true },
            { name: "❓ Unknown",      value: `${stats.unknown  || 0}`,                inline: true },
            { name: "🔓 Once Grants",  value: `${stats.once     || 0}`,                inline: true },
            { name: "🌞 Day Grants",   value: `${stats.day_grants || 0}`,              inline: true },
            { name: "🔌 Remote Opens", value: `${stats.remote   || 0}`,                inline: true }
          )
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // ── /status ──────────────────────────────────────────
      case "status": {
        const cmdId = `status_${Date.now()}`;
        pushCommand(cmdId, "get_status");
        return interaction.editReply(
          "📡 Status request sent to ESP32. Response will appear here within ~5 seconds."
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
// BUTTON HANDLER
// Buttons: grant_once | grant_day | block_day | ban
// ════════════════════════════════════════════════════════════
async function handleButton(interaction) {
  const id = interaction.customId;
  const uid = id.split('_').pop();

  if (id.startsWith("grant_once_")) {
    pushCommand(`once_${Date.now()}`, "grant_once", uid);
    await interaction.editReply(`🟢 **Once Granted** for UID: \`${uid}\`.`);
    await interaction.message.edit({ components: [disabledButtons(uid, "🟢 Granted", ButtonStyle.Success)] });

  } else if (id.startsWith("grant_day_")) {
    grantDay(uid);
    pushCommand(`day_${Date.now()}`, "grant_day", uid);
    await interaction.editReply(`🟡 **Day Granted** for UID: \`${uid}\`.`);
    await interaction.message.edit({ components: [disabledButtons(uid, "🟡 Day Granted", ButtonStyle.Primary)] });

  } else if (id.startsWith("block_day_")) {
    pushCommand(`block_${Date.now()}`, "block_day", uid);
    await interaction.editReply(`⚫ **Access Denied** for UID: \`${uid}\`.`);
    await interaction.message.edit({ components: [disabledButtons(uid, "⚫ Denied", ButtonStyle.Secondary)] });

  } else if (id.startsWith("add_member_")) {
    upsertMember(uid, "New Member", "Member", interaction.user.tag);
    pushCommand(`add_${Date.now()}`, "add_member", uid); // Tells ESP32 to save locally
    await interaction.editReply(`👤 UID \`${uid}\` added as a **Member**.`);
    await interaction.message.edit({ components: [disabledButtons(uid, "👤 Member Added", ButtonStyle.Primary)] });
  }
}
// ════════════════════════════════════════════════════════════
// BOT READY
// ════════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  await registerCommands();

  const savedChannelId = getChannelId() || CHANNEL_ID;

  if (savedChannelId) {
    try {
      notifyChannel = await client.channels.fetch(savedChannelId);
      console.log(`[Bot] Notify channel loaded: #${notifyChannel.name}`);
    } catch (e) {
      console.warn("[Bot] Could not load saved channel:", e.message);
      console.warn("[Bot] Use /setchannel in any channel to configure notifications.");
    }
  } else {
    console.warn("[Bot] No channel configured. Use /setchannel in Discord to set one.");
  }
});

// ════════════════════════════════════════════════════════════
// START BOT
// ════════════════════════════════════════════════════════════
const startBot = async () => {
  await client.login(BOT_TOKEN);
};

module.exports = { startBot, notifyDiscord };