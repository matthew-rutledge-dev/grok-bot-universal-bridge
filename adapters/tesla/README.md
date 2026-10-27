# tesla adapter (skeleton)

Status: **skeleton**. The logic and seams are tested. There's no live receiver or energy client yet, and enabling either one without an implementation fails at start.

The split with the Tesla plugin:

* **Bridge (here):** the Fleet Telemetry receiver (mTLS, a public hostname with TLS), energy `live_status` polling (every few minutes), filter + debounce, wake rules, VIN and site allowlists, hold-and-retry, and an audit of event type, masked VIN and time.
* **Plugin:** OAuth and refresh, the Fleet API client, read and command tools, safety (read-only fail-closed, confirm, dry-run, `state_unknown`), and the virtual-key proxy client.

Hard rules (enforced by the config validator and the tests):

* The bridge **never sends vehicle commands**. A config with `commands`/`actions` keys is refused.
* **Never poll `vehicle_data`**, because it wakes the car. Vehicles are push-only through telemetry.
* Replies go back through the agent's **origin channel**, so there's no `/tesla/callback` route.
* Prompts and audit carry a **masked** VIN (`…0001`) only.

Seams to implement:

```ts
interface TelemetryReceiver { start(onRecord: (r: TelemetryRecord) => void): Promise<void>; stop(): Promise<void>; }
interface EnergyStatusSource { liveStatus(siteId: string): Promise<EnergyStatus>; }
```

* **Matches.** Routes match `{ "kind": "vehicle" }` (actor = VIN) or `{ "kind": "energy" }` (actor = site id).
* **Rules.** `{ on, wake, debounce_s, priority }`. Triggers: `charge_complete`, `charge_stopped`, `plugged_in`, `unplugged`, `door_open_parked`, `trunk_open_parked`, `sentry_alert`, `low_battery`, `update_available`, `grid_islanded`, `battery_below_reserve`, `storm_watch`. With `wake: false` the trigger is only observed and audited.
* **To confirm with the plugin author:**
  * the exact telemetry field names and values used by `deriveVehicleTriggers`
  * whether agents need the full VIN in the prompt (today they get the masked one)
  * that `token_ref` is rendered from the vault into `env:`/`file:` by the host loader
