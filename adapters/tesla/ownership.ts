import { createHash } from "node:crypto";
import {
  enumName,
  num,
  type CoarseLocation,
  type TelemetryValue,
  type TireSet,
  type VehicleAlertRecord,
} from "./fields.js";

/**
 * Ownership events: change-only, deduped facts about each car (software updates, odometer
 * milestones, alerts, service, tires, battery health, charging faults, safety, Sentry), built from
 * the same telemetry the wake triggers read plus a slow REST pull (recalls, warranty, service
 * status, release notes). Never a raw stream: every event is one change, keyed for dedupe, and
 * either sent right away (tier "immediate") or batched into a weekly digest.
 *
 * Field names are the ones in teslamotors/fleet-telemetry protos/vehicle_data.proto and
 * vehicle_alert.proto; see adapters/tesla/README.md "Ownership events" for the mapping and for
 * what Tesla does not expose (there is no airbag / collision / AEB-activation / 12V / charging
 * error-code field; those come only from alert names, matched by configurable patterns).
 *
 * What is never sent: a location trail (Location is rounded to city level on ingest and only
 * attached to safety and service events), tokens or keys, cabin or camera media, full VINs.
 */

export const OWNERSHIP_EVENT_TYPES = [
  "software_update",
  "odometer_milestone",
  "vehicle_alert",
  "service_mode",
  "tpms",
  "12v_or_hv_battery",
  "charging_fault",
  "collision_or_safety",
  "sentry_or_security",
  "recall",
  "warranty_status",
] as const;
export type OwnershipEventType = (typeof OWNERSHIP_EVENT_TYPES)[number];

export type Tier = "immediate" | "digest";

/** The envelope every ownership event carries. */
export interface OwnershipEvent {
  vehicle_id: string;
  vin_last6: string;
  /** Model / trim label (config label, else CarType + Trim from telemetry, else decoded from the VIN). */
  model: string;
  /** UTC ISO time of the change. */
  ts: string;
  source: "telemetry" | "rest";
  event_type: OwnershipEventType;
  tier: Tier;
  priority: "high" | "normal";
  /** Stable key: the same change never produces two events. */
  dedupe_key: string;
  data: Record<string, unknown>;
  /** City-level only, and only on collision_or_safety and service events. */
  location?: CoarseLocation;
}

export interface OwnershipVehicle {
  vin: string;
  /** Short id used in events and state (default "car-" + 8 hex of a hash of the VIN). */
  vehicle_id?: string;
  /** Model/trim label, e.g. "Model 3 Long Range". */
  label?: string;
  /** For the recall lookup when it can't be read from the VIN. */
  model?: string;
  model_year?: number;
}

export interface OwnershipRules {
  /** Odometer milestone step in miles (default 1000). */
  odometer_step_mi?: number;
  tpms?: {
    /** Recommended cold pressure (default 42 psi). */
    recommended_psi?: number;
    /** Below this a tire is "low" (default recommended - 3). */
    low_psi?: number;
    /** Above this a tire is "high" (default recommended + 6). */
    high_psi?: number;
    /** Low by more than this vs recommended = immediate (default 5). */
    immediate_low_by_psi?: number;
  };
  alerts?: {
    /** Audiences whose new alerts are sent right away (default ["Customer"]). */
    immediate_audiences?: string[];
    /** Alert-name regexes treated as critical (immediate). Default none. */
    critical_patterns?: string[];
    /** Alert-name regexes mapped to collision_or_safety (immediate). */
    safety_patterns?: string[];
    /** Alert-name regexes mapped to charging_fault (the name is the error code). */
    charging_patterns?: string[];
    /** Alert-name regexes mapped to 12v_or_hv_battery (12V warning). */
    lv_battery_patterns?: string[];
    /** Alert-name regexes mapped to software_update failed. */
    update_failed_patterns?: string[];
  };
  /** Monthly HV reading only from a BatteryLevel at or above this (default 50, less extrapolation). */
  hv_min_battery_level?: number;
  /** Attach city-level location to safety / service events (needs Location in the fields). Default true. */
  location?: boolean;
}

/**
 * Default alert-name patterns. Tesla does not publish the alert name list, so these are
 * heuristics, not verified names: check them against your cars' alerts (the plugin's
 * get_recent_alerts read) and override them in config.
 */
export const DEFAULT_PATTERNS = {
  safety_patterns: ["airbag", "crash", "collision_detected", "(^|_)AEB_?(ACTIVE|EVENT|BRAKE)", "^RCM\\d*_"],
  charging_patterns: ["^(CHG|CHGS|CP|UMC|PCS|BMS_.*CHG)_"],
  lv_battery_patterns: ["12V", "(^|_)LV_?BATT?"],
  update_failed_patterns: ["UPDATE.*FAIL", "FAIL.*UPDATE"],
  critical_patterns: [] as string[],
};

export const BAR_TO_PSI = 14.5038;
const TIRES = ["fl", "fr", "rl", "rr"] as const;
type Tire = (typeof TIRES)[number];
const TPMS_FIELD: Record<Tire, string> = { fl: "TpmsPressureFl", fr: "TpmsPressureFr", rl: "TpmsPressureRl", rr: "TpmsPressureRr" };
type Band = "ok" | "low" | "very_low" | "high";

/** Everything remembered per car (persisted, keyed by vehicle_id; never the VIN). */
export interface CarState {
  version?: string;
  swTarget?: string;
  swPhase?: "idle" | "available" | "installing";
  swInstallPct?: number;
  /** SoftwareUpdateVersion has been seen at least once (the first value is a baseline). */
  swSeen?: boolean;
  odoMilestone?: number;
  odometer?: number;
  serviceMode?: boolean;
  serviceStatus?: string;
  tpmsBand?: Partial<Record<Tire, Band>>;
  tpmsSoft?: TireSet;
  tpmsHard?: TireSet;
  charge?: string;
  chargeEnable?: boolean;
  chargeLimit?: number;
  battery?: number;
  ratedRange?: number;
  energyRemaining?: number;
  nominalFullPack?: number;
  bms?: string;
  hvil?: string;
  sentry?: string;
  aebOff?: boolean;
  carType?: string;
  trim?: string;
  hvMonth?: string;
  /** Alert keys (name|startedAt) seen active / seen ended. */
  alertsActive?: string[];
  alertsEnded?: string[];
  /** Last charging-pattern alert (name + ms) to attach as the error code of an interruption. */
  lastChargeAlert?: { name: string; at: number };
  recalls?: string[];
  recallsBaselined?: boolean;
  warrantyHash?: string;
  /** Last REST pull per kind (ms). */
  pulls?: Record<string, number>;
  /** Dedupe keys already emitted (key -> ms), pruned after 400 days. */
  emitted?: Record<string, number>;
}

const MAX_LIST = 200;
const EMITTED_TTL_MS = 400 * 86400_000;

/** "car-" + 8 hex of sha256(VIN): stable, short, not reversible to the VIN in practice. */
export function defaultVehicleId(vin: string): string {
  return `car-${createHash("sha256").update(vin).digest("hex").slice(0, 8)}`;
}

/** Tesla VIN position 4 (model) and 10 (model year). Undefined for other makes or unknown codes. */
export function decodeTeslaVin(vin: string): { model?: string; modelYear?: number } {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return {};
  const models: Record<string, string> = { S: "Model S", X: "Model X", "3": "Model 3", Y: "Model Y", C: "Cybertruck" };
  const years = "ABCDEFGHJKLMNPRSTVWXY";
  const yi = years.indexOf(vin[9]);
  return { model: models[vin[3]], modelYear: yi >= 0 ? 2010 + yi : undefined };
}

const CAR_TYPE: Record<string, string> = { ModelS: "Model S", ModelX: "Model X", Model3: "Model 3", ModelY: "Model Y", Cybertruck: "Cybertruck", SemiTruck: "Semi" };

function compile(list: string[] | undefined, fallback: string[]): RegExp[] {
  return (list ?? fallback).map((p) => new RegExp(p, "i"));
}

/** Problems with the ownership rules (patterns must compile, numbers in range). */
export function validateOwnershipRules(r: OwnershipRules | undefined, at = "tesla.ownership"): string[] {
  const p: string[] = [];
  if (!r) return p;
  if (r.odometer_step_mi !== undefined && !(Number.isFinite(r.odometer_step_mi) && r.odometer_step_mi >= 100)) p.push(`${at}.odometer_step_mi must be >= 100`);
  const t = r.tpms ?? {};
  for (const k of ["recommended_psi", "low_psi", "high_psi", "immediate_low_by_psi"] as const) {
    const v = t[k];
    if (v !== undefined && !(Number.isFinite(v) && v > 0 && v < 150)) p.push(`${at}.tpms.${k} must be a psi value between 0 and 150`);
  }
  if (r.hv_min_battery_level !== undefined && !(r.hv_min_battery_level >= 10 && r.hv_min_battery_level <= 100)) p.push(`${at}.hv_min_battery_level must be 10-100`);
  for (const [k, v] of Object.entries(r.alerts ?? {})) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length > 200)) {
      p.push(`${at}.alerts.${k} must be an array of strings (max 200 chars each)`);
      continue;
    }
    if (k === "immediate_audiences") continue;
    for (const x of v) {
      try {
        new RegExp(x, "i");
      } catch {
        p.push(`${at}.alerts.${k}: ${JSON.stringify(x)} is not a valid regex`);
      }
    }
  }
  return p;
}

const text = (v: TelemetryValue | undefined) => (typeof v === "string" ? v.trim() : undefined);
const bool = (v: TelemetryValue | undefined) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Pure per-car state machine. Feed it telemetry deltas, alerts and REST results; it returns the
 * events to send and mutates the CarState it was given. `baseline` folds values in without
 * emitting (first value after a restart, MQTT retained, is_resend).
 */
export class OwnershipTracker {
  private readonly re: {
    safety: RegExp[];
    charging: RegExp[];
    lv: RegExp[];
    updateFailed: RegExp[];
    critical: RegExp[];
  };
  constructor(
    readonly vehicle: { vin: string; vehicle_id: string; label?: string; model?: string; model_year?: number },
    readonly state: CarState,
    private readonly rules: OwnershipRules = {},
  ) {
    const a = rules.alerts ?? {};
    this.re = {
      safety: compile(a.safety_patterns, DEFAULT_PATTERNS.safety_patterns),
      charging: compile(a.charging_patterns, DEFAULT_PATTERNS.charging_patterns),
      lv: compile(a.lv_battery_patterns, DEFAULT_PATTERNS.lv_battery_patterns),
      updateFailed: compile(a.update_failed_patterns, DEFAULT_PATTERNS.update_failed_patterns),
      critical: compile(a.critical_patterns, DEFAULT_PATTERNS.critical_patterns),
    };
  }

  /** Model/trim label for the envelope. */
  model(): string {
    if (this.vehicle.label) return this.vehicle.label;
    const ct = this.state.carType ? CAR_TYPE[enumName("CarType" as never, this.state.carType).replace(/^CarType/, "")] : undefined;
    const base = ct ?? this.vehicle.model ?? decodeTeslaVin(this.vehicle.vin).model ?? "Tesla";
    return this.state.trim ? `${base} ${this.state.trim}` : base;
  }

  private loc: CoarseLocation | undefined;

  private ev(
    event_type: OwnershipEventType,
    key: string,
    data: Record<string, unknown>,
    o: { ts: string; source: "telemetry" | "rest"; tier?: Tier; priority?: "high" | "normal"; withLocation?: boolean; withOdometer?: boolean },
  ): OwnershipEvent | undefined {
    const dedupe_key = `${event_type}:${key}`;
    const em = (this.state.emitted ??= {});
    if (em[dedupe_key] !== undefined) return undefined;
    em[dedupe_key] = Date.parse(o.ts) || Date.now();
    const d = { ...data };
    if (o.withOdometer && this.state.odometer !== undefined && d.odometer_mi === undefined) d.odometer_mi = round1(this.state.odometer);
    const e: OwnershipEvent = {
      vehicle_id: this.vehicle.vehicle_id,
      vin_last6: this.vehicle.vin.slice(-6),
      model: this.model(),
      ts: o.ts,
      source: o.source,
      event_type,
      tier: o.tier ?? "digest",
      priority: o.priority ?? (event_type === "vehicle_alert" || o.tier === "immediate" ? "high" : "normal"),
      dedupe_key,
      data: d,
    };
    if (o.withLocation && this.rules.location !== false && this.loc) e.location = { ...this.loc };
    return e;
  }

  /** Drop emitted keys older than the TTL and cap the lists. */
  prune(now: number): void {
    const em = this.state.emitted ?? {};
    for (const [k, at] of Object.entries(em)) if (now - at > EMITTED_TTL_MS) delete em[k];
    const keys = Object.keys(em);
    if (keys.length > 2000) for (const k of keys.sort((a, b) => em[a] - em[b]).slice(0, keys.length - 2000)) delete em[k];
    for (const k of ["alertsActive", "alertsEnded", "recalls"] as const) {
      const l = this.state[k];
      if (l && l.length > MAX_LIST) this.state[k] = l.slice(-MAX_LIST);
    }
  }

  /** One telemetry delta (fields present in this record). */
  telemetry(data: Record<string, TelemetryValue>, ts: string, baseline = false): OwnershipEvent[] {
    const s = this.state;
    const out: (OwnershipEvent | undefined)[] = [];
    const src = { ts, source: "telemetry" as const };
    const has = (k: string) => k in data && !(typeof data[k] === "object" && data[k] !== null && (data[k] as { invalid?: boolean }).invalid === true);

    if (has("Location")) {
      const l = data.Location as CoarseLocation;
      if (typeof l === "object" && l && "lat" in l) this.loc = { lat: l.lat, lon: l.lon };
    }
    if (has("CarType")) s.carType = text(data.CarType) ?? s.carType;
    if (has("Trim")) s.trim = text(data.Trim) || s.trim;

    // Odometer first, so service events below carry the current reading.
    if (has("Odometer")) {
      const odo = num(data.Odometer);
      if (odo !== undefined && odo >= 0) {
        const step = this.rules.odometer_step_mi ?? 1000;
        const m = Math.floor(odo / step) * step;
        if (s.odoMilestone === undefined || baseline) {
          s.odoMilestone = Math.max(s.odoMilestone ?? 0, m);
        } else if (m > s.odoMilestone) {
          s.odoMilestone = m;
          out.push(this.ev("odometer_milestone", String(m), { milestone_mi: m, odometer_mi: round1(odo) }, src));
        }
        s.odometer = odo;
      }
    }

    // Software update: Version is the installed firmware, SoftwareUpdateVersion the available one.
    if (has("Version") || has("SoftwareUpdateVersion") || has("SoftwareUpdateInstallationPercentComplete")) {
      const prevVersion = s.version;
      const v = has("Version") ? text(data.Version) : undefined;
      const avail = has("SoftwareUpdateVersion") ? text(data.SoftwareUpdateVersion) ?? "" : undefined;
      const pct = has("SoftwareUpdateInstallationPercentComplete") ? num(data.SoftwareUpdateInstallationPercentComplete) : undefined;
      if (v && prevVersion && v !== prevVersion && !baseline) {
        out.push(this.ev("software_update", `done:${v}`, { phase: "done", from: prevVersion, to: v }, src));
        s.swPhase = "idle";
        s.swInstallPct = 0;
      }
      if (v) s.version = v;
      if (avail !== undefined) {
        if (avail && avail !== s.swTarget && avail !== s.version && !baseline && s.swSeen) {
          out.push(this.ev("software_update", `available:${avail}`, { phase: "available", from: s.version ?? null, to: avail }, src));
          s.swPhase = "available";
        }
        if (avail && (s.swPhase ?? "idle") === "idle" && baseline) s.swPhase = "available";
        s.swTarget = avail || (s.swPhase === "installing" ? s.swTarget : undefined);
        if (!avail && s.swPhase === "available") s.swPhase = "idle";
        s.swSeen = true;
      }
      if (pct !== undefined) {
        const known = s.swInstallPct !== undefined;
        const was = s.swInstallPct ?? 0;
        if (pct > 0 && was === 0 && known && s.swPhase !== "installing" && !baseline) {
          out.push(this.ev("software_update", `installing:${s.swTarget ?? "unknown"}`, { phase: "installing", from: s.version ?? null, to: s.swTarget ?? null }, src));
        }
        if (pct > 0) s.swPhase = "installing";
        // Back to 0 while still on the old version, with the update still offered: inferred failure.
        if (pct === 0 && was > 0 && s.swPhase === "installing" && !baseline && (v === undefined || v === prevVersion) && s.swTarget && s.swTarget !== s.version) {
          out.push(this.ev("software_update", `failed:${s.swTarget}:${ts}`, { phase: "failed", from: s.version ?? null, to: s.swTarget, inferred: true, reason: "install progress reset without a version change" }, { ...src, tier: "immediate", priority: "high" }));
          s.swPhase = "available";
        }
        s.swInstallPct = pct;
      }
    }

    if (has("ServiceMode")) {
      const on = bool(data.ServiceMode);
      if (on !== undefined) {
        if (s.serviceMode !== undefined && on !== s.serviceMode && !baseline) {
          out.push(this.ev("service_mode", `${on ? "on" : "off"}:${ts}`, { state: on ? "on" : "off" }, { ...src, withLocation: true, withOdometer: true }));
        }
        s.serviceMode = on;
      }
    }

    out.push(...this.tpms(data, ts, baseline));

    // Charging: interruption = Charging/Starting -> NoPower, or -> Stopped while charging is still
    // enabled (ChargeEnableRequest true) and below the limit. The code is the last charging alert.
    if (has("ChargeEnableRequest")) s.chargeEnable = bool(data.ChargeEnableRequest) ?? s.chargeEnable;
    if (has("ChargeLimitSoc")) s.chargeLimit = num(data.ChargeLimitSoc) ?? s.chargeLimit;
    if (has("BatteryLevel")) s.battery = num(data.BatteryLevel) ?? s.battery;
    if (has("DetailedChargeState")) {
      const now = enumName("DetailedChargeState", data.DetailedChargeState);
      const was = s.charge;
      if (was && now !== was && !baseline && (was === "Charging" || was === "Starting")) {
        const belowLimit = s.battery === undefined || s.chargeLimit === undefined || s.battery < s.chargeLimit - 1;
        const interrupted = now === "NoPower" || (now === "Stopped" && s.chargeEnable === true && belowLimit);
        if (interrupted) {
          const code = s.lastChargeAlert && Date.parse(ts) - s.lastChargeAlert.at < 15 * 60_000 ? s.lastChargeAlert.name : null;
          out.push(this.ev("charging_fault", `interrupted:${ts}`, { kind: now === "NoPower" ? "power_lost" : "stopped_while_enabled", from: was, to: now, error_code: code, battery_level: s.battery ?? null, inferred: now === "Stopped" }, src));
        }
      }
      if (now) s.charge = now;
    }

    // HV health: BMS / HV interlock faults (critical), plus one reading per UTC month.
    if (has("RatedRange")) s.ratedRange = num(data.RatedRange) ?? s.ratedRange;
    if (has("EnergyRemaining")) s.energyRemaining = num(data.EnergyRemaining) ?? s.energyRemaining;
    if (has("NominalFullPackEnergyKwh")) s.nominalFullPack = num(data.NominalFullPackEnergyKwh) ?? s.nominalFullPack;
    for (const [field, key, fault] of [["BMSState", "bms", "Fault"], ["Hvil", "hvil", "Fault"]] as const) {
      if (!has(field)) continue;
      const v = enumName(field as never, data[field]).replace(/^(BMSState|HvilStatus)/, "");
      if (v === fault && s[key] !== fault && s[key] !== undefined && !baseline) {
        out.push(this.ev("12v_or_hv_battery", `${field}_fault:${ts}`, { kind: "hv_fault", signal: field, value: v }, { ...src, tier: "immediate", priority: "high", withOdometer: true }));
      }
      s[key] = v;
    }
    out.push(this.hvMonthly(ts, baseline));

    // Sentry: count + timestamp only. Panic -> Aware is the same incident.
    if (has("SentryMode")) {
      const now = enumName("SentryMode", data.SentryMode);
      const was = s.sentry;
      if (was !== undefined && now !== was && !baseline && (now === "Panic" || (now === "Aware" && was !== "Panic"))) {
        out.push(this.ev("sentry_or_security", `sentry:${ts}`, { count: 1, last_at: ts }, src));
      }
      if (now) s.sentry = now;
    }

    if (has("AutomaticEmergencyBrakingOff")) {
      const off = bool(data.AutomaticEmergencyBrakingOff);
      if (off !== undefined && s.aebOff !== undefined && off !== s.aebOff && !baseline) {
        out.push(this.ev("collision_or_safety", `aeb_setting:${off ? "off" : "on"}:${ts}`, { kind: "aeb_setting", aeb_disabled: off }, src));
      }
      if (off !== undefined) s.aebOff = off;
    }
    return out.filter((e): e is OwnershipEvent => e !== undefined);
  }

  private tpms(data: Record<string, TelemetryValue>, ts: string, baseline: boolean): (OwnershipEvent | undefined)[] {
    const s = this.state;
    const out: (OwnershipEvent | undefined)[] = [];
    const t = this.rules.tpms ?? {};
    const rec = t.recommended_psi ?? 42;
    const low = t.low_psi ?? rec - 3;
    const high = t.high_psi ?? rec + 6;
    const veryLow = rec - (t.immediate_low_by_psi ?? 5);
    const bands = (s.tpmsBand ??= {});
    for (const tire of TIRES) {
      const bar = num(data[TPMS_FIELD[tire]]);
      if (bar === undefined || bar <= 0) continue;
      const psi = round1(bar * BAR_TO_PSI);
      const prev = bands[tire];
      // 0.5 psi hysteresis on the way back so a tire sitting on a threshold doesn't flap.
      let band: Band = psi < veryLow ? "very_low" : psi < low ? "low" : psi > high ? "high" : "ok";
      if (prev === "very_low" && psi < veryLow + 0.5) band = "very_low";
      else if ((prev === "very_low" || prev === "low") && band === "ok" && psi < low + 0.5) band = "low";
      else if (prev === "high" && band === "ok" && psi > high - 0.5) band = "high";
      // A tire already out of range when first seen is reported (once: the band is persisted).
      if (band !== (prev ?? "ok") && !baseline) {
        out.push(this.ev("tpms", `${tire}:${band}:${ts}`, { tire, psi, state: band, recommended_psi: rec, low_by_psi: round1(Math.max(0, rec - psi)) }, { ts, source: "telemetry", tier: band === "very_low" ? "immediate" : "digest", priority: band === "very_low" ? "high" : "normal" }));
      }
      bands[tire] = band;
    }
    for (const [field, key, level] of [["TpmsSoftWarnings", "tpmsSoft", "soft"], ["TpmsHardWarnings", "tpmsHard", "hard"]] as const) {
      if (!(field in data)) continue;
      const v = data[field] as TireSet | undefined;
      if (!v || typeof v !== "object" || "invalid" in v) continue;
      const was = s[key] ?? {};
      const added = TIRES.filter((x) => v[x] === true && was[x] !== true);
      if (added.length && s[key] !== undefined && !baseline) {
        out.push(this.ev("tpms", `${level}_warning:${added.join(",")}:${ts}`, { warning: level, tires: added }, { ts, source: "telemetry" }));
      }
      s[key] = { ...v };
    }
    return out;
  }

  private hvMonthly(ts: string, baseline: boolean): OwnershipEvent | undefined {
    const s = this.state;
    const month = ts.slice(0, 7);
    if (baseline || s.hvMonth === month || s.battery === undefined || s.battery < (this.rules.hv_min_battery_level ?? 50)) return undefined;
    if (s.ratedRange === undefined && s.energyRemaining === undefined && s.nominalFullPack === undefined) return undefined;
    s.hvMonth = month;
    const scale = 100 / s.battery;
    return this.ev("12v_or_hv_battery", `hv_monthly:${month}`, {
      kind: "hv_monthly",
      month,
      battery_level: round1(s.battery),
      range_at_100_mi: s.ratedRange !== undefined ? round1(s.ratedRange * scale) : null,
      pack_energy_at_100_kwh: s.energyRemaining !== undefined ? round1(s.energyRemaining * scale) : null,
      nominal_full_pack_kwh: s.nominalFullPack ?? null,
      note: "range and pack energy at 100% are extrapolated from the current battery level",
    }, { ts, source: "telemetry" });
  }

  /** Alerts (telemetry Alerts stream, or the REST recent-alerts pull). */
  alerts(list: VehicleAlertRecord[], ts: string, source: "telemetry" | "rest", baseline = false): OwnershipEvent[] {
    const s = this.state;
    const active = new Set(s.alertsActive ?? []);
    const ended = new Set(s.alertsEnded ?? []);
    const out: (OwnershipEvent | undefined)[] = [];
    const immAud = new Set((this.rules.alerts?.immediate_audiences ?? ["Customer"]).map((a) => a.toLowerCase()));
    for (const a of list) {
      const key = `${a.name}|${a.startedAt ?? ""}`;
      const isEnd = a.endedAt !== undefined;
      if (isEnd ? ended.has(key) : active.has(key) || ended.has(key)) continue;
      if (isEnd) {
        ended.add(key);
        active.delete(key);
      } else active.add(key);
      const at = a.endedAt ?? a.startedAt ?? ts;
      const evTs = Date.parse(at) ? at : ts;
      if (/charg/i.test(a.name) || this.re.charging.some((r) => r.test(a.name))) {
        if (!isEnd) s.lastChargeAlert = { name: a.name, at: Date.parse(evTs) || Date.parse(ts) };
      }
      if (baseline) continue;
      const base = { name: a.name, audiences: a.audiences, started_at: a.startedAt ?? null, ended_at: a.endedAt ?? null, active: !isEnd };
      const service = a.audiences.some((x) => /^service/i.test(x));
      const o = { ts: evTs, source, withOdometer: service };
      if (this.re.safety.some((r) => r.test(a.name))) {
        out.push(this.ev("collision_or_safety", `alert:${key}:${isEnd ? "end" : "start"}`, { kind: "alert", ...base }, { ...o, tier: isEnd ? "digest" : "immediate", priority: "high", withLocation: true, withOdometer: true }));
      } else if (this.re.updateFailed.some((r) => r.test(a.name))) {
        if (!isEnd) out.push(this.ev("software_update", `failed_alert:${key}`, { phase: "failed", from: s.version ?? null, to: s.swTarget ?? null, alert: a.name }, { ...o, tier: "immediate", priority: "high" }));
      } else if (this.re.lv.some((r) => r.test(a.name))) {
        out.push(this.ev("12v_or_hv_battery", `alert:${key}:${isEnd ? "end" : "start"}`, { kind: "12v_warning", ...base }, o));
      } else if (this.re.charging.some((r) => r.test(a.name))) {
        out.push(this.ev("charging_fault", `alert:${key}:${isEnd ? "end" : "start"}`, { kind: "alert", error_code: a.name, ...base }, o));
      } else {
        const critical = !isEnd && (this.re.critical.some((r) => r.test(a.name)) || a.audiences.some((x) => immAud.has(x.toLowerCase())));
        out.push(this.ev("vehicle_alert", `${key}:${isEnd ? "end" : "start"}`, base, { ...o, tier: critical ? "immediate" : "digest", priority: "high" }));
      }
    }
    s.alertsActive = [...active].slice(-MAX_LIST);
    s.alertsEnded = [...ended].slice(-MAX_LIST);
    return out.filter((e): e is OwnershipEvent => e !== undefined);
  }

  /** NHTSA recalls for the car's make/model/year. The first pull is a baseline (one digest line). */
  recalls(list: RecallItem[], ts: string): OwnershipEvent[] {
    const s = this.state;
    const seen = new Set(s.recalls ?? []);
    const fresh = list.filter((r) => r.campaign && !seen.has(r.campaign));
    for (const r of fresh) seen.add(r.campaign);
    s.recalls = [...seen].slice(-MAX_LIST);
    if (!fresh.length) {
      s.recallsBaselined = true;
      return [];
    }
    if (!s.recallsBaselined) {
      s.recallsBaselined = true;
      const e = this.ev("recall", `baseline:${ts.slice(0, 10)}`, { kind: "baseline", count: fresh.length, campaigns: fresh.map((r) => r.campaign).slice(0, 50), scope: RECALL_SCOPE }, { ts, source: "rest", withOdometer: true });
      return e ? [e] : [];
    }
    return fresh
      .map((r) => this.ev("recall", r.campaign, { kind: "new", ...r, scope: RECALL_SCOPE }, { ts, source: "rest", tier: "immediate", priority: "high", withOdometer: true }))
      .filter((e): e is OwnershipEvent => e !== undefined);
  }

  /** Warranty summary; sent when it changes (first pull included, as a digest line). */
  warranty(items: WarrantySummary[], ts: string): OwnershipEvent[] {
    const h = createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 16);
    if (h === this.state.warrantyHash) return [];
    this.state.warrantyHash = h;
    const e = this.ev("warranty_status", h, { items }, { ts, source: "rest", withOdometer: true });
    return e ? [e] : [];
  }

  /** Service status from service_data: arriving at / leaving a Service Center. */
  serviceStatus(status: string | undefined, etc: string | undefined, ts: string): OwnershipEvent[] {
    if (!status) return [];
    const was = this.state.serviceStatus;
    this.state.serviceStatus = status;
    if (was === undefined || was === status) return [];
    const inNow = isInService(status);
    if (inNow === isInService(was)) return [];
    const e = this.ev("service_mode", `service_center:${inNow ? "arrived" : "left"}:${ts}`, { state: inNow ? "at_service_center" : "left_service_center", service_status: status, estimated_completion: etc ?? null }, { ts, source: "rest", withLocation: true, withOdometer: true });
    return e ? [e] : [];
  }

  /** Release notes for a version that was just installed. */
  releaseNotes(version: string, notes: { title: string; subtitle?: string }[], ts: string): OwnershipEvent[] {
    if (!notes.length) return [];
    const e = this.ev("software_update", `release_notes:${version}`, { phase: "release_notes", version, notes }, { ts, source: "rest" });
    return e ? [e] : [];
  }
}

export const RECALL_SCOPE = "NHTSA recalls for this make/model/year; whether one is open or done for this exact car is only in the Tesla app or Tesla's VIN recall search";

export const isInService = (s: string) => /in_service|in-service|inservice/i.test(s) && !/not_in_service|not-in-service|notinservice/i.test(s);

export interface RecallItem {
  campaign: string;
  component?: string;
  summary?: string;
  remedy?: string;
  report_date?: string;
  over_the_air?: boolean;
  park_it?: boolean;
  park_outside?: boolean;
}

export interface WarrantySummary {
  type?: string;
  name?: string;
  status: "active" | "upcoming" | "expired";
  expiration_date?: string;
  expiration_odometer?: number;
  odometer_unit?: string;
}

const clip = (v: unknown, n: number) => (typeof v === "string" ? (v.length > n ? `${v.slice(0, n - 1)}…` : v) : undefined);

/** NHTSA recallsByVehicle results -> RecallItem[] (only these keys are read). */
export function parseNhtsaRecalls(body: unknown): RecallItem[] {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const out: RecallItem[] = [];
  for (const r of results) {
    const o = r as Record<string, unknown>;
    const campaign = typeof o.NHTSACampaignNumber === "string" ? o.NHTSACampaignNumber.trim() : "";
    if (!/^[A-Z0-9]{5,16}$/i.test(campaign)) continue;
    out.push({
      campaign,
      component: clip(o.Component, 200),
      summary: clip(o.Summary, 600),
      remedy: clip(o.Remedy, 400),
      report_date: clip(o.ReportReceivedDate, 40),
      over_the_air: typeof o.overTheAirUpdate === "boolean" ? o.overTheAirUpdate : undefined,
      park_it: typeof o.parkIt === "boolean" ? o.parkIt : undefined,
      park_outside: typeof o.parkOutSide === "boolean" ? o.parkOutSide : undefined,
    });
  }
  return out;
}

/** Fleet API dx/warranty/details -> summary (activeWarranty / upcomingWarranty / expiredWarranty, WarrantyItem keys only). */
export function parseWarranty(body: unknown): WarrantySummary[] {
  const r = ((body as { response?: unknown })?.response ?? body) as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return [];
  const out: WarrantySummary[] = [];
  for (const [k, status] of [["activeWarranty", "active"], ["upcomingWarranty", "upcoming"], ["expiredWarranty", "expired"]] as const) {
    const list = r[k];
    if (!Array.isArray(list)) continue;
    for (const i of list) {
      const o = i as Record<string, unknown>;
      out.push({
        status,
        type: clip(o.warrantyType, 60),
        name: clip(o.warrantyDisplayName, 120),
        expiration_date: clip(o.expirationDate ?? o.warrantyExpiredOn, 40),
        expiration_odometer: typeof o.expirationOdometer === "number" ? o.expirationOdometer : undefined,
        odometer_unit: clip(o.odometerUnit, 20),
      });
    }
  }
  return out;
}

/**
 * service_data -> { status, etc }. Tesla documents the endpoint but not its body; this reads only
 * `service_status` and `service_etc` (the keys the endpoint is known to return) and ignores the rest.
 */
export function parseServiceData(body: unknown): { status?: string; etc?: string } {
  const r = ((body as { response?: unknown })?.response ?? body) as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return {};
  return { status: clip(r.service_status, 60), etc: clip(r.service_etc, 40) };
}

/** release_notes -> titles (no descriptions' media, no image URLs). Body shape is undocumented: read defensively. */
export function parseReleaseNotes(body: unknown): { title: string; subtitle?: string }[] {
  const r = ((body as { response?: unknown })?.response ?? body) as Record<string, unknown> | undefined;
  const list = r && typeof r === "object" ? (r.release_notes ?? r.notes) : undefined;
  if (!Array.isArray(list)) return [];
  const out: { title: string; subtitle?: string }[] = [];
  for (const n of list.slice(0, 30)) {
    const o = n as Record<string, unknown>;
    const title = clip(o.title, 120);
    if (title) out.push({ title, subtitle: clip(o.subtitle, 160) });
  }
  return out;
}

/** recent_alerts -> alerts (Owner-API-era shape: { name, time, audience[] }; undocumented, read defensively). */
export function parseRecentAlerts(body: unknown): VehicleAlertRecord[] {
  const r = ((body as { response?: unknown })?.response ?? body) as Record<string, unknown> | undefined;
  const list = r && typeof r === "object" ? r.recent_alerts : undefined;
  if (!Array.isArray(list)) return [];
  const out: VehicleAlertRecord[] = [];
  for (const a of list.slice(0, 100)) {
    const o = a as Record<string, unknown>;
    if (typeof o.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(o.name)) continue;
    const t = typeof o.time === "string" && !Number.isNaN(Date.parse(o.time)) ? new Date(Date.parse(o.time)).toISOString() : undefined;
    const aud = Array.isArray(o.audience) ? o.audience.filter((x): x is string => typeof x === "string") : [];
    // Normalise "customer" / "service" / "service-fix" to the telemetry Audience names.
    const norm = aud.map((x) => (/^service[-_]?fix$/i.test(x) ? "ServiceFix" : x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()));
    out.push({ name: o.name, audiences: norm, startedAt: t });
  }
  return out;
}

/**
 * Weekly digest: digest-tier events wait here (persisted), coalesced by dedupe key (a repeated
 * key replaces the older entry; sentry entries add up), and go out once per car per period.
 */
export interface DigestState {
  next_at?: number;
  items: Record<string, OwnershipEvent[]>;
}

export const DIGEST_MAX_ITEMS = 200;

export function addToDigest(d: DigestState, e: OwnershipEvent): void {
  const list = (d.items[e.vehicle_id] ??= []);
  if (e.event_type === "sentry_or_security") {
    const prev = list.find((x) => x.event_type === "sentry_or_security");
    if (prev) {
      prev.data = { count: Number(prev.data.count ?? 0) + Number(e.data.count ?? 1), last_at: e.data.last_at ?? e.ts };
      prev.ts = e.ts;
      return;
    }
  }
  const i = list.findIndex((x) => x.dedupe_key === e.dedupe_key);
  if (i >= 0) list.splice(i, 1);
  list.push(e);
  if (list.length > DIGEST_MAX_ITEMS) list.splice(0, list.length - DIGEST_MAX_ITEMS);
}

/** Next digest time strictly after `now`: weekday (0 = Sunday) at hour_utc:00 UTC. */
export function nextDigestAt(now: number, weekday = 0, hourUtc = 13): number {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc);
  let add = (weekday - d.getUTCDay() + 7) % 7;
  if (add === 0 && t <= now) add = 7;
  return t + add * 86400_000;
}
