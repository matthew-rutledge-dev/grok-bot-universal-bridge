# tesla adapter

The bridge's half of the Tesla split. It turns vehicle telemetry and energy-site status into wake events for a Grok Bot. It **never sends vehicle commands, never wakes a car and never calls `vehicle_data`**.

* **Bridge (here):** telemetry receiver, read-only energy polling, filter + debounce, wake rules, VIN and site allowlists, hold-and-retry, and an audit of event type, masked id and time.
* **Plugin:** OAuth and token refresh, the Fleet API client, read and command tools, safety (read-only fail-closed, confirm, dry-run, `state_unknown`), and the virtual-key proxy client. It also exports the current access token for energy polling (see [Token](#token)).
* **Operator (one time):** pushing `fleet_telemetry_config` to each car. That's a signed request through the virtual-key proxy and a real change to the car, so it's a deliberate one-time operator step (a confirm-gated plugin tool may do it later). The plugin doesn't push it today and the bridge never does. `telemetry.fields` here is the source of truth for that config; see [`docs/TESLA-CUTOVER.md`](../../docs/TESLA-CUTOVER.md).

## Hard rules (enforced by the validator and the tests)

* A config with `commands`/`actions` keys, a `vehicle_data` / `wake_up` / `command/` path, or any refresh-token key (`refresh_token`, `refreshTokenRef`, ...) is refused.
* Replies go back through the agent's **origin channel**, so there's no `/tesla/callback` route.
* Prompts and audit carry a **masked** VIN or site id (last 4 characters) only. Event ids hash only the masked id (plus kind, trigger, priority and time), so they can't be brute-forced back to a VIN. There's no full-VIN opt-in: agents that need the VIN get it from the plugin's `list_vehicles`, and prompts end up in logs and transcripts.

## Telemetry

Field names follow `teslamotors/fleet-telemetry` `protos/vehicle_data.proto`. Push the vehicle config with **`prefer_typed: true`** (the validator refuses `prefer_typed: false`), so enums come typed and prefixed (`ShiftStateP`, `DetailedChargeStateComplete`, `SentryModeStateAware`, `CableTypeSAE`) and `DoorState` comes as a struct. The prefix is stripped before comparing, and unprefixed values (`P`, `Complete`) are accepted too.

| Trigger | Field | Fires when |
|---|---|---|
| `charge_complete` / `charge_stopped` | `DetailedChargeState` | becomes `Complete` / becomes `Stopped` from `Charging` or `Starting` (so `Disconnected` → `Stopped` is only `plugged_in`) |
| `plugged_in` / `unplugged` | `DetailedChargeState` | leaves `Disconnected` / returns to `Disconnected`. Backup while `DetailedChargeState` isn't streamed: `ChargingCableType` going from invalid or `SNA` (no cable) to a cable type, and back |
| `door_open_parked` | `DoorState` (`DriverFront`, `DriverRear`, `PassengerFront`, `PassengerRear`) | any door turns true while parked (`Gear` P; a car that never streamed `Gear`, or sends Unknown/Invalid/SNA, also counts as parked, so the validator requires `Gear` and `DoorState` in `telemetry.fields` when a door/trunk rule wakes) |
| `trunk_open_parked` | `DoorState` (`TrunkFront`, `TrunkRear`) | either turns true while parked |
| `sentry_alert` | `SentryMode` | becomes `Aware`; `Panic` fires with priority **high** regardless of the rule. `Panic` → `Aware` is the same incident winding down and doesn't fire again |
| `low_battery` | `BatteryLevel` (the app %, not `Soc`) | crosses below `low_battery_percent` (default 20). Numeric strings are parsed with `Number()` |
| `update_available` | `SoftwareUpdateVersion` | goes from empty to a version |

Edge rules:

* The first value of a field after a restart is a **baseline** and never fires.
* `invalid: true` values are not recorded as changes (the last good value stays), except `ChargingCableType`, where invalid means "no cable".
* Records with `is_resend` update the stored state but never fire (audited `resend`). Records older than the last `createdAt` seen for that VIN are skipped entirely (audited `stale_record`).
* Field names that don't exist or are deprecated (`ChargeState`, `ChargeCableConnected`, `TrunkOpen`, `SentryAlert`, `SoftwareUpdateAvailable`) are refused in `telemetry.fields` with the replacement named. `Soc` is accepted as stream-only: no trigger reads it, and `low_battery` reads `BatteryLevel` (the app %).
* `telemetry.fields` maps field → `interval_seconds` (whole seconds ≥ 1). `resend_interval_s` is the long `resend_interval_seconds` applied to every field, so a car re-sends unchanged values now and then (an unchanged value never fires).

### Recommended fields

| Field | interval_seconds | Used by |
|---|---|---|
| `DetailedChargeState` | 60 | charge_complete, charge_stopped, plugged_in, unplugged |
| `ChargingCableType` | 60 | plugged_in / unplugged backup |
| `DoorState` | 10 | door_open_parked, trunk_open_parked |
| `SentryMode` | 10 | sentry_alert |
| `Gear` | 10 | parked check for doors and trunks |
| `Soc` | 300 | stream-only (context) |
| `BatteryLevel` | 300 | low_battery |
| `SoftwareUpdateVersion` | 3600 | update_available |

With `prefer_typed: true` and `resend_interval_s: 21600`. Newer car firmware always sends typed values and ignores `prefer_typed`. The bridge accepts both.

### Receiver modes

* **`mqtt` (recommended).** Run Tesla's fleet-telemetry server with its MQTT dispatcher (`records: { "V": ["mqtt"] }`) and a broker on loopback or the LAN. The bridge subscribes to that broker directly with the pure-JS `mqtt` package, so there's no relay process and nothing native to build. See [MQTT](#mqtt) below.
* **`decoded` (the default when `mode` is unset).** Run Tesla's own fleet-telemetry server. It terminates the cars' mTLS, verifies their certs and decodes their frames. Set `transmit_decoded_records: true` and relay its JSON records (from a dispatcher you already run, e.g. MQTT, Redis, ZMQ or the logger) to the bridge's loopback listener: `POST http://<decoded_listen>/records` with one record, a JSON array, or NDJSON. `decoded_listen` must be loopback. `decoded_token_ref` optionally requires a bearer; when it's set it must resolve at startup (or start fails), and if it later resolves empty the listener answers 503 (fail closed, never "no auth"). Requests time out after 10 s.
* **`mtls`.** The bridge terminates TLS itself on `listen` with `requestCert` + `rejectUnauthorized`, verifying client certs against `client_ca` (the Tesla vehicle CA). The VIN is taken from the **verified client certificate's Subject CN**, never from the payload, and a record whose payload VIN disagrees is dropped (`vin_cert_mismatch`). Text WebSocket frames must carry decoded JSON records. Failed TLS handshakes (scanners, wrong or missing client cert) are not logged one per hit: the first in each 60 s window writes one `tls_handshake_failed` audit line, and the rest are summed into the next line's `count`. There is no timer: a pending count stays unwritten until the next failed handshake after the window, or until `stop()` flushes it, so after a burst the audit file can lag behind (`pendingTlsFailures()` shows it). Frame errors (over 1 MB, invalid UTF-8, bad opcodes) are audited `bad_record` and the socket is terminated; they never crash the process. Native vehicle frames (binary: a flatbuffers envelope around protobuf) are **not decoded** here and are dropped as `undecodable_frame`, so use `mqtt` or `decoded` mode for real cars. `tls_cert`, `tls_key` and `client_ca` are `file:` refs (read whole) or `env:` refs (`\n` escapes allowed).

## MQTT

Checked against `teslamotors/fleet-telemetry` at commit `bd076fe1494841707528449560c4a19d0d426da4` (last change to `datastore/mqtt`: `3b4e7c0b389eb06ca7d5da19c55ddd9fbd442ba2`): `datastore/mqtt/README.md` (topic structure and payload formats), `datastore/mqtt/mqtt_payload.go` (`processVehicleFields`, `payloadToMap`, `getDatumValue`) and `datastore/mqtt/mqtt.go` (`Config`, `Produce`).

| What fleet-telemetry publishes | Topic | Payload |
|---|---|---|
| Vehicle data (`V`), one message per datum | `<topic_base>/<VIN>/v/<Field>` | the datum value as JSON only: `"DetailedChargeStateComplete"`, `80.5` or `"80.5"`, `{"DriverFront":false,…,"TrunkRear":false}` for `DoorState`, `null` for an invalid datum |
| Alerts | `<topic_base>/<VIN>/alerts/<name>/current` and `/history` | not subscribed |
| Errors | `<topic_base>/<VIN>/errors/<name>` | not subscribed |
| Connectivity | `<topic_base>/<VIN>/connectivity` | not subscribed |

How the bridge maps it:

* It subscribes to `<topic_base>/+/v/+` at `qos` 1 (default; 0 allowed) with a clean session.
* **The VIN comes from the topic.** fleet-telemetry fills it from the car's verified client certificate (`rec.Vin`), the same source the other modes trust. Topics whose VIN isn't 17 valid VIN characters are `bad_record`. VINs not in `vin_allowlist` are dropped right after the topic is parsed, before the payload is parsed or batched, and audited `vin_not_allowlisted` at most once per VIN per 10 min (masked `actor`; the next line's `count` is how many were suppressed in between; at most 256 VINs are remembered, oldest evicted).
* Field messages carry **no `created_at` and no `is_resend`**: the MQTT producer publishes the value only. So `createdAt` is the bridge's receive time, and a car's resend arrives looking like a live value. An unchanged value never fires, so periodic resends are harmless.
* fleet-telemetry publishes the datums of one vehicle payload back to back, unordered (`SetOrderMatters(false)`). The bridge coalesces one VIN's messages for `batch_ms` (default 250) into one record, so `Gear` and `DoorState` from the same payload are judged together. A repeated field inside the window starts a new record, which keeps the order.
* `null` is an invalid datum (the last good value stays; for `ChargingCableType` it means no cable). Fields the trigger logic doesn't read are ignored. Malformed topics, non-JSON payloads, payloads over 64 KB and wrong shapes (say, a string `DoorState`) are audited `bad_record` and never throw.
* **Set a broker message size limit too.** The 64 KB check runs after the MQTT client has already received and buffered the whole packet, so the broker should refuse big messages first. With Mosquitto: `message_size_limit 65536` in `mosquitto.conf` (a datum is a few hundred bytes at most).
* `Soc` is ignored over MQTT: it's stream-only (no trigger reads it; `low_battery` reads `BatteryLevel`), so its messages are dropped like any other field the trigger logic doesn't read.
* Retained messages (only if fleet-telemetry runs with `retained: true`) are replayed by the broker on every subscribe. They fill in fields the bridge hasn't seen yet, as a baseline, and never fire (audited `retained_baseline`). **A change missed while disconnected fires late:** for a field the bridge has already seen, the replayed value is ignored, not compared, so if (say) `DetailedChargeState` went to `Complete` while the bridge was disconnected, that trigger fires only when the next live message for that field arrives (the car's next change or resend), not on reconnect.
* Reconnects use the bridge's own backoff: `reconnect_min_ms` (1000) doubling to `reconnect_max_ms` (60000), with ±20 % jitter. Audit lines (action `connection`) carry reason codes only, never the URL or credentials: `mqtt_connected`, `mqtt_subscribed`, `mqtt_disconnected`, `mqtt_connect_failed` (with the wait in `ms`), `mqtt_subscribe_refused` (the bridge then closes that connection and the backoff reconnects and subscribes again, so a broker ACL fix is picked up without a restart), `mqtt_connack_not_authorized`, `mqtt_ECONNREFUSED`, and so on.

Config (`telemetry.mqtt`):

| Key | |
|---|---|
| `broker` | `env:NAME` or `file:/abs/path` ref holding the URL, or a literal `mqtt://` / `mqtts://` URL whose host is a dotted-quad loopback, RFC 1918, link-local, ULA, a single-label name (a compose service) or `*.local` / `*.lan` / `*.home.arpa` / `*.internal`. Integer, hex and shorthand IPv4 hosts (`2130706433`, `0x7f000001`, `127.1`, `0177.0.0.1`) are refused as literals. Literal URLs must not carry credentials. A ref that doesn't resolve fails the start. |
| `client_id` | 1-64 of `A-Z a-z 0-9 . _ -`; must differ from fleet-telemetry's own `client_id` |
| `topic_base` | fleet-telemetry's `mqtt.topic_base`; no wildcards, no leading or trailing `/` |
| `qos` | 1 (default) or 0 |
| `username_ref` / `password_ref` | optional refs, re-read before every reconnect so a rotated broker password is picked up. A set ref that doesn't resolve fails the start. |
| `ca_file` | `file:` ref to the broker's CA (PEM) for `mqtts://` |
| `batch_ms`, `reconnect_min_ms`, `reconnect_max_ms` | tuning, see above |

Matching fleet-telemetry server config (placeholders; the MQTT part follows `datastore/mqtt/README.md`, whose `broker` is `host:port`):

```json
{
  "host": "0.0.0.0",
  "port": 4443,
  "log_level": "info",
  "json_log_enable": true,
  "namespace": "tesla_telemetry",
  "transmit_decoded_records": true,
  "reliable_ack_sources": { "V": "mqtt" },
  "records": { "V": ["mqtt"] },
  "mqtt": {
    "broker": "127.0.0.1:1883",
    "client_id": "fleet-telemetry",
    "username": "<broker-user-for-fleet-telemetry>",
    "password": "<broker-password-for-fleet-telemetry>",
    "topic_base": "telemetry",
    "qos": 1,
    "retained": false
  },
  "tls": {
    "server_cert": "/etc/fleet-telemetry/tls.crt",
    "server_key": "/etc/fleet-telemetry/tls.key"
  }
}
```

The MQTT producer always publishes decoded values, whatever `transmit_decoded_records` says (that setting changes what the other dispatchers get). Keep it `true` anyway so a `logger` or other dispatcher you add for debugging emits JSON. `reliable_ack_sources` makes fleet-telemetry ack the car only after the broker took every datum of a payload. Leave `alerts`, `errors` and `connectivity` off `mqtt` unless something else needs them; the bridge doesn't subscribe to them.

## Energy polling

* `live_status` right at start, then every `interval_s` (default 300, floor 60). A tick is skipped while the previous poll is still running, and a failed tick is audited `poll_failed`.
* `backup_reserve_percent` comes from `site_info`, fetched rarely (cached `site_info_ttl_s`, default 600).
* Grid outage (`grid_islanded`): `island_status` starts with `off_grid` (`off_grid_unintentional` is the real outage, and the prompt says so; `off_grid_intentional` is user-chosen) or `grid_status` is `Inactive`.
* Empty bodies and `{ "response": {} }` are tolerated. A status with no known fields is audited `no_data` and doesn't overwrite the last good status, so a gap can't re-arm `grid_islanded`.
* Errors are mapped, never swallowed: `fleet_api_unreachable`, `fleet_api_tls_error`, `unauthorized`, `login_required`, `missing_scope`, `rate_limited`, `no_token`, `fleet_api_error`. On a 429 the adapter skips polls until `Retry-After` passes (default 60 s, capped at 3600 s). On auth failures it backs off (interval × 2ⁿ, capped at 1 h).
* **Energy state survives restarts.** The last good status and the debounce times per allowlisted site go to `<data dir>/tesla-energy-state.json` (mode 600, written to a temp file and renamed). After a restart the saved status is the baseline, so an outage that's still going doesn't re-fire `grid_islanded`, and the debounce windows carry on. Saved state older than 24 h, or for sites no longer allowlisted, is ignored, so an outage at the first poll after a long gap is still reported. With no data dir (memory only), the first poll after a restart is compared against nothing and reports what's already in effect.
* Only `GET /api/1/energy_sites/{id}/live_status` and `/site_info` are called, on the `api_base` you configure (your region's Fleet API base URL).

### Token

* **Where it comes from.** The Tesla plugin exports its current access token when `TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE` is set (an absolute path; unset = off), for example `<state-dir>/grokbot-vehicle-fleet/access-token`. The file holds only the raw token, mode 0600, written atomically on each refresh. Point the bridge at it with a `file:` ref: `"token_ref": "file:/<state-dir>/grokbot-vehicle-fleet/access-token"` (mount it read-only into the container).
* **Never point the bridge at the plugin's `tokens.json`** (its refresh-token store) and never let the bridge refresh. Tesla refresh tokens rotate and are single-use, so a second refresher races the plugin and both end up at `login_required`.
* **Security note.** The exported token carries **every scope the plugin was granted**, including `energy_cmds` (Powerwall commands need no proxy signing), not just `energy_device_data`. The bridge only calls the two read-only `GET` endpoints below, but anyone who can read that file or the bridge's environment can command the Powerwall until the token expires (about 8 h). The adapter logs one warning at start saying so whenever `energy_poll.enabled` is on. Trust the bridge host as much as the plugin host: same machine or same trust boundary, file readable only by the bridge's user, no shared mounts. The alternative is a separate Tesla sign-in limited to `energy_device_data`, with the bridge keeping its own refresh chain and token store. **That isn't implemented**; it would need its own OAuth client setup and a refresh owner inside the bridge.
* `token_ref` is an **access token only**, as `env:` or `file:` (`vault:` and literals are refused; the host renders the vault value into one of these). Scope: **`energy_device_data`** only.
* **Never give the bridge a refresh token.** Tesla refresh tokens rotate and are single-use, so a second refresher would race the plugin and both would end up at `login_required`. The plugin owns refresh.
* Access tokens last about 8 h. The ref is **re-read on every poll and again after a 401**. If the re-read token differs, the request is retried once with it; otherwise the adapter audits `unauthorized` and backs off. A `file:` ref the plugin or host rewrites is therefore picked up without a restart.

## Config

See `config.example.json`. Routes match `{ "kind": "vehicle" }` (actor = VIN) or `{ "kind": "energy" }` (actor = site id). Rules are `{ on, wake, debounce_s, priority }`. With `wake: false` a trigger is only observed and audited.
