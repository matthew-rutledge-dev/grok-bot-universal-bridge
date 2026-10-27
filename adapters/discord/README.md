# discord adapter

Status: **working** (Gateway in, callback out). Parity gaps compared with the existing Discord bridge: attachments in callbacks, voice, and the local-planner hop.

* **Matches.** Guild messages match `{ "guild": "<id>", "channel": "<id>" }`. DMs match `{ "dm": "true" }`. Actor = user id, groups = role ids, addressed = the bot was mentioned (DMs are always addressed).
* **Bots.** Messages from bots are ignored unless `ignoreBots` is `false`.
* **Prompt.** The compact grammar of the existing bridge: `Discord #<channel> from <label>: <text>` + `⟂ d:<slug>:<msgId> u=<user> c=<channel> [g=<guild>] [map=<agent>] [a=<url>]...`. `slug` comes from the route.
* **While held.** Posts ONE reply, "Bot is waking up, holding your message…", and later edits it to "Delivered. The bot is on it." or "❌ Couldn't reach the bot, please try again." It never posts once per retry.
* **Callback.** `POST /discord/callback`, with `Authorization: Bearer <token>` or `x-callback-token`. Body:
  ```json
  { "channelId": "222222222222222222", "content": "text", "replyToMessageId": "…", "statusMessageId": "…" }
  ```
  `statusMessageId` edits that message (the single "Working on it" pattern). The target channel must be in an enabled route or be a DM channel that already passed the allowlist. Content over 2000 characters is split.
* **Bot setup.** Intents: Guilds, Guild Messages, Message Content, Direct Messages. Permissions: View Channel, Send Messages, Read Message History.
* **Secrets.** `tokenRef` (bot token) and `callbackTokenRef`.
