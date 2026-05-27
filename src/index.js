const { Client, GatewayIntentBits } = require('discord.js');
const { PrismaClient } = require('@prisma/client');
const redis = require('redis');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const prisma = new PrismaClient();
const redisClient = redis.createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

// Import systems
const { analyzeWithOllama, analyzeWithClaude } = require('./systems/ai/dualAI');
const { checkLocalPatterns } = require('./systems/moderation/patterns');
const { handleEscalation } = require('./systems/moderation/escalation');

(async () => {
  try {
    if (!redisClient.isOpen) await redisClient.connect();
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Database connected');
    let config = await prisma.serverConfig.findFirst();
    if (!config) config = await prisma.serverConfig.create({ data: { id: 'default' } });
    client.prisma = prisma;
    client.redis = redisClient;
    client.config = config;
    console.log('✅ Bot initialized');
  } catch (error) {
    console.error('Init error:', error);
    process.exit(1);
  }
})();

client.once('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  client.user.setActivity('your server', { type: 'WATCHING' });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  try {
    let user = await client.prisma.user.findUnique({ where: { id: message.author.id } });
    if (!user) {
      user = await client.prisma.user.create({ 
        data: { id: message.author.id, username: message.author.username } 
      });
    }

    const urls = message.content.match(/https?:\/\/[^\s]+/g) || [];
    const mentions = Array.from(message.mentions.users.keys());

    await client.prisma.messageHistory.create({
      data: {
        id: message.id,
        userId: message.author.id,
        content: message.content,
        channelId: message.channelId,
        messageId: message.id,
        guildId: message.guildId,
        containsURL: urls.length > 0,
        urls,
        mentions,
      },
    });

    // STEP 1: Check local patterns first (NO API COST)
    const localResult = checkLocalPatterns(message.content);
    if (localResult.flagged && localResult.confidence > 0.85) {
      console.log(`⚠️ Local pattern detected: ${localResult.type}`);
      await flagMessage(client, user, message, localResult.type, localResult.confidence, 'Local pattern match', true);
      if (localResult.confidence > 0.9) {
        await handleEscalation(client, user, message, 'pattern_match');
      }
      return;
    }

    // STEP 2: Check cache for URLs (NO API COST)
    let cachedAnalysis = null;
    if (urls.length > 0) {
      const cacheKey = `analysis:${urls[0]}`;
      const cached = await client.redis.get(cacheKey);
      if (cached) {
        cachedAnalysis = JSON.parse(cached);
        console.log(`✅ Cache hit for URL: ${urls[0]}`);
      }
    }

    if (cachedAnalysis) {
      if (cachedAnalysis.isScam && cachedAnalysis.confidence > 0.7) {
        await flagMessage(client, user, message, cachedAnalysis.scamType, cachedAnalysis.confidence, 'Cached analysis', true);
      }
      return;
    }

    // STEP 3: Use Ollama for quick screening (FREE, LOCAL)
    console.log(`🤖 Ollama screening: ${message.author.username}`);
    const ollamaResult = await analyzeWithOllama(message.content, urls);

    if (ollamaResult.isSuspicious && ollamaResult.confidence > 0.7) {
      console.log(`⚠️ Ollama flagged: ${ollamaResult.type} (${ollamaResult.confidence})`);
      
      // Cache the result
      if (urls.length > 0) {
        await client.redis.setEx(`analysis:${urls[0]}`, 24*60*60, JSON.stringify(ollamaResult));
      }

      await flagMessage(client, user, message, ollamaResult.type, ollamaResult.confidence, ollamaResult.reason, true);
      
      // Only use Claude for uncertain cases or when Ollama says it's bad
      if (ollamaResult.confidence > 0.85) {
        return; // High confidence, no need for Claude
      }
    }

    // STEP 4: Only use Claude for edge cases (MINIMAL API COST)
    const shouldUseClaude = 
      (ollamaResult.isSuspicious && ollamaResult.confidence <= 0.85) ||
      (user.flaggedCount > 2) ||
      (urls.length > 0 && !ollamaResult.isSuspicious);

    if (shouldUseClaude) {
      console.log(`🧠 Claude analyzing: ${message.author.username} (${ollamaResult.confidence} confidence)`);
      const claudeResult = await analyzeWithClaude(message.content, urls, ollamaResult);

      if (claudeResult) {
        // Cache it
        if (urls.length > 0) {
          await client.redis.setEx(`analysis:${urls[0]}`, 24*60*60, JSON.stringify(claudeResult));
        }

        if (claudeResult.isScam && claudeResult.confidence > client.config.scamConfidenceThreshold) {
          await flagMessage(client, user, message, claudeResult.scamType, claudeResult.confidence, claudeResult.reasoning, true);
          
          if (claudeResult.confidence > 0.85) {
            await handleEscalation(client, user, message, 'high_confidence_scam');
          }
        }
      }
    }

    if (message.mentions.has(client.user)) {
      await message.reply('Hello! I\'m monitoring your server.');
    }
  } catch (error) {
    console.error('Message error:', error);
  }
});

async function flagMessage(client, user, message, flagType, confidence, reason, byAI = false) {
  try {
    await client.prisma.messageFlag.create({
      data: {
        messageId: message.id,
        userId: user.id,
        flagType,
        confidence,
        reason,
        flaggedByAI: byAI,
        severity: confidence > 0.8 ? 'critical' : confidence > 0.6 ? 'high' : 'medium',
      },
    });

    await client.prisma.user.update({
      where: { id: user.id },
      data: { flaggedCount: { increment: 1 } },
    });
  } catch (error) {
    console.error('Error flagging message:', error);
  }
}

client.on('error', (error) => console.error('Client error:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));

async function shutdown(signal) {
  console.log(`${signal} - shutting down...`);
  client.destroy();
  await prisma.$disconnect();
  await redisClient.quit();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('Login failed:', error);
  process.exit(1);
});

module.exports = { client, prisma, redisClient };
