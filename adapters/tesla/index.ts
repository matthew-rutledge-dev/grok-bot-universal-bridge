import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateRoutes } from "../../core/allowlist.js";
import type { AdapterContext, SourceAdapter } from "../../core/bridge.js";
import { maskId } from "../../core/redact.js";
import { isSecretRef } from "../../core/secrets.js";
import type { Route } from "../../core/types.js";
import {
  deriveEnergyTriggers,
  EnergyApiError,
  FleetEnergyClient,
  gridOutage,
  hasEnergyData,
  unintentionalOutage,
  type EnergyStatus,
  type EnergyStatusSource,
  type EnergyTrigger,
  type FetchLike,
} from "./energy.js";
import { deriveVehicleTriggers, KNOWN_FIELDS, mergeState, REPLACED_FIELDS, type TelemetryRecord, type TelemetryValue, type TriggerHit, type VehicleTrigger } from "./fields.js";
import { DecodedJsonReceiver, isLoopbackHost, MtlsTelemetryReceiver, splitListen, type DropReason, type TelemetryReceiver } from "./receiver.js";

export * from "./fields.js";
export * from "./energy.js";
export * from "./receiver.js";

/**
 * Tesla source adapter.
 *
 * Split with the Tesla plugin:
 *   bridge (here): telemetry receiver (decoded JSON from fleet-telemetry, or mTLS), energy
 *                  live_status polling, filter + debounce, wake rules, VIN/site allowlists,
 *                  hold-retry, audit.
 *   plugin:        OAuth and token refresh, Fleet API client, read + command tools, safety
 *                  (read-only fail-closed, confirm, dry-run, state_unknown), proxy client.
 *
 * Hard rules enforced here:
 *   - The bridge NEVER sends vehicle commands (config with commands is refused).
 *   - Never poll vehicle_data or wake a car. Vehicles are push-only via telemetry.
 *   - Energy uses an ACCESS token only (energy_device_data). Refresh tokens are refused.
 *   - Replies go back through the agent's origin channel; there is no /tesla/callback.
 *   - Prompts and audit carry a masked VIN / site id only.
 */

export type TeslaTrigger = VehicleTrigger | EnergyTrigger;

export const VEHICLE_TRIGGERS: VehicleTrigger[] = [
  "charge_complete", "charge_stopped", "plugged_in", "unplugged", "door_open_parked",
  "trunk_open_parked", "sentry_alert", "low_battery", "update_available",
];
export const ENERGY_TRIGGERS: EnergyTrigger[] = ["grid_islanded", "battery_below_reserve", "storm_watch"];

export interface TeslaRule {
  on: TeslaTrigger;
  wake: boolean;
  debounce_s?: number;
  priority?: "low" | "normal" | "high";
}

export interface TeslaConfig {
  telemetry?: {
    enabled: boolean;
    /** "decoded" (default): loopback JSON from Tesla's fleet-telemetry server. "mtls": the bridge terminates mTLS. */
    mode?: "decoded" | "mtls";
    /** decoded mode: loopback host:port for POST /records. */
    decoded_listen?: string;
    /** decoded mode: optional bearer for the loopback listener. */
    decoded_token_ref?: string;
    /** mtls mode. */
    listen?: string;
    public_hostname?: string;
    tls_cert?: string;
    tls_key?: string;
    /** Tesla vehicle CA (client certs are verified against it). */
    client_ca?: string;
    vin_allowlist: string[];
    /** Must stay true: the vehicle config is pushed with prefer_typed so enums/structs arrive typed. */
    prefer_typed?: boolean;
    /** Field -> minimum interval seconds requested in fleet_telemetry_config (pushed by the plugin). */
    fields?: Record<string, number>;
    low_battery_percent?: number;
  };
  energy_poll?: {
    enabled: boolean;
    interval_s?: number;
    site_allowlist: string[];
    /** Region Fleet API base URL (https). */
    api_base?: string;
    /** env:/file: ref to an ACCESS token (scope energy_device_data). Re-read every poll. */
    token_ref?: string;
    reserve_margin_percent?: number;
    /** site_info (backup_reserve_percent) cache, seconds. Default 600. */
    site_info_ttl_s?: number;
  };
  rules: TeslaRule[];
  reply?: { via: "origin_channel" };
  routes: Route[];
}

const FORBIDDEN_KEYS = /^(commands?|command_tools|vehicle_commands|actions?)$/i;
const REFRESH_KEYS = /refresh_?token/i;
const PEM_KEYS = ["tls_cert", "tls_key", "client_ca"] as const;

export function validateTeslaConfig(raw: unknown): string[] {
  const c = raw as Partial<TeslaConfig> | null;
  if (!c || typeof c !== "object") return ["tesla: config is not an object"];
  const p = validateRoutes(c.routes, "tesla");
  const walk = (o: unknown, path: string) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (FORBIDDEN_KEYS.test(k)) p.push(`tesla: ${path}${k} refused: the bridge never sends vehicle commands`);
      if (REFRESH_KEYS.test(k)) p.push(`tesla: ${path}${k} refused: give the bridge an access token only (refresh tokens rotate and are single-use; the plugin owns refresh)`);
      if (typeof v === "string" && /vehicle_data/i.test(v)) p.push(`tesla: ${path}${k} refused: never poll vehicle_data`);
      if (typeof v === "string" && /\/wake_up\b|\/command\//i.test(v)) p.push(`tesla: ${path}${k} refused: the bridge never wakes cars or sends commands`);
      walk(v, `${path}${k}.`);
    }
  };
  walk(c, "");
  if (c.reply && c.reply.via !== "origin_channel") p.push("tesla: reply.via must be origin_channel");
  if (!Array.isArray(c.rules)) p.push("tesla: rules must be an array");
  for (const [i, r] of (c.rules ?? []).entries()) {
    if (![...VEHICLE_TRIGGERS, ...ENERGY_TRIGGERS].includes(r.on)) p.push(`tesla.rules[${i}]: unknown trigger ${String(r.on)}`);
    if (typeof r.wake !== "boolean") p.push(`tesla.rules[${i}]: wake must be true or false`);
  }
  const t = c.telemetry;
  if (t) {
    if (!Array.isArray(t.vin_allowlist)) p.push("tesla.telemetry.vin_allowlist must be an array");
    for (const v of t.vin_allowlist ?? []) if (typeof v !== "string" || !/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) p.push("tesla.telemetry.vin_allowlist entries must be 17-character VINs");
    if (t.prefer_typed === false) p.push("tesla.telemetry.prefer_typed must be true (enums and DoorState are parsed as typed values)");
    const doorRules = (c.rules ?? []).filter((r) => (r.on === "door_open_parked" || r.on === "trunk_open_parked") && r.wake).map((r) => r.on);
    if (doorRules.length && t.fields && !("Gear" in t.fields)) {
      p.push(`tesla.telemetry.fields must include Gear when ${doorRules.join("/")} wakes (without Gear the car counts as parked)`);
    }
    if (doorRules.length && t.fields && !("DoorState" in t.fields)) p.push(`tesla.telemetry.fields must include DoorState when ${doorRules.join("/")} wakes`);
    for (const f of Object.keys(t.fields ?? {})) {
      if (REPLACED_FIELDS[f]) p.push(`tesla.telemetry.fields.${f}: not a usable field; use ${REPLACED_FIELDS[f]}`);
      else if (!(KNOWN_FIELDS as readonly string[]).includes(f)) p.push(`tesla.telemetry.fields.${f}: not read by the trigger logic (known: ${KNOWN_FIELDS.join(", ")})`);
    }
    const mode = t.mode ?? "decoded";
    if (mode !== "decoded" && mode !== "mtls") p.push('tesla.telemetry.mode must be "decoded" or "mtls"');
    for (const k of PEM_KEYS) {
      const v = t[k];
      if (v !== undefined && !isSecretRef(v)) p.push(`tesla.telemetry.${k} must be file:/path or env:NAME`);
    }
    if (t.decoded_token_ref !== undefined && !isSecretRef(t.decoded_token_ref)) p.push("tesla.telemetry.decoded_token_ref must be env:NAME or file:/path");
    if (t.enabled && mode === "mtls") {
      for (const k of [...PEM_KEYS, "listen"] as const) if (!t[k]) p.push(`tesla.telemetry.${k} is required in mtls mode`);
    }
    if (mode === "decoded" && t.decoded_listen !== undefined) {
      try {
        if (!isLoopbackHost(splitListen(t.decoded_listen).host)) p.push("tesla.telemetry.decoded_listen must be a loopback address");
      } catch {
        p.push("tesla.telemetry.decoded_listen must be host:port");
      }
    }
    if (t.enabled && mode === "decoded" && !t.decoded_listen) p.push("tesla.telemetry.decoded_listen is required in decoded mode");
  }
  const e = c.energy_poll;
  if (e) {
    if (!Array.isArray(e.site_allowlist)) p.push("tesla.energy_poll.site_allowlist must be an array");
    if (e.token_ref !== undefined && !isSecretRef(e.token_ref)) {
      p.push("tesla.energy_poll.token_ref must be env:NAME or file:/path (the host renders the access token into one of these)");
    }
    if (e.interval_s !== undefined && e.interval_s < 60) p.push("tesla.energy_poll.interval_s must be >= 60");
    if (e.site_info_ttl_s !== undefined && e.site_info_ttl_s < 60) p.push("tesla.energy_poll.site_info_ttl_s must be >= 60");
    if (e.api_base !== undefined && !/^https:\/\/[^/]+/.test(e.api_base)) p.push("tesla.energy_poll.api_base must be an https URL");
    if (e.enabled && !e.api_base) p.push("tesla.energy_poll.api_base is required when enabled");
    if (e.enabled && !e.token_ref) p.push("tesla.energy_poll.token_ref is required when enabled");
  }
  for (const [i, r] of (c.routes ?? []).entries()) {
    const keys = Object.keys(r.match ?? {});
    if (keys.length !== 1 || keys[0] !== "kind" || !["vehicle", "energy"].includes(String(r.match.kind))) {
      p.push(`tesla.routes[${i}]: match must be { kind: "vehicle" } or { kind: "energy" }`);
    }
  }
  return p;
}

/** Per key debounce: a trigger fires again only after debounce_s. */
export class Debouncer {
  private readonly last = new Map<string, number>();
  allow(key: string, debounceS: number, now = Date.now()): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < debounceS * 1000) return false;
    this.last.set(key, now);
    return true;
  }
}

export interface TeslaDeps {
  receiver?: TelemetryReceiver;
  energy?: EnergyStatusSource;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Poll energy once right at start (default true). */
  pollOnStart?: boolean;
  /** decoded listener request timeout (default 10 s). */
  decodedRequestTimeoutMs?: number;
}

const MAX_AUTH_BACKOFF_S = 3600;

export class TeslaAdapter implements SourceAdapter {
  readonly name = "tesla";
  readonly routes: Route[];
  /** No callback: replies go through the agent's origin channel. */
  readonly callbackTokenRef = undefined;
  private ctx!: AdapterContext;
  private readonly lastVehicle = new Map<string, Record<string, TelemetryValue>>();
  private readonly lastCreatedAt = new Map<string, number>();
  private readonly lastEnergy = new Map<string, EnergyStatus>();
  private readonly reserveCache = new Map<string, { value: number | undefined; at: number }>();
  private readonly debounce = new Debouncer();
  private timer: ReturnType<typeof setInterval> | undefined;
  private receiver?: TelemetryReceiver;
  private energy?: EnergyStatusSource;
  private polling = false;
  private skipUntil = 0;
  private skipReason = "";
  private authFailures = 0;
  private lastTokenUsed: string | undefined;
  private readonly now: () => number;

  constructor(
    private readonly cfg: TeslaConfig,
    private readonly deps: TeslaDeps = {},
  ) {
    const problems = validateTeslaConfig(cfg);
    if (problems.length) throw new Error(problems.join("; "));
    this.routes = cfg.routes;
    this.now = deps.now ?? Date.now;
  }

  init(ctx: AdapterContext): void {
    this.ctx = ctx;
  }

  /** PEM from a ref: file: is read whole (multi-line), env: may use literal \n. */
  private pem(ref: string): string {
    const r = ref.trim();
    const v = r.startsWith("file:") ? readFileSync(r.slice(5), "utf8") : (this.ctx.raw(r) ?? "").replace(/\\n/g, "\n");
    if (!v.includes("-----BEGIN")) throw new Error(`tesla: ${r.startsWith("file:") ? "file" : r} does not hold a PEM block`);
    return v;
  }

  /** Access token, re-read from its ref on every call. */
  private token(): string | undefined {
    const v = this.ctx.secret(this.cfg.energy_poll?.token_ref);
    this.lastTokenUsed = v;
    return v;
  }

  async start(): Promise<void> {
    const t = this.cfg.telemetry;
    if (t?.enabled) {
      this.receiver =
        this.deps.receiver ??
        ((t.mode ?? "decoded") === "mtls"
          ? new MtlsTelemetryReceiver({ listen: t.listen!, cert: this.pem(t.tls_cert!), key: this.pem(t.tls_key!), clientCa: this.pem(t.client_ca!) })
          : this.decodedReceiver(t));
      await this.receiver.start({
        record: (r) =>
          void this.ingestTelemetry(r).catch(() => this.ctx.audit({ action: "inbound", outcome: "error", reason: "ingest_failed", actor: r.vin })),
        drop: (reason, vin) => this.dropped(reason, vin),
      });
    }
    const e = this.cfg.energy_poll;
    if (e?.enabled) {
      this.energy = this.deps.energy ?? new FleetEnergyClient({ apiBase: e.api_base!, getToken: () => this.token(), fetchImpl: this.deps.fetchImpl });
      const every = Math.max(60, e.interval_s ?? 300) * 1000;
      this.timer = setInterval(() => this.safeTick(), every);
      this.timer.unref?.();
      if (this.deps.pollOnStart !== false) this.safeTick();
    }
    this.ctx.log.info(`[tesla] started telemetry=${t?.enabled ? (t.mode ?? "decoded") : "off"} energy=${Boolean(e?.enabled)}`);
  }

  private decodedReceiver(t: NonNullable<TeslaConfig["telemetry"]>): DecodedJsonReceiver {
    const ref = t.decoded_token_ref;
    if (ref && !this.ctx.secret(ref)) {
      throw new Error(`tesla: telemetry.decoded_token_ref is set but does not resolve (${ref.startsWith("file:") ? "file" : ref})`);
    }
    return new DecodedJsonReceiver({
      listen: t.decoded_listen!,
      token: ref ? () => this.ctx.secret(ref) : undefined,
      requestTimeoutMs: this.deps.decodedRequestTimeoutMs,
    });
  }

  /** Timer/start entry: never lets a rejection escape. */
  private safeTick(): void {
    this.tick().catch(() => {
      this.ctx.audit({ action: "observe", outcome: "error", reason: "poll_failed" });
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.receiver?.stop().catch(() => undefined);
  }

  /** Bound telemetry port (tests / ops). */
  telemetryPort(): number {
    return this.receiver?.port?.() ?? 0;
  }

  vinAllowed(vin: string): boolean {
    return (this.cfg.telemetry?.vin_allowlist ?? []).includes(vin);
  }

  siteAllowed(site: string): boolean {
    return (this.cfg.energy_poll?.site_allowlist ?? []).includes(site);
  }

  private dropped(reason: DropReason, vin?: string): void {
    this.ctx.audit({ action: "inbound", outcome: "deny", reason, actor: vin });
  }

  /** Feed one decoded telemetry record (called by the receiver). Returns triggers submitted. */
  async ingestTelemetry(r: TelemetryRecord): Promise<TeslaTrigger[]> {
    if (!this.vinAllowed(r.vin)) {
      this.ctx.audit({ action: "inbound", outcome: "deny", reason: "vin_not_allowlisted", actor: r.vin });
      return [];
    }
    if (r.isResend) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "resend", actor: r.vin });
      return [];
    }
    const at = Date.parse(r.createdAt);
    const last = this.lastCreatedAt.get(r.vin);
    if (!Number.isNaN(at) && last !== undefined && at < last) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "stale_record", actor: r.vin });
      return [];
    }
    if (!Number.isNaN(at)) this.lastCreatedAt.set(r.vin, at);
    const prev = this.lastVehicle.get(r.vin);
    const { next, delta } = mergeState(prev, r.data);
    this.lastVehicle.set(r.vin, next);
    const hits = deriveVehicleTriggers(prev, delta, { lowBatteryPercent: this.cfg.telemetry?.low_battery_percent });
    return this.fire("vehicle", r.vin, hits, r.createdAt || new Date(this.now()).toISOString());
  }

  /** Timer entry: skip when a poll is still running or while backing off. */
  async tick(): Promise<TeslaTrigger[]> {
    if (this.polling) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "poll_in_progress" });
      return [];
    }
    if (this.now() < this.skipUntil) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: `backoff_${this.skipReason}` });
      return [];
    }
    this.polling = true;
    try {
      return await this.pollEnergyOnce();
    } finally {
      this.polling = false;
    }
  }

  private backoff(reason: string, sec: number): void {
    this.skipReason = reason;
    this.skipUntil = this.now() + sec * 1000;
  }

  /** Map an energy error to an audit line and back-off. Returns true when the poll round must stop. */
  private onEnergyError(err: unknown, site: string, what: "live_status" | "site_info"): boolean {
    const e = err instanceof EnergyApiError ? err : new EnergyApiError("fleet_api_unreachable");
    this.ctx.audit({ action: "observe", outcome: "error", reason: e.code, type: what, actor: site, status: e.status });
    const interval = Math.max(60, this.cfg.energy_poll?.interval_s ?? 300);
    if (e.code === "rate_limited") {
      this.backoff("rate_limited", e.retryAfterSec ?? 60);
      return true;
    }
    if (e.code === "unauthorized" || e.code === "login_required" || e.code === "missing_scope" || e.code === "no_token") {
      this.authFailures++;
      this.backoff(e.code, Math.min(MAX_AUTH_BACKOFF_S, interval * 2 ** (this.authFailures - 1)));
      return true;
    }
    return false;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // After a 401, re-read the token ref once: if the plugin/host rotated the access token, retry with it.
      if (err instanceof EnergyApiError && err.code === "unauthorized") {
        const used = this.lastTokenUsed;
        const fresh = this.ctx.secret(this.cfg.energy_poll?.token_ref);
        if (fresh && fresh !== used) return await fn();
      }
      throw err;
    }
  }

  private async reserve(site: string): Promise<{ value: number | undefined; stop: boolean }> {
    const src = this.energy!;
    const cached = this.reserveCache.get(site);
    const ttl = Math.max(60, this.cfg.energy_poll?.site_info_ttl_s ?? 600) * 1000;
    if (!src.backupReserve || (cached && this.now() - cached.at < ttl)) return { value: cached?.value, stop: false };
    try {
      const value = await this.call(() => src.backupReserve!(site));
      this.reserveCache.set(site, { value: value ?? cached?.value, at: this.now() });
      return { value: value ?? cached?.value, stop: false };
    } catch (err) {
      return { value: cached?.value, stop: this.onEnergyError(err, site, "site_info") };
    }
  }

  /** One energy poll across the allowlisted sites. */
  async pollEnergyOnce(): Promise<TeslaTrigger[]> {
    const fired: TeslaTrigger[] = [];
    if (!this.energy) return fired;
    for (const site of this.cfg.energy_poll?.site_allowlist ?? []) {
      let s: EnergyStatus;
      try {
        s = await this.call(() => this.energy!.liveStatus(site));
      } catch (err) {
        if (this.onEnergyError(err, site, "live_status")) break;
        continue;
      }
      this.authFailures = 0;
      if (s.backupReservePercent === undefined) {
        const r = await this.reserve(site);
        if (r.value !== undefined) s = { ...s, backupReservePercent: r.value };
        fired.push(...(await this.ingestEnergy(s)));
        if (r.stop) break;
      } else {
        fired.push(...(await this.ingestEnergy(s)));
      }
    }
    return fired;
  }

  async ingestEnergy(s: EnergyStatus): Promise<TeslaTrigger[]> {
    if (!this.siteAllowed(s.siteId)) {
      this.ctx.audit({ action: "inbound", outcome: "deny", reason: "site_not_allowlisted", actor: s.siteId });
      return [];
    }
    if (!hasEnergyData(s)) {
      // Keep the last good status: overwriting it with a gap would re-arm grid_islanded.
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "no_data", actor: s.siteId });
      return [];
    }
    const prev = this.lastEnergy.get(s.siteId);
    const merged: EnergyStatus = { ...s };
    this.lastEnergy.set(s.siteId, merged);
    const hits = deriveEnergyTriggers(prev, merged, this.cfg.energy_poll?.reserve_margin_percent).map((on) => ({ on }));
    const detail = gridOutage(merged) ? (unintentionalOutage(merged) ? "unintentional outage" : "intentional off-grid") : undefined;
    return this.fire("energy", s.siteId, hits, new Date(this.now()).toISOString(), detail);
  }

  private async fire(kind: "vehicle" | "energy", id: string, hits: TriggerHit<TeslaTrigger>[], at: string, detail?: string): Promise<TeslaTrigger[]> {
    const fired: TeslaTrigger[] = [];
    for (const h of hits) {
      const t = h.on;
      const rule = this.cfg.rules.find((r) => r.on === t);
      if (!rule) continue;
      const priority = h.priority ?? rule.priority ?? "normal";
      if (!this.debounce.allow(`${id}:${t}:${h.priority ?? ""}`, rule.debounce_s ?? 0, this.now())) {
        this.ctx.audit({ action: "observe", outcome: "skipped", reason: "debounced", type: t, actor: id });
        continue;
      }
      if (!rule.wake) {
        this.ctx.audit({ action: "observe", outcome: "ok", reason: "no_wake_rule", type: t, actor: id });
        continue;
      }
      const masked = maskId(id);
      // Only the masked id goes into the hash, so the event id can't be brute-forced back to a VIN.
      const eventId = createHash("sha256").update(`${kind}|${masked}|${t}|${priority}|${at}`).digest("hex").slice(0, 16);
      const extra = t === "grid_islanded" && detail ? ` (${detail})` : "";
      const res = await this.ctx.submit({
        eventId,
        lane: `${kind}:${masked}`,
        actor: id,
        match: { kind },
        addressed: true,
        prompt: [
          `Tesla ${kind} ${masked}: ${t}${extra} (priority ${priority}) at ${at}.`,
          "Reply through your origin channel. This bridge sends no vehicle commands; use the Tesla plugin's confirm-gated tools if an action is needed.",
          `\u27C2 t:${t}:${eventId} id=${masked} kind=${kind}`,
        ].join("\n"),
        metadata: { trigger: t, kind, priority },
      });
      if (res.accepted) fired.push(t);
    }
    return fired;
  }
}

export function createTeslaAdapter(cfg: TeslaConfig, deps?: TeslaDeps): TeslaAdapter {
  return new TeslaAdapter(cfg, deps);
}
