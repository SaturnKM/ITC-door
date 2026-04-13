// ============================================================
//  index.js — Bot entry point, Discord client, event routing
//  File 1/4  |  RFID Access Control Bot
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
const REQUIRED_ENV = ['BOT_TOKEN', 'CHANNEL_ID', 'API_KEY', 'PORT'];
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

  // Wire up API module with client + channel
  setClient(client, channel);

  // Register slash commands
  await registerCommands(client);

  // Yearly CSV reminder
  if (storage.shouldRemindYearlyUpdate()) {
    channel.send('📅 **Yearly Reminder:** Please review and update the member database for the new year!').catch(() => {});
  }

  // Boot message
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

  // Slash commands
  if (interaction.isChatInputCommand()) {
    return handleCommand(interaction);
  }

  // Button clicks (pending request decisions)
  if (interaction.isButton()) {
    return handleButtonDecision(interaction);
  }

  // Modal submit (add_member flow)
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('modal_add::')) {
      return handleModalSubmit(interaction);
    }
  }
});

// ─── ERROR HANDLING ──────────────────────────────────────────
client.on(Events.Error, e => console.error('[DISCORD]', e.message));

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED]', reason);
});

process.on('uncaughtException', (e) => {
  console.error('[EXCEPTION]', e.message);
  // Do NOT exit — keep the bot alive
});

// ─── EXPRESS API SERVER ──────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

// Mount ESP32 API routes under /api
app.use('/api', apiRouter);

// Health check (no auth required)
app.get('/health', (_req, res) => res.json({
  ok:      true,
  uptime:  process.uptime(),
  members: storage.getMemberCount(),
  time:    new Date().toISOString(),
}));

// 404 handler
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[HTTP]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`[HTTP] API server listening on port ${PORT}`);
});

// ─── LOGIN ───────────────────────────────────────────────────
client.login(process.env.BOT_TOKEN).catch(e => {
  console.error('[BOT] Login failed:', e.message);
  process.exit(1);
});
