# tesla adapter

The bridge's half of the Tesla split. It turns vehicle telemetry and energy-site status into wake events for a Grok Bot. It **never sends vehicle commands, never wakes a car and never calls `vehicle_data`**.

* **Bridge (here):** telemetry receiver, read-only energy polling, filter + debounce, wake rules, VIN and site allowlists, hold-and-retry, and an audit of event type, masked id and time.
* **Plugin:** OAuth and token refresh, the Fleet API client, read and command tools, safety (read-only fail-closed, confirm, dry-run, `state_unknown`), the virtual-key proxy client, and pushing `fleet_telemetry_config` to the cars.

## Hard rules (enforced by the validator and the tests)

* A config with `commands`/`actions` keys, a `vehicle_data` / `wake_up` / `command/` path, or any refresh-token key (`refresh_token`, `refreshTokenRef`, ...) is refused.
* Replies go back through the agent's **origin channel**, so there's no `/tesla/callback` route.
* Prompts and audit carry a **masked** VIN or site id (last 4 characters) only. Event ids hash only the masked id (plus kind, trigger, priority and time), so they can't be brute-forced back to a VIN. There's no full-VIN opt-in: agents that need the VIN get it from the plugin's `list_vehicles`, and prompts end up in logs and transcripts.

## Telemetry

Field names follow `teslamotors/fleet-telemetry` `protos/vehicle_data.proto`. Push the vehicle config with **`prefer_typed: true`** (the validator refuses `prefer_typed: false`), so enums come typed and prefixed (`ShiftStateP`, `DetailedChargeStateComplete`, `SentryModeStateAware`, `CableTypeSAE`) and `DoorState` comes as a struct. The prefix is stripped before comparing, and unprefixed values (`P`, `Complete`) are accepted too.

| Trigger | Field | Fires when |
|---|---|---|
| `charge_complete` / `charge_stopped` | `DetailedChargeState` | becomes `Complete` / `Stopped` |
| `plugged_in` / `unplugged` | `DetailedChargeState` | leaves `Disconnected` / returns to `Disconnected`. Backup while `DetailedChargeState` isn't streamed: `ChargingCableType` going from invalid or `SNA` (no cable) to a cable type, and back |
| `door_open_parked` | `DoorState` (`DriverFront`, `DriverRear`, `PassengerFront`, `PassengerRear`) | any door turns true while parked (`Gear` P; a car that never streamed `Gear`, or sends Unknown/Invalid/SNA, also counts as parked, so the validator requires `Gear` and `DoorState` in `telemetry.fields` when a door/trunk rule wakes) |
| `trunk_open_parked` | `DoorState` (`TrunkFront`, `TrunkRear`) | either turns true while parked |
| `sentry_alert` | `SentryMode` | becomes `Aware`; `Panic` fires with priority **high** regardless of the rule |
| `low_battery` | `BatteryLevel` (the app %, not `Soc`) | crosses below `low_battery_percent` (default 20). Numeric strings are parsed with `Number()` |
| `update_available` | `SoftwareUpdateVersion` | goes from empty to a version |

Edge rules:

* The first value of a field after a restart is a **baseline** and never fires.
* `invalid: true` values are not recorded as changes (the last good value stays), except `ChargingCableType`, where invalid means "no cable".
* Records with `is_resend` and records older than the last `createdAt` seen for that VIN are ignored (audited `resend` / `stale_record`).
* Field names that don't exist or are deprecated (`ChargeState`, `ChargeCableConnected`, `TrunkOpen`, `SentryAlert`, `SoftwareUpdateAvailable`, `Soc`) are refused in `telemetry.fields` with the replacement named.

### Receiver modes

* **`decoded` (default, recommended).** Run Tesla's own fleet-telemetry server. It terminates the cars' mTLS, verifies their certs and decodes their frames. Set `transmit_decoded_records: true` and relay its JSON records (from a dispatcher you already run, e.g. MQTT, Redis, ZMQ or the logger) to the bridge's loopback listener: `POST http://<decoded_listen>/records` with one record, a JSON array, or NDJSON. `decoded_listen` must be loopback. `decoded_token_ref` optionally requires a bearer; when it's set it must resolve at startup (or start fails), and if it later resolves empty the listener answers 503 (fail closed, never "no auth"). Requests time out after 10 s.
* **`mtls`.** The bridge terminates TLS itself on `listen` with `requestCert` + `rejectUnauthorized`, verifying client certs against `client_ca` (the Tesla vehicle CA). The VIN is taken from the **verified client certificate's Subject CN**, never from the payload, and a record whose payload VIN disagrees is dropped (`vin_cert_mismatch`). Text WebSocket frames must carry decoded JSON records. Failed TLS handshakes (scanners, wrong or missing client cert) are not logged one per hit: the first in each 60 s window writes one `tls_handshake_failed` audit line, and the rest are summed into the next line's `count`. There is no timer: a pending count stays unwritten until the next failed handshake after the window, or until `stop()` flushes it, so after a burst the audit file can lag behind (`pendingTlsFailures()` shows it). Frame errors (over 1 MB, invalid UTF-8, bad opcodes) are audited `bad_record` and the socket is terminated; they never crash the process. Native vehicle frames (binary: a flatbuffers envelope around protobuf) are **not decoded** here and are dropped as `undecodable_frame`, so use `decoded` mode for real cars. `tls_cert`, `tls_key` and `client_ca` are `file:` refs (read whole) or `env:` refs (`\n` escapes allowed).

## Energy polling

* `live_status` right at start, then every `interval_s` (default 300, floor 60). A tick is skipped while the previous poll is still running, and a failed tick is audited `poll_failed`.
* `backup_reserve_percent` comes from `site_info`, fetched rarely (cached `site_info_ttl_s`, default 600).
* Grid outage (`grid_islanded`): `island_status` starts with `off_grid` (`off_grid_unintentional` is the real outage, and the prompt says so; `off_grid_intentional` is user-chosen) or `grid_status` is `Inactive`.
* Empty bodies and `{ "response": {} }` are tolerated. A status with no known fields is audited `no_data` and doesn't overwrite the last good status, so a gap can't re-arm `grid_islanded`.
* Errors are mapped, never swallowed: `fleet_api_unreachable`, `fleet_api_tls_error`, `unauthorized`, `login_required`, `missing_scope`, `rate_limited`, `no_token`, `fleet_api_error`. On a 429 the adapter skips polls until `Retry-After` passes (default 60 s, capped at 3600 s). On auth failures it backs off (interval × 2ⁿ, capped at 1 h).
* Unlike vehicle fields, energy triggers have no restart baseline: an outage, low reserve or storm watch already in effect at the first poll is reported (debounce state is memory-only).
* Only `GET /api/1/energy_sites/{id}/live_status` and `/site_info` are called, on the `api_base` you configure (your region's Fleet API base URL).

### Token

* `token_ref` is an **access token only**, as `env:` or `file:` (`vault:` and literals are refused; the host renders the vault value into one of these). Scope: **`energy_device_data`** only.
* **Never give the bridge a refresh token.** Tesla refresh tokens rotate and are single-use, so a second refresher would race the plugin and both would end up at `login_required`. The plugin owns refresh.
* Access tokens last about 8 h. The ref is **re-read on every poll and again after a 401**. If the re-read token differs, the request is retried once with it; otherwise the adapter audits `unauthorized` and backs off. A `file:` ref the plugin or host rewrites is therefore picked up without a restart.

## Config

See `config.example.json`. Routes match `{ "kind": "vehicle" }` (actor = VIN) or `{ "kind": "energy" }` (actor = site id). Rules are `{ on, wake, debounce_s, priority }`. With `wake: false` a trigger is only observed and audited.
