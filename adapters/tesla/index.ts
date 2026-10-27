import { createHash } from "node:crypto";
import { validateRoutes } from "../../core/allowlist.js";
import type { AdapterContext, SourceAdapter } from "../../core/bridge.js";
import { maskId } from "../../core/redact.js";
import { isSecretRef } from "../../core/secrets.js";
import type { Route } from "../../core/types.js";

/**
 * Tesla source adapter: SKELETON (not wired to a live receiver yet).
 *
 * Split with the Tesla plugin:
 *   bridge (here): Fleet Telemetry receiver (mTLS), energy live_status polling,
 *                  filter + debounce, wake rules, VIN/site allowlists, hold-retry, audit.
 *   plugin:        OAuth/refresh, Fleet API client, read + command tools, safety
 *                  (read-only fail-closed, confirm, dry-run, state_unknown), proxy client.
 *
 * Hard rules enforced here:
 *   - The bridge NEVER sends vehicle commands (config with commands is refused).
 *   - Never poll vehicle_data (it wakes the car). Vehicles are push-only via telemetry.
 *   - Replies go back through the agent's origin channel; there is no /tesla/callback.
 *   - Audit: event type, masked VIN, timestamp. Nothing else about the car.
 *
 * What is still a stub: the mTLS telemetry server and the energy HTTP client.
 * Both are interfaces (TelemetryReceiver, EnergyStatusSource) injected at
 * construction; without them, enabling telemetry or polling fails at start.
 */

export type VehicleTrigger =
  | "charge_complete"
  | "charge_stopped"
  | "plugged_in"
  | "unplugged"
  | "door_open_parked"
  | "trunk_open_parked"
  | "sentry_alert"
  | "low_battery"
  | "update_available";

export type EnergyTrigger = "grid_islanded" | "battery_below_reserve" | "storm_watch";
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
    listen?: string;
    public_hostname?: string;
    tls_cert?: string;
    tls_key?: string;
    client_ca?: string;
    vin_allowlist: string[];
    /** Field -> minimum interval seconds requested in fleet_telemetry_config. */
    fields?: Record<string, number>;
    low_battery_percent?: number;
  };
  energy_poll?: {
    enabled: boolean;
    interval_s?: number;
    site_allowlist: string[];
    token_ref?: string;
    reserve_margin_percent?: number;
  };
  rules: TeslaRule[];
  reply?: { via: "origin_channel" };
  routes: Route[];
}

/** One decoded Fleet Telemetry record (field names per Tesla's schema; confirm with the plugin author). */
export interface TelemetryRecord {
  vin: string;
  createdAt: string;
  data: Record<string, string | number | boolean | null>;
}

export interface EnergyStatus {
  siteId: string;
  gridStatus?: string;
  percentCharged?: number;
  backupReservePercent?: number;
  stormModeActive?: boolean;
}

/** mTLS Fleet Telemetry server. Implemented later; the skeleton only defines the seam. */
export interface TelemetryReceiver {
  start(onRecord: (r: TelemetryRecord) => void): Promise<void>;
  stop(): Promise<void>;
}

/** Energy live_status reader (site endpoint only, never vehicle_data). */
export interface EnergyStatusSource {
  liveStatus(siteId: string): Promise<EnergyStatus>;
}

const FORBIDDEN_KEYS = /^(commands?|command_tools|vehicle_commands|actions?)$/i;

export function validateTeslaConfig(raw: unknown): string[] {
  const c = raw as Partial<TeslaConfig> | null;
  if (!c || typeof c !== "object") return ["tesla: config is not an object"];
  const p = validateRoutes(c.routes, "tesla");
  const walk = (o: unknown, path: string) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (FORBIDDEN_KEYS.test(k)) p.push(`tesla: ${path}${k} refused: the bridge never sends vehicle commands`);
      if (typeof v === "string" && /vehicle_data/i.test(v)) p.push(`tesla: ${path}${k} refused: never poll vehicle_data`);
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
  if (c.telemetry && !Array.isArray(c.telemetry.vin_allowlist)) p.push("tesla.telemetry.vin_allowlist must be an array");
  if (c.energy_poll && !Array.isArray(c.energy_poll.site_allowlist)) p.push("tesla.energy_poll.site_allowlist must be an array");
  for (const k of ["tls_cert", "tls_key", "client_ca"] as const) {
    const v = c.telemetry?.[k];
    if (v !== undefined && !isSecretRef(v)) p.push(`tesla.telemetry.${k} must be file:/path or env:NAME`);
  }
  if (c.energy_poll?.token_ref !== undefined && !isSecretRef(c.energy_poll.token_ref)) {
    p.push("tesla.energy_poll.token_ref must be env:NAME or file:/path (the host renders vault values into one of these)");
  }
  if (c.energy_poll?.interval_s !== undefined && c.energy_poll.interval_s < 60) p.push("tesla.energy_poll.interval_s must be >= 60");
  for (const [i, r] of (c.routes ?? []).entries()) {
    const keys = Object.keys(r.match ?? {});
    if (keys.length !== 1 || keys[0] !== "kind" || !["vehicle", "energy"].includes(String(r.match.kind))) {
      p.push(`tesla.routes[${i}]: match must be { kind: "vehicle" } or { kind: "energy" }`);
    }
  }
  return p;
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** Turn a change between two telemetry snapshots into triggers. Field names need confirmation. */
export function deriveVehicleTriggers(
  prev: TelemetryRecord["data"] | undefined,
  next: TelemetryRecord["data"],
  opts: { lowBatteryPercent?: number } = {},
): VehicleTrigger[] {
  const p = prev ?? {};
  const out: VehicleTrigger[] = [];
  const changed = (k: string) => k in next && str(next[k]) !== str(p[k]);
  const parked = str(next.Gear ?? p.Gear) === "P" || str(next.Gear ?? p.Gear) === "";
  if (changed("ChargeState")) {
    const v = str(next.ChargeState);
    if (v === "Complete") out.push("charge_complete");
    if (v === "Stopped") out.push("charge_stopped");
  }
  if (changed("ChargeCableConnected")) out.push(next.ChargeCableConnected === true || str(next.ChargeCableConnected) === "true" ? "plugged_in" : "unplugged");
  if (changed("DoorState") && /open/i.test(str(next.DoorState)) && parked) out.push("door_open_parked");
  if (changed("TrunkOpen") && (next.TrunkOpen === true || str(next.TrunkOpen) === "true") && parked) out.push("trunk_open_parked");
  if (changed("SentryAlert") && (next.SentryAlert === true || str(next.SentryAlert) === "true")) out.push("sentry_alert");
  const low = opts.lowBatteryPercent ?? 20;
  if ("Soc" in next && typeof next.Soc === "number" && next.Soc < low && !(typeof p.Soc === "number" && p.Soc < low)) out.push("low_battery");
  if (changed("SoftwareUpdateAvailable") && (next.SoftwareUpdateAvailable === true || str(next.SoftwareUpdateAvailable) === "true")) out.push("update_available");
  return out;
}

export function deriveEnergyTriggers(prev: EnergyStatus | undefined, next: EnergyStatus, marginPercent = 5): EnergyTrigger[] {
  const out: EnergyTrigger[] = [];
  if (/islanded/i.test(next.gridStatus ?? "") && !/islanded/i.test(prev?.gridStatus ?? "")) out.push("grid_islanded");
  const reserve = next.backupReservePercent;
  const below = (s: EnergyStatus | undefined) =>
    s?.percentCharged !== undefined && s.backupReservePercent !== undefined && s.percentCharged < s.backupReservePercent + marginPercent;
  if (reserve !== undefined && below(next) && !below(prev)) out.push("battery_below_reserve");
  if (next.stormModeActive === true && prev?.stormModeActive !== true) out.push("storm_watch");
  return out;
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

export class TeslaAdapter implements SourceAdapter {
  readonly name = "tesla";
  readonly routes: Route[];
  /** No callback: replies go through the agent's origin channel. */
  readonly callbackTokenRef = undefined;
  private ctx!: AdapterContext;
  private readonly lastVehicle = new Map<string, TelemetryRecord["data"]>();
  private readonly lastEnergy = new Map<string, EnergyStatus>();
  private readonly debounce = new Debouncer();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly cfg: TeslaConfig,
    private readonly deps: { receiver?: TelemetryReceiver; energy?: EnergyStatusSource } = {},
  ) {
    const problems = validateTeslaConfig(cfg);
    if (problems.length) throw new Error(problems.join("; "));
    this.routes = cfg.routes;
  }

  init(ctx: AdapterContext): void {
    this.ctx = ctx;
  }

  async start(): Promise<void> {
    if (this.cfg.telemetry?.enabled) {
      if (!this.deps.receiver) throw new Error("tesla: telemetry.enabled but no mTLS receiver is implemented yet (skeleton)");
      await this.deps.receiver.start((r) => void this.ingestTelemetry(r));
    }
    if (this.cfg.energy_poll?.enabled) {
      if (!this.deps.energy) throw new Error("tesla: energy_poll.enabled but no energy status source is implemented yet (skeleton)");
      const every = Math.max(60, this.cfg.energy_poll.interval_s ?? 300) * 1000;
      this.timer = setInterval(() => void this.pollEnergyOnce(), every);
      this.timer.unref?.();
    }
    this.ctx.log.info(`[tesla] skeleton started telemetry=${Boolean(this.cfg.telemetry?.enabled)} energy=${Boolean(this.cfg.energy_poll?.enabled)}`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.deps.receiver?.stop().catch(() => undefined);
  }

  vinAllowed(vin: string): boolean {
    return (this.cfg.telemetry?.vin_allowlist ?? []).includes(vin);
  }

  siteAllowed(site: string): boolean {
    return (this.cfg.energy_poll?.site_allowlist ?? []).includes(site);
  }

  /** Feed one decoded telemetry record (called by the receiver). Returns triggers submitted. */
  async ingestTelemetry(r: TelemetryRecord): Promise<TeslaTrigger[]> {
    if (!this.vinAllowed(r.vin)) {
      this.ctx.audit({ action: "inbound", outcome: "deny", reason: "vin_not_allowlisted", actor: r.vin });
      return [];
    }
    const prev = this.lastVehicle.get(r.vin);
    this.lastVehicle.set(r.vin, { ...(prev ?? {}), ...r.data });
    const triggers = deriveVehicleTriggers(prev, r.data, { lowBatteryPercent: this.cfg.telemetry?.low_battery_percent });
    return this.fire("vehicle", r.vin, triggers, r.createdAt);
  }

  /** One energy poll across the allowlisted sites. */
  async pollEnergyOnce(): Promise<TeslaTrigger[]> {
    const fired: TeslaTrigger[] = [];
    for (const site of this.cfg.energy_poll?.site_allowlist ?? []) {
      try {
        const s = await this.deps.energy!.liveStatus(site);
        fired.push(...(await this.ingestEnergy(s)));
      } catch {
        this.ctx.audit({ action: "observe", outcome: "error", reason: "energy_poll_failed", actor: site });
      }
    }
    return fired;
  }

  async ingestEnergy(s: EnergyStatus): Promise<TeslaTrigger[]> {
    if (!this.siteAllowed(s.siteId)) {
      this.ctx.audit({ action: "inbound", outcome: "deny", reason: "site_not_allowlisted", actor: s.siteId });
      return [];
    }
    const prev = this.lastEnergy.get(s.siteId);
    this.lastEnergy.set(s.siteId, s);
    return this.fire("energy", s.siteId, deriveEnergyTriggers(prev, s, this.cfg.energy_poll?.reserve_margin_percent), new Date().toISOString());
  }

  private async fire(kind: "vehicle" | "energy", id: string, triggers: TeslaTrigger[], at: string): Promise<TeslaTrigger[]> {
    const fired: TeslaTrigger[] = [];
    for (const t of triggers) {
      const rule = this.cfg.rules.find((r) => r.on === t);
      if (!rule) continue;
      if (!this.debounce.allow(`${id}:${t}`, rule.debounce_s ?? 0)) {
        this.ctx.audit({ action: "observe", outcome: "skipped", reason: "debounced", type: t, actor: id });
        continue;
      }
      if (!rule.wake) {
        this.ctx.audit({ action: "observe", outcome: "ok", reason: "no_wake_rule", type: t, actor: id });
        continue;
      }
      const eventId = createHash("sha256").update(`${id}|${t}|${at}`).digest("hex").slice(0, 16);
      const masked = maskId(id);
      const res = await this.ctx.submit({
        eventId,
        lane: `${kind}:${masked}`,
        actor: id,
        match: { kind },
        addressed: true,
        prompt: [
          `Tesla ${kind} ${masked}: ${t} (priority ${rule.priority ?? "normal"}) at ${at}.`,
          "Reply through your origin channel. This bridge sends no vehicle commands; use the Tesla plugin's confirm-gated tools if an action is needed.",
          `\u27C2 t:${t}:${eventId} id=${masked} kind=${kind}`,
        ].join("\n"),
        metadata: { trigger: t, kind, priority: rule.priority ?? "normal" },
      });
      if (res.accepted) fired.push(t);
    }
    return fired;
  }
}

export function createTeslaAdapter(cfg: TeslaConfig, deps?: { receiver?: TelemetryReceiver; energy?: EnergyStatusSource }): TeslaAdapter {
  return new TeslaAdapter(cfg, deps);
}
