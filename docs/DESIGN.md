# Universal bridge: design (v0.1)

One small service that takes events from many **sources** (chat, coding harnesses, vehicle telemetry, ...) and delivers them to **Grok Bots**, with one shared, deny-by-default core and one folder per source adapter. It replaces "one named bridge per source" without changing how agents reply.

```
 source ──> adapters/<name>  ──InboundEvent──>  core  ──webhook/sendPrompt──>  Grok Bot
   ^          (parse, UI)                (allowlist, registry,                 (routine)
   |                                      hold-retry, wake, audit)                 |
   └──────── adapter reply  <── POST /<name>/callback (bearer, rate limit) <───────┘
```

## Shared core (`core/`)

| Piece | What it does |
|---|---|
| **Source allowlist** (`allowlist.ts`) | Each adapter has a route table. A route matches exact event fields (`{guild, channel}`, `{client, bot}`, `{kind}`); an empty match never matches. `allowActors` empty = nobody, `"*"` only when written. Optional `allowGroups`, `requireAddressed`. No route = deny. First match wins, so a disabled row switches a source off. |
| **Secrets loading** (`secrets.ts`) | Config and registry hold only references: `env:NAME` or `file:/path`. Literal values are refused at startup. Placeholders (`changeme`, `${X}`) count as missing. Secrets are never logged, audited or returned. Secret-bearing files are checked for mode 600. |
| **Registry** (`registry.ts`) | `alias -> { agentId, deliver: { kind, urlRef, keyRef } }`. `webhook` = documented Grok Bot webhook routine (`Authorization: Bearer` + `X-Automation-Key`); `sendprompt` = compatibility with sendPrompt-style gateways. https only (http allowed only on loopback). A missing key fails closed. |
| **Hold-and-retry** (`hold.ts`) | Retryable failures (502/503/504/530, Cloudflare 1033, timeouts, network) are held, not failed: in memory plus a JSON file in the data volume (atomic rename, mode 600), retried at 5 s, 10 s, 20 s, then every 30 s, until `hold.maxSec` (default 1800). Ordered per lane. 4xx and auth errors fail fast. Held events reload after a restart. |
| **Wake-on-sleep** (`wake.ts`) | The first hold of an outage triggers one POST to an optional wake routine. The body carries no content: `{reason, heldCount, firstHeldAt}`. It re-arms after success or when nothing is held. **If the wake fails, the hold continues.** |
| **Reply callback** (`bridge.ts`, `http.ts`) | Each adapter gets `POST /<name>/callback`. A bearer or `x-callback-token` header is checked in constant time; `?token=` is refused. It is soft rate-limited. With no token configured it answers 503 (fail-closed). The adapter validates the target, for example an allowlisted channel only. |
| **Audit log** (`audit.ts`) | JSONL, one line per decision (inbound allow/deny, hold, retry, deliver, give_up, callback, ingest). Ids are masked to their last 4 characters. A field allowlist means message text, URLs and keys cannot be written. |
| **HTTP** | `node:http`, loopback bind enforced by config validation, `GET /healthz` (counts only). Adapters register routes under `/<name>/...`. |

Runtime: Node 22 + TypeScript, the same as the existing Discord bridge. The only runtime dependency is `discord.js`.

## Adapters (`adapters/<name>/`, each with `config.example.json`, README, tests)

* **discord** (working). Gateway messages become events: guild `{guild, channel}`, DM `{dm:"true"}`, actor = user, groups = roles, mention = addressed. It sends the same compact wake prompt as today's bridge (`⟂ d:<slug>:<msgId> u= c= g= map=`), so agent-side reply skills don't change. While a message is held it posts **one** status message and edits it (delivered / gave up). Callback `{channelId, content, replyToMessageId?, statusMessageId?}` posts or edits only in routed channels or DM channels that already passed the allowlist. Long replies are split at 2000 characters.
* **grokbuild** (working). A coding harness posts `POST /grokbuild/prompt {bot, prompt, requestId?}` with its own client token. The route matches `{client, bot}`. Delivery goes through the registry, so the client never holds a bot's webhook key. The agent replies through `/grokbuild/callback {requestId, content}`, and the client polls `GET /grokbuild/requests/:id` (owner only, 404 otherwise). `readOnly` fails closed. Request records persist in the data volume.
* **tesla** (skeleton). It holds the bridge's half of the Tesla split: a `TelemetryReceiver` seam (Fleet Telemetry over mTLS), an `EnergyStatusSource` polling hook (`live_status`), trigger derivation plus debounce, wake rules, VIN and site allowlists, and an audit of event type, masked VIN and time. **It never sends vehicle commands**: command keys in config are refused, `vehicle_data` polling is refused, and there's no callback route because replies go through the agent's origin channel. Enabling telemetry or polling without a real implementation fails at start.
* **Adding a source** (see `adapters/README.md`): create a working branch, add `adapters/<name>/` (index, README, `config.example.json`, tests), add one line in `adapters/index.ts`, and open a PR. Once CI and the leak check are green, the PR is reviewed and merged. There is no core change unless a new shared capability is needed.

## Config, registry, secrets

* In git: `config/bridge.example.json`, `config/registry.example.json`, `adapters/*/config.example.json`, `.env.example`. They contain placeholders only (`example-agent`, `111…`, `example.com`).
* On the deployment host only: `config/bridge.json`, the adapter configs, **`registry.json`** (real bot ids and routine URL refs) and `.env`. These files are rendered from the host's secret store by its loader script, owned by the service user, mode 600, mounted **read-only**, and never committed. The bridge never writes them. Deploys must preserve these runtime files. A `.env` change needs `compose up -d --force-recreate`.
* State (`data/`: hold file, adapter request records, audit JSONL) lives in a named volume. There's no shared DB.
* **Marketplace plugins stay thin clients.** They know a bridge URL and their own client token, never registry contents.

## Deployment and cutover

* A new directory and compose project run **side by side** with today's bridge on their own loopback port (example `127.0.0.1:18090`). There's one process with the adapters enabled per config: one image, one health check, one rollback. The container is split only for different network needs, for example a public mTLS listener for telemetry.
* Ingress: reuse the existing tunnel and hostnames with **path routes per adapter** (`/discord/*`, `/grokbuild/*`, `/tesla/*`). Auth stays in the core (a bearer per adapter); the edge (WAF) is defense in depth.
* Cutover = **move the tunnel ingress** route from the old bridge to the new port, soak, then retire the old container. Rollback = move the ingress back; deploys are tagged `rollback-pre-<sha>` with a tarball of the previous build.
* Merge, host deploy, and making the repo public each need the owner's explicit yes.

## Migration (nothing is on hold)

1. **Discord first.** It's the closest to the existing code (same hold/wake/callback semantics, same prompt grammar), so it gets the first soak on a staging channel, then the ingress move.
2. **Tesla on top of it.** After Discord is stable, the plugin author fills in the receiver and the energy client behind the seams here. The public mTLS endpoint and the signed telemetry config push need the owner's yes.
3. **GrokBuild after.** The grokbuild client plugin switches from per-bot webhook keys to the bridge URL and a client token.

Discord and Tesla development **continues against the current named bridges** in the meantime. Once the universal bridge works, each existing client gets **its own small PR that only changes its bridge pointer** (named bridge -> universal bridge), so every review stays a one-line diff. The existing bridge repos and PRs are not modified by this repo.

## Not in v0.1 (tracked)

Discord attachments, voice and the local-planner hop. The Tesla mTLS receiver and Fleet energy client. Hold-file encryption at rest (it's mode 600 inside the volume today). Multi-instance HA. The bridge is single-writer by design.
