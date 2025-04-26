# Juan-AI
Juan AI is a discord bot that uses AI to respond to messages.

You will need a [OpenAI API key](https://platform.openai.com/api-keys) to do this, though they are cheap.

If the AI gets annoying, you can make the it ignore you using `/optout` and make it unignore you by doing `/optin`, both of these commands don't need any permissions.

To start using the bot you have to:
- 1  |  [Invite Juan to your Discord Server](https://discord.com/oauth2/authorize?client_id=1347680549807980707&permissions=8&integration_type=0&scope=bot),
- 2  |  Add a channel with `bot-state` in it's name.
- 2  |  Use the command `/key` and put in the value `key` your [OpenAI API key](https://platform.openai.com/api-keys).
- 3  |  Make sure you put in the correct key by doing `/currentkey` and checking if the key is your key,
- 4  |  Now all you have to do is run `/startai` to start the ai, and run `/stopai` to stop the ai.
- 5  |  If you want to wipe its memory then do `/wipememory`.

To do commands you have to have atleast one of these:
- Have the adminstrator permission
- Have the manage messages permission
- Be the server owner
