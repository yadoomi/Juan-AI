const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js')
const { OpenAI } = require('openai')
require('dotenv').config()
const fs = require('fs')

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
})

let serverData = {}
const prompt = fs.readFileSync('./prompt.txt', 'utf-8')

const registerCommands = async () => {
  const commands = [
    new SlashCommandBuilder()
      .setName('key')
      .setDescription('Set the OpenAI API key for the server')
      .addStringOption(option =>
        option.setName('key')
          .setDescription('Your OpenAI API key')
          .setRequired(true)),
    new SlashCommandBuilder().setName('currentkey').setDescription('Check the stored OpenAI API key'),
    new SlashCommandBuilder().setName('startai').setDescription('Turn on the AI bot'),
    new SlashCommandBuilder().setName('stopai').setDescription('Turn off the AI bot'),
    new SlashCommandBuilder().setName('wipememory').setDescription('Wipe the AI’s memory'),
  ].map(cmd => cmd.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages).toJSON())

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN)
  try {
    console.log('Registering global commands...')
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands })
    console.log('Global slash commands registered.')
  } catch (error) {
    console.error('Error registering global commands:', error)
  }
}

client.on('ready', async () => {
  console.log('Bot is ready')
  console.log('Version 1.5.7')
  await registerCommands()
})

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return
  const { commandName, guildId } = interaction

  if (
    !(
      interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
      interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) ||
      interaction.user.id === interaction.guild.ownerId
    )
  ) {
    return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true })
  }

  if (!serverData[guildId]) {
    serverData[guildId] = {
      botActive: false,
      messageHistory: {},
      lastMessageTime: {},
      messageBuffer: {},
      typingTimeouts: {},
      serverOpenAIKey: null,
      memory: [],
    }
  }

  const server = serverData[guildId]
  const botStateChannels = interaction.guild.channels.cache.filter(
    (channel) =>
      channel.isTextBased?.() &&
      channel.name.toLowerCase().includes('bot-state')
  )

  try {
    await interaction.deferReply({ ephemeral: true })

    if (commandName === 'key') {
      server.serverOpenAIKey = interaction.options.getString('key')
      await interaction.editReply({ content: 'API key has been set.' })
    }

    if (commandName === 'currentkey') {
      if (!server.serverOpenAIKey) {
        return interaction.editReply({ content: 'No API key set.' })
      }
      const maskedKey = server.serverOpenAIKey.slice(0, 5) + '*****' + server.serverOpenAIKey.slice(-5)
      await interaction.editReply({ content: `Stored API key: \`${maskedKey}\`` })
    }

    if (commandName === 'startai') {
      server.botActive = true
      client.user.setPresence({ status: 'online', activities: [{ name: 'AI without the use of Shapes!', type: 'PLAYING' }] })
      botStateChannels.forEach(ch => ch.send('AI has turned on'))
      await interaction.editReply({ content: 'AI is now active.' })
    }

    if (commandName === 'stopai') {
      server.botActive = false
      client.user.setPresence({ status: 'offline' })
      botStateChannels.forEach(ch => ch.send('AI has turned off'))
      await interaction.editReply({ content: 'AI is now inactive.' })
    }

    if (commandName === 'wipememory') {
      server.messageHistory = {}
      server.messageBuffer = {}
      server.lastMessageTime = {}
      server.typingTimeouts = {}
      server.memory = []
      botStateChannels.forEach(ch => ch.send('AI memory has been wiped.'))
      await interaction.editReply({ content: 'AI memory has been wiped.' })
    }
  } catch (error) {
    console.error(error)
    try {
      await interaction.editReply({ content: 'There was an error with the command.' })
    } catch (e) {
      console.error('Could not reply to interaction:', e)
    }
  }
})

const initializeServer = (guildId) => {
  if (!serverData[guildId]) {
    serverData[guildId] = {
      botActive: false,
      messageHistory: {},
      lastMessageTime: {},
      messageBuffer: {},
      typingTimeouts: {},
      serverOpenAIKey: null,
      memory: [],
    }
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return
  const guildId = message.guild.id

  initializeServer(guildId)
  const server = serverData[guildId]
  if (!server.botActive) return

  const member = await message.guild.members.fetch(message.author.id).catch(() => null)
  const displayName = member ? member.displayName : message.author.username
  const userMessage = `${displayName}: ${message.content}`

  console.log(`Message from ${displayName}: ${message.content}`)

  if (!server.messageHistory[displayName]) {
    server.messageHistory[displayName] = []
    server.messageBuffer[displayName] = ''
  }

  server.messageBuffer[displayName] += userMessage + ' '
  const currentTime = Date.now()
  const lastMessage = server.lastMessageTime[displayName] || 0
  const timeDiff = currentTime - lastMessage
  let delay = timeDiff < 3000 ? 0 : (5 + Math.random() * 10) * 1000
  server.lastMessageTime[displayName] = currentTime

  if (server.typingTimeouts[displayName]) clearTimeout(server.typingTimeouts[displayName])

  server.typingTimeouts[displayName] = setTimeout(async () => {
    try {
      const fullMessage = server.messageBuffer[displayName].trim()
      if (!fullMessage) return
      server.messageHistory[displayName].push({ role: 'user', content: fullMessage })
      server.messageBuffer[displayName] = ''

      console.log('Message sent to AI:')
      console.log(server.messageHistory[displayName])

      if (server.messageHistory[displayName].length > 100000) server.messageHistory[displayName].shift()

      let botReply = ''
      const dynamicOpenAI = new OpenAI({ apiKey: server.serverOpenAIKey })
      const completion = await dynamicOpenAI.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: prompt },
          ...server.messageHistory[displayName],
        ],
      })
      botReply = completion.choices[0].message.content.trim()

      if (server.messageHistory[displayName].length > 1) {
        let lastBotResponse = server.messageHistory[displayName][server.messageHistory[displayName].length - 2].content
        if (botReply === lastBotResponse) botReply = 'is anyone there?'
      }

      const originalMessage = await message.channel.messages.fetch(message.id).catch(() => null)
      if (!originalMessage) return

      if (server.messageHistory[displayName].length >= 15) {
        message.reply(botReply)
      } else {
        message.channel.send(botReply)
      }

      console.log(`[Channel: ${message.channel.name}] Bot response: ${botReply}`)
      server.messageHistory[displayName].push({ role: 'assistant', content: botReply })
    } catch (error) {
      console.error('Error fetching from OpenAI:', error)
      message.reply('u sent this right before my memory went boom and idk what u sent anymore and what i was going to say🤷‍♂️')
    }
  }, 5000)
})

client.on('messageDelete', (deletedMessage) => {
  const { guildId, author } = deletedMessage
  const displayName = deletedMessage.member?.displayName || author.username
  if (!serverData[guildId]) return
  const server = serverData[guildId]
  if (!server.messageHistory[displayName]) return
  server.messageHistory[displayName] = server.messageHistory[displayName].filter(
    (msg) => msg.content !== deletedMessage.content
  )
})

client.login(process.env.DISCORD_BOT_TOKEN)
