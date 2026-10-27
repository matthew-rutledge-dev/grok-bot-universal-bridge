# discord adapter

Status: **working** (Gateway in, callback out incl. multipart and DM-by-user, attachments, local-planner and chat hops, voice). Voice on a real Discord channel is **pending live** (see [docs/VOICE-LIVE-TEST.md](../../docs/VOICE-LIVE-TEST.md)).

* **Matches.** Guild messages match `{ "guild": "<id>", "channel": "<id>" }`. DMs match `{ "dm": "true" }`. Actor = user id, groups = role ids, addressed = the bot was mentioned (DMs are always addressed).
* **Bots.** Messages from bots are ignored unless `ignoreBots` is `false`.
* **Prompt.** The compact grammar of the existing bridge: `Discord #<channel> from <label>[ (N attachments)]: <text>` + `⟂ d:<slug>:<msgId> u=<user> c=<channel> [g=<guild>] [map=<agent>] [a=<url>]...`. `slug` comes from the route. An attachment-only message has no `: text` part.
* **While held.** Posts ONE reply, "Bot is waking up, holding your message…", and later edits it to "Delivered. The bot is on it." or "❌ Couldn't reach the bot, please try again." It never posts once per retry.

## Attachments

* **Inbound** (same as today): nothing is downloaded. Up to 10 refs `{ url, filename?, contentType?, size? }` (Discord CDN `url`, fallback `proxyURL`) go in the trailer as `a=<url>` and in `metadata.attachments`. **Voice messages** are attachments (`audio/ogg`), so they arrive the same way.
* **Callback files**: `attachments: [{ filename, contentType?, data: "<base64>" } | { url: "https://…", filename?, contentType? }]`, exactly one of `data`/`url` each. The bridge fetches `url` (15 s timeout, https only; redirects followed by hand, at most 3, every hop re-checked; private, loopback, link-local, CGNAT, benchmark 198.18.0.0/15, NAT64 64:ff9b::/96 and IPv4-compatible/-mapped IPv6 targets, literal or via DNS, are refused unless listed in `allowHttpHosts`). DNS is resolved once per hop and the connection goes to the address that was checked (every answer must be public), and the socket's remote address is checked again after connect, so a rebinding DNS answer can't swap in a private target. Filenames ending in exe/msi/dmg/iso/appimage/bat/cmd/scr/com are refused whatever MIME type is claimed. It checks the MIME allowlist (images, mp4/webm, mp3/ogg/wav, PDF, Office/OpenDocument/RTF/CSV/TSV, text/code, zip/tar/gz/7z/rar; never exe/msi/dmg/iso) and the caps (8 MiB each, 25 MiB total, 10 files; both enforced while streaming, not only from `content-length`). Errors: 415 `unsupported_media_type`, 400 `attachment_too_large` / `too_many_attachments` / `invalid_attachment` / `invalid_attachment_url`, 502 `attachment_fetch_failed`. The channel allowlist is checked before anything is fetched.
* **Audit**: `action: "attachment"` lines carry only count, total bytes, kinds (`image,text,…`) and the outcome/error code. Never filenames, URLs or content.
* `attachments.allowHttpHosts` lets a **loopback** host serve plain http (tests and the local smoke run's mock CDN). Any other host is refused at startup.

## Callback

`POST /discord/callback`, with `Authorization: Bearer <token>` or `x-callback-token` (never `?token=`). Body:

```json
{ "channelId": "222222222222222222", "content": "text", "replyToMessageId": "…", "statusMessageId": "…", "attachments": [], "threadContent": "optional log" }
```

`content` or `attachments` is required.

* **multipart/form-data** is accepted too: either a `payload_json` part (the JSON body above) and/or plain text fields (`channelId`, `userId`, `content`, `replyToMessageId`, `statusMessageId`, `threadContent`), plus file parts. Files go through the same filename/MIME rules and the same caps as JSON attachments (counted together: 10 files, 8 MiB each, 25 MiB total). At most 32 parts, text fields up to 64 KiB. Nothing is parsed before the token check. Errors: 400 `multipart_invalid` / `multipart_too_many_parts` / `multipart_field_too_large`.
* **DM by user**: `userId` instead of `channelId` opens a DM with that user, but only for ids in `dmCallbacks.allowUsers` (deny by default; snowflakes only, no wildcards). Errors: 400 when both `channelId` and `userId` are sent, 403 `user_not_allowlisted` (audited), 502 `dm_open_failed`. `statusMessageId` (or, for a planner reply, the remembered "Working on it." message for `replyToMessageId`) is edited instead of posting; if that edit fails the reply is posted as a new message. `threadContent` (max 6000) starts a "Planner log" thread on the reply. The target channel must be in an enabled route or be a DM channel that already passed the allowlist. Content over 2000 characters is split.

## Local-planner hop

A route with `"handler": "local-planner"` needs `callbackTokenRef` and a callback URL (`http.publicBaseUrl` or `planner.callbackUrl`), or startup fails. It does not wake the agent (`agent` is still required and only labels the audit line). For an allowlisted message the bridge:

1. replies once with `Working on it. (0s)` and edits the elapsed time every 5 s (stops after `planner.pulseMaxMs`, default 30 min);
2. POSTs the planner (`planner.urlRef`, bearer `planner.tokenRef`) with `messageId` (the real Discord id), `callbackUrl` and `statusMessageId` on the query string and in the body, plus `userPrompt`, `imagePath`/`referenceImagePath`/`imagePaths` (first two attachment URLs), `channelId`, `slug`, `dryRun: false`. Any `token`, `access_token` or `key` on the configured URL's query string is removed;
3. never aborts that call (the listener may hold it until the job ends).

**Chat hop.** A route with `"handler": "grokbuild-chat"` and a `profile` (letters, digits, `._-`, max 64) does the same, but POSTs the planner's `/chat` URL (`planner.chatUrlRef`, default: `planner.urlRef` with `/plan` swapped for `/chat`) with `profile` and the attachment refs (`imagePath` empty). It doesn't post "Working on it." straight away: that waits `planner.chatWorkingDelayMs` (default 15 s), and a callback that arrives first is posted as a normal reply. Audit `type: "chat_hop"`.

**Restart-safe.** The working-message map (which reply to edit for which message) is saved to `<dataDir>/discord-planner-status.json` (mode 600, atomic writes, entries older than 24 h dropped on load), so a callback after a restart still edits the original "Working on it." message.

Accepted reacts ✅ and leaves the message for the planner's callback (success or failure text). Not configured / bad URL / 401 / 403 / 404 edits it to "Couldn't start that.". A dropped connection or timeout is a warning only: no red X, and the late callback still edits the message. `planner.callbackUrl` overrides the callback URL handed to the planner (default: this bridge's public `/discord/callback`).

## Voice

Off unless `voice.enabled`. Only channel ids in `voice.channels` can be joined. Both routes use the callback token.

* `POST /discord/voice/play` `{ channelId, text?, voice?, bed? }`: no `text` plays a 2 s tone; `text` (max 240) is spoken by local Piper (`voice.piperHostRef`/`piperPortRef`, Wyoming protocol) or, with `voice: "grok" | "grok-voice-latest" | "grok-voice-3.0"`, Grok Voice (`voice.grokApiKeyRef`). `bed: true` mixes a quiet music bed. 409 while a stream is open.
* `POST /discord/voice/stream` `{ op: "open", channelId }`, `{ op: "add", id, text, voice? }` (gain 1, one-shot), `{ op: "add", id, audioBase64 }` (16-bit PCM wav up to 3 min; loops at gain 0.25 by default; `loop`, `gain` override), `{ op: "remove", id }`, `{ op: "status" }`, `{ op: "close" }`.
* If Discord drops the connection while a stream is open (kicked, channel deleted, or no reconnect within 5 s) the stream is released (audit `stream_dropped`), so `play` works again instead of staying 409.
* One voice operation at a time: a play or stream open/close that overlaps another answers 409 `voice_busy` (the guild connection is shared). A stream holds at most 16 layers (400 `too_many_layers`).
* Errors: 400 `channel_id_required` / `voice_engine` / `not_a_voice_channel` / `wav_format` / `audio_too_long` / `layer_source` / `layer_id_required`, 403 `voice_channel_not_allowlisted`, 409 `voice_stream_open` / `voice_stream_closed`, 503 `voice_disabled` / `piper_not_configured` / `grok_voice_not_configured`, 502 otherwise. Audit: `action: "voice"` with outcome and code only, never the spoken text.

## Bot setup

Intents: Guilds, Guild Messages, Message Content, Direct Messages, Guild Voice States. Permissions: View Channel, Send Messages, Read Message History, Attach Files, Add Reactions, Create Public Threads, Send Messages in Threads, and Connect + Speak for voice.

Secrets (all `env:` / `file:` refs; a literal value in any `*Ref` is refused at startup): `tokenRef`, `callbackTokenRef`, `planner.urlRef`, `planner.chatUrlRef`, `planner.tokenRef`, `voice.piperHostRef`, `voice.piperPortRef`, `voice.grokApiKeyRef`.

## Pending live

* Voice against a real Discord channel: run `scripts/voice-live-check.mjs` after cutover ([checklist](../../docs/VOICE-LIVE-TEST.md)). CI covers voice through an in-memory port only.
