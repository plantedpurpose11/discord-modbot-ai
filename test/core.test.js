const test = require('node:test');
const assert = require('node:assert/strict');
const { defaults, validateSetting } = require('../src/config');
const { checkLocalPatterns, contentHash, checkSpam } = require('../src/systems/moderation/patterns');
const { parseVerdict, AI } = require('../src/systems/ai/dualAI');
const { handleEscalation } = require('../src/systems/moderation/escalation');
const { Moderation } = require('../src/systems/moderation/engine');
const { definitions, helpEmbed, handleInteraction } = require('../src/commands');
test('configuration rejects unknown, out-of-range and incorrectly typed settings', () => {
  for (const [key, value] of [['mode', 'ban'], ['aiThreshold', NaN], ['spamLimit', 2.5], ['claudeEnabled', 'true'], ['blockedDomains', ['good.com/path']], ['exemptRoleIds', ['x']], ['__proto__', {}]]) assert.throws(() => validateSetting(key, value));
  assert.equal(validateSetting('mode', 'delete'), 'delete');
  assert.equal(validateSetting('aiThreshold', 0.9), 0.9);
});
test('invites are separate from phishing and domain checks respect hostname boundaries', () => {
  assert.equal(checkLocalPatterns('discord.gg/hello', defaults).category, 'invite');
  assert.equal(checkLocalPatterns('https://discord.com/invite/abc', defaults).category, 'invite');
  assert.equal(checkLocalPatterns('https://notdiscord.gg/abc', defaults).category, 'safe');
  assert.equal(checkLocalPatterns('discord.gg/abc', { ...defaults, blockInvites: false }).category, 'safe');
  assert.equal(checkLocalPatterns('https://sub.evil.com/x', { ...defaults, blockedDomains: ['evil.com'] }).category, 'phishing');
  assert.equal(checkLocalPatterns('https://evil.com.safe.org', { ...defaults, blockedDomains: ['evil.com'] }).category, 'safe');
  assert.equal(checkLocalPatterns('Never share your seed phrase', defaults).category, 'safe');
  assert.equal(contentHash('He\u200bLLo   world'), contentHash('hello world'));
});
test('AI verdict parser rejects unsafe schemas instead of coercing values', () => {
  for (const value of [{ category: 'ban', confidence: 1, reason: 'x' }, { category: 'scam', confidence: '1', reason: 'x' }, { category: 'scam', confidence: 2, reason: 'x' }, { category: 'scam', confidence: 1 }]) assert.throws(() => parseVerdict(JSON.stringify(value), 'test'));
  assert.equal(parseVerdict('```json\n{"category":"safe","confidence":1,"reason":"fine"}\n```', 'ollama').category, 'safe');
});
test('spam counters are scoped to guild and member; threshold catches duplicates', async () => {
  const redis = { eval: async (_, args) => { assert.equal(args.keys[0], 'spam:g:u'); assert.equal(args.arguments[0], '10'); return [3, 3]; } };
  assert.equal((await checkSpam(redis, { guildId: 'g', author: { id: 'u' }, content: 'repeat', mentions: { users: new Map(), roles: new Map() } }, defaults)).category, 'spam');
});
test('review mode and low confidence never delete; partial Discord failures are recorded', async () => {
  let deleted = 0;
  const message = { delete: async () => { deleted++; }, author: { id: 'u' }, guild: { members: { fetch: async () => ({ moderatable: false }) } } };
  assert.equal((await handleEscalation(message, defaults, { confidence: 1 })).action, 'review');
  await handleEscalation(message, { ...defaults, mode: 'delete' }, { confidence: 0.8 });
  assert.equal(deleted, 0);
  const result = await handleEscalation(message, { ...defaults, mode: 'timeout' }, { confidence: 1, category: 'scam' });
  assert.equal(result.action, 'deleted'); assert.match(result.actionError, /cannot/);
});
test('Ollama confident decisions avoid paid calls; disabled Claude never incurs usage', async () => {
  let paid = 0;
  const ai = new AI({ db: {}, redis: {}, env: {}, anthropic: { messages: { create: async () => { paid++; } } }, http: { post: async () => ({ data: { message: { content: '{"category":"safe","confidence":1,"reason":"fine"}' } } }) } });
  assert.equal((await ai.analyze('g', 'hello', defaults, [])).category, 'safe');
  ai.http.post = async () => { throw new Error('offline'); };
  assert.equal(await ai.analyze('g', 'hello', defaults, []), null);
  assert.equal(paid, 0);
});
test('paid request reservation is atomic and exhausted budgets prevent calls', async () => {
  let count = 0; let paid = 0;
  const db = { dailyUsage: { upsert: async () => {}, updateMany: async ({ where }) => ({ count: count < where.requests.lt ? (++count, 1) : 0 }) } };
  const ai = new AI({ db, redis: {}, env: { CLAUDE_MODEL: 'configured-model' }, http: { post: async () => { throw new Error('offline'); } }, anthropic: { messages: { create: async () => { paid++; return { content: [{ type: 'text', text: '{"category":"scam","confidence":0.95,"reason":"phishing"}' }] }; } } } });
  await Promise.all(Array.from({ length: 3 }, () => ai.analyze('g', 'x', { ...defaults, claudeEnabled: true, claudeDailyRequests: 1 }, [])));
  assert.equal(count, 1); assert.equal(paid, 1);
});
function fixture(config = {}, learned = null) {
  const rows = [];
  const db = {
    guildSettings: { findUnique: async () => ({ settings: config }) },
    learningExample: { findUnique: async ({ where }) => { assert.equal(where.guildId_contentHash.guildId, 'g'); return learned; }, findMany: async () => [] },
    moderationCase: { create: async ({ data }) => { if (rows.some(row => row.messageId === data.messageId && row.contentHash === data.contentHash)) throw Object.assign(new Error('duplicate'), { code: 'P2002' }); const row = { id: `case${rows.length + 1}`, ...data }; rows.push(row); return row; }, update: async ({ where, data }) => Object.assign(rows.find(row => row.id === where.id), data) },
  };
  let deletes = 0; let aiCalls = 0;
  const redis = { eval: async () => [1, 1], get: async () => null, setEx: async () => {} };
  const ai = { analyze: async () => { aiCalls++; return null; }, chat: async () => null };
  const message = { guildId: 'g', channelId: 'c', id: 'm', content: 'discord.gg/abc', author: { id: 'u' }, guild: { members: { fetch: async () => ({ permissions: { has: () => false }, roles: { cache: new Map() } }) } }, mentions: { users: new Map(), roles: new Map() }, delete: async () => { deletes++; } };
  return { engine: new Moderation({ db, redis, ai, client: { user: { id: 'bot' } }, inspector: { inspect: async () => ({ hasMedia: false, images: [], evidence: [], issues: [], verdict: null }) } }), message, rows, deletes: () => deletes, aiCalls: () => aiCalls };
}
test('staff safe labels cannot bypass explicit invite policy and a message is enforced only once', async () => {
  const f = fixture({ mode: 'delete' }, { category: 'safe' });
  await f.engine.process(f.message); await f.engine.process(f.message);
  assert.equal(f.rows[0].category, 'invite'); assert.equal(f.deletes(), 1); assert.equal(f.aiCalls(), 0);
});
test('safe staff labels skip AI while unavailable AI produces review-only cases', async () => {
  const safe = fixture({}, { category: 'safe' }); safe.message.content = 'https://example.com';
  await safe.engine.process(safe.message); assert.equal(safe.rows.length, 0); assert.equal(safe.aiCalls(), 0);
  const offline = fixture({ mode: 'timeout' }); offline.message.content = 'https://example.com';
  await offline.engine.process(offline.message); assert.equal(offline.rows[0].action, 'review'); assert.equal(offline.deletes(), 0);
});
test('edits are screened without incrementing message-rate counters', async () => {
  const f = fixture({ mode: 'delete' });
  f.engine.redis.eval = async () => { throw new Error('Should not count an edit as a new message'); };
  await f.engine.process(f.message, { edited: true }); assert.equal(f.deletes(), 1);
});
test('slash definitions and all help sections satisfy Discord embed constraints', () => {
  for (const command of definitions) assert.ok(command.toJSON().name);
  for (const topic of ['overview', 'moderation', 'settings', 'ai']) {
    const embed = helpEmbed(topic).toJSON();
    for (const field of embed.fields) assert.ok(field.value.length <= 1024);
  }
});
test('runtime staff permissions protect feedback even if command visibility is changed', async () => {
  let response;
  const interaction = { isChatInputCommand: () => true, isButton: () => false, inGuild: () => true, commandName: 'feedback', user: { id: 'u' }, guild: { members: { fetch: async () => ({ permissions: { has: () => false } }) } }, deferReply: async () => {}, editReply: async r => { response = r; } };
  await handleInteraction(interaction, { db: {}, redis: {}, moderation: {}, ai: {} });
  assert.match(response.content, /Manage Messages/);
});
test('simultaneous first daily reservation tolerates initialization conflicts', async () => {
  const ai = new AI({ db: { dailyUsage: { upsert: async () => { throw Object.assign(new Error('race'), { code: 'P2002' }); }, updateMany: async () => ({ count: 1 }) } }, redis: {}, env: {} });
  assert.equal(await ai.reserve('g', 1), true);
});
test('open chat and mentions route to local chat; edited messages do not trigger chat', async () => {
  for (const config of [{ botchatChannelId: 'c' }, {}]) {
    const f = fixture(config); f.message.content = 'hello';
    if (!config.botchatChannelId) f.message.mentions.users.set('bot', {});
    let calls = 0; let reply;
    f.engine.ai.chat = async () => { calls++; return 'Hello, chaos coordinator.'; };
    f.message.reply = async value => { reply = value; };
    await f.engine.process(f.message);
    assert.equal(calls, 1); assert.deepEqual(reply.allowedMentions, { parse: [], repliedUser: false });
    await f.engine.process(f.message, { edited: true }); assert.equal(calls, 1);
  }
});
test('chat cooldown prevents model work and chat never calls paid provider', async () => {
  let calls = 0;
  const ai = new AI({ db: {}, redis: { set: async () => null }, env: {}, anthropic: { messages: { create: () => { throw new Error('No paid chat'); } } }, http: { post: () => { calls++; } } });
  assert.equal(await ai.chat({ guildId: 'g', author: { id: 'u' } }, defaults), null); assert.equal(calls, 0);
});
test('AI concurrency is bounded without an unbounded queue', async () => {
  const ai = new AI({ db: {}, redis: {}, env: {} });
  const release = [];
  const jobs = Array.from({ length: 3 }, () => ai.limited(() => new Promise(resolve => release.push(resolve))));
  assert.equal(await ai.limited(() => assert.fail('Must not start fourth request')), null);
  for (const resolve of release) resolve('done');
  await Promise.all(jobs); assert.equal(ai.active, 0);
});

test('a previously reviewed message can be enforced after its content changes', async () => {
  const f = fixture({ mode: 'delete' });
  await f.engine.process(f.message);
  f.message.content = 'discord.gg/changed';
  await f.engine.process(f.message, { edited: true });
  assert.equal(f.rows.length, 2); assert.equal(f.deletes(), 2);
});
