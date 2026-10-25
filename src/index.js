require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const { PrismaClient } = require('@prisma/client');
const { createClient } = require('redis');
const { AI } = require('./systems/ai/dualAI');
const { Moderation } = require('./systems/moderation/engine');
const { handleInteraction } = require('./commands');
const { attachmentIdentity } = require('./systems/inspection/scanner');
const { getConfig } = require('./config');
async function cleanup(db) {
  const guilds = await db.guildSettings.findMany({ select: { id: true } });
  // Cases can exist before a guild saves settings.
  const caseGuilds = await db.moderationCase.findMany({ distinct: ['guildId'], select: { guildId: true } });
  const exampleGuilds = await db.learningExample.findMany({ distinct: ['guildId'], select: { guildId: true } });
  const feedbackGuilds = await db.staffFeedback.findMany({ distinct: ['guildId'], select: { guildId: true } });
  for (const id of new Set([...guilds.map(g => g.id), ...caseGuilds.map(g => g.guildId), ...exampleGuilds.map(g => g.guildId), ...feedbackGuilds.map(g => g.guildId)])) {
    const config = await getConfig(db, id);
    const cutoff = new Date(Date.now() - config.retentionDays * 86400000);
    await db.moderationCase.deleteMany({ where: { guildId: id, createdAt: { lt: cutoff } } });
    await db.staffFeedback.deleteMany({ where: { guildId: id, createdAt: { lt: cutoff } } });
    await db.learningExample.deleteMany({ where: { guildId: id, updatedAt: { lt: cutoff } } });
  }
  await db.dailyUsage.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 86400000) } } });
}
async function main() {
  for (const name of ['DISCORD_TOKEN', 'DATABASE_URL']) if (!process.env[name]) throw new Error(`Missing ${name}`);
  const db = new PrismaClient();
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379', disableOfflineQueue: true, socket: { connectTimeout: 5000 } });
  redis.on('error', error => console.error('Redis error:', error.code || error.name));
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Message, Partials.Channel], allowedMentions: { parse: [], repliedUser: false } });
  const ai = new AI({ db, redis });
  const moderation = new Moderation({ db, redis, ai, client });
  let timer;
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    client.destroy();
    await db.$disconnect();
    if (redis.isOpen) await redis.disconnect();
  }
  process.once('SIGINT', () => shutdown().catch(console.error));
  process.once('SIGTERM', () => shutdown().catch(console.error));
  client.once('ready', () => {
    console.log(`Sentinel ready as ${client.user.tag}`);
    client.user.setActivity('/help • keeping the chaos tasteful', { type: ActivityType.Watching });
  });
  // Do not queue spam checks behind slow model requests. Redis counters are atomic,
  // AI concurrency is independently bounded, and case claims prevent duplicate actions.
  let pending = 0;
  function enqueue(message, edited) {
    if (stopping || !message.guildId || !message.author || message.author.bot || message.webhookId) return;
    if (pending >= 500) { console.warn('Moderation overloaded: event dropped'); return; }
    pending++;
    moderation.process(message, { edited }).catch(error => console.error('Message processing failed:', error.code || error.name)).finally(() => { pending--; });
  }
  client.on('messageCreate', message => enqueue(message, false));
  client.on('messageUpdate', async (previous, current) => {
    try { const message = current.partial ? await current.fetch() : current; if (previous.content !== message.content || JSON.stringify(attachmentIdentity(previous)) !== JSON.stringify(attachmentIdentity(message))) enqueue(message, true); } catch (error) { console.warn('Edited message unavailable:', error.code || error.name); }
  });
  client.on('interactionCreate', interaction => handleInteraction(interaction, { db, redis, moderation, ai }).catch(error => console.error('Interaction failed:', error.code || error.name)));
  client.on('error', error => console.error('Discord error:', error.code || error.name));
  try {
    await db.$connect();
    await db.guildSettings.count(); // Fail startup if schema preparation was missed.
    await redis.connect();
    await cleanup(db);
    let cleaning = false;
    timer = setInterval(async () => {
      if (cleaning) return;
      cleaning = true;
      try { await cleanup(db); } catch (error) { console.error('Retention cleanup failed:', error.code || error.name); } finally { cleaning = false; }
    }, 3600000);
    timer.unref();
    await client.login(process.env.DISCORD_TOKEN);
    return { client, db, redis, shutdown };
  } catch (error) { await shutdown(); throw error; }
}
if (require.main === module) main().catch(error => { console.error('Startup failed:', error.code || error.message); process.exitCode = 1; });
module.exports = { main, cleanup };
