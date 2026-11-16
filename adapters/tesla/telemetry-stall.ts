import { createHash } from "node:crypto";
import type { AdapterContext } from "../../core/bridge.js";
import { maskId } from "../../core/redact.js";
import type { VinAudit } from "./audit-vin.js";
import { baseUrlProblem, EnergyApiError, FLEET_API_HOSTS, guardedGet, mapHttpError, type FetchLike, type TestHostOverride } from "./energy.js";
import { isTokenRef } from "./ownership-runtime.js";

/**
 * Telemetry stall alert (optional, off by default; route match { kind: "telemetry_stall" }).
 *
 * Per allowlisted VIN the adapter remembers when the last live telemetry message arrived. When a
 * car has been silent for silent_minutes, ONE Fleet API call lists the account's vehicles
 * (GET /api/1/vehicles: no wake, no vehicle_data) and reads each car's `state`:
 *
 *   online          -> one `telemetry_stalled` event (the car is awake but nothing arrives)
 *   asleep/offline  -> no event; audited (an asleep car streams nothing, that is normal)
 *
 * At most one `telemetry_stalled` per stall; `telemetry_resumed` follows when messages return.
 * Tesla bills each call, so no call is made while messages flow, and while silent at most one
 * call per check (for all cars together), none once every silent car has already alerted.
 */
export interface StallAlertConfig {
  enabled: boolean;
  /** Silence before the online check (default 30, 5-1440). */
  silent_minutes?: number;
  /** Minutes between checks while a car is silent (default 5, 1-60). */
  check_minutes?: number;
  /** Region Fleet API base URL (https). */
  api_base?: string;
  /** env:/file: ref to an ACCESS token (vehicle list). Re-read on every call. */
  token_ref?: string;
}

export const STALL_DEFAULT_SILENT_MIN = 30;
export const STALL_DEFAULT_CHECK_MIN = 5;
const MAX_AUTH_BACKOFF_MS = 3600_000;

export function validateStallAlert(s: StallAlertConfig | undefined, hasRoute: boolean, telemetryEnabled: boolean): string[] {
  const p: string[] = [];
  if (!s) return p;
  const at = "tesla.telemetry.stall_alert";
  if (typeof s !== "object") return [`${at} must be an object`];
  if (typeof s.enabled !== "boolean") p.push(`${at}.enabled must be true or false`);
  if (s.silent_minutes !== undefined && !(Number.isInteger(s.silent_minutes) && s.silent_minutes >= 5 && s.silent_minutes <= 1440)) p.push(`${at}.silent_minutes must be a whole number 5-1440`);
  if (s.check_minutes !== undefined && !(Number.isInteger(s.check_minutes) && s.check_minutes >= 1 && s.check_minutes <= 60)) p.push(`${at}.check_minutes must be a whole number 1-60`);
  if (s.api_base !== undefined) {
    const bad = baseUrlProblem(s.api_base, FLEET_API_HOSTS, `${at}.api_base`);
    if (bad) p.push(bad);
  }
  if (s.token_ref !== undefined && !isTokenRef(s.token_ref)) p.push(`${at}.token_ref must be env:NAME or file:/path`);
  if (s.enabled) {
    if (!s.api_base) p.push(`${at}.api_base is required when enabled`);
    if (!s.token_ref) p.push(`${at}.token_ref is required when enabled`);
    if (!hasRoute) p.push(`${at}: enabled needs a route with match { kind: "telemetry_stall" }`);
    if (!telemetryEnabled) p.push(`${at}: enabled needs tesla.telemetry enabled`);
  }
  return p;
}

/** GET /api/1/vehicles -> VIN -> state ("online", "asleep", "offline", ...). Never wakes a car. */
export async function listVehicleStates(
  fetchImpl: FetchLike,
  apiBase: string,
  token: string,
  timeoutMs = 15_000,
): Promise<Map<string, string>> {
  const url = `${apiBase.replace(/\/+$/, "")}/api/1/vehicles`;
  const { status, body, retryAfter } = await guardedGet(fetchImpl, url, { authorization: `Bearer ${token}`, accept: "application/json" }, timeoutMs);
  if (status < 200 || status >= 300) throw mapHttpError(status, body, retryAfter);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new EnergyApiError("fleet_api_error", status);
  }
  const list = (raw as { response?: unknown } | null)?.response;
  if (!Array.isArray(list)) throw new EnergyApiError("fleet_api_error", status);
  const out = new Map<string, string>();
  for (const v of list) {
    const o = v as { vin?: unknown; state?: unknown } | null;
    if (o && typeof o.vin === "string" && typeof o.state === "string") out.set(o.vin, o.state.slice(0, 32));
  }
  return out;
}

export interface StallDeps {
  now: () => number;
  fetchImpl?: FetchLike;
  /** TESTS ONLY: extra hosts the client may call. */
  testHosts?: TestHostOverride;
  auditVin: (vin: string) => VinAudit;
}

export type StallEvent = "telemetry_stalled" | "telemetry_resumed";

export class TelemetryStallRuntime {
  private readonly lastMsg = new Map<string, { at: number; since: "last_message" | "bridge_start" }>();
  /** VIN -> stall start (last message time) for cars that already alerted. */
  private readonly stalled = new Map<string, number>();
  /** Last non-online outcome audited per VIN (audit on change only, not every check). */
  private readonly lastOutcome = new Map<string, string>();
  private readonly fetchImpl: FetchLike;
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  private backoffUntil = 0;
  private authFailures = 0;
  private calls = 0;

  constructor(
    private readonly cfg: StallAlertConfig,
    private readonly vins: readonly string[],
    private readonly ctx: AdapterContext,
    private readonly deps: StallDeps,
  ) {
    const p = baseUrlProblem(cfg.api_base, FLEET_API_HOSTS, "tesla.telemetry.stall_alert.api_base", deps.testHosts);
    if (p) throw new Error(p);
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private get silentMs(): number {
    return (this.cfg.silent_minutes ?? STALL_DEFAULT_SILENT_MIN) * 60_000;
  }

  private get checkMs(): number {
    return (this.cfg.check_minutes ?? STALL_DEFAULT_CHECK_MIN) * 60_000;
  }

  start(): void {
    const now = this.deps.now();
    for (const v of this.vins) if (!this.lastMsg.has(v)) this.lastMsg.set(v, { at: now, since: "bridge_start" });
    this.timer = setInterval(() => void this.check().catch(() => this.ctx.audit({ action: "observe", outcome: "error", reason: "stall_check_failed" })), this.checkMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** A live message for an allowlisted VIN. Fires telemetry_resumed once after a stall alert. */
  async seen(vin: string): Promise<StallEvent[]> {
    this.lastMsg.set(vin, { at: this.deps.now(), since: "last_message" });
    this.lastOutcome.delete(vin);
    const since = this.stalled.get(vin);
    if (since === undefined) return [];
    this.stalled.delete(vin);
    await this.notify(vin, "telemetry_resumed", { stalled_since: new Date(since).toISOString(), silent_minutes: Math.round((this.deps.now() - since) / 60_000) });
    return ["telemetry_resumed"];
  }

  private silentVins(now: number): string[] {
    return this.vins.filter((v) => !this.stalled.has(v) && now - (this.lastMsg.get(v)?.at ?? now) >= this.silentMs);
  }

  /** One check (timer entry). At most one Fleet API call, and none unless a car is silent. */
  async check(): Promise<StallEvent[]> {
    if (this.checking) return [];
    const now = this.deps.now();
    if (!this.silentVins(now).length) return [];
    if (now < this.backoffUntil) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "stall_check_backoff" });
      return [];
    }
    this.checking = true;
    try {
      let states: Map<string, string>;
      try {
        states = await this.list();
        this.authFailures = 0;
      } catch (err) {
        this.onError(err);
        return [];
      }
      const fired: StallEvent[] = [];
      const at = this.deps.now();
      // Re-read: a message may have arrived while the call was in flight.
      for (const vin of this.silentVins(at)) {
        const state = states.get(vin);
        if (state === "online") {
          const last = this.lastMsg.get(vin)!;
          this.stalled.set(vin, last.at);
          this.lastOutcome.delete(vin);
          await this.notify(vin, "telemetry_stalled", {
            car_state: "online",
            last_message_at: new Date(last.at).toISOString(),
            since: last.since,
            silent_minutes: Math.round((at - last.at) / 60_000),
          });
          fired.push("telemetry_stalled");
          continue;
        }
        const reason = state === undefined ? "stall_vin_not_listed" : state === "asleep" || state === "offline" ? `stall_car_${state}` : "stall_car_state_unknown";
        if (this.lastOutcome.get(vin) !== reason) {
          this.lastOutcome.set(vin, reason);
          this.ctx.audit({ action: "observe", outcome: "skipped", reason, type: "telemetry_stall_check", ...this.deps.auditVin(vin) });
        }
      }
      return fired;
    } finally {
      this.checking = false;
    }
  }

  private async list(): Promise<Map<string, string>> {
    const ref = this.cfg.token_ref;
    const token = this.ctx.secret(ref);
    if (!token) throw new EnergyApiError("no_token");
    try {
      this.calls++;
      return await listVehicleStates(this.fetchImpl, this.cfg.api_base!, token);
    } catch (err) {
      // After a 401, re-read the ref once: if the plugin/host rotated the access token, retry with it.
      if (err instanceof EnergyApiError && err.code === "unauthorized") {
        const fresh = this.ctx.secret(ref);
        if (fresh && fresh !== token) {
          this.calls++;
          return await listVehicleStates(this.fetchImpl, this.cfg.api_base!, fresh);
        }
      }
      throw err;
    }
  }

  private onError(err: unknown): void {
    const e = err instanceof EnergyApiError ? err : new EnergyApiError("fleet_api_unreachable");
    this.ctx.audit({ action: "observe", outcome: "error", reason: e.code, type: "telemetry_stall_check", status: e.status });
    const now = this.deps.now();
    if (e.code === "rate_limited") this.backoffUntil = now + (e.retryAfterSec ?? 60) * 1000;
    else if (["unauthorized", "login_required", "missing_scope", "no_token"].includes(e.code)) {
      this.authFailures++;
      this.backoffUntil = now + Math.min(MAX_AUTH_BACKOFF_MS, this.checkMs * 2 ** (this.authFailures - 1));
    }
  }

  private async notify(vin: string, event: StallEvent, data: Record<string, unknown>): Promise<void> {
    const masked = maskId(vin);
    const vinLast6 = vin.slice(-6);
    const ts = new Date(this.deps.now()).toISOString();
    const key = String(data.last_message_at ?? data.stalled_since ?? ts);
    // Only the last 6 go into the hash, so the event id can't be brute-forced back to a VIN.
    const eventId = createHash("sha256").update(`telemetry_stall|${vinLast6}|${event}|${key}`).digest("hex").slice(0, 16);
    const priority = event === "telemetry_stalled" ? "high" : "normal";
    const envelope = { kind: "telemetry_stall", event_type: event, vin_last6: vinLast6, ts, priority, data };
    const head =
      event === "telemetry_stalled"
        ? `Tesla telemetry stalled for VIN …${vinLast6}: no telemetry for ${String(data.silent_minutes)} min while the car reports online (priority ${priority}) at ${ts}.`
        : `Tesla telemetry resumed for VIN …${vinLast6} after ${String(data.silent_minutes)} min (priority ${priority}) at ${ts}.`;
    const res = await this.ctx.submit({
      eventId,
      lane: `telemetry_stall:${masked}`,
      actor: vin,
      actorKeep: this.deps.auditVin(vin).actorKeep,
      match: { kind: "telemetry_stall" },
      addressed: true,
      prompt: [
        head,
        JSON.stringify(envelope),
        "This bridge sends no vehicle commands. A stall usually means the receiver, broker or the car's telemetry connection is down; check them on the host.",
        `\u27C2 s:${event}:${eventId} id=${vinLast6} kind=telemetry_stall`,
      ].join("\n"),
      metadata: { kind: "telemetry_stall", event, priority },
    });
    this.ctx.audit({
      action: "observe",
      outcome: res.accepted ? "ok" : "skipped",
      reason: res.accepted ? event : `${event}_${res.reason}`,
      type: event,
      ...this.deps.auditVin(vin),
    });
  }

  health(): Record<string, unknown> {
    return { enabled: true, cars: this.vins.length, stalled: this.stalled.size, fleet_calls: this.calls, backoff: this.deps.now() < this.backoffUntil };
  }
}
