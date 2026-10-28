# Migrating from the older Discord bridge

This covers moving the older Discord bridge (`grok-bot-discord-bridge`, 0.2.14) to the universal bridge's `discord` adapter. Every feature of the old bridge is either ported, ported differently, or dropped for a stated reason (see the [parity table](#parity-table)). Real ids, agents and URLs stay in the host config, never in git. Every example here uses placeholders.

## 1. Convert the host config

```bash
node scripts/migrate-old-config.mjs \
  --security <old>/config/security.json --channel-map <old>/config/channel-map.json --env <old>/.env \
  --registry <host>/registry.json --seed <old>/config/user-directory.seed.json \
  --out-dir <host>/migrated --env-out <host>/migrated/discord-extra.env \
  --planner-handler <media planner handler name> [--planner-handler <its deprecated alias>]
```

* It reads `security.json`, `channel-map.json`, and the `.env` key names plus their **non-secret** values (ids, flags, policy, paths). Secret keys (`DISCORD_BOT_TOKEN`, `GROK_BOT_GATEWAY_TOKEN`, `GROK_BOT_SENDPROMPT_URL`, `CALLBACK_TOKEN`, `LOCAL_PLANNER_URL`, `LOCAL_PLANNER_TOKEN`, `SENDPROMPT_WAKE_URL`, `SENDPROMPT_WAKE_KEY`, `XAI_API_KEY`) are never read for their value. They become `env:NAME` refs, so the same `.env` keeps working.
* `--registry` reuses existing registry aliases, matched by `agentId`. An agent id with no alias becomes a new `sendprompt` entry in `registry.additions.json` (`urlRef: env:GROK_BOT_SENDPROMPT_URL`, `keyRef: env:GROK_BOT_GATEWAY_TOKEN`). Merge those into the host registry, or point them at the agent's webhook routine instead.
* `--gateway-url-ref <ref>` and `--gateway-token-ref <ref>` override those two refs (defaults: `env:GROK_BOT_SENDPROMPT_URL` and `env:GROK_BOT_GATEWAY_TOKEN`), for a host `.env` that uses other names, e.g. `--gateway-url-ref env:<YOUR_SENDPROMPT_URL_VAR> --gateway-token-ref file:/run/secrets/<token-file>`. The URL ref also applies to DM routes and to channel rows without their own `sendPromptUrl`. Only `env:NAME` or `file:/path` refs are accepted; a literal value exits 2 without echoing it.
* Write `file:` refs as **container paths** (for example `file:/run/secrets/<token-file>`), not host paths. The bridge resolves them inside its container, and the converter only checks that the path is absolute on whatever platform it runs on: on Windows a host path such as `file:C:\secrets\token` passes the check but won't exist in the container, and on Linux or macOS the same path is refused. Mount the secret read-only at the container path you wrote.
* A per-row `sendPromptUrl` (or `defaultSendPromptUrl`) can carry a secret. Its value is written only to `--env-out` (mode 600) as `DISCORD_SENDPROMPT_URL_<SLUG>=…`, and stdout shows the names only. Append that file to the host `.env`.
* Outputs: `discord.json` (the adapter config), `registry.additions.json`, `bridge.patch.json` (hold, wake, rate limit, adapter on/off) and `warnings.txt`, all mode 600. Without `--out-dir`, one JSON bundle goes to stdout.
* `--planner-handler` names the old `local_handler` value(s) of the media planner. Without it, a planner row converts to an agent route (warned), which is what the old bridge did for an unknown handler.
* Read `warnings.txt`. Anything the converter can't decide is listed there (voice channels, rows the old bridge refused anyway, a pinned guild, and so on).

## 2. Key mapping

### `.env`

| Old key | New key |
|---|---|
| `DISCORD_BOT_TOKEN` | `discord.tokenRef: "env:DISCORD_BOT_TOKEN"` |
| `CALLBACK_TOKEN` | `discord.callbackTokenRef: "env:CALLBACK_TOKEN"` |
| `CALLBACK_PATH` (`/callback`) | `discord.legacyPaths.callback: "/callback"`: the same handler also serves `/callback`, so the host's nginx shim can go away. The canonical path is `/discord/callback`. |
| `CALLBACK_BASE_URL` | `discord.planner.callbackUrl` = base + legacy path (what planner handlers post to). Agents get `http.publicBaseUrl` + `/discord/callback` in metadata. |
| `CALLBACK_RATE_LIMIT_PER_MIN` | bridge `callbackRateLimitPerMin` |
| `GROK_BOT_SENDPROMPT_URL`, `GROK_BOT_GATEWAY_TOKEN` | registry `deliver: { kind: "sendprompt", urlRef: "env:GROK_BOT_SENDPROMPT_URL", keyRef: "env:GROK_BOT_GATEWAY_TOKEN" }` (or a `webhook` routine) |
| `DISCORD_GUILD_ID` | the converter keeps only that guild (pin) |
| `DISCORD_ALLOWFROM` | added to every route's `allowActors` and to `dm.allowUsers` (the same union the old bridge used) |
| `DISCORD_ALLOW_ROLES` | added to every route's `allowGroups` |
| `DISCORD_ALLOW_CHANNELS` | a row outside the list becomes a disabled route; listed channels with no row go to `callbackChannels` |
| `DISCORD_OWNER_ID` | `dm.ownerIds` |
| `DISCORD_DM_POLICY` | `dm.policy` (`pairing` / `allowlist` / `disabled`) |
| `REQUIRE_MENTION_DEFAULT` | each route's `requireAddressed` (row → guild → this default, as before) |
| `WAKE_PROMPT_FORMAT` | `discord.wakePromptFormat` (`compact` default, `legacy` kept) |
| `LOCAL_PLANNER_URL`, `LOCAL_PLANNER_TOKEN` | `discord.planner.urlRef` / `tokenRef` (`env:` refs). The chat hop uses the same URL with `/plan` → `/chat`, or `planner.chatUrlRef`. |
| `SENDPROMPT_HOLD_MAX_SEC` | bridge `hold.maxSec` |
| `SENDPROMPT_HOLD_FILE` | bridge `dataDir` (`hold.json`). Old held hops are not imported. |
| `SENDPROMPT_WAKE_URL`, `_KEY`, `_HEADER` | bridge `wake.urlRef`, `wake.keyRef`, `wake.header` |
| `USER_DIRECTORY_FILE` | `<dataDir>/discord-user-directory.json` (same file format: copy the old file there to keep learned names) |
| `USER_DIRECTORY_SEED_FILE` / `config/user-directory.seed.json` | `discord.users.seedPath` (host-only file, mounted read-only) |
| `XAI_API_KEY` | `discord.voice.grokApiKeyRef: "env:XAI_API_KEY"` (Grok Voice, `voice: "grok"`) |
| `PIPER_HOST`, `PIPER_PORT` | `discord.voice.piperHostRef` / `piperPortRef`. The old defaults were `host.docker.internal` / `10200`, so set them if you relied on the defaults. |
| `HTTP_BIND`, `HTTP_PORT` | bridge `http.bind` / `http.port` (+ the compose `ports:` line). Keep `18083` if callers still use that port. |
| `HTTP_ONLY` | `adapters.discord.enabled: false` (no Gateway login; the other adapters still run) |
| `CHANNEL_MAP_PATH`, `SECURITY_CONFIG_PATH` | gone: one adapter config file (`adapters.discord.configPath`) |
| `LOCAL_PLANNER_POWERSHELL` | dropped: 0.2.14 never read it (only the stand-in `bin/local-planner-powershell.mjs` did); the hop is a plain HTTP POST |

### `security.json`

| Old key | New key |
|---|---|
| `version`, `description` | not needed |
| `ignoreBots` | `discord.ignoreBots` |
| `guilds.<id>.enabled` | route `enabled` (false for every row in that guild) |
| `guilds.<id>.allowFrom` | route `allowActors` (empty = nobody) |
| `guilds.<id>.allowRoles` | route `allowGroups` (empty = no role gate) |
| `guilds.<id>.allowChannels` | route enabled only if listed (when the list is non-empty); extra channels → `callbackChannels` |
| `guilds.<id>.requireMention` | route `requireAddressed` when the row doesn't set it |
| `guilds.<id>.ownerId` | `dm.ownerIds` (may run `!pair`) |
| `dm.policy` | `dm.policy` |
| `dm.allowFrom` | `dm.allowUsers` |
| `dm.ownerId` | `dm.ownerIds` |
| `dm.defaultAgentId` | `dm.defaultAgent` (registry alias) |
| `dm.agentsByUser { userId: agentId \| {agentId, alias} }` | `dmRoutes: [{ userId, agent, map? }]`. `map` keeps the old trailer `map=` value. |
| `dm.slug`, `dm.alias` | `dm.slug`, `dm.map` |
| `hostAdmins` | dropped: the old bridge never used it at runtime (one unused helper, no access, no command) |

DM semantics stay the same. A user with a `dmRoutes` entry reaches their own agent. Any other `dm.allowUsers` user, or a user an owner paired with `!pair <userId>` (policy `pairing`, memory only), gets `dm.defaultAgent`. With no default agent they are refused (`dm_no_agent`, as before). Under policy `pairing`, a stranger's DM gets the old "Not paired…" reply. `disabled` ignores every DM. **DM callbacks by `userId`** use the same allowlist: dmRoutes users, `dm.allowUsers`, `dm.ownerIds`, paired users, plus any explicit `dmCallbacks.allowUsers`. Deny by default.

### `channel-map.json` rows

| Old field | New |
|---|---|
| `channelId` (+ the guild from security.json) | route `match: { guild, channel }` (one route per guild when several are allowed) |
| `enabled` | route `enabled` |
| `slug` | route `slug` (trailer `d:<slug>:<id>`) |
| `alias` | registry alias (lowercased) and, when it differs, route `map` (trailer `map=`) |
| `agentId` | registry entry (reused by id if present) |
| `label` | route `label` |
| `requireMention` | route `requireAddressed` |
| `sendPromptUrl`, `defaultSendPromptUrl` | registry entry `deliver.urlRef` (`env:DISCORD_SENDPROMPT_URL_<SLUG>` / `env:DISCORD_DEFAULT_SENDPROMPT_URL`) |
| `primary_llm: "local"` + `wake_agent: false` + `local_handler: <the media planner's handler name>` (pass it, and its deprecated alias, with `--planner-handler`; the names are host-specific and kept out of git) | `handler: "local-planner"`: no agent wake |
| `primary_llm: "local"` + `wake_agent: false` + `harness: "grok-build"` + `profile` | `handler: "grokbuild-chat"`, `profile`: no agent wake. The empty alias and all-zero agentId are not needed (the converter labels it `local-hop-<slug>`). |
| `wake_agent: false` without a known handler or harness+profile | still an agent route, as in the old bridge (warned) |

## 3. Cutover checklist (host operator)

The universal bridge already runs in place of the old one, with the old container stopped. Run this on the live host to confirm parity, or after any reconfiguration.

1. **Stop old.** `cd <old dir> && docker compose down` (it stays on disk for rollback). Keep `.env`, `config/` and the old data volume.
2. **Convert.** Run the converter (section 1). Merge `discord.json` into `<host>/config/discord.json`, `registry.additions.json` into `<host>/registry.json`, the `bridge.patch.json` values into `<host>/config/bridge.json`, and `discord-extra.env` into `<host>/.env`. In `discord.json`, set `voice.enabled: true` and list the voice channel ids in `voice.channels`. Copy the seed to `<host>/config/user-directory.seed.json` and, optionally, the old learned `data/user-directory.json` into the bridge data volume as `discord-user-directory.json`.
3. **Planner proxy.** If the planner listener is only on host loopback, run `python3 scripts/planner-docker-proxy.py --network <new-compose-project>_default`. The old proxy hard-coded the old project's network name.

   **Host firewall.** If the host runs a firewall (for example ufw), allow the bridge's compose network to reach the host-side services it calls, here the planner proxy port. Otherwise planner and chat hops fail silently (the request just times out). Find the subnet with `docker network inspect <new-compose-project>_default --format '{{(index .IPAM.Config 0).Subnet}}'`, then for example `sudo ufw allow from <compose-subnet> to any port <planner-proxy-port> proto tcp`. Recheck after the compose network is recreated, since its subnet can change.
4. **Start new.** `docker compose up -d --force-recreate` with `adapters.discord.enabled: true`, then `node dist/src/main.js --check` in the container (`docker compose exec -T universal-bridge node dist/src/main.js --check`).
5. **Health.** `curl -sS http://127.0.0.1:<port>/healthz` shows `discordReady: true` and `health.discord.legacyCallbackPath: "/callback"`.
6. **Tests** (in Discord, from an allowlisted user):
   - [ ] **Guild channel wake:** a message (or mention, per `requireAddressed`) in each enabled channel route gets ✅ and the right agent answers.
   - [ ] **Each DM route:** each of the DM users DMs the bot, and each answer comes from that user's own agent. A non-listed user gets "Not paired…" (policy pairing).
   - [ ] **Pairing:** an owner runs `!pair <userId>`, then that user's DM reaches the default agent.
   - [ ] **Callback text:** `curl -H "Authorization: Bearer $CALLBACK_TOKEN" -H 'content-type: application/json' -d '{"channelId":"<channel>","content":"text"}' http://127.0.0.1:<port>/callback` (and `/discord/callback`) → 200, posted.
   - [ ] **Callback with attachment:** the same with `"attachments":[{"filename":"1x1.png","contentType":"image/png","data":"<base64>"}]`, and once with an `https` `url`.
   - [ ] **Multipart:** `curl -F channelId=<channel> -F content=multipart -F files=@shot.png …/callback` → 200 with the image.
   - [ ] **DM by userId:** `{"userId":"<dm user>","content":"hi"}` → 200 in their DM. An unlisted user → 403.
   - [ ] **Planner hop:** a message in the media planner channel → "Working on it. (Ns)" edited until the planner's callback replaces it. A planner timeout shows no red X.
   - [ ] **Chat hop:** a message in the local-LLM channel → typing, then a reply. "Working on it." appears only after 15 s (`planner.chatWorkingDelayMs`; set `0` for the old code's immediate message).
   - [ ] **Hold/wake:** with the agent's computer asleep, one "Bot is waking up…" status, then delivered (✅) after the wake hook fires.
   - [ ] **Voice:** `node scripts/voice-live-check.mjs --bridge env:VOICE_CHECK_BRIDGE_URL --token env:CALLBACK_TOKEN --channel env:VOICE_CHECK_CHANNEL --speech --drop` → `RESULT: PASS` (see [VOICE-LIVE-TEST.md](VOICE-LIVE-TEST.md)).
7. **Audit.** `data/audit.jsonl` shows `inbound allow`/`deliver ok`/`callback ok` lines with no message text, names or URLs.

## 4. Rollback

1. `docker compose stop universal-bridge` (or set `adapters.discord.enabled: false` and recreate, if the other adapters must keep running: only one process may log in with the Discord bot token).
2. `cd <old dir> && docker compose up -d` (use `up -d`, not `restart`, so `.env` is re-read). The old `.env`, `config/` and data volume are untouched by the migration.
3. `curl -sS http://127.0.0.1:18083/healthz` → `discordReady: true`. Restore the nginx `/callback` shim if it was removed.
4. Agents and planner handlers that were moved to `/discord/callback` must go back to the old `/callback` URL. The ones still on `/callback` keep working.

## Parity table

| Feature (old bridge) | Status |
|---|---|
| Gateway intents/partials (Guilds, GuildMessages, MessageContent, DirectMessages, GuildVoiceStates; Channel partial) | ported |
| Ignore bot authors (`ignoreBots`) | ported |
| Guild allowlist + `enabled` + `DISCORD_GUILD_ID` pin | ported differently: per-route `match.guild`; the converter applies the pin |
| Users `allowFrom` ∪ `DISCORD_ALLOWFROM` (empty = deny) | ported: route `allowActors` |
| Roles `allowRoles` ∪ `DISCORD_ALLOW_ROLES` | ported: route `allowGroups` |
| Channels `allowChannels` ∪ `DISCORD_ALLOW_CHANNELS` | ported: the converter disables unlisted rows |
| Channel-map row `enabled` / `agentId` / `alias` / `slug` / `label` | ported (registry alias + route `map`) |
| `requireMention` row → guild → `REQUIRE_MENTION_DEFAULT` | ported: `requireAddressed` |
| Per-row `sendPromptUrl` + `defaultSendPromptUrl` | ported differently: registry entry per agent (`deliver.urlRef`) |
| DM policy `pairing` / `allowlist` / `disabled` | ported (`dm.policy`) |
| `!pair <userId>` by owner (guild owner in guild, owner in DM), memory only | ported differently: any `dm.ownerIds` user, in a DM or any channel the bot sees; still memory only |
| "Not paired…" reply | ported |
| `dm.allowFrom`, `dm.defaultAgentId`, `dm.agentsByUser` (string or {agentId, alias}) | ported: `dm.allowUsers`, `dm.defaultAgent`, `dmRoutes` |
| `dm.slug`, `dm.alias` | ported: `dm.slug`, `dm.map` |
| `hostAdmins` | dropped (unused at runtime in the old bridge) |
| Compact wake prompt + trailer grammar | ported (same grammar) |
| `WAKE_PROMPT_FORMAT=legacy` (d: line + thin JSON) | ported (`wakePromptFormat`) |
| sendPrompt `metadata` (hop, discordMessageId/ChannelId/UserId/GuildId, discordUser, callbackBaseUrl/Path, attachments) | ported (`source` is `"discord"`, set by the core) |
| User directory (learn names, seed labels win, mode-600 atomic debounced file) + interaction users | ported (`users.seedPath`, `discord-user-directory.json`); now bounded (`users.max`, default 5000) and learns only allowlisted authors |
| Inbound attachments as CDN refs (max 10, `a=` trailer, metadata) | ported |
| Callback auth header-only (`Bearer` / `x-callback-token`), `?token=` refused | ported (both already refused `?token=`) |
| `POST /callback` path | ported differently: `/discord/callback` plus the optional `legacyPaths.callback` alias |
| Callback JSON `channelId` / `userId` / `content` / `replyToMessageId` / `statusMessageId` / `threadContent` / `attachments` | ported |
| Callback multipart/form-data (text fields + `files` parts) | ported (also `payload_json`; field cap 256 KiB like the old one) |
| Attachment caps (10 / 8 MiB / 25 MiB), MIME allowlist, executables denied, https url fetch 15 s | ported (plus DNS-rebinding and private-range hardening) |
| DM callback by `userId` (allow list ∪ paired ∪ owner) | ported (same sets, plus explicit `dmCallbacks.allowUsers`) |
| Callback to any channel the bot can see | deliberately narrowed: route channels, DM channels that passed the allowlist, and `callbackChannels` |
| Status-message edit (`statusMessageId` or remembered working message), fallback to a new message | ported (the remembered map now survives a restart) |
| Long text chunking, files on the first chunk | ported (2000-char chunks; cap 32 000 chars) |
| "Planner log" thread from `threadContent` | ported |
| Response `{ ok, messageId, chunks, attachments, edited?, thread? }` | ported (+ `messageIds`) |
| Errors `content_or_attachment_required`, `channelId_required`, `unauthorized`, `discord_not_ready`, `deliver_failed`, `user_not_allowlisted`, attachment codes | ported (`dm_open_failed` is 502, was 404; unknown channel is 403 `channel_not_allowlisted`) |
| Soft callback rate limit 90/min (token hash + client IP, 429 + Retry-After) | ported differently: per-adapter bucket after auth, 429 + Retry-After; no x-forwarded-for IP bucket (spoofable) |
| Local planner hop (row trio, "Working on it. (Ns)" pulse, message id + callback URL + statusMessageId in body and query, token never on the query, no abort) | ported |
| Planner: no red X on timeout/drop; "Couldn't start that." on not-configured/401/403/404; ✅ on accept | ported |
| Planner body fields `imagePath` / `referenceImagePath` / `imagePaths` (first two attachments) | ported |
| Deprecated `local_handler` alias | ported in the converter: `--planner-handler <old name>` maps it to `local-planner` (the name is host-specific, so it is not in git) |
| Grok Build chat hop (`harness: grok-build` + `profile`, `/plan` → `/chat`, profile + attachment refs, typing every 8 s, cancel on callback) | ported; the working message waits `chatWorkingDelayMs` (15 s per the old README; the old code posted at once, so set 0 to match) |
| sendPrompt hold/retry on 530/1033/502–504/network, backoff 5/10/20/30 s, per-channel order, mode-600 hold file, reload on restart | ported (core hold queue) |
| Hold status "Bot is waking up…", gave-up "❌ Couldn't reach the bot…" + ❌ | ported; on success the status is edited to "Delivered. The bot is on it." (the old bridge deleted it) |
| ✅ / ⚠️ (not accepted) / ❌ reactions | ported |
| Wake hook (one POST per outage, re-arm, `{reason, heldCount, firstHeldAt}`, header modes) | ported (core wake hook) |
| Fail-closed blank gateway token | ported (registry key required) |
| `/healthz` `{ ok, service, discordReady, hasTokenConfigured, callbackPath, callbackBaseUrl }` | ported differently: `discordReady` top level plus `health.discord.{ready, hasTokenConfigured, callbackPath, legacyCallbackPath}` |
| Placeholder/missing bot token → exit code 2 | ported differently: startup fails closed with an error |
| `HTTP_ONLY=1` | ported differently: `adapters.discord.enabled: false` |
| Voice `/voice/play` (tone, Piper, Grok Voice, bed) and `/voice/stream` (open/add/remove/status/close, 409 while open) | ported (`/discord/voice/*` + optional `legacyPaths.voicePlay/voiceStream`); **pending live** test |
| Voice on any voice channel | deliberately narrowed: `voice.channels` allowlist |
| Timing logs (`[timing] stage=…`) | ported differently: content-free audit JSONL (`ms`, status, outcome) |
| `scripts/send-grok-bot-prompt.mjs` + roster | ported differently: the `grokbuild` adapter (`POST /grokbuild/prompt` with a client token) |
| `bin/planner-docker-proxy.py` | ported: `scripts/planner-docker-proxy.py --network <name>` (no hard-coded addresses) |
| `bin/local-planner-powershell.mjs` / `LOCAL_PLANNER_POWERSHELL` | dropped (unused by 0.2.14) |
| Old held hops in `SENDPROMPT_HOLD_FILE` | not imported (downtime accepted; resend if any were held at stop) |
