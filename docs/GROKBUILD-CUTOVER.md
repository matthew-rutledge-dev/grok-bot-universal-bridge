# Grok Build adapter: cutover checklist

For the host operator. Goal: real Grok Build clients reach an allowlisted Grok Bot through the universal bridge, after a check while read-only is still on. Every step is reversible. Placeholders below (`example-client`, `example-agent`, `bridge.example.com`) stand for the host's real values, which live only in the host files.

## 0. Before you start

- [ ] The bridge runs at the commit that has this file, and `--check` lists `grokbuild` with every route agent ready.
- [ ] `config/grokbuild.json` (host copy) has `readOnlyRef` set, one `clients.<id>.tokenRef` per real client, and one route row per client and bot. Everything else stays deny by default.
- [ ] The host `.env` (or secret files) has the client token(s), `GROKBUILD_CALLBACK_TOKEN`, and **`GROKBUILD_READ_ONLY=1`**. Unset or empty also means read-only, but set `1` explicitly.
- [ ] `http.publicBaseUrl` is set, and the tunnel routes `/grokbuild/*` to the bridge's loopback port. Otherwise prompts answer 503 `reply_channel_unset`.
- [ ] The agent behind the route knows the callback URL and has the callback token (its reply skill), and its registry entry (webhook routine or sendPrompt Gateway) resolves.
- [ ] Note the current image tag for rollback (`rollback-pre-<sha>`).

## 1. Live check while read-only (writes nothing)

On the host, with refs only (literal values are refused, and nothing secret is printed):

```sh
set -a; . /path/to/host/.env; set +a   # loads GROKBUILD_BRIDGE_URL etc. without typing values into history
node scripts/grokbuild-live-check.mjs \
  --bridge-url-ref env:GROKBUILD_BRIDGE_URL \
  --client-token-ref file:/path/to/example-client.token \
  --callback-token-ref env:GROKBUILD_CALLBACK_TOKEN \
  --bot example-agent \
  --expect read-only
```

- [ ] `RESULT: all checks passed` (exit 0). It confirms healthz, the client token, read-only ON, the bot is routed, 401 without or with a wrong token, 400 for `?token=`, 403 for an unrouted bot, 404 for an unknown id, the callback token, and 403 `read_only` for a real prompt.
- [ ] Run it once through the tunnel URL and once against loopback (`http://127.0.0.1:<port>`).
- [ ] The audit file has new `ingest` deny lines (`read_only`, `bad_token`) with masked ids and no prompt text.

## 2. Turn read-only off

- [ ] Set `GROKBUILD_READ_ONLY=0` in the host `.env`, then `docker compose up -d --force-recreate` (a plain restart keeps the old env). With a `file:` ref, write `0` to the file instead (no restart needed, it's re-read per request).
- [ ] `GET /grokbuild/status` (with the client token) reports `"readOnly": false` and `"replyChannel": "ready"`.

## 3. Verify one real round trip

```sh
node scripts/grokbuild-live-check.mjs \
  --bridge-url-ref env:GROKBUILD_BRIDGE_URL \
  --client-token-ref file:/path/to/example-client.token \
  --callback-token-ref env:GROKBUILD_CALLBACK_TOKEN \
  --bot example-agent \
  --expect writable --send --wait-reply-sec 300
```

- [ ] Exit 0. It sends **one** short prompt, waits until it's `delivered` (it may be `held` first while the computer wakes; the wake hook fires once), then waits for the agent's reply through `/grokbuild/callback`.
- [ ] If the computer is asleep, expect `held`, one wake POST in the logs, then `delivered`.
- [ ] The audit shows `inbound allow`, `deliver ok` (or `hold` then `deliver`), `callback ok reply_stored` and `reply_read`, with masked ids only.
- [ ] Point the real Grok Build client at the bridge URL with its client token and send one prompt from a coding session.

## 4. Soak

- [ ] Watch the audit for `rate_limited`, `agent_not_ready`, `give_up` and `bad_token_suppressed`.
- [ ] Re-run step 3 after the first host restart (request records persist in `data/grokbuild-requests.json`).

## Rollback

Fastest first:

1. **Stop writes:** set `GROKBUILD_READ_ONLY=1` (recreate the container for an env ref; a file ref takes effect on the next request). Clients get 403 `read_only`, and reads and pending replies keep working.
2. **Cut one client:** remove its route row (or set `"enabled": false`) or blank its token, then restart. Its prompts answer 403 or 401.
3. **Adapter off:** set `adapters.grokbuild.enabled: false` in the host bridge config and recreate. `/grokbuild/*` answers 404.
4. **Image:** redeploy the `rollback-pre-<sha>` tag.

Clients fall back to their previous path (direct webhook routine) on their side. The bridge holds nothing for them except request records, which expire after `replyTtlSec`.
