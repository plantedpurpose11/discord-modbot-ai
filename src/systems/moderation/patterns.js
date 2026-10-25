const { createHash } = require('node:crypto');
function normalize(content) { return content.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function contentHash(content) { return createHash('sha256').update(normalize(content)).digest('hex'); }
function domains(content) {
  const matches = normalize(content).match(/(?:https?:\/\/|www\.)[^\s<>]+/g) || [];
  return matches.flatMap(value => {
    try { return [new URL(value.startsWith('www.') ? `https://${value}` : value).hostname.replace(/\.$/, '')]; } catch { return []; }
  });
}
function matchesDomain(host, list) { return list.some(domain => host === domain || host.endsWith(`.${domain}`)); }
function checkLocalPatterns(content, config) {
  const text = normalize(content);
  const hosts = domains(text);
  if (hosts.some(host => matchesDomain(host, config.blockedDomains))) return { category: 'phishing', confidence: 1, reason: 'Blocked domain', source: 'rules' };
  if (config.blockInvites && /(?:^|[^\w.-])(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[\w-]+/i.test(text)) return { category: 'invite', confidence: 1, reason: 'Discord invite links are disabled', source: 'rules' };
  const suspicious = /(?:wallet|seed phrase|private key|airdrop|free nitro|guaranteed.{0,20}profit|claim.{0,20}(?:reward|gift)|verify.{0,20}account)/i.test(text)
    || hosts.some(host => !matchesDomain(host, config.allowedDomains));
  return { category: 'safe', confidence: 1, reason: 'No deterministic violation', source: 'rules', suspicious };
}
const SPAM_SCRIPT = `
local total = redis.call('INCR', KEYS[1])
if total == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local copies = redis.call('INCR', KEYS[2])
if copies == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
return {total, copies}
`;
async function checkSpam(redis, message, config) {
  const base = `spam:${message.guildId}:${message.author.id}`;
  const [total, copies] = await redis.eval(SPAM_SCRIPT, { keys: [base, `${base}:${contentHash(message.content)}`], arguments: [String(config.spamWindowSeconds)] });
  const mentions = message.mentions.users.size + message.mentions.roles.size;
  if (total > config.spamLimit || (message.content.trim() && copies >= config.duplicateLimit) || mentions >= config.mentionLimit || message.mentions.everyone) {
    return { category: 'spam', confidence: 1, reason: 'Message rate, duplicate or mention limit exceeded', source: 'rules' };
  }
  return null;
}
module.exports = { normalize, contentHash, domains, matchesDomain, checkLocalPatterns, checkSpam };
