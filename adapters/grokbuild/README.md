# grokbuild adapter

Status: **working, ready for real clients** once the host operator runs the live check and turns read-only off (see [docs/GROKBUILD-CUTOVER.md](../../docs/GROKBUILD-CUTOVER.md)). Lets a coding harness (Grok Build, Cursor or any MCP client) send a prompt to a Grok Bot through the bridge. The harness plugin stays a thin client: it holds only the bridge URL and its own client token. Bot webhook keys and Gateway tokens stay in the host registry.

| Route | Auth | Body / answer |
|---|---|---|
| `POST /grokbuild/prompt` | client token | `{ "bot": "example-agent", "prompt": "…", "requestId": "optional-8-64", "replyHint": "optional" }` -> `202 { requestId, state }` (`delivered` or `held`) |
| `GET /grokbuild/requests/:requestId` | client token (owner only) | `{ state, replies: [{ content, at }] }`. Another client's id answers 404. |
| `GET /grokbuild/status` | client token | `{ client, readOnly, replyChannel: "ready"\|"unset", bots: [...] }`. Writes nothing (used by the live check). |
| `POST /grokbuild/callback` | callback token | `{ "requestId": "…", "content": "…" }` (the agent's reply) |

## End to end

1. The client posts a prompt with `Authorization: Bearer <client token>`.
2. The route table matches `{ client, bot }` (deny by default: no row, a disabled row, or an actor outside `allowActors` means no delivery). The row's `agent` is a registry alias.
3. The core delivers through the registry: a webhook routine, or a sendPrompt-style Gateway (`POST { agentId, prompt, metadata }` with the Gateway's bearer token). If the computer is asleep (502/503/504/530, network errors) the prompt is **held** and retried, and the wake hook POSTs once per outage.
4. The agent gets the prompt labelled as untrusted data plus `⟂ gb:<requestId> client=<id> reply=<callback URL>`, and answers with `POST /grokbuild/callback` and the callback token.
5. The client polls `GET /grokbuild/requests/:requestId` until `replies` is non-empty (states: `queued`, `held`, `delivered`, `failed`).

## Auth and limits

* **Client tokens.** One `tokenRef` per client (`env:NAME` or `file:/absolute/path`; literal tokens are refused at startup). Header only: `?token=` answers 400. If no client token resolves at all the routes answer **503 `client_auth_unset`** (fail closed); a wrong token answers 401. Two clients sharing one token are refused (503), because it would blur the actor.
* **Callback token.** `callbackTokenRef`, checked by the core (503 while unset, 401 when wrong, shared callback rate limit). A client token is never a callback token.
* **Reply channel.** New prompts answer **503 `reply_channel_unset`** while the callback token or `http.publicBaseUrl` is missing, because the agent could not answer.
* **Rate limits.** `promptsPerMin` (default 20, per client; a client can override it with `clients.<id>.promptsPerMin`), `readsPerMin` (default 240, per client, status and reply reads), and `maxOpenRequests` (default 200 per client). Over the limit: 429 with `Retry-After`.
* **Audit.** Content-free JSONL lines with masked ids (client id, request id: last 4 characters): refusals with their reason, deliveries, holds, wakes, stored replies, reads. Never prompt or reply text, tokens or URLs. 401 lines are capped at 20 a minute, and the rest are summed into one `bad_token_suppressed` line.

## Read-only (fails closed)

* `"readOnlyRef": "env:GROKBUILD_READ_ONLY"` (or a `file:` path) is re-read on every request, so flipping it needs no restart (an env change still needs the container recreated; a `file:` ref does not).
* Only `0/false/no/off` allow prompts. `1/true/yes/on`, **unset, empty**, an unexpanded `${...}`, an unreadable file and any unrecognised value all mean read-only.
* Without `readOnlyRef`, `"readOnly": false` is the explicit opt-in; with nothing configured the adapter is read-only.
* While read-only, `POST /grokbuild/prompt` answers 403 `read_only` before routing, and nothing is delivered. Reads, status and agent callbacks for earlier requests keep working.

## Persistence

Request records and replies are kept for `replyTtlSec` in `data/grokbuild-requests.json` (mode 600), so a reply that arrives after a restart still lands. Event states are memory only: after a restart a request with replies reports `delivered`.

## Live check

`scripts/grokbuild-live-check.mjs` runs against a deployed bridge with `env:`/`file:` refs only and never prints a secret. See [docs/GROKBUILD-CUTOVER.md](../../docs/GROKBUILD-CUTOVER.md).
