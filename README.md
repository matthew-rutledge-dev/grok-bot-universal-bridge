# grok-bot-universal-bridge

A generic, deny-by-default bridge from many sources to Grok Bots. It has one shared core (source allowlist, secret references, hold-and-retry, wake-on-sleep, reply callback, audit log) and one folder per source adapter under [`adapters/`](adapters/README.md).

| Adapter | Status |
|---|---|
| [`discord`](adapters/discord/README.md) | working |
| [`grokbuild`](adapters/grokbuild/README.md) | working |
| [`tesla`](adapters/tesla/README.md) | telemetry receiver (decoded JSON or mTLS) + energy polling; never sends commands, wakes or polls `vehicle_data` |

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

## Deploy with Docker Compose

```bash
cp compose.example.yml compose.yml                       # on the host
docker compose build
docker compose run --rm -T universal-bridge node dist/src/main.js --check
docker compose up -d
```

* **Use `docker compose run -T`** (and `exec -T`) in scripts. Without `-T` the container reads stdin, so in a piped or heredoc script it swallows the rest of the script and the later lines never run.
* **Keep host files outside the repo dir.** Put the real `bridge.json`, adapter configs, `registry.json`, `.env` and any secrets in a sibling directory such as `<repo>-host/` (for example `../grok-bot-universal-bridge-host/`), owned by the service user, and mount them from there. Then `git pull` never touches them, and they're never part of the Docker build context: a host-only directory inside the checkout (especially one the build user can't read) breaks `docker compose build`. `.dockerignore` also drops `.env`, `config.host/`, `host/`, `registry*.json`, `*.tmp`, `node_modules`, `.git` and test output, as a safety net for older layouts.
  ```yaml
  env_file: ${BRIDGE_HOST_DIR:-../grok-bot-universal-bridge-host}/.env
  volumes:
    - ${BRIDGE_HOST_DIR:-../grok-bot-universal-bridge-host}/config:/app/config:ro
    - ${BRIDGE_HOST_DIR:-../grok-bot-universal-bridge-host}/registry.json:/run/bridge/registry.json:ro
  ```
* `http.publicBaseUrl` is only needed when an enabled adapter has a live callback route (its `callbackTokenRef` is set). Startup fails with a clear message if it's missing then.

## Rules

* Real config, `registry.json` and `.env` live only on the deployment host, and the registry is mounted read-only. Git holds examples only (see `.gitignore`).
* **Registry aliases are lowercase** (`a-z 0-9 . _ -`, starting with a letter or digit). They are case-sensitive and are not normalised: a mixed-case alias is rejected with a "rename it to …" message, and an adapter route (e.g. a Discord route's `agent`) that differs from a registry alias only by case fails at startup. Write aliases in lowercase everywhere.
* Config holds secret **references** (`env:NAME`, `file:/path`). Literal secrets are refused.
* The service binds loopback only. Put the tunnel in front of it and route by path: `/discord/*`, `/grokbuild/*`, `/tesla/*`.
* Marketplace plugins stay thin clients: a bridge URL plus their own client token.

## License

MIT
