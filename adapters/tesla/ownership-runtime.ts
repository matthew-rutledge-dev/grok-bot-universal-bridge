import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, win32 } from "node:path";
import type { AdapterContext } from "../../core/bridge.js";
import { baseUrlProblem, EnergyApiError, FLEET_API_HOSTS, NHTSA_HOSTS, type FetchLike, type TestHostOverride } from "./energy.js";
import type { TelemetryRecord, TelemetryValue } from "./fields.js";
import {
  addToDigest,
  decodeTeslaVin,
  defaultVehicleId,
  nextDigestAt,
  OwnershipTracker,
  parseNhtsaRecalls,
  parseRecentAlerts,
  parseReleaseNotes,
  parseServiceData,
  parseWarranty,
  sanitizeCarState,
  sanitizeDigest,
  validateOwnershipRules,
  type CarState,
  type DigestState,
  type OwnershipEvent,
  type OwnershipRules,
  type OwnershipVehicle,
} from "./ownership.js";
import { OwnershipRestClient } from "./ownership-rest.js";

export interface OwnershipConfig {
  enabled: boolean;
  /** One entry per car (VINs must also be in telemetry.vin_allowlist). Cars not listed get defaults. */
  vehicles?: OwnershipVehicle[];
  rules?: OwnershipRules;
  /** Subscribe to the telemetry Alerts stream (mqtt mode) / accept alerts records. Default true. */
  alerts_stream?: boolean;
  /** Weekly digest time: weekday 0-6 (0 = Sunday) and hour 0-23, UTC. Default Sunday 13:00 UTC. */
  digest?: { weekday?: number; hour_utc?: number };
  rest?: {
    enabled: boolean;
    /** Region Fleet API base URL (https). */
    api_base?: string;
    /** env:/file: ref to an ACCESS token with vehicle_device_data. Re-read on every call. */
    token_ref?: string;
    /** NHTSA API base (default https://api.nhtsa.gov). */
    nhtsa_base?: string;
    /** Hours between pulls per car. 0 = off. Defaults: service 24, warranty 168, recalls 168, recent_alerts 0. */
    service_h?: number;
    warranty_h?: number;
    recalls_h?: number;
    recent_alerts_h?: number;
    /** Fetch release notes after a version change (default true). */
    release_notes?: boolean;
  };
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validateOwnership(o: OwnershipConfig | undefined, vinAllowlist: string[], hasRoute: boolean): string[] {
  const p: string[] = [];
  if (!o) return p;
  const at = "tesla.ownership";
  if (typeof o.enabled !== "boolean") p.push(`${at}.enabled must be true or false`);
  const ids = new Set<string>();
  for (const [i, v] of (o.vehicles ?? []).entries()) {
    if (!v || typeof v.vin !== "string" || !/^[A-HJ-NPR-Z0-9]{17}$/.test(v.vin)) {
      p.push(`${at}.vehicles[${i}].vin must be a 17-character VIN`);
      continue;
    }
    if (!vinAllowlist.includes(v.vin)) p.push(`${at}.vehicles[${i}].vin must also be in tesla.telemetry.vin_allowlist`);
    const id = v.vehicle_id ?? defaultVehicleId(v.vin);
    if (!ID_RE.test(id)) p.push(`${at}.vehicles[${i}].vehicle_id must be 1-32 of a-z 0-9 _ - (starting with a letter or digit)`);
    if (ids.has(id)) p.push(`${at}.vehicles[${i}].vehicle_id ${id} is used twice`);
    ids.add(id);
    if (v.label !== undefined && (typeof v.label !== "string" || v.label.length > 60)) p.push(`${at}.vehicles[${i}].label must be a string of at most 60 characters`);
    if (v.model_year !== undefined && !(Number.isInteger(v.model_year) && v.model_year >= 2008 && v.model_year <= 2100)) p.push(`${at}.vehicles[${i}].model_year must be a year`);
    if (v.model !== undefined && !/^[A-Za-z0-9 -]{1,40}$/.test(v.model)) p.push(`${at}.vehicles[${i}].model must be a model name like "Model 3"`);
  }
  p.push(...validateOwnershipRules(o.rules));
  const d = o.digest ?? {};
  if (d.weekday !== undefined && !(Number.isInteger(d.weekday) && d.weekday >= 0 && d.weekday <= 6)) p.push(`${at}.digest.weekday must be 0-6 (0 = Sunday)`);
  if (d.hour_utc !== undefined && !(Number.isInteger(d.hour_utc) && d.hour_utc >= 0 && d.hour_utc <= 23)) p.push(`${at}.digest.hour_utc must be 0-23`);
  const r = o.rest;
  if (r) {
    const badApi = r.api_base !== undefined ? baseUrlProblem(r.api_base, FLEET_API_HOSTS, `${at}.rest.api_base`) : undefined;
    if (badApi) p.push(badApi);
    const badNhtsa = r.nhtsa_base !== undefined ? baseUrlProblem(r.nhtsa_base, NHTSA_HOSTS, `${at}.rest.nhtsa_base`) : undefined;
    if (badNhtsa) p.push(badNhtsa);
    if (r.token_ref !== undefined && !isTokenRef(r.token_ref)) p.push(`${at}.rest.token_ref must be env:NAME or file:/path`);
    if (r.enabled && !r.api_base) p.push(`${at}.rest.api_base is required when rest is enabled`);
    if (r.enabled && !r.token_ref) p.push(`${at}.rest.token_ref is required when rest is enabled`);
    for (const k of ["service_h", "warranty_h", "recalls_h", "recent_alerts_h"] as const) {
      const v = r[k];
      if (v !== undefined && !(Number.isFinite(v) && (v === 0 || (v >= 12 && v <= 24 * 31)))) p.push(`${at}.rest.${k} must be 0 (off) or 12-744 hours`);
    }
  }
  if (o.enabled && !hasRoute) p.push(`${at}: enabled needs a route with match { kind: "ownership" }`);
  return p;
}

interface StateFile {
  version: 1;
  cars: Record<string, CarState>;
  digest: DigestState;
}

const SAVE_EVERY_MS = 30_000;
/** After ANY failed REST pull, that pull kind waits this long before it is tried again (persisted). */
export const PULL_RETRY_MS = 3600_000;

export interface OwnershipDeps {
  now: () => number;
  fetchImpl?: FetchLike;
  /** TESTS ONLY: extra hosts for the REST client. */
  testHosts?: TestHostOverride;
}

/**
 * env:NAME, or file:<absolute path>. Absolute means POSIX (/...) or Windows (C:\..., C:/..., or a UNC path \\server\share\...),
 * whatever OS validates the config, so a config written for one host checks the same everywhere.
 * Relative and drive-relative (C:foo) paths are refused: they depend on the working directory.
 * Any whitespace or control character anywhere (file:\t..., embedded newlines, padding) is refused.
 */
export function isTokenRef(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  if (/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(ref)) return false;
  const r = ref;
  if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(r)) return true;
  if (!r.startsWith("file:") || r.length <= 5) return false;
  const f = r.slice(5);
  return isAbsolute(f) || posix.isAbsolute(f) || win32.isAbsolute(f);
}

/** Wires OwnershipTracker into the adapter: state file, submit, digest timer, REST pulls. */
export class OwnershipRuntime {
  private readonly trackers = new Map<string, OwnershipTracker>();
  private cars: Record<string, CarState> = {};
  private digest: DigestState = { items: {} };
  private file = "";
  private dirty = false;
  private lastSave = 0;
  private timer?: ReturnType<typeof setInterval>;
  private rest?: OwnershipRestClient;
  private pulling = false;
  private flushing = false;
  private restBackoffUntil = 0;
  /** Release notes to fetch (vehicle_id -> version). */
  private readonly pendingNotes = new Map<string, string>();

  constructor(
    private readonly cfg: OwnershipConfig,
    private readonly ctx: AdapterContext,
    private readonly deps: OwnershipDeps,
  ) {}

  private vehicleFor(vin: string): OwnershipVehicle & { vehicle_id: string } {
    const v = (this.cfg.vehicles ?? []).find((x) => x.vin === vin) ?? { vin };
    return { ...v, vehicle_id: v.vehicle_id ?? defaultVehicleId(vin) };
  }

  tracker(vin: string): OwnershipTracker {
    let t = this.trackers.get(vin);
    if (!t) {
      const v = this.vehicleFor(vin);
      const st = (this.cars[v.vehicle_id] ??= {});
      t = new OwnershipTracker(v, st, this.cfg.rules);
      this.trackers.set(vin, t);
    }
    return t;
  }

  start(): void {
    this.file = this.ctx.dataFile?.("ownership-state.json") ?? "";
    this.load();
    const now = this.deps.now();
    if (!this.digest.next_at || this.digest.next_at < now - 7 * 86400_000) this.digest.next_at = this.nextAt(now);
    const r = this.cfg.rest;
    if (r?.enabled) {
      this.rest = new OwnershipRestClient({
        apiBase: r.api_base!,
        nhtsaBase: r.nhtsa_base,
        getToken: () => this.ctx.secret(r.token_ref),
        fetchImpl: this.deps.fetchImpl,
        testHosts: this.deps.testHosts,
      });
    }
    for (const v of this.cfg.vehicles ?? []) this.tracker(v.vin);
    this.timer = setInterval(() => void this.tick().catch(() => this.ctx.audit({ action: "observe", outcome: "error", reason: "ownership_tick_failed" })), 60_000);
    this.timer.unref?.();
  }

  /** Idempotent: clears the tick timer and writes state once. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.save(true);
  }

  private nextAt(now: number): number {
    return nextDigestAt(now, this.cfg.digest?.weekday ?? 0, this.cfg.digest?.hour_utc ?? 13);
  }

  /** Timer: digest when due, REST pulls when due, throttled state save. */
  async tick(): Promise<void> {
    const now = this.deps.now();
    if (this.digest.next_at !== undefined && now >= this.digest.next_at) await this.flushDigest();
    if (this.rest && !this.pulling) {
      this.pulling = true;
      try {
        await this.pullDue();
      } finally {
        this.pulling = false;
      }
    }
    this.save(false);
  }

  /** One telemetry record (allowlisted VIN). `quiet` = baseline / resend: state only. */
  async record(r: TelemetryRecord, quiet: boolean): Promise<OwnershipEvent[]> {
    try {
      return await this.recordUnsafe(r, quiet);
    } catch {
      // Ownership must never break the wake triggers that share the record.
      this.ctx.audit({ action: "observe", outcome: "error", reason: "ownership_ingest_failed", actor: r.vin, actorKeep: "full" });
      return [];
    }
  }

  private async recordUnsafe(r: TelemetryRecord, quiet: boolean): Promise<OwnershipEvent[]> {
    const t = this.tracker(r.vin);
    const ts = r.createdAt && !Number.isNaN(Date.parse(r.createdAt)) ? new Date(Date.parse(r.createdAt)).toISOString() : new Date(this.deps.now()).toISOString();
    const events: OwnershipEvent[] = [];
    if (r.alerts?.length && this.cfg.alerts_stream !== false) events.push(...t.alerts(r.alerts, ts, "telemetry", quiet));
    if (Object.keys(r.data).length) {
      const before = t.state.version;
      events.push(...t.telemetry(r.data as Record<string, TelemetryValue>, ts, quiet));
      if (!quiet && before && t.state.version && before !== t.state.version && this.cfg.rest?.release_notes !== false) {
        this.pendingNotes.set(t.vehicle.vehicle_id, t.state.version);
      }
    }
    this.dirty = true;
    if (events.length) t.prune(this.deps.now());
    await this.emit(events);
    return events;
  }

  /** Immediate events are submitted now; digest events wait for the weekly digest. */
  private async emit(events: OwnershipEvent[]): Promise<void> {
    if (!events.length) return;
    for (const e of events) {
      if (e.tier === "immediate") await this.submit([e], e.vehicle_id, `${e.event_type}:${e.dedupe_key}`);
      else addToDigest(this.digest, e);
    }
    this.dirty = true;
    this.save(true);
  }

  private vinFor(vehicleId: string): string | undefined {
    for (const [vin, t] of this.trackers) if (t.vehicle.vehicle_id === vehicleId) return vin;
    return undefined;
  }

  private async submit(events: OwnershipEvent[], vehicleId: string, key: string): Promise<boolean> {
    const vin = this.vinFor(vehicleId);
    if (!vin) return false;
    const e0 = events[0];
    const digest = events.length > 1 || e0.tier === "digest";
    const eventId = createHash("sha256").update(`ownership|${vehicleId}|${key}`).digest("hex").slice(0, 16);
    const head = digest
      ? `Tesla ownership digest for ${vehicleId} (${e0.model}, VIN …${e0.vin_last6}): ${events.length} change${events.length === 1 ? "" : "s"} since the last digest.`
      : `Tesla ownership event for ${vehicleId} (${e0.model}, VIN …${e0.vin_last6}): ${e0.event_type} (tier immediate, priority ${e0.priority}) at ${e0.ts}.`;
    const res = await this.ctx.submit({
      eventId,
      lane: `ownership:${vehicleId}`,
      actor: vin,
      actorKeep: "full",
      match: { kind: "ownership" },
      addressed: true,
      prompt: [
        head,
        "Each line below is one change (JSON envelope: vehicle_id, vin_last6, model, ts, source, event_type, tier, priority, data). This bridge sends no vehicle commands; use the Tesla plugin's read tools for detail.",
        ...events.map((e) => JSON.stringify(e)),
        `\u27C2 o:${digest ? "digest" : e0.event_type}:${eventId} id=${vehicleId} kind=ownership`,
      ].join("\n"),
      metadata: { kind: "ownership", digest, event_types: [...new Set(events.map((e) => e.event_type))].join(","), priority: events.some((e) => e.priority === "high") ? "high" : "normal" },
    });
    this.ctx.audit({ action: "observe", outcome: res.accepted ? "ok" : "skipped", reason: res.accepted ? (digest ? "ownership_digest" : "ownership_immediate") : `ownership_${res.reason}`, type: digest ? "digest" : e0.event_type, actor: vin, actorKeep: "full", count: events.length });
    return res.accepted;
  }

  /** Send each car's queued digest-tier events as one message, then schedule the next digest. */
  async flushDigest(): Promise<number> {
    // Overlap guard: a slow submit must not let the next tick send the same digest twice.
    if (this.flushing) return 0;
    this.flushing = true;
    try {
      let sent = 0;
      for (const [vehicleId, list] of Object.entries(this.digest.items)) {
        if (!list.length) continue;
        const ok = await this.submit(list, vehicleId, `digest:${this.digest.next_at ?? this.deps.now()}`);
        if (ok) {
          sent += list.length;
          this.digest.items[vehicleId] = [];
        }
      }
      this.digest.next_at = this.nextAt(this.deps.now());
      this.dirty = true;
      this.save(true);
      return sent;
    } finally {
      this.flushing = false;
    }
  }

  /** Pending digest items per vehicle (ops / tests). */
  pending(): Record<string, number> {
    return Object.fromEntries(Object.entries(this.digest.items).map(([k, v]) => [k, v.length]));
  }

  /**
   * Run the REST pulls that are due (one pass over the cars). Each pull kind has its own try/catch,
   * so one failure never stops the others. ANY error backs that kind off for PULL_RETRY_MS (the
   * attempt time is persisted in CarState.pullFails), so a 404 or 500 is not retried every tick
   * (each Fleet answer below 500 is billed). 429 / auth errors additionally pause every Fleet API
   * pull (Retry-After, or 1 h); the public NHTSA recall lookup is not affected by that pause.
   */
  async pullDue(): Promise<OwnershipEvent[]> {
    const r = this.cfg.rest;
    if (!r?.enabled || !this.rest) return [];
    const rest = this.rest;
    const now = this.deps.now();
    const ts = new Date(now).toISOString();
    const events: OwnershipEvent[] = [];
    const hours = { service: r.service_h ?? 24, warranty: r.warranty_h ?? 168, recalls: r.recalls_h ?? 168, recent_alerts: r.recent_alerts_h ?? 0 };
    type Kind = keyof typeof hours | "release_notes";
    for (const [vin, t] of this.trackers) {
      const pulls = (t.state.pulls ??= {});
      const fails = (t.state.pullFails ??= {});
      const coolingDown = (k: Kind) => now - (fails[k] ?? -Infinity) < PULL_RETRY_MS;
      const fleetPaused = () => now < this.restBackoffUntil;
      const due = (k: keyof typeof hours) => hours[k] > 0 && now - (pulls[k] ?? 0) >= hours[k] * 3600_000 && !coolingDown(k);
      const attempt = async (k: Kind, fleet: boolean, run: () => Promise<void>): Promise<void> => {
        if (fleet && fleetPaused()) return;
        try {
          await run();
          delete fails[k];
        } catch (err) {
          fails[k] = now;
          const e = err instanceof EnergyApiError ? err : new EnergyApiError("fleet_api_unreachable");
          this.ctx.audit({ action: "observe", outcome: "error", reason: e.code, type: `ownership_rest_${k}`, actor: vin, actorKeep: "full", status: e.status });
          if (fleet && e.code === "rate_limited") this.restBackoffUntil = Math.max(this.restBackoffUntil, now + (e.retryAfterSec ?? 60) * 1000);
          else if (fleet && ["unauthorized", "login_required", "missing_scope", "no_token"].includes(e.code)) this.restBackoffUntil = Math.max(this.restBackoffUntil, now + PULL_RETRY_MS);
        }
      };
      if (due("service")) {
        await attempt("service", true, async () => {
          const s = parseServiceData(await rest.serviceData(vin));
          pulls.service = now;
          events.push(...t.serviceStatus(s.status, s.etc, ts));
        });
      }
      if (due("warranty")) {
        await attempt("warranty", true, async () => {
          const w = parseWarranty(await rest.warranty(vin));
          pulls.warranty = now;
          if (w.length) events.push(...t.warranty(w, ts));
        });
      }
      if (due("recalls")) {
        await attempt("recalls", false, async () => {
          const dec = decodeTeslaVin(vin);
          const model = t.vehicle.model ?? dec.model;
          const year = t.vehicle.model_year ?? dec.modelYear;
          if (!model || !year) {
            pulls.recalls = now;
            this.ctx.audit({ action: "observe", outcome: "skipped", reason: "recalls_model_unknown", actor: vin, actorKeep: "full" });
            return;
          }
          const items = parseNhtsaRecalls(await rest.recalls(model, year));
          pulls.recalls = now;
          events.push(...t.recalls(items, ts));
        });
      }
      if (due("recent_alerts")) {
        await attempt("recent_alerts", true, async () => {
          const a = parseRecentAlerts(await rest.recentAlerts(vin));
          pulls.recent_alerts = now;
          events.push(...t.alerts(a, ts, "rest"));
        });
      }
      const notesFor = this.pendingNotes.get(t.vehicle.vehicle_id);
      if (notesFor && !coolingDown("release_notes")) {
        await attempt("release_notes", true, async () => {
          const notes = parseReleaseNotes(await rest.releaseNotes(vin));
          this.pendingNotes.delete(t.vehicle.vehicle_id);
          events.push(...t.releaseNotes(notesFor, notes, ts));
        });
      }
      t.prune(now);
    }
    this.dirty = true;
    await this.emit(events);
    return events;
  }

  private load(): void {
    if (!this.file) return;
    let raw: StateFile;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as StateFile;
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object" || raw.version !== 1 || !raw.cars || typeof raw.cars !== "object" || Array.isArray(raw.cars)) return;
    // Shape-check everything read back: a malformed car or digest entry is dropped (one warning), never thrown on.
    let dropped = 0;
    const cars: Record<string, CarState> = {};
    for (const [id, c] of Object.entries(raw.cars as Record<string, unknown>)) {
      const clean = sanitizeCarState(c);
      if (!clean || !/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
        dropped++;
        continue;
      }
      dropped += clean.dropped;
      cars[id] = clean.state;
    }
    this.cars = cars;
    const d = sanitizeDigest(raw.digest);
    this.digest = d.digest;
    dropped += d.dropped;
    if (dropped) this.ctx.audit({ action: "observe", outcome: "error", reason: "ownership_state_malformed_dropped", count: dropped });
    this.ctx.audit({ action: "observe", outcome: "ok", reason: "ownership_state_restored", count: Object.keys(this.cars).length });
  }

  /** Atomic, mode 600. Throttled unless forced (events are always saved right away for dedupe). */
  private save(force: boolean): void {
    if (!this.file || !this.dirty) return;
    const now = this.deps.now();
    if (!force && now - this.lastSave < SAVE_EVERY_MS) return;
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify({ version: 1, cars: this.cars, digest: this.digest } satisfies StateFile), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
      this.dirty = false;
      this.lastSave = now;
    } catch {
      this.ctx.audit({ action: "observe", outcome: "error", reason: "ownership_state_write_failed" });
    }
  }

  health(): Record<string, unknown> {
    return { cars: this.trackers.size, digestPending: Object.values(this.digest.items).reduce((a, l) => a + l.length, 0), restEnabled: Boolean(this.rest) };
  }
}

