import "dotenv/config";
import { REST, Routes } from "discord.js";
import { commandsJSON } from "./commands.js";

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("DISCORD_TOKEN and CLIENT_ID are required.");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(TOKEN);

try {
  if (GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commandsJSON }
    );
    console.log(`Registered ${commandsJSON.length} guild slash commands.`);
  } else {
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commandsJSON }
    );
    console.log(`Registered ${commandsJSON.length} global slash commands.`);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
