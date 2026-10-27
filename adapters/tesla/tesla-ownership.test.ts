import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addToDigest,
  BAR_TO_PSI,
  decodeTeslaVin,
  defaultVehicleId,
  fromProtoValue,
  nextDigestAt,
  OwnershipTracker,
  parseAlert,
  parseMqttValue,
  parseNhtsaRecalls,
  parsePayload,
  parseRecentAlerts,
  parseReleaseNotes,
  parseServiceData,
  parseWarranty,
  TeslaAdapter,
  validateTeslaConfig,
  isTokenRef,
  baseUrlProblem,
  EnergyApiError,
  FLEET_API_HOSTS,
  FleetEnergyClient,
  MAX_BODY_BYTES,
  NHTSA_HOSTS,
  OwnershipRestClient,
  PULL_RETRY_MS,
  type CarState,
  type DigestState,
  type FetchLike,
  type OwnershipEvent,
  type TelemetryValue,
  type TeslaConfig,
} from "./index.js";
import { mockRoutine, startBridge } from "../../test/helpers.js";

/** Teardown stack: every server, bridge and adapter is closed even when a test fails half-way (no leaked handles). */
function teardown() {
  const fns: Array<() => unknown> = [];
  return {
    add<T>(v: T, close: (v: T) => unknown): T {
      fns.push(() => close(v));
      return v;
    },
    async run(): Promise<void> {
      for (const f of fns.reverse()) await Promise.resolve().then(f).catch(() => undefined);
    },
  };
}

const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as TeslaConfig;
// Placeholder VINs: position 4 is the model (3, Y), position 10 the model year (L = 2020).
const CAR_A = "5YJ3EXAMPLE000001";
const CAR_B = "7SAYEXAMPLE000002";
const T0 = Date.parse("2026-10-27T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const psi = (p: number) => p / BAR_TO_PSI;

function tracker(rules: ConstructorParameters<typeof OwnershipTracker>[2] = {}, vin = CAR_A, state: CarState = {}) {
  return new OwnershipTracker({ vin, vehicle_id: vin === CAR_A ? "car-a" : "car-b" }, state, rules);
}
/** Feed records one second apart (a shared clock, so keys with a timestamp never collide); returns all events. */
let tick = 0;
function feed(t: OwnershipTracker, ...records: Record<string, TelemetryValue>[]): OwnershipEvent[] {
  const out: OwnershipEvent[] = [];
  for (const r of records) out.push(...t.telemetry(r, iso(T0 + ++tick * 1000)));
  return out;
}
const types = (ev: OwnershipEvent[]) => ev.map((e) => `${e.event_type}/${e.tier}`);

// ---------- parsing / field names ----------

test("ownership: alerts parse from protojson and fleet-telemetry MQTT shapes; errors records are counted only", () => {
  assert.deepEqual(parseAlert({ name: "ExampleAlert_a001", audiences: ["Customer", "Service"], startedAt: "2026-10-27T12:00:00Z" }), {
    name: "ExampleAlert_a001", audiences: ["Customer", "Service"], startedAt: "2026-10-27T12:00:00.000Z", endedAt: undefined,
  });
  assert.equal(parseAlert({ Name: "X_a1", Audiences: ["ServiceFix"], StartedAt: "2026-10-27T12:00:00Z", EndedAt: "2026-10-27T12:05:00Z" })!.endedAt, "2026-10-27T12:05:00.000Z");
  assert.equal(parseAlert({ Name: "bad name with spaces" }), undefined);
  const r = parsePayload({ vin: CAR_A, createdAt: "2026-10-27T12:00:00Z", alerts: [{ name: "A_a1", audiences: ["Customer"], startedAt: "2026-10-27T12:00:00Z" }, { junk: 1 }] })!;
  assert.equal(r.alerts!.length, 1);
  assert.equal(parsePayload({ vin: CAR_A, errors: [{ name: "unknown_field" }] })!.telemetryErrors, 1);
});

test("ownership: TireLocation and Location values (protojson + MQTT); Location is rounded to city level on ingest", () => {
  assert.deepEqual(fromProtoValue({ tireLocationValue: { frontLeft: true, rearRight: true } }), { fl: true, rr: true });
  assert.deepEqual(parseMqttValue("TpmsSoftWarnings", { front_left: true }), { fl: true });
  assert.deepEqual(parseMqttValue("TpmsHardWarnings", {}), {});
  assert.deepEqual(fromProtoValue({ locationValue: { latitude: 37.123456, longitude: -122.98765 } }), { lat: 37.1, lon: -123 });
  assert.deepEqual(parseMqttValue("Location", { latitude: 37.123456, longitude: -122.98765 }), { lat: 37.1, lon: -123 });
  const flat = parsePayload({ vin: CAR_A, data: { Location: { latitude: 1.23456, longitude: 2.34567 } } })!;
  assert.deepEqual(flat.data.Location, { lat: 1.2, lon: 2.3 }, "precise value never kept");
});

test("ownership: VIN decode for the recall lookup stays local; default vehicle_id is a short hash", () => {
  assert.deepEqual(decodeTeslaVin(CAR_A), { model: "Model 3", modelYear: 2020 });
  assert.deepEqual(decodeTeslaVin(CAR_B), { model: "Model Y", modelYear: 2020 });
  assert.deepEqual(decodeTeslaVin("5YJSEXAMPLEK00000"), { model: "Model S", modelYear: 2020 });
  assert.match(defaultVehicleId(CAR_A), /^car-[0-9a-f]{8}$/);
  assert.notEqual(defaultVehicleId(CAR_A), defaultVehicleId(CAR_B));
});

// ---------- event types ----------

test("software_update: available, installing, done (from/to), inferred failure, failure alert; first values are a baseline", () => {
  const t = tracker();
  const ev = feed(t,
    { Version: "2026.32.1", SoftwareUpdateVersion: "", SoftwareUpdateInstallationPercentComplete: 0 },
    { SoftwareUpdateVersion: "2026.38.2" },
    { SoftwareUpdateInstallationPercentComplete: 10 },
    { SoftwareUpdateInstallationPercentComplete: 80 },
    { Version: "2026.38.2", SoftwareUpdateVersion: "", SoftwareUpdateInstallationPercentComplete: 0 },
  );
  assert.deepEqual(ev.map((e) => e.data.phase), ["available", "installing", "done"]);
  assert.deepEqual(ev[2].data, { phase: "done", from: "2026.32.1", to: "2026.38.2" });
  assert.equal(ev[0].tier, "digest");
  // Failure: progress resets with the old version still installed and the update still offered.
  const f = feed(t,
    { SoftwareUpdateVersion: "2026.44.1" },
    { SoftwareUpdateInstallationPercentComplete: 30 },
    { SoftwareUpdateInstallationPercentComplete: 0 },
  );
  assert.deepEqual(f.map((e) => `${e.data.phase}/${e.tier}`), ["available/digest", "installing/digest", "failed/immediate"]);
  assert.equal(f[2].data.inferred, true);
  const a = t.alerts([{ name: "GTW_a001_UpdateFailed", audiences: ["Customer"], startedAt: iso(T0) }], iso(T0), "telemetry");
  assert.deepEqual(types(a), ["software_update/immediate"]);
  assert.equal(a[0].data.phase, "failed");
});

test("odometer_milestone: every 1,000 mi (configurable), never on the first reading; service events carry the odometer", () => {
  const t = tracker();
  const ev = feed(t, { Odometer: 12345.6 }, { Odometer: 12999.9 }, { Odometer: 13000.2 }, { Odometer: 13500 }, { Odometer: 15001 });
  assert.deepEqual(ev.map((e) => e.data.milestone_mi), [13000, 15000]);
  assert.equal(ev[0].data.odometer_mi, 13000.2);
  const s = feed(t, { ServiceMode: false }, { ServiceMode: true });
  assert.equal(s[0].event_type, "service_mode");
  assert.equal(s[0].data.odometer_mi, 15001);
  const t5 = tracker({ odometer_step_mi: 500 });
  assert.deepEqual(feed(t5, { Odometer: 100 }, { Odometer: 501 }).map((e) => e.data.milestone_mi), [500]);
});

test("vehicle_alert: name, audiences, start and end; deduped; Customer audience (default) is immediate, service-only is digest", () => {
  const t = tracker();
  const start = { name: "VCSEC_a001_Example", audiences: ["Customer"], startedAt: "2026-10-27T12:00:00.000Z" };
  const e1 = t.alerts([start], iso(T0), "telemetry");
  assert.deepEqual(types(e1), ["vehicle_alert/immediate"]);
  assert.deepEqual(e1[0].data, { name: start.name, audiences: ["Customer"], started_at: start.startedAt, ended_at: null, active: true });
  assert.equal(e1[0].priority, "high");
  assert.deepEqual(t.alerts([start], iso(T0 + 1000), "telemetry"), [], "same alert again: deduped");
  const end = t.alerts([{ ...start, endedAt: "2026-10-27T12:30:00.000Z" }], iso(T0), "telemetry");
  assert.deepEqual(types(end), ["vehicle_alert/digest"]);
  assert.equal(end[0].data.active, false);
  const svc = t.alerts([{ name: "BMS_a002_Example", audiences: ["Service"], startedAt: iso(T0) }], iso(T0), "telemetry");
  assert.deepEqual(types(svc), ["vehicle_alert/digest"]);
  // critical_patterns make a service alert immediate; immediate_audiences can be narrowed to none.
  const c = tracker({ alerts: { critical_patterns: ["^BMS_"], immediate_audiences: [] } });
  assert.deepEqual(types(c.alerts([{ name: "BMS_a002_Example", audiences: ["Service"], startedAt: iso(T0) }], iso(T0), "telemetry")), ["vehicle_alert/immediate"]);
  assert.deepEqual(types(c.alerts([{ name: "UI_a003_Example", audiences: ["Customer"], startedAt: iso(T0) }], iso(T0), "telemetry")), ["vehicle_alert/digest"]);
});

test("service_mode: on/off from ServiceMode; Service Center arrival/departure from service_data; location city-level only here", () => {
  const t = tracker();
  feed(t, { Location: { lat: 37.1, lon: -122 }, ServiceMode: false });
  const on = feed(t, { ServiceMode: true });
  assert.deepEqual(on[0].data.state, "on");
  assert.deepEqual(on[0].location, { lat: 37.1, lon: -122 });
  assert.deepEqual(t.serviceStatus("not_in_service", undefined, iso(T0)), [], "first status is a baseline");
  const arr = t.serviceStatus("in_service", "2026-10-29T17:00:00Z", iso(T0 + 1));
  assert.equal(arr[0].data.state, "at_service_center");
  assert.equal(arr[0].source, "rest");
  assert.deepEqual(arr[0].location, { lat: 37.1, lon: -122 });
  assert.equal(t.serviceStatus("not_in_service", undefined, iso(T0 + 2))[0].data.state, "left_service_center");
  const noLoc = tracker({ location: false });
  feed(noLoc, { Location: { lat: 1, lon: 2 }, ServiceMode: false });
  assert.equal(feed(noLoc, { ServiceMode: true })[0].location, undefined, "location: false");
  // Non-safety events never carry location.
  const odo = feed(t, { Odometer: 900 }, { Odometer: 1000 });
  assert.equal(odo[0].location, undefined);
});

test("tpms: tire + psi when under/over the configurable thresholds; low by > 5 psi is immediate; warnings; hysteresis", () => {
  const t = tracker({ tpms: { recommended_psi: 42 } });
  const ok = { TpmsPressureFl: psi(42), TpmsPressureFr: psi(42), TpmsPressureRl: psi(42), TpmsPressureRr: psi(42) };
  assert.deepEqual(feed(t, ok), []);
  const low = feed(t, { TpmsPressureFl: psi(38) });
  assert.deepEqual(types(low), ["tpms/digest"]);
  assert.deepEqual({ tire: low[0].data.tire, psi: low[0].data.psi, state: low[0].data.state }, { tire: "fl", psi: 38, state: "low" });
  assert.deepEqual(feed(t, { TpmsPressureFl: psi(38.2) }), [], "same band: no repeat");
  const vlow = feed(t, { TpmsPressureFl: psi(36.5) });
  assert.deepEqual(types(vlow), ["tpms/immediate"]);
  assert.equal(vlow[0].data.low_by_psi, 5.5);
  assert.deepEqual(feed(t, { TpmsPressureFl: psi(37.2) }), [], "hysteresis near the immediate threshold");
  assert.deepEqual(feed(t, { TpmsPressureFl: psi(39.2) }).map((e) => e.data.state), ["low"]);
  assert.deepEqual(feed(t, { TpmsPressureFl: psi(42) }).map((e) => e.data.state), ["ok"], "recovery goes to the digest");
  assert.deepEqual(feed(t, { TpmsPressureRr: psi(49) }).map((e) => `${e.data.tire}/${e.data.state}`), ["rr/high"]);
  feed(t, { TpmsSoftWarnings: {}, TpmsHardWarnings: {} });
  const w = feed(t, { TpmsSoftWarnings: { fl: true } });
  assert.deepEqual(w[0].data, { warning: "soft", tires: ["fl"] });
  const custom = tracker({ tpms: { recommended_psi: 36, low_psi: 34, high_psi: 44, immediate_low_by_psi: 3 } });
  feed(custom, { TpmsPressureFl: psi(36) });
  assert.deepEqual(types(feed(custom, { TpmsPressureFl: psi(32.5) })), ["tpms/immediate"]);
});

test("12v_or_hv_battery: 12V warning from alert names, BMS/HVIL faults (immediate), one HV reading per month", () => {
  const t = tracker();
  const lv = t.alerts([{ name: "VCFRONT_a180_12V_Battery_Low", audiences: ["Customer"], startedAt: iso(T0) }], iso(T0), "telemetry");
  assert.deepEqual(types(lv), ["12v_or_hv_battery/digest"]);
  assert.equal(lv[0].data.kind, "12v_warning");
  const m = feed(t, { BatteryLevel: 40, RatedRange: 120 }, { BatteryLevel: 80, RatedRange: 240, EnergyRemaining: 60 }, { BatteryLevel: 81 });
  assert.deepEqual(m.map((e) => e.data.kind), ["hv_monthly"], "once per month, only at >= 50%");
  assert.equal(m[0].data.range_at_100_mi, 300);
  assert.equal(m[0].data.pack_energy_at_100_kwh, 75);
  assert.equal(t.telemetry({ BatteryLevel: 82 }, "2026-11-02T00:00:00.000Z").length, 1, "next month");
  feed(t, { BMSState: "BMSStateDrive", Hvil: "HvilStatusOK" });
  const f = feed(t, { BMSState: "BMSStateFault" });
  assert.deepEqual(types(f), ["12v_or_hv_battery/immediate"]);
});

test("charging_fault: power lost / stopped while enabled (with the alert name as error code); user stop is not a fault", () => {
  const t = tracker();
  feed(t, { DetailedChargeState: "DetailedChargeStateCharging", ChargeEnableRequest: true, BatteryLevel: 50, ChargeLimitSoc: 80 });
  const a = t.alerts([{ name: "CP_a043_Example", audiences: ["Customer"], startedAt: iso(T0) }], iso(T0), "telemetry");
  assert.deepEqual(types(a), ["charging_fault/digest"]);
  assert.equal(a[0].data.error_code, "CP_a043_Example");
  const lost = t.telemetry({ DetailedChargeState: "DetailedChargeStateNoPower" }, iso(T0 + 60_000));
  assert.deepEqual(types(lost), ["charging_fault/digest"]);
  assert.equal(lost[0].data.kind, "power_lost");
  assert.equal(lost[0].data.error_code, "CP_a043_Example");
  const u = tracker();
  feed(u, { DetailedChargeState: "DetailedChargeStateCharging", ChargeEnableRequest: true, BatteryLevel: 50, ChargeLimitSoc: 80 });
  assert.deepEqual(feed(u, { ChargeEnableRequest: false, DetailedChargeState: "DetailedChargeStateStopped" }), [], "user stop");
  const v = tracker();
  feed(v, { DetailedChargeState: "DetailedChargeStateCharging", ChargeEnableRequest: true, BatteryLevel: 50, ChargeLimitSoc: 80 });
  const s = feed(v, { DetailedChargeState: "DetailedChargeStateStopped" });
  assert.equal(s[0].data.kind, "stopped_while_enabled");
  assert.equal(s[0].data.inferred, true);
  const c = tracker();
  feed(c, { DetailedChargeState: "DetailedChargeStateCharging", ChargeEnableRequest: true, BatteryLevel: 79.5, ChargeLimitSoc: 80 });
  assert.deepEqual(feed(c, { DetailedChargeState: "DetailedChargeStateStopped" }), [], "at the limit: not a fault");
});

test("collision_or_safety: only from alert names (no airbag/collision field exists); immediate with location + odometer; AEB setting change", () => {
  const t = tracker();
  feed(t, { Location: { lat: 40.7, lon: -74 }, Odometer: 2000, AutomaticEmergencyBrakingOff: false });
  const s = t.alerts([{ name: "RCM2_a001_Example_Crash", audiences: ["Customer"], startedAt: iso(T0) }], iso(T0), "telemetry");
  assert.deepEqual(types(s), ["collision_or_safety/immediate"]);
  assert.deepEqual(s[0].location, { lat: 40.7, lon: -74 });
  assert.equal(s[0].data.odometer_mi, 2000);
  const aeb = feed(t, { AutomaticEmergencyBrakingOff: true });
  assert.deepEqual(types(aeb), ["collision_or_safety/digest"]);
  assert.equal(aeb[0].data.aeb_disabled, true);
  const custom = tracker({ alerts: { safety_patterns: ["^MY_SAFETY_"] } });
  assert.deepEqual(types(custom.alerts([{ name: "MY_SAFETY_x", audiences: [], startedAt: iso(T0) }], iso(T0), "telemetry")), ["collision_or_safety/immediate"]);
});

test("sentry_or_security: count + timestamp only; Panic -> Aware is one incident; coalesced in the digest", () => {
  const t = tracker();
  const ev = feed(t, { SentryMode: "SentryModeStateArmed" }, { SentryMode: "SentryModeStateAware" }, { SentryMode: "SentryModeStateArmed" }, { SentryMode: "SentryModeStatePanic" }, { SentryMode: "SentryModeStateAware" });
  assert.equal(ev.length, 2);
  assert.deepEqual(Object.keys(ev[0].data).sort(), ["count", "last_at"]);
  const d: DigestState = { items: {} };
  for (const e of ev) addToDigest(d, e);
  assert.equal(d.items["car-a"].length, 1);
  assert.equal(d.items["car-a"][0].data.count, 2);
  assert.equal(d.items["car-a"][0].data.last_at, ev[1].ts);
});

test("recalls (NHTSA by make/model/year): first pull is one digest baseline; a new campaign is immediate; warranty on change", () => {
  const t = tracker();
  const body = { Count: 2, results: [{ NHTSACampaignNumber: "26V000000", Component: "EXAMPLE", Summary: "s", Remedy: "r", overTheAirUpdate: true }, { NHTSACampaignNumber: "25V000001" }] };
  const base = t.recalls(parseNhtsaRecalls(body), iso(T0));
  assert.deepEqual(types(base), ["recall/digest"]);
  assert.equal(base[0].data.count, 2);
  assert.deepEqual(t.recalls(parseNhtsaRecalls(body), iso(T0 + 1)), []);
  const more = t.recalls(parseNhtsaRecalls({ results: [...body.results, { NHTSACampaignNumber: "26V000099", Component: "NEW" }] }), iso(T0 + 2));
  assert.deepEqual(types(more), ["recall/immediate"]);
  assert.equal(more[0].data.campaign, "26V000099");
  assert.match(String(more[0].data.scope), /make\/model\/year/);
  const w = parseWarranty({ response: { activeWarranty: [{ warrantyType: "BASIC", warrantyDisplayName: "Basic", expirationDate: "2027-01-01T00:00:00Z", expirationOdometer: 50000, odometerUnit: "MI" }], expiredWarranty: [] } });
  assert.equal(w[0].status, "active");
  assert.deepEqual(types(t.warranty(w, iso(T0))), ["warranty_status/digest"]);
  assert.deepEqual(t.warranty(w, iso(T0 + 1)), [], "unchanged warranty: nothing");
});

test("REST body parsers read only known keys; release notes drop images; recent_alerts audiences normalised", () => {
  assert.deepEqual(parseServiceData({ response: { service_status: "in_service", service_etc: "2026-10-29T17:00:00Z", service_visit_number: "SV-000" } }), { status: "in_service", etc: "2026-10-29T17:00:00Z" });
  assert.deepEqual(parseReleaseNotes({ response: { release_notes: [{ title: "Example", subtitle: "Sub", image_url: "https://example.com/x.png" }] } }), [{ title: "Example", subtitle: "Sub" }]);
  assert.deepEqual(parseRecentAlerts({ response: { recent_alerts: [{ name: "A_a1", time: "2026-10-27T12:00:00Z", audience: ["service-fix", "customer"], user_text: "x" }] } }), [
    { name: "A_a1", audiences: ["ServiceFix", "Customer"], startedAt: "2026-10-27T12:00:00.000Z" },
  ]);
});

test("envelope: vehicle_id, vin_last6, model/trim label, UTC ts, source, event_type on every event; never the full VIN", () => {
  const t = tracker();
  const ev = [...feed(t, { CarType: "CarTypeModel3", Trim: "74D", Odometer: 999 }, { Odometer: 1000 }), ...t.recalls([{ campaign: "26V000000" }], iso(T0))];
  for (const e of ev) {
    assert.equal(e.vehicle_id, "car-a");
    assert.equal(e.vin_last6, CAR_A.slice(-6));
    assert.equal(e.model, "Model 3 74D");
    assert.match(e.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(e.source === "telemetry" || e.source === "rest");
    assert.equal(JSON.stringify(e).includes(CAR_A), false);
  }
  assert.equal(new OwnershipTracker({ vin: CAR_B, vehicle_id: "b", label: "Model Y Example" }, {}).model(), "Model Y Example");
  assert.equal(new OwnershipTracker({ vin: CAR_B, vehicle_id: "b" }, {}).model(), "Model Y", "decoded from the VIN");
});

test("dedupe: baseline/resend never fire; persisted state means a restart doesn't repeat events", () => {
  const state: CarState = {};
  const t = tracker({}, CAR_A, state);
  assert.deepEqual(t.telemetry({ Odometer: 999, ServiceMode: false, SentryMode: "SentryModeStateArmed" }, iso(T0), true), []);
  assert.deepEqual(t.telemetry({ Odometer: 5000, ServiceMode: true }, iso(T0 + 1), true), [], "baseline (resend / retained)");
  assert.equal(feed(t, { Odometer: 6000 }).length, 1);
  const again = tracker({}, CAR_A, JSON.parse(JSON.stringify(state)));
  assert.deepEqual(again.telemetry({ Odometer: 6000.5 }, iso(T0 + 5)), [], "restart with the saved state");
  assert.equal(again.alerts([{ name: "A_a1", audiences: [], startedAt: iso(T0) }], iso(T0), "telemetry", true).length, 0, "retained alert is a baseline");
  assert.equal(again.alerts([{ name: "A_a1", audiences: [], startedAt: iso(T0) }], iso(T0), "telemetry").length, 0, "and stays deduped");
});

test("digest scheduling: next weekday/hour in UTC, strictly after now", () => {
  const sunNoon = Date.parse("2026-11-01T12:00:00Z"); // a Sunday
  assert.equal(iso(nextDigestAt(sunNoon, 0, 13)), "2026-11-01T13:00:00.000Z");
  assert.equal(iso(nextDigestAt(Date.parse("2026-11-01T13:00:00Z"), 0, 13)), "2026-11-08T13:00:00.000Z");
  assert.equal(iso(nextDigestAt(Date.parse("2026-10-27T12:00:00Z"), 5, 8)), "2026-10-30T08:00:00.000Z");
});

// ---------- config ----------

function ownCfg(dir: string, patch: Partial<NonNullable<TeslaConfig["ownership"]>> = {}, fetchRest = false): TeslaConfig {
  return {
    ...example,
    telemetry: { ...example.telemetry!, enabled: true, mode: "decoded", decoded_listen: "127.0.0.1:0", vin_allowlist: [CAR_A, CAR_B] },
    energy_poll: { ...example.energy_poll!, enabled: false },
    ownership: {
      enabled: true,
      vehicles: [{ vin: CAR_A, vehicle_id: "car-a", label: "Model 3 Example" }, { vin: CAR_B, vehicle_id: "car-b" }],
      ...(fetchRest ? { rest: { enabled: true, api_base: "https://fleet-api.prd.na.vn.cloud.tesla.com", token_ref: `file:${join(dir, "tok")}` } } : {}),
      ...patch,
    },
    routes: [
      ...example.routes.filter((r) => r.match.kind !== "ownership"),
      { id: "example-ownership", enabled: true, match: { kind: "ownership" }, allowActors: [CAR_A, CAR_B], agent: "example-agent" },
    ],
  };
}

test("ownership config: example validates; VINs must be allowlisted; ids unique; patterns compile; route required", () => {
  assert.deepEqual(validateTeslaConfig(example), []);
  const dir = mkdtempSync(join(tmpdir(), "own-"));
  const ok = ownCfg(dir);
  assert.deepEqual(validateTeslaConfig(ok), []);
  const v = (c: TeslaConfig) => validateTeslaConfig(c).join("\n");
  assert.match(v({ ...ok, ownership: { ...ok.ownership!, vehicles: [{ vin: "5YJ3EXAMPLE000009" }] } }), /must also be in tesla.telemetry.vin_allowlist/);
  assert.match(v({ ...ok, ownership: { ...ok.ownership!, vehicles: [{ vin: CAR_A, vehicle_id: "x" }, { vin: CAR_B, vehicle_id: "x" }] } }), /used twice/);
  assert.match(v({ ...ok, ownership: { ...ok.ownership!, rules: { alerts: { safety_patterns: ["(unclosed"] } } } }), /not a valid regex/);
  assert.match(v({ ...ok, ownership: { ...ok.ownership!, rules: { tpms: { recommended_psi: -1 } } } }), /psi value/);
  assert.match(v({ ...ok, routes: example.routes.filter((r) => r.match.kind !== "ownership") }), /needs a route with match \{ kind: "ownership" \}/);
  assert.match(v({ ...ok, ownership: { ...ok.ownership!, rest: { enabled: true, api_base: "http://x.example.com", token_ref: "vault:x" } } }), /https URL[\s\S]*token_ref/);
  assert.match(v({ ...ok, ownership: { ...ok.ownership!, rest: { enabled: true, api_base: "https://x.example.com", refresh_token_ref: "env:X" } as never } }), /access token only/);
  assert.match(v({ ...ok, ownership: { ...ok.ownership!, digest: { weekday: 9 } } }), /weekday must be 0-6/);
});

// ---------- adapter end to end (decoded POST /records -> bridge -> routine) ----------

test("ownership e2e: two cars, immediate vs weekly digest per car, state file mode 600, restart doesn't repeat, no full VIN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "own-e2e-"));
  let clock = T0;
  const td = teardown();
  try {
    const m = td.add(await mockRoutine({ key: "routine-key" }), (x) => x.close());
    const mk = () => td.add(new TeslaAdapter(ownCfg(dir), { now: () => clock, pollOnStart: false }), (x) => x.stop());
    const up = async (ad: TeslaAdapter) => td.add(await startBridge({ routineUrl: m.url, adapters: [ad], holdFile: join(dir, "hold.json") }), (x) => x.close());
    let a = mk();
    let b = await up(a);
    const post = async (records: unknown[]) => {
      const res = await fetch(`http://127.0.0.1:${a.telemetryPort()}/records`, { method: "POST", body: records.map((r) => JSON.stringify(r)).join("\n") });
      assert.equal(res.status, 202);
      await new Promise((r) => setTimeout(r, 150));
    };
    let t = T0;
    const rec = (vin: string, data: Record<string, unknown>) => ({ vin, createdAt: iso((t += 1000)), data: Object.entries(data).map(([key, value]) => ({ key, value })) });
    const D = (n: number) => ({ doubleValue: n });
    const S = (s: string) => ({ stringValue: s });
    await post([rec(CAR_A, { Odometer: D(999), TpmsPressureFl: D(psi(42)) }), rec(CAR_B, { Odometer: D(20999), TpmsPressureFl: D(psi(42)) })]);
    assert.equal(m.hits.length, 0, "baselines");
    // Car A: low tire by > 5 psi (immediate). Car B: odometer milestone (digest).
    await post([rec(CAR_A, { TpmsPressureFl: D(psi(35)) }), rec(CAR_B, { Odometer: D(21000.4) })]);
    assert.equal(m.hits.length, 1);
    const p0 = m.hits[0].body.prompt as string;
    assert.match(p0, /ownership event for car-a \(Model 3 Example, VIN …000001\): tpms \(tier immediate, priority high\)/);
    const env = JSON.parse(p0.split("\n")[2]);
    assert.deepEqual(Object.keys(env).slice(0, 6), ["vehicle_id", "vin_last6", "model", "ts", "source", "event_type"]);
    // Alerts record for car B (Customer audience -> immediate).
    await post([{ vin: CAR_B, createdAt: iso((t += 1000)), alerts: [{ name: "UI_a001_Example", audiences: ["Customer"], startedAt: iso(t) }] }]);
    assert.equal(m.hits.length, 2);
    assert.match(m.hits[1].body.prompt, /car-b \(Model Y, VIN …000002\): vehicle_alert/);
    // Same alert re-sent: deduped.
    await post([{ vin: CAR_B, createdAt: iso((t += 1000)), alerts: [{ name: "UI_a001_Example", audiences: ["Customer"], startedAt: iso(t - 1000) }] }]);
    assert.equal(m.hits.length, 2);
    // Version change on car A -> digest.
    await post([rec(CAR_A, { Version: S("2026.32.1") })]);
    await post([rec(CAR_A, { Version: S("2026.38.2") })]);
    const rt = a.ownershipRuntime()!;
    assert.deepEqual(rt.pending(), { "car-a": 1, "car-b": 1 });
    const file = join(dir, "tesla-ownership-state.json");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8").includes(CAR_A), false, "state is keyed by vehicle_id, never the VIN");
    // Restart: state survives, nothing repeats.
    await b.close();
    a = mk();
    b = await up(a);
    await post([rec(CAR_A, { TpmsPressureFl: D(psi(35.1)), Version: S("2026.38.2") }), rec(CAR_B, { Odometer: D(21000.9) })]);
    assert.equal(m.hits.length, 2, "no repeats after restart");
    assert.deepEqual(a.ownershipRuntime()!.pending(), { "car-a": 1, "car-b": 1 });
    // Weekly digest: one message per car.
    clock = nextDigestAt(T0, 0, 13) + 1;
    await a.ownershipRuntime()!.tick();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(m.hits.length, 4);
    const digests = m.hits.slice(2).map((h) => h.body.prompt as string);
    assert.ok(digests.some((d) => /digest for car-a .*1 change/.test(d) && /"event_type":"software_update"/.test(d)));
    assert.ok(digests.some((d) => /digest for car-b .*1 change/.test(d) && /"event_type":"odometer_milestone"/.test(d)));
    assert.deepEqual(a.ownershipRuntime()!.pending(), { "car-a": 0, "car-b": 0 });
    const all = JSON.stringify(m.hits) + JSON.stringify(b.audit.lines);
    assert.equal(all.includes(CAR_A) || all.includes(CAR_B), false, "no full VIN in prompts or audit");
  } finally {
    await td.run();
  }
});

test("ownership REST pull: service_data / warranty / NHTSA recalls / release notes after an update; token only to the Fleet API; no VIN to NHTSA", async () => {
  const dir = mkdtempSync(join(tmpdir(), "own-rest-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "tok"), "dummy-access\n");
  let clock = T0;
  const calls: { url: string; auth: boolean }[] = [];
  let service = "not_in_service";
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, auth: Boolean(init.headers.authorization) });
    let body: unknown = {};
    if (url.includes("/service_data")) body = { response: { service_status: service } };
    else if (url.includes("/dx/warranty/details")) body = { response: { activeWarranty: [{ warrantyType: "BASIC", warrantyDisplayName: "Basic" }] } };
    else if (url.includes("recallsByVehicle")) body = { results: [{ NHTSACampaignNumber: "26V000000" }] };
    else if (url.includes("/release_notes")) body = { response: { release_notes: [{ title: "Example feature", image_url: "https://example.com/i.png" }] } };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const td = teardown();
  try {
    const m = td.add(await mockRoutine({ key: "routine-key" }), (x) => x.close());
    const a = td.add(new TeslaAdapter(ownCfg(dir, {}, true), { now: () => clock, pollOnStart: false, fetchImpl }), (x) => x.stop());
    td.add(await startBridge({ routineUrl: m.url, adapters: [a], holdFile: join(dir, "hold.json") }), (x) => x.close());
    const rt = a.ownershipRuntime()!;
    const first = await rt.pullDue();
    assert.deepEqual(first.map((e) => `${e.vehicle_id}/${e.event_type}`).sort(), ["car-a/recall", "car-a/warranty_status", "car-b/recall", "car-b/warranty_status"]);
    const nhtsa = calls.filter((c) => c.url.includes("nhtsa"));
    assert.equal(nhtsa.length, 2);
    assert.ok(nhtsa.every((c) => !c.auth && !c.url.includes(CAR_A) && !c.url.includes(CAR_B)), "no token, no VIN to NHTSA");
    assert.ok(nhtsa.some((c) => c.url.includes("model=MODEL+3&modelYear=2020")));
    assert.ok(calls.filter((c) => c.url.startsWith("https://fleet-api.prd.na.vn.cloud.tesla.com")).every((c) => c.auth));
    assert.equal(calls.some((c) => /vehicle_data|wake_up|\/command\//.test(c.url)), false);
    // Nothing is due again within the interval.
    const n = calls.length;
    assert.deepEqual(await rt.pullDue(), []);
    assert.equal(calls.length, n);
    // A day later: the car is at a Service Center.
    service = "in_service";
    clock += 25 * 3600_000;
    const svc = await rt.pullDue();
    assert.deepEqual(svc.map((e) => `${e.vehicle_id}/${e.data.state}`).sort(), ["car-a/at_service_center", "car-b/at_service_center"]);
    // A version change queues one release-notes read for that car.
    await rt.record({ vin: CAR_A, createdAt: iso(clock), data: { Version: "2026.32.1" } }, false);
    await rt.record({ vin: CAR_A, createdAt: iso(clock + 1000), data: { Version: "2026.38.2" } }, false);
    const notes = await rt.pullDue();
    assert.deepEqual(notes.map((e) => `${e.vehicle_id}/${e.data.phase}`), ["car-a/release_notes"]);
    assert.deepEqual(notes[0].data.notes, [{ title: "Example feature", subtitle: undefined }]);
    assert.equal(calls.filter((c) => c.url.includes("release_notes")).length, 1);
  } finally {
    await td.run();
  }
});

test("rest.token_ref: env:NAME or file:<absolute path> (POSIX, Windows drive, UNC) on any OS; relative and drive-relative refused", () => {
  for (const ok of ["env:TESLA_ACCESS_TOKEN", "file:/run/secrets/tesla-access", "file:C:\\secrets\\tesla-access", "file:D:/secrets/tesla-access", "file:\\\\fileserver\\share\\tesla-access", `file:${join(tmpdir(), "tok")}`]) {
    assert.equal(isTokenRef(ok), true, ok);
  }
  for (const bad of ["vault:x", "env:", "env:1BAD", "file:", "file:tok", "file:./tok", "file:C:tok", "/run/secrets/tesla-access", 42]) {
    assert.equal(isTokenRef(bad), false, String(bad));
  }
  const ok = { ...ownCfg(tmpdir(), {}, true) };
  const v = (c: TeslaConfig) => validateTeslaConfig(c).join("\n");
  for (const ref of ["file:C:\\secrets\\tok", "file:\\\\fileserver\\share\\tok", "file:/run/secrets/tok", `file:${join(tmpdir(), "tok")}`]) {
    assert.doesNotMatch(v({ ...ok, ownership: { ...ok.ownership!, rest: { ...ok.ownership!.rest!, token_ref: ref } } }), /token_ref/, ref);
  }
  assert.match(v({ ...ok, ownership: { ...ok.ownership!, rest: { ...ok.ownership!.rest!, token_ref: "file:tok" } } }), /rest\.token_ref must be env:NAME or file:\/path/);
});

// ---------- review fixes: pull backoff, host allowlist, redirects, body cap, state shape, parsers ----------

test("REST pulls: ANY error backs that kind off ~1 h (persisted); a warranty 404 is not retried next tick; recalls and release notes still run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "own-backoff-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "tok"), "dummy-access\n");
  let clock = T0;
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    if (url.includes("/dx/warranty/details")) return { status: 404, headers: { get: () => null }, text: async () => '{"error":"not_found"}' };
    let body: unknown = {};
    if (url.includes("/service_data")) body = { response: { service_status: "not_in_service" } };
    else if (url.includes("recallsByVehicle")) body = { results: [{ NHTSACampaignNumber: "26V000000" }] };
    else if (url.includes("/release_notes")) body = { response: { release_notes: [{ title: "Example feature" }] } };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const td = teardown();
  try {
    const m = td.add(await mockRoutine({ key: "routine-key" }), (x) => x.close());
    const cfg = ownCfg(dir, { vehicles: [{ vin: CAR_A, vehicle_id: "car-a" }] }, true);
    const a = td.add(new TeslaAdapter(cfg, { now: () => clock, pollOnStart: false, fetchImpl }), (x) => x.stop());
    const b = td.add(await startBridge({ routineUrl: m.url, adapters: [a], holdFile: join(dir, "hold.json") }), (x) => x.close());
    const rt = a.ownershipRuntime()!;
    const n = (s: string) => calls.filter((u) => u.includes(s)).length;
    const first = await rt.pullDue();
    assert.equal(n("/dx/warranty/details"), 1);
    assert.deepEqual(first.map((e) => e.event_type), ["recall"], "the warranty 404 did not stop the recall pull");
    assert.ok(b.audit.lines.some((l) => l.reason === "fleet_api_error" && l.type === "ownership_rest_warranty" && l.status === 404));
    // A version change queues release notes; next tick (1 min later): no warranty retry, notes still fetched.
    await rt.record({ vin: CAR_A, createdAt: iso(clock), data: { Version: "2026.32.1" } }, false);
    await rt.record({ vin: CAR_A, createdAt: iso(clock + 1000), data: { Version: "2026.38.2" } }, false);
    clock += 60_000;
    await rt.tick();
    assert.equal(n("/dx/warranty/details"), 1, "a 404 is not retried on the next tick");
    assert.equal(n("/release_notes"), 1, "release notes still run");
    // Many ticks within the hour: still one warranty call (not ~1 per minute).
    for (let i = 0; i < 50; i++) {
      clock += 60_000;
      await rt.tick();
    }
    assert.equal(n("/dx/warranty/details"), 1);
    // The failed attempt time is persisted and survives a restart.
    await a.stop();
    const st = JSON.parse(readFileSync(join(dir, "tesla-ownership-state.json"), "utf8"));
    assert.equal(st.cars["car-a"].pullFails.warranty, T0);
    const a2 = td.add(new TeslaAdapter(cfg, { now: () => clock, pollOnStart: false, fetchImpl }), (x) => x.stop());
    td.add(await startBridge({ routineUrl: m.url, adapters: [a2], holdFile: join(dir, "hold.json") }), (x) => x.close());
    await a2.ownershipRuntime()!.pullDue();
    assert.equal(n("/dx/warranty/details"), 1, "still backing off after a restart");
    // After the hour: retried once.
    clock = T0 + PULL_RETRY_MS + 1;
    await a2.ownershipRuntime()!.pullDue();
    assert.equal(n("/dx/warranty/details"), 2);
  } finally {
    await td.run();
  }
});

/** A base URL carrying credentials (built with the URL API so no credential-looking literal sits in the repo). */
const withUser = (raw: string) => {
  const u = new URL(raw);
  u.username = "someone";
  return u.href;
};

test("REST hosts: api_base only the Fleet API regional hosts, nhtsa_base only api.nhtsa.gov (config and clients, energy too)", () => {
  for (const h of FLEET_API_HOSTS) {
    assert.equal(baseUrlProblem(`https://${h}`, FLEET_API_HOSTS, "x"), undefined, h);
    assert.equal(baseUrlProblem(`https://${h}/`, FLEET_API_HOSTS, "x"), undefined, h);
  }
  for (const bad of ["https://fleet-api.example.com", "https://fleet-api.prd.na.vn.cloud.tesla.com.example.com", "http://fleet-api.prd.na.vn.cloud.tesla.com",
    withUser("https://fleet-api.prd.na.vn.cloud.tesla.com"), "https://fleet-api.prd.na.vn.cloud.tesla.com:8443", "https://fleet-api.prd.na.vn.cloud.tesla.com/api", "not a url"]) {
    assert.ok(baseUrlProblem(bad, FLEET_API_HOSTS, "x"), bad);
  }
  assert.equal(baseUrlProblem("https://api.nhtsa.gov", NHTSA_HOSTS, "x"), undefined);
  assert.ok(baseUrlProblem("https://nhtsa.example.com", NHTSA_HOSTS, "x"));
  const tok = () => "t";
  assert.throws(() => new OwnershipRestClient({ apiBase: "https://fleet-api.example.com", getToken: tok }), /api_base must be one of/);
  assert.throws(() => new OwnershipRestClient({ apiBase: "https://fleet-api.prd.eu.vn.cloud.tesla.com", nhtsaBase: "https://nhtsa.example.com", getToken: tok }), /nhtsa_base must be one of/);
  assert.throws(() => new FleetEnergyClient({ apiBase: "https://fleet-api.example.com", getToken: tok }), /api_base must be one of/);
  // The test-only override is the only way to another host.
  assert.doesNotThrow(() => new OwnershipRestClient({ apiBase: "http://127.0.0.1:1", nhtsaBase: "http://127.0.0.1:1", getToken: tok, testHosts: { hosts: ["127.0.0.1"], allowHttp: true } }));
  const ok = ownCfg(tmpdir(), {}, true);
  const v = (c: TeslaConfig) => validateTeslaConfig(c).join("\n");
  assert.match(v({ ...ok, ownership: { ...ok.ownership!, rest: { ...ok.ownership!.rest!, api_base: "https://fleet-api.example.com" } } }), /rest\.api_base must be one of/);
  assert.match(v({ ...ok, ownership: { ...ok.ownership!, rest: { ...ok.ownership!.rest!, nhtsa_base: "https://nhtsa.example.com" } } }), /rest\.nhtsa_base must be one of/);
  assert.match(v({ ...example, energy_poll: { ...example.energy_poll!, api_base: "https://fleet-api.example.com" } }), /energy_poll\.api_base must be one of/);
});

test("REST guard: redirects are refused (never followed) and bodies over the cap are aborted mid-stream (ownership + energy clients)", async () => {
  const { createServer } = await import("node:http");
  let followed = 0;
  const BIG = 64 * 1024 * 1024;
  const big: Array<{ written: number; finished: boolean; closed: boolean }> = [];
  const server = createServer((req, res) => {
    const u = req.url ?? "";
    if (u.includes("/followed")) {
      followed++;
      res.end("{}");
    } else if (u.includes("/service_data") || u.includes("live_status")) {
      res.writeHead(302, { location: "/followed" }).end();
    } else if (u.includes("recent_alerts")) {
      res.writeHead(200, { "content-length": String(5 * 1024 * 1024) }).write("{");
    } else {
      // 64 MiB in 64 KiB chunks, no content-length: the client must stop reading past 1 MiB.
      const st = { written: 0, finished: false, closed: false };
      big.push(st);
      res.writeHead(200, { "content-type": "application/json" });
      res.on("close", () => (st.closed = true));
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      const pump = () => {
        while (st.written < BIG && !st.closed) {
          st.written += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        if (!st.closed) {
          st.finished = true;
          res.end();
        }
      };
      pump();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const testHosts = { hosts: ["127.0.0.1"], allowHttp: true };
  try {
    const own = new OwnershipRestClient({ apiBase: base, nhtsaBase: base, getToken: () => "t", testHosts });
    await assert.rejects(own.serviceData(CAR_A), (e: EnergyApiError) => e.code === "redirect_refused");
    const energy = new FleetEnergyClient({ apiBase: base, getToken: () => "t", testHosts });
    await assert.rejects(energy.liveStatus("1111"), (e: EnergyApiError) => e.code === "redirect_refused");
    assert.equal(followed, 0, "a redirect target is never requested");
    await assert.rejects(own.warranty(CAR_A), (e: EnergyApiError) => e.code === "response_too_large");
    await assert.rejects(energy.backupReserve("1111"), (e: EnergyApiError) => e.code === "response_too_large");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(big.length, 2);
    assert.ok(big.every((b) => b.closed && !b.finished && b.written < BIG), "each oversize response was aborted before the server finished");
    // A declared Content-Length over the cap is refused before reading the body.
    await assert.rejects(own.recentAlerts(CAR_A), (e: EnergyApiError) => e.code === "response_too_large");
    // Mocked fetch: a 3xx answer is refused too, and a text() body over the cap is rejected.
    const r3 = new OwnershipRestClient({ apiBase: "https://fleet-api.prd.na.vn.cloud.tesla.com", getToken: () => "t", fetchImpl: async () => ({ status: 301, headers: { get: () => null }, text: async () => "" }) });
    await assert.rejects(r3.warranty(CAR_A), (e: EnergyApiError) => e.code === "redirect_refused");
    const huge = new OwnershipRestClient({ apiBase: "https://fleet-api.prd.na.vn.cloud.tesla.com", getToken: () => "t", fetchImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => "x".repeat(MAX_BODY_BYTES + 1) }) });
    await assert.rejects(huge.warranty(CAR_A), (e: EnergyApiError) => e.code === "response_too_large");
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test("state file: malformed car and digest entries are dropped with one warning; ticks and flushDigest keep working", async () => {
  const dir = mkdtempSync(join(tmpdir(), "own-badstate-"));
  const { writeFileSync } = await import("node:fs");
  const good = { vehicle_id: "car-b", vin_last6: "000002", model: "Model Y", ts: iso(T0), source: "telemetry", event_type: "odometer_milestone", tier: "digest", priority: "normal", dedupe_key: "odometer_milestone:21000", data: { milestone_mi: 21000 } };
  writeFileSync(join(dir, "tesla-ownership-state.json"), JSON.stringify({
    version: 1,
    cars: { "car-a": "str", "car-b": { odometer: "not a number", odoMilestone: 21000, pulls: { service: "x" }, emitted: { "odometer_milestone:21000": T0 } }, "bad id!": {} },
    digest: { next_at: T0 + 3600_000, items: { "car-a": "nope", "car-b": [good, null, 5, { vehicle_id: "car-b" }] } },
  }));
  let clock = T0;
  const td = teardown();
  try {
    const m = td.add(await mockRoutine({ key: "routine-key" }), (x) => x.close());
    const a = td.add(new TeslaAdapter(ownCfg(dir), { now: () => clock, pollOnStart: false }), (x) => x.stop());
    const b = td.add(await startBridge({ routineUrl: m.url, adapters: [a], holdFile: join(dir, "hold.json") }), (x) => x.close());
    const rt = a.ownershipRuntime()!;
    const warn = b.audit.lines.filter((l) => l.reason === "ownership_state_malformed_dropped");
    assert.equal(warn.length, 1, "one warning");
    assert.ok((warn[0].count as number) >= 6);
    assert.deepEqual(rt.pending(), { "car-b": 1 });
    // Car A (dropped) works from a fresh state; car B kept its valid fields (milestone dedupe).
    await rt.record({ vin: CAR_A, createdAt: iso(clock), data: { Odometer: 999 } }, false);
    await rt.record({ vin: CAR_A, createdAt: iso(clock + 1000), data: { Odometer: 1000.5 } }, false);
    await rt.record({ vin: CAR_B, createdAt: iso(clock + 2000), data: { Odometer: 21000.5 } }, false);
    assert.deepEqual(rt.pending(), { "car-b": 1, "car-a": 1 });
    clock = T0 + 3600_000 + 1;
    await rt.tick();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(m.hits.length, 2, "one digest per car");
    assert.deepEqual(rt.pending(), { "car-b": 0, "car-a": 0 });
    assert.equal(await rt.flushDigest(), 0);
  } finally {
    await td.run();
  }
});

test("flushDigest is under an overlap guard: two at once send each car's digest once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "own-overlap-"));
  let clock = T0;
  const td = teardown();
  try {
    const m = td.add(await mockRoutine({ key: "routine-key" }), (x) => x.close());
    const a = td.add(new TeslaAdapter(ownCfg(dir), { now: () => clock, pollOnStart: false }), (x) => x.stop());
    td.add(await startBridge({ routineUrl: m.url, adapters: [a], holdFile: join(dir, "hold.json") }), (x) => x.close());
    const rt = a.ownershipRuntime()!;
    await rt.record({ vin: CAR_A, createdAt: iso(clock), data: { Odometer: 999 } }, false);
    await rt.record({ vin: CAR_A, createdAt: iso(clock + 1000), data: { Odometer: 1000.5 } }, false);
    const [x, y] = await Promise.all([rt.flushDigest(), rt.flushDigest()]);
    assert.deepEqual([x, y].sort(), [0, 1]);
    clock = nextDigestAt(T0, 0, 13) + 1;
    await Promise.all([rt.tick(), rt.tick()]);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(m.hits.length, 1);
  } finally {
    await td.run();
  }
});

test("parseNhtsaRecalls skips null and non-object entries", () => {
  assert.deepEqual(parseNhtsaRecalls({ results: [null, 5, "x", [], { NHTSACampaignNumber: "26V000000" }, undefined] }).map((r) => r.campaign), ["26V000000"]);
  assert.deepEqual(parseNhtsaRecalls(null), []);
  assert.deepEqual(parseNhtsaRecalls({ results: null }), []);
});

test("rest.token_ref refuses any whitespace or control character", () => {
  for (const bad of ["file:\t/run/tok", "file:/run/tok\n", "file:/run/\ntok", " env:TOKEN", "env:TOKEN ", "env:TOK\u0000EN", "file:/run/t ok", "file:C:\\Program Files\\tok", "file:/run/tok\u2028", "file:/run/tok\u0085", "env:TOKEN\r"]) {
    assert.equal(isTokenRef(bad), false, JSON.stringify(bad));
  }
  const ok = ownCfg(tmpdir(), {}, true);
  assert.match(validateTeslaConfig({ ...ok, ownership: { ...ok.ownership!, rest: { ...ok.ownership!.rest!, token_ref: "file:\t/run/tok" } } }).join("\n"), /rest\.token_ref must be env:NAME or file:\/path/);
});
