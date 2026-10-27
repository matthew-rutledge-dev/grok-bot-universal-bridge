import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Aedes } from "aedes";
import { connect, type MqttClient } from "mqtt";
import {
  brokerUrlProblem,
  isLanHost,
  parseMqttTopic,
  parseMqttValue,
  alertSubscriptionFor,
  subscriptionFor,
  TeslaAdapter,
  validateTeslaConfig,
  VIN_DENY_AUDIT_MAX,
  type TeslaConfig,
} from "./index.js";
import { mockRoutine, startBridge } from "../../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as TeslaConfig;
const VIN = "5YJ0000000EXAMPLE";
const BASE = "telemetry";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(15);
  }
}

/** In-process MQTT broker (aedes, pure JS) on 127.0.0.1. restart() reuses the same port. */
async function broker(opts: { auth?: { user: string; pass: string }; refuseSubscribe?: () => boolean } = {}) {
  let aedes: Aedes;
  let server: Server;
  const sockets = new Set<Socket>();
  let port = 0;
  const up = async () => {
    aedes = await Aedes.createBroker();
    if (opts.auth) {
      const want = opts.auth;
      aedes.authenticate = (_c, u, p, done) => {
        const ok = u === want.user && p?.toString() === want.pass;
        if (ok) return done(null, true);
        const err = Object.assign(new Error("bad"), { returnCode: 5 });
        done(err as never, false);
      };
    }
    if (opts.refuseSubscribe) {
      const refuse = opts.refuseSubscribe;
      // null subscription = negated: SUBACK return code 0x80 (128).
      aedes.authorizeSubscribe = (_c, sub, done) => (refuse() ? done(null, null as never) : done(null, sub));
    }
    server = createServer((s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      aedes.handle(s);
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  };
  const down = async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => aedes.close(() => r()));
  };
  await up();
  return {
    url: () => `mqtt://127.0.0.1:${port}`,
    clients: () => aedes.connectedClients,
    restart: async () => {
      await down();
      await up();
    },
    down,
    up,
  };
}

/** Plays fleet-telemetry's MQTT dispatcher: one message per datum, JSON value only. */
async function publisher(url: string) {
  const c: MqttClient = connect(url, { clientId: "fleet-telemetry-test", reconnectPeriod: 0 });
  await new Promise<void>((resolve, reject) => {
    c.once("connect", () => resolve());
    c.once("error", reject);
  });
  const pub = (topic: string, payload: string | Buffer, retain = false) =>
    new Promise<void>((resolve, reject) => c.publish(topic, payload, { qos: 1, retain }, (e) => (e ? reject(e) : resolve())));
  return {
    datum: (field: string, value: unknown, retain = false, vin = VIN) => pub(`${BASE}/${vin}/v/${field}`, JSON.stringify(value), retain),
    raw: pub,
    close: () => new Promise<void>((r) => c.end(true, {}, () => r())),
  };
}

function mqttCfg(url: string, patch: Partial<NonNullable<TeslaConfig["telemetry"]>["mqtt"]> = {}): TeslaConfig {
  const { username_ref: _u, password_ref: _p, ...m } = example.telemetry!.mqtt!;
  return {
    ...example,
    telemetry: { ...example.telemetry!, enabled: true, mode: "mqtt", mqtt: { ...m, broker: url, batch_ms: 40, reconnect_min_ms: 50, reconnect_max_ms: 200, ...patch } },
  };
}

const CLOSED = { DriverFront: false, DriverRear: false, PassengerFront: false, PassengerRear: false, TrunkFront: false, TrunkRear: false };

// ---------- unit ----------

test("mqtt: topic layout <base>/<VIN>/v/<Field>; VIN from the topic", () => {
  assert.equal(subscriptionFor("telemetry"), "telemetry/+/v/+");
  assert.deepEqual(parseMqttTopic("telemetry", `telemetry/${VIN}/v/DetailedChargeState`), { vin: VIN, field: "DetailedChargeState" });
  assert.deepEqual(parseMqttTopic("a/b", `a/b/${VIN}/v/Gear`), { vin: VIN, field: "Gear" });
  assert.deepEqual(parseMqttTopic("telemetry", `telemetry/${VIN}/alerts/X/current`), { vin: VIN, field: "", alert: "X" });
  assert.equal(parseMqttTopic("telemetry", `telemetry/${VIN}/alerts/X/history`), undefined);
  assert.equal(parseMqttTopic("telemetry", `telemetry/${VIN}/errors/X`), undefined);
  assert.equal(parseMqttTopic("telemetry", `telemetry/${VIN}/connectivity`), undefined);
  assert.equal(parseMqttTopic("telemetry", "telemetry/not-a-vin/v/Gear"), undefined);
  assert.equal(parseMqttTopic("telemetry", `other/${VIN}/v/Gear`), undefined);
  assert.equal(parseMqttTopic("telemetry", `telemetry/${VIN}/v/Gear/extra`), undefined);
});

test("mqtt: datum values (getDatumValue shapes): null = invalid, DoorState struct, scalars", () => {
  assert.deepEqual(parseMqttValue("ChargingCableType", null), { invalid: true });
  assert.equal(parseMqttValue("DetailedChargeState", "DetailedChargeStateComplete"), "DetailedChargeStateComplete");
  assert.equal(parseMqttValue("BatteryLevel", 80.5), 80.5);
  assert.equal(parseMqttValue("BatteryLevel", "80.5"), "80.5");
  assert.deepEqual(parseMqttValue("DoorState", { ...CLOSED, TrunkRear: true }), { ...CLOSED, TrunkRear: true });
  assert.equal(parseMqttValue("DoorState", "open"), undefined);
  assert.equal(parseMqttValue("Gear", { latitude: 1 }), undefined);
  assert.equal(parseMqttValue("Gear", [1]), undefined);
});

test("mqtt: broker URL rules (literal = loopback/LAN, no credentials; refs ok)", () => {
  // Addresses are built from parts so the repo carries no literal non-loopback IPs.
  const ip = (...o: number[]) => o.join(".");
  for (const h of ["127.0.0.1", "localhost", ip(10, 1, 2, 3), ip(192, 168, 0, 10), ip(172, 20, 0, 5), ip(169, 254, 1, 1), "[::1]", "[fd00::5]", "mosquitto", "broker.lan", "nas.local"]) {
    assert.equal(isLanHost(h), true, h);
  }
  for (const h of [ip(8, 8, 8, 8), "broker.example.com", ip(172, 32, 0, 1), ip(192, 0, 2, 1), "[2001:db8::1]"]) assert.equal(isLanHost(h), false, h);
  // Integer / hex hosts and IPv4 shorthand resolve to addresses the name rules can't see: refused.
  const asInt = (...o: number[]) => String(o.reduce((n, x) => n * 256 + x, 0));
  const asHex = (...o: number[]) => `0x${o.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  for (const h of [asInt(8, 8, 8, 8), asInt(127, 0, 0, 1), asHex(8, 8, 8, 8), asHex(127, 0, 0, 1), "0X7F000001", "127.1", "10.1", "10.0.1", "0177.0.0.1", "0x7f.0.0.1", "127.0.0.0x1", "0", "0x"]) {
    assert.equal(isLanHost(h), false, h);
    assert.match(brokerUrlProblem(`mqtt://${h}:1883`, true) ?? "", /loopback or LAN/, h);
  }
  // Names that merely contain digits are still names.
  for (const h of ["mqtt1", "broker-01", "nas2.lan"]) assert.equal(isLanHost(h), true, h);
  assert.equal(brokerUrlProblem("mqtt://127.0.0.1:1883", true), undefined);
  assert.match(brokerUrlProblem("mqtt://broker.example.com:1883", true)!, /loopback or LAN/);
  assert.match(brokerUrlProblem("mqtt://u:p@127.0.0.1:1883", true)!, /credentials/);
  assert.match(brokerUrlProblem("http://127.0.0.1:1883", true)!, /mqtt:\/\/ or mqtts:\/\//);
  assert.equal(brokerUrlProblem("mqtts://broker.example.com:8883", false), undefined, "a ref'd URL may point anywhere");
  const v = (m: object) => validateTeslaConfig({ ...example, telemetry: { ...example.telemetry!, mqtt: { ...example.telemetry!.mqtt!, ...m } } }).join("\n");
  assert.equal(v({}), "");
  assert.equal(v({ broker: "env:TESLA_MQTT_URL" }), "");
  assert.equal(v({ broker: "file:/run/secrets/mqtt-url" }), "");
  assert.match(v({ broker: "file:relative" }), /broker must be env:NAME or file:/);
  assert.match(v({ broker: "mqtt://broker.example.com" }), /loopback or LAN/);
  assert.match(v({ qos: 2 }), /qos must be 1/);
  assert.match(v({ topic_base: "telemetry/#" }), /wildcards/);
  assert.match(v({ topic_base: "/telemetry" }), /start or end/);
  assert.match(v({ client_id: "" }), /client_id/);
  assert.match(v({ password_ref: "hunter2" }), /password_ref must be env:NAME or file:/);
  assert.match(v({ username_ref: undefined }), /password_ref needs username_ref/);
  assert.match(v({ ca_file: "env:CA" }), /ca_file must be file:/);
  assert.match(v({ batch_ms: 99999 }), /batch_ms/);
  assert.match(validateTeslaConfig({ ...example, telemetry: { ...example.telemetry!, enabled: true, mqtt: undefined } }).join("\n"), /mqtt is required in mqtt mode/);
});

// ---------- end to end ----------

test("mqtt e2e: publish -> record -> trigger -> wake submit to the routine; Gear+DoorState coalesced", async () => {
  const br = await broker();
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(mqttCfg(br.url()));
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  const p = await publisher(br.url());
  try {
    await until(() => b.audit.lines.some((l) => l.reason === "mqtt_subscribed"));
    assert.ok(b.audit.lines.some((l) => l.action === "connection" && l.reason === "mqtt_connected"));
    // Baseline (first values never fire).
    await p.datum("DetailedChargeState", "DetailedChargeStateCharging");
    await p.datum("Gear", "ShiftStateD");
    await p.datum("DoorState", CLOSED);
    await sleep(120);
    assert.equal(m.hits.length, 0, "baseline");
    await p.datum("DetailedChargeState", "DetailedChargeStateComplete");
    await until(() => m.hits.length === 1);
    assert.match(m.hits[0].body.prompt, /Tesla vehicle …MPLE: charge_complete \(priority normal\)/);
    assert.equal(m.hits[0].body.prompt.includes(VIN), false, "masked VIN only");
    // One fleet-telemetry Payload: DoorState published before Gear (SetOrderMatters(false)). The batch sees both.
    await p.datum("DoorState", { ...CLOSED, DriverFront: true });
    await p.datum("Gear", "ShiftStateP");
    await until(() => m.hits.length === 2);
    assert.match(m.hits[1].body.prompt, /door_open_parked \(priority high\)/);
    // Another VIN on the same broker is not allowlisted.
    await p.datum("DetailedChargeState", "DetailedChargeStateComplete", false, "5YJ1111111EXAMPLE");
    await until(() => b.audit.lines.some((l) => l.reason === "vin_not_allowlisted"));
    assert.equal(JSON.stringify(b.audit.lines).includes(VIN), false, "audit has masked ids only");
  } finally {
    await p.close();
    await b.close();
    await m.close();
    await br.down();
  }
});

test("mqtt: malformed topics and payloads are audited bad_record and never crash; unknown fields ignored", async () => {
  const br = await broker();
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(mqttCfg(br.url()));
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  const p = await publisher(br.url());
  try {
    await until(() => b.audit.lines.some((l) => l.reason === "mqtt_subscribed"));
    await p.raw(`${BASE}/${VIN}/v/SentryMode`, "not json{");
    await p.raw(`${BASE}/${VIN}/v/SentryMode`, Buffer.from([0xff, 0xfe, 0x00]));
    await p.raw(`${BASE}/${VIN}/v/DoorState`, JSON.stringify("open"));
    await p.raw(`${BASE}/${VIN}/v/Gear`, JSON.stringify({ nested: { deep: 1 } }));
    await p.raw(`${BASE}/${VIN}/v/SentryMode`, JSON.stringify("x".repeat(70 * 1024)));
    await p.raw(`${BASE}/lowercase-not-a-vin1/v/Gear`, JSON.stringify("ShiftStateP"));
    await p.raw(`${BASE}/${VIN}/v/Odometer`, JSON.stringify(1234.5));
    await until(() => b.audit.lines.filter((l) => l.reason === "bad_record").length >= 6);
    assert.equal(b.audit.lines.filter((l) => l.reason === "bad_record").length, 6, "Odometer (not read) is ignored, not bad");
    // Still alive and working.
    await p.datum("SentryMode", "SentryModeStateArmed");
    await sleep(100);
    await p.datum("SentryMode", "SentryModeStateAware");
    await until(() => m.hits.length === 1);
    assert.match(m.hits[0].body.prompt, /sentry_alert/);
  } finally {
    await p.close();
    await b.close();
    await m.close();
    await br.down();
  }
});

test("mqtt: reconnects with backoff after the broker drops; audits disconnect and connect", async () => {
  const br = await broker();
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(mqttCfg(br.url()));
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  try {
    await until(() => b.audit.lines.some((l) => l.reason === "mqtt_subscribed"));
    await br.down();
    await until(() => b.audit.lines.some((l) => l.reason === "mqtt_disconnected"));
    // Failed attempts while it's down (Windows takes ~2 s per refused connect, so wait on the audit).
    await until(() => b.audit.lines.some((l) => l.reason === "mqtt_connect_failed"), 15000);
    const waits = b.audit.lines.filter((l) => l.reason === "mqtt_connect_failed").map((l) => l.ms as number);
    assert.ok(waits.every((w) => w >= 40 && w <= 240), `backoff within min/max: ${waits}`);
    await br.up();
    await until(() => b.audit.lines.filter((l) => l.reason === "mqtt_subscribed").length >= 2, 8000);
    const p = await publisher(br.url());
    try {
      await p.datum("DetailedChargeState", "DetailedChargeStateCharging");
      await sleep(100);
      await p.datum("DetailedChargeState", "DetailedChargeStateComplete");
      await until(() => m.hits.length === 1);
      assert.match(m.hits[0].body.prompt, /charge_complete/);
    } finally {
      await p.close();
    }
    assert.equal(JSON.stringify(b.audit.lines).includes("127.0.0.1"), false, "audit never carries the broker URL");
  } finally {
    await b.close();
    await m.close();
    await br.down();
  }
});

test("mqtt: retained values are a baseline only; repeated (resent) values and older records don't fire", async () => {
  const br = await broker();
  const p = await publisher(br.url());
  await p.datum("SentryMode", "SentryModeStateArmed", true);
  await p.datum("DetailedChargeState", "DetailedChargeStateCharging", true);
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(mqttCfg(br.url()), { now: () => clock });
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  try {
    await until(() => b.audit.lines.some((l) => l.reason === "retained_baseline"));
    assert.equal(m.hits.length, 0, "retained replay never fires");
    // The retained values were the baseline, so the first live change fires.
    await p.datum("SentryMode", "SentryModeStateAware");
    await until(() => m.hits.length === 1);
    // fleet-telemetry resending the same value (resend_interval_seconds): no change, no fire.
    clock += 60_000;
    await p.datum("SentryMode", "SentryModeStateAware");
    await sleep(150);
    assert.equal(m.hits.length, 1);
    // A batch stamped earlier than the last one (clock went back) is stale and skipped.
    clock -= 3_600_000;
    await p.datum("DetailedChargeState", "DetailedChargeStateComplete");
    await until(() => b.audit.lines.some((l) => l.reason === "stale_record"));
    assert.equal(m.hits.length, 1);
  } finally {
    await p.close();
    await b.close();
    await m.close();
    await br.down();
  }
});

test("mqtt: username/password refs are re-read; bad credentials audited (no secrets); unresolved refs fail start", async () => {
  const br = await broker({ auth: { user: "bridge", pass: "broker-pass-1" } });
  const m = await mockRoutine({ key: "routine-key" });
  const env = { MQTT_USER: "bridge" };
  const passFile = join(mkdtempSync(join(tmpdir(), "tesla-mqtt-")), "mqtt-password");
  writeFileSync(passFile, "wrong-pass\n", { mode: 0o600 });
  const cfg = mqttCfg(br.url(), { username_ref: "env:MQTT_USER", password_ref: `file:${passFile}` });
  const a = new TeslaAdapter(cfg);
  const b = await startBridge({ routineUrl: m.url, adapters: [a], env });
  try {
    await until(() => b.audit.lines.some((l) => l.reason === "mqtt_connack_not_authorized" || l.reason === "mqtt_connack_bad_credentials"));
    writeFileSync(passFile, "broker-pass-1\n"); // rotated on the host: picked up on the next reconnect
    await until(() => b.audit.lines.some((l) => l.reason === "mqtt_subscribed"), 8000);
    const text = JSON.stringify(b.audit.lines);
    assert.equal(text.includes("wrong-pass") || text.includes("broker-pass-1"), false, "no secrets in audit");
  } finally {
    await b.close();
    await m.close();
    await br.down();
  }
  const ctx = { log: { info() {}, warn() {}, error() {} }, audit() {}, submit: async () => ({ accepted: true }), secret: () => undefined } as never;
  const a2 = new TeslaAdapter(mqttCfg("env:TESLA_MQTT_URL"));
  a2.init(ctx);
  await assert.rejects(a2.start(), /mqtt\.broker is set but does not resolve \(env:TESLA_MQTT_URL\)/);
  const a3 = new TeslaAdapter(mqttCfg("mqtt://127.0.0.1:1", { username_ref: "env:U", password_ref: "env:P" }));
  a3.init(ctx);
  await assert.rejects(a3.start(), /username_ref is set but does not resolve/);
});

test("mqtt: a refused subscribe drops the connection and the backoff reconnects and subscribes", async () => {
  let refusals = 2;
  const br = await broker({ refuseSubscribe: () => refusals-- > 0 });
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(mqttCfg(br.url()));
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  try {
    await until(() => b.audit.lines.some((l) => l.reason === "mqtt_subscribed"), 10000);
    const reasons = b.audit.lines.map((l) => l.reason);
    assert.equal(reasons.filter((r) => r === "mqtt_subscribe_refused").length, 2);
    assert.ok(reasons.filter((r) => r === "mqtt_connected").length >= 3, "reconnected after each refusal");
    assert.ok(reasons.includes("mqtt_disconnected"), "the refused connection was closed (backoff path)");
    const p = await publisher(br.url());
    try {
      await p.datum("SentryMode", "SentryModeStateArmed");
      await sleep(100);
      await p.datum("SentryMode", "SentryModeStateAware");
      await until(() => m.hits.length === 1);
    } finally {
      await p.close();
    }
  } finally {
    await b.close();
    await m.close();
    await br.down();
  }
});

test("mqtt: VINs not allowlisted are dropped before parsing or batching; the audit line is rate-limited", async () => {
  const br = await broker();
  const m = await mockRoutine({ key: "routine-key" });
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const a = new TeslaAdapter(mqttCfg(br.url()), { now: () => clock });
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  const p = await publisher(br.url());
  const OTHER = "5YJ000000EXAMPLE9";
  const denies = () => b.audit.lines.filter((l) => l.reason === "vin_not_allowlisted");
  try {
    await until(() => b.audit.lines.some((l) => l.reason === "mqtt_subscribed"));
    // Garbage and oversized payloads from an unknown VIN are never parsed: no bad_record.
    await p.raw(`${BASE}/${OTHER}/v/SentryMode`, "not json{");
    await p.raw(`${BASE}/${OTHER}/v/SentryMode`, JSON.stringify("x".repeat(70 * 1024)));
    for (let i = 0; i < 20; i++) await p.datum("SentryMode", i % 2 ? "SentryModeStateAware" : "SentryModeStateArmed", false, OTHER);
    // A known VIN after them proves the stream was consumed in order.
    await p.datum("SentryMode", "SentryModeStateArmed");
    await sleep(100);
    await p.datum("SentryMode", "SentryModeStateAware");
    await until(() => m.hits.length === 1);
    assert.equal(b.audit.lines.filter((l) => l.reason === "bad_record").length, 0, "unknown VIN payloads are not parsed");
    assert.equal(denies().length, 1, "22 messages, one audit line");
    assert.equal(denies()[0].actor, "…PLE9");
    assert.equal(JSON.stringify(b.audit.lines).includes(OTHER), false, "masked only");
    // Ten minutes on, the next line carries the count suppressed in between.
    clock += 10 * 60_000;
    await p.datum("SentryMode", "SentryModeStateArmed", false, OTHER);
    await until(() => denies().length === 2);
    assert.equal(denies()[1].count, 21);
    assert.equal(m.hits.length, 1, "only the allowlisted VIN fired");
  } finally {
    await p.close();
    await b.close();
    await m.close();
    await br.down();
  }
});

test("adapter: the vin_not_allowlisted map is capped; a flood of distinct VINs can't grow it", async () => {
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(example, { now: () => 0 });
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  try {
    const vin = (i: number) => `OTHERVIN${String(i).padStart(9, "0")}`;
    for (let i = 0; i < VIN_DENY_AUDIT_MAX + 50; i++) await a.ingestTelemetry({ vin: vin(i), createdAt: "x", data: {} });
    assert.equal((a as any).vinDenyAudit.size, VIN_DENY_AUDIT_MAX);
    // The oldest were evicted, so they audit again; the newest are still suppressed.
    const before = b.audit.lines.length;
    await a.ingestTelemetry({ vin: vin(0), createdAt: "x", data: {} });
    await a.ingestTelemetry({ vin: vin(VIN_DENY_AUDIT_MAX + 49), createdAt: "x", data: {} });
    assert.equal(b.audit.lines.length - before, 1);
  } finally {
    await b.close();
    await m.close();
  }
});

test("tesla-live-check: invalid JSON config prints a fixed message, never a snippet of the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tesla-live-"));
  const file = join(dir, "tesla.json");
  writeFileSync(file, `{"telemetry": {"vin_allowlist": ["${VIN}"], "x": `);
  const script = fileURLToPath(new URL("../../scripts/tesla-live-check.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script, "--tesla-config", file], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /setup: invalid JSON in config/);
  assert.equal(out.includes(VIN), false);
  assert.equal(out.includes("vin_allowlist"), false);
});

test("mqtt: a broker that keeps refusing the subscribe gets exponential backoff, capped at reconnect_max_ms", async () => {
  const br = await broker({ refuseSubscribe: () => true });
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(mqttCfg(br.url(), { reconnect_min_ms: 50, reconnect_max_ms: 400 }));
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  try {
    const waits = () => b.audit.lines.filter((l) => l.reason === "mqtt_disconnected").map((l) => l.ms as number);
    await until(() => waits().length >= 6, 15000);
    const w = waits().slice(0, 6);
    // Bases 50, 100, 200, 400, 400, 400 with ±20 % jitter: each of the first four is above the last.
    for (let i = 1; i < 4; i++) assert.ok(w[i] > w[i - 1], `waits grow: ${w}`);
    assert.ok(w[0] >= 40 && w[0] <= 60, `starts at reconnect_min_ms: ${w}`);
    for (const x of w.slice(3)) assert.ok(x >= 320 && x <= 480, `capped at reconnect_max_ms: ${w}`);
    assert.equal(b.audit.lines.some((l) => l.reason === "mqtt_subscribed"), false);
    assert.ok(b.audit.lines.filter((l) => l.reason === "mqtt_subscribe_refused").length >= 6);
  } finally {
    await b.close();
    await m.close();
    await br.down();
  }
});

test("mqtt: with ownership on, alerts/<name>/current is subscribed and feeds ownership events; history/errors ignored", async () => {
  const br = await broker();
  const m = await mockRoutine({ key: "routine-key" });
  const dir = mkdtempSync(join(tmpdir(), "mqtt-own-"));
  const base = mqttCfg(br.url());
  const cfg: TeslaConfig = {
    ...base,
    ownership: { enabled: true, vehicles: [{ vin: VIN, vehicle_id: "car-a" }] },
    routes: [...base.routes.filter((r) => r.match.kind !== "ownership"), { id: "example-ownership", enabled: true, match: { kind: "ownership" }, allowActors: [VIN], agent: "example-agent" }],
  };
  assert.deepEqual(validateTeslaConfig(cfg), []);
  assert.equal(alertSubscriptionFor(BASE), "telemetry/+/alerts/+/current");
  const a = new TeslaAdapter(cfg);
  const b = await startBridge({ routineUrl: m.url, adapters: [a], holdFile: join(dir, "hold.json") });
  const p = await publisher(br.url());
  try {
    await until(() => b.audit.lines.some((l) => l.reason === "mqtt_subscribed"));
    const alert = { Name: "UI_a001_Example", StartedAt: "2026-10-27T12:00:00Z", Audiences: ["Customer"] };
    await p.raw(`${BASE}/${VIN}/alerts/UI_a001_Example/history`, JSON.stringify([alert]));
    await p.raw(`${BASE}/${VIN}/errors/some_error`, JSON.stringify({ Name: "some_error", Body: "x" }));
    await p.raw(`${BASE}/${VIN}/alerts/UI_a001_Example/current`, JSON.stringify(alert));
    await until(() => m.hits.length === 1);
    assert.match(m.hits[0].body.prompt, /ownership event for car-a .*vehicle_alert \(tier immediate, priority high\)/);
    assert.match(m.hits[0].body.prompt, /"name":"UI_a001_Example","audiences":\["Customer"\]/);
    // Same alert again (fleet-telemetry republishes current state): deduped. Name/topic mismatch: bad_record.
    await p.raw(`${BASE}/${VIN}/alerts/UI_a001_Example/current`, JSON.stringify(alert));
    await p.raw(`${BASE}/${VIN}/alerts/Other_a002/current`, JSON.stringify(alert));
    await until(() => b.audit.lines.some((l) => l.reason === "bad_record"));
    await sleep(100);
    assert.equal(m.hits.length, 1);
    // Ended: goes to the digest, not sent now.
    await p.raw(`${BASE}/${VIN}/alerts/UI_a001_Example/current`, JSON.stringify({ ...alert, EndedAt: "2026-10-27T12:10:00Z" }));
    await until(() => a.ownershipRuntime()!.pending()["car-a"] === 1);
    assert.equal(m.hits.length, 1);
  } finally {
    await p.close();
    await b.close();
    await m.close();
    await br.down();
  }
});
