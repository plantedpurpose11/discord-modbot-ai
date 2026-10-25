const defaults = Object.freeze({
  mode: 'review', blockInvites: true, spamLimit: 6, spamWindowSeconds: 10,
  duplicateLimit: 3, mentionLimit: 6, timeoutSeconds: 300,
  scanAttachments: true, inspectLinks: true, blockDangerousFiles: true,
  maxAttachments: 3, maxAttachmentBytes: 5242880, maxLinks: 3,
  aiEnabled: true, aiAllMessages: false, aiThreshold: 0.9,
  claudeEnabled: false, claudeDailyRequests: 20,
  chatEnabled: true, chatCooldownSeconds: 8,
  logChannelId: '', botchatChannelId: '', exemptRoleIds: [], exemptChannelIds: [],
  allowedDomains: [], blockedDomains: [], retentionDays: 30,
  personality: 'Witty, concise and mildly sarcastic. Roast bad ideas, never people. Be helpful; no harassment, slurs or humiliation.',
});
const ranges = {
  maxAttachments: [1, 5], maxAttachmentBytes: [1024, 10485760], maxLinks: [1, 5],
  spamLimit: [3, 50], spamWindowSeconds: [3, 120], duplicateLimit: [2, 20],
  mentionLimit: [3, 50], timeoutSeconds: [0, 86400], aiThreshold: [0.7, 1],
  claudeDailyRequests: [0, 1000], chatCooldownSeconds: [3, 300], retentionDays: [1, 365],
};
function validateSetting(key, value) {
  if (!Object.hasOwn(defaults, key)) throw new Error('Unknown setting. Use /config show.');
  if (key === 'mode' && !['review', 'delete', 'timeout'].includes(value)) throw new Error('Mode must be review, delete or timeout.');
  if (ranges[key] && (typeof value !== 'number' || !Number.isFinite(value) || value < ranges[key][0] || value > ranges[key][1] || (key !== 'aiThreshold' && !Number.isInteger(value)))) throw new Error(`${key} must be ${ranges[key].join('–')}${key === 'aiThreshold' ? '' : ' (integer)'}.`);
  if (typeof defaults[key] === 'boolean' && typeof value !== 'boolean') throw new Error('Use true or false.');
  if (typeof defaults[key] === 'string' && (typeof value !== 'string' || value.length > 700)) throw new Error('Expected text, at most 700 characters.');
  if (key.endsWith('ChannelId') && value !== '' && !/^\d{17,20}$/.test(value)) throw new Error('Expected a channel ID or empty string.');
  if (Array.isArray(defaults[key])) {
    if (!Array.isArray(value) || value.length > 50 || value.some(x => typeof x !== 'string')) throw new Error('Expected a JSON array of at most 50 strings.');
    if (key.endsWith('Ids') && value.some(x => !/^\d{17,20}$/.test(x))) throw new Error('Expected Discord IDs.');
    if (key.endsWith('Domains') && value.some(x => x !== x.toLowerCase() || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(x))) throw new Error('Use lowercase hostnames without paths, e.g. example.com.');
  }
  return value;
}
async function getConfig(db, guildId) {
  const row = await db.guildSettings.findUnique({ where: { id: guildId } });
  return { ...defaults, ...(row?.settings || {}) };
}
async function setConfig(db, guildId, key, value) {
  validateSetting(key, value);
  // JSONB merge avoids losing simultaneous updates to different settings.
  await db.$executeRaw`INSERT INTO "GuildSettings" (id, settings, "updatedAt") VALUES (${guildId}, ${JSON.stringify({ [key]: value })}::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET settings = "GuildSettings".settings || EXCLUDED.settings, "updatedAt" = NOW()`;
}
module.exports = { defaults, ranges, validateSetting, getConfig, setConfig };
