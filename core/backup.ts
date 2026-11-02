import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AuditEntry, AuditSink } from "./audit.js";
import { safeEqual, type HttpResponse, type HttpServer } from "./http.js";
import type { Registry } from "./registry.js";
import type { SecretEnv } from "./secrets.js";
import { consoleLogger, type Logger } from "./types.js";

/**
 * POST /backup/upload?bot=<alias>&name=<file>
 *
 * Write-only backup drop: streams the body to
 * <BACKUP_ROOT>/<alias>/<YYYY-MM-DD UTC>/<name>, never overwriting.
 * No list, read, delete or overwrite routes exist on purpose.
 *
 * Auth: `Authorization: Bearer <BRIDGE_BACKUP_UPLOAD_KEY>` (constant-time).
 * With the env unset or empty the route answers 404 like any unknown path.
 */
export const BACKUP_PATH = "/backup/upload";
export const BACKUP_MAX_BYTES = 95 * 1024 * 1024;
export const DEFAULT_BACKUP_ROOT = "/backup";
const NAME = /^[A-Za-z0-9._-]{1,128}$/;

export interface BackupOptions {
  registry: Registry;
  audit: AuditSink;
  env?: SecretEnv;
  log?: Logger;
  /** Test hook: overrides env BACKUP_ROOT. */
  root?: string;
  /** Test hook: byte cap (default 95 MiB). */
  maxBytes?: number;
  /** Test hook: clock for the date folder. */
  now?: () => Date;
}

/** null = ok, else a short reason. */
export function backupNameProblem(name: string | null): string | null {
  if (name === null || name === "") return "name_missing";
  if (!NAME.test(name)) return "name_invalid";
  if (name === "." || name === "..") return "name_invalid";
  return null;
}

class TooLarge extends Error {}

function bearer(headers: IncomingMessage["headers"]): string {
  const auth = headers.authorization;
  if (typeof auth !== "string") return "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : "";
}

export function registerBackupRoute(http: HttpServer, o: BackupOptions): void {
  const env = o.env ?? process.env;
  const log = o.log ?? consoleLogger;
  const maxBytes = o.maxBytes ?? BACKUP_MAX_BYTES;
  const now = o.now ?? (() => new Date());

  http.route(
    "POST",
    BACKUP_PATH,
    async (req): Promise<HttpResponse> => {
      const expected = (env.BRIDGE_BACKUP_UPLOAD_KEY ?? "").trim();
      // Disabled: indistinguishable from an unknown path (no audit line either).
      if (!expected) return { status: 404, body: { ok: false, error: "not_found" } };

      const bot = req.query.get("bot") ?? "";
      const name = req.query.get("name");
      const audit = (outcome: AuditEntry["outcome"], extra: Partial<AuditEntry> = {}) =>
        o.audit.write({ adapter: "backup", action: "upload", outcome, agent: bot || undefined, name: name ?? undefined, ...extra });

      if (req.query.has("token") || req.query.has("key")) {
        audit("bad_request", { reason: "query_token_refused", status: 400 });
        return { status: 400, body: { ok: false, error: "use the Authorization header" } };
      }
      const got = bearer(req.headers);
      if (!got) {
        audit("auth_fail", { reason: "missing_key", status: 401 });
        return { status: 401, body: { ok: false, error: "unauthorized" } };
      }
      if (!safeEqual(got, expected)) {
        audit("auth_fail", { reason: "bad_key", status: 403 });
        return { status: 403, body: { ok: false, error: "forbidden" } };
      }

      if (!bot || !o.registry.has(bot)) {
        audit("bad_request", { reason: "unknown_bot", status: 400 });
        return { status: 400, body: { ok: false, error: "unknown_bot" } };
      }
      const nameProblem = backupNameProblem(name);
      if (nameProblem) {
        audit("bad_request", { reason: nameProblem, status: 400 });
        return { status: 400, body: { ok: false, error: nameProblem } };
      }

      const declaredRaw = req.headers["content-length"];
      const declared = declaredRaw === undefined ? NaN : Number(declaredRaw);
      if (Number.isFinite(declared) && declared > maxBytes) {
        audit("too_large", { reason: "content_length", status: 413 });
        return { status: 413, body: { ok: false, error: "body_too_large", maxBytes } };
      }

      const root = resolve(o.root ?? (env.BACKUP_ROOT?.trim() || DEFAULT_BACKUP_ROOT));
      const day = now().toISOString().slice(0, 10);
      const dir = resolve(root, bot, day);
      const file = resolve(dir, name!);
      // Defense in depth: the validation above already makes these impossible.
      const rel = relative(root, file);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).length !== 3) {
        audit("bad_request", { reason: "path_escape", status: 400 });
        return { status: 400, body: { ok: false, error: "bad_path" } };
      }

      let fh;
      try {
        await mkdir(dir, { recursive: true, mode: 0o750 });
        fh = await open(file, "wx", 0o640);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          audit("conflict", { status: 409 });
          return { status: 409, body: { ok: false, error: "exists" } };
        }
        log.error(`[backup] open failed ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
        audit("error", { reason: (err as NodeJS.ErrnoException).code ?? "open_failed", status: 500 });
        return { status: 500, body: { ok: false, error: "write_failed" } };
      }

      const hash = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > maxBytes) return cb(new TooLarge("too large"));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      // pipe (not pipeline) for the request side: on 413 the request must stay
      // open so the core can drain it and the client reads the 413, not a reset.
      const src = req.stream!;
      const onAbort = () => {
        if (!src.readableEnded) meter.destroy(Object.assign(new Error("client aborted"), { code: "ECONNRESET" }));
      };
      const onError = (e: Error) => meter.destroy(e);
      src.once("close", onAbort);
      src.once("error", onError);
      src.pipe(meter);
      try {
        await pipeline(meter, fh.createWriteStream());
      } catch (err) {
        src.unpipe(meter);
        await fh.close().catch(() => undefined);
        await unlink(file).catch(() => undefined);
        if (err instanceof TooLarge) {
          audit("too_large", { reason: "streamed", status: 413, bytes });
          return { status: 413, body: { ok: false, error: "body_too_large", maxBytes } };
        }
        const code = (err as NodeJS.ErrnoException).code ?? (err as Error).name;
        log.warn(`[backup] upload failed ${code}`);
        audit("error", { reason: String(code), status: 500, bytes });
        return { status: 500, body: { ok: false, error: "write_failed" } };
      } finally {
        src.removeListener("close", onAbort);
        src.removeListener("error", onError);
      }
      const sha256 = hash.digest("hex");
      const path = rel.split(sep).join("/");
      audit("ok", { status: 201, bytes, sha256 });
      return { status: 201, body: { path, bytes, sha256 } };
    },
    { stream: true },
  );
}
