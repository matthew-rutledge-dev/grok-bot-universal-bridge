import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, win32 } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { AdapterContext } from "../../core/bridge.js";
import type { TelemetryValue } from "./fields.js";

/**
 * Optional telemetry history (off by default): every accepted telemetry datum of an allowlisted
 * VIN is appended to a local SQLite file (node:sqlite, Node 22.13+). Write-only from the bridge:
 * there are no read routes; read the file on the host.
 *
 *   telemetry(id, vin, field, value JSON, created_at ms, received_at ms)
 *   index (vin, field, created_at); index (received_at) for the daily retention prune
 *
 * WAL mode, batched writes (one transaction per flush), file mode 600. A database error is audited
 * (history_write_failed) and the batch is dropped: history never blocks or breaks ingest.
 */
export interface TelemetryHistoryConfig {
  enabled: boolean;
  /** file:/absolute/path.sqlite. Default: telemetry-history.sqlite in the bridge data dir. */
  path?: string;
  /** Rows older than this (by received time) are pruned daily. Default 90, 1-3650. */
  retention_days?: number;
}

export const HISTORY_DEFAULT_RETENTION_DAYS = 90;
export const HISTORY_FLUSH_MS = 1000;
export const HISTORY_BATCH_ROWS = 500;
/** Rows held in memory at most (oldest dropped past this, audited). */
export const HISTORY_MAX_BUFFER = 20_000;
/** A value whose JSON is longer than this is skipped (audited). */
export const HISTORY_MAX_VALUE_CHARS = 16_384;
const PRUNE_MS = 24 * 3600_000;
const FAIL_AUDIT_MS = 60_000;

function isFileRef(ref: unknown): ref is string {
  if (typeof ref !== "string" || /[\s\u0000-\u001f\u007f-\u009f]/.test(ref) || !ref.startsWith("file:") || ref.length <= 5) return false;
  const f = ref.slice(5);
  return isAbsolute(f) || posix.isAbsolute(f) || win32.isAbsolute(f);
}

export function validateHistory(h: TelemetryHistoryConfig | undefined): string[] {
  const p: string[] = [];
  if (!h) return p;
  const at = "tesla.telemetry.history";
  if (typeof h !== "object") return [`${at} must be an object`];
  if (typeof h.enabled !== "boolean") p.push(`${at}.enabled must be true or false`);
  if (h.path !== undefined && !isFileRef(h.path)) p.push(`${at}.path must be file:/absolute/path`);
  if (h.retention_days !== undefined && !(Number.isInteger(h.retention_days) && h.retention_days >= 1 && h.retention_days <= 3650)) p.push(`${at}.retention_days must be a whole number 1-3650`);
  return p;
}

interface Row {
  vin: string;
  field: string;
  value: string;
  createdAt: number;
  receivedAt: number;
}

export interface HistoryDeps {
  now: () => number;
  /** TESTS ONLY: replace the node:sqlite loader (e.g. to simulate a Node without it). */
  loadSqlite?: () => Promise<{ DatabaseSync: typeof DatabaseSync }>;
}

export class TelemetryHistory {
  private db?: DatabaseSync;
  private insert?: StatementSync;
  private buf: Row[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;
  private pruneTimer?: ReturnType<typeof setInterval>;
  private file = "";
  private written = 0;
  private failures = 0;
  private skipped = 0;
  private overflow = 0;
  private lastFailAudit = 0;
  private suppressedFails = 0;

  constructor(
    private readonly cfg: TelemetryHistoryConfig,
    private readonly ctx: AdapterContext,
    private readonly deps: HistoryDeps,
  ) {}

  /** Opens the database. Never throws: on any problem history stays off (audited). */
  async start(): Promise<boolean> {
    this.file = this.cfg.path ? this.cfg.path.slice(5) : (this.ctx.dataFile?.("telemetry-history.sqlite") ?? "");
    if (!this.file) {
      this.ctx.log.warn("[tesla] telemetry.history is on but there is no data dir and no path; history is off");
      this.ctx.audit({ action: "observe", outcome: "error", reason: "history_no_path" });
      return false;
    }
    let mod: { DatabaseSync: typeof DatabaseSync };
    try {
      mod = await (this.deps.loadSqlite ?? (() => import("node:sqlite") as Promise<{ DatabaseSync: typeof DatabaseSync }>))();
    } catch {
      this.ctx.log.warn("[tesla] telemetry.history needs node:sqlite (Node 22.13 or later); history is off");
      this.ctx.audit({ action: "observe", outcome: "error", reason: "history_sqlite_unavailable" });
      return false;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      // Create the file 600 before SQLite opens it (an empty file is a valid empty database).
      if (!existsSync(this.file)) writeFileSync(this.file, "", { mode: 0o600 });
      chmodSync(this.file, 0o600);
      const db = new mod.DatabaseSync(this.file);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 2000;
        CREATE TABLE IF NOT EXISTS telemetry (
          id INTEGER PRIMARY KEY,
          vin TEXT NOT NULL,
          field TEXT NOT NULL,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          received_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS telemetry_vin_field_created ON telemetry (vin, field, created_at);
        CREATE INDEX IF NOT EXISTS telemetry_received ON telemetry (received_at);
        PRAGMA user_version = 1;
      `);
      this.insert = db.prepare("INSERT INTO telemetry (vin, field, value, created_at, received_at) VALUES (?, ?, ?, ?, ?)");
      this.db = db;
      this.chmodSidecars();
    } catch {
      this.ctx.log.warn("[tesla] telemetry.history could not open its database; history is off");
      this.ctx.audit({ action: "observe", outcome: "error", reason: "history_open_failed" });
      this.close();
      return false;
    }
    this.prune();
    this.flushTimer = setInterval(() => this.flush(), HISTORY_FLUSH_MS);
    this.flushTimer.unref?.();
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_MS);
    this.pruneTimer.unref?.();
    return true;
  }

  private chmodSidecars(): void {
    for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      try {
        if (existsSync(f)) chmodSync(f, 0o600);
      } catch {
        /* best effort */
      }
    }
  }

  /** Queue one record's fields. Never throws. */
  add(vin: string, data: Record<string, TelemetryValue>, createdAt: number, receivedAt: number): void {
    if (!this.db) return;
    try {
      for (const [field, v] of Object.entries(data)) {
        if (v === undefined) continue;
        const value = JSON.stringify(v);
        if (value === undefined || value.length > HISTORY_MAX_VALUE_CHARS || field.length > 128) {
          this.skipped++;
          continue;
        }
        this.buf.push({ vin, field, value, createdAt, receivedAt });
      }
      if (this.buf.length > HISTORY_MAX_BUFFER) {
        const drop = this.buf.length - HISTORY_MAX_BUFFER;
        this.buf.splice(0, drop);
        this.overflow += drop;
      }
      if (this.buf.length >= HISTORY_BATCH_ROWS) this.flush();
    } catch {
      this.writeFailed(0);
    }
  }

  /** Write the queued rows in one transaction. On error the batch is dropped and audited. */
  flush(): number {
    if (this.skipped) {
      this.ctx.audit({ action: "observe", outcome: "skipped", reason: "history_value_too_large", count: this.skipped });
      this.skipped = 0;
    }
    if (this.overflow) {
      this.ctx.audit({ action: "observe", outcome: "error", reason: "history_buffer_overflow", count: this.overflow });
      this.overflow = 0;
    }
    if (!this.db || !this.insert || !this.buf.length) return 0;
    const rows = this.buf;
    this.buf = [];
    try {
      this.db.exec("BEGIN");
      for (const r of rows) this.insert.run(r.vin, r.field, r.value, r.createdAt, r.receivedAt);
      this.db.exec("COMMIT");
      this.written += rows.length;
      return rows.length;
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* not in a transaction */
      }
      this.writeFailed(rows.length);
      return 0;
    }
  }

  /** history_write_failed, at most once a minute (the next line carries the rows dropped since). */
  private writeFailed(rows: number): void {
    this.failures++;
    this.suppressedFails += rows;
    const now = this.deps.now();
    if (now - this.lastFailAudit < FAIL_AUDIT_MS) return;
    this.lastFailAudit = now;
    this.ctx.audit({ action: "observe", outcome: "error", reason: "history_write_failed", count: this.suppressedFails });
    this.suppressedFails = 0;
  }

  /** Delete rows received before now - retention_days. Returns rows deleted. */
  prune(): number {
    if (!this.db) return 0;
    const cutoff = this.deps.now() - (this.cfg.retention_days ?? HISTORY_DEFAULT_RETENTION_DAYS) * 86400_000;
    try {
      const r = this.db.prepare("DELETE FROM telemetry WHERE received_at < ?").run(cutoff);
      const n = Number(r.changes);
      if (n) this.ctx.audit({ action: "observe", outcome: "ok", reason: "history_pruned", count: n });
      this.chmodSidecars();
      return n;
    } catch {
      this.ctx.audit({ action: "observe", outcome: "error", reason: "history_prune_failed" });
      return 0;
    }
  }

  private close(): void {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = undefined;
    this.insert = undefined;
  }

  /** Idempotent: flushes what is queued and closes the database. */
  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flushTimer = this.pruneTimer = undefined;
    this.flush();
    this.close();
  }

  health(): Record<string, unknown> {
    return { enabled: true, open: Boolean(this.db), rows_written: this.written, pending: this.buf.length, write_failures: this.failures };
  }
}
