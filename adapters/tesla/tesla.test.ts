import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Debouncer, deriveEnergyTriggers, deriveVehicleTriggers, TeslaAdapter, validateTeslaConfig, type TeslaConfig } from "./index.js";
import { mockRoutine, startBridge } from "../../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as TeslaConfig;
const VIN = "EXAMPLEVIN00000001";

test("example config validates", () => {
  assert.deepEqual(validateTeslaConfig(example), []);
});

test("refuses command config, vehicle_data polling, non-origin replies, literal secrets", () => {
  assert.match(validateTeslaConfig({ ...example, commands: ["honk"] } as unknown as TeslaConfig).join(), /never sends vehicle commands/);
  assert.match(validateTeslaConfig({ ...example, energy_poll: { ...example.energy_poll!, endpoint: "/api/1/vehicles/1/vehicle_data" } } as unknown as TeslaConfig).join(), /never poll vehicle_data/);
  assert.match(validateTeslaConfig({ ...example, reply: { via: "webhook" } } as unknown as TeslaConfig).join(), /origin_channel/);
  assert.match(validateTeslaConfig({ ...example, energy_poll: { ...example.energy_poll!, token_ref: "vault:x" } }).join(), /token_ref/);
});

test("telemetry/energy enabled without an implementation fails at start (skeleton)", async () => {
  const a = new TeslaAdapter({ ...example, telemetry: { ...example.telemetry!, enabled: true } });
  a.init({ log: { info() {}, warn() {}, error() {} } } as never);
  await assert.rejects(a.start(), /no mTLS receiver is implemented yet/);
});

test("trigger derivation and debounce", () => {
  assert.deepEqual(deriveVehicleTriggers({ ChargeState: "Charging" }, { ChargeState: "Complete" }), ["charge_complete"]);
  assert.deepEqual(deriveVehicleTriggers({ Gear: "P", DoorState: "Closed" }, { DoorState: "DriverFrontOpen" }), ["door_open_parked"]);
  assert.deepEqual(deriveVehicleTriggers({ Gear: "D", DoorState: "Closed" }, { DoorState: "DriverFrontOpen" }), []);
  assert.deepEqual(deriveVehicleTriggers({ Soc: 25 }, { Soc: 15 }), ["low_battery"]);
  assert.deepEqual(deriveVehicleTriggers({ Soc: 15 }, { Soc: 14 }), []);
  assert.deepEqual(deriveEnergyTriggers({ siteId: "s", gridStatus: "Active" }, { siteId: "s", gridStatus: "Islanded" }), ["grid_islanded"]);
  assert.deepEqual(deriveEnergyTriggers(undefined, { siteId: "s", percentCharged: 22, backupReservePercent: 20 }), ["battery_below_reserve"]);
  const d = new Debouncer();
  assert.deepEqual([d.allow("k", 60, 0), d.allow("k", 60, 30_000), d.allow("k", 60, 61_000)], [true, false, true]);
});

test("allowlisted VIN trigger is delivered with a masked id; other VINs are dropped; audit masks VINs", async () => {
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(example);
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  try {
    await a.ingestTelemetry({ vin: VIN, createdAt: "2026-01-01T00:00:00Z", data: { ChargeState: "Charging" } });
    const fired = await a.ingestTelemetry({ vin: VIN, createdAt: "2026-01-01T01:00:00Z", data: { ChargeState: "Complete" } });
    assert.deepEqual(fired, ["charge_complete"]);
    assert.equal(m.hits.length, 1);
    const prompt: string = m.hits[0].body.prompt;
    assert.match(prompt, /Tesla vehicle …0001: charge_complete/);
    assert.equal(prompt.includes(VIN), false, "full VIN never leaves the bridge");
    assert.deepEqual(await a.ingestTelemetry({ vin: "OTHERVIN000000009", createdAt: "x", data: { ChargeState: "Complete" } }), []);
    assert.equal(JSON.stringify(b.audit.lines).includes(VIN), false);
    assert.ok(b.audit.lines.some((l) => l.reason === "vin_not_allowlisted" && l.actor === "…0009"));
    assert.equal(b.bridge.stateOf("tesla:x"), undefined);
    const cb = await b.call("POST", "/tesla/callback", {});
    assert.equal(cb.status, 404, "no tesla callback route: replies use the origin channel");
  } finally {
    await b.close();
    await m.close();
  }
});
