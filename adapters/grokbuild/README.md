# grokbuild adapter

Status: **working**. Lets a coding harness (Grok Build, Cursor or any MCP client) send a prompt to a Grok Bot through the bridge. The harness plugin stays a thin client: it holds only the bridge URL and its own client token. Bot webhook keys stay in the host registry.

| Route | Auth | Body / answer |
|---|---|---|
| `POST /grokbuild/prompt` | client token | `{ "bot": "example-agent", "prompt": "…", "requestId": "optional-8-64", "replyHint": "optional" }` -> `202 { requestId, state }` (`delivered` or `held`) |
| `GET /grokbuild/requests/:requestId` | client token (owner only) | `{ state, replies: [{ content, at }] }`. Another client's id answers 404. |
| `POST /grokbuild/callback` | callback token | `{ "requestId": "…", "content": "…" }` (the agent's reply) |

* **Matches.** Routes match `{ "client": "<client id>", "bot": "<alias>" }`. Actor = client id.
* **Prompt.** The agent receives the prompt labelled as untrusted data, plus `⟂ gb:<requestId> client=<id> reply=<callback URL>`.
* **Read-only.** `readOnly` fails closed: `1/true/yes/on` turns it on, and so does any unrecognised value; unset, empty or `${...}` leaves it off. When on, new prompts are refused with 403.
* **Persistence.** Request records and replies are kept for `replyTtlSec` in `data/grokbuild-requests.json` (mode 600), so a reply that arrives after a restart still lands.
