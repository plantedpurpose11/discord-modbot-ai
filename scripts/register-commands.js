require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { definitions } = require('../src/commands');
async function register() {
  if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) throw new Error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID');
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const route = process.env.DISCORD_GUILD_ID ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID) : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);
  await rest.put(route, { body: definitions.map(command => command.toJSON()) });
  console.log('Slash commands registered.');
}
register().catch(error => { console.error('Registration failed:', error.code || error.name); process.exitCode = 1; });
