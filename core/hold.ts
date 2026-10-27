import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { failureCode, isRetryable } from "./deliver.js";
import { NO_WAKE, type WakeHook } from "./wake.js";
import { consoleLogger, type DeliveryRequest, type DeliveryResult, type Logger } from "./types.js";

/**
 * Hold-and-retry (generalised from the Discord bridge's sendPrompt hold).
 *
 * When the Grok Bot's computer sleeps or its tunnel is down, delivery fails
 * with a retryable error. Instead of failing at once the event is HELD: kept
 * in memory, mirrored to a JSON file (atomic rename, mode 600) and retried
 * with backoff (5 s, 10 s, 20 s, then every 30 s) until the hold window runs
 * out. Events in one lane stay in order. A wake hook fires once per outage;
 * if the wake fails the hold simply continues.
 */
export const DEFAULT_HOLD_MAX_SEC = 1800;
const BACKOFF_MS = [5_000, 10_000, 20_000];
const STEADY_MS = 30_000;

export function holdRetryDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return BACKOFF_MS[failures - 1] ?? STEADY_MS;
}

export interface HoldInput {
  /** Globally unique: `<adapter>:<eventId>`. */
  id: string;
  adapter: string;
  lane: string;
  agent: string;
  request: DeliveryRequest;
  ref?: Record<string, string>;
}

export interface HeldItem extends HoldInput {
  seq: number;
  submittedAt: number;
  deadline: number;
  holding: boolean;
  holdStartedAt?: number;
  tries: number;
  failures: number;
  /** Adapter-owned id of the single status message it edits (e.g. "Working on it"). */
  statusRef?: string;
}

export interface HoldUi {
  holding(item: HeldItem): Promise<string | undefined>;
  delivered(item: HeldItem, result: DeliveryResult, info: { held: boolean; elapsedMs: number }): Promise<void>;
  failed(item: HeldItem, err: unknown, info: { held: boolean; expired: boolean; elapsedMs: number }): Promise<void>;
}

export interface HoldQueueOptions {
  filePath: string;
  maxMs: number;
  send(item: HeldItem): Promise<DeliveryResult>;
  ui: HoldUi;
  wake?: WakeHook;
  log?: Logger;
  now?: () => number;
  /** Override backoff (tests and local smoke runs). */
  delayMs?: (failures: number) => number;
  /** Called after each try (audit). */
  onTry?: (item: HeldItem, outcome: "ok" | "held" | "give_up", err?: unknown) => void;
}

interface HoldFile {
  version: 1;
  items: HeldItem[];
}

const secs = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);

export class HoldQueue {
  private readonly lanes = new Map<string, HeldItem[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly busy = new Set<string>();
  private seq = 0;
  private wroteEntries = false;
  private lastWriteError = "";
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly wake: WakeHook;
  private readonly delay: (f: number) => number;
  private stopped = false;

  constructor(private readonly opts: HoldQueueOptions) {
    this.log = opts.log ?? consoleLogger;
    this.now = opts.now ?? (() => Date.now());
    this.wake = opts.wake ?? NO_WAKE;
    this.delay = opts.delayMs ?? holdRetryDelayMs;
  }

  snapshot(): HeldItem[] {
    return [...this.lanes.values()].flat().sort((a, b) => a.seq - b.seq);
  }

  heldCount(): number {
    return this.snapshot().filter((h) => h.holding).length;
  }

  has(id: string): boolean {
    return this.snapshot().some((h) => h.id === id);
  }

  /** Deliver now, or queue behind an earlier event in the same lane. Resolves after the first try. */
  async submit(input: HoldInput): Promise<void> {
    const now = this.now();
    const item: HeldItem = {
      ...input,
      seq: ++this.seq,
      submittedAt: now,
      deadline: now + this.opts.maxMs,
      holding: false,
      tries: 0,
      failures: 0,
    };
    const lane = this.lanes.get(item.lane) ?? [];
    lane.push(item);
    this.lanes.set(item.lane, lane);
    // Write before the first try so a crash mid-delivery cannot lose the event.
    this.persist();
    if (lane.length === 1) {
      await this.attempt(item.lane);
      return;
    }
    if (lane[0].holding) await this.startHold(item, "behind_earlier_held_event");
  }

  /** Reload unexpired held items after a restart. Expired ones are failed. */
  async load(): Promise<{ kept: number; expired: number }> {
    const path = this.opts.filePath;
    if (!path) return { kept: 0, expired: 0 };
    let parsed: HoldFile | undefined;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as HoldFile;
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") this.log.warn(`[hold] file unreadable; starting empty`);
      return { kept: 0, expired: 0 };
    }
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    // The file on disk has entries: the next persist() must rewrite it even if
    // nothing survives, or expired items would be failed again on every restart.
    if (items.length > 0) this.wroteEntries = true;
    const now = this.now();
    const expired: HeldItem[] = [];
    for (const it of items.sort((a, b) => a.seq - b.seq)) {
      if (!it?.id || !it.lane || !it.request || !it.adapter) continue;
      this.seq = Math.max(this.seq, it.seq);
      if (now >= it.deadline) {
        expired.push(it);
        continue;
      }
      const lane = this.lanes.get(it.lane) ?? [];
      lane.push({ ...it, holding: true, holdStartedAt: it.holdStartedAt ?? it.submittedAt });
      this.lanes.set(it.lane, lane);
    }
    this.persist();
    for (const it of expired) {
      this.opts.onTry?.(it, "give_up", new Error("expired while down"));
      await this.opts.ui.failed(it, new Error("hold expired"), { held: true, expired: true, elapsedMs: now - it.submittedAt }).catch(() => undefined);
    }
    for (const laneId of this.lanes.keys()) this.schedule(laneId, 0);
    const kept = this.snapshot().length;
    this.log.info(`[hold] reload kept=${kept} expired=${expired.length}`);
    return { kept, expired: expired.length };
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Wait until nothing is queued (tests / smoke). */
  async drain(timeoutMs = 10_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.snapshot().length === 0 && this.busy.size === 0) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }

  private schedule(lane: string, ms: number): void {
    if (this.stopped) return;
    const prev = this.timers.get(lane);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(lane);
      void this.attempt(lane);
    }, Math.max(0, ms));
    this.timers.set(lane, t);
  }

  private scheduleHead(lane: string): void {
    const head = this.lanes.get(lane)?.[0];
    if (!head) {
      this.lanes.delete(lane);
      return;
    }
    const left = head.deadline - this.now();
    this.schedule(lane, head.failures > 0 ? Math.min(this.delay(head.failures), Math.max(0, left)) : 0);
  }

  private async startHold(item: HeldItem, reason: string): Promise<void> {
    if (item.holding) return;
    item.holding = true;
    item.holdStartedAt = this.now();
    this.persist();
    this.log.warn(`[hold] start id=${item.adapter}:… lane=${item.adapter} maxSec=${Math.round(this.opts.maxMs / 1000)} reason=${reason}`);
    try {
      const ref = await this.opts.ui.holding(item);
      if (ref) item.statusRef = ref;
    } catch {
      this.log.warn(`[hold] status update failed adapter=${item.adapter}`);
    }
    this.persist();
  }

  private finish(lane: string, item: HeldItem): void {
    const l = this.lanes.get(lane);
    if (l && l[0] === item) l.shift();
    if (l && l.length === 0) this.lanes.delete(lane);
    this.persist();
  }

  private async attempt(lane: string): Promise<void> {
    const item = this.lanes.get(lane)?.[0];
    if (!item || this.busy.has(lane) || this.stopped) return;
    this.busy.add(lane);
    try {
      item.tries += 1;
      let result: DeliveryResult;
      try {
        result = await this.opts.send(item);
      } catch (err) {
        await this.onError(lane, item, err);
        return;
      }
      const now = this.now();
      this.finish(lane, item);
      this.safeWake(() => this.wake.succeeded());
      if (item.holding) this.log.info(`[hold] delivered after ${secs(now - (item.holdStartedAt ?? item.submittedAt))}s tries=${item.tries}`);
      this.opts.onTry?.(item, "ok");
      await this.opts.ui.delivered(item, result, { held: item.holding, elapsedMs: now - item.submittedAt }).catch(() => undefined);
    } finally {
      this.busy.delete(lane);
    }
    this.scheduleHead(lane);
  }

  private async onError(lane: string, item: HeldItem, err: unknown): Promise<void> {
    const now = this.now();
    const retryable = isRetryable(err);
    item.failures += 1;
    if (retryable && now < item.deadline) {
      if (!item.holding) {
        await this.startHold(item, failureCode(err));
        for (const behind of this.lanes.get(lane)?.slice(1) ?? []) await this.startHold(behind, "behind_earlier_held_event");
      } else {
        this.persist();
      }
      this.opts.onTry?.(item, "held", err);
      const held = this.snapshot().filter((h) => h.holding);
      if (held.length) {
        const firstHeldAt = Math.min(...held.map((h) => h.holdStartedAt ?? h.submittedAt));
        this.safeWake(() => this.wake.held({ err, heldCount: held.length, firstHeldAt }));
      }
      this.busy.delete(lane);
      this.scheduleHead(lane);
      return;
    }
    this.finish(lane, item);
    if (!this.snapshot().some((h) => h.holding)) this.safeWake(() => this.wake.idle());
    this.log.warn(`[hold] gave up adapter=${item.adapter} tries=${item.tries} reason=${retryable ? "window_expired" : "rejected"} code=${failureCode(err)}`);
    this.opts.onTry?.(item, "give_up", err);
    await this.opts.ui.failed(item, err, { held: item.holding, expired: retryable, elapsedMs: now - item.submittedAt }).catch(() => undefined);
    this.busy.delete(lane);
    this.scheduleHead(lane);
  }

  private safeWake(fn: () => void): void {
    try {
      fn();
    } catch {
      this.log.warn("[hold] wake hook threw; hold continues");
    }
  }

  private persist(): void {
    const path = this.opts.filePath;
    if (!path) return;
    // Every queued item, held or in flight, so a crash never loses one.
    const items = this.snapshot();
    if (items.length === 0 && !this.wroteEntries) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      // A stale tmp from a crash may carry old permissions; start fresh. (Mode 600 is a no-op on Windows.)
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify({ version: 1, items } satisfies HoldFile), { mode: 0o600 });
      renameSync(tmp, path);
      this.wroteEntries = items.length > 0;
      this.lastWriteError = "";
    } catch (err) {
      const code = (err as { code?: string }).code ?? "write_error";
      if (code !== this.lastWriteError) {
        this.log.warn(`[hold] file write failed code=${code} (memory only)`);
        this.lastWriteError = code;
      }
    }
  }
}
