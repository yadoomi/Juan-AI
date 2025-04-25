const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js')
const { OpenAI } = require('openai')
const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice')
require('dotenv').config()
const fs = require('fs')

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
})

let serverData = {}
const prompt = fs.readFileSync('./prompt.txt', 'utf-8')

const registerCommands = async () => {
  console.log('Registering Bot Commands...')
  const commands = [
    new SlashCommandBuilder()
      .setName('join')
      .setDescription('Bot joins a voice channel and chats via TTS')
      .addStringOption(option =>
        option.setName('channel')
          .setDescription('Voice channel name')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('key')
      .setDescription('Set the OpenAI API key for the server')
      .addStringOption(option =>
        option.setName('key')
          .setDescription('Your OpenAI API key')
          .setRequired(true)
      ),
    new SlashCommandBuilder().setName('currentkey').setDescription('Check the stored OpenAI API key'),
    new SlashCommandBuilder().setName('startai').setDescription('Turn on the AI bot'),
    new SlashCommandBuilder().setName('stopai').setDescription('Turn off the AI bot'),
    new SlashCommandBuilder().setName('wipememory').setDescription('Wipe the AI’s memory'),
    new SlashCommandBuilder().setName('optout').setDescription('Opt out of AI interactions'),
    new SlashCommandBuilder().setName('optin').setDescription('Opt back in to AI interactions')
  ].map(cmd => {
    if (!['optout', 'optin'].includes(cmd.name)) {
      cmd.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    }
    return cmd.toJSON()
  })
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN)
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands })
  } catch (error) {
    console.error('Error registering global commands:', error)
  }
}

client.on('ready', async () => {
  console.log('Version: 1.9')
  await registerCommands()
})

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand() || !interaction.guild) return
  const { commandName, guildId, user, member } = interaction

  if (!serverData[guildId]) {
    serverData[guildId] = {
      botActive: false,
      messageHistory: {},
      lastMessageTime: {},
      messageBuffer: {},
      typingTimeouts: {},
      serverOpenAIKey: null,
      memory: [],
      ignoredUsers: new Set(),
    }
  }
  const server = serverData[guildId]

  if (commandName === 'join') {
    const vcName = interaction.options.getString('channel', true)
    const hasUserPerm =
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.Connect) ||
      member.permissions.has(PermissionFlagsBits.Speak) ||
      user.id === interaction.guild.ownerId
    if (!hasUserPerm) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true })
    }
    const vc = interaction.guild.channels.cache
      .filter(ch => ch.isVoiceBased())
      .find(ch => ch.name.toLowerCase() === vcName.toLowerCase())
    if (!vc) {
      return interaction.reply({ content: `Voice channel "${vcName}" not found.`, ephemeral: true })
    }
    const everyonePerms = vc.permissionsFor(interaction.guild.roles.everyone)
    if (!everyonePerms.has(PermissionFlagsBits.Connect)) {
      return interaction.reply({ content: `I can't connect to ${vc.name}.`, ephemeral: true })
    }
    const connection = joinVoiceChannel({
      channelId: vc.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator
    })
    await interaction.reply({ content: `Joined ${vc.name}!` })
    const canSpeak = everyonePerms.has(PermissionFlagsBits.Speak)
    const player = createAudioPlayer()
    connection.subscribe(player)
    connection.receiver.speaking.on('start', async userId => {
      if (server.ignoredUsers.has(userId)) return
      const audioBuffer = await captureAudio(userId)
      const transcript = await transcribeAudio(audioBuffer, server.serverOpenAIKey)
      const replyText = await getAIReply(transcript, server, userId)
      if (canSpeak) {
        player.play(createAudioResource(await synthesizeTTS(replyText)))
      } else {
        vc.send(replyText)
      }
    })
    return
  }

  if (!['optin', 'optout'].includes(commandName)) {
    const hasPerms =
      interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
      interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) ||
      user.id === interaction.guild.ownerId
    if (!hasPerms) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true })
    }
  }

  const botStateChannels = interaction.guild.channels.cache.filter(
    channel => channel.isTextBased?.() && channel.name.toLowerCase().includes('bot-state')
  )

  try {
    await interaction.deferReply({ ephemeral: ['key', 'currentkey'].includes(commandName) })

    if (commandName === 'key') {
      server.serverOpenAIKey = interaction.options.getString('key')
      await interaction.editReply({ content: 'API key has been set.' })
    }

    if (commandName === 'currentkey') {
      if (!server.serverOpenAIKey) return interaction.editReply({ content: 'No API key set.' })
      const maskedKey = server.serverOpenAIKey.slice(0, 5) + '*****' + server.serverOpenAIKey.slice(-5)
      await interaction.editReply({ content: `Stored API key: \`${maskedKey}\`` })
    }

    if (commandName === 'startai') {
      server.botActive = true
      client.user.setPresence({ status: 'online', activities: [{ name: 'an AI without the use of Shapes!', type: 'PLAYING' }] })
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

    if (commandName === 'optout') {
      server.ignoredUsers.add(user.id)
      await interaction.editReply({ content: 'You have opted out of AI interactions.' })
    }

    if (commandName === 'optin') {
      server.ignoredUsers.delete(user.id)
      await interaction.editReply({ content: 'You have opted back into AI interactions.' })
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

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return
  const guildId = message.guild.id
  initializeServer(guildId)
  const server = serverData[guildId]
  if (!server.botActive || server.ignoredUsers.has(message.author.id)) return
  const member = await message.guild.members.fetch(message.author.id).catch(() => null)
  const displayName = member ? member.displayName : message.author.username
  const userMessage = `${displayName}: ${message.content}`
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
      const dynamicOpenAI = new OpenAI({ apiKey: server.serverOpenAIKey })
      const completion = await dynamicOpenAI.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'system', content: prompt }, ...server.messageHistory[displayName] ] })
      let botReply = completion.choices[0].message.content.trim()
      if (botReply.length > 2000) {
        console.error('Message too long (2000+ characters), telling AI to redo message but shorter.')
        server.messageHistory[displayName].push({ role: 'assistant', content: 'that message was too long to be sent to discord' })
        server.messageHistory[displayName].push({ role: 'user', content: 'pls say that again but keep it under 2000 characters' })
        const redo = await dynamicOpenAI.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: prompt }, ...server.messageHistory[displayName] ] })
        botReply = redo.choices[0].message.content.trim()
      }
      const originalMessage = await message.channel.messages.fetch(message.id).catch(() => null)
      if (!originalMessage) return
      if (server.messageHistory[displayName].length >= 15) message.reply(botReply)
      else message.channel.send(botReply)
      server.messageHistory[displayName].push({ role: 'assistant', content: botReply })
    } catch (error) {
      console.error('Error fetching from OpenAI:', error)
      message.reply('either you sent this before my memory went boom so idk what to say, or u didnt put a key yet💥🤷‍♂️🗝️')
    }
  }, delay)
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
      ignoredUsers: new Set(),
    }
    console.log('Initialized data for server ${guildId}')
  }
}

async function captureAudio(userId) {}
async function transcribeAudio(buffer, key) {}
async function getAIReply(text, server, userId) {}
async function synthesizeTTS(text) {}

client.login(process.env.DISCORD_BOT_TOKEN)
