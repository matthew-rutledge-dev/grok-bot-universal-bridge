# Source adapters

One folder per source. Each folder is self-contained:

```
adapters/<name>/
  index.ts             the adapter (implements SourceAdapter from core/bridge.ts) + config validator
  config.example.json  placeholders only; the real file lives on the deployment host
  README.md            what it matches on, its routes, its reply shape
  <name>.test.ts       tests (deny-by-default, delivery, reply)
```

## Contract (core/bridge.ts)

```ts
interface SourceAdapter {
  name: string;                    // lowercase; also the URL prefix /<name>/...
  routes: Route[];                 // deny-by-default route table from the adapter config
  callbackTokenRef?: string;       // env:NAME or file:/path; enables POST /<name>/callback
  init(ctx: AdapterContext): void; // register extra routes via ctx.route(...)
  start(): Promise<void>;          // connect to the source; fail closed if a secret is missing
  stop(): Promise<void>;
  ui?: { holding, delivered, failed }; // optional status UI while an event is held
  handleCallback?(body): Promise<{ status, body }>; // agent reply (auth already checked by the core)
}
```

An adapter builds an `InboundEvent` (`eventId`, `lane`, `actor`, `match`, `prompt`, optional `actorGroups`, `addressed`, `metadata`, `ref`) and calls `ctx.submit(event)`. The core runs the allowlist, resolves the agent in the registry, delivers it with hold-and-retry and writes the audit line. Adapters never see registry secrets.

Routes registered with `ctx.route(method, subpath, handler, { maxBytes?, rawBody? })`: `rawBody: true` skips the core's JSON parse and hands the handler only `req.rawBody`. Use it when the source signs the raw bytes, and parse after verifying.

Rules for every adapter:

* Deny by default: the config validator must reject routes whose `match` shape is wrong for the source.
* Only secret references in config (`env:` / `file:`), never values.
* No message content in audit entries. Use `ctx.audit` with ids only; the core masks them.
* Replies may only target places the route table already allows.
* Example config uses placeholders: `example-agent`, `example-client`, `111111111111111111`, `example.com`.

## Adding a source

1. Create a working branch, for example `adapter-<name>`.
2. Copy the smallest adapter (`grokbuild`) as a template into `adapters/<name>/`.
3. Add one line to `adapters/index.ts`.
4. Add `"<name>": { "enabled": false, "configPath": "./config/<name>.json" }` to `config/bridge.example.json`.
5. Run `npm test`, `npm run smoke` and `npm run leak-check`, then open a PR. CI must be green.
6. Enabling it on a host is a separate, host-side config change, and the operator owns it.
