import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { maskId } from "./redact.js";

/**
 * Content-free audit log (JSON Lines, mode 600).
 *
 * One line per decision: ts, adapter, action, outcome, reason, agent alias,
 * and MASKED ids (last 4 characters). Never message text, prompts, URLs,
 * keys or tokens: fields outside the allow list below are dropped.
 */
export type AuditAction =
  | "inbound"
  | "deliver"
  | "hold"
  | "retry"
  | "give_up"
  | "callback"
  | "ingest"
  | "reply_read"
  | "wake"
  | "observe"
  | "attachment"
  | "planner"
  | "voice"
  /** A source's upstream connection (e.g. the Tesla MQTT broker): connected / disconnected / connect_failed. */
  | "connection";

export interface AuditEntry {
  adapter: string;
  action: AuditAction;
  outcome: "allow" | "deny" | "ok" | "error" | "held" | "skipped";
  reason?: string;
  agent?: string;
  route?: string;
  /** Raw ids; masked before writing. */
  eventId?: string;
  lane?: string;
  actor?: string;
  /** Characters of the actor kept when masking (default 4). The Tesla adapter keeps 6 of a VIN, matching vin_last6 in its prompts. */
  actorKeep?: 4 | 6;
  /** Short event type (e.g. charge_complete). */
  type?: string;
  status?: number;
  tries?: number;
  ms?: number;
  /** Attachment lines: file count, total bytes, comma list of kinds (image,text,...). Never names or content. */
  count?: number;
  bytes?: number;
  kinds?: string;
}

const KEEP = ["adapter", "action", "outcome", "reason", "agent", "route", "type", "status", "tries", "ms", "count", "bytes", "kinds"] as const;
const MASK = ["eventId", "lane", "actor"] as const;

export interface AuditSink {
  write(entry: AuditEntry): void;
}

export function auditLine(entry: AuditEntry, now = new Date()): Record<string, unknown> {
  const out: Record<string, unknown> = { ts: now.toISOString() };
  const src = entry as unknown as Record<string, unknown>;
  for (const k of KEEP) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").slice(0, 80) : v;
  }
  for (const k of MASK) {
    const v = src[k];
    if (typeof v === "string" && v) out[k] = maskId(v, k === "actor" && entry.actorKeep === 6 ? 6 : 4);
  }
  return out;
}

export class JsonlAudit implements AuditSink {
  private warned = false;
  constructor(private readonly path: string) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }
  write(entry: AuditEntry): void {
    if (!this.path) return;
    try {
      appendFileSync(this.path, `${JSON.stringify(auditLine(entry))}\n`, { mode: 0o600 });
    } catch (err) {
      if (!this.warned) {
        console.warn(`[audit] write failed (${(err as Error).name}); continuing without audit file`);
        this.warned = true;
      }
    }
  }
}

export class MemoryAudit implements AuditSink {
  readonly lines: Record<string, unknown>[] = [];
  write(entry: AuditEntry): void {
    this.lines.push(auditLine(entry));
  }
}
