import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DashcamAutosaveRuntime,
  DEFAULT_COOLDOWN_S,
  DEFAULT_MAX_ALERT_AGE_S,
  alertDedupeKey,
  alertTimeMs,
  envDashcamEnabled,
  isDashcamTrigger,
  isKeyRef,
  sanitizeDashcamState,
  telemetryAuthenticated,
  validateDashcamAutosave,
  type DashcamAutosaveConfig,
} from "./dashcam-autosave.js";
import { validateTeslaConfig, type TeslaConfig, type OwnershipEvent } from "./index.js";
import type { AdapterContext } from "../../core/bridge.js";
import { auditLine, type AuditEntry } from "../../core/audit.js";
import { vinAuditActor, type VinAudit } from "./audit-vin.js";
import type { DashcamCommandResult } from "./signed-command.js";

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

function freshAlert(name = "Crash", startedAt = new Date(T0).toISOString()): OwnershipEvent {
  return ev({
    event_type: "collision_or_safety",
    dedupe_key: `collision_or_safety:alert:${name}|${startedAt}:start`,
    data: { kind: "alert", name, active: true, started_at: startedAt },
  });
}

test("dashcam: env flag is exact string 1 only", () => {
  assert.equal(envDashcamEnabled({ TESLA_DASHCAM_AUTOSAVE: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(envDashcamEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(envDashcamEnabled({ TESLA_DASHCAM_AUTOSAVE: "true" } as NodeJS.ProcessEnv), false);
});

test("dashcam: trigger match — collision alert start only", () => {
  assert.equal(isDashcamTrigger(freshAlert()), true);
  assert.equal(
    isDashcamTrigger(ev({ event_type: "collision_or_safety", dedupe_key: "b", data: { kind: "aeb_setting", aeb_disabled: true } })),
    false,
  );
  assert.equal(
    isDashcamTrigger(ev({ event_type: "vehicle_alert", dedupe_key: "d", data: { kind: "alert", name: "Other" } })),
    false,
  );
});

test("dashcam: telemetryAuthenticated requires decoded token, mqtt creds, or mtls", () => {
  assert.equal(telemetryAuthenticated({ mode: "decoded" }), false);
  assert.equal(telemetryAuthenticated({ mode: "decoded", decoded_token_ref: "env:EXAMPLE_TELEMETRY_DECODED_TOKEN" }), true);
  assert.equal(telemetryAuthenticated({ mode: "mqtt", mqtt: { username_ref: "env:U" } }), false);
  assert.equal(telemetryAuthenticated({ mode: "mqtt", mqtt: { username_ref: "env:U", password_ref: "env:P" } }), true);
  assert.equal(telemetryAuthenticated({ mode: "mtls", tls_cert: "file:/a", tls_key: "file:/b", client_ca: "file:/c" }), true);
});

test("dashcam: key_ref must be absolute file:", () => {
  assert.equal(isKeyRef("file:/run/secrets/key.pem"), true);
  assert.equal(isKeyRef("file:relative.pem"), false);
  assert.equal(isKeyRef("env:KEY"), false);
});

test("dashcam: validate requires ownership + auth telemetry + route + refs when enabled", () => {
  const base: DashcamAutosaveConfig = {
    enabled: true,
    api_base: "https://fleet-api.prd.na.vn.cloud.tesla.com",
    token_ref: "file:/run/secrets/token",
    key_ref: "file:/run/secrets/key.pem",
  };
  assert.deepEqual(validateDashcamAutosave(base, [CAR_A], true, true, true), []);
  assert.ok(validateDashcamAutosave(base, [CAR_A], true, true, false).some((x) => /authenticated telemetry/.test(x)));
  assert.ok(validateDashcamAutosave(base, [CAR_A], false, true, true).some((x) => /dashcam_autosave/.test(x)));
});

test("dashcam: sanitize fails closed on bad version / bad maps", () => {
  assert.equal(sanitizeDashcamState({ version: 2 }).ok, false);
  assert.equal(sanitizeDashcamState("x").ok, false);
  assert.equal(sanitizeDashcamState({ version: 1, lastAttempt: [] }).ok, false);
  const ok = sanitizeDashcamState({ version: 1, lastAttempt: { "car-a": 1 }, alertKeys: {}, globalAttempts: [1], globalNotifies: [] });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.state.lastAttempt["car-a"], 1);
});

test("dashcam: TeslaConfig example validates", () => {
  const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as TeslaConfig;
  const problems = validateTeslaConfig(example);
  assert.deepEqual(problems.filter((p) => /dashcam|route/i.test(p)), []);
  const text = JSON.stringify(example);
  // Placeholder agent only (public-repo hygiene).
  assert.ok(/\bexample-agent\b/.test(text));
  assert.ok((example.routes ?? []).every((r) => typeof r.agent === "string" && r.agent.startsWith("example-")));
  // When CI provides LEAK_DENYLIST_FILE, none of its terms appear in the example (terms never listed here).
  const denyFile = process.env.LEAK_DENYLIST_FILE;
  if (denyFile && existsSync(denyFile)) {
    const terms = readFileSync(denyFile, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
    for (const w of terms) {
      assert.ok(!text.toLowerCase().includes(w.toLowerCase()), "example must not contain a denylist term");
    }
  }
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
      return { accepted: true, id: "x", state: "delivered", agent: "example-agent" };
    },
  } as unknown as AdapterContext;
  return { ctx, audit };
}

function runtime(
  dir: string,
  submits: unknown[],
  opts: {
    now?: () => number;
    env?: boolean;
    client?: { dashcamSaveClip(vin: string): Promise<DashcamCommandResult> };
    cfg?: Partial<DashcamAutosaveConfig>;
    auditVin?: (vin: string) => VinAudit;
  } = {},
) {
  const { ctx, audit } = mockCtx(dir, submits);
  const rt = new DashcamAutosaveRuntime(
    {
      enabled: true,
      api_base: "https://fleet-api.prd.na.vn.cloud.tesla.com",
      token_ref: "file:/run/secrets/token",
      key_ref: "file:/run/secrets/key.pem",
      cooldown_s: DEFAULT_COOLDOWN_S,
      global_max_per_hour: 10,
      max_alert_age_s: DEFAULT_MAX_ALERT_AGE_S,
      notify_max_per_hour: 30,
      ...opts.cfg,
    },
    ctx,
    {
      now: opts.now ?? (() => T0),
      envFlag: () => opts.env ?? true,
      ...(opts.auditVin ? { auditVin: opts.auditVin } : {}),
      client: opts.client ?? {
        async dashcamSaveClip() {
          return { status: "saved", unverified: true };
        },
      },
    },
  );
  return { rt, ctx, audit };
}

test("dashcam: flag off → inert", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: unknown[] = [];
  let calls = 0;
  const { rt } = runtime(dir, submits, {
    env: false,
    client: {
      async dashcamSaveClip() {
        calls++;
        return { status: "saved", unverified: true };
      },
    },
  });
  rt.start();
  assert.equal(rt.active(), false);
  await rt.onOwnershipEvents(CAR_A, [freshAlert()]);
  assert.equal(calls, 0);
  assert.equal(submits.length, 0);
  await rt.stop();
});

test("dashcam: stale alert refused and audited (no save)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: unknown[] = [];
  let calls = 0;
  const { rt, audit } = runtime(dir, submits, {
    now: () => T0,
    client: {
      async dashcamSaveClip() {
        calls++;
        return { status: "saved", unverified: true };
      },
    },
  });
  rt.start();
  const old = freshAlert("Crash", new Date(T0 - 6 * 60_000).toISOString()); // 6 min old > 5 min default
  await rt.onOwnershipEvents(CAR_A, [old]);
  assert.equal(calls, 0);
  assert.equal(submits.length, 0);
  assert.ok(audit.some((a) => (a as { reason?: string }).reason === "dashcam_autosave_stale_alert"));
  await rt.stop();
});

test("dashcam: fresh alert → trigger + saved; dedupe audits only (no second notify)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: Array<{ metadata?: Record<string, unknown> }> = [];
  let calls = 0;
  const { rt, audit } = runtime(dir, submits, {
    client: {
      async dashcamSaveClip() {
        calls++;
        return { status: "saved", unverified: true };
      },
    },
  });
  rt.start();
  assert.equal(rt.active(), true);
  const event = freshAlert();
  await rt.onOwnershipEvents(CAR_A, [event]);
  assert.equal(calls, 1);
  assert.deepEqual(submits.map((s) => (s.metadata as { event?: string }).event), ["trigger", "saved"]);
  await rt.onOwnershipEvents(CAR_A, [event]);
  assert.equal(calls, 1);
  assert.equal(submits.length, 2); // no deduped notify
  assert.ok(audit.some((a) => (a as { reason?: string }).reason === "dashcam_autosave_deduped"));
  // With audit_full_vin on (the default), audit lines record the full VIN; notify prompts and envelopes keep vin_last6 only.
  const lines = audit.map((a) => auditLine(a as AuditEntry)).filter((l) => /^dashcam_/.test(String(l.reason)) && "actor" in l);
  assert.ok(lines.length >= 4 && lines.every((l) => l.actor === CAR_A), "dashcam audit lines carry the full VIN");
  const prompts = submits.map((s) => String((s as { prompt?: string }).prompt));
  assert.equal(prompts.some((p) => p.includes(CAR_A)), false, "notify prompts never carry the full VIN");
  assert.ok(prompts.every((p) => p.includes(`VIN …${CAR_A.slice(-6)}`) && p.includes(`"vin_last6":"${CAR_A.slice(-6)}"`)), "notifies keep vin_last6");
  assert.ok(submits.every((s) => (s as { actorKeep?: unknown }).actorKeep === "full"), "the bridge's inbound audit line for a notify also records the full VIN");
  await rt.stop();
});

test("dashcam: unconfirmed outcome (empty/unsigned) is not reported as saved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: Array<{ metadata?: Record<string, unknown> }> = [];
  const { rt } = runtime(dir, submits, {
    client: {
      async dashcamSaveClip() {
        return { status: "unconfirmed", reason: "empty_response", unverified: true };
      },
    },
  });
  rt.start();
  await rt.onOwnershipEvents(CAR_A, [freshAlert("AEB_ACTIVE")]);
  assert.deepEqual(submits.map((s) => (s.metadata as { event?: string }).event), ["trigger", "unconfirmed"]);
  assert.ok(!submits.some((s) => (s.metadata as { event?: string }).event === "saved"));
  await rt.stop();
});

test("dashcam: failure path notifies failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: Array<{ metadata?: Record<string, unknown> }> = [];
  const { rt } = runtime(dir, submits, {
    client: {
      async dashcamSaveClip() {
        return { status: "failed", reason: "message_fault_9", fault: 9, unverified: true };
      },
    },
  });
  rt.start();
  await rt.onOwnershipEvents(CAR_A, [freshAlert("Collision")]);
  assert.ok(submits.some((s) => (s.metadata as { event?: string }).event === "failed"));
  await rt.stop();
});

test("dashcam: corrupt state file disarms and does not re-send the same incident", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  // First run: save once so the alert key is recorded.
  {
    const submits: unknown[] = [];
    let calls = 0;
    const { rt } = runtime(dir, submits, {
      client: {
        async dashcamSaveClip() {
          calls++;
          return { status: "saved", unverified: true };
        },
      },
    });
    rt.start();
    await rt.onOwnershipEvents(CAR_A, [freshAlert()]);
    assert.equal(calls, 1);
    await rt.stop();
  }
  // Corrupt the state file.
  writeFileSync(join(dir, "dashcam-autosave-state.json"), "{not-json", { mode: 0o600 });
  // Restart: must disarm, and must NOT send again for the same alert.
  {
    const submits: unknown[] = [];
    let calls = 0;
    const { rt, audit } = runtime(dir, submits, {
      client: {
        async dashcamSaveClip() {
          calls++;
          return { status: "saved", unverified: true };
        },
      },
    });
    rt.start();
    assert.equal(rt.active(), false);
    assert.ok(audit.some((a) => (a as { reason?: string }).reason === "dashcam_autosave_state_corrupt"));
    await rt.onOwnershipEvents(CAR_A, [freshAlert()]);
    assert.equal(calls, 0);
    assert.equal(submits.length, 0);
    await rt.stop();
  }
});

test("dashcam: 200 distinct alerts produce a bounded number of notifies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: unknown[] = [];
  let now = T0;
  let calls = 0;
  const { rt } = runtime(dir, submits, {
    now: () => now,
    cfg: {
      cooldown_s: 1, // test-only: keep the whole burst inside one rolling hour
      global_max_per_hour: 100,
      notify_max_per_hour: 20,
      max_alert_age_s: 3600,
    },
    client: {
      async dashcamSaveClip() {
        calls++;
        return { status: "saved", unverified: true };
      },
    },
  });
  rt.start();
  for (let i = 0; i < 200; i++) {
    now = T0 + i * 2_000; // 400s total << 1 hour; past 1s cooldown
    const started = new Date(now - 500).toISOString();
    await rt.onOwnershipEvents(CAR_A, [freshAlert(`Alert_${i}`, started)]);
  }
  // trigger+outcome per incident, but the rolling notify cap hard-stops at 20.
  assert.ok(submits.length <= 20, `notifies ${submits.length} should be <= 20`);
  assert.ok(calls >= 10, `expected saves to continue after notify cap; got ${calls}`);
  assert.ok(submits.length < 200);
  await rt.stop();
});

test("dashcam: cooldown and in_flight are audited without notify", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: Array<{ metadata?: Record<string, unknown> }> = [];
  let now = T0;
  let unblock!: () => void;
  const hold = new Promise<void>((r) => {
    unblock = r;
  });
  let inCommand = false;
  const { rt, audit } = runtime(dir, submits, {
    now: () => now,
    client: {
      async dashcamSaveClip() {
        inCommand = true;
        await hold;
        inCommand = false;
        return { status: "saved", unverified: true };
      },
    },
  });
  rt.start();
  const first = rt.onOwnershipEvents(CAR_A, [freshAlert("A", new Date(T0).toISOString())]);
  for (let i = 0; i < 100 && !inCommand; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(inCommand, true);
  await rt.onOwnershipEvents(CAR_A, [freshAlert("B", new Date(T0 + 1000).toISOString())]);
  assert.ok(audit.some((a) => (a as { reason?: string }).reason === "dashcam_autosave_in_flight"));
  unblock();
  await first;
  assert.ok(!submits.some((s) => ["deduped", "suppressed"].includes(String((s.metadata as { event?: string }).event))));
  now = T0 + 30_000;
  await rt.onOwnershipEvents(CAR_A, [freshAlert("C", new Date(now).toISOString())]);
  assert.ok(audit.some((a) => (a as { reason?: string }).reason === "dashcam_autosave_cooldown"));
  await rt.stop();
});

test("dashcam: dedupe key with spaces in the alert name survives state sanitize", () => {
  const e = freshAlert("Front Crash Sensor", new Date(T0).toISOString());
  const key = alertDedupeKey(e);
  assert.ok(!/\s/.test(key), "encoded key must not contain raw spaces");
  const round = sanitizeDashcamState({ version: 1, lastAttempt: {}, alertKeys: { [key]: T0 }, globalAttempts: [], globalNotifies: [] });
  assert.equal(round.ok, true);
  if (round.ok) {
    assert.equal(round.state.alertKeys[key], T0);
    assert.equal(round.dropped, 0);
  }
});

test("dashcam: alertTimeMs prefers started_at", () => {
  const e = freshAlert("X", "2026-10-27T11:59:00.000Z");
  assert.equal(alertTimeMs(e), Date.parse("2026-10-27T11:59:00.000Z"));
  assert.ok(alertDedupeKey(e).startsWith("car-a|"));
  assert.notEqual(alertDedupeKey(e), alertDedupeKey(freshAlert("Y", "2026-10-27T11:59:00.000Z")));
});

test("dashcam: audit follows the adapter's audit_full_vin policy (false: last 6); notifies keep vin_last6 either way", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dashcam-"));
  const submits: Array<{ prompt?: string; actorKeep?: unknown }> = [];
  const { rt, audit } = runtime(dir, submits, { auditVin: (v) => vinAuditActor(v, true, false) });
  rt.start();
  await rt.onOwnershipEvents(CAR_A, [freshAlert()]);
  const lines = audit.map((a) => auditLine(a as AuditEntry)).filter((l) => /^dashcam_/.test(String(l.reason)) && "actor" in l);
  assert.ok(lines.length >= 3 && lines.every((l) => l.actor === `…${CAR_A.slice(-6)}`), "audit_full_vin=false: last 6");
  assert.ok(submits.length === 2 && submits.every((s) => s.actorKeep === 6));
  assert.ok(submits.every((s) => String(s.prompt).includes(`VIN …${CAR_A.slice(-6)}`) && !String(s.prompt).includes(CAR_A)));
  await rt.stop();
});
