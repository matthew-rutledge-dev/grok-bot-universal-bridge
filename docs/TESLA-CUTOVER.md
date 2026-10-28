# Tesla adapter cutover (host operator checklist)

Brings the `tesla` adapter up end to end on the universal bridge: car → Tesla's fleet-telemetry server → MQTT broker → bridge → wake → agent, plus read-only energy polling. Every value below is a placeholder. Real hostnames, VINs, site ids, passwords and tokens stay in host-only files (mode 600) outside the repo and never go in git.

Ground rules:

* The bridge never sends vehicle commands, never wakes a car and never calls `vehicle_data`. Pushing the telemetry config to a car is the one step that changes the car. It's a signed request, and it needs the owner's explicit yes.
* Turn on one source at a time and verify it before the next (`telemetry` first, then `energy_poll`).
* Keep the previous state restorable: note the image tag and copy `config/tesla.json` before you change anything.

## 0. Before you start

- [ ] The bridge runs at a commit that has the MQTT receiver (`docker compose run -T --rm universal-bridge node dist/src/main.js --check` shows no Tesla config problems).
- [ ] A public DNS name and a TLS cert for fleet-telemetry exist (`<telemetry-fqdn>`). The cars connect to it over mTLS on its own port. This is the only thing exposed publicly; the broker and the bridge stay loopback or LAN.
- [ ] The car has the app's virtual key paired, and the Tesla plugin works (`list_vehicles` answers).
- [ ] You have the VIN(s) for `vin_allowlist` and the energy site id(s) for `site_allowlist` (from the plugin, kept in the host-only config).

## 1. MQTT broker

- [ ] Run a broker (for example Mosquitto) on a compose network shared by fleet-telemetry and the bridge (simplest), or on the host. A host broker bound only to `127.0.0.1` can't be reached from the bridge's compose network: also listen on the Docker bridge gateway address (`listener <mqtt-port> <bridge-gateway-ip>`; find it with `docker network inspect <bridge-compose-project>_default --format '{{(index .IPAM.Config 0).Gateway}}'`), and never on public interfaces. Don't publish its port to the internet.
- [ ] Two broker users. `fleet-telemetry` may **publish** to `telemetry/#`, and `bridge` may only **subscribe** to `telemetry/+/v/+`. With Mosquitto, an ACL file like:

  ```
  user fleet-telemetry
  topic write telemetry/#
  user bridge
  topic read telemetry/+/v/+
  ```

- [ ] Message size limit: `message_size_limit 65536` in `mosquitto.conf`. The bridge drops payloads over 64 KB, but only after its MQTT client has buffered the whole packet, so the broker should refuse them first.
- [ ] Host firewall: if the broker runs on the host (or publishes its port on the host) and the host runs a firewall such as ufw, allow the bridge's compose network to reach it, or the MQTT connection fails silently (connect timeouts and backoff in the audit, no events). Find the subnet with `docker network inspect <bridge-compose-project>_default --format '{{(index .IPAM.Config 0).Subnet}}'`, then for example `sudo ufw allow from <compose-subnet> to any port <mqtt-port> proto tcp`. Recheck after the compose network is recreated, since its subnet can change. Not needed when the broker shares the bridge's compose network. If the broker runs in Docker with a published port, ufw rules don't govern it (Docker's own iptables rules bypass them): bind the published port to a specific host address (e.g. `127.0.0.1:<mqtt-port>:<mqtt-port>`) or filter it in the `DOCKER-USER` chain.
- [ ] Anonymous access off. Passwords live in host-only files (mode 600).
- [ ] Optional TLS (`mqtts://`): give the bridge the broker CA through `telemetry.mqtt.ca_file` (`file:` ref).

## 2. fleet-telemetry container

- [ ] Image `tesla/fleet-telemetry:<tag>` (pin a tag) with the server config from [`adapters/tesla/README.md` → MQTT](../adapters/tesla/README.md#mqtt): `records: { "V": ["mqtt"] }`, `transmit_decoded_records: true`, `mqtt.broker` = `host:port` of the broker, `mqtt.topic_base` = `telemetry`, `qos: 1`, `retained: false`, and its own `client_id` (different from the bridge's).
  - If you do turn on `retained: true`: values the broker replays after a bridge reconnect only fill in fields the bridge hasn't seen yet. For fields it has, the replay is ignored, so a change that happened while the bridge was disconnected fires late, on the next live message for that field (the car's next change or resend), not at reconnect.
- [ ] Ownership events: also `records: { "alerts": ["mqtt"] }` so vehicle alerts reach the broker (`<topic_base>/<VIN>/alerts/<name>/current`).
- [ ] The server cert and key are mounted read-only, and the public port is forwarded to it.
- [ ] Started, and its log shows the MQTT connect health check passing (it fails to start if the broker is unreachable).

## 3. Push the telemetry config to the car (signed, needs the owner's yes)

- [ ] Build the request from `telemetry.fields` in the bridge config: `fields` → `{ "<Field>": { "interval_seconds": N, "resend_interval_seconds": <resend_interval_s> } }`, plus `prefer_typed: true`, `hostname: <telemetry-fqdn>`, `port`, `ca` (the fleet-telemetry server's CA chain) and an `exp`.
- [ ] Ownership events: add the fields from [`adapters/tesla/README.md` → Telemetry fields for ownership](../adapters/tesla/README.md#telemetry-fields-for-ownership) and `alert_types` (the values are only community-documented; see that README section).
- [ ] Send it once through the virtual-key proxy (`POST /api/1/vehicles/fleet_telemetry_config`). Neither the plugin nor the bridge does this today. Do it by hand, or later with the plugin's confirm-gated tool.
- [ ] Check it took: `GET /api/1/vehicles/<VIN>/fleet_telemetry_config` shows `synced: true` once the car is online.

## 4. Energy access token

- [ ] In the plugin's environment, set `TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE=<state-dir>/grokbot-vehicle-fleet/access-token` (an absolute path). After the next refresh the file exists, mode 600, and holds only the raw access token.
- [ ] Mount that file **read-only** into the bridge container, for example at `/run/secrets/tesla-fleet/access-token`, and set `energy_poll.token_ref` to `file:/run/secrets/tesla-fleet/access-token`.
- [ ] Never mount or reference the plugin's `tokens.json`. The bridge must never refresh.
- [ ] Security: that token carries **all** the plugin's scopes, including `energy_cmds` (Powerwall commands need no proxy signing). Only run the bridge on a host you trust as much as the plugin host, with the file readable by the bridge's user only. A bridge-owned sign-in limited to `energy_device_data` is the alternative, and it isn't implemented.

## 5. Bridge config (host-only `config/tesla.json`)

- [ ] Start from `adapters/tesla/config.example.json`. Set `telemetry.mode: "mqtt"`, `telemetry.mqtt.broker` (a literal loopback or LAN URL such as `mqtt://<broker-host>:1883`, or an `env:` / `file:` ref), `client_id`, `topic_base`, `username_ref` / `password_ref` (refs to the `bridge` broker user), `vin_allowlist`, `rules` and `routes` (route `agent` = the registry alias that should wake).
- [ ] `energy_poll`: `site_allowlist`, `api_base` (your region's Fleet API base URL: `https://fleet-api.prd.na.vn.cloud.tesla.com`, `…eu…` or `https://fleet-api.prd.cn.vn.cloud.tesla.cn`; other hosts are refused) and `token_ref` from step 4.
- [ ] If the broker is a compose service, put the bridge on the same compose network and use the service name (`mqtt://mosquitto:1883`). Single-label names are accepted as LAN.
- [ ] In `config/bridge.json`, set `adapters.tesla.enabled: true` (telemetry first: leave `energy_poll.enabled: false` until step 6 passes).
- [ ] Ownership events (optional): `ownership.enabled: true`, `ownership.vehicles` (one entry per car, VINs also in `vin_allowlist`), a route with `match: { "kind": "ownership" }` whose `agent` is the alias that should get them, and `ownership.rest` (`api_base`, `token_ref`) for recalls / warranty / service status.
- [ ] `node dist/src/main.js --check` → `ok`, with `tesla` in the adapter list.
- [ ] `docker compose up -d --force-recreate universal-bridge`.

## 6. Verify

- [ ] `/healthz` returns 200.
- [ ] Live check (prints masked ids and counts only, never secrets). The image already has the `mqtt` package:

  ```
  docker compose run -T --rm -v "$PWD/scripts:/app/scripts:ro" universal-bridge \
    node scripts/tesla-live-check.mjs --tesla-config /app/config/tesla.json --listen 60
  ```

  Expect `connected`, `subscribed`, and field counts for your masked VIN (wake the car with the app first, or wait for a resend). Add `--energy` once energy polling is on, for one read-only `live_status` per site.
- [ ] Audit (`data/audit.jsonl`): `connection` lines `mqtt_connected` and `mqtt_subscribed`, no `bad_record`, no `vin_not_allowlisted` for your car (that line is rate-limited to once per VIN per 10 min, so one line can stand for many messages; see its `count`). Tesla audit lines carry your car's full VIN as `actor` (`audit_full_vin`, default `true`; set `false` for the last 6); foreign VINs show their last 6 and non-VIN strings show `invalid`. Prompts keep the masked id and `vin_last6`. Repeated `mqtt_subscribe_refused` means the broker ACL doesn't let the `bridge` user read `telemetry/+/v/+`; the bridge keeps retrying with backoff.
- [ ] With energy polling on, the bridge log shows one `[tesla] energy polling on: the exported access token carries every scope…` warning at start. That's expected (see the token security note in the adapter README).
- [ ] End to end: with the car parked, open a door → one `door_open_parked` wake for the routed agent within seconds. Plug in and charge → `plugged_in`; let it finish → `charge_complete` (if those rules wake).
- [ ] Then turn on `energy_poll.enabled`, recreate, and check the audit for `observe` lines without errors. `data/tesla-energy-state.json` appears (mode 600).
- [ ] Restart the bridge once. No duplicate vehicle wakes (the first value after a restart is a baseline) and no repeated energy alert (saved state).

## 7. Rollback

- [ ] Set `adapters.tesla.enabled: false` in `config/bridge.json` and recreate the bridge. Nothing else depends on it, and the bridge sends nothing to the car.
- [ ] Or go back to the previous image tag or commit and `config/tesla.json` copy, then recreate.
- [ ] fleet-telemetry and the broker can keep running, or be stopped. To stop the car streaming, remove the telemetry config (`DELETE /api/1/vehicles/<VIN>/fleet_telemetry_config`, a car change that needs the owner's yes) or let its `exp` lapse.
- [ ] Unset `TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE` in the plugin and delete the exported file if energy polling is abandoned.
- [ ] Audit and hold files stay in the data volume for review. `tesla-energy-state.json` can be deleted safely; the only effect is that the next first poll reports what's already in effect.

## 8. EXPERIMENTAL dashcam auto-save (off by default)

Saves a dashcam clip on the car when a crash/collision or AEB telemetry alert is classified as `collision_or_safety` (same alert-name heuristics as ownership events). Sends community CarServer action 47 (`DashcamSaveClipAction`) through Fleet API `signed_command` (stock `tesla-http-proxy` rejects it). **Unverified until a live test. Needs the owner's yes before any live command.**

- [ ] Ownership events are on (step 5) and alerts reach the bridge.
- [ ] A NIST-P256 private key paired with the car is on the host (mode 600), referenced only as `file:/…` — never in git.
- [ ] Telemetry is authenticated (decoded_token_ref, MQTT username_ref+password_ref, or mTLS PEMs) — dashcam refuses to arm without one.
- [ ] `config/tesla.json` has `dashcam_autosave` (see `adapters/tesla/config.example.json`): `enabled: true`, `api_base`, `token_ref`, `key_ref`, cooldown / global cap, and a route `match: { "kind": "dashcam_autosave" }` whose `agent` is the registry alias that should be notified (example: `example-agent`). Optional `max_alert_age_s` (default 300) refuses stale alerts; `notify_max_per_hour` caps dashcam notifies.
- [ ] Registry has that alias (see `config/registry.example.json` placeholder `example-agent`).
- [ ] Set host env `TESLA_DASHCAM_AUTOSAVE=1`. Any other value (unset, `true`, `yes`) keeps the feature inert even if config says enabled.
- [ ] `node dist/src/main.js --check` → ok.
- [ ] Recreate the bridge. Audit should show `dashcam_autosave_experimental_armed` once. No car command has been sent yet.
- [ ] Live test only with the owner's explicit yes: induce a safe test path or wait for a real safety alert; confirm one `dashcam_autosave_attempt` / `…_saved` or `…_failed` audit line and an immediate notify to the alias. Confirm the car's SavedClips gained a clip. Mark the field-47 encoding verified or file a fix.
- [ ] To disable: unset `TESLA_DASHCAM_AUTOSAVE` (or set anything but `1`) and/or `dashcam_autosave.enabled: false`, recreate. State file `dashcam-autosave-state.json` can stay; it only holds dedupe timestamps keyed by `vehicle_id`.
