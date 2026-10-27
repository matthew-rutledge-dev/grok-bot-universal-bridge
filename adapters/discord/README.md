# discord adapter

Status: **working** (Gateway in, callback out, attachments, local-planner hop, voice). Remaining gaps against the existing Discord bridge are listed at the end.

* **Matches.** Guild messages match `{ "guild": "<id>", "channel": "<id>" }`. DMs match `{ "dm": "true" }`. Actor = user id, groups = role ids, addressed = the bot was mentioned (DMs are always addressed).
* **Bots.** Messages from bots are ignored unless `ignoreBots` is `false`.
* **Prompt.** The compact grammar of the existing bridge: `Discord #<channel> from <label>[ (N attachments)]: <text>` + `⟂ d:<slug>:<msgId> u=<user> c=<channel> [g=<guild>] [map=<agent>] [a=<url>]...`. `slug` comes from the route. An attachment-only message has no `: text` part.
* **While held.** Posts ONE reply, "Bot is waking up, holding your message…", and later edits it to "Delivered. The bot is on it." or "❌ Couldn't reach the bot, please try again." It never posts once per retry.

## Attachments

* **Inbound** (same as today): nothing is downloaded. Up to 10 refs `{ url, filename?, contentType?, size? }` (Discord CDN `url`, fallback `proxyURL`) go in the trailer as `a=<url>` and in `metadata.attachments`. **Voice messages** are attachments (`audio/ogg`), so they arrive the same way.
* **Callback files**: `attachments: [{ filename, contentType?, data: "<base64>" } | { url: "https://…", filename?, contentType? }]`, exactly one of `data`/`url` each. The bridge fetches `url` (15 s timeout, https only), checks the MIME allowlist (images, mp4/webm, mp3/ogg/wav, PDF, Office/OpenDocument/RTF/CSV/TSV, text/code, zip/tar/gz/7z/rar; never exe/msi/dmg/iso) and the caps (8 MiB each, 25 MiB total, 10 files; enforced while streaming, not only from `content-length`). Errors: 415 `unsupported_media_type`, 400 `attachment_too_large` / `too_many_attachments` / `invalid_attachment` / `invalid_attachment_url`, 502 `attachment_fetch_failed`. The channel allowlist is checked before anything is fetched.
* **Audit**: `action: "attachment"` lines carry only count, total bytes, kinds (`image,text,…`) and the outcome/error code. Never filenames, URLs or content.
* `attachments.allowHttpHosts` lets a **loopback** host serve plain http (tests and the local smoke run's mock CDN). Any other host is refused at startup.

## Callback

`POST /discord/callback`, with `Authorization: Bearer <token>` or `x-callback-token` (never `?token=`). Body:

```json
{ "channelId": "222222222222222222", "content": "text", "replyToMessageId": "…", "statusMessageId": "…", "attachments": [], "threadContent": "optional log" }
```

`content` or `attachments` is required. `statusMessageId` (or, for a planner reply, the remembered "Working on it." message for `replyToMessageId`) is edited instead of posting; if that edit fails the reply is posted as a new message. `threadContent` (max 6000) starts a "Planner log" thread on the reply. The target channel must be in an enabled route or be a DM channel that already passed the allowlist. Content over 2000 characters is split.

## Local-planner hop

A route with `"handler": "local-planner"` does not wake the agent (`agent` is still required and only labels the audit line). For an allowlisted message the bridge:

1. replies once with `Working on it. (0s)` and edits the elapsed time every 5 s (stops after `planner.pulseMaxMs`, default 30 min);
2. POSTs the planner (`planner.urlRef`, bearer `planner.tokenRef`) with `messageId` (the real Discord id), `callbackUrl` and `statusMessageId` on the query string and in the body, plus `userPrompt`, `imagePath`/`referenceImagePath`/`imagePaths` (first two attachment URLs), `channelId`, `slug`, `dryRun: false`. Any `token` on the configured URL's query string is removed;
3. never aborts that call (the listener may hold it until the job ends).

Accepted reacts ✅ and leaves the message for the planner's callback (success or failure text). Not configured / bad URL / 401 / 403 / 404 edits it to "Couldn't start that.". A dropped connection or timeout is a warning only: no red X, and the late callback still edits the message. `planner.callbackUrl` overrides the callback URL handed to the planner (default: this bridge's public `/discord/callback`).

## Voice

Off unless `voice.enabled`. Only channel ids in `voice.channels` can be joined. Both routes use the callback token.

* `POST /discord/voice/play` `{ channelId, text?, voice?, bed? }`: no `text` plays a 2 s tone; `text` (max 240) is spoken by local Piper (`voice.piperHostRef`/`piperPortRef`, Wyoming protocol) or, with `voice: "grok" | "grok-voice-latest" | "grok-voice-3.0"`, Grok Voice (`voice.grokApiKeyRef`). `bed: true` mixes a quiet music bed. 409 while a stream is open.
* `POST /discord/voice/stream` `{ op: "open", channelId }`, `{ op: "add", id, text, voice? }` (gain 1, one-shot), `{ op: "add", id, audioBase64 }` (16-bit PCM wav up to 3 min; loops at gain 0.25 by default; `loop`, `gain` override), `{ op: "remove", id }`, `{ op: "status" }`, `{ op: "close" }`.
* Errors: 400 `channel_id_required` / `voice_engine` / `not_a_voice_channel` / `wav_format` / `audio_too_long` / `layer_source` / `layer_id_required`, 403 `voice_channel_not_allowlisted`, 409 `voice_stream_open` / `voice_stream_closed`, 503 `voice_disabled` / `piper_not_configured` / `grok_voice_not_configured`, 502 otherwise. Audit: `action: "voice"` with outcome and code only, never the spoken text.

## Bot setup

Intents: Guilds, Guild Messages, Message Content, Direct Messages, Guild Voice States. Permissions: View Channel, Send Messages, Read Message History, Attach Files, Add Reactions, Create Public Threads, Send Messages in Threads, and Connect + Speak for voice.

Secrets (all `env:` / `file:` refs): `tokenRef`, `callbackTokenRef`, `planner.urlRef`, `planner.tokenRef`, `voice.piperHostRef`, `voice.piperPortRef`, `voice.grokApiKeyRef`.

## Not ported yet

* multipart/form-data callbacks (JSON base64/url only);
* callbacks addressed by `userId` (opening a DM): reply to a DM channel that already passed the allowlist instead;
* the Grok Build chat-hop variant of the planner (`/chat` + `profile`);
* the planner working-message map is in memory: after a restart mid-job the callback posts a new reply instead of editing.
