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
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, win32 } from "node:path";
import type { AdapterContext } from "../../core/bridge.js";
import { isTokenRef } from "./ownership-runtime.js";
import type { OwnershipEvent } from "./ownership.js";
import {
  SignedCommandClient,
  loadPrivateKeyFromRef,
  type SignedCommandFetch,
} from "./signed-command.js";
import { baseUrlProblem, FLEET_API_HOSTS, type TestHostOverride } from "./energy.js";

export const DASHCAM_ENV = "TESLA_DASHCAM_AUTOSAVE";
export const DEFAULT_COOLDOWN_S = 600;
export const DEFAULT_GLOBAL_MAX_PER_HOUR = 10;
export const DEFAULT_NOTIFY_AGENT = "detective_tesla";

export type DashcamEventKind = "trigger" | "saved" | "failed" | "deduped" | "suppressed";

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
  /** Global cap across all cars per rolling hour (default 10). */
  global_max_per_hour?: number;
  /** Registry alias for immediate notify (default detective_tesla). */
  notify_agent?: string;
}

export interface DashcamStateFile {
  version: 1;
  /** vehicle_id -> last attempt ms */
  lastAttempt: Record<string, number>;
  /** alert dedupe keys already acted on (key -> ms) */
  alertKeys: Record<string, number>;
  /** global attempt timestamps (ms), pruned to the last hour */
  globalAttempts: number[];
}

export interface DashcamDeps {
  now: () => number;
  fetchImpl?: SignedCommandFetch;
  testHosts?: TestHostOverride;
  /** Injected client for tests (skips key load + real HTTP). */
  client?: { dashcamSaveClip(vin: string): Promise<{ ok: boolean; reason?: string; fault?: number; unverified: true }> };
  /** Override env read (tests). */
  envFlag?: () => boolean;
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

export function validateDashcamAutosave(
  c: DashcamAutosaveConfig | undefined,
  vinAllowlist: string[],
  hasNotifyRoute: boolean,
  ownershipEnabled: boolean,
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
  if (c.notify_agent !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(c.notify_agent)) {
    p.push(`${at}.notify_agent must be a lowercase registry alias`);
  }
  // When host intends to enable (config.enabled), require the rest; env is checked at runtime.
  if (c.enabled) {
    if (!ownershipEnabled) p.push(`${at}: enabled needs tesla.ownership.enabled (triggers reuse ownership alert classification)`);
    if (!c.api_base) p.push(`${at}.api_base is required when enabled`);
    if (!c.token_ref) p.push(`${at}.token_ref is required when enabled`);
    if (!c.key_ref) p.push(`${at}.key_ref is required when enabled`);
    if (!hasNotifyRoute) p.push(`${at}: enabled needs a route with match { kind: "dashcam_autosave" }`);
    if (!vinAllowlist.length) p.push(`${at}: enabled needs tesla.telemetry.vin_allowlist`);
  }
  return p;
}

export function sanitizeDashcamState(raw: unknown): { state: DashcamStateFile; dropped: number } {
  const state: DashcamStateFile = { version: 1, lastAttempt: {}, alertKeys: {}, globalAttempts: [] };
  let dropped = 0;
  if (!isObj(raw)) return { state, dropped: raw === undefined ? 0 : 1 };
  if (raw.version !== 1) dropped++;
  for (const [mapKey, dest] of [["lastAttempt", state.lastAttempt], ["alertKeys", state.alertKeys]] as const) {
    const src = raw[mapKey];
    if (src === undefined) continue;
    if (!isObj(src)) {
      dropped++;
      continue;
    }
    for (const [k, v] of Object.entries(src)) {
      if (/^[A-Za-z0-9_.:|-]{1,200}$/.test(k) && fin(v)) dest[k] = v as number;
      else dropped++;
    }
  }
  if (raw.globalAttempts !== undefined) {
    if (!Array.isArray(raw.globalAttempts)) dropped++;
    else {
      state.globalAttempts = raw.globalAttempts.filter((x): x is number => fin(x)).slice(-500);
      dropped += raw.globalAttempts.length - state.globalAttempts.length;
    }
  }
  return { state, dropped };
}

/** True when this ownership event should try to save a dashcam clip. */
export function isDashcamTrigger(e: OwnershipEvent): boolean {
  if (e.event_type !== "collision_or_safety") return false;
  if (e.tier !== "immediate") return false;
  if (e.data?.kind !== "alert") return false; // skip aeb_setting
  if (e.data?.active === false) return false; // end of alert
  return true;
}

function alertDedupeKey(e: OwnershipEvent): string {
  const name = typeof e.data.name === "string" ? e.data.name : "unknown";
  const started = typeof e.data.started_at === "string" ? e.data.started_at : e.ts;
  return `${e.vehicle_id}|${name}|${started}`;
}

export class DashcamAutosaveRuntime {
  private state: DashcamStateFile = { version: 1, lastAttempt: {}, alertKeys: {}, globalAttempts: [] };
  private file = "";
  private dirty = false;
  private client?: SignedCommandClient | DashcamDeps["client"];
  private readonly enabled: boolean;
  private busy = new Set<string>();

  constructor(
    private readonly cfg: DashcamAutosaveConfig,
    private readonly ctx: AdapterContext,
    private readonly deps: DashcamDeps,
  ) {
    const flag = deps.envFlag ? deps.envFlag() : envDashcamEnabled();
    this.enabled = Boolean(flag && cfg.enabled);
  }

  /** Whether the runtime will act (env + config.enabled). */
  active(): boolean {
    return this.enabled;
  }

  start(): void {
    this.file = this.ctx.dataFile?.("dashcam-autosave-state.json") ?? "";
    this.load();
    if (!this.enabled) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "dashcam_autosave_off" });
      return;
    }
    if (this.deps.client) {
      this.client = this.deps.client;
    } else {
      try {
        const key = loadPrivateKeyFromRef(this.cfg.key_ref!);
        this.client = new SignedCommandClient({
          apiBase: this.cfg.api_base!,
          getToken: () => this.ctx.secret(this.cfg.token_ref),
          clientKey: key,
          fetchImpl: this.deps.fetchImpl,
          testHosts: this.deps.testHosts,
          now: this.deps.now,
        });
      } catch {
        this.ctx.audit({ action: "observe", outcome: "error", reason: "dashcam_autosave_key_load_failed" });
        // Leave client undefined: attempts will fail closed and notify.
      }
    }
    this.ctx.audit({
      action: "observe",
      outcome: "ok",
      reason: "dashcam_autosave_experimental_armed",
      // No VIN, no token. experimental flag is the point of this line.
    });
  }

  async stop(): Promise<void> {
    this.save(true);
  }

  /**
   * Called after ownership emits events for a VIN. Only immediate collision_or_safety
   * alert starts are considered. Never throws into the telemetry path.
   */
  async onOwnershipEvents(vin: string, events: OwnershipEvent[]): Promise<void> {
    if (!this.enabled) return;
    try {
      for (const e of events) {
        if (!isDashcamTrigger(e)) continue;
        await this.handle(vin, e);
      }
    } catch {
      this.ctx.audit({ action: "observe", outcome: "error", reason: "dashcam_autosave_handler_failed", actor: vin, actorKeep: 6 });
    }
  }

  private async handle(vin: string, e: OwnershipEvent): Promise<void> {
    const now = this.deps.now();
    const key = alertDedupeKey(e);
    const cooldownMs = (this.cfg.cooldown_s ?? DEFAULT_COOLDOWN_S) * 1000;
    const globalMax = this.cfg.global_max_per_hour ?? DEFAULT_GLOBAL_MAX_PER_HOUR;

    await this.notify(vin, e, "trigger", { alert_key: key });

    if (this.state.alertKeys[key] !== undefined) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "dashcam_autosave_deduped", actor: vin, actorKeep: 6, type: key.slice(0, 80) });
      await this.notify(vin, e, "deduped", { alert_key: key });
      return;
    }
    const last = this.state.lastAttempt[e.vehicle_id] ?? 0;
    if (now - last < cooldownMs) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "dashcam_autosave_cooldown", actor: vin, actorKeep: 6 });
      await this.notify(vin, e, "suppressed", { reason: "cooldown", alert_key: key });
      return;
    }
    this.state.globalAttempts = this.state.globalAttempts.filter((t) => now - t < 3600_000);
    if (this.state.globalAttempts.length >= globalMax) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "dashcam_autosave_global_cap", actor: vin, actorKeep: 6 });
      await this.notify(vin, e, "suppressed", { reason: "global_cap", alert_key: key });
      return;
    }
    if (this.busy.has(e.vehicle_id)) {
      await this.notify(vin, e, "suppressed", { reason: "in_flight", alert_key: key });
      return;
    }

    this.busy.add(e.vehicle_id);
    this.state.alertKeys[key] = now;
    this.state.lastAttempt[e.vehicle_id] = now;
    this.state.globalAttempts.push(now);
    this.dirty = true;
    this.save(true);

    this.ctx.audit({ action: "observe", outcome: "ok", reason: "dashcam_autosave_attempt", actor: vin, actorKeep: 6 });

    try {
      if (!this.client) {
        await this.notify(vin, e, "failed", { reason: "no_client", alert_key: key });
        this.ctx.audit({ action: "observe", outcome: "error", reason: "dashcam_autosave_no_client", actor: vin, actorKeep: 6 });
        return;
      }
      const result = await this.client.dashcamSaveClip(vin);
      if (result.ok) {
        this.ctx.audit({ action: "observe", outcome: "ok", reason: "dashcam_autosave_saved", actor: vin, actorKeep: 6 });
        await this.notify(vin, e, "saved", { alert_key: key, unverified: true });
      } else {
        this.ctx.audit({
          action: "observe",
          outcome: "error",
          reason: "dashcam_autosave_failed",
          actor: vin,
          actorKeep: 6,
          type: (result.reason ?? `fault_${result.fault ?? "?"}`).slice(0, 80),
        });
        await this.notify(vin, e, "failed", { alert_key: key, reason: result.reason, fault: result.fault, unverified: true });
      }
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "dashcam_autosave_error";
      this.ctx.audit({ action: "observe", outcome: "error", reason: code.slice(0, 80), actor: vin, actorKeep: 6 });
      await this.notify(vin, e, "failed", { alert_key: key, reason: code });
    } finally {
      this.busy.delete(e.vehicle_id);
    }
  }

  private async notify(vin: string, e: OwnershipEvent, kind: DashcamEventKind, data: Record<string, unknown>): Promise<void> {
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
      note: "EXPERIMENTAL. DashcamSaveClipAction (community field 47) is unverified until a live test. This bridge event is a notify only; no clip bytes are transferred.",
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

  private load(): void {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      const { state, dropped } = sanitizeDashcamState(raw);
      this.state = state;
      if (dropped) this.ctx.audit({ action: "observe", outcome: "error", reason: "dashcam_state_malformed_dropped", count: dropped });
    } catch {
      /* missing or unreadable: start empty */
    }
  }

  private save(force: boolean): void {
    if (!this.file || !this.dirty) return;
    if (!force) return;
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      this.ctx.audit({ action: "observe", outcome: "error", reason: "dashcam_state_write_failed" });
    }
  }

  health(): Record<string, unknown> {
    return {
      experimental: true,
      armed: this.enabled,
      client: Boolean(this.client),
      alertKeys: Object.keys(this.state.alertKeys).length,
      globalAttemptsLastHour: this.state.globalAttempts.length,
    };
  }
}
