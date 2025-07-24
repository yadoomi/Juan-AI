const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js')
const { OpenAI } = require('openai')
require('dotenv').config()
const fs = require('fs')

const MAX_MEMORY = 150
const CONVO_ACTIVE_MS = 30 * 60 * 1000

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

const initializeServer = (guildId) => {
  if (!serverData[guildId]) {
    serverData[guildId] = {
      botActive: false,
      messageHistory: {},
      messageBuffer: {},
      lastMessageTime: {},
      typingTimeouts: {},
      activeChannels: new Map(),
      serverOpenAIKey: null,
      ignoredUsers: new Set(),
    }
  }
}

const registerCommands = async () => {
  const commands = [
    new SlashCommandBuilder().setName('key').setDescription('Set the OpenAI API key for the server').addStringOption(opt => opt.setName('key').setDescription('Your OpenAI API key').setRequired(true)),
    new SlashCommandBuilder().setName('currentkey').setDescription('Check the stored OpenAI API key'),
    new SlashCommandBuilder().setName('startai').setDescription('Turn on the AI bot'),
    new SlashCommandBuilder().setName('stopai').setDescription('Turn off the AI bot'),
    new SlashCommandBuilder().setName('wipememory').setDescription('Wipe the AI’s memory'),
    new SlashCommandBuilder().setName('optout').setDescription('Opt out of AI interactions'),
    new SlashCommandBuilder().setName('optin').setDescription('Opt back in to AI interactions'),
  ].map(cmd => {
    if (!['optout', 'optin'].includes(cmd.name)) {
      cmd.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    }
    return cmd.toJSON()
  })

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN)
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands })
  } catch (error) { console.error(error) }
}

client.on('ready', async () => {
  console.log('Version: 1.8')
  await registerCommands()
})

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return
  const { commandName, guildId, user } = interaction
  initializeServer(guildId)
  const server = serverData[guildId]
  if (!['optin', 'optout'].includes(commandName)) {
    if (!(interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
          interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) ||
          interaction.user.id === interaction.guild.ownerId)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true })
    }
  }
  const botStateChannels = interaction.guild.channels.cache.filter(ch => ch.isTextBased?.() && ch.name.toLowerCase().includes('bot-state'))
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
      client.user.setPresence({ status: 'online', activities: [{ name: 'AI without the use of Shapes!', type: 'PLAYING' }] })
      botStateChannels.forEach(ch => { if (ch.permissionsFor(interaction.guild.roles.everyone).has(PermissionFlagsBits.SendMessages)) ch.send('AI has turned on') })
      await interaction.editReply({ content: 'AI is now active.' })
    }
    if (commandName === 'stopai') {
      server.botActive = false
      client.user.setPresence({ status: 'offline' })
      botStateChannels.forEach(ch => { if (ch.permissionsFor(interaction.guild.roles.everyone).has(PermissionFlagsBits.SendMessages)) ch.send('AI has turned off') })
      await interaction.editReply({ content: 'AI is now inactive.' })
    }
    if (commandName === 'wipememory') {
      server.messageHistory = {}
      server.messageBuffer = {}
      server.lastMessageTime = {}
      server.typingTimeouts = {}
      server.activeChannels.clear()
      botStateChannels.forEach(ch => { if (ch.permissionsFor(interaction.guild.roles.everyone).has(PermissionFlagsBits.SendMessages)) ch.send('AI memory has been wiped.') })
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
    try { await interaction.editReply({ content: 'There was an error with the command.' }) } catch {}
  }
})

client.on('messageCreate', async (message) => {
  if (!message.guild) return
  if (!message.channel.permissionsFor(message.guild.roles.everyone).has(PermissionFlagsBits.SendMessages)) return
  const guildId = message.guild.id
  const channelId = message.channel.id
  initializeServer(guildId)
  const server = serverData[guildId]
  if (!server.botActive || server.ignoredUsers.has(message.author.id)) return

  let displayName
  if (message.author.bot) {
    try {
      const botMem = await message.guild.members.fetch(client.user.id)
      displayName = botMem ? botMem.displayName : client.user.username
    } catch {
      displayName = client.user.username
    }
  } else {
    try {
      const mem = await message.guild.members.fetch(message.author.id)
      displayName = mem ? mem.displayName : message.author.username
    } catch {
      displayName = message.author.username
    }
  }
  console.log(`[${message.guild.name} | #${message.channel.name} | ${displayName}]: ${message.content}`)

  if (!message.author.bot) {
    const now = Date.now()
    const activeUntil = server.activeChannels.get(channelId) || 0
    const userMentionedBot = message.mentions.has(client.user.id)

    if (userMentionedBot) server.activeChannels.set(channelId, now + CONVO_ACTIVE_MS)

    if (!userMentionedBot && now >= activeUntil) return

    if (!server.messageHistory[channelId]) server.messageHistory[channelId] = []
    if (!server.messageBuffer[channelId]) server.messageBuffer[channelId] = ''

    const normalizedNewMsg = message.content.trim().toLowerCase()
    const recentUserMessages = server.messageHistory[channelId]
      .filter(m => m.role === 'user' && m.content)
      .slice(-30)

    const userRecentMessages = []
    for (let i = recentUserMessages.length - 1; i >= 0; i--) {
      const msg = recentUserMessages[i]
      let contentText = ''
      if (typeof msg.content === 'string') contentText = msg.content
      else if (Array.isArray(msg.content)) contentText = msg.content.map(p => (p.type === 'text' && typeof p.text === 'string') ? p.text : '').join(' ')
      contentText = contentText.toLowerCase()
      if (contentText.startsWith(`${displayName.toLowerCase()}:`)) {
        userRecentMessages.push(contentText)
        if (userRecentMessages.length >= 3) break
      }
    }
    server.messageBuffer[channelId] += `${displayName}: ${message.content} `
    if (userRecentMessages.some(m => m.includes(normalizedNewMsg) || normalizedNewMsg.includes(m))) {
      const textMsg = { role: 'user', content: `${displayName}: ${message.content}` }
      server.messageHistory[channelId].push(textMsg)
      while (server.messageHistory[channelId].length > MAX_MEMORY) server.messageHistory[channelId].shift()
      return
    }

    if (server.typingTimeouts[channelId]) clearTimeout(server.typingTimeouts[channelId])

    server.typingTimeouts[channelId] = setTimeout(async () => {
      try {
        const fullMessage = server.messageBuffer[channelId].trim()
        if (!fullMessage) return
        server.messageBuffer[channelId] = ''

        const allImageUrls = [...message.attachments.values()]
          .filter(a => a.contentType?.startsWith('image/')).map(a => a.url)

        const dynamicOpenAI = new OpenAI({ apiKey: server.serverOpenAIKey })
        let messages = [{ role: 'system', content: prompt }, ...server.messageHistory[channelId]]

        if (allImageUrls.length) {
          allImageUrls.forEach(url => {
            const imgMsg = { role: 'user', content: [{ type: 'text', text: fullMessage }, { type: 'image_url', image_url: { url } }] }
            messages.push(imgMsg)
            server.messageHistory[channelId].push(imgMsg)
          })
        } else {
          const textMsg = { role: 'user', content: fullMessage }
          messages.push(textMsg)
          server.messageHistory[channelId].push(textMsg)
        }

        while (server.messageHistory[channelId].length > MAX_MEMORY) server.messageHistory[channelId].shift()

        const completion = await dynamicOpenAI.chat.completions.create({ model: 'gpt-4o-mini', messages })

        let botReply = completion.choices[0].message.content.trim()

        if (botReply.length > 2000) {
          server.messageHistory[channelId].push({ role: 'assistant', content: 'that message was too long to be sent to discord' })
          server.messageHistory[channelId].push({ role: 'user', content: 'pls say that again but keep it under 2000 characters' })
          while (server.messageHistory[channelId].length > MAX_MEMORY) server.messageHistory[channelId].shift()
          const redo = await dynamicOpenAI.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: prompt }, ...server.messageHistory[channelId]] })
          botReply = redo.choices[0].message.content.trim()
        }

        const origMsg = await message.channel.messages.fetch(message.id).catch(() => null)
        if (!origMsg) return

        const sentMsg = await message.channel.send(botReply)
        let botDisplayName = client.user.username
        try {
          const botMem = await message.guild.members.fetch(client.user.id)
          botDisplayName = botMem?.displayName || botDisplayName
        } catch {}
        console.log(`[${message.guild.name} | #${message.channel.name} | ${botDisplayName}]: ${botReply}`)
        server.messageHistory[channelId].push({ role: 'assistant', content: botReply })
        while (server.messageHistory[channelId].length > MAX_MEMORY) server.messageHistory[channelId].shift()
      } catch (error) {
        console.error('Error fetching from OpenAI:', error)
        message.reply('either you sent this before my memory went boom so idk what to say, or u didnt put a key yet💥🧷🔑')
      }
    }, 5000)
  }
})

client.on('messageDelete', (deletedMessage) => {
  if (!deletedMessage.guild) return
  const guildId = deletedMessage.guild.id
  const channelId = deletedMessage.channel.id
  if (!serverData[guildId]) return
  const server = serverData[guildId]
  if (!server.messageHistory[channelId]) return
  server.messageHistory[channelId] = server.messageHistory[channelId].filter(msg => !msg.content?.includes(deletedMessage.content))
})

client.login(process.env.DISCORD_BOT_TOKEN)
