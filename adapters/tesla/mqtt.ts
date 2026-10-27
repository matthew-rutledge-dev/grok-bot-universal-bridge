import { isIP } from "node:net";
import { connect, type IClientOptions, type MqttClient } from "mqtt";
import { doors, KNOWN_FIELDS, type TelemetryRecord, type TelemetryValue } from "./fields.js";
import type { ReceiverSink, TelemetryReceiver } from "./receiver.js";

/**
 * MQTT receiver: the bridge subscribes to the broker Tesla's fleet-telemetry server publishes to.
 *
 * Layout and payloads follow teslamotors/fleet-telemetry datastore/mqtt (README.md,
 * mqtt_payload.go processVehicleFields + getDatumValue):
 *
 *   topic    <topic_base>/<VIN>/v/<Field>      one message per datum (Payload.data[i])
 *   payload  the JSON-encoded datum value only: "DetailedChargeStateComplete", 80.5, "80.5",
 *            {"DriverFront":false,...} for DoorState, null for an invalid datum.
 *
 * The VIN is taken from the topic (fleet-telemetry fills it from the vehicle's verified client
 * cert, rec.Vin). Field messages carry NO created_at and NO is_resend, so createdAt is the
 * bridge's receive time and resends can't be told apart. The datums of one vehicle Payload are
 * published back to back with SetOrderMatters(false), so messages for one VIN are coalesced for
 * `batch_ms` into one record before the trigger logic runs (Gear and DoorState from the same
 * Payload are evaluated together). Alerts, errors and connectivity topics are not subscribed.
 *
 * Retained messages (only if fleet-telemetry runs with retained:true) are replayed by the broker
 * on every subscribe; they are folded in as a baseline and never fire.
 *
 * Malformed topics or payloads are audited `bad_record` and never throw.
 */

export interface MqttReceiverOptions {
  /** Resolved broker URL (mqtt:// or mqtts://). */
  url: string;
  clientId: string;
  topicBase: string;
  qos: 0 | 1 | 2;
  /** Re-read before every (re)connect so a rotated broker password is picked up. */
  username?: () => string | undefined;
  password?: () => string | undefined;
  /** PEM CA for mqtts. */
  ca?: string;
  batchMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  connectTimeoutMs?: number;
  keepaliveS?: number;
  now?: () => number;
  /**
   * VIN allowlist check, applied right after the topic is parsed: a VIN that isn't allowlisted is
   * dropped (`vin_not_allowlisted`) before its payload is parsed or batched.
   */
  vinAllowed?: (vin: string) => boolean;
}

export type MqttEvent =
  | { outcome: "ok"; reason: "connected" | "subscribed" }
  | { outcome: "error"; reason: string; ms?: number };

export interface MqttSink extends ReceiverSink {
  /** connect / disconnect / subscribe / connect_failed (reason codes only, never URLs or credentials). */
  event?(e: MqttEvent): void;
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
/** A datum is a scalar or a 6-key struct; anything bigger is not a fleet-telemetry field message. */
export const MAX_MQTT_PAYLOAD = 64 * 1024;

/** Topic base: non-empty, no wildcards, no leading/trailing slash. */
export function topicBaseProblem(base: unknown): string | undefined {
  if (typeof base !== "string" || !base.trim()) return "must be a non-empty string";
  if (/[+#\u0000]/.test(base)) return "must not contain MQTT wildcards";
  if (base.startsWith("/") || base.endsWith("/") || base.includes("//")) return "must not start or end with / or contain //";
  return undefined;
}

export const subscriptionFor = (base: string) => `${base}/+/v/+`;

/** "<base>/<VIN>/v/<Field>" -> { vin, field }, or undefined. */
export function parseMqttTopic(base: string, topic: string): { vin: string; field: string } | undefined {
  if (!topic.startsWith(`${base}/`)) return undefined;
  const rest = topic.slice(base.length + 1).split("/");
  if (rest.length !== 3 || rest[1] !== "v") return undefined;
  const [vin, , field] = rest;
  if (!VIN_RE.test(vin) || !/^[A-Za-z0-9_]+$/.test(field)) return undefined;
  return { vin, field };
}

/**
 * One MQTT datum value -> the bridge's TelemetryValue. null (fleet-telemetry's invalid) ->
 * { invalid: true }; DoorState must be the Doors struct; everything else a scalar.
 * Returns undefined for a shape the trigger logic can't use.
 */
export function parseMqttValue(field: string, v: unknown): TelemetryValue | undefined {
  if (v === null) return { invalid: true };
  if (field === "DoorState") return typeof v === "object" && !Array.isArray(v) ? doors(v) : undefined;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  return undefined;
}

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./];
const LAN_SUFFIX = [".local", ".lan", ".home.arpa", ".internal"];

/** Integer, hex, or dotted-shorthand IPv4 forms that isIP() doesn't accept as a canonical dotted quad. */
function looksNumericV4(h: string): boolean {
  if (/^(0x[0-9a-f]*|\d+)$/i.test(h)) return true;
  const parts = h.split(".");
  return parts.length > 1 && parts.every((x) => /^(0x[0-9a-f]*|\d+)$/i.test(x));
}

/** Literal broker hosts allowed in config: loopback, RFC 1918 / link-local, ULA, or a LAN-only name. */
export function isLanHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost") return true;
  const fam = isIP(h);
  if (fam === 4) return PRIVATE_V4.some((r) => r.test(h));
  if (fam === 6) return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  // Numeric hosts that aren't a plain dotted quad are refused: integer / hex forms (2130706433,
  // 0x7f000001) and IPv4 shorthand (127.1, 10.0.1, octal 0177.0.0.1, hex 0x7f.0.0.1) resolve to an
  // address the name rules below can't see, so they could point a "LAN" literal anywhere.
  if (looksNumericV4(h)) return false;
  // Single-label names (a compose service such as "mosquitto") and LAN-only suffixes.
  if (/^[a-z0-9-]+$/.test(h)) return true;
  return LAN_SUFFIX.some((s) => h.endsWith(s));
}

/** Problem with a broker URL, or undefined. `literal` adds the loopback/LAN and no-credentials rules. */
export function brokerUrlProblem(raw: string, literal: boolean): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "is not a URL";
  }
  if (u.protocol !== "mqtt:" && u.protocol !== "mqtts:") return "must be mqtt:// or mqtts://";
  if (!u.hostname) return "has no host";
  if (literal) {
    if (u.username || u.password) return "must not carry credentials (use username_ref / password_ref)";
    if (!isLanHost(u.hostname)) return "literal URL must point at a loopback or LAN broker; use an env:/file: ref otherwise";
  }
  return undefined;
}

interface Batch {
  data: Record<string, TelemetryValue>;
  at: number;
  retained: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class MqttTelemetryReceiver implements TelemetryReceiver {
  private client?: MqttClient;
  private sink?: MqttSink;
  private stopped = false;
  private failures = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly batches = new Map<string, Batch>();
  private readonly now: () => number;
  private readonly known = new Set<string>(KNOWN_FIELDS);
  private connectedOnce = false;

  constructor(private readonly o: MqttReceiverOptions) {
    const p = brokerUrlProblem(o.url, false) ?? (topicBaseProblem(o.topicBase) ? `topic_base ${topicBaseProblem(o.topicBase)}` : undefined);
    if (p) throw new Error(`tesla: telemetry.mqtt broker ${p}`);
    this.now = o.now ?? Date.now;
  }

  /** True while connected (tests / ops). */
  connected(): boolean {
    return Boolean(this.client?.connected);
  }

  async start(sink: MqttSink): Promise<void> {
    this.sink = sink;
    this.stopped = false;
    const opts: IClientOptions = {
      clientId: this.o.clientId,
      clean: true,
      protocolVersion: 4,
      reconnectPeriod: 0, // our own backoff below
      connectTimeout: this.o.connectTimeoutMs ?? 10_000,
      keepalive: this.o.keepaliveS ?? 30,
      resubscribe: false,
      ...(this.o.ca ? { ca: this.o.ca } : {}),
    };
    this.applyCredentials(opts);
    const c = connect(this.o.url, opts);
    this.client = c;
    c.on("connect", () => {
      // failures is reset only once the subscribe is granted (below): a broker that accepts the
      // connection but refuses the subscribe must still back off, not retry at reconnect_min_ms.
      this.connectedOnce = true;
      this.event({ outcome: "ok", reason: "connected" });
      c.subscribe(subscriptionFor(this.o.topicBase), { qos: this.o.qos }, (err, granted) => {
        if (err || !granted?.length || (granted[0].qos as number) === 128) {
          this.event({ outcome: "error", reason: "subscribe_refused" });
          // Connected but subscribed to nothing would be silent forever: drop the connection and
          // let the close handler's backoff reconnect and subscribe again.
          if (!this.stopped && this.client === c) c.end(true);
          return;
        }
        this.failures = 0;
        this.event({ outcome: "ok", reason: "subscribed" });
      });
    });
    c.on("message", (topic, payload, packet) => {
      try {
        this.onMessage(topic, payload, Boolean(packet?.retain));
      } catch {
        this.sink?.drop("bad_record");
      }
    });
    // Never let a client error escape: map it to a reason code (no message text: it can echo the URL).
    c.on("error", (err) => this.event({ outcome: "error", reason: errCode(err) }));
    c.on("close", () => this.onClose());
    c.on("offline", () => undefined);
  }

  private applyCredentials(opts: IClientOptions): void {
    const u = this.o.username?.();
    const p = this.o.password?.();
    if (u !== undefined) opts.username = u;
    if (p !== undefined) opts.password = p;
  }

  private onClose(): void {
    if (this.stopped) return;
    if (this.retryTimer) return; // already scheduled
    this.failures++;
    const min = Math.max(10, this.o.reconnectMinMs ?? 1000);
    const max = Math.max(min, this.o.reconnectMaxMs ?? 60_000);
    const base = Math.min(max, min * 2 ** Math.min(20, this.failures - 1));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.event({ outcome: "error", reason: this.connectedOnce ? "disconnected" : "connect_failed", ms: delay });
    this.connectedOnce = false;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.stopped || !this.client) return;
      this.applyCredentials(this.client.options);
      try {
        this.client.reconnect();
      } catch {
        this.onClose();
      }
    }, delay);
    this.retryTimer.unref?.();
  }

  private event(e: MqttEvent): void {
    try {
      this.sink?.event?.(e);
    } catch {
      /* audit must never break the receiver */
    }
  }

  private onMessage(topic: string, payload: Buffer, retained: boolean): void {
    const t = parseMqttTopic(this.o.topicBase, topic);
    if (!t) {
      this.sink?.drop("bad_record");
      return;
    }
    // Allowlist first: an unknown VIN is never parsed or batched.
    if (this.o.vinAllowed && !this.o.vinAllowed(t.vin)) {
      this.sink?.drop("vin_not_allowlisted", t.vin);
      return;
    }
    if (payload.length > MAX_MQTT_PAYLOAD) {
      this.sink?.drop("bad_record", t.vin);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString("utf8"));
    } catch {
      this.sink?.drop("bad_record", t.vin);
      return;
    }
    if (!this.known.has(t.field)) return; // fields the trigger logic doesn't read are ignored
    const v = parseMqttValue(t.field, raw);
    if (v === undefined) {
      this.sink?.drop("bad_record", t.vin);
      return;
    }
    this.add(t.vin, t.field, v, retained);
  }

  private add(vin: string, field: string, v: TelemetryValue, retained: boolean): void {
    let b = this.batches.get(vin);
    // A repeated field or a retained/live switch closes the current batch first (keeps order).
    if (b && (field in b.data || b.retained !== retained)) {
      this.flush(vin);
      b = undefined;
    }
    if (!b) {
      const ms = Math.max(0, this.o.batchMs ?? 250);
      b = { data: {}, at: this.now(), retained, timer: setTimeout(() => this.flush(vin), ms) };
      b.timer.unref?.();
      this.batches.set(vin, b);
    }
    b.data[field] = v;
  }

  private flush(vin: string): void {
    const b = this.batches.get(vin);
    if (!b) return;
    clearTimeout(b.timer);
    this.batches.delete(vin);
    const r: TelemetryRecord = { vin, createdAt: new Date(b.at).toISOString(), data: b.data, ...(b.retained ? { baseline: true } : {}) };
    this.sink?.record(r);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    for (const vin of [...this.batches.keys()]) this.flush(vin);
    const c = this.client;
    this.client = undefined;
    if (c) await new Promise<void>((r) => c.end(true, {}, () => r()));
  }
}

/** Short reason code for an MQTT client error (connack codes, socket codes). */
export function errCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown } | null;
  if (typeof e?.code === "number") {
    // MQTT 3.1.1 CONNACK return codes.
    const map: Record<number, string> = { 1: "bad_protocol", 2: "client_id_rejected", 3: "broker_unavailable", 4: "bad_credentials", 5: "not_authorized" };
    return `connack_${map[e.code] ?? e.code}`;
  }
  if (typeof e?.code === "string" && /^[A-Z0-9_]+$/.test(e.code)) return e.code;
  return "client_error";
}
