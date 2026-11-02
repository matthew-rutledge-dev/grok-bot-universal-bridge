import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, statfs, unlink, type FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform, Writable } from "node:stream";
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
 * With the env unset, empty or shorter than 32 characters the route answers
 * 404 like any unknown path.
 *
 * Atomic publish: the body goes to <BACKUP_ROOT>/<alias>/.incoming/<random>.part
 * (opened O_EXCL), is fsynced, then hard-linked to the final name (link() fails
 * with EEXIST, so a name is never overwritten) and the temp name is unlinked.
 * A crash mid-upload can only leave a stray .part under .incoming/, never a
 * file under a real name. `.incoming` cannot clash with an upload: uploads
 * only ever land in a YYYY-MM-DD folder, and that is the only thing `name`
 * can address. Where the filesystem has no hard links (EPERM, ENOTSUP,
 * EXDEV, ...) the publish falls back to copyFile with COPYFILE_EXCL, which
 * keeps the same never-overwrite / 409 semantics.
 *
 * Free space: before anything is written, statfs(BACKUP_ROOT) must show
 * free - (Content-Length, or the cap when absent) >= BACKUP_MIN_FREE_BYTES
 * (default 5 GiB), else 507. Re-checked every 8 MiB while streaming, and
 * ENOSPC/EDQUOT also answer 507; the temp file is removed either way.
 */
export const BACKUP_PATH = "/backup/upload";
export const BACKUP_MAX_BYTES = 95 * 1024 * 1024;
export const BACKUP_MIN_KEY_LENGTH = 32;
export const DEFAULT_BACKUP_ROOT = "/backup";
export const BACKUP_INCOMING_DIR = ".incoming";
/** Default free-space reserve: 5 GiB (see README). 0 disables the check. */
export const DEFAULT_BACKUP_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;
/** Free space is re-checked after every this many streamed bytes. */
export const BACKUP_SPACE_RECHECK_BYTES = 8 * 1024 * 1024;
const NO_HARDLINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);
const NO_SPACE = new Set(["ENOSPC", "EDQUOT"]);
const NAME = /^[A-Za-z0-9._-]{1,128}$/;
/** Windows device names, with or without an extension (CON, nul.txt, COM1.tar.gz, ...). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

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
  /** Test hooks: filesystem calls that tests need to fail or fake. */
  fsOps?: Partial<BackupFsOps>;
  /** Test hook: re-check free space after this many streamed bytes (default 8 MiB). */
  spaceRecheckBytes?: number;
}

export interface BackupFsOps {
  /** Free bytes available to this process on the filesystem holding `path`. */
  freeBytes(path: string): Promise<number>;
  link(existing: string, target: string): Promise<void>;
  copyFileExcl(src: string, dest: string): Promise<void>;
  /** Write part of a buffer to the temp file; returns bytes written. */
  write(fh: FileHandle, buf: Buffer, offset: number, length: number): Promise<number>;
}

const realFsOps: BackupFsOps = {
  async freeBytes(path) {
    const st = await statfs(path);
    return Number(st.bavail) * Number(st.bsize);
  },
  link: (a, b) => link(a, b),
  copyFileExcl: (a, b) => copyFile(a, b, fsConstants.COPYFILE_EXCL),
  write: async (fh, buf, offset, length) => (await fh.write(buf, offset, length)).bytesWritten,
};

/** BACKUP_MIN_FREE_BYTES: a non-negative integer of bytes; anything else = undefined (caller warns, uses the default). */
export function parseMinFree(raw: string | undefined): number | undefined {
  const v = (raw ?? "").trim();
  if (!v) return DEFAULT_BACKUP_MIN_FREE_BYTES;
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** null = ok, else a short reason. */
export function backupNameProblem(name: string | null): string | null {
  if (name === null || name === "") return "name_missing";
  if (!NAME.test(name)) return "name_invalid";
  if (name === "." || name === "..") return "name_invalid";
  if (WINDOWS_RESERVED.test(name)) return "name_reserved";
  return null;
}

/** The configured key, or "" when unset, empty or too short (the route is then off). */
export function backupKey(env: SecretEnv): string {
  const k = (env.BRIDGE_BACKUP_UPLOAD_KEY ?? "").trim();
  return k.length >= BACKUP_MIN_KEY_LENGTH ? k : "";
}

class TooLarge extends Error {}

function bearer(headers: IncomingMessage["headers"]): string {
  const auth = headers.authorization;
  if (typeof auth !== "string") return "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : "";
}

/** fsync a directory so a new entry survives power loss. Not possible on Windows. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const dh = await open(dir, "r");
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

/**
 * mkdir -p, then refuse a directory that is (or was swapped for) a symlink.
 * A directory created here has its parent fsynced (best effort, warn only).
 */
async function ensureRealDir(dir: string, log: Logger): Promise<void> {
  const created = await mkdir(dir, { recursive: true, mode: 0o750 });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw Object.assign(new Error("not a real directory"), { code: "SYMLINK_DIR" });
  if (created !== undefined) {
    await syncDir(dirname(dir)).catch((err) => log.warn(`[backup] parent directory fsync failed ${(err as NodeJS.ErrnoException).code ?? "error"}`));
  }
}

class NoSpace extends Error {}

/** fsync an already-written file by path (after the copy fallback). */
async function syncFile(path: string): Promise<void> {
  const fh = await open(path, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export function registerBackupRoute(http: HttpServer, o: BackupOptions): void {
  const env = o.env ?? process.env;
  const log = o.log ?? consoleLogger;
  const maxBytes = o.maxBytes ?? BACKUP_MAX_BYTES;
  const now = o.now ?? (() => new Date());
  const fsOps: BackupFsOps = { ...realFsOps, ...(o.fsOps ?? {}) };
  let minFree = parseMinFree(env.BACKUP_MIN_FREE_BYTES);
  if (minFree === undefined) {
    log.warn(`[backup] BACKUP_MIN_FREE_BYTES is not a whole number of bytes; using the default ${DEFAULT_BACKUP_MIN_FREE_BYTES}`);
    minFree = DEFAULT_BACKUP_MIN_FREE_BYTES;
  }
  const reserve = minFree;
  const recheckEvery = o.spaceRecheckBytes ?? BACKUP_SPACE_RECHECK_BYTES;

  const configured = (env.BRIDGE_BACKUP_UPLOAD_KEY ?? "").trim();
  if (configured && !backupKey(env)) {
    log.warn(`[backup] BRIDGE_BACKUP_UPLOAD_KEY is shorter than ${BACKUP_MIN_KEY_LENGTH} characters; backup upload stays disabled (404)`);
  }

  http.route(
    "POST",
    BACKUP_PATH,
    async (req): Promise<HttpResponse> => {
      const expected = backupKey(env);
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
      const botDir = resolve(root, bot);
      const dir = resolve(botDir, now().toISOString().slice(0, 10));
      const incoming = resolve(botDir, BACKUP_INCOMING_DIR);
      const file = resolve(dir, name!);
      // Defense in depth: the validation above already makes these impossible.
      const rel = relative(root, file);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).length !== 3) {
        audit("bad_request", { reason: "path_escape", status: 400 });
        return { status: 400, body: { ok: false, error: "bad_path" } };
      }

      const noSpace = (reason: string, bytes?: number): HttpResponse => {
        audit("no_space", { reason, status: 507, bytes });
        return { status: 507, body: { ok: false, error: "insufficient_storage" } };
      };
      const fail = (err: unknown, bytes?: number): HttpResponse => {
        const code = String((err as NodeJS.ErrnoException).code ?? (err as Error).name ?? "error");
        log.warn(`[backup] upload failed ${code}`);
        audit("error", { reason: code === "SYMLINK_DIR" ? "symlink_dir" : code, status: 500, bytes });
        return { status: 500, body: { ok: false, error: "write_failed" } };
      };

      // Cheap early 409 (the link() below is what actually guarantees no overwrite).
      try {
        await lstat(file);
        audit("conflict", { status: 409 });
        return { status: 409, body: { ok: false, error: "exists" } };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") return fail(err);
      }

      // Free space before anything is written: free - expected size must stay >= reserve.
      const expectedBytes = Number.isFinite(declared) && declared >= 0 ? declared : maxBytes;
      if (reserve > 0) {
        try {
          await mkdir(root, { recursive: true, mode: 0o750 });
          const free = await fsOps.freeBytes(root);
          if (free - expectedBytes < reserve) return noSpace("below_reserve");
        } catch (err) {
          return fail(err);
        }
      }

      let temp = "";
      let fh;
      try {
        await ensureRealDir(botDir, log);
        await ensureRealDir(dir, log);
        await ensureRealDir(incoming, log);
        temp = join(incoming, `${randomBytes(12).toString("hex")}.part`);
        fh = await open(temp, "wx", 0o640);
      } catch (err) {
        return fail(err);
      }

      const hash = createHash("sha256");
      let bytes = 0;
      let nextCheck = recheckEvery;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > maxBytes) return cb(new TooLarge("too large"));
          hash.update(chunk);
          if (reserve <= 0 || bytes < nextCheck) return cb(null, chunk);
          nextCheck = bytes + recheckEvery;
          // Re-check while streaming: other writers share the volume.
          fsOps.freeBytes(root).then(
            (free) => (free < reserve ? cb(new NoSpace("below reserve")) : cb(null, chunk)),
            (err) => cb(err as Error),
          );
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
      let linked = false;
      try {
        const handle = fh;
        // Our own sink (not fh.createWriteStream) so the handle stays open for fsync.
        const sink = new Writable({
          write(chunk: Buffer, _enc, cb) {
            (async () => {
              let off = 0;
              while (off < chunk.length) off += await fsOps.write(handle, chunk, off, chunk.length - off);
            })().then(() => cb(), cb);
          },
        });
        await pipeline(meter, sink);
        await fh.sync();
        await fh.close();
        try {
          await fsOps.link(temp, file);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? "";
          if (!NO_HARDLINK.has(code)) throw err;
          // No hard links here: exclusive copy keeps "never overwrite" (EEXIST -> 409).
          let copied = false;
          try {
            await fsOps.copyFileExcl(temp, file);
            copied = true;
            await syncFile(file);
          } catch (copyErr) {
            // A failed copy must not leave a partial file under the real name.
            if (copied || (copyErr as NodeJS.ErrnoException).code !== "EEXIST") await unlink(file).catch(() => undefined);
            throw copyErr;
          }
        }
        linked = true;
      } catch (err) {
        src.unpipe(meter);
        await fh.close().catch(() => undefined);
        if (err instanceof TooLarge) {
          audit("too_large", { reason: "streamed", status: 413, bytes });
          return { status: 413, body: { ok: false, error: "body_too_large", maxBytes } };
        }
        if (err instanceof NoSpace) return noSpace("below_reserve_streaming", bytes);
        if (NO_SPACE.has((err as NodeJS.ErrnoException).code ?? "")) return noSpace(String((err as NodeJS.ErrnoException).code), bytes);
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          audit("conflict", { status: 409, bytes });
          return { status: 409, body: { ok: false, error: "exists" } };
        }
        return fail(err, bytes);
      } finally {
        src.removeListener("close", onAbort);
        src.removeListener("error", onError);
        await unlink(temp).catch(() => undefined);
      }
      if (linked) {
        // Best effort: the data is already fsynced; this makes the new name durable too.
        await syncDir(dir).catch((err) => log.warn(`[backup] directory fsync failed ${(err as NodeJS.ErrnoException).code ?? "error"}`));
      }
      const sha256 = hash.digest("hex");
      const path = rel.split(sep).join("/");
      audit("ok", { status: 201, bytes, sha256 });
      return { status: 201, body: { path, bytes, sha256 } };
    },
    { stream: true },
  );
}
