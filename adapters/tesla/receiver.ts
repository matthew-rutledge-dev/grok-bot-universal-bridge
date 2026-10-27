import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { safeEqual } from "../../core/http.js";
import { parsePayload, type TelemetryRecord } from "./fields.js";

/**
 * Telemetry receivers. Both hand normalised records to the adapter; neither ever
 * sends anything to a vehicle.
 *
 *  - "decoded" (recommended): run Tesla's own fleet-telemetry server (it terminates the
 *    vehicles' mTLS and decodes their frames) with `transmit_decoded_records: true`, and
 *    relay its JSON records to this loopback-only HTTP listener (POST one record, a JSON
 *    array, or NDJSON). The VIN is the one fleet-telemetry took from the client cert.
 *
 *  - "mtls": the bridge itself terminates TLS with requestCert + rejectUnauthorized against
 *    the Tesla vehicle CA (client_ca). The VIN is the verified client certificate's
 *    Subject CN, never the payload; a payload VIN that disagrees is dropped. Text frames
 *    must carry decoded JSON records. Native vehicle frames (binary, flatbuffers envelope
 *    around protobuf) are NOT decoded here and are dropped as `undecodable_frame`; use
 *    "decoded" mode for real cars.
 */

export type DropReason = "vin_cert_mismatch" | "no_client_cert" | "undecodable_frame" | "bad_record" | "tls_handshake_failed";

export interface ReceiverSink {
  record(r: TelemetryRecord): void;
  /** count: how many events this line stands for (rate-limited handshake failures). */
  drop(reason: DropReason, vin?: string, count?: number): void;
}

export interface TelemetryReceiver {
  start(sink: ReceiverSink): Promise<void>;
  stop(): Promise<void>;
  /** Bound port (after start). */
  port?(): number;
}

export function splitListen(listen: string): { host: string; port: number } {
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(listen.trim());
  if (!m) throw new Error(`tesla: listen must be host:port`);
  return { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}

export const isLoopbackHost = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost";

const MAX_BODY = 1_000_000; // fleet-telemetry's own per-message cap

function* recordsIn(text: string): Generator<unknown> {
  const t = text.trim();
  if (!t) return;
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) yield* v;
    else yield v;
    return;
  } catch {
    /* NDJSON */
  }
  for (const line of t.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      yield undefined;
    }
  }
}

/** Loopback HTTP listener for fleet-telemetry decoded JSON (POST /records). */
export class DecodedJsonReceiver implements TelemetryReceiver {
  private server?: HttpServer;
  /**
   * token: when set, a bearer is REQUIRED; if the ref resolves empty at request time the
   * listener answers 503 (fail closed), never "no auth".
   * requestTimeoutMs: whole-request timeout (default 10 s) so a slow client can't hold a socket.
   */
  constructor(private readonly o: { listen: string; token?: () => string | undefined; requestTimeoutMs?: number }) {
    const { host } = splitListen(o.listen);
    if (!isLoopbackHost(host)) throw new Error("tesla.telemetry.decoded_listen must be a loopback address");
  }

  async start(sink: ReceiverSink): Promise<void> {
    const { host, port } = splitListen(this.o.listen);
    const timeout = Math.max(50, this.o.requestTimeoutMs ?? 10_000);
    this.server = createHttpServer(
      { requestTimeout: timeout, headersTimeout: timeout, connectionsCheckingInterval: Math.min(1000, Math.max(25, Math.floor(timeout / 4))) },
      (req, res) => {
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/records") {
        res.writeHead(404).end();
        return;
      }
      if (this.o.token) {
        const want = this.o.token();
        if (!want) {
          res.writeHead(503).end();
          return;
        }
        if (!safeEqual(req.headers.authorization ?? "", `Bearer ${want}`)) {
          res.writeHead(401).end();
          return;
        }
      }
      readBody(req, MAX_BODY)
        .then((text) => {
          let n = 0;
          for (const raw of recordsIn(text)) {
            const r = parsePayload(raw);
            if (!r || !r.vin) {
              sink.drop("bad_record");
              continue;
            }
            sink.record(r);
            n++;
          }
          res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ accepted: n }));
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(413).end();
        });
      },
    );
    this.server.on("clientError", (_e, sock) => sock.destroy());
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
  }

  port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("too_big"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** VIN = verified client cert Subject CN (what fleet-telemetry uses as the device id). */
export function vinFromSocket(sock: TLSSocket): string | undefined {
  if (!sock.authorized) return undefined;
  const cert = sock.getPeerCertificate();
  const cn = cert?.subject?.CN;
  const v = Array.isArray(cn) ? cn[0] : cn;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** WebSocket-over-mTLS receiver. Requires and verifies client certs. */
export class MtlsTelemetryReceiver implements TelemetryReceiver {
  private server?: HttpsServer;
  private wss?: WebSocketServer;
  private tlsFailures = 0;
  private tlsLastEmit = -Infinity;
  private flushTls: () => void = () => undefined;
  constructor(private readonly o: { listen: string; cert: string; key: string; clientCa: string; tlsAuditWindowMs?: number; now?: () => number }) {}

  /** Handshake failures counted but not yet written. */
  pendingTlsFailures(): number {
    return this.tlsFailures;
  }

  async start(sink: ReceiverSink): Promise<void> {
    const { host, port } = splitListen(this.o.listen);
    this.server = createHttpsServer({
      cert: this.o.cert,
      key: this.o.key,
      ca: this.o.clientCa,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    this.server.on("request", (_req, res) => res.writeHead(426).end());
    // Failed handshakes (scanners, no/foreign client cert) are counted, not logged one by one:
    // the first failure in a window writes a line, the rest are summed into the next line.
    // No timer: a pending count stays unwritten until the next failure after the window or
    // stop() (flushTls), so the audit file can lag behind a burst.
    this.server.on("tlsClientError", (_e, sock) => {
      sock.destroy();
      this.tlsFailures++;
      const now = (this.o.now ?? Date.now)();
      if (now - this.tlsLastEmit >= (this.o.tlsAuditWindowMs ?? 60_000)) {
        sink.drop("tls_handshake_failed", undefined, this.tlsFailures);
        this.tlsFailures = 0;
        this.tlsLastEmit = now;
      }
    });
    this.flushTls = () => {
      if (this.tlsFailures) sink.drop("tls_handshake_failed", undefined, this.tlsFailures);
      this.tlsFailures = 0;
    };
    this.wss = new WebSocketServer({ server: this.server, maxPayload: MAX_BODY });
    // Server-level errors (e.g. a failed upgrade) must never crash the process.
    this.wss.on("error", () => sink.drop("bad_record"));
    this.wss.on("connection", (ws, req) => {
      const certVin = vinFromSocket(req.socket as TLSSocket);
      // Frame errors (over maxPayload, invalid UTF-8 text, bad opcode) emit 'error' on the socket.
      ws.on("error", () => {
        sink.drop("bad_record", certVin);
        ws.terminate();
      });
      if (!certVin) {
        sink.drop("no_client_cert");
        ws.close(1008);
        return;
      }
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          sink.drop("undecodable_frame", certVin);
          return;
        }
        for (const raw of recordsIn(data.toString())) {
          const r = parsePayload(raw);
          if (!r) {
            sink.drop("bad_record", certVin);
            continue;
          }
          if (r.vin && r.vin !== certVin) {
            sink.drop("vin_cert_mismatch", certVin);
            continue;
          }
          sink.record({ ...r, vin: certVin });
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
  }

  port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? 0;
  }

  async stop(): Promise<void> {
    this.flushTls();
    for (const c of this.wss?.clients ?? []) c.terminate();
    this.wss?.close();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
