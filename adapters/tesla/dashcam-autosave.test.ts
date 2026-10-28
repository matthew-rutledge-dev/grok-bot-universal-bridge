import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DashcamAutosaveRuntime,
  DEFAULT_COOLDOWN_S,
  envDashcamEnabled,
  isDashcamTrigger,
  isKeyRef,
  sanitizeDashcamState,
  validateDashcamAutosave,
  type DashcamAutosaveConfig,
} from "./dashcam-autosave.js";
import { validateTeslaConfig, type TeslaConfig, type OwnershipEvent } from "./index.js";
import type { AdapterContext } from "../../core/bridge.js";

const CAR_A = "5YJ3EXAMPLE000001";
const T0 = Date.parse("2026-10-27T12:00:00Z");

function ev(partial: Partial<OwnershipEvent> & Pick<OwnershipEvent, "event_type" | "dedupe_key" | "data">): OwnershipEvent {
  return {
    vehicle_id: "car-a",
    vin_last6: CAR_A.slice(-6),
    model: "Model 3 Example",
    ts: new Date(T0).toISOString(),
    source: "telemetry",
    tier: "immediate",
    priority: "high",
    ...partial,
  };
}

test("dashcam: env flag is exact string 1 only", () => {
  assert.equal(envDashcamEnabled({ TESLA_DASHCAM_AUTOSAVE: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(envDashcamEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(envDashcamEnabled({ TESLA_DASHCAM_AUTOSAVE: "true" } as NodeJS.ProcessEnv), false);
  assert.equal(envDashcamEnabled({ TESLA_DASHCAM_AUTOSAVE: "yes" } as NodeJS.ProcessEnv), false);
  assert.equal(envDashcamEnabled({ TESLA_DASHCAM_AUTOSAVE: "0" } as NodeJS.ProcessEnv), false);
});

test("dashcam: trigger match — collision alert start only", () => {
  assert.equal(
    isDashcamTrigger(ev({ event_type: "collision_or_safety", dedupe_key: "a", data: { kind: "alert", name: "crash", active: true } })),
    true,
  );
  assert.equal(
    isDashcamTrigger(ev({ event_type: "collision_or_safety", dedupe_key: "b", data: { kind: "aeb_setting", aeb_disabled: true } })),
    false,
  );
  assert.equal(
    isDashcamTrigger(ev({ event_type: "collision_or_safety", dedupe_key: "c", tier: "digest", data: { kind: "alert", active: false } })),
    false,
  );
  assert.equal(
    isDashcamTrigger(ev({ event_type: "vehicle_alert", dedupe_key: "d", data: { kind: "alert", name: "Other" } })),
    false,
  );
});

test("dashcam: key_ref must be absolute file:", () => {
  assert.equal(isKeyRef("file:/run/secrets/key.pem"), true);
  assert.equal(isKeyRef("file:C:/secrets/key.pem"), true);
  assert.equal(isKeyRef("env:KEY"), false);
  assert.equal(isKeyRef("file:relative.pem"), false);
  assert.equal(isKeyRef("file:/run/secrets/key.pem\n"), false);
});

test("dashcam: validate requires ownership + route + refs when enabled", () => {
  const base: DashcamAutosaveConfig = {
    enabled: true,
    api_base: "https://fleet-api.prd.na.vn.cloud.tesla.com",
    token_ref: "file:/run/secrets/token",
    key_ref: "file:/run/secrets/key.pem",
  };
  assert.deepEqual(validateDashcamAutosave(base, [CAR_A], true, true), []);
  assert.ok(validateDashcamAutosave(base, [CAR_A], false, true).some((x) => /dashcam_autosave/.test(x)));
  assert.ok(validateDashcamAutosave(base, [CAR_A], true, false).some((x) => /ownership/.test(x)));
  assert.ok(validateDashcamAutosave({ enabled: true }, [CAR_A], true, true).some((x) => /api_base/.test(x)));
});

test("dashcam: sanitize state drops bad fields", () => {
  const { state, dropped } = sanitizeDashcamState({
    version: 1,
    lastAttempt: { "car-a": 1, bad: "x" },
    alertKeys: { "car-a|Crash|2026-10-27T12:00:00Z": 2 },
    globalAttempts: [1, "no", 3],
    extra: true,
  });
  assert.equal(state.lastAttempt["car-a"], 1);
  assert.equal(state.alertKeys["car-a|Crash|2026-10-27T12:00:00Z"], 2);
  assert.deepEqual(state.globalAttempts, [1, 3]);
  assert.ok(dropped >= 2);
});

test("dashcam: TeslaConfig accepts dashcam_autosave route kind", () => {
  const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as TeslaConfig;
  // Example has enabled:false so missing live secrets are ok; route kind must be accepted.
  const problems = validateTeslaConfig(example);
  assert.deepEqual(problems.filter((p) => /dashcam|route/.test(p)), []);
});

function mockCtx(dir: string, submits: unknown[]) {
  const audit: unknown[] = [];
  const ctx: AdapterContext = {
    log: { info() {}, warn() {}, error() {} },
    audit: (e) => {
      audit.push(e);
    },
    secret: () => "test-token",
    raw: () => undefined,
    dataFile: (name) => join(dir, name),
    submit: async (ev) => {
      submits.push(ev);
      return { accepted: true, id: "x", state: "delivered", agent: "detective_tesla" };
    },
  } as unknown as AdapterContext;
  return { ctx, audit };
}

test("dashcam: flag off → inert (no client call, no notify of saved)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: unknown[] = [];
  const { ctx } = mockCtx(dir, submits);
  let calls = 0;
  const rt = new DashcamAutosaveRuntime(
    {
      enabled: true,
      api_base: "https://fleet-api.prd.na.vn.cloud.tesla.com",
      token_ref: "file:/run/secrets/token",
      key_ref: "file:/run/secrets/key.pem",
    },
    ctx,
    {
      now: () => T0,
      envFlag: () => false,
      client: {
        async dashcamSaveClip() {
          calls++;
          return { ok: true, unverified: true };
        },
      },
    },
  );
  rt.start();
  assert.equal(rt.active(), false);
  await rt.onOwnershipEvents(CAR_A, [
    ev({ event_type: "collision_or_safety", dedupe_key: "collision_or_safety:alert:Crash|t:start", data: { kind: "alert", name: "Crash", active: true, started_at: "2026-10-27T12:00:00Z" } }),
  ]);
  assert.equal(calls, 0);
  assert.equal(submits.length, 0);
  await rt.stop();
});

test("dashcam: flag on → trigger, save, notify detective route; dedupe second time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: Array<{ match: Record<string, string>; metadata?: Record<string, unknown>; prompt: string }> = [];
  const { ctx, audit } = mockCtx(dir, submits);
  let calls = 0;
  const rt = new DashcamAutosaveRuntime(
    {
      enabled: true,
      api_base: "https://fleet-api.prd.na.vn.cloud.tesla.com",
      token_ref: "file:/run/secrets/token",
      key_ref: "file:/run/secrets/key.pem",
      cooldown_s: DEFAULT_COOLDOWN_S,
      global_max_per_hour: 10,
    },
    ctx,
    {
      now: () => T0,
      envFlag: () => true,
      client: {
        async dashcamSaveClip(vin: string) {
          calls++;
          assert.equal(vin, CAR_A);
          return { ok: true, unverified: true };
        },
      },
    },
  );
  rt.start();
  assert.equal(rt.active(), true);
  const event = ev({
    event_type: "collision_or_safety",
    dedupe_key: "collision_or_safety:alert:Crash|t:start",
    data: { kind: "alert", name: "Crash", active: true, started_at: "2026-10-27T12:00:00Z" },
  });
  await rt.onOwnershipEvents(CAR_A, [event]);
  assert.equal(calls, 1);
  const kinds = submits.map((s) => (s.metadata as { event?: string })?.event);
  assert.deepEqual(kinds, ["trigger", "saved"]);
  assert.ok(submits.every((s) => s.match.kind === "dashcam_autosave"));
  assert.ok(submits.every((s) => /EXPERIMENTAL/.test(s.prompt)));
  assert.ok(audit.some((a) => (a as { reason?: string }).reason === "dashcam_autosave_saved"));

  // Same alert again → deduped, no second save.
  await rt.onOwnershipEvents(CAR_A, [event]);
  assert.equal(calls, 1);
  assert.ok(submits.some((s) => (s.metadata as { event?: string }).event === "deduped"));

  // State file persisted (mode 600 where supported).
  const raw = JSON.parse(readFileSync(join(dir, "dashcam-autosave-state.json"), "utf8"));
  assert.equal(raw.version, 1);
  assert.ok(Object.keys(raw.alertKeys).length >= 1);
  await rt.stop();
});

test("dashcam: failure path notifies failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: Array<{ metadata?: Record<string, unknown> }> = [];
  const { ctx } = mockCtx(dir, submits);
  const rt = new DashcamAutosaveRuntime(
    { enabled: true, api_base: "https://fleet-api.prd.na.vn.cloud.tesla.com", token_ref: "file:/x", key_ref: "file:/y" },
    ctx,
    {
      now: () => T0,
      envFlag: () => true,
      client: {
        async dashcamSaveClip() {
          return { ok: false, reason: "message_fault_9", fault: 9, unverified: true };
        },
      },
    },
  );
  rt.start();
  await rt.onOwnershipEvents(CAR_A, [
    ev({
      event_type: "collision_or_safety",
      dedupe_key: "collision_or_safety:alert:AEB|t:start",
      data: { kind: "alert", name: "AEB_ACTIVE", active: true, started_at: "2026-10-27T12:00:01Z" },
    }),
  ]);
  assert.ok(submits.some((s) => (s.metadata as { event?: string }).event === "failed"));
  await rt.stop();
});

test("dashcam: cooldown suppresses a different alert within window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: Array<{ metadata?: Record<string, unknown> }> = [];
  const { ctx } = mockCtx(dir, submits);
  let now = T0;
  let calls = 0;
  const rt = new DashcamAutosaveRuntime(
    { enabled: true, api_base: "https://fleet-api.prd.na.vn.cloud.tesla.com", token_ref: "file:/x", key_ref: "file:/y", cooldown_s: 600 },
    ctx,
    {
      now: () => now,
      envFlag: () => true,
      client: {
        async dashcamSaveClip() {
          calls++;
          return { ok: true, unverified: true };
        },
      },
    },
  );
  rt.start();
  await rt.onOwnershipEvents(CAR_A, [
    ev({ event_type: "collision_or_safety", dedupe_key: "k1", data: { kind: "alert", name: "Crash", active: true, started_at: "t1" } }),
  ]);
  assert.equal(calls, 1);
  now = T0 + 60_000; // still in cooldown
  await rt.onOwnershipEvents(CAR_A, [
    ev({ event_type: "collision_or_safety", dedupe_key: "k2", data: { kind: "alert", name: "Collision", active: true, started_at: "t2" } }),
  ]);
  assert.equal(calls, 1);
  assert.ok(submits.some((s) => (s.metadata as { event?: string }).event === "suppressed"));
  await rt.stop();
});

test("dashcam: global cap suppresses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  // Pre-seed state at the cap.
  writeFileSync(
    join(dir, "dashcam-autosave-state.json"),
    JSON.stringify({ version: 1, lastAttempt: {}, alertKeys: {}, globalAttempts: [T0 - 1000, T0 - 2000] }),
    { mode: 0o600 },
  );
  const submits: Array<{ metadata?: Record<string, unknown> }> = [];
  const { ctx } = mockCtx(dir, submits);
  let calls = 0;
  const rt = new DashcamAutosaveRuntime(
    { enabled: true, api_base: "https://fleet-api.prd.na.vn.cloud.tesla.com", token_ref: "file:/x", key_ref: "file:/y", global_max_per_hour: 2 },
    ctx,
    {
      now: () => T0,
      envFlag: () => true,
      client: {
        async dashcamSaveClip() {
          calls++;
          return { ok: true, unverified: true };
        },
      },
    },
  );
  rt.start();
  await rt.onOwnershipEvents(CAR_A, [
    ev({ event_type: "collision_or_safety", dedupe_key: "k3", data: { kind: "alert", name: "Crash", active: true, started_at: "t3" } }),
  ]);
  assert.equal(calls, 0);
  assert.ok(submits.some((s) => (s.metadata as { event?: string }).event === "suppressed"));
  await rt.stop();
});
