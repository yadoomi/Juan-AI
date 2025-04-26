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
    new SlashCommandBuilder().setName('key').setDescription('Set the OpenAI API key for the server').addStringOption(option => option.setName('key').setDescription('Your OpenAI API key').setRequired(true)),
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
  } catch (error) {
    console.error('Error registering global commands:', error)
  }
}

client.on('ready', async () => {
  console.log('Version: 1.7.1')
  await registerCommands()
})

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return
  const { commandName, guildId, user } = interaction

  if (!serverData[guildId]) initializeServer(guildId)
  const server = serverData[guildId]

  if (!['optin', 'optout'].includes(commandName)) {
    if (!(interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
        interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) ||
        interaction.user.id === interaction.guild.ownerId)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true })
    }
  }

  const botStateChannels = interaction.guild.channels.cache.filter(
    (channel) => channel.isTextBased?.() && channel.name.toLowerCase().includes('bot-state')
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
      client.user.setPresence({ status: 'online', activities: [{ name: 'AI without the use of Shapes!', type: 'PLAYING' }] })
      botStateChannels.forEach(ch => {
        if (ch.permissionsFor(interaction.guild.roles.everyone).has(PermissionFlagsBits.SendMessages)) ch.send('AI has turned on')
      })
      await interaction.editReply({ content: 'AI is now active.' })
    }

    if (commandName === 'stopai') {
      server.botActive = false
      client.user.setPresence({ status: 'offline' })
      botStateChannels.forEach(ch => {
        if (ch.permissionsFor(interaction.guild.roles.everyone).has(PermissionFlagsBits.SendMessages)) ch.send('AI has turned off')
      })
      await interaction.editReply({ content: 'AI is now inactive.' })
    }

    if (commandName === 'wipememory') {
      server.messageHistory = {}
      server.messageBuffer = {}
      server.lastMessageTime = {}
      server.typingTimeouts = {}
      server.memory = []
      botStateChannels.forEach(ch => {
        if (ch.permissionsFor(interaction.guild.roles.everyone).has(PermissionFlagsBits.SendMessages)) ch.send('AI memory has been wiped.')
      })
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
  if (message.author.bot) return
  if (!message.guild) return

  if (!message.channel.permissionsFor(message.guild.roles.everyone).has(PermissionFlagsBits.SendMessages)) return

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
      server.messageBuffer[displayName] = ''

      const allImageUrls = [...message.attachments.values()].filter(a => a.contentType?.startsWith('image/')).map(a => a.url)

      const dynamicOpenAI = new OpenAI({ apiKey: server.serverOpenAIKey })
      const messages = [
        { role: 'system', content: prompt },
        ...server.messageHistory[displayName],
      ]

      if (allImageUrls.length) {
        allImageUrls.forEach(url => {
          const imageMsg = {
            role: 'user',
            content: [
              { type: 'text', text: fullMessage },
              { type: 'image_url', image_url: { url } }
            ]
          }
          messages.push(imageMsg)
          server.messageHistory[displayName].push(imageMsg)
        })
      } else {
        const textMsg = { role: 'user', content: fullMessage }
        messages.push(textMsg)
        server.messageHistory[displayName].push(textMsg)
      }

      const completion = await dynamicOpenAI.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
      })

      let botReply = completion.choices[0].message.content.trim()
      if (botReply.length > 2000) {
        server.messageHistory[displayName].push({
          role: 'assistant',
          content: 'that message was too long to be sent to discord',
        })
        server.messageHistory[displayName].push({
          role: 'user',
          content: 'pls say that again but keep it under 2000 characters',
        })

        const redo = await dynamicOpenAI.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: prompt },
            ...server.messageHistory[displayName],
          ]
        })
        botReply = redo.choices[0].message.content.trim()
      }

      const originalMessage = await message.channel.messages.fetch(message.id).catch(() => null)
      if (!originalMessage) return

      if (server.messageHistory[displayName].length >= 15) {
        message.reply(botReply)
      } else {
        message.channel.send(botReply)
      }

      server.messageHistory[displayName].push({ role: 'assistant', content: botReply })
    } catch (error) {
      console.error('Error fetching from OpenAI:', error)
      message.reply('either you sent this before my memory went boom so idk what to say, or u didnt put a key yet\ud83d\udca5\ud83e\uddf7\ud83d\udd11')
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
  }
}

console.log(process.env.DISCORD_BOT_TOKEN)
client.login(process.env.DISCORD_BOT_TOKEN)
