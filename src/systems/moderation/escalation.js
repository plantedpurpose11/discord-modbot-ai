async function handleEscalation(message, config, verdict) {
  if (config.mode === 'review' || verdict.confidence < config.aiThreshold || verdict.category === 'uncertain') return { action: 'review' };
  let action = 'pending';
  try {
    await message.delete();
    action = 'deleted';
    if (config.mode === 'timeout' && config.timeoutSeconds > 0) {
      const member = await message.guild.members.fetch(message.author.id);
      if (!member.moderatable) return { action, actionError: 'Member cannot be timed out (permissions or role hierarchy)' };
      // Do not shorten an existing staff timeout.
      if ((member.communicationDisabledUntilTimestamp || 0) < Date.now() + config.timeoutSeconds * 1000) {
        await member.timeout(config.timeoutSeconds * 1000, `Automatic moderation: ${verdict.category}`);
        action = 'deleted + timed out';
      }
    }
    return { action };
  } catch (error) { return { action: action === 'pending' ? 'failed' : action, actionError: `Discord action failed (${error.code || error.name})` }; }
}
module.exports = { handleEscalation };
