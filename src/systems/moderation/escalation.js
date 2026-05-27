async function handleEscalation(client, user, message, reason) {
  try {
    const warningCount = user.warningCount || 0;
    const config = client.config;
    const kickThreshold = config.warningsBeforeKick || 3;
    const banThreshold = config.warningsBeforeBan || 5;

    if (warningCount >= banThreshold) {
      await message.guild.bans.create(user.id, { reason });
      console.log(`🔨 Banned ${user.username}`);
    } else if (warningCount >= kickThreshold) {
      const member = await message.guild.members.fetch(user.id);
      await member.kick(reason);
      console.log(`👢 Kicked ${user.username}`);
    } else if (warningCount > 0) {
      const member = await message.guild.members.fetch(user.id);
      await member.timeout(5 * 60 * 1000, reason);
      console.log(`🔇 Muted ${user.username}`);
    } else {
      await client.prisma.user.update({ where: { id: user.id }, data: { warningCount: { increment: 1 } } });
      console.log(`⚠️ Warned ${user.username}`);
    }
  } catch (error) {
    console.error('Escalation error:', error);
  }
}

module.exports = { handleEscalation };
