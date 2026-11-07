// ============================================================
//  index.js — Bot entry point, Discord client, event routing
// ============================================================
'use strict';

require('dotenv').config({ path: '.env' });

const {
  Client,
  GatewayIntentBits,
  Events,
} = require('discord.js');

const express    = require('express');
const { router: apiRouter, setClient, handleButtonDecision, handleModalSubmit } = require('./api');
const { handleCommand, registerCommands } = require('./commands');
const storage    = require('./storage');

// ─── VALIDATE ENV ────────────────────────────────────────────
const REQUIRED_ENV = ['DISCORD_TOKEN', 'CHANNEL_ID', 'API_KEY', 'PORT'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[BOOT] Missing env variable: ${key}`);
    process.exit(1);
  }
}

// ─── STORAGE INIT ────────────────────────────────────────────
storage.loadMembers();
storage.loadQueue();

// ─── DISCORD CLIENT ──────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

// ─── READY ───────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);

  const channel = await client.channels.fetch(process.env.CHANNEL_ID).catch(e => {
    console.error('[BOT] Cannot fetch channel:', e.message);
    return null;
  });

  if (!channel) {
    console.error('[BOT] CHANNEL_ID not found or bot lacks access. Check your .env and bot permissions.');
    process.exit(1);
  }

  console.log(`[BOT] Logging to channel: #${channel.name}`);

  setClient(client, channel);

  await registerCommands(client);

  if (storage.shouldRemindYearlyUpdate()) {
    channel.send('📅 **Yearly Reminder:** Please review and update the member database for the new year!').catch(() => {});
  }

  channel.send({
    embeds: [{
      color: 0x2ECC71,
      title: '🟢 RFID Access Control Online',
      description: `Bot started — \`${storage.getMemberCount()}\` members loaded.`,
      timestamp: new Date().toISOString(),
    }]
  }).catch(() => {});
});

// ─── INTERACTION HANDLER ─────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      return await handleCommand(interaction);
    }

    if (interaction.isButton()) {
      return await handleButtonDecision(interaction);
    }

    if (interaction.isModalSubmit()) {
      // modal_add::<request>::<uid>  (from a scan card)
      // modal_new                    (from /addmember)
      if (interaction.customId.startsWith('modal_add') || interaction.customId.startsWith('modal_new')) {
        return await handleModalSubmit(interaction);
      }
    }
  } catch (e) {
    console.error('[INTERACTION] Unhandled error:', e);
    if (e.code === 10062 || e.code === 40060) return;
    try {
      const payload = { content: '❌ Something went wrong. Please try again.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {}
  }
});

// ─── ERROR HANDLING ──────────────────────────────────────────
client.on(Events.Error, e => console.error('[DISCORD]', e.message));

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED]', reason);
});

process.on('uncaughtException', (e) => {
  console.error('[EXCEPTION]', e.message);
});

// ─── EXPRESS API SERVER ──────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

app.use('/api', apiRouter);

app.get('/health', (_req, res) => res.json({
  ok:      true,
  uptime:  process.uptime(),
  members: storage.getMemberCount(),
  time:    new Date().toISOString(),
}));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error('[HTTP]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`[HTTP] API server listening on port ${PORT}`);
});

// ─── LOGIN ───────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('[BOT] Login failed:', e.message);
  process.exit(1);
});
