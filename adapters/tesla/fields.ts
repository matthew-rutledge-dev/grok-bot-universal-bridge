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
 * TrunkOpen and SentryAlert do not exist in the proto. ChargeState exists but is deprecated,
 * SoftwareUpdateAvailable exists but is undocumented, and Soc exists but means usable charge,
 * not the app's battery %.
 */
export const REPLACED_FIELDS: Record<string, string> = {
  ChargeState: "DetailedChargeState (ChargeState is deprecated)",
  ChargeCableConnected: "DetailedChargeState leaving/returning to Disconnected (backup: ChargingCableType)",
  TrunkOpen: "DoorState.TrunkFront / DoorState.TrunkRear",
  SentryAlert: "SentryMode (Aware, Panic)",
  SoftwareUpdateAvailable: "SoftwareUpdateVersion (empty -> a version)",
  Soc: "BatteryLevel (Soc is usable charge, not the app %)",
};

/** Doors struct (proto message Doors). */
export const DOOR_KEYS = ["DriverFront", "DriverRear", "PassengerFront", "PassengerRear"] as const;
export const TRUNK_KEYS = ["TrunkFront", "TrunkRear"] as const;
export type Doors = Partial<Record<(typeof DOOR_KEYS)[number] | (typeof TRUNK_KEYS)[number], boolean>>;

/** Marker for a datum sent as `invalid: true`. */
export interface Invalid {
  invalid: true;
}
export type TelemetryValue = string | number | boolean | null | Doors | Invalid;

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
  data: Record<string, TelemetryValue>;
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
      data[k] = k === "DoorState" ? (doors(v) ?? (isInvalid(v) ? { invalid: true } : {})) : (v as TelemetryValue);
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
    if (now === "Stopped") out.push({ on: "charge_stopped" });
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
    const now = enumName("SentryMode", delta.SentryMode);
    if (now === "Aware") out.push({ on: "sentry_alert" });
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
