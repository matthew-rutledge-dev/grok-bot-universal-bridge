# grok-bot-universal-bridge

A generic, deny-by-default bridge from many sources to Grok Bots. It has one shared core (source allowlist, secret references, hold-and-retry, wake-on-sleep, reply callback, audit log) and one folder per source adapter under [`adapters/`](adapters/README.md).

| Adapter | Status |
|---|---|
| [`discord`](adapters/discord/README.md) | working |
| [`grokbuild`](adapters/grokbuild/README.md) | working |
| [`tesla`](adapters/tesla/README.md) | fleet telemetry ingest is live (MQTT path, end-to-end pass 2026-11-10); also decoded JSON or mTLS, plus energy polling; never sends commands, wakes or polls `vehicle_data`. Operator checklist: [`docs/TESLA-CUTOVER.md`](docs/TESLA-CUTOVER.md) |

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
* **Keep host files outside the repo dir.** Put the real `bridge.json`, adapter configs, `registry.json`, `.env` and any secrets in a sibling directory such as `<repo>-host/` (for example `../grok-bot-universal-bridge-host/`), with modes and ownership as in Permissions below, and mount them from there. Then `git pull` never touches them, and they're never part of the Docker build context: a host-only directory inside the checkout (especially one the build user can't read) breaks `docker compose build`. `.dockerignore` also drops `.env`, `config.host/`, `host/`, `registry*.json`, `*.tmp`, `node_modules`, `.git` and test output, as a safety net for older layouts.
  ```yaml
  env_file: ${BRIDGE_HOST_DIR:-../grok-bot-universal-bridge-host}/.env
  volumes:
    - ${BRIDGE_HOST_DIR:-../grok-bot-universal-bridge-host}/config:/app/config:ro
    - ${BRIDGE_HOST_DIR:-../grok-bot-universal-bridge-host}/registry.json:/run/bridge/registry.json:ro
  ```
* `http.publicBaseUrl` is only needed when an enabled adapter has a live callback route (its `callbackTokenRef` is set). Startup fails with a clear message if it's missing then.

## Permissions

The image and `compose.example.yml` run the process as uid `100`, gid `101` (numeric; Alpine already uses gid 100 for `users`). Writable paths in the container must be owned by that uid, including host bind mounts the process writes to.

On the host, before `docker compose up`:

* The sibling host directory (`${BRIDGE_HOST_DIR:-../grok-bot-universal-bridge-host}/`, containing `config/`, `registry.json`, `.env`, and any secret files). Make those files readable by uid 100: mode `0600` or `0640`, never world-readable. Ownership can be `100:101`, or `root:101` with `0640` so the process can read but not write. The compose file mounts `config/` and `registry.json` read-only.
* The `bridge-data` named volume is `/app/data` inside the container (hold file, request records, `audit.jsonl`). A volume created from this image is already owned by `100:101`. If you reuse a volume that was created under a different uid, `chown -R 100:101` its data on the host.
* The backup bind mount (`${BACKUP_HOST_DIR:-/mnt/grokbot_backup}` on the host, `/backup` in the container). Create it first and `chown 100:101` so it is writable by the container; if the path is missing, Docker creates it owned by root and uploads fail with `500`.

Published ports stay on `127.0.0.1` by default. The compose example also drops all capabilities, sets `no-new-privileges`, and uses a read-only root filesystem with tmpfs on `/tmp`.

## Backup upload

A write-only drop for bot backups. Off by default: with `BRIDGE_BACKUP_UPLOAD_KEY` unset, empty or shorter than 32 characters the route answers 404 like any unknown path (a too-short key also logs a startup warning, never the value).

| Env | Meaning |
|---|---|
| `BRIDGE_BACKUP_UPLOAD_KEY` | Bearer key for uploads, at least 32 characters (host `.env` only, never in git). Unset, empty or shorter = route disabled. |
| `BACKUP_ROOT` | Directory uploads land in, inside the container. Default `/backup`; bind-mount a host dir there (see `compose.example.yml`), writable by uid `100` (gid `101`). |
| `BACKUP_HOST_DIR` | Compose only: the host directory mounted at `/backup` (default `/mnt/grokbot_backup`). Create it and `chown 100:101` before `docker compose up`, or Docker creates it owned by root and uploads fail. |
| `BACKUP_MIN_FREE_BYTES` | Free-space reserve in bytes on the `BACKUP_ROOT` filesystem (default `5368709120`, 5 GiB; `0` turns the check off). An upload is refused with `507` if free space minus its `Content-Length` (or 95 MiB when there is none) would drop below it. A value that is not a whole number logs a warning and the default is used. |

```bash
curl -sS -X POST --data-binary @db.sqlite.gz \
  -H "Authorization: Bearer $BRIDGE_BACKUP_UPLOAD_KEY" \
  "https://bridge.example.com/backup/upload?bot=example-agent&name=db.sqlite.gz"
# 201 {"path":"example-agent/2026-01-02/db.sqlite.gz","bytes":12345,"sha256":"<hex>"}
```

* `POST /backup/upload?bot=<alias>&name=<file>`: `bot` must be a registry alias; `name` must match `^[A-Za-z0-9._-]{1,128}$`, not be `.` or `..`, and not be a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, any case, with or without an extension).
* The body is streamed (never buffered) to a temp file `<BACKUP_ROOT>/<alias>/.incoming/<random>.part` (`O_EXCL`), fsynced, then published with a hard link to `<BACKUP_ROOT>/<alias>/<YYYY-MM-DD, UTC>/<name>` (the link fails if the name exists, so nothing is overwritten), the temp name is removed and the date directory is fsynced (not on Windows). A file under a real name is therefore always complete. A killed process can leave a stray `.part` under `.incoming/`; it never blocks a name and is safe for the host to prune.
* `path` in the answer is relative to `BACKUP_ROOT`; `sha256` is computed while streaming, so the client can compare it with its own. A `201` is the proof of a stored upload. Clients may also send `X-Content-SHA256: <64 hex>` (case-insensitive); a mismatch answers `422` and nothing is published, and a malformed header answers `400` before any write. The header is optional: omit it and the route behaves as before.
* Symlinks are not followed: if the alias or date directory is a symlink the upload is refused (`500`, audit reason `symlink_dir`).
* Answers: `201` stored; `400` bad alias/name (or `?token=`, or a malformed `X-Content-SHA256`); `401` no key; `403` wrong key; `404` disabled; `409` that name already exists for that bot today (nothing is overwritten); `413` over 95 MiB (by `Content-Length` up front, or counted while streaming); `422` `X-Content-SHA256` does not match the body; `499` (audit only: the client disconnected, reason `client_aborted`; the client never sees it); `507` not enough free space (see `BACKUP_MIN_FREE_BYTES`); `500` write failed. A failed, aborted, mismatched or oversize upload leaves no file under its name.
* One `audit.jsonl` line per attempt: `adapter: "backup"`, `action: "upload"`, `outcome` (`ok`, `auth_fail`, `bad_request`, `conflict`, `too_large`, `no_space`, `error`), `agent` (the alias), `name`, `bytes`, `sha256`, `status`, `ip` (the socket remote address; `CF-Connecting-IP` is used only when that peer is loopback, i.e. the trusted tunnel in front of the loopback bind). Never the body or the key.
* Free space is checked with `statfs` before anything is written, re-checked every 8 MiB while streaming (other writers share the volume), and a disk-full or quota error (`ENOSPC`, `EDQUOT`) while creating directories or files, streaming or copying also answers `507`. The temp file is removed in every case. If `statfs` itself fails (or returns nonsense), the upload is refused with `500` (audit reason `statfs_<code>`) and a warning is logged: fail closed, because without a reading the reserve cannot be promised and a full backup disk can take the host's other services down with it.
* **Why 5 GiB by default:** it is a fixed floor rather than a percentage, because a percentage of a large NAS volume reserves far more than needed while a small volume gets almost nothing. 5 GiB is more than 50 maximum-size uploads of headroom, which leaves room for the host, other services on the volume, and uploads already in flight (each in-flight upload is counted only against the free space it saw when it started). Raise it if the volume is shared with something busy.
* Where the filesystem has no hard links (`link()` fails with `EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `EXDEV` or `ENOSYS`, as on some SMB/FAT mounts), the temp file is published by **copy** instead: the final name is created with `O_EXCL` by that request, filled from the temp file and fsynced. It is still never-overwrite (`409`), and a failed copy removes only the file that request created, never one a concurrent upload published.
* The first upload probes hard-link support with throwaway files in `.incoming/` and logs the active mode once: `[backup] publish mode: link (atomic)` or a warning `[backup] publish mode: copy ...`.
* **Copy mode is not crash-safe.** If the process is killed or the host loses power mid-copy, a truncated file can be left under the final name (and that name then answers `409` for the rest of the day). To spot one, compare the file with its audit line: a good upload has an `outcome: "ok"` line whose `bytes` equals the file size and whose `sha256` equals `sha256sum` of the file; a truncated copy has no matching `ok` line, or a smaller size / different hash. Link mode never has this problem. Prefer a backup volume with hard-link support.
* **Host sync and pruning must exclude `*/.incoming/`.** It only ever holds in-flight or crash-orphaned temp files (`*.part`, and `*.probe` from the hard-link probe), never a finished backup. Any file in `.incoming/` older than a day is safe to delete.
* There are no list, read, delete or overwrite routes. Retention and pruning are the host's job.
* A reverse proxy in front must allow bodies up to 95 MiB on this path.

## Rules

* Real config, `registry.json` and `.env` live only on the deployment host, and the registry is mounted read-only. Git holds examples only (see `.gitignore`).
* **Registry aliases are lowercase** (`a-z 0-9 . _ -`, starting with a letter or digit). They are case-sensitive and are not normalised: a mixed-case alias is rejected with a "rename it to …" message, and an adapter route (e.g. a Discord route's `agent`) that differs from a registry alias only by case fails at startup. Write aliases in lowercase everywhere.
* Config holds secret **references** (`env:NAME`, `file:/path`). Literal secrets are refused.
* The service binds loopback only. Put the tunnel in front of it and route by path: `/discord/*`, `/grokbuild/*`, `/tesla/*` (and `/backup/upload` if backups are enabled).
* Marketplace plugins stay thin clients: a bridge URL plus their own client token.

## License

MIT
