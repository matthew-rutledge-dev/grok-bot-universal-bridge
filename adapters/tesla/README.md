# tesla adapter

The bridge's half of the Tesla split. It turns vehicle telemetry and energy-site status into wake events for a Grok Bot. It **never sends vehicle commands, never wakes a car and never calls `vehicle_data`**.

* **Bridge (here):** telemetry receiver, read-only energy polling, filter + debounce, wake rules, VIN and site allowlists, hold-and-retry, and an audit of event type, id (full VIN, masked site id) and time.
* **Plugin:** OAuth and token refresh, the Fleet API client, read and command tools, safety (read-only fail-closed, confirm, dry-run, `state_unknown`), and the virtual-key proxy client. It also exports the current access token for energy polling (see [Token](#token)).
* **Operator (one time):** pushing `fleet_telemetry_config` to each car. That's a signed request through the virtual-key proxy and a real change to the car, so it's a deliberate one-time operator step (a confirm-gated plugin tool may do it later). The plugin doesn't push it today and the bridge never does. `telemetry.fields` here is the source of truth for that config; see [`docs/TESLA-CUTOVER.md`](../../docs/TESLA-CUTOVER.md).

## Hard rules (enforced by the validator and the tests)

* A config with `commands`/`actions` keys, a `vehicle_data` / `wake_up` / `command/` path, or any refresh-token key (`refresh_token`, `refreshTokenRef`, ...) is refused.
* **EXPERIMENTAL exception:** `tesla.dashcam_autosave` plus env `TESLA_DASHCAM_AUTOSAVE=1` may send community `DashcamSaveClipAction` (CarServer field 47) via Fleet `signed_command`. Off by default; unverified until a live test; needs the owner's yes for live commands. See [Experimental dashcam auto-save](#experimental-dashcam-auto-save).
* Replies go back through the agent's **origin channel**, so there's no `/tesla/callback` route.
* Prompts carry a **masked** VIN or site id only. Wake-trigger prompts show the last 4 characters; ownership events carry `vin_last6` (the owner's spec). There's no full-VIN opt-in for prompts: agents that need the VIN get it from the plugin's `list_vehicles`, and prompts end up in logs and transcripts. Event ids hash only the masked id (plus kind, trigger, priority and time), so they can't be brute-forced back to a VIN.
* Audit lines record the **full VIN** as `actor` (a VIN is not a secret), for allowlisted cars and for denied unknown VINs alike, so the owner's audit can be matched to a car without guessing. Site ids keep the last 4, and every other adapter keeps the core default of 4.

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
* **The VIN comes from the topic.** fleet-telemetry fills it from the car's verified client certificate (`rec.Vin`), the same source the other modes trust. Topics whose VIN isn't 17 valid VIN characters are `bad_record`. VINs not in `vin_allowlist` are dropped right after the topic is parsed, before the payload is parsed or batched, and audited `vin_not_allowlisted` at most once per VIN per 10 min (full VIN as `actor`; the next line's `count` is how many were suppressed in between; at most 256 VINs are remembered, oldest evicted).
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

The MQTT producer always publishes decoded values, whatever `transmit_decoded_records` says (that setting changes what the other dispatchers get). Keep it `true` anyway so a `logger` or other dispatcher you add for debugging emits JSON. `reliable_ack_sources` makes fleet-telemetry ack the car only after the broker took every datum of a payload. With [ownership events](#ownership-events) on, also route `alerts` to `mqtt` (`records: { "V": ["mqtt"], "alerts": ["mqtt"] }`): the bridge then subscribes to `<topic_base>/+/alerts/+/current` as well (payload `{"Name", "StartedAt", "EndedAt", "Audiences"}`, `mqtt_payload.go` `processVehicleAlerts`). The `alerts/<name>/history`, `errors` and `connectivity` topics are never subscribed; leave `errors` and `connectivity` off `mqtt` unless something else needs them.

## Ownership events

Optional (`ownership.enabled`). Change-only, deduped facts about each car for an agent that tracks ownership (updates, mileage, alerts, service, tires, battery health, charging faults, safety, Sentry), sent to the route with `match: { "kind": "ownership" }` (actor = VIN; the route's `agent` is the configurable target). Never a raw stream: each event is one change with a `dedupe_key`, and the same change never produces two events, also across restarts (per-car state in `<data dir>/tesla-ownership-state.json`, mode 600, keyed by `vehicle_id`, never the VIN).

Every event carries the same envelope:

```json
{ "vehicle_id": "example-car", "vin_last6": "000001", "model": "Model 3 Example", "ts": "2026-01-01T12:00:00.000Z",
  "source": "telemetry", "event_type": "tpms", "tier": "immediate", "priority": "high", "dedupe_key": "tpms:fl:very_low:...",
  "data": { "tire": "fl", "psi": 36.5, "state": "very_low", "recommended_psi": 42, "low_by_psi": 5.5 } }
```

`ownership.vehicles` lists the cars (each VIN must also be in `telemetry.vin_allowlist`) with an optional `vehicle_id` (default `car-` + 8 hex of a hash of the VIN), `label` (model/trim; default `CarType` + `Trim` from telemetry, else decoded from the VIN), and `model` / `model_year` for the recall lookup when the VIN can't be decoded. Two or more cars are handled independently: separate state, separate lanes, one digest per car.

### Tiers

* **Immediate** (sent at once): `collision_or_safety` from a safety alert, a **new** recall, a critical `vehicle_alert` (audience in `rules.alerts.immediate_audiences`, default `["Customer"]`, or a name matching `rules.alerts.critical_patterns`), a BMS / HV-interlock fault, a failed software update, and a tire low by more than `rules.tpms.immediate_low_by_psi` (default 5) against `recommended_psi` (default 42).
* **Weekly digest** (everything else): queued (persisted), coalesced by `dedupe_key` (Sentry entries add up to one count per car), and sent once per car at `digest.weekday` / `digest.hour_utc` (default Sunday 13:00 UTC).

### Field mapping (verified)

Checked against `teslamotors/fleet-telemetry` `protos/vehicle_data.proto` and `protos/vehicle_alert.proto` (last proto change 2026-09-24), `datastore/mqtt/mqtt_payload.go`, and Tesla's Fleet Telemetry *Available Data* page and Fleet API endpoint pages.

| Event | Source (real field / alert / endpoint) | Fires when |
|---|---|---|
| `software_update` | `Version` (installed firmware), `SoftwareUpdateVersion` (available update), `SoftwareUpdateInstallationPercentComplete` | `available` (a new version offered), `installing` (progress leaves 0), `done` (`Version` changes; `from` / `to`), `failed`: **no field exists**; inferred when progress drops back to 0 with the old version still installed and the update still offered (`inferred: true`), or an alert matching `update_failed_patterns`. After `done`, `release_notes` (REST) adds the note titles |
| `odometer_milestone` | `Odometer` (miles) | crosses a multiple of `odometer_step_mi` (default 1000). The current odometer is also attached to every service event (`service_mode`, recalls, warranty, service-audience alerts, safety, HV faults) |
| `vehicle_alert` | Alerts stream (`VehicleAlert`: `name`, `audiences` Customer / Service / ServiceFix, `started_at`, `ended_at`) | an alert starts (`active: true`) or ends. Deduped on name + start time. Priority high |
| `service_mode` | `ServiceMode` (boolean) | on / off. **Arriving at / leaving a Service Center**: from `GET /api/1/vehicles/{vin}/service_data` (`service_status` changing into / out of `in_service`; the endpoint is documented, its body isn't, so only `service_status` and `service_etc` are read) |
| `tpms` | `TpmsPressureFl` / `Fr` / `Rl` / `Rr` (bar; psi = bar × 14.5038), `TpmsSoftWarnings` / `TpmsHardWarnings` (`TireLocation` struct) | a tire enters `low` (< `low_psi`, default recommended − 3), `very_low` (low by more than 5 psi: immediate), `high` (> `high_psi`, default recommended + 6), or recovers (0.5 psi hysteresis); a soft or hard TPMS warning appears on a tire |
| `12v_or_hv_battery` | 12V: **no field exists**; alert names matching `lv_battery_patterns`. HV: `BMSState` = `Fault`, `Hvil` = `Fault` (immediate). Monthly: `RatedRange`, `EnergyRemaining`, `BatteryLevel` (+ `NominalFullPackEnergyKwh` when streamed; proto-only, firmware 2026.32+) | 12V warning alert; HV fault; one reading per UTC month at `BatteryLevel` ≥ `hv_min_battery_level` (default 50): range and pack energy extrapolated to 100% |
| `charging_fault` | `DetailedChargeState`, `ChargeEnableRequest`, `ChargeLimitSoc`, `BatteryLevel`; error code: **no field exists**, the name of the last alert matching `charging_patterns` (within 15 min) | `Charging`/`Starting` → `NoPower` (power lost), or → `Stopped` while `ChargeEnableRequest` is still true and below the limit (`inferred: true`; a user stop flips `ChargeEnableRequest` to false); or a charging alert |
| `collision_or_safety` | Airbag / collision / AEB activation: **not exposed** as telemetry fields (`ForwardCollisionWarning`, `AutomaticEmergencyBrakingOff` are settings). Mapped from alert names matching `safety_patterns`; `AutomaticEmergencyBrakingOff` changes are reported as an `aeb_setting` digest line | a safety alert starts (immediate, with city-level location and odometer) |
| `sentry_or_security` | `SentryMode` (`Aware`, `Panic`) | entering `Aware` or `Panic` (`Panic` → `Aware` is the same incident). Data is `count` and `last_at` only |
| `recall` | Fleet API has **no recalls endpoint**. NHTSA `GET https://api.nhtsa.gov/recalls/recallsByVehicle?make=TESLA&model=…&modelYear=…` (model and year decoded from the VIN on this host; neither the VIN, the token nor anything else identifying goes to NHTSA) | a campaign number not seen before (immediate). The first pull is one digest baseline line. Model/year scope: whether a recall is open or done for this exact car is only in the Tesla app or Tesla's VIN recall search |
| `warranty_status` | `GET /api/1/dx/warranty/details?vin=` (`activeWarranty` / `upcomingWarranty` / `expiredWarranty`, `WarrantyItem` keys) | the summary changes (digest) |

Alert names are not published by Tesla, so the `*_patterns` defaults in `ownership.ts` (`DEFAULT_PATTERNS`) are heuristics, not verified names. Check them against your cars' alerts (the plugin's `get_recent_alerts` read) and override them in `rules.alerts`. An alert that matches a pattern becomes that event type instead of a plain `vehicle_alert`.

The Errors stream (`vehicle_error.proto`) is the car's telemetry client reporting its own problems (bad config, unknown field), not vehicle fault codes: an errors record is only counted in the audit (`telemetry_client_errors`).

### What is never sent

* No location trail: `Location` is rounded to one decimal (about 11 km, city level) the moment it's parsed, the precise value is never stored, and only the last coarse value is kept, in memory. It's attached only to `collision_or_safety` and service events, and `rules.location: false` turns that off.
* No tokens or keys, no cabin or camera media (no such field is read), no full VIN in prompts (the envelope has `vin_last6`; prompts and the state file never hold the VIN; only the local audit file records it), no raw streams (changes only).

### REST pull (`ownership.rest`, off by default)

Daily / weekly per car, never per record: `service_data` every `service_h` (default 24), warranty every `warranty_h` (168), NHTSA recalls every `recalls_h` (168), `recent_alerts` every `recent_alerts_h` (default 0 = off; a backup for cars without the Alerts stream), and `release_notes` once after a version change (`release_notes`, default true). `token_ref` is an access token with `vehicle_device_data` (the plugin's export file works; same security note as [Token](#token)); it's re-read on every call and sent to `api_base` only. Each pull kind (service, warranty, recalls, recent alerts, release notes) runs on its own: **any** failure (a 404, a 500, a timeout) backs that kind off for an hour, and the attempt time is saved in the state file, so a missing endpoint costs one billed call an hour at most, not one a minute; the other kinds still run. On 429 every Fleet API pull also waits for `Retry-After`, and on auth errors for an hour; the NHTSA lookup is not paused by those. `api_base` must be one of the Fleet API regional hosts (`https://fleet-api.prd.na.vn.cloud.tesla.com`, `https://fleet-api.prd.eu.vn.cloud.tesla.com`, `https://fleet-api.prd.cn.vn.cloud.tesla.cn`) and `nhtsa_base` (optional) must be `https://api.nhtsa.gov`; anything else is refused. Redirects are refused, not followed, and a response body over 1 MiB is aborted while it streams (`redirect_refused`, `response_too_large`). None of these calls touch `vehicle_data`, wake a car or send a command. Tesla bills each Fleet API answer below 500, so the defaults stay at a few calls per car per week.

### Telemetry fields for ownership

Add these to `telemetry.fields` (and so to the pushed `fleet_telemetry_config`): `Version` 3600, `SoftwareUpdateInstallationPercentComplete` 60, `Odometer` 600, `ServiceMode` 60, `TpmsPressureFl` / `Fr` / `Rl` / `Rr` 600, `TpmsSoftWarnings` / `TpmsHardWarnings` 60, `ChargeEnableRequest` 60, `ChargeLimitSoc` 600, `RatedRange` 600, `EnergyRemaining` 600, `BMSState` 60, `Hvil` 60, `AutomaticEmergencyBrakingOff` 3600, `CarType` 86400, `Trim` 86400, `Location` 300 (only if location on safety/service events is wanted; it needs the `vehicle_location` scope). Alerts additionally need `alert_types` in the vehicle config: community examples use `["service"]` (some add `"customer"`, `"service-fix"`, matching the `Audience` enum); Tesla's endpoint page doesn't list the values, so confirm on the first push. The plugin repo's telemetry field doc has the full request body; pushing it is an operator step that needs the owner's yes.

## Energy polling

* `live_status` right at start, then every `interval_s` (default 300, floor 60). A tick is skipped while the previous poll is still running, and a failed tick is audited `poll_failed`.
* `backup_reserve_percent` comes from `site_info`, fetched rarely (cached `site_info_ttl_s`, default 600).
* Grid outage (`grid_islanded`): `island_status` starts with `off_grid` (`off_grid_unintentional` is the real outage, and the prompt says so; `off_grid_intentional` is user-chosen) or `grid_status` is `Inactive`.
* Empty bodies and `{ "response": {} }` are tolerated. A status with no known fields is audited `no_data` and doesn't overwrite the last good status, so a gap can't re-arm `grid_islanded`.
* Errors are mapped, never swallowed: `fleet_api_unreachable`, `fleet_api_tls_error`, `unauthorized`, `login_required`, `missing_scope`, `rate_limited`, `no_token`, `fleet_api_error`, `redirect_refused`, `response_too_large`. On a 429 the adapter skips polls until `Retry-After` passes (default 60 s, capped at 3600 s). On auth failures it backs off (interval × 2ⁿ, capped at 1 h).
* **Energy state survives restarts.** The last good status and the debounce times per allowlisted site go to `<data dir>/tesla-energy-state.json` (mode 600, written to a temp file and renamed). After a restart the saved status is the baseline, so an outage that's still going doesn't re-fire `grid_islanded`, and the debounce windows carry on. Saved state older than 24 h, or for sites no longer allowlisted, is ignored, so an outage at the first poll after a long gap is still reported. With no data dir (memory only), the first poll after a restart is compared against nothing and reports what's already in effect.
* Only `GET /api/1/energy_sites/{id}/live_status` and `/site_info` are called, on the `api_base` you configure, which must be one of the three Fleet API regional hosts (NA / EU / CN); any other host is refused at config load. Redirects are never followed and bodies over 1 MiB are aborted mid-stream.

### Token

* **Where it comes from.** The Tesla plugin exports its current access token when `TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE` is set (an absolute path; unset = off), for example `<state-dir>/grokbot-vehicle-fleet/access-token`. The file holds only the raw token, mode 0600, written atomically on each refresh. Point the bridge at it with a `file:` ref: `"token_ref": "file:/<state-dir>/grokbot-vehicle-fleet/access-token"` (mount it read-only into the container).
* **Never point the bridge at the plugin's `tokens.json`** (its refresh-token store) and never let the bridge refresh. Tesla refresh tokens rotate and are single-use, so a second refresher races the plugin and both end up at `login_required`.
* **Security note.** The exported token carries **every scope the plugin was granted**, including `energy_cmds` (Powerwall commands need no proxy signing), not just `energy_device_data`. The bridge only calls the two read-only `GET` endpoints below, but anyone who can read that file or the bridge's environment can command the Powerwall until the token expires (about 8 h). The adapter logs one warning at start saying so whenever `energy_poll.enabled` is on. Trust the bridge host as much as the plugin host: same machine or same trust boundary, file readable only by the bridge's user, no shared mounts. The alternative is a separate Tesla sign-in limited to `energy_device_data`, with the bridge keeping its own refresh chain and token store. **That isn't implemented**; it would need its own OAuth client setup and a refresh owner inside the bridge.
* `token_ref` is an **access token only**, as `env:` or `file:` (`vault:` and literals are refused; the host renders the vault value into one of these). Scope: **`energy_device_data`** only.
* **Never give the bridge a refresh token.** Tesla refresh tokens rotate and are single-use, so a second refresher would race the plugin and both would end up at `login_required`. The plugin owns refresh.
* Access tokens last about 8 h. The ref is **re-read on every poll and again after a 401**. If the re-read token differs, the request is retried once with it; otherwise the adapter audits `unauthorized` and backs off. A `file:` ref the plugin or host rewrites is therefore picked up without a restart.

## Config

See `config.example.json`. Routes match `{ "kind": "vehicle" }` (actor = VIN), `{ "kind": "energy" }` (actor = site id), `{ "kind": "ownership" }` (actor = VIN; ownership events and digests) or `{ "kind": "dashcam_autosave" }` (actor = VIN; experimental dashcam notify). Rules are `{ on, wake, debounce_s, priority }`. With `wake: false` a trigger is only observed and audited.


## Experimental dashcam auto-save

Requires an authenticated telemetry source (decoded bearer, MQTT creds, or mTLS) when enabled. Off by default. Master switch: host env `TESLA_DASHCAM_AUTOSAVE` must be exactly `1` **and** `dashcam_autosave.enabled: true` in the Tesla config. Any other env value leaves the feature inert.

When an ownership `collision_or_safety` event fires for an **alert start** (not `aeb_setting`, not alert end), the bridge:

1. Notifies the route with `match: { "kind": "dashcam_autosave" }` (route `agent`, e.g. `example-agent`) with at most `trigger` + one outcome (`saved` / `failed` / `unconfirmed`). Deduped and suppressed cases are audited only. Ownership still sends the `collision_or_safety` event on its own route once.
2. Refuses alerts older than `max_alert_age_s` (default 300 s). Dedupes by alert key (`vehicle_id|name|started_at`) in `<data dir>/tesla-dashcam-autosave-state.json` (mode 600), applies a per-car cooldown (default 10 min) and a global hourly cap (default 10).
3. If not suppressed: POSTs a Fleet API `signed_command` carrying community CarServer action **47** (`DashcamSaveClipAction`, empty body) after a vehicle-command session handshake + HMAC-SHA256 authorization (see `signed-command.ts` and `THIRD_PARTY_VEHICLE_COMMAND.md`). Stock `tesla-http-proxy` rejects this action.
4. Notifies again with `saved`, `failed`, `deduped`, or `suppressed`. Every notify is immediate (never digest). Audit lines carry the full VIN (notify prompts and envelopes keep `vin_last6`); never tokens or key material.

**Unverified until a live test:** field number 47 and the empty body are community knowledge, not in the public `car_server.proto`. Do not enable against a real car without the owner's explicit yes. Config example and cutover checklist: `config.example.json`, [`docs/TESLA-CUTOVER.md`](../../docs/TESLA-CUTOVER.md) §8.
