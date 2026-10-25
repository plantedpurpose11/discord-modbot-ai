const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const { defaults, ranges, getConfig, setConfig } = require('./config');
const { categories } = require('./systems/ai/dualAI');
const { caseEmbed } = require('./systems/moderation/engine');
const staff = builder => builder.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages).setDMPermission(false);
const admin = builder => builder.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false);
const definitions = [
  new SlashCommandBuilder().setName('help').setDescription('A tidy guide to commands and how moderation works').setDMPermission(false)
    .addStringOption(o => o.setName('topic').setDescription('Choose a section').addChoices(...['overview', 'moderation', 'settings', 'ai'].map(name => ({ name, value: name })))),
  new SlashCommandBuilder().setName('privacy').setDescription('What the bot stores and how long it keeps it').setDMPermission(false),
  staff(new SlashCommandBuilder().setName('status').setDescription('Show moderation mode, AI budget, and recent cases')),
  admin(new SlashCommandBuilder().setName('botchat').setDescription('Choose the channel where everyone can talk to the bot')
    .addChannelOption(o => o.setName('channel').setDescription('Omit to unlink the channel').addChannelTypes(ChannelType.GuildText))),
  admin(new SlashCommandBuilder().setName('config').setDescription('View or change server configuration')
    .addSubcommand(s => s.setName('show').setDescription('View all settings'))
    .addSubcommand(s => s.setName('set').setDescription('Change one setting; use JSON for lists, numbers and booleans')
      .addStringOption(o => o.setName('key').setDescription('Setting name from /config show').setRequired(true))
      .addStringOption(o => o.setName('value').setDescription('Value, e.g. true, 6, review or ["example.com"]').setRequired(true)))),
  staff(new SlashCommandBuilder().setName('case').setDescription('Inspect a moderation case')
    .addStringOption(o => o.setName('id').setDescription('Case ID from the log or /status').setRequired(true))),
  staff(new SlashCommandBuilder().setName('feedback').setDescription('Approve or correct a case and teach future moderation')
    .addStringOption(o => o.setName('id').setDescription('Case ID').setRequired(true))
    .addStringOption(o => o.setName('label').setDescription('Correct classification').setRequired(true).addChoices(...['approve', ...categories].map(name => ({ name, value: name }))))),
  staff(new SlashCommandBuilder().setName('forget').setDescription('Remove the learned example associated with a case')
    .addStringOption(o => o.setName('id').setDescription('Case ID').setRequired(true))),
  staff(new SlashCommandBuilder().setName('purge').setDescription('Remove up to 100 recent messages (under 14 days old)')
    .addIntegerOption(o => o.setName('count').setDescription('Number of messages').setRequired(true).setMinValue(1).setMaxValue(100))),
];
const help = {
  overview: [
    ['Conversation', '**/botchat channel:#channel** links open chat. Omit channel to unlink. Mention me anywhere I can read to chat. Replies use your configured Ollama provider.'],
    ['Staff desk', '**/status** · health and latest cases\n**/case id** · inspect a decision\n**/feedback id label** · approve or correct\n**/forget id** · remove a lesson\n**/purge count** · clean recent messages'],
    ['Server controls', '**/config show** · inspect settings\n**/config set key value** · change settings\n**/privacy** · data policy\n**/help topic** · more detail'],
  ],
  moderation: [
    ['Action modes', '**review**: record for staff; no deletion.\n**delete**: remove confident violations.\n**timeout**: delete and temporarily mute. No automatic bans.'],
    ['Review workflow', 'Configure **logChannelId** to a private staff channel. Use Approve / Mark safe buttons or **/feedback** with the correct category. Feedback changes future decisions; it cannot restore deleted messages or undo timeouts. Use Discord’s native timeout controls for reversal.'],
    ['Media inspection', 'Links follow up to 3 redirects and inspect page text. Attachments support image/QR and text inspection, executable blocking, and optional ClamAV. Failed, partial or unsupported scans require review. Configure scanAttachments, inspectLinks and blockDangerousFiles.'],
    ['Permissions', 'Reviewers need **Manage Messages**. Configuration needs **Manage Server**. Staff with Manage Messages and configured roles/channels are exempt. Bot role must outrank members to timeout.'],
  ],
  settings: [
    ['Examples', '`/config set key:mode value:delete`\n`/config set key:blockInvites value:false`\n`/config set key:allowedDomains value:["example.com"]`\n`/config set key:spamLimit value:8`'],
    ['Available controls', Object.keys(defaults).join(' · ')],
    ['Ranges', Object.entries(ranges).map(([k, v]) => `${k}: ${v.join('–')}`).join('\n')],
  ],
  ai: [
    ['Cost ladder', 'Rules → staff-approved exact matches → cached analysis → Ollama → optional Claude for uncertain/unavailable results. Normal conversation skips moderation AI unless aiAllMessages is enabled.'],
    ['Learning', 'Staff labels become server-specific examples and exact-match decisions. Latest 8 examples guide AI. This is feedback-based learning, not automatic model training. Spam and explicit policy checks always run first.'],
    ['Paid budget', 'Claude is off by default. Requires ANTHROPIC_API_KEY, CLAUDE_MODEL and claudeEnabled. Daily request reservations survive restarts and include failed calls. Chat never uses Claude; Ollama Cloud quotas apply.'],
  ],
};
function helpEmbed(topic) {
  return new EmbedBuilder().setColor(0x7c83ff).setTitle(`Sentinel • ${topic[0].toUpperCase() + topic.slice(1)}`)
    .setDescription('A little attitude. A lot less spam.').addFields(...help[topic].map(([name, value]) => ({ name, value })))
    .setFooter({ text: 'Use /help topic:moderation, settings or ai for details.' });
}
async function handleInteraction(interaction, { db, redis, moderation, ai }) {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
  if (!interaction.inGuild()) return interaction.reply({ content: 'Use this in a server.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  try {
    const name = interaction.isButton() ? 'feedback' : interaction.commandName;
    const isAdmin = ['config', 'botchat'].includes(name);
    if (!['help', 'privacy'].includes(name)) {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!member.permissions.has(isAdmin ? PermissionFlagsBits.ManageGuild : PermissionFlagsBits.ManageMessages)) throw new Error(`You need ${isAdmin ? 'Manage Server' : 'Manage Messages'} permission.`);
    }
    const config = await getConfig(db, interaction.guildId);
    const option = key => interaction.options.getString(key);
    let response;
    if (name === 'help') response = { embeds: [helpEmbed(option('topic') || 'overview')] };
    else if (name === 'privacy') response = { content: `Flagged message text and staff-reviewed examples are kept for ${config.retentionDays} days (examples expire after their last review). Ordinary messages are not stored in the database. Chat context is local Redis, scoped to member/channel, and expires after 15 minutes. AI cache expires after one hour. Suspicious text and up to 8 staff examples go to Ollama${config.claudeEnabled ? ' and optionally Anthropic Claude' : ''}. When enabled, attachments are downloaded from Discord CDN and public link destinations are fetched. Extracted text and resized images may go to Ollama Cloud; file bytes are not stored. Case evidence includes extracts, URLs and file hashes. Optional ClamAV scans file bytes. Staff can remove learned examples with /forget.` };
    else if (name === 'config') {
      if (interaction.options.getSubcommand() === 'show') response = { content: `\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\`` };
      else {
        const key = option('key'); let value = option('value');
        if (typeof defaults[key] !== 'string') {
          try { value = JSON.parse(value); } catch { /* Validation provides a useful error. */ }
        }
        if (key.endsWith('ChannelId') && value) {
          const channel = await interaction.guild.channels.fetch(value);
          if (!channel || !channel.isTextBased()) throw new Error('Choose a text channel in this server.');
        }
        await setConfig(db, interaction.guildId, key, value);
        response = { content: `Updated ${key}.` };
      }
    } else if (name === 'botchat') {
      const channel = interaction.options.getChannel('channel');
      await setConfig(db, interaction.guildId, 'botchatChannelId', channel?.id || '');
      response = { content: channel ? `Open chat linked to <#${channel.id}>. Tiny channel, big personality.` : 'Open chat unlinked. Mentions still work when chat is enabled.' };
    } else if (name === 'status') {
      await redis.ping();
      const usage = await db.dailyUsage.findUnique({ where: { id: `${interaction.guildId}:${new Date().toISOString().slice(0, 10)}` } });
      const recent = await db.moderationCase.findMany({ where: { guildId: interaction.guildId }, orderBy: { createdAt: 'desc' }, take: 5 });
      response = { embeds: [new EmbedBuilder().setColor(0x7c83ff).setTitle('Sentinel • Status').addFields(
        { name: 'Services', value: `Database and Redis reachable. AI requests active: ${ai.active}. Provider connectivity is checked when requests run.` },
        { name: 'Policy', value: `Mode: ${config.mode}\nClaude: ${config.claudeEnabled ? 'enabled' : 'disabled'} • ${usage?.requests || 0}/${config.claudeDailyRequests} daily requests reserved` },
        { name: 'Recent cases', value: recent.map(r => `${r.id} • ${r.category} • ${r.action}`).join('\n') || 'No cases. Suspiciously peaceful.' })] };
    } else if (['case', 'feedback', 'forget'].includes(name)) {
      const parts = interaction.isButton() ? interaction.customId.split(':') : null;
      if (parts && (parts.length !== 3 || parts[0] !== 'review' || !['approve', 'safe'].includes(parts[2]))) throw new Error('Unknown review action.');
      const id = parts ? parts[1] : option('id');
      const row = await db.moderationCase.findFirst({ where: { id, guildId: interaction.guildId } });
      if (!row) throw new Error('Case not found in this server.');
      if (name === 'case') response = { embeds: [caseEmbed(row).addFields({ name: 'Staff review', value: row.verdict ? `${row.verdict} by <@${row.reviewedBy}>` : 'Awaiting review' })] };
      else if (name === 'forget') {
        await db.learningExample.deleteMany({ where: { guildId: interaction.guildId, contentHash: row.contentHash } });
        response = { content: 'Learned example removed. Existing actions and case history remain.' };
      } else {
        const label = await moderation.feedback(interaction.guildId, id, parts ? parts[2] : option('label'), interaction.user.id);
        response = { content: `Recorded staff verdict: ${label}. Future matching messages use this lesson after policy checks. Existing deletions and timeouts are unchanged.` };
      }
    } else if (name === 'purge') {
      if (!interaction.channel?.bulkDelete) throw new Error('Bulk deletion is unavailable here.');
      const deleted = await interaction.channel.bulkDelete(interaction.options.getInteger('count'), true);
      response = { content: `Removed ${deleted.size} messages. Ancient history (over 14 days) stays put.` };
    } else throw new Error('Unknown command.');
    if (response.content?.length > 2000) response = { files: [{ attachment: Buffer.from(response.content), name: 'settings.txt' }], content: 'Settings attached.' };
    await interaction.editReply({ ...response, allowedMentions: { parse: [] } });
  } catch (error) {
    console.warn('Command failed:', error.code || error.name);
    await interaction.editReply({ content: error.code ? 'Operation failed. Check bot permissions, role hierarchy and service health.' : String(error.message).slice(0, 1800), allowedMentions: { parse: [] } });
  }
}
module.exports = { definitions, handleInteraction, helpEmbed };
