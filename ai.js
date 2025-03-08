const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");
const { OpenAI } = require("openai");
require("dotenv").config();
const fs = require("fs");
const express = require("express");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

let serverData = {};

const prompt = fs.readFileSync("./prompt.txt", "utf-8");

client.on("ready", async () => {
  console.log("Bot is ready");
  const commands = [
    new SlashCommandBuilder()
      .setName("key")
      .setDescription("Set the OpenAI API key for the server")
      .addStringOption((option) =>
        option
          .setName("key")
          .setDescription("Your OpenAI API key")
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("currentkey")
      .setDescription("Check the stored OpenAI API key for the server"),
    new SlashCommandBuilder()
      .setName("startai")
      .setDescription("Turn on the AI bot"),
    new SlashCommandBuilder()
      .setName("stopai")
      .setDescription("Turn off the AI bot"),
  ].map((cmd) => cmd.toJSON());
  const rest = new REST({ version: "10" }).setToken(
    process.env.DISCORD_BOT_TOKEN,
  );
  try {
    console.log("Registering global commands...");
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log("Global slash commands registered.");
  } catch (error) {
    console.error("Error registering global commands:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  const { commandName, guildId } = interaction;
  if (!interaction.member.permissions.has("Administrator")) {
    return interaction.reply({
      content: "You do not have permission to use this command.",
      ephemeral: true,
    });
  }
  if (!serverData[guildId]) {
    serverData[guildId] = {
      botActive: false,
      messageHistory: {},
      lastMessageTime: {},
      messageBuffer: {},
      typingTimeouts: {},
      serverOpenAIKey: null,
    };
  }
  const server = serverData[guildId];
  try {
    if (commandName === "key") {
      server.serverOpenAIKey = interaction.options.getString("key");
      const botStateChannel = interaction.guild.channels.cache.find(
        (channel) => channel.name === "bot-state" && channel.isTextBased(),
      );
      if (botStateChannel)
        botStateChannel.send(
          "Key was successfully entered, AI is ready to use, type `/startai` to turn it on, type `/stopai` to turn it off.",
        );
      await interaction.reply({
        content: "Server-wide API key has been stored successfully.",
        ephemeral: true,
      });
    }
    if (commandName === "currentkey") {
      if (!server.serverOpenAIKey) {
        return interaction.reply({
          content: "No API key has been set for this server.",
          ephemeral: true,
        });
      }
      const maskedKey =
        server.serverOpenAIKey.slice(0, 5) +
        "*****" +
        server.serverOpenAIKey.slice(-5);
      await interaction.reply({
        content: `Stored API key: \`${maskedKey}\``,
        ephemeral: true,
      });
    }
    if (commandName === "startai") {
      if (!server.serverOpenAIKey) {
        return interaction.reply({
          content: "You must set an OpenAI API key first using `/key`.",
          ephemeral: true,
        });
      }
      server.botActive = true;
      console.log("Bot is now active");
      client.user.setPresence({
        status: "online",
        activities: [{ name: "AI Chatting", type: "PLAYING" }],
      });
      await interaction.reply({
        content: "AI has been turned on.",
        ephemeral: true,
      });
      const botStateChannel = interaction.guild.channels.cache.find(
        (channel) => channel.name === "bot-state" && channel.isTextBased(),
      );
      if (botStateChannel) botStateChannel.send("AI has turned on");
    }
    if (commandName === "stopai") {
      server.botActive = false;
      console.log("Bot is now inactive");
      client.user.setPresence({ status: "offline" });
      await interaction.reply({
        content: "AI has been turned off.",
        ephemeral: true,
      });
      const botStateChannel = interaction.guild.channels.cache.find(
        (channel) => channel.name === "bot-state" && channel.isTextBased(),
      );
      if (botStateChannel) botStateChannel.send("AI has turned off");
    }
  } catch (error) {
    console.error(error);
    await interaction.reply({
      content: "There was an error while processing your command.",
      ephemeral: true,
    });
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const guildId = message.guild.id;
  if (!serverData[guildId]) {
    serverData[guildId] = {
      botActive: false,
      messageHistory: {},
      lastMessageTime: {},
      messageBuffer: {},
      typingTimeouts: {},
      serverOpenAIKey: null,
    };
  }
  const server = serverData[guildId];
  const botStateChannel = message.guild.channels.cache.find(
    (channel) => channel.name === "bot-state" && channel.isTextBased(),
  );
  if (message.content.toLowerCase() === ".restartmemory") {
    if (!message.member.permissions.has("Administrator")) {
      return message.reply({
        content: "You do not have permission to use this command.",
        ephemeral: true,
      });
    }
    server.serverOpenAIKey = null;
    server.messageHistory = {};
    server.messageBuffer = {};
    server.lastMessageTime = {};
    server.typingTimeouts = {};
    console.log("Memory storage has been reset.");
    return message.reply({
      content: "Memory storage has been reset.",
      ephemeral: true,
    });
  }
  if (message.content.toLowerCase() === ".startai") {
    server.botActive = true;
    console.log("Bot is now active");
    client.user.setPresence({
      status: "online",
      activities: [{ name: "AI Chatting", type: "PLAYING" }],
    });
    if (botStateChannel) botStateChannel.send("AI has turned on");
    return;
  } else if (message.content.toLowerCase() === ".stopai") {
    server.botActive = false;
    console.log("Bot is now inactive");
    client.user.setPresence({ status: "offline" });
    if (botStateChannel) botStateChannel.send("AI has turned off");
    return;
  }
  if (!server.botActive) return;
  const userId = message.author.id;
  if (!server.messageHistory[userId]) {
    server.messageHistory[userId] = [];
    server.messageBuffer[userId] = "";
  }
  let userMessage = message.content;
  server.messageBuffer[userId] += userMessage + " ";
  const currentTime = Date.now();
  const lastMessage = server.lastMessageTime[userId] || 0;
  const timeDiff = currentTime - lastMessage;
  let delay = timeDiff < 3000 ? 0 : (5 + Math.random() * 10) * 1000;
  server.lastMessageTime[userId] = currentTime;
  if (server.typingTimeouts[userId])
    clearTimeout(server.typingTimeouts[userId]);
  server.typingTimeouts[userId] = setTimeout(async () => {
    try {
      const fullMessage = server.messageBuffer[userId].trim();
      if (!fullMessage) return;
      server.messageHistory[userId].push({
        role: "user",
        content: fullMessage,
      });
      server.messageBuffer[userId] = "";
      if (server.messageHistory[userId].length > 1000)
        server.messageHistory[userId].shift();
      let botReply = "";
      if (
        fullMessage.toLowerCase().includes("search") ||
        fullMessage.toLowerCase().includes("find")
      ) {
        const searchQuery = fullMessage.replace(/search|find/i, "").trim();
        botReply = await performWebSearch(searchQuery);
      } else {
        const dynamicOpenAI = new OpenAI({ apiKey: server.serverOpenAIKey });
        const completion = await dynamicOpenAI.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: prompt },
            ...server.messageHistory[userId],
          ],
        });
        botReply = completion.choices[0].message.content.trim();
      }
      if (server.messageHistory[userId].length > 1) {
        let lastBotResponse =
          server.messageHistory[userId][
            server.messageHistory[userId].length - 2
          ].content;
        if (botReply === lastBotResponse)
          botReply = "bruh idk what to say lol 😭";
      }
      if (message.guild) {
        message.reply(botReply);
      }
    } catch (error) {
      console.error(error);
    }
  }, delay);
});

function performWebSearch(query) {
  return `Search result for: ${query}`;
}

const app = express();
app.get("/", (req, res) => {
  res.send("Bot is alive!");
});

app.get("/ping", (req, res) => {
  res.send("Pong");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port 3000");
});

client.login(process.env.DISCORD_BOT_TOKEN);
