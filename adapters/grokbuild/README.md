# grokbuild adapter

Status: **working, ready for real clients** once the host operator runs the live check and turns read-only off (see [docs/GROKBUILD-CUTOVER.md](../../docs/GROKBUILD-CUTOVER.md)). Lets a coding harness (Grok Build, Cursor or any MCP client) send a prompt to a Grok Bot through the bridge. The harness plugin stays a thin client: it holds only the bridge URL and its own client token. Bot webhook keys and Gateway tokens stay in the host registry.

| Route | Auth | Body / answer |
|---|---|---|
| `POST /grokbuild/prompt` | client token | `{ "bot": "example-agent", "prompt": "…", "requestId": "optional-8-64", "replyHint": "optional" }` -> `202 { requestId, state }` (`delivered` or `held`) |
| `GET /grokbuild/requests/:requestId` | client token (owner only) | `{ state, replies: [{ content, at }] }`. Another client's id answers 404. |
| `GET /grokbuild/status` | client token | `{ client, readOnly, replyChannel: "ready"\|"unset", bots: [...] }`. Writes nothing (used by the live check). |
| `POST /grokbuild/expect` | client token | `{ "requestId": "8-64", "bot": "optional label" }` -> `201 { requestId, replyUrl, replyToken, expiresAt }`. For a prompt the client delivers itself (direct reply, below). Nothing is delivered by the bridge. |
| `POST /grokbuild/reply` | one-time reply token | `{ "requestId": "…", "content": "…" }` (the woken bot's reply to a direct request; one reply per token on this route) |
| `GET /grokbuild/requests/:requestId?waitSec=N` | client token (owner only) | Same as above, but waits up to `N` seconds (capped at `maxWaitSec`, default 25) for the first reply. Direct requests report `awaiting_reply`, `replied` or `expired`, plus `createdAt` and (direct) `expiresAt`, so a client can show how long it has been waiting. Past `maxLongPolls` open long-polls (default 32, all clients), it answers at once with `busy: true` and `Retry-After: 2`; poll again. `maxLongPolls: 0` turns long-polling off: **every** `?waitSec` read then answers at once with `busy: true`. A cancelled or expired direct request answers `200 { state: "cancelled" | "expired", tombstone: true, until }` for `tombstoneSec` (default 1 h) instead of 404, also to a long-poll reader woken by the cancel. |
| `DELETE /grokbuild/requests/:requestId` | client token (owner only) | Cancels an open **direct** request: drops the record, frees its open-request slot, wakes its long-poll readers (they get `200 { state: "cancelled", tombstone: true }`, or 404 with `tombstoneSec: 0`) and its reply token stops working. `200 { cancelled: true }`; 404 unknown or another client's; 409 for a relayed `/prompt` request. Read limit (`readsPerMin`); allowed in read-only mode. |
| `POST /grokbuild/callback` | callback token | `{ "requestId": "…", "client": "example-client", "content": "…" }` (the agent's reply; `client` comes from the trailer and is required only when two clients use the same requestId, otherwise 409) |

## End to end

1. The client posts a prompt with `Authorization: Bearer <client token>`.
2. The route table matches `{ client, bot }` (deny by default: no row, a disabled row, or an actor outside `allowActors` means no delivery). The row's `agent` is a registry alias.
3. The core delivers through the registry: a webhook routine, or a sendPrompt-style Gateway (`POST { agentId, prompt, metadata }` with the Gateway's bearer token). If the computer is asleep (502/503/504/530, network errors) the prompt is **held** and retried, and the wake hook POSTs once per outage.
4. The agent gets the prompt labelled as untrusted data plus `⟂ gb:<requestId> client=<id> reply=<callback URL>`, and answers with `POST /grokbuild/callback` (requestId + client from the trailer) and the callback token.
5. The client polls `GET /grokbuild/requests/:requestId` until `replies` is non-empty (states: `queued`, `held`, `delivered`, `failed`).

## Direct replies (client delivers the prompt itself)

For a client that posts the prompt straight to the bot's webhook routine (for example the grokbuild-grokbots plugin's `send_prompt`) and only needs the reply to come back:

1. The client calls `POST /grokbuild/expect` with its client token and its own `requestId`. Same auth, prompt rate limit, read-only switch and open-request cap as `/prompt`; no route row is needed, because the bridge delivers nothing.
2. The bridge answers with `replyUrl` (`<http.publicBaseUrl>/grokbuild/reply`), a random `replyToken` and `expiresAt`. The token is bound to that client + requestId, kept only as a SHA-256 hash in the request file, valid for `replyTokenTtlSec` (default 21600 s = 6 h, at most 86400 s = 24 h) and accepted **once**. The request record lives as long as its token (or `replyTtlSec`, whichever is later), across restarts, so a bot can take hours to answer, like a Discord thread. A waiting direct request keeps its `maxOpenRequests` slot until it gets a reply, is cancelled, or its token expires; size the cap (default 200 per client) for how many long waits you expect.

Lifetimes (0.2.3+):

- **Waiting** (no reply): until the token expires. The sweep then leaves an `expired` tombstone. If the bridge was down when the token expired, the record is turned into the same `expired` tombstone on load; it runs from the expiry time, not from the restart.
- **Replied:** dropped `readKeepSec` (default 600 s) after the first read that returned the reply, or `repliedKeepSec` (default 3600 s) after the first reply, whichever comes first. They are not kept for the whole token lifetime, and no tombstone is left (the reply was available).
- **Cancelled** (`DELETE`): dropped at once, with a `cancelled` tombstone.
- **Tombstones** last `tombstoneSec` (default 3600, max 86400, `0` = off). They are owner-only and survive a restart. A new request with the same id clears it: `/expect` at once, `/prompt` only once the prompt is accepted. A refused prompt (unrouted bot, read-only, not ready) leaves it in place. The cap is per client: `maxTombstonesPerClient` (default 10000). Past it, that client's own oldest tombstone goes first, so one busy client never evicts another's.

The request file (`grokbuild-requests.json`, mode 600) is rewritten atomically. Changes a late reply depends on are written at once, so a hard kill loses none of them: a new request, a stored reply, a spent token, a cancel. Housekeeping is debounced to at most one write per second and flushed on stop: sweeps, read marks, tombstone expiry. A crash can lose only that housekeeping. On the next start, the load and the sweep redo it from the records themselves: dropping replied or expired records, and leaving `expired` tombstones.

**Clients: DELETE when you stop waiting for good** (the user gave up, or the session ends), so the slot and the token go at once instead of at `replyTokenTtlSec`. The grokbuild-grokbots plugin cancels when its webhook send fails. When the host aborts a wait, it stops polling at once but keeps the route, because the same request can be resumed with another wait.

**Shared or multi-user accounts:** use a lower `replyTokenTtlSec` (for example 900-3600). A reply token is visible in the woken bot's routine run history until it expires, and every waiting request holds an open-request slot.
3. The client puts `reply: { url, requestId, token, expiresAt }` in the webhook body. Its own client token never goes in the payload.
4. The woken bot answers with `POST <replyUrl>`, `Authorization: Bearer <replyToken>` (or `x-callback-token`), body `{ requestId, content }` (content up to 8000 chars, body up to 64 KiB). A missing, wrong, expired or already used token, or a token for a different requestId, answers 401; `?token=` answers 400. Rate limits: only **failed** token checks count against a shared bucket, `replyAuthFailsPerMin` (default 60 per minute, all callers; past it, bad tokens get 429). A verified token has its own per-request bucket, `replyAttemptsPerRequest` (default 10 per minute), so a flood of bad tokens never blocks a valid reply. (`replyPostsPerMin` from 0.2.0 still works as the old name for `replyAuthFailsPerMin`.) The limits are per bridge, not per IP: behind a tunnel every request arrives from loopback.
5. The client long-polls `GET /grokbuild/requests/<requestId>?waitSec=25` with its client token until `replies` is non-empty.

The bot needs no stored secret: everything it needs is in that one payload, and the token is useless for anything but one reply to that request. The shared `callbackTokenRef` path still works for these requests too. **"One reply per token" applies only to `/grokbuild/reply`:** whoever holds the shared callback token can still add replies to a direct request through `/grokbuild/callback` (up to the usual per-request reply cap), before or after the reply token is spent. If a client sends the prompt itself and then the send fails, it should cancel the request (`DELETE`, above) so the slot is freed at once instead of at `replyTokenTtlSec`.

## Auth and limits

* **Client tokens.** One `tokenRef` per client (`env:NAME` or `file:/absolute/path`; literal tokens are refused at startup). Header only: `?token=` answers 400. If no client token resolves at all the routes answer **503 `client_auth_unset`** (fail closed); a wrong token answers 401. Two clients sharing one token are refused (503), because it would blur the actor.
* **Callback token.** `callbackTokenRef`, checked by the core (503 while unset, 401 when wrong, shared callback rate limit). A client token is never a callback token: if the callback token equals any client token the bridge refuses to start.
* **Request ids are per client.** Records are keyed by client + requestId, so another client reusing an id gets neither a 409 nor access; the same client reusing its own open id gets 409.
* **Reply channel.** New prompts answer **503 `reply_channel_unset`** while the callback token or `http.publicBaseUrl` is missing, because the agent could not answer.
* **Rate limits.** `promptsPerMin` (default 20, per client; a client can override it with `clients.<id>.promptsPerMin`), `readsPerMin` (default 240, per client, status and reply reads), and `maxOpenRequests` (default 200 per client). `0` turns any of them off. Over the limit: 429 with `Retry-After`; for the open-request cap that's the seconds until the client's oldest open request expires (at least 1). A request stops counting as open once it has a reply or its delivery failed, and at the latest after `replyTtlSec`.
* **Audit.** Content-free JSONL lines with masked ids (client id, request id: last 4 characters): refusals with their reason, deliveries, holds, wakes, stored replies, reads. Never prompt or reply text, tokens or URLs. 401 lines are capped at 20 a minute, and the rest are summed into one `bad_token_suppressed` line, written by a minute timer and on stop so it isn't lost.

## Read-only (fails closed)

* `"readOnlyRef": "env:GROKBUILD_READ_ONLY"` (or a `file:` path) is re-read on every request, so flipping it needs no restart (an env change still needs the container recreated; a `file:` ref does not).
* Only `0/false/no/off` allow prompts. `1/true/yes/on`, **unset, empty**, an unexpanded `${...}`, an unreadable file and any unrecognised value all mean read-only.
* Without `readOnlyRef`, `"readOnly": false` is the explicit opt-in; with nothing configured the adapter is read-only.
* While read-only, `POST /grokbuild/prompt` answers 403 `read_only` before routing, and nothing is delivered. Reads, status and agent callbacks for earlier requests keep working.

## Persistence

Request records and replies are kept for `replyTtlSec` in `data/grokbuild-requests.json` (mode 600), so a reply that arrives after a restart still lands. Event states are memory only: after a restart a request with replies reports `delivered`. Files written before per-client keys still load.

Accepted limits: the whole file is rewritten (temp file + rename) on every save. That's bounded by `maxOpenRequests` × clients × `replyTtlSec` and is fine at harness volumes. Mode 600 has no effect on Windows, where the data directory's ACL must restrict access instead.

## Live check

`scripts/grokbuild-live-check.mjs` runs against a deployed bridge with `env:`/`file:` refs only and never prints a secret. See [docs/GROKBUILD-CUTOVER.md](../../docs/GROKBUILD-CUTOVER.md).
