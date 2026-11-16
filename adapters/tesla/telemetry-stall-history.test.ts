import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TeslaAdapter, validateTeslaConfig, type FetchLike, type TelemetryReceiver, type TeslaConfig } from "./index.js";
import { mockRoutine, startBridge } from "../../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as TeslaConfig;
const VIN = "5YJ0000000EXAMPLE";
const API = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const T0 = Date.parse("2026-11-16T12:00:00Z");
const posix = process.platform !== "win32";
const stubReceiver = (): TelemetryReceiver => ({ start: async () => undefined, stop: async () => undefined });
const settle = () => new Promise((r) => setTimeout(r, 150));

function cfgWith(telemetry: Partial<NonNullable<TeslaConfig["telemetry"]>>, extraRoutes: TeslaConfig["routes"] = []): TeslaConfig {
  const ids = new Set(extraRoutes.map((r) => r.id));
  return {
    ...example,
    telemetry: { ...example.telemetry!, enabled: true, mode: "decoded", ...telemetry },
    routes: [...example.routes.filter((r) => !ids.has(r.id)), ...extraRoutes],
  };
}
const stallRoute = { id: "example-telemetry-stall", enabled: true, match: { kind: "telemetry_stall" }, allowActors: [VIN], agent: "example-agent" };

// ---------- validation ----------

test("stall_alert / history: off by default, validated, need a route and api_base/token_ref when on", () => {
  assert.deepEqual(validateTeslaConfig(example), []);
  const v = (t: object, routes: TeslaConfig["routes"] = []) => validateTeslaConfig(cfgWith(t, routes)).join("\n");
  const on = { enabled: true, api_base: API, token_ref: "file:/run/secrets/tesla-fleet/access-token" };
  assert.equal(v({ stall_alert: on }, [stallRoute]), "");
  const noStallRoute = { ...cfgWith({ stall_alert: on }), routes: example.routes.filter((r) => r.match.kind !== "telemetry_stall") };
  assert.match(validateTeslaConfig(noStallRoute).join("\n"), /needs a route with match \{ kind: "telemetry_stall" \}/);
  assert.match(v({ stall_alert: { ...on, api_base: undefined } }, [stallRoute]), /stall_alert\.api_base is required/);
  assert.match(v({ stall_alert: { ...on, api_base: "https://fleet-api.example.com" } }, [stallRoute]), /must be one of/);
  assert.match(v({ stall_alert: { ...on, token_ref: "vault:x" } }, [stallRoute]), /token_ref must be env:NAME or file:/);
  assert.match(v({ stall_alert: { ...on, silent_minutes: 1 } }, [stallRoute]), /silent_minutes must be a whole number 5-1440/);
  assert.match(v({ stall_alert: { ...on, check_minutes: 0 } }, [stallRoute]), /check_minutes must be a whole number 1-60/);
  assert.equal(v({ stall_alert: { enabled: false } }), "", "off needs nothing");
  assert.equal(v({ history: { enabled: true } }), "");
  assert.equal(v({ history: { enabled: true, path: "file:/var/lib/bridge/history.sqlite", retention_days: 30 } }), "");
  assert.match(v({ history: { enabled: true, path: "history.sqlite" } }), /history\.path must be file:\/absolute\/path/);
  assert.match(v({ history: { enabled: true, retention_days: 0 } }), /retention_days must be a whole number 1-3650/);
  assert.match(v({ history: { enabled: "yes" } }), /history\.enabled must be true or false/);
});

// ---------- stall alert ----------

function fleet(states: () => Record<string, string> | { status: number; body?: string; headers?: Record<string, string> }) {
  const calls: { url: string; auth: string }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    const s = states();
    if ("status" in s && typeof s.status === "number") {
      const body = typeof s.body === "string" ? s.body : "";
      return { status: s.status, headers: { get: (h: string) => (s.headers as Record<string, string> | undefined)?.[h.toLowerCase()] ?? null }, text: async () => body };
    }
    const body = JSON.stringify({ response: Object.entries(s).map(([vin, state]) => ({ vin, state, id_s: "1" })), count: 1 });
    return { status: 200, headers: { get: () => null }, text: async () => body };
  };
  return { f, calls };
}

async function stallRig(states: Parameters<typeof fleet>[0], patch: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tesla-stall-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "access-one\n");
  const api = fleet(states);
  let clock = T0;
  const cfg = cfgWith({ stall_alert: { enabled: true, api_base: API, token_ref: `file:${tokenFile}`, ...patch } }, [stallRoute]);
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(cfg, { receiver: stubReceiver(), fetchImpl: api.f, now: () => clock });
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  const msg = (data: object = { Soc: 50 }, extra: object = {}) => a.ingestTelemetry({ vin: VIN, createdAt: new Date(clock).toISOString(), data: data as never, ...extra });
  return {
    a, b, m, api, tokenFile, msg,
    stall: a.stallRuntime()!,
    advance: (min: number) => (clock += min * 60_000),
    reasons: () => b.audit.lines.map((l) => l.reason),
    close: async () => {
      await b.close();
      await m.close();
    },
  };
}

test("stall: no Fleet call while messages flow; one list call per check while silent; online fires once, then resumed", async () => {
  const r = await stallRig(() => ({ [VIN]: "online" }));
  try {
    await r.msg();
    for (let i = 0; i < 10; i++) {
      r.advance(5);
      await r.msg();
      assert.deepEqual(await r.stall.check(), []);
    }
    assert.equal(r.api.calls.length, 0, "messages flowing: no billed calls");
    r.advance(29);
    assert.deepEqual(await r.stall.check(), [], "29 min silent: not yet");
    assert.equal(r.api.calls.length, 0);
    r.advance(1);
    assert.deepEqual(await r.stall.check(), ["telemetry_stalled"]);
    assert.equal(r.api.calls.length, 1);
    assert.equal(r.api.calls[0].url, `${API}/api/1/vehicles`, "vehicle list only: no vehicle_data, no wake_up");
    assert.equal(r.api.calls[0].auth, "Bearer access-one");
    r.advance(5);
    assert.deepEqual(await r.stall.check(), [], "fires at most once per stall");
    assert.equal(r.api.calls.length, 1, "no further calls once the silent car has alerted");
    await r.msg();
    await settle();
    assert.equal(r.m.hits.length, 2);
    const [stalled, resumed] = r.m.hits.map((h) => h.body.prompt as string);
    assert.match(stalled, /telemetry stalled for VIN …XAMPLE: no telemetry for 30 min while the car reports online/);
    assert.match(stalled, /"vin_last6":"XAMPLE"/);
    assert.match(resumed, /telemetry resumed for VIN …XAMPLE after 35 min/);
    for (const p of [stalled, resumed]) assert.equal(p.includes(VIN), false, "never the full VIN in prompts");
    assert.ok(r.reasons().includes("telemetry_stalled") && r.reasons().includes("telemetry_resumed"));
    assert.equal((r.a.health() as { telemetry_stall: { fleet_calls: number } }).telemetry_stall.fleet_calls, 1);
  } finally {
    await r.close();
  }
});

test("stall: asleep / offline / unlisted car never alerts (audited once per outcome); retained baseline is not a message", async () => {
  let state = "asleep";
  const r = await stallRig(() => (state === "gone" ? {} : { [VIN]: state }));
  try {
    await r.msg({ Soc: 50 }, { baseline: true });
    r.advance(30);
    assert.deepEqual(await r.stall.check(), [], "silent since start (the baseline replay does not count)");
    r.advance(5);
    assert.deepEqual(await r.stall.check(), []);
    assert.equal(r.api.calls.length, 2, "asleep: one call per check");
    assert.equal(r.reasons().filter((x) => x === "stall_car_asleep").length, 1, "audited on change, not every check");
    state = "offline";
    r.advance(5);
    await r.stall.check();
    state = "gone";
    r.advance(5);
    await r.stall.check();
    assert.ok(r.reasons().includes("stall_car_offline") && r.reasons().includes("stall_vin_not_listed"));
    assert.equal(r.m.hits.length, 0, "no alert while the car isn't online");
    state = "online";
    r.advance(5);
    assert.deepEqual(await r.stall.check(), ["telemetry_stalled"]);
    await settle();
    assert.match(r.m.hits[0].body.prompt, /"since":"bridge_start"/);
  } finally {
    await r.close();
  }
});

test("stall: 429 backs off, 401 re-reads the token once, errors never fire", async () => {
  let answer: "429" | "401" | "rotate" | "ok" = "429";
  let tokenFile = "";
  const r = await stallRig(() => {
    if (answer === "429") return { status: 429, headers: { "retry-after": "1200" } };
    if (answer === "401") return { status: 401, body: "{}" };
    if (answer === "rotate") {
      // The plugin rotated the access token while this call was in flight.
      writeFileSync(tokenFile, "access-three\n");
      answer = "ok";
      return { status: 401, body: "{}" };
    }
    return { [VIN]: "online" };
  });
  tokenFile = r.tokenFile;
  try {
    r.advance(30);
    assert.deepEqual(await r.stall.check(), []);
    assert.ok(r.reasons().includes("rate_limited"));
    r.advance(5);
    assert.deepEqual(await r.stall.check(), []);
    assert.equal(r.api.calls.length, 1, "inside Retry-After: no call");
    assert.ok(r.reasons().includes("stall_check_backoff"));
    r.advance(16);
    answer = "401";
    assert.deepEqual(await r.stall.check(), []);
    assert.equal(r.api.calls.length, 2, "401 with an unchanged token: no retry");
    assert.ok(r.reasons().includes("unauthorized"));
    r.advance(4);
    assert.deepEqual(await r.stall.check(), [], "auth backoff");
    assert.equal(r.api.calls.length, 2);
    answer = "rotate";
    r.advance(1);
    assert.deepEqual(await r.stall.check(), ["telemetry_stalled"]);
    assert.deepEqual(r.api.calls.slice(2).map((c) => c.auth), ["Bearer access-one", "Bearer access-three"], "one retry with the re-read token");
  } finally {
    await r.close();
  }
});

// ---------- history ----------

async function historyRig(patch: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tesla-history-"));
  let clock = T0;
  const cfg = cfgWith({ history: { enabled: true, ...patch } });
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(cfg, { receiver: stubReceiver(), now: () => clock });
  const b = await startBridge({ routineUrl: m.url, adapters: [a], holdFile: join(dir, "hold.json") });
  return {
    a, b, m, dir,
    file: join(dir, "tesla-telemetry-history.sqlite"),
    advance: (ms: number) => (clock += ms),
    reasons: () => b.audit.lines.map((l) => l.reason),
    close: async () => {
      await b.close();
      await m.close();
    },
  };
}

test("history: accepted datums of allowlisted VINs land in SQLite (WAL, indexed, mode 600); others never", async () => {
  const r = await historyRig();
  try {
    const w = r.a.historyWriter()!;
    assert.ok(w, "history opened");
    await r.a.ingestTelemetry({ vin: VIN, createdAt: "2026-11-16T12:00:00Z", data: { Soc: 50, DetailedChargeState: "DetailedChargeStateCharging" } });
    await r.a.ingestTelemetry({ vin: VIN, createdAt: "2026-11-16T12:01:00Z", isResend: true, data: { Soc: 51 } });
    await r.a.ingestTelemetry({ vin: VIN, createdAt: "2026-11-16T11:00:00Z", data: { Soc: 1 } }); // stale: skipped
    await r.a.ingestTelemetry({ vin: VIN, createdAt: "2026-11-16T12:02:00Z", baseline: true, data: { Gear: "ShiftStateP" } }); // retained replay
    await r.a.ingestTelemetry({ vin: "5YJ0000000OTHER00", createdAt: "2026-11-16T12:00:00Z", data: { Soc: 9 } });
    assert.equal(w.flush(), 3);
    const db = new DatabaseSync(r.file, { readOnly: true });
    const rows = db.prepare("SELECT vin, field, value, created_at, received_at FROM telemetry ORDER BY id").all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((x) => [x.vin, x.field, JSON.parse(String(x.value))]), [
      [VIN, "Soc", 50],
      [VIN, "DetailedChargeState", "DetailedChargeStateCharging"],
      [VIN, "Soc", 51],
    ]);
    assert.equal(rows[0].created_at, Date.parse("2026-11-16T12:00:00Z"));
    assert.equal(rows[0].received_at, T0);
    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    const idx = (db.prepare("PRAGMA index_list(telemetry)").all() as Array<{ name: string }>).map((x) => x.name);
    assert.ok(idx.includes("telemetry_vin_field_created") && idx.includes("telemetry_received"));
    db.close();
    if (posix) assert.equal(statSync(r.file).mode & 0o777, 0o600);
  } finally {
    await r.close();
  }
});

test("history: daily prune by retention_days; batches flush on size", async () => {
  const r = await historyRig({ retention_days: 1 });
  try {
    const w = r.a.historyWriter()!;
    for (let i = 0; i < 600; i++) await r.a.ingestTelemetry({ vin: VIN, createdAt: new Date(T0 + i * 1000).toISOString(), data: { Soc: i % 100 } });
    assert.ok((w.health() as { rows_written: number }).rows_written >= 500, "a full batch flushes without waiting for the timer");
    w.flush();
    r.advance(2 * 86400_000);
    await r.a.ingestTelemetry({ vin: VIN, createdAt: new Date(T0 + 2 * 86400_000).toISOString(), data: { Soc: 7 } });
    w.flush();
    assert.equal(w.prune(), 600);
    assert.ok(r.reasons().includes("history_pruned"));
    const db = new DatabaseSync(r.file, { readOnly: true });
    assert.equal((db.prepare("SELECT count(*) AS n FROM telemetry").get() as { n: number }).n, 1);
    db.close();
  } finally {
    await r.close();
  }
});

test("history: a DB error is audited (history_write_failed) and never breaks ingest; no node:sqlite = history off", async () => {
  const r = await historyRig();
  try {
    const w = r.a.historyWriter()!;
    // Break the table under the writer: the next flush fails.
    const db = new DatabaseSync(r.file);
    db.exec("DROP TABLE telemetry");
    db.close();
    const fired = await r.a.ingestTelemetry({ vin: VIN, createdAt: "2026-11-16T12:00:00Z", data: { DetailedChargeState: "DetailedChargeStateCharging" } });
    assert.deepEqual(fired, []);
    assert.equal(w.flush(), 0);
    assert.ok(r.reasons().includes("history_write_failed"));
    // Triggers still work while history is failing.
    const fired2 = await r.a.ingestTelemetry({ vin: VIN, createdAt: "2026-11-16T12:05:00Z", data: { DetailedChargeState: "DetailedChargeStateComplete" } });
    assert.deepEqual(fired2, ["charge_complete"]);
  } finally {
    await r.close();
  }
  const { TelemetryHistory } = await import("./index.js");
  const audit: string[] = [];
  const ctx = { log: { warn: () => undefined }, audit: (e: { reason?: string }) => audit.push(String(e.reason)), dataFile: (n: string) => join(mkdtempSync(join(tmpdir(), "tesla-history-")), n) };
  const h = new TelemetryHistory({ enabled: true }, ctx as never, { now: () => T0, loadSqlite: () => Promise.reject(new Error("ERR_UNKNOWN_BUILTIN_MODULE")) });
  assert.equal(await h.start(), false);
  assert.deepEqual(audit, ["history_sqlite_unavailable"]);
  h.add(VIN, { Soc: 1 }, T0, T0);
  assert.equal(h.flush(), 0);
  h.stop();
  const noDir = new TelemetryHistory({ enabled: true }, { ...ctx, dataFile: () => "" } as never, { now: () => T0 });
  assert.equal(await noDir.start(), false);
  assert.ok(audit.includes("history_no_path"));
});
