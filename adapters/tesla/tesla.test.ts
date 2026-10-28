import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  Debouncer,
  deriveVehicleTriggers,
  enumName,
  mergeState,
  num,
  parsePayload,
  TeslaAdapter,
  validateTeslaConfig,
  type TelemetryValue,
  type TeslaConfig,
} from "./index.js";
import { mockRoutine, startBridge } from "../../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as TeslaConfig;
export const VIN = "5YJ0000000EXAMPLE";

/** prev state + record -> triggers, the way the adapter does it. */
function step(prev: Record<string, TelemetryValue> | undefined, data: Record<string, TelemetryValue>, low?: number) {
  const { delta } = mergeState(prev, data);
  return deriveVehicleTriggers(prev, delta, { lowBatteryPercent: low }).map((h) => (h.priority ? `${h.on}!${h.priority}` : h.on));
}

test("example config validates; dummy VIN is 17 chars", () => {
  assert.deepEqual(validateTeslaConfig(example), []);
  assert.equal(VIN.length, 17);
  assert.equal(example.telemetry!.prefer_typed, true);
});

test("refuses commands, vehicle_data, wakes, non-origin replies, literal/vault secrets, refresh tokens", () => {
  const v = (c: unknown) => validateTeslaConfig(c).join("\n");
  assert.match(v({ ...example, commands: ["honk"] }), /never sends vehicle commands/);
  assert.match(v({ ...example, energy_poll: { ...example.energy_poll!, endpoint: "/api/1/vehicles/1/vehicle_data" } }), /never poll vehicle_data/);
  assert.match(v({ ...example, energy_poll: { ...example.energy_poll!, endpoint: "/api/1/vehicles/1/wake_up" } }), /never wakes cars/);
  assert.match(v({ ...example, reply: { via: "webhook" } }), /origin_channel/);
  assert.match(v({ ...example, energy_poll: { ...example.energy_poll!, token_ref: "vault:x" } }), /token_ref must be env:NAME or file:/);
  assert.match(v({ ...example, energy_poll: { ...example.energy_poll!, refresh_token_ref: "env:X" } }), /access token only/);
  assert.match(v({ ...example, energy_poll: { ...example.energy_poll!, refreshToken: "file:/x" } }), /access token only/);
  assert.equal(v({ ...example, energy_poll: { ...example.energy_poll!, refresh_note: "x" } }), "", "only refresh-token keys are refused");
  assert.match(v({ ...example, energy_poll: { ...example.energy_poll!, enabled: true, api_base: undefined } }), /api_base is required/);
  assert.match(v({ ...example, energy_poll: { ...example.energy_poll!, api_base: "http://fleet-api.example.com" } }), /https URL/);
  assert.match(v({ ...example, energy_poll: { ...example.energy_poll!, interval_s: 30 } }), />= 60/);
});

test("telemetry config: prefer_typed, replaced field names, VIN shape, receiver modes", () => {
  const t = example.telemetry!;
  const v = (patch: object) => validateTeslaConfig({ ...example, telemetry: { ...t, ...patch } }).join("\n");
  assert.match(v({ prefer_typed: false }), /prefer_typed must be true/);
  for (const [f, hint] of [
    ["ChargeState", /DetailedChargeState/],
    ["ChargeCableConnected", /Disconnected/],
    ["TrunkOpen", /TrunkFront/],
    ["SentryAlert", /SentryMode/],
    ["SoftwareUpdateAvailable", /SoftwareUpdateVersion/],
  ] as const) {
    assert.match(v({ fields: { [f]: 10 } }), hint, f);
  }
  assert.match(v({ fields: { VehicleSpeed: 10 } }), /not read by the trigger logic or ownership events/);
  assert.equal(v({ fields: { ...t.fields!, Odometer: 600 } }), "", "ownership fields are accepted");
  assert.equal(v({ fields: { ...t.fields!, Soc: 300 } }), "", "Soc is accepted as stream-only (low_battery still reads BatteryLevel)");
  assert.match(v({ fields: { ...t.fields!, Gear: 0 } }), /whole seconds >= 1/);
  assert.match(v({ resend_interval_s: 5 }), /resend_interval_s must be an integer >= 60/);
  const noGear = { ...t.fields! };
  delete noGear.Gear;
  assert.match(v({ fields: noGear }), /must include Gear when door_open_parked\/trunk_open_parked wakes/);
  assert.equal(validateTeslaConfig({ ...example, rules: example.rules.filter((r) => !/door|trunk/.test(r.on)), telemetry: { ...t, fields: noGear } }).length, 0, "Gear optional without door/trunk wake rules");
  assert.match(v({ vin_allowlist: ["5YJ0000000EXAMPLE1"] }), /17-character/);
  assert.match(v({ enabled: true, mode: "mtls", client_ca: undefined }), /client_ca is required in mtls mode/);
  assert.match(v({ decoded_listen: "0.0.0.0:18091" }), /loopback/);
  assert.match(v({ enabled: true, mode: "decoded", decoded_listen: undefined }), /decoded_listen is required/);
  assert.match(v({ mode: "raw" }), /mode must be/);
});

test("enum prefixes are stripped (typed and untyped both accepted); numbers parse from strings", () => {
  assert.equal(enumName("Gear", "ShiftStateP"), "P");
  assert.equal(enumName("Gear", "P"), "P");
  assert.equal(enumName("DetailedChargeState", "DetailedChargeStateComplete"), "Complete");
  assert.equal(enumName("SentryMode", "SentryModeStateAware"), "Aware");
  assert.equal(enumName("ChargingCableType", "CableTypeSAE"), "SAE");
  assert.equal(num("42"), 42);
  assert.equal(num(17.5), 17.5);
  assert.equal(num(""), undefined);
  assert.equal(num("abc"), undefined);
});

test("DetailedChargeState: complete, stopped, plugged in (leaves Disconnected), unplugged (returns)", () => {
  assert.deepEqual(step({ DetailedChargeState: "DetailedChargeStateCharging" }, { DetailedChargeState: "DetailedChargeStateComplete" }), ["charge_complete"]);
  assert.deepEqual(step({ DetailedChargeState: "Charging" }, { DetailedChargeState: "Stopped" }), ["charge_stopped"]);
  assert.deepEqual(step({ DetailedChargeState: "DetailedChargeStateDisconnected" }, { DetailedChargeState: "DetailedChargeStateStarting" }), ["plugged_in"]);
  assert.deepEqual(step({ DetailedChargeState: "Complete" }, { DetailedChargeState: "Disconnected" }), ["unplugged"]);
  assert.deepEqual(step({ DetailedChargeState: "Unknown" }, { DetailedChargeState: "Disconnected" }), []);
  assert.deepEqual(step({ DetailedChargeState: "Charging" }, { DetailedChargeState: "Charging" }), []);
});

test("ChargingCableType is the backup plug signal (invalid = no cable), only without DetailedChargeState", () => {
  const plugged = mergeState(undefined, { ChargingCableType: { invalid: true } }).next;
  assert.equal(plugged.ChargingCableType, "Invalid");
  assert.deepEqual(step(plugged, { ChargingCableType: "CableTypeSAE" }), ["plugged_in"]);
  assert.deepEqual(step({ ChargingCableType: "CableTypeSAE" }, { ChargingCableType: { invalid: true } }), ["unplugged"]);
  assert.deepEqual(step({ ChargingCableType: "CableTypeSAE" }, { ChargingCableType: "CableTypeSNA" }), ["unplugged"], "SNA = no cable");
  assert.deepEqual(step({ ChargingCableType: "CableTypeSNA" }, { ChargingCableType: "CableTypeIEC" }), ["plugged_in"]);
  assert.deepEqual(step({ ChargingCableType: "Invalid" }, { ChargingCableType: "CableTypeSNA" }), []);
  // DetailedChargeState seen for this car: it alone decides.
  assert.deepEqual(step({ DetailedChargeState: "Charging", ChargingCableType: "Invalid" }, { ChargingCableType: "CableTypeSAE" }), []);
});

test("DoorState is a struct of six booleans: any door / trunk true while parked", () => {
  const closed = { DriverFront: false, DriverRear: false, PassengerFront: false, PassengerRear: false, TrunkFront: false, TrunkRear: false };
  assert.deepEqual(step({ Gear: "ShiftStateP", DoorState: closed }, { DoorState: { ...closed, PassengerRear: true } }), ["door_open_parked"]);
  assert.deepEqual(step({ Gear: "P", DoorState: closed }, { DoorState: { ...closed, TrunkRear: true } }), ["trunk_open_parked"]);
  assert.deepEqual(step({ DoorState: closed }, { DoorState: { ...closed, TrunkFront: true } }), ["trunk_open_parked"], "no gear reported = parked");
  assert.deepEqual(step({ Gear: "ShiftStateD", DoorState: closed }, { DoorState: { ...closed, DriverFront: true } }), []);
  assert.deepEqual(step({ Gear: "P", DoorState: { ...closed, DriverFront: true } }, { DoorState: { ...closed, DriverFront: true, DriverRear: true } }), [], "already open");
  assert.deepEqual(step({ Gear: "P", DoorState: closed }, { DoorState: "DriverFrontOpen" as never }), [], "a string never matches");
});

test("SentryMode: Aware fires, Panic fires with high priority, others do not", () => {
  assert.deepEqual(step({ SentryMode: "SentryModeStateArmed" }, { SentryMode: "SentryModeStateAware" }), ["sentry_alert"]);
  assert.deepEqual(step({ SentryMode: "Aware" }, { SentryMode: "Panic" }), ["sentry_alert!high"]);
  assert.deepEqual(step({ SentryMode: "Off" }, { SentryMode: "Armed" }), []);
  assert.deepEqual(step({ SentryMode: "Armed" }, { SentryMode: "Quiet" }), []);
});

test("BatteryLevel (app %) crosses the low mark; numeric strings parse", () => {
  assert.deepEqual(step({ BatteryLevel: "25" }, { BatteryLevel: "15.5" }), ["low_battery"]);
  assert.deepEqual(step({ BatteryLevel: 25 }, { BatteryLevel: 15 }), ["low_battery"]);
  assert.deepEqual(step({ BatteryLevel: 15 }, { BatteryLevel: 14 }), []);
  assert.deepEqual(step({ BatteryLevel: 35 }, { BatteryLevel: 28 }, 30), ["low_battery"]);
  assert.deepEqual(step({ Soc: 25 } as never, { Soc: 15 } as never), [], "Soc is ignored");
});

test("SoftwareUpdateVersion going from empty to a version", () => {
  assert.deepEqual(step({ SoftwareUpdateVersion: "" }, { SoftwareUpdateVersion: "2026.1.1" }), ["update_available"]);
  assert.deepEqual(step({ SoftwareUpdateVersion: "2026.1.1" }, { SoftwareUpdateVersion: "" }), []);
  assert.deepEqual(step({ SoftwareUpdateVersion: "2026.1.1" }, { SoftwareUpdateVersion: "2026.1.2" }), []);
});

test("edge rules: first value is a baseline; invalid values are not changes", () => {
  assert.deepEqual(step(undefined, { DetailedChargeState: "Complete", SentryMode: "Panic", BatteryLevel: 5, SoftwareUpdateVersion: "1" }), []);
  assert.deepEqual(step({ Gear: "P" }, { DoorState: { DriverFront: true } }), [], "DoorState not in prev yet");
  const s1 = mergeState({ BatteryLevel: 50 }, { BatteryLevel: { invalid: true } });
  assert.equal(s1.next.BatteryLevel, 50, "invalid is not stored");
  assert.deepEqual(s1.delta, {});
  assert.deepEqual(step(s1.next, { BatteryLevel: 10 }), ["low_battery"]);
});

test("parsePayload reads fleet-telemetry decoded JSON (prefer_typed)", () => {
  const r = parsePayload({
    data: [
      { key: "DetailedChargeState", value: { detailedChargeStateValue: "DetailedChargeStateCharging" } },
      { key: "DoorState", value: { doorValue: { DriverFront: true, DriverRear: false, PassengerFront: false, PassengerRear: false, TrunkFront: false, TrunkRear: false } } },
      { key: "BatteryLevel", value: { doubleValue: 81.5 } },
      { key: "Gear", value: { shiftStateValue: "ShiftStateP" } },
      { key: "SentryMode", value: { sentryModeStateValue: "SentryModeStateArmed" } },
      { key: "ChargingCableType", value: { invalid: true } },
      { key: "SoftwareUpdateVersion", value: { stringValue: "" } },
      { key: "Odometer", value: { longValue: "1234" } },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    vin: VIN,
    isResend: false,
  })!;
  assert.equal(r.vin, VIN);
  assert.equal(r.isResend, false);
  assert.equal(r.data.DetailedChargeState, "DetailedChargeStateCharging");
  assert.deepEqual(r.data.DoorState, { DriverFront: true, DriverRear: false, PassengerFront: false, PassengerRear: false, TrunkFront: false, TrunkRear: false });
  assert.equal(r.data.BatteryLevel, 81.5);
  assert.deepEqual(r.data.ChargingCableType, { invalid: true });
  assert.equal(r.data.Odometer, "1234");
  assert.equal(parsePayload("nope"), undefined);
  assert.equal(parsePayload({ vin: VIN }), undefined);
});

test("debounce", () => {
  const d = new Debouncer();
  assert.deepEqual([d.allow("k", 60, 0), d.allow("k", 60, 30_000), d.allow("k", 60, 61_000)], [true, false, true]);
});

test("adapter: baseline, masked VIN, Panic high, resend/stale ignored, other VINs dropped, no callback route", async () => {
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(example);
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  try {
    const rec = (createdAt: string, data: Record<string, TelemetryValue>, extra: object = {}) => a.ingestTelemetry({ vin: VIN, createdAt, data, ...extra });
    assert.deepEqual(await rec("2026-01-01T00:00:00Z", { DetailedChargeState: "DetailedChargeStateComplete", SentryMode: "SentryModeStateArmed" }), [], "baseline");
    assert.deepEqual(await rec("2026-01-01T00:30:00Z", { DetailedChargeState: "DetailedChargeStateCharging" }), []);
    assert.deepEqual(await rec("2026-01-01T01:00:00Z", { DetailedChargeState: "DetailedChargeStateComplete" }), ["charge_complete"]);
    assert.equal(m.hits.length, 1);
    const prompt: string = m.hits[0].body.prompt;
    assert.match(prompt, /Tesla vehicle …MPLE: charge_complete \(priority normal\)/);
    assert.equal(prompt.includes(VIN), false, "the prompt never has the full VIN");
    // The event id hashes only the masked id: it can't be brute-forced back to the VIN.
    const at = "2026-01-01T01:00:00Z";
    const id = /t:charge_complete:([0-9a-f]{16})/.exec(prompt)![1];
    assert.equal(id, createHash("sha256").update(`vehicle|…MPLE|charge_complete|normal|${at}`).digest("hex").slice(0, 16));
    assert.notEqual(id, createHash("sha256").update(`${VIN}|charge_complete|normal|${at}`).digest("hex").slice(0, 16));

    assert.deepEqual(await rec("2026-01-01T01:10:00Z", { SentryMode: "SentryModeStatePanic" }), ["sentry_alert"]);
    assert.match(m.hits[1].body.prompt, /sentry_alert \(priority high\)/);

    assert.deepEqual(await rec("2026-01-01T02:00:00Z", { DetailedChargeState: "DetailedChargeStateStopped" }, { isResend: true }), []);
    assert.deepEqual(await rec("2026-01-01T00:59:00Z", { DetailedChargeState: "DetailedChargeStateStopped" }), [], "older createdAt");
    assert.ok(b.audit.lines.some((l) => l.reason === "resend"));
    assert.ok(b.audit.lines.some((l) => l.reason === "stale_record"));

    assert.deepEqual(await a.ingestTelemetry({ vin: "OTHERVIN000000009", createdAt: "x", data: { DetailedChargeState: "Complete" } }), []);
    assert.ok(b.audit.lines.filter((l) => l.reason === "resend" || l.reason === "stale_record").every((l) => l.actor === VIN), "audit lines carry the full VIN");
    assert.equal(m.hits.some((h) => JSON.stringify(h.body).includes(VIN)), false, "prompts still carry the masked id only");
    assert.ok(b.audit.lines.some((l) => l.reason === "vin_not_allowlisted" && l.actor === "OTHERVIN000000009"), "a denied VIN is audited in full too");
    const cb = await b.call("POST", "/tesla/callback", {});
    assert.equal(cb.status, 404, "no tesla callback route: replies use the origin channel");
  } finally {
    await b.close();
    await m.close();
  }
});

test("charge_stopped only after Charging/Starting; Disconnected -> Stopped is just plugged_in", () => {
  assert.deepEqual(step({ DetailedChargeState: "Disconnected" }, { DetailedChargeState: "Stopped" }), ["plugged_in"]);
  assert.deepEqual(step({ DetailedChargeState: "DetailedChargeStateCharging" }, { DetailedChargeState: "DetailedChargeStateStopped" }), ["charge_stopped"]);
  assert.deepEqual(step({ DetailedChargeState: "Starting" }, { DetailedChargeState: "Stopped" }), ["charge_stopped"]);
  assert.deepEqual(step({ DetailedChargeState: "NoPower" }, { DetailedChargeState: "Stopped" }), []);
  assert.deepEqual(step({ DetailedChargeState: "Complete" }, { DetailedChargeState: "Stopped" }), []);
});

test("SentryMode Panic -> Aware does not fire a second, normal alert", () => {
  assert.deepEqual(step({ SentryMode: "SentryModeStatePanic" }, { SentryMode: "SentryModeStateAware" }), []);
  assert.deepEqual(step({ SentryMode: "Panic" }, { SentryMode: "Armed" }), []);
  assert.deepEqual(step({ SentryMode: "Armed" }, { SentryMode: "Aware" }), ["sentry_alert"], "a fresh Aware still fires");
});

test("resend records update the stored state without firing", async () => {
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(example);
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  try {
    const rec = (createdAt: string, data: Record<string, TelemetryValue>, extra: object = {}) => a.ingestTelemetry({ vin: VIN, createdAt, data, ...extra });
    assert.deepEqual(await rec("2026-01-01T00:00:00Z", { DetailedChargeState: "Charging" }), [], "baseline");
    assert.deepEqual(await rec("2026-01-01T00:10:00Z", { DetailedChargeState: "Complete" }, { isResend: true }), [], "resend never fires");
    assert.ok(b.audit.lines.some((l) => l.reason === "resend"));
    // State moved to Complete: the live Complete is no change, so it doesn't fire either.
    assert.deepEqual(await rec("2026-01-01T00:11:00Z", { DetailedChargeState: "Complete" }), []);
    assert.deepEqual(await rec("2026-01-01T00:20:00Z", { DetailedChargeState: "Charging" }), []);
    assert.deepEqual(await rec("2026-01-01T00:30:00Z", { DetailedChargeState: "Complete" }), ["charge_complete"]);
    assert.deepEqual(await rec("2026-01-01T00:05:00Z", { DetailedChargeState: "Stopped" }, { isResend: true }), [], "an older resend");
    assert.ok(b.audit.lines.some((l) => l.reason === "stale_record"), "older resends don't touch state");
    assert.equal(m.hits.length, 1);
  } finally {
    await b.close();
    await m.close();
  }
});
