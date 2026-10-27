# grok-bot-universal-bridge

A generic, deny-by-default bridge from many sources to Grok Bots. It has one shared core (source allowlist, secret references, hold-and-retry, wake-on-sleep, reply callback, audit log) and one folder per source adapter under [`adapters/`](adapters/README.md).

| Adapter | Status |
|---|---|
| [`discord`](adapters/discord/README.md) | working |
| [`grokbuild`](adapters/grokbuild/README.md) | working |
| [`tesla`](adapters/tesla/README.md) | skeleton (no live receiver; never sends commands) |

Design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Quick start (local)

```bash
npm ci
npm test            # unit + adapter tests
npm run smoke       # loopback end-to-end: real service process, mock routine, hold/retry, wake failure, restart, callbacks, audit
npm run leak-check  # no real ids, hosts, URLs or secrets in the tree
```

Run it for real:

```bash
cp config/bridge.example.json config/bridge.json        # then edit
cp adapters/grokbuild/config.example.json config/grokbuild.json
cp config/registry.example.json /run/bridge/registry.json && chmod 600 /run/bridge/registry.json
cp .env.example .env && chmod 600 .env                   # fill in real values
npm run build && npm run check:config && npm start
```

## Rules

* Real config, `registry.json` and `.env` live only on the deployment host, and the registry is mounted read-only. Git holds examples only (see `.gitignore`).
* Config holds secret **references** (`env:NAME`, `file:/path`). Literal secrets are refused.
* The service binds loopback only. Put the tunnel in front of it and route by path: `/discord/*`, `/grokbuild/*`, `/tesla/*`.
* Marketplace plugins stay thin clients: a bridge URL plus their own client token.

## License

MIT
