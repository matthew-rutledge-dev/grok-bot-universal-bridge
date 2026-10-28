/**
 * Fleet Telemetry field handling, per teslamotors/fleet-telemetry protos/vehicle_data.proto.
 *
 * Assumes the vehicle config is pushed with `prefer_typed: true`, so values arrive typed:
 * enums as prefixed names (ShiftStateP, DetailedChargeStateComplete, SentryModeStateAware,
 * CableTypeSAE), DoorState as a Doors struct of six booleans, numbers as numbers (int64
 * as a numeric string in JSON). Untyped string values ("P", "Complete") are accepted too.
 */

/** Fields the trigger logic reads. Only these are kept per VIN. */
export const KNOWN_FIELDS = [
  "DetailedChargeState",
  "ChargingCableType",
  "DoorState",
  "SentryMode",
  "BatteryLevel",
  "Gear",
  "SoftwareUpdateVersion",
] as const;
export type KnownField = (typeof KNOWN_FIELDS)[number];

/**
 * Names from older drafts that must not be used, with the replacement. ChargeCableConnected,
 * TrunkOpen and SentryAlert do not exist in the proto. ChargeState exists but is deprecated
 * and SoftwareUpdateAvailable exists but is undocumented. (Soc is allowed as stream-only below.)
 */
export const REPLACED_FIELDS: Record<string, string> = {
  ChargeState: "DetailedChargeState (ChargeState is deprecated)",
  ChargeCableConnected: "DetailedChargeState leaving/returning to Disconnected (backup: ChargingCableType)",
  TrunkOpen: "DoorState.TrunkFront / DoorState.TrunkRear",
  SentryAlert: "SentryMode (Aware, Panic)",
  SoftwareUpdateAvailable: "SoftwareUpdateVersion (empty -> a version)",
};

/**
 * Fields accepted in telemetry.fields although no trigger reads them (streamed for context,
 * e.g. by the plugin's tools). Soc is usable charge, not the app's battery %: low_battery
 * reads BatteryLevel only.
 */
export const STREAM_ONLY_FIELDS: readonly string[] = ["Soc"];

/**
 * Fields the ownership events read (adapters/tesla/ownership.ts). All are in vehicle_data.proto;
 * all but NominalFullPackEnergyKwh are on Tesla's Available Data page (that one is proto-only,
 * firmware 2026.32+). Location is only kept coarse (city level) and only attached to safety and
 * service events.
 */
export const OWNERSHIP_FIELDS = [
  "Version",
  "SoftwareUpdateVersion",
  "SoftwareUpdateInstallationPercentComplete",
  "Odometer",
  "ServiceMode",
  "TpmsPressureFl",
  "TpmsPressureFr",
  "TpmsPressureRl",
  "TpmsPressureRr",
  "TpmsSoftWarnings",
  "TpmsHardWarnings",
  "DetailedChargeState",
  "ChargeEnableRequest",
  "ChargeLimitSoc",
  "BatteryLevel",
  "RatedRange",
  "EnergyRemaining",
  "NominalFullPackEnergyKwh",
  "BMSState",
  "Hvil",
  "SentryMode",
  "AutomaticEmergencyBrakingOff",
  "CarType",
  "Trim",
  "Location",
] as const;
export type OwnershipField = (typeof OWNERSHIP_FIELDS)[number];

/** Every field a receiver keeps (trigger fields + ownership fields). */
export const ACCEPTED_FIELDS: ReadonlySet<string> = new Set<string>([...KNOWN_FIELDS, ...OWNERSHIP_FIELDS]);

/** Doors struct (proto message Doors). */
export const DOOR_KEYS = ["DriverFront", "DriverRear", "PassengerFront", "PassengerRear"] as const;
export const TRUNK_KEYS = ["TrunkFront", "TrunkRear"] as const;
export type Doors = Partial<Record<(typeof DOOR_KEYS)[number] | (typeof TRUNK_KEYS)[number], boolean>>;

/** Marker for a datum sent as `invalid: true`. */
export interface Invalid {
  invalid: true;
}
/** TireLocation struct (TpmsSoftWarnings / TpmsHardWarnings), normalised to fl/fr/rl/rr. */
export type TireSet = Partial<Record<"fl" | "fr" | "rl" | "rr", boolean>>;
/** Location, already rounded to city level on ingest (the precise value is never stored). */
export interface CoarseLocation {
  lat: number;
  lon: number;
}
export type TelemetryValue = string | number | boolean | null | Doors | Invalid | TireSet | CoarseLocation;

/** Decimal places kept for Location (1 = about 11 km, roughly city level). */
export const COARSE_DECIMALS = 1;

/** {latitude, longitude} (MQTT) or {latitude, longitude} protojson -> coarse location, or undefined. */
export function coarseLocation(v: unknown): CoarseLocation | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const lat = num(o.latitude ?? o.lat);
  const lon = num(o.longitude ?? o.lon);
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  const f = 10 ** COARSE_DECIMALS;
  return { lat: Math.round(lat * f) / f, lon: Math.round(lon * f) / f };
}

const TIRE_KEYS: Record<string, keyof TireSet> = {
  front_left: "fl", frontLeft: "fl", front_right: "fr", frontRight: "fr",
  rear_left: "rl", rearLeft: "rl", rear_right: "rr", rearRight: "rr",
};

/** TireLocation struct (snake_case from MQTT, camelCase from protojson) -> TireSet. Semi axles are ignored. */
export function tireSet(v: unknown): TireSet | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v) || isInvalid(v)) return undefined;
  const out: TireSet = {};
  for (const [k, b] of Object.entries(v as Record<string, unknown>)) {
    const t = TIRE_KEYS[k];
    if (t) out[t] = b === true || b === "true";
  }
  return out;
}

export const isInvalid = (v: unknown): v is Invalid =>
  typeof v === "object" && v !== null && (v as { invalid?: unknown }).invalid === true;

/** Enum prefix per field (typed values carry it; untyped ones do not). */
const ENUM_PREFIX: Partial<Record<KnownField, string>> = {
  Gear: "ShiftState",
  DetailedChargeState: "DetailedChargeState",
  SentryMode: "SentryModeState",
  ChargingCableType: "CableType",
};

/** "ShiftStateP" -> "P", "P" -> "P". Non-strings become "". */
export function enumName(field: KnownField, v: unknown): string {
  if (typeof v !== "string") return "";
  const prefix = ENUM_PREFIX[field];
  return prefix && v.startsWith(prefix) && v.length > prefix.length ? v.slice(prefix.length) : v;
}

/** Number() that also takes numeric strings; NaN/empty -> undefined. */
export function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function doors(v: unknown): Doors | undefined {
  if (typeof v !== "object" || v === null || isInvalid(v)) return undefined;
  const out: Doors = {};
  for (const k of [...DOOR_KEYS, ...TRUNK_KEYS]) {
    const b = (v as Record<string, unknown>)[k];
    if (b !== undefined) out[k] = b === true || b === "true";
  }
  return out;
}
const anyOpen = (d: Doors | undefined, keys: readonly string[]) => Boolean(d && keys.some((k) => d[k as keyof Doors] === true));

/** protojson Value object -> plain value. Unknown shapes -> undefined (ignored). */
export function fromProtoValue(v: unknown): TelemetryValue | undefined {
  if (v === null || typeof v !== "object") return v as TelemetryValue | undefined;
  const o = v as Record<string, unknown>;
  if (o.invalid === true) return { invalid: true };
  if ("doorValue" in o) return doors(o.doorValue) ?? {};
  if ("tireLocationValue" in o) return tireSet(o.tireLocationValue) ?? {};
  if ("locationValue" in o) return coarseLocation(o.locationValue);
  // Exactly one oneof member is meaningful; with EmitUnpopulated the others are absent (oneof).
  for (const [k, x] of Object.entries(o)) {
    if (k === "invalid") continue;
    if (!k.endsWith("Value")) continue;
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return x;
  }
  return undefined;
}

/** One decoded record, normalised. */
export interface TelemetryRecord {
  vin: string;
  createdAt: string;
  isResend?: boolean;
  /** A replayed value (e.g. an MQTT retained message): folded into state as a baseline, never fires. */
  baseline?: boolean;
  data: Record<string, TelemetryValue>;
  /** VehicleAlerts (vehicle_alert.proto), when the record is an alerts record. */
  alerts?: VehicleAlertRecord[];
  /**
   * A VehicleErrors record (vehicle_error.proto): errors from the car's telemetry client (bad
   * config, unknown field), not vehicle fault codes. Counted in audit only.
   */
  telemetryErrors?: number;
}

/** One VehicleAlert: active while endedAt is unset. Audiences: Customer, Service, ServiceFix. */
export interface VehicleAlertRecord {
  name: string;
  audiences: string[];
  startedAt?: string;
  endedAt?: string;
}

const ALERT_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * One alert, from protojson ({ name, audiences, startedAt, endedAt }) or fleet-telemetry's MQTT
 * payload ({ Name, Audiences, StartedAt, EndedAt }). Undefined when it has no usable name.
 */
export function parseAlert(raw: unknown, nameHint?: string): VehicleAlertRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : typeof o.Name === "string" ? o.Name : nameHint;
  if (typeof name !== "string" || !ALERT_NAME.test(name)) return undefined;
  const aud = (o.audiences ?? o.Audiences) as unknown;
  const audiences = Array.isArray(aud) ? aud.filter((a): a is string => typeof a === "string").map((a) => a.replace(/^AUDIENCE_/i, "")) : [];
  const ts = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : undefined);
  return { name, audiences, startedAt: ts(o.startedAt ?? o.StartedAt), endedAt: ts(o.endedAt ?? o.EndedAt) };
}

/**
 * Parse a fleet-telemetry decoded Payload (transmit_decoded_records: protojson, camelCase:
 * { data: [{ key, value: { stringValue | doubleValue | doorValue | invalid ... } }], createdAt, vin, isResend })
 * or an already-flat { vin, createdAt, data: { Field: value } }. Returns undefined when it is neither.
 */
export function parsePayload(raw: unknown): TelemetryRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const vin = typeof o.vin === "string" ? o.vin : "";
  const createdAt = typeof o.createdAt === "string" ? o.createdAt : typeof o.created_at === "string" ? o.created_at : "";
  const isResend = o.isResend === true || o.is_resend === true;
  const data: Record<string, TelemetryValue> = {};
  if (Array.isArray(o.alerts)) {
    const alerts = o.alerts.map((a) => parseAlert(a)).filter((a): a is VehicleAlertRecord => a !== undefined);
    return { vin, createdAt, isResend, data, alerts };
  }
  if (Array.isArray(o.errors)) return { vin, createdAt, isResend, data, telemetryErrors: o.errors.length };
  if (Array.isArray(o.data)) {
    for (const d of o.data) {
      const key = (d as { key?: unknown })?.key;
      if (typeof key !== "string") continue;
      const val = fromProtoValue((d as { value?: unknown }).value);
      if (val !== undefined) data[key] = val;
    }
  } else if (o.data && typeof o.data === "object") {
    for (const [k, v] of Object.entries(o.data as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (k === "DoorState") data[k] = doors(v) ?? (isInvalid(v) ? { invalid: true } : {});
      else if (k === "TpmsSoftWarnings" || k === "TpmsHardWarnings") data[k] = tireSet(v) ?? (isInvalid(v) ? { invalid: true } : {});
      else if (k === "Location") {
        const c = coarseLocation(v);
        if (c) data[k] = c;
      } else data[k] = v as TelemetryValue;
    }
  } else {
    return undefined;
  }
  return { vin, createdAt, isResend, data };
}

/**
 * Fold one record into the stored per-VIN state.
 * invalid:true values are not recorded (the last good value stays), except ChargingCableType,
 * where Invalid means "no cable" and is stored as the string "Invalid".
 */
export function mergeState(prev: Record<string, TelemetryValue> | undefined, data: Record<string, TelemetryValue>) {
  const next: Record<string, TelemetryValue> = { ...(prev ?? {}) };
  const delta: Record<string, TelemetryValue> = {};
  for (const k of KNOWN_FIELDS) {
    if (!(k in data)) continue;
    let v = data[k];
    if (isInvalid(v)) {
      if (k !== "ChargingCableType") continue;
      v = "Invalid";
    }
    next[k] = v;
    delta[k] = v;
  }
  return { next, delta };
}

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

export interface TriggerHit<T extends string = VehicleTrigger> {
  on: T;
  /** Overrides the rule priority (SentryMode Panic is always high). */
  priority?: "high";
}

/**
 * Gear values treated as parked. "" (Gear never streamed), Unknown, Invalid and SNA count as
 * parked, so door/trunk triggers need Gear in the telemetry fields (the validator requires it
 * when those rules wake) or they could fire while driving.
 */
const PARKED = new Set(["P", "", "Unknown", "Invalid", "SNA"]);

/**
 * Triggers from one change. `prev` is the stored state before the record, `delta` the fields
 * the record actually changed (after mergeState). Edge rules: a field fires only when it was
 * present in prev (the first value after a restart is a baseline) and its value changed.
 */
export function deriveVehicleTriggers(
  prev: Record<string, TelemetryValue> | undefined,
  delta: Record<string, TelemetryValue>,
  opts: { lowBatteryPercent?: number } = {},
): TriggerHit[] {
  const p = prev ?? {};
  const out: TriggerHit[] = [];
  const same = (a: TelemetryValue | undefined, b: TelemetryValue | undefined) => JSON.stringify(a) === JSON.stringify(b);
  const changed = (k: KnownField) => k in delta && k in p && !same(delta[k], p[k]);
  const gear = enumName("Gear", "Gear" in delta ? delta.Gear : p.Gear);
  const parked = PARKED.has(gear);

  if (changed("DetailedChargeState")) {
    const was = enumName("DetailedChargeState", p.DetailedChargeState);
    const now = enumName("DetailedChargeState", delta.DetailedChargeState);
    if (now === "Complete") out.push({ on: "charge_complete" });
    // Only a session that was actually charging can stop (Disconnected -> Stopped is a plug-in).
    if (now === "Stopped" && (was === "Charging" || was === "Starting")) out.push({ on: "charge_stopped" });
    if (was === "Disconnected" && now !== "Disconnected" && now !== "Unknown") out.push({ on: "plugged_in" });
    if (was !== "Disconnected" && was !== "Unknown" && now === "Disconnected") out.push({ on: "unplugged" });
  } else if (!("DetailedChargeState" in p) && !("DetailedChargeState" in delta) && changed("ChargingCableType")) {
    // Backup only while DetailedChargeState is not streamed for this car.
    const was = enumName("ChargingCableType", p.ChargingCableType);
    const now = enumName("ChargingCableType", delta.ChargingCableType);
    // Invalid (and SNA, "signal not available") mean no cable.
    const none = (v: string) => v === "Invalid" || v === "SNA";
    if (none(was) && !none(now)) out.push({ on: "plugged_in" });
    if (!none(was) && none(now)) out.push({ on: "unplugged" });
  }

  if (changed("DoorState") && parked) {
    const was = doors(p.DoorState);
    const now = doors(delta.DoorState);
    if (anyOpen(now, DOOR_KEYS) && !anyOpen(was, DOOR_KEYS)) out.push({ on: "door_open_parked" });
    if (anyOpen(now, TRUNK_KEYS) && !anyOpen(was, TRUNK_KEYS)) out.push({ on: "trunk_open_parked" });
  }

  if (changed("SentryMode")) {
    const was = enumName("SentryMode", p.SentryMode);
    const now = enumName("SentryMode", delta.SentryMode);
    // Panic -> Aware is the same incident winding down: no second (normal) alert.
    if (now === "Aware" && was !== "Panic") out.push({ on: "sentry_alert" });
    if (now === "Panic") out.push({ on: "sentry_alert", priority: "high" });
  }

  if (changed("BatteryLevel")) {
    const low = opts.lowBatteryPercent ?? 20;
    const was = num(p.BatteryLevel);
    const now = num(delta.BatteryLevel);
    if (now !== undefined && was !== undefined && now < low && was >= low) out.push({ on: "low_battery" });
  }

  if (changed("SoftwareUpdateVersion")) {
    const text = (v: TelemetryValue | undefined) => (typeof v === "string" ? v.trim() : "");
    if (text(p.SoftwareUpdateVersion) === "" && text(delta.SoftwareUpdateVersion) !== "") out.push({ on: "update_available" });
  }
  return out;
}
