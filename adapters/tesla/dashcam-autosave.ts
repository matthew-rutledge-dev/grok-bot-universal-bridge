/**
 * EXPERIMENTAL dashcam auto-save.
 *
 * When a crash/collision or emergency-braking telemetry alert is classified as
 * collision_or_safety (same heuristics as ownership events), optionally send
 * DashcamSaveClipAction (community CarServer field 47) through SignedCommandClient.
 *
 * Master switch: process.env.TESLA_DASHCAM_AUTOSAVE must be exactly "1". Any other
 * value (unset, empty, "true", "yes") leaves the feature completely inert.
 * Config alone cannot enable it. Off by default. Live car commands still need the
 * owner's explicit yes for the first live test; this module never fires without
 * the env flag, and unit tests never touch a real car.
 *
 * Ownership still emits the collision_or_safety event on the ownership route (one
 * message). This module separately notifies the dashcam_autosave route with at most
 * trigger + one outcome per incident (saved / failed / unconfirmed). Deduped and
 * suppressed cases are audited only — no second notify flood.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, win32 } from "node:path";
import type { AdapterContext } from "../../core/bridge.js";
import { isTokenRef } from "./ownership-runtime.js";
import type { OwnershipEvent } from "./ownership.js";
import {
  SignedCommandClient,
  loadPrivateKeyFromRef,
  type DashcamCommandResult,
  type SignedCommandFetch,
} from "./signed-command.js";
import { baseUrlProblem, FLEET_API_HOSTS, type TestHostOverride } from "./energy.js";

export const DASHCAM_ENV = "TESLA_DASHCAM_AUTOSAVE";
export const DEFAULT_COOLDOWN_S = 600;
export const DEFAULT_GLOBAL_MAX_PER_HOUR = 10;
export const DEFAULT_MAX_ALERT_AGE_S = 300;
export const DEFAULT_NOTIFY_MAX_PER_HOUR = 30;
export const ALERT_KEY_TTL_MS = 7 * 86400_000;

/** Notify kinds that go to the dashcam_autosave route (never deduped/suppressed). */
export type DashcamNotifyKind = "trigger" | "saved" | "failed" | "unconfirmed";

export interface DashcamAutosaveConfig {
  /**
   * Documentation / host intent. Even when true, the env flag must be "1" or the
   * feature stays off. Default false.
   */
  enabled?: boolean;
  /** Always treated as experimental; kept in config for operators. */
  experimental?: boolean;
  api_base?: string;
  /** env:/file: ref to an ACCESS token with vehicle_cmds (and the signed_command path). */
  token_ref?: string;
  /** file:/absolute/path to the paired NIST-P256 private key PEM. Never commit the key. */
  key_ref?: string;
  /** Per-car cooldown after a save attempt (default 600 s). */
  cooldown_s?: number;
  /** Global save-attempt cap across all cars per rolling hour (default 10). */
  global_max_per_hour?: number;
  /**
   * Refuse alerts whose started_at (else event ts) is older than this many seconds
   * relative to wall clock (default 300). Stops retained / replayed alerts from
   * triggering a save days later.
   */
  max_alert_age_s?: number;
  /** Global notify cap (trigger+outcome messages) per rolling hour (default 30). */
  notify_max_per_hour?: number;
}

export interface DashcamStateFile {
  version: 1;
  /** vehicle_id -> last attempt ms */
  lastAttempt: Record<string, number>;
  /** alert dedupe keys already acted on (key -> ms) */
  alertKeys: Record<string, number>;
  /** global attempt timestamps (ms), pruned to the last hour */
  globalAttempts: number[];
  /** global notify timestamps (ms), pruned to the last hour */
  globalNotifies: number[];
}

export interface DashcamDeps {
  now: () => number;
  fetchImpl?: SignedCommandFetch;
  testHosts?: TestHostOverride;
  /** Injected client for tests (skips key load + real HTTP). */
  client?: { dashcamSaveClip(vin: string): Promise<DashcamCommandResult> };
  /** Override env read (tests). */
  envFlag?: () => boolean;
  /** TESTS ONLY: skip the key/api_base load path when injecting a client. */
  skipKeyLoad?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fin = (v: unknown) => typeof v === "number" && Number.isFinite(v);

export function envDashcamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DASHCAM_ENV] === "1";
}

export function isKeyRef(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  if (/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(ref)) return false;
  if (!ref.startsWith("file:") || ref.length <= 5) return false;
  const f = ref.slice(5);
  return isAbsolute(f) || posix.isAbsolute(f) || win32.isAbsolute(f);
}

/**
 * True when telemetry is configured with an authenticated source: decoded bearer,
 * MQTT username+password refs, or mTLS PEMs. Unauthenticated decoded (no token) or
 * MQTT without creds is refused when dashcam is enabled.
 */
export function telemetryAuthenticated(t: {
  mode?: "decoded" | "mqtt" | "mtls";
  decoded_token_ref?: string;
  mqtt?: { username_ref?: string; password_ref?: string };
  tls_cert?: string;
  tls_key?: string;
  client_ca?: string;
} | undefined): boolean {
  if (!t) return false;
  const mode = t.mode ?? "decoded";
  if (mode === "mtls") return Boolean(t.tls_cert && t.tls_key && t.client_ca);
  if (mode === "mqtt") return Boolean(t.mqtt?.username_ref && t.mqtt?.password_ref);
  return Boolean(t.decoded_token_ref);
}

export function validateDashcamAutosave(
  c: DashcamAutosaveConfig | undefined,
  vinAllowlist: string[],
  hasNotifyRoute: boolean,
  ownershipEnabled: boolean,
  telemetryAuth: boolean,
): string[] {
  const p: string[] = [];
  if (!c) return p;
  const at = "tesla.dashcam_autosave";
  if (c.enabled !== undefined && typeof c.enabled !== "boolean") p.push(`${at}.enabled must be true or false`);
  if (c.api_base !== undefined) {
    const bad = baseUrlProblem(c.api_base, FLEET_API_HOSTS, `${at}.api_base`);
    if (bad) p.push(bad);
  }
  if (c.token_ref !== undefined && !isTokenRef(c.token_ref)) p.push(`${at}.token_ref must be env:NAME or file:/path`);
  if (c.key_ref !== undefined && !isKeyRef(c.key_ref)) p.push(`${at}.key_ref must be file:/absolute/path`);
  if (c.cooldown_s !== undefined && !(Number.isFinite(c.cooldown_s) && c.cooldown_s >= 60 && c.cooldown_s <= 86400)) {
    p.push(`${at}.cooldown_s must be 60-86400`);
  }
  if (c.global_max_per_hour !== undefined && !(Number.isInteger(c.global_max_per_hour) && c.global_max_per_hour >= 1 && c.global_max_per_hour <= 100)) {
    p.push(`${at}.global_max_per_hour must be 1-100`);
  }
  if (c.max_alert_age_s !== undefined && !(Number.isFinite(c.max_alert_age_s) && c.max_alert_age_s >= 30 && c.max_alert_age_s <= 3600)) {
    p.push(`${at}.max_alert_age_s must be 30-3600`);
  }
  if (c.notify_max_per_hour !== undefined && !(Number.isInteger(c.notify_max_per_hour) && c.notify_max_per_hour >= 2 && c.notify_max_per_hour <= 200)) {
    p.push(`${at}.notify_max_per_hour must be 2-200`);
  }
  if (c.enabled) {
    if (!ownershipEnabled) p.push(`${at}: enabled needs tesla.ownership.enabled (triggers reuse ownership alert classification)`);
    if (!telemetryAuth) {
      p.push(`${at}: enabled needs an authenticated telemetry source (decoded_token_ref, mqtt username_ref+password_ref, or mtls PEMs)`);
    }
    if (!c.api_base) p.push(`${at}.api_base is required when enabled`);
    if (!c.token_ref) p.push(`${at}.token_ref is required when enabled`);
    if (!c.key_ref) p.push(`${at}.key_ref is required when enabled`);
    if (!hasNotifyRoute) p.push(`${at}: enabled needs a route with match { kind: "dashcam_autosave" }`);
    if (!vinAllowlist.length) p.push(`${at}: enabled needs tesla.telemetry.vin_allowlist`);
  }
  return p;
}

/**
 * Shape-check a persisted state file. On structural failure returns ok:false (caller
 * must disarm). Dropped unknown fields alone still ok:true with the cleaned state.
 * A missing file is handled by the caller (not this function).
 */
export function sanitizeDashcamState(raw: unknown): { ok: true; state: DashcamStateFile; dropped: number } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: "not_object" };
  if (raw.version !== 1) return { ok: false, reason: "bad_version" };
  const state: DashcamStateFile = { version: 1, lastAttempt: {}, alertKeys: {}, globalAttempts: [], globalNotifies: [] };
  let dropped = 0;
  for (const [mapKey, dest] of [
    ["lastAttempt", state.lastAttempt],
    ["alertKeys", state.alertKeys],
  ] as const) {
    const src = raw[mapKey];
    if (src === undefined) continue;
    if (!isObj(src)) return { ok: false, reason: `bad_${mapKey}` };
    for (const [k, v] of Object.entries(src)) {
      if (/^[A-Za-z0-9_.:|-]{1,200}$/.test(k) && fin(v)) dest[k] = v as number;
      else dropped++;
    }
  }
  for (const listKey of ["globalAttempts", "globalNotifies"] as const) {
    const src = raw[listKey];
    if (src === undefined) continue;
    if (!Array.isArray(src)) return { ok: false, reason: `bad_${listKey}` };
    const ok = src.filter((x): x is number => fin(x)).slice(-500);
    dropped += src.length - ok.length;
    state[listKey] = ok;
  }
  // Reject unknown top-level keys beyond the schema (fail closed on surprise shapes).
  for (const k of Object.keys(raw)) {
    if (!["version", "lastAttempt", "alertKeys", "globalAttempts", "globalNotifies"].includes(k)) dropped++;
  }
  return { ok: true, state, dropped };
}

/** True when this ownership event should try to save a dashcam clip (ignores freshness). */
export function isDashcamTrigger(e: OwnershipEvent): boolean {
  if (e.event_type !== "collision_or_safety") return false;
  if (e.tier !== "immediate") return false;
  if (e.data?.kind !== "alert") return false;
  if (e.data?.active === false) return false;
  return true;
}

/** Alert wall-clock time: started_at when parseable, else event ts. */
export function alertTimeMs(e: OwnershipEvent): number | undefined {
  const started = typeof e.data.started_at === "string" ? Date.parse(e.data.started_at) : NaN;
  if (!Number.isNaN(started)) return started;
  const ts = Date.parse(e.ts);
  return Number.isNaN(ts) ? undefined : ts;
}

export function alertDedupeKey(e: OwnershipEvent): string {
  const name = typeof e.data.name === "string" ? e.data.name : "unknown";
  const started = typeof e.data.started_at === "string" ? e.data.started_at : e.ts;
  // base64url so spaces / odd chars in alert names survive the state-file key charset.
  const enc = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  return `${e.vehicle_id}|${enc(name)}|${enc(started)}`;
}

export class DashcamAutosaveRuntime {
  private state: DashcamStateFile = { version: 1, lastAttempt: {}, alertKeys: {}, globalAttempts: [], globalNotifies: [] };
  private file = "";
  private dirty = false;
  private client?: SignedCommandClient | DashcamDeps["client"];
  /** Env + config.enabled intent. */
  private readonly wantEnabled: boolean;
  /** Armed only after state load + key load succeed. */
  private armed = false;
  private disarmedReason?: string;
  private busy = new Set<string>();

  constructor(
    private readonly cfg: DashcamAutosaveConfig,
    private readonly ctx: AdapterContext,
    private readonly deps: DashcamDeps,
  ) {
    const flag = deps.envFlag ? deps.envFlag() : envDashcamEnabled();
    this.wantEnabled = Boolean(flag && cfg.enabled);
  }

  /** Whether the runtime will send commands / notifies. */
  active(): boolean {
    return this.armed;
  }

  start(): void {
    this.file = this.ctx.dataFile?.("dashcam-autosave-state.json") ?? "";
    if (!this.wantEnabled) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "dashcam_autosave_off" });
      return;
    }
    if (!this.loadOrDisarm()) return;

    if (this.deps.client) {
      this.client = this.deps.client;
      this.armed = true;
      this.ctx.audit({ action: "observe", outcome: "ok", reason: "dashcam_autosave_experimental_armed" });
      return;
    }
    if (!this.cfg.api_base) {
      this.disarm("dashcam_autosave_missing_api_base");
      return;
    }
    if (!this.cfg.key_ref) {
      this.disarm("dashcam_autosave_key_load_failed");
      return;
    }
    try {
      const key = loadPrivateKeyFromRef(this.cfg.key_ref);
      this.client = new SignedCommandClient({
        apiBase: this.cfg.api_base,
        getToken: () => this.ctx.secret(this.cfg.token_ref),
        clientKey: key,
        fetchImpl: this.deps.fetchImpl,
        testHosts: this.deps.testHosts,
        now: this.deps.now,
      });
      this.armed = true;
      this.ctx.audit({ action: "observe", outcome: "ok", reason: "dashcam_autosave_experimental_armed" });
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
          ? (err as { code: string }).code
          : "dashcam_autosave_key_load_failed";
      this.disarm(code.startsWith("dashcam_") || code.startsWith("key_") ? code : "dashcam_autosave_key_load_failed");
    }
  }

  async stop(): Promise<void> {
    if (this.armed) this.save(true);
  }

  /**
   * Called after ownership emits events for a VIN. Only immediate collision_or_safety
   * alert starts within max_alert_age_s are considered. Never throws into the telemetry path.
   */
  async onOwnershipEvents(vin: string, events: OwnershipEvent[]): Promise<void> {
    if (!this.armed) return;
    try {
      for (const e of events) {
        if (!isDashcamTrigger(e)) continue;
        await this.handle(vin, e);
      }
    } catch {
      this.ctx.audit({ action: "observe", outcome: "error", reason: "dashcam_autosave_handler_failed", actor: vin, actorKeep: 6 });
    }
  }

  private disarm(reason: string): void {
    this.armed = false;
    this.client = undefined;
    this.disarmedReason = reason;
    this.ctx.audit({ action: "observe", outcome: "error", reason });
  }

  private async handle(vin: string, e: OwnershipEvent): Promise<void> {
    const now = this.deps.now();
    this.pruneAlertKeys(now);
    const key = alertDedupeKey(e);
    const cooldownMs = (this.cfg.cooldown_s ?? DEFAULT_COOLDOWN_S) * 1000;
    const globalMax = this.cfg.global_max_per_hour ?? DEFAULT_GLOBAL_MAX_PER_HOUR;
    const maxAgeMs = (this.cfg.max_alert_age_s ?? DEFAULT_MAX_ALERT_AGE_S) * 1000;

    const at = alertTimeMs(e);
    if (at === undefined || now - at > maxAgeMs || at - now > 60_000) {
      this.ctx.audit({
        action: "observe",
        outcome: "skipped",
        reason: "dashcam_autosave_stale_alert",
        actor: vin,
        actorKeep: 6,
        type: key.slice(0, 80),
        ...(at !== undefined ? { ms: now - at } : {}),
      });
      return;
    }

    if (this.state.alertKeys[key] !== undefined) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "dashcam_autosave_deduped", actor: vin, actorKeep: 6, type: key.slice(0, 80) });
      return;
    }
    if (this.busy.has(e.vehicle_id)) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "dashcam_autosave_in_flight", actor: vin, actorKeep: 6 });
      return;
    }
    const last = this.state.lastAttempt[e.vehicle_id] ?? 0;
    if (now - last < cooldownMs) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "dashcam_autosave_cooldown", actor: vin, actorKeep: 6 });
      return;
    }
    this.state.globalAttempts = this.state.globalAttempts.filter((t) => now - t < 3600_000);
    if (this.state.globalAttempts.length >= globalMax) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "dashcam_autosave_global_cap", actor: vin, actorKeep: 6 });
      return;
    }

    // Persist dedupe BEFORE the command so a crash mid-flight cannot re-send. If the
    // save fails, disarm and do not send.
    this.busy.add(e.vehicle_id);
    this.state.alertKeys[key] = now;
    this.state.lastAttempt[e.vehicle_id] = now;
    this.state.globalAttempts.push(now);
    this.dirty = true;
    if (!this.save(true)) {
      this.busy.delete(e.vehicle_id);
      this.disarm("dashcam_autosave_state_write_failed");
      return;
    }

    // Trigger notify (counts toward notify cap). If the cap is hit, still attempt the
    // save (the car command is the point) but skip notifies.
    const canNotify = this.reserveNotify(now);
    if (canNotify) await this.notify(vin, e, "trigger", { alert_key: key });

    this.ctx.audit({ action: "observe", outcome: "ok", reason: "dashcam_autosave_attempt", actor: vin, actorKeep: 6 });

    try {
      if (!this.client) {
        if (canNotify && this.reserveNotify(this.deps.now())) {
          await this.notify(vin, e, "failed", { reason: "no_client", alert_key: key });
        }
        this.ctx.audit({ action: "observe", outcome: "error", reason: "dashcam_autosave_no_client", actor: vin, actorKeep: 6 });
        return;
      }
      const result = await this.client.dashcamSaveClip(vin);
      const outcome: DashcamNotifyKind =
        result.status === "saved" ? "saved" : result.status === "unconfirmed" ? "unconfirmed" : "failed";
      this.ctx.audit({
        action: "observe",
        outcome: outcome === "saved" ? "ok" : "error",
        reason: `dashcam_autosave_${outcome}`,
        actor: vin,
        actorKeep: 6,
        type: (result.reason ?? outcome).slice(0, 80),
      });
      if (canNotify && this.reserveNotify(this.deps.now())) {
        await this.notify(vin, e, outcome, {
          alert_key: key,
          reason: result.reason,
          fault: result.fault,
          unverified: true,
        });
      }
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "dashcam_autosave_error";
      this.ctx.audit({ action: "observe", outcome: "error", reason: code.slice(0, 80), actor: vin, actorKeep: 6 });
      if (canNotify && this.reserveNotify(this.deps.now())) {
        await this.notify(vin, e, "failed", { alert_key: key, reason: code });
      }
    } finally {
      this.busy.delete(e.vehicle_id);
    }
  }

  /** Reserve one notify slot in the rolling hour. Returns false when capped (audit only). */
  private reserveNotify(now: number): boolean {
    const max = this.cfg.notify_max_per_hour ?? DEFAULT_NOTIFY_MAX_PER_HOUR;
    this.state.globalNotifies = this.state.globalNotifies.filter((t) => now - t < 3600_000);
    if (this.state.globalNotifies.length >= max) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "dashcam_autosave_notify_cap" });
      return false;
    }
    this.state.globalNotifies.push(now);
    this.dirty = true;
    this.save(true);
    return true;
  }

  private async notify(vin: string, e: OwnershipEvent, kind: DashcamNotifyKind, data: Record<string, unknown>): Promise<void> {
    const eventId = createHash("sha256").update(`dashcam|${e.vehicle_id}|${kind}|${String(data.alert_key ?? e.dedupe_key)}`).digest("hex").slice(0, 16);
    const envelope = {
      experimental: true,
      kind: "dashcam_autosave",
      event: kind,
      vehicle_id: e.vehicle_id,
      vin_last6: e.vin_last6,
      model: e.model,
      ts: new Date(this.deps.now()).toISOString(),
      source_event_type: e.event_type,
      source_dedupe_key: e.dedupe_key,
      data,
      note: "EXPERIMENTAL. DashcamSaveClipAction (community field 47) is unverified until a live test. This bridge event is a notify only; no clip bytes are transferred. Ownership still sends the collision_or_safety event on its own route.",
    };
    const res = await this.ctx.submit({
      eventId,
      lane: `dashcam_autosave:${e.vehicle_id}`,
      actor: vin,
      actorKeep: 6,
      match: { kind: "dashcam_autosave" },
      addressed: true,
      prompt: [
        `EXPERIMENTAL Tesla dashcam auto-save (${kind}) for ${e.vehicle_id} (VIN …${e.vin_last6}) at ${envelope.ts}.`,
        JSON.stringify(envelope),
        `\u27C2 o:dashcam_autosave:${kind}:${eventId} id=${e.vehicle_id} kind=dashcam_autosave`,
      ].join("\n"),
      metadata: { kind: "dashcam_autosave", event: kind, priority: "high", experimental: true },
    });
    this.ctx.audit({
      action: "observe",
      outcome: res.accepted ? "ok" : "skipped",
      reason: res.accepted ? `dashcam_notify_${kind}` : `dashcam_notify_${res.reason}`,
      actor: vin,
      actorKeep: 6,
      type: kind,
    });
  }

  private pruneAlertKeys(now: number): void {
    for (const [k, at] of Object.entries(this.state.alertKeys)) {
      if (now - at > ALERT_KEY_TTL_MS) delete this.state.alertKeys[k];
    }
  }

  /** Load state. Missing file → empty OK. Unreadable / corrupt / bad shape → disarm. */
  private loadOrDisarm(): boolean {
    if (!this.file) {
      // No data dir: in-memory only (tests). Treat as empty OK.
      return true;
    }
    let rawText: string;
    try {
      rawText = readFileSync(this.file, "utf8");
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
      if (code === "ENOENT") return true; // first run
      this.disarm("dashcam_autosave_state_unreadable");
      return false;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawText) as unknown;
    } catch {
      this.disarm("dashcam_autosave_state_corrupt");
      return false;
    }
    const cleaned = sanitizeDashcamState(raw);
    if (!cleaned.ok) {
      this.disarm("dashcam_autosave_state_malformed");
      return false;
    }
    this.state = cleaned.state;
    if (cleaned.dropped) {
      // Unknown fields dropped but structure OK — keep going, note it.
      this.ctx.audit({ action: "observe", outcome: "ok", reason: "dashcam_state_unknown_fields_dropped", count: cleaned.dropped });
    }
    return true;
  }

  /** Atomic write. Returns false on failure (caller must not send). */
  private save(force: boolean): boolean {
    if (!this.file) {
      this.dirty = false;
      return true; // in-memory (tests)
    }
    if (!this.dirty && !force) return true;
    if (!force && !this.dirty) return true;
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
      this.dirty = false;
      return true;
    } catch {
      this.ctx.audit({ action: "observe", outcome: "error", reason: "dashcam_autosave_state_write_failed" });
      return false;
    }
  }

  health(): Record<string, unknown> {
    return {
      experimental: true,
      armed: this.armed,
      disarmedReason: this.disarmedReason,
      client: Boolean(this.client),
      alertKeys: Object.keys(this.state.alertKeys).length,
      globalAttemptsLastHour: this.state.globalAttempts.length,
      globalNotifiesLastHour: this.state.globalNotifies.length,
    };
  }
}

/** Re-export for tests that poke the state file path convention. */
export function dashcamStatePathExists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
