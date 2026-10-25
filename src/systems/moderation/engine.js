const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { Inspector, attachmentIdentity, digest } = require('../inspection/scanner');
const { categories } = require('../ai/dualAI');
const { getConfig } = require('../../config');
const { contentHash, checkLocalPatterns, checkSpam } = require('./patterns');
const { handleEscalation } = require('./escalation');
function caseEmbed(row) {
  return new EmbedBuilder().setColor(row.actionError ? 0xe76f51 : 0x7c83ff)
    .setTitle(`Moderation • ${row.category}`).setDescription(row.reason.slice(0, 500))
    .addFields({ name: 'Case', value: row.id }, { name: 'Member', value: `<@${row.userId}>`, inline: true },
      { name: 'Decision', value: `${row.source} • ${Math.round(row.confidence * 100)}%`, inline: true },
      { name: 'Action', value: `${row.action}${row.actionError ? ` — ${row.actionError}` : ''}` },
      { name: 'Message (untrusted content)', value: row.content.slice(0, 1000) || '(no text)' })
    .setFooter({ text: 'Approve confirms this label. Mark safe corrects it. /feedback supports other labels.' });
}
class Moderation {
  constructor({ db, redis, ai, client, inspector = new Inspector() }) { Object.assign(this, { db, redis, ai, client, inspector }); }
  async log(row, config) {
    if (!config.logChannelId) return;
    try {
      const channel = await this.client.channels.fetch(config.logChannelId);
      if (channel?.guildId !== row.guildId || !channel.isTextBased()) return;
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`review:${row.id}:approve`).setLabel('Approve').setStyle(ButtonStyle.Success).setDisabled(row.category === 'uncertain'),
        new ButtonBuilder().setCustomId(`review:${row.id}:safe`).setLabel('Mark safe').setStyle(ButtonStyle.Secondary));
      await channel.send({ embeds: [caseEmbed(row)], components: [buttons], allowedMentions: { parse: [] } });
    } catch (error) { console.warn('Moderation log delivery failed:', error.code || error.name); }
  }
  async process(message, { edited = false } = {}) {
    if (!message.guild || message.author.bot || message.webhookId) return;
    const config = await getConfig(this.db, message.guildId);
    const member = await message.guild.members.fetch(message.author.id);
    const exempt = member.permissions.has(PermissionFlagsBits.ManageMessages) || config.exemptRoleIds.some(id => member.roles.cache.has(id)) || config.exemptChannelIds.includes(message.channelId);
    let verdict = null;
    let evidenceContent = message.content;
    let evidenceHash = contentHash(message.content);
    if (!exempt) {
      verdict = edited ? null : await checkSpam(this.redis, message, config);
      if (!verdict) {
        const local = checkLocalPatterns(message.content, config);
        if (local.category !== 'safe') verdict = local;
        else {
          const scan = await this.inspector.inspect(message, config);
          if (scan.hasMedia) {
            evidenceContent = JSON.stringify({ message: message.content, attachments: attachmentIdentity(message), evidence: scan.evidence, issues: scan.issues });
            evidenceHash = digest(evidenceContent);
            if (evidenceContent.length > 16000) scan.issues.push('Combined evidence exceeds AI inspection limit');
          }
          if (scan.verdict) verdict = scan.verdict;
          else if (scan.issues.length) verdict = { category: 'uncertain', confidence: 0, reason: scan.issues.join('; ').slice(0, 500), source: 'inspection' };
          else {
            const learned = await this.db.learningExample.findUnique({ where: { guildId_contentHash: { guildId: message.guildId, contentHash: evidenceHash } } });
            if (learned) verdict = { category: learned.category, confidence: 1, reason: 'Exact match to staff-reviewed evidence', source: 'staff' };
            else if (config.aiEnabled && (scan.hasMedia || local.suspicious || config.aiAllMessages) && evidenceContent.trim()) {
              const examples = await this.db.learningExample.findMany({ where: { guildId: message.guildId }, orderBy: { updatedAt: 'desc' }, take: 8 });
              const cacheKey = `analysis:${message.guildId}:${digest(JSON.stringify({ evidenceHash, config, examples, model: this.ai.env?.OLLAMA_MODEL, visionModel: this.ai.env?.OLLAMA_VISION_MODEL }))}`;
              const cached = await this.redis.get(cacheKey);
              verdict = cached ? JSON.parse(cached) : await this.ai.analyze(message.guildId, evidenceContent, config, examples, scan.images);
              if (verdict) await this.redis.setEx(cacheKey, 3600, JSON.stringify(verdict));
              else verdict = { category: 'uncertain', confidence: 0, reason: 'AI unavailable or busy; staff review needed', source: 'unavailable' };
              if (scan.hasMedia && verdict.category === 'safe' && verdict.confidence < config.aiThreshold) verdict = { category: 'uncertain', confidence: 0, reason: 'Media assessment is uncertain; staff review needed', source: 'inspection' };
            } else if (scan.hasMedia) verdict = { category: 'uncertain', confidence: 0, reason: 'AI disabled; extracted media requires staff review', source: 'inspection' };
          }
        }
      }
      if (verdict && verdict.category !== 'safe') {
        // Database uniqueness claims each message before any destructive operation.
        let row;
        try {
          row = await this.db.moderationCase.create({ data: { guildId: message.guildId, channelId: message.channelId, messageId: message.id, userId: message.author.id, content: evidenceContent.slice(0, 16000), contentHash: evidenceHash, category: verdict.category, confidence: verdict.confidence, reason: verdict.reason, source: verdict.source } });
        } catch (error) { if (error.code === 'P2002') return; throw error; }
        const result = await handleEscalation(message, config, verdict);
        row = await this.db.moderationCase.update({ where: { id: row.id }, data: result });
        await this.log(row, config);
        return;
      }
    }
    if (!edited && config.chatEnabled && (message.channelId === config.botchatChannelId || message.mentions.users.has(this.client.user.id))) {
      const response = await this.ai.chat(message, config);
      if (response) await message.reply({ content: response, allowedMentions: { parse: [], repliedUser: false } });
    }
  }
  async feedback(guildId, caseId, category, moderatorId) {
    return this.db.$transaction(async tx => {
      const row = await tx.moderationCase.findFirst({ where: { id: caseId, guildId } });
      if (!row) throw new Error('Case not found in this server.');
      const label = category === 'approve' ? row.category : category;
      if (!categories.includes(label)) throw new Error('Choose a specific label with /feedback.');
      // Lock the case before changing its example; concurrent corrections serialize.
      await tx.moderationCase.update({ where: { id: row.id }, data: { reviewedBy: moderatorId, verdict: label } });
      await tx.learningExample.upsert({ where: { guildId_contentHash: { guildId, contentHash: row.contentHash } },
        create: { guildId, contentHash: row.contentHash, content: row.content, category: label, moderatorId },
        update: { content: row.content, category: label, moderatorId } });
      await tx.staffFeedback.create({ data: { guildId, caseId, moderatorId, category: label } });
      return label;
    });
  }
}
module.exports = { Moderation, caseEmbed };
