import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MultipartBody, multipartBoundary } from "./multipart.js";
import { consoleLogger, type Logger } from "./types.js";

/** Minimal JSON HTTP router on node:http (no framework). Binds loopback by default. */
export interface HttpRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON (or MultipartBody). Undefined for routes registered with `rawBody: true`. */
  body: unknown;
  /** Exact request bytes for POST/PUT (for adapters that verify a signature over the raw body). */
  rawBody?: Buffer;
}

export interface RouteOptions {
  maxBytes?: number;
  /**
   * Deliver only the raw bytes: the core does not JSON-parse the body, so
   * nothing touches unauthenticated input before the handler verifies it
   * (for example an HMAC signature). The handler parses after verification.
   */
  rawBody?: boolean;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type Handler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;

interface RouteDef {
  method: string;
  parts: string[];
  handler: Handler;
  maxBytes: number;
  rawBody: boolean;
}

export const DEFAULT_MAX_BODY = 256 * 1024;

/** Token from `Authorization: Bearer <t>` or `x-callback-token: <t>`. Never from the query string. */
export function tokenFromHeaders(headers: IncomingHttpHeaders): string {
  const auth = headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const h = headers["x-callback-token"];
  return typeof h === "string" ? h.trim() : "";
}

/** Constant-time comparison (hashes first so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/**
 * Read the body up to maxBytes. An oversize body (by content-length or by
 * counting) is not buffered: the rest is read and discarded so the client
 * gets a clean 413 instead of a reset socket. Past a hard drain cap the
 * socket is destroyed, so a sender cannot keep the connection busy forever.
 */
export const DRAIN_CAP_BYTES = 4 * 1024 * 1024;

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    let settled = false;
    const tooLarge = () => Object.assign(new Error("body too large"), { status: 413 });
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) over = true;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (!over && size > maxBytes) {
        over = true;
        chunks.length = 0;
      }
      if (over) {
        if (size > maxBytes + DRAIN_CAP_BYTES && !settled) {
          settled = true;
          reject(tooLarge());
          req.destroy();
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (over) reject(tooLarge());
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

export class HttpServer {
  private readonly routes: RouteDef[] = [];
  private server: Server | undefined;

  constructor(private readonly log: Logger = consoleLogger) {}

  route(method: string, pattern: string, handler: Handler, opts?: RouteOptions): void {
    const parts = pattern.split("/").filter(Boolean);
    if (this.routes.some((r) => r.method === method && r.parts.join("/") === parts.join("/"))) {
      throw new Error(`duplicate route ${method} ${pattern}`);
    }
    this.routes.push({ method, parts, handler, maxBytes: opts?.maxBytes ?? DEFAULT_MAX_BODY, rawBody: opts?.rawBody === true });
  }

  /** undefined = no route; "bad_path" = a parameter is not valid percent-encoding. */
  private match(method: string, path: string): { def: RouteDef; params: Record<string, string> } | "bad_path" | undefined {
    const segs = path.split("/").filter(Boolean);
    for (const def of this.routes) {
      if (def.method !== method || def.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = def.parts[i];
        if (p.startsWith(":")) {
          try {
            params[p.slice(1)] = decodeURIComponent(segs[i]);
          } catch {
            return "bad_path";
          }
        } else if (p !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { def, params };
    }
    return undefined;
  }

  async listen(bind: string, port: number): Promise<number> {
    if (!bind || !bind.trim()) throw new Error("http bind address required (an empty bind listens on every interface)");
    this.server = createServer((req, res) => {
      void this.handle(req)
        .then((out) => {
          // A string body with an explicit text/plain content-type is written as-is (e.g. a webhook challenge echo).
          const plain = typeof out.body === "string" && /^text\/plain\b/i.test(out.headers?.["content-type"] ?? "");
          const body = plain ? (out.body as string) : JSON.stringify(out.body ?? {});
          res.writeHead(out.status, {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            ...(out.headers ?? {}),
            ...(plain ? { "content-type": "text/plain; charset=utf-8" } : {}),
          });
          res.end(body);
        })
        .catch((err) => {
          // Never let one request take the process down.
          this.log.error(`[http] request failed ${(err as Error)?.name ?? typeof err}`);
          try {
            if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "internal" }));
          } catch {
            res.destroy();
          }
        });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, bind, () => resolve());
    });
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = undefined;
  }

  private async handle(req: IncomingMessage): Promise<HttpResponse> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();
    const m = this.match(method, url.pathname);
    if (m === "bad_path") return { status: 400, body: { ok: false, error: "bad_path_encoding" } };
    if (!m) return { status: 404, body: { ok: false, error: "not_found" } };
    let body: unknown = undefined;
    let rawBody: Buffer | undefined;
    try {
      if (method === "POST" || method === "PUT") {
        const raw = await readBody(req, m.def.maxBytes);
        rawBody = raw;
        // rawBody routes get the bytes only; the handler parses after verifying them.
        if (!m.def.rawBody) {
          const boundary = multipartBoundary(req.headers["content-type"]);
          // multipart/form-data stays raw until the handler parses it (after auth).
          if (boundary) body = new MultipartBody(raw, boundary);
          else body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
        }
      }
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      if (status === 413) return { status, body: { ok: false, error: "body_too_large" }, headers: { connection: "close" } };
      return { status, body: { ok: false, error: "invalid_json" } };
    }
    try {
      return await m.def.handler({ method, path: url.pathname, headers: req.headers, params: m.params, query: url.searchParams, body, rawBody });
    } catch (err) {
      this.log.error(`[http] handler error ${method} ${m.def.parts[0] ?? "/"} ${(err as Error).name}`);
      return { status: 500, body: { ok: false, error: "internal" } };
    }
  }
}
