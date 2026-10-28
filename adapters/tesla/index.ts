import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { vinAuditActor, type VinAudit } from "./audit-vin.js";
import { validateRoutes } from "../../core/allowlist.js";
import type { AdapterContext, SourceAdapter } from "../../core/bridge.js";
import { maskId } from "../../core/redact.js";
import { isSecretRef } from "../../core/secrets.js";
import type { Route } from "../../core/types.js";
import {
  deriveEnergyTriggers,
  baseUrlProblem,
  EnergyApiError,
  FLEET_API_HOSTS,
  FleetEnergyClient,
  gridOutage,
  hasEnergyData,
  unintentionalOutage,
  type EnergyStatus,
  type EnergyStatusSource,
  type EnergyTrigger,
  type FetchLike,
  type TestHostOverride,
} from "./energy.js";
import { deriveVehicleTriggers, KNOWN_FIELDS, mergeState, OWNERSHIP_FIELDS, REPLACED_FIELDS, STREAM_ONLY_FIELDS, type TelemetryRecord, type TelemetryValue, type TriggerHit, type VehicleTrigger } from "./fields.js";
import { brokerUrlProblem, MqttTelemetryReceiver, topicBaseProblem } from "./mqtt.js";
import { OwnershipRuntime, validateOwnership, type OwnershipConfig } from "./ownership-runtime.js";
import {
  DashcamAutosaveRuntime,
  telemetryAuthenticated,
  validateDashcamAutosave,
  type DashcamAutosaveConfig,
} from "./dashcam-autosave.js";
import { DecodedJsonReceiver, isLoopbackHost, MtlsTelemetryReceiver, splitListen, type DropReason, type TelemetryReceiver } from "./receiver.js";

export * from "./fields.js";
export * from "./energy.js";
export * from "./receiver.js";
export * from "./mqtt.js";
export * from "./ownership.js";
export * from "./ownership-rest.js";
export * from "./ownership-runtime.js";
export * from "./dashcam-autosave.js";
export * from "./signed-command.js";
export * from "./proto-wire.js";

/**
 * Tesla source adapter.
 *
 * Split with the Tesla plugin:
 *   bridge (here): telemetry receiver (fleet-telemetry over MQTT or decoded JSON, or mTLS), energy
 *                  live_status polling, filter + debounce, wake rules, VIN/site allowlists,
 *                  hold-retry, audit.
 *   plugin:        OAuth and token refresh, Fleet API client, read + command tools, safety
 *                  (read-only fail-closed, confirm, dry-run, state_unknown), proxy client, and
 *                  the access-token export file energy polling reads.
 *   ownership:     change-only, deduped ownership events (software update, odometer, alerts,
 *                  service, TPMS, battery health, charging faults, safety, Sentry counts) with
 *                  immediate / weekly-digest tiers and a slow REST pull (recalls, warranty,
 *                  service status, release notes). See ownership.ts.
 *   operator:      pushes fleet_telemetry_config to each car once (a signed request through the
 *                  proxy; a future confirm-gated plugin tool). Neither the plugin nor the bridge
 *                  pushes it today; telemetry.fields here is its source of truth.
 *
 * Hard rules enforced here:
 *   - The bridge NEVER sends vehicle commands by default (config with commands/actions keys is
 *     refused). EXPERIMENTAL exception: tesla.dashcam_autosave + env TESLA_DASHCAM_AUTOSAVE=1 may
 *     send community DashcamSaveClipAction (47) via Fleet signed_command. Off by default; live
 *     tests need the owner's yes. Stock tesla-http-proxy rejects action 47.
 *   - Never poll vehicle_data or wake a car. Vehicles are push-only via telemetry (except the
 *     experimental dashcam path above, which may wake the car as a side effect of the command).
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

export interface TeslaMqttConfig {
  /** Broker URL: env:NAME / file:/path ref, or a literal mqtt(s):// URL on loopback or the LAN (no credentials in it). */
  broker: string;
  client_id: string;
  /** fleet-telemetry's mqtt.topic_base. The bridge subscribes to <topic_base>/+/v/+. */
  topic_base: string;
  /** 1 (default) or 0. QoS 2 is refused (fleet-telemetry publishes at 0-2; 1 is the recommended pairing). */
  qos?: 0 | 1;
  username_ref?: string;
  password_ref?: string;
  /** mqtts: PEM CA for the broker cert, as a file: ref (read whole). */
  ca_file?: string;
  /** Coalesce one VIN's field messages for this long into one record (default 250 ms, 0-5000). */
  batch_ms?: number;
  /** Reconnect backoff (defaults 1000 ms doubling to 60000 ms, with jitter). */
  reconnect_min_ms?: number;
  reconnect_max_ms?: number;
}

export interface TeslaConfig {
  telemetry?: {
    enabled: boolean;
    /**
     * "decoded" (default): loopback JSON POSTed from a relay of Tesla's fleet-telemetry server.
     * "mqtt": the bridge subscribes to the broker fleet-telemetry's MQTT dispatcher publishes to.
     * "mtls": the bridge terminates mTLS itself (decoded JSON text frames only).
     */
    mode?: "decoded" | "mqtt" | "mtls";
    /** mqtt mode. */
    mqtt?: TeslaMqttConfig;
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
    /** Field -> interval_seconds for fleet_telemetry_config (pushed once by the operator; the bridge never pushes it). */
    fields?: Record<string, number>;
    low_battery_percent?: number;
    /** resend_interval_seconds the plugin applies to every field (a long one, e.g. 21600). Documentation for the plugin; the bridge never pushes config. */
    resend_interval_s?: number;
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
  /** Ownership events (route match { kind: "ownership" }). */
  ownership?: OwnershipConfig;
  /**
   * EXPERIMENTAL dashcam auto-save (route match { kind: "dashcam_autosave" }).
   * Also requires env TESLA_DASHCAM_AUTOSAVE=1. Off by default.
   */
  dashcam_autosave?: DashcamAutosaveConfig;
  /**
   * Audit lines record the full VIN of an allowlisted car (default true). false: the last 6 only.
   * Foreign (non-allowlisted) VINs always keep the last 6, and non-VIN strings are written "invalid".
   * Prompts and envelopes are unaffected (masked id / vin_last6).
   */
  audit_full_vin?: boolean;
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
  if (c.audit_full_vin !== undefined && typeof c.audit_full_vin !== "boolean") p.push("tesla.audit_full_vin must be true or false");
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
    if (t.resend_interval_s !== undefined && !(Number.isInteger(t.resend_interval_s) && t.resend_interval_s >= 60)) p.push("tesla.telemetry.resend_interval_s must be an integer >= 60");
    for (const [f, sec] of Object.entries(t.fields ?? {})) if (!(Number.isInteger(sec) && sec >= 1)) p.push(`tesla.telemetry.fields.${f} must be an interval in whole seconds >= 1`);
    for (const f of Object.keys(t.fields ?? {})) {
      if (REPLACED_FIELDS[f]) p.push(`tesla.telemetry.fields.${f}: not a usable field; use ${REPLACED_FIELDS[f]}`);
      else if (!(KNOWN_FIELDS as readonly string[]).includes(f) && !STREAM_ONLY_FIELDS.includes(f) && !(OWNERSHIP_FIELDS as readonly string[]).includes(f)) {
        p.push(`tesla.telemetry.fields.${f}: not read by the trigger logic or ownership events (known: ${[...new Set([...KNOWN_FIELDS, ...OWNERSHIP_FIELDS])].join(", ")})`);
      }
    }
    const mode = t.mode ?? "decoded";
    if (mode !== "decoded" && mode !== "mtls" && mode !== "mqtt") p.push('tesla.telemetry.mode must be "decoded", "mqtt" or "mtls"');
    if (t.mqtt !== undefined || (t.enabled && mode === "mqtt")) p.push(...validateMqtt(t.mqtt));
    for (const k of PEM_KEYS) {
      const v = t[k];
      if (v !== undefined && !isSecretRef(v)) p.push(`tesla.telemetry.${k} must be file:/path or env:NAME`);
    }
    if (t.decoded_token_ref !== undefined && !isSecretRef(t.decoded_token_ref)) p.push("tesla.telemetry.decoded_token_ref must be env:NAME or file:/path");
    if (t.enabled && mode === "mtls") {
      for (const k of [...PEM_KEYS, "listen"] as const) if (!t[k]) p.push(`tesla.telemetry.${k} is required in mtls mode`);
    }
    if (t.decoded_listen !== undefined) {
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
    if (e.api_base !== undefined) {
      const bad = baseUrlProblem(e.api_base, FLEET_API_HOSTS, "tesla.energy_poll.api_base");
      if (bad) p.push(bad);
    }
    if (e.enabled && !e.api_base) p.push("tesla.energy_poll.api_base is required when enabled");
    if (e.enabled && !e.token_ref) p.push("tesla.energy_poll.token_ref is required when enabled");
  }
  for (const [i, r] of (c.routes ?? []).entries()) {
    const keys = Object.keys(r.match ?? {});
    if (keys.length !== 1 || keys[0] !== "kind" || !["vehicle", "energy", "ownership", "dashcam_autosave"].includes(String(r.match.kind))) {
      p.push(`tesla.routes[${i}]: match must be { kind: "vehicle" }, { kind: "energy" }, { kind: "ownership" } or { kind: "dashcam_autosave" }`);
    }
  }
  if (c.ownership !== undefined) {
    const hasRoute = (c.routes ?? []).some((r) => r.match?.kind === "ownership" && r.enabled !== false);
    p.push(...validateOwnership(c.ownership, t?.vin_allowlist ?? [], hasRoute));
    if (c.ownership.enabled && !t?.enabled) p.push("tesla.ownership needs tesla.telemetry enabled (events come from the cars' telemetry)");
  }
  if (c.dashcam_autosave !== undefined) {
    const hasDash = (c.routes ?? []).some((r) => r.match?.kind === "dashcam_autosave" && r.enabled !== false);
    p.push(...validateDashcamAutosave(
      c.dashcam_autosave,
      t?.vin_allowlist ?? [],
      hasDash,
      Boolean(c.ownership?.enabled),
      telemetryAuthenticated(t),
    ));
  }
  return p;
}

function validateMqtt(m: TeslaMqttConfig | undefined): string[] {
  const p: string[] = [];
  const at = "tesla.telemetry.mqtt";
  if (!m || typeof m !== "object") return [`${at} is required in mqtt mode`];
  if (typeof m.broker !== "string" || !m.broker.trim()) p.push(`${at}.broker is required`);
  else if (!isSecretRef(m.broker)) {
    const b: string = m.broker;
    if (/^(env|file):/.test(b.trim())) p.push(`${at}.broker must be env:NAME or file:/absolute/path when it is a ref`);
    else {
      const prob = brokerUrlProblem(b, true);
      if (prob) p.push(`${at}.broker ${prob}`);
    }
  }
  if (typeof m.client_id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(m.client_id)) p.push(`${at}.client_id must be 1-64 characters of A-Z a-z 0-9 . _ -`);
  const tb = topicBaseProblem(m.topic_base);
  if (tb) p.push(`${at}.topic_base ${tb}`);
  if (m.qos !== undefined && m.qos !== 0 && m.qos !== 1) p.push(`${at}.qos must be 1 (default) or 0`);
  for (const k of ["username_ref", "password_ref", "ca_file"] as const) {
    if (m[k] !== undefined && !isSecretRef(m[k])) p.push(`${at}.${k} must be ${k === "ca_file" ? "file:/absolute/path" : "env:NAME or file:/absolute/path"}`);
  }
  if (m.ca_file !== undefined && !m.ca_file.trim().startsWith("file:")) p.push(`${at}.ca_file must be file:/absolute/path`);
  if (m.password_ref !== undefined && m.username_ref === undefined) p.push(`${at}.password_ref needs username_ref`);
  if (m.batch_ms !== undefined && !(Number.isFinite(m.batch_ms) && m.batch_ms >= 0 && m.batch_ms <= 5000)) p.push(`${at}.batch_ms must be 0-5000`);
  for (const k of ["reconnect_min_ms", "reconnect_max_ms"] as const) {
    if (m[k] !== undefined && !(Number.isFinite(m[k]) && m[k]! >= 10 && m[k]! <= 3_600_000)) p.push(`${at}.${k} must be 10-3600000`);
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
  /** Entries whose key starts with prefix (for persistence). */
  entries(prefix: string): Array<[string, number]> {
    return [...this.last].filter(([k]) => k.startsWith(prefix));
  }
  restore(key: string, at: number): void {
    const prev = this.last.get(key);
    if (prev === undefined || at > prev) this.last.set(key, at);
  }
}

/** vin_not_allowlisted audit: once per VIN per 10 min, at most this many VINs remembered. */
export const VIN_DENY_AUDIT_MS = 10 * 60_000;
export const VIN_DENY_AUDIT_MAX = 256;

/** Persisted energy state older than this is ignored at start (the outage it describes is history). */
export const ENERGY_STATE_MAX_AGE_MS = 24 * 3600 * 1000;

interface EnergyStateFile {
  version: 1;
  sites: Record<string, { at: number; status: EnergyStatus; debounce: Record<string, number> }>;
}

export interface TeslaDeps {
  receiver?: TelemetryReceiver;
  energy?: EnergyStatusSource;
  fetchImpl?: FetchLike;
  /** TESTS ONLY: extra hosts the REST clients may call (never from config). */
  testHosts?: TestHostOverride;
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
  private ownership?: OwnershipRuntime;
  private dashcam?: DashcamAutosaveRuntime;
  private polling = false;
  private skipUntil = 0;
  private skipReason = "";
  private authFailures = 0;
  private lastTokenUsed: string | undefined;
  private readonly now: () => number;
  private energyFile = "";
  private readonly energySavedAt = new Map<string, number>();
  /** Last vin_not_allowlisted audit line per VIN, and lines suppressed since (bounded). */
  private readonly vinDenyAudit = new Map<string, { at: number; suppressed: number }>();

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
    if (this.cfg.ownership?.enabled) {
      this.ownership = new OwnershipRuntime(this.cfg.ownership, this.ctx, { now: this.now, fetchImpl: this.deps.fetchImpl, testHosts: this.deps.testHosts, auditVin: (vin) => this.auditVin(vin) });
      this.ownership.start();
    }
    if (this.cfg.dashcam_autosave) {
      this.dashcam = new DashcamAutosaveRuntime(this.cfg.dashcam_autosave, this.ctx, {
        now: this.now,
        fetchImpl: this.deps.fetchImpl,
        testHosts: this.deps.testHosts,
      });
      this.dashcam.start();
    }
    if (t?.enabled) {
      const mode = t.mode ?? "decoded";
      this.receiver =
        this.deps.receiver ??
        (mode === "mtls"
          ? new MtlsTelemetryReceiver({ listen: t.listen!, cert: this.pem(t.tls_cert!), key: this.pem(t.tls_key!), clientCa: this.pem(t.client_ca!) })
          : mode === "mqtt"
            ? this.mqttReceiver(t.mqtt!)
            : this.decodedReceiver(t));
      await this.receiver.start({
        record: (r) =>
          void this.ingestTelemetry(r).catch(() => this.ctx.audit({ action: "inbound", outcome: "error", reason: "ingest_failed", ...this.auditVin(r.vin) })),
        drop: (reason, vin, count) => this.dropped(reason, vin, count),
        event: (e) => this.ctx.audit({ action: "connection", outcome: e.outcome, reason: `mqtt_${e.reason}`, ms: "ms" in e ? e.ms : undefined }),
      });
    }
    const e = this.cfg.energy_poll;
    if (e?.enabled) {
      // Accepted residual, stated once at start: the plugin exports one access token for all of its
      // scopes, so the file this adapter reads can do more than energy_device_data.
      this.ctx.log.warn(
        "[tesla] energy polling on: the exported access token carries every scope the Tesla plugin was granted, not only energy_device_data; keep token_ref host-only (mode 600)",
      );
      this.loadEnergyState();
      this.energy = this.deps.energy ?? new FleetEnergyClient({ apiBase: e.api_base!, getToken: () => this.token(), fetchImpl: this.deps.fetchImpl, testHosts: this.deps.testHosts });
      const every = Math.max(60, e.interval_s ?? 300) * 1000;
      this.timer = setInterval(() => this.safeTick(), every);
      this.timer.unref?.();
      if (this.deps.pollOnStart !== false) this.safeTick();
    }
    this.ctx.log.info(`[tesla] started telemetry=${t?.enabled ? (t.mode ?? "decoded") : "off"} energy=${Boolean(e?.enabled)}`);
  }

  /** Refs are resolved here; a configured ref that doesn't resolve fails the start (never "no auth"). */
  private mqttReceiver(m: TeslaMqttConfig): MqttTelemetryReceiver {
    const kind = (ref: string) => (ref.trim().startsWith("file:") ? "file" : ref.trim());
    const need = (label: string, ref: string | undefined): (() => string | undefined) | undefined => {
      if (ref === undefined) return undefined;
      if (!this.ctx.secret(ref)) throw new Error(`tesla: telemetry.mqtt.${label} is set but does not resolve (${kind(ref)})`);
      // Re-read on each reconnect; keep the last good value if the ref is briefly empty mid-rotation.
      let last = this.ctx.secret(ref);
      return () => (last = this.ctx.secret(ref) ?? last);
    };
    let url = m.broker.trim();
    if (isSecretRef(url)) {
      const v = this.ctx.secret(url);
      if (!v) throw new Error(`tesla: telemetry.mqtt.broker is set but does not resolve (${kind(url)})`);
      const prob = brokerUrlProblem(v, false);
      if (prob) throw new Error(`tesla: telemetry.mqtt.broker (${kind(url)}) ${prob}`);
      url = v;
    }
    return new MqttTelemetryReceiver({
      url,
      clientId: m.client_id,
      topicBase: m.topic_base,
      qos: m.qos ?? 1,
      username: need("username_ref", m.username_ref),
      password: need("password_ref", m.password_ref),
      ca: m.ca_file ? this.pem(m.ca_file) : undefined,
      batchMs: m.batch_ms,
      reconnectMinMs: m.reconnect_min_ms,
      reconnectMaxMs: m.reconnect_max_ms,
      now: this.deps.now,
      vinAllowed: (vin) => this.vinAllowed(vin),
      alerts: Boolean(this.cfg.ownership?.enabled && this.cfg.ownership.alerts_stream !== false),
    });
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

  /** Idempotent: clears the energy poll timer, stops the receiver and the ownership runtime. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.receiver?.stop().catch(() => undefined);
    await this.ownership?.stop();
    await this.dashcam?.stop();
  }

  health(): Record<string, unknown> {
    return {
      ownership: this.ownership?.health() ?? { enabled: false },
      dashcam_autosave: this.dashcam?.health() ?? { experimental: true, armed: false },
    };
  }

  /** Ownership runtime (tests / ops): digest flush, REST pull, pending counts. */
  ownershipRuntime(): OwnershipRuntime | undefined {
    return this.ownership;
  }

  /** Bound telemetry port (tests / ops). */
  telemetryPort(): number {
    return this.receiver?.port?.() ?? 0;
  }

  /** Audit actor fields for a VIN (see vinAuditActor and audit_full_vin). */
  auditVin(vin: string): VinAudit {
    return vinAuditActor(vin, this.vinAllowed(vin), this.cfg.audit_full_vin !== false);
  }

  vinAllowed(vin: string): boolean {
    return (this.cfg.telemetry?.vin_allowlist ?? []).includes(vin);
  }

  siteAllowed(site: string): boolean {
    return (this.cfg.energy_poll?.site_allowlist ?? []).includes(site);
  }

  private dropped(reason: DropReason, vin?: string, count?: number): void {
    if (reason === "vin_not_allowlisted" && vin) return this.vinDenied(vin);
    this.ctx.audit({ action: "inbound", outcome: "deny", reason, ...(vin !== undefined ? this.auditVin(vin) : {}), ...(count !== undefined ? { count } : {}) });
  }

  /**
   * vin_not_allowlisted is audited at most once per VIN per VIN_DENY_AUDIT_MS; the next line carries
   * the count suppressed in between. The map is capped (oldest entry evicted) so a flood of
   * distinct VINs can't grow it.
   */
  private vinDenied(vin: string): void {
    const now = this.now();
    const seen = this.vinDenyAudit.get(vin);
    if (seen && now - seen.at < VIN_DENY_AUDIT_MS) {
      seen.suppressed++;
      return;
    }
    this.vinDenyAudit.delete(vin);
    while (this.vinDenyAudit.size >= VIN_DENY_AUDIT_MAX) this.vinDenyAudit.delete(this.vinDenyAudit.keys().next().value!);
    this.vinDenyAudit.set(vin, { at: now, suppressed: 0 });
    this.ctx.audit({ action: "inbound", outcome: "deny", reason: "vin_not_allowlisted", ...this.auditVin(vin), ...(seen?.suppressed ? { count: seen.suppressed } : {}) });
  }

  /** Feed one decoded telemetry record (called by the receiver). Returns triggers submitted. */
  async ingestTelemetry(r: TelemetryRecord): Promise<TeslaTrigger[]> {
    if (!this.vinAllowed(r.vin)) {
      this.vinDenied(r.vin);
      return [];
    }
    if (r.telemetryErrors !== undefined) {
      // The car's telemetry client reporting its own errors (bad config, unknown field): audit only.
      this.ctx.audit({ action: "observe", outcome: "error", reason: "telemetry_client_errors", ...this.auditVin(r.vin), count: r.telemetryErrors });
      return [];
    }
    if (r.alerts) {
      // Alerts records carry no field data: they only feed ownership (and experimental dashcam) events.
      if (this.ownership) {
        const ev = await this.ownership.record(r, Boolean(r.baseline || r.isResend));
        if (this.dashcam && ev.length) await this.dashcam.onOwnershipEvents(r.vin, ev);
      } else this.ctx.audit({ action: "observe", outcome: "skipped", reason: "alerts_without_ownership", ...this.auditVin(r.vin) });
      return [];
    }
    if (r.baseline) {
      // Replayed value (MQTT retained): only fills fields not seen yet, never fires.
      const cur = this.lastVehicle.get(r.vin) ?? {};
      const fresh = Object.fromEntries(Object.entries(r.data).filter(([k]) => !(k in cur)));
      this.lastVehicle.set(r.vin, mergeState(cur, fresh).next);
      if (this.ownership) {
        const ev = await this.ownership.record({ ...r, data: fresh }, true);
        if (this.dashcam && ev.length) await this.dashcam.onOwnershipEvents(r.vin, ev);
      }
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "retained_baseline", ...this.auditVin(r.vin) });
      return [];
    }
    const at = Date.parse(r.createdAt);
    const last = this.lastCreatedAt.get(r.vin);
    if (!Number.isNaN(at) && last !== undefined && at < last) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "stale_record", ...this.auditVin(r.vin) });
      return [];
    }
    if (!Number.isNaN(at)) this.lastCreatedAt.set(r.vin, at);
    const prev = this.lastVehicle.get(r.vin);
    const { next, delta } = mergeState(prev, r.data);
    this.lastVehicle.set(r.vin, next);
    if (r.isResend) {
      // A resend carries un-acked values: keep the state current, but never fire on it.
      if (this.ownership) {
        const ev = await this.ownership.record(r, true);
        if (this.dashcam && ev.length) await this.dashcam.onOwnershipEvents(r.vin, ev);
      }
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "resend", ...this.auditVin(r.vin) });
      return [];
    }
    if (this.ownership) {
      const ev = await this.ownership.record(r, false);
      if (this.dashcam && ev.length) await this.dashcam.onOwnershipEvents(r.vin, ev);
    }
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
    const fired = await this.fire("energy", s.siteId, hits, new Date(this.now()).toISOString(), detail);
    this.energySavedAt.set(s.siteId, this.now());
    this.saveEnergyState();
    return fired;
  }

  /**
   * Energy state survives restarts: the last good status and the debounce times per allowlisted
   * site, in <data dir>/tesla-energy-state.json (mode 600, written atomically). A restart during
   * an outage then compares against the saved status and doesn't re-fire. Entries older than
   * 24 h, or for sites no longer allowlisted, are ignored. No data dir = memory only.
   */
  private loadEnergyState(): void {
    this.energyFile = this.ctx.dataFile?.("energy-state.json") ?? "";
    if (!this.energyFile) return;
    let raw: EnergyStateFile;
    try {
      raw = JSON.parse(readFileSync(this.energyFile, "utf8")) as EnergyStateFile;
    } catch {
      return; // none yet (or unreadable: start fresh)
    }
    if (raw?.version !== 1 || !raw.sites || typeof raw.sites !== "object") return;
    let n = 0;
    for (const [site, v] of Object.entries(raw.sites)) {
      if (!this.siteAllowed(site) || !v || typeof v.at !== "number" || this.now() - v.at > ENERGY_STATE_MAX_AGE_MS) continue;
      if (v.status && typeof v.status === "object" && hasEnergyData({ ...v.status, siteId: site })) {
        this.lastEnergy.set(site, { ...v.status, siteId: site });
      }
      for (const [k, at] of Object.entries(v.debounce ?? {})) if (k.startsWith(`${site}:`) && typeof at === "number") this.debounce.restore(k, at);
      this.energySavedAt.set(site, v.at);
      n++;
    }
    if (n) this.ctx.audit({ action: "observe", outcome: "ok", reason: "energy_state_restored", count: n });
  }

  private saveEnergyState(): void {
    if (!this.energyFile) return;
    const sites: EnergyStateFile["sites"] = {};
    for (const [site, status] of this.lastEnergy) {
      if (!this.siteAllowed(site)) continue;
      sites[site] = { at: this.energySavedAt.get(site) ?? this.now(), status, debounce: Object.fromEntries(this.debounce.entries(`${site}:`)) };
    }
    const tmp = `${this.energyFile}.tmp`;
    try {
      mkdirSync(dirname(this.energyFile), { recursive: true });
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify({ version: 1, sites } satisfies EnergyStateFile), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.energyFile);
    } catch {
      this.ctx.audit({ action: "observe", outcome: "error", reason: "energy_state_write_failed" });
    }
  }

  private async fire(kind: "vehicle" | "energy", id: string, hits: TriggerHit<TeslaTrigger>[], at: string, detail?: string): Promise<TeslaTrigger[]> {
    const fired: TeslaTrigger[] = [];
    // Audit lines carry the full VIN (prompts keep the masked id / vin_last6); site ids keep 4.
    const keep: { actorKeep?: VinAudit["actorKeep"] } = kind === "vehicle" ? { actorKeep: this.auditVin(id).actorKeep } : {};
    for (const h of hits) {
      const t = h.on;
      const rule = this.cfg.rules.find((r) => r.on === t);
      if (!rule) continue;
      const priority = h.priority ?? rule.priority ?? "normal";
      if (!this.debounce.allow(`${id}:${t}:${h.priority ?? ""}`, rule.debounce_s ?? 0, this.now())) {
        this.ctx.audit({ action: "observe", outcome: "skipped", reason: "debounced", type: t, actor: id, ...keep });
        continue;
      }
      if (!rule.wake) {
        this.ctx.audit({ action: "observe", outcome: "ok", reason: "no_wake_rule", type: t, actor: id, ...keep });
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
        ...keep,
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
