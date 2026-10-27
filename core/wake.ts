import { failureCode } from "./deliver.js";
import { isAllowedUrl } from "./registry.js";
import { safeErr } from "./redact.js";
import { consoleLogger, type Logger } from "./types.js";

/**
 * Wake-on-sleep hook.
 *
 * Hold-and-retry only helps if the Grok Bot's computer wakes inside the hold
 * window. When a wake URL is configured, the first time anything is held the
 * core POSTs once to it (for example a webhook routine that wakes the
 * computer). Body: { reason, heldCount, firstHeldAt } only: no message
 * content, no user or channel ids, no tokens.
 *
 * At most one POST per outage. Re-arms after the next successful delivery or
 * once nothing is held. Fire-and-forget with a short timeout: a failed wake
 * is logged (without URL or key) and the hold simply continues.
 */
export interface WakeHeldEvent {
  err: unknown;
  heldCount: number;
  firstHeldAt: number;
}

export interface WakeHook {
  held(event: WakeHeldEvent): void;
  succeeded(): void;
  idle(): void;
}

export const NO_WAKE: WakeHook = { held: () => undefined, succeeded: () => undefined, idle: () => undefined };

export interface WakeOptions {
  url?: string;
  key?: string;
  /** "Authorization" (default) sends Bearer; any other header name sends the raw key. */
  header?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: Logger;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function wakeAuthHeader(header: string | undefined, key: string | undefined) {
  if (!key) return undefined;
  const name = (header ?? "").trim() || "Authorization";
  if (!HEADER_NAME.test(name) || name.toLowerCase() === "authorization") {
    return { name: "Authorization", value: `Bearer ${key}` };
  }
  return { name, value: key };
}

export class HttpWakeHook implements WakeHook {
  readonly enabled: boolean;
  private fired = false;
  private readonly log: Logger;
  private readonly auth: { name: string; value: string } | undefined;
  /** Last POST, for tests. */
  lastPost: Promise<void> = Promise.resolve();
  posts = 0;

  constructor(private readonly opts: WakeOptions) {
    this.log = opts.log ?? consoleLogger;
    const url = (opts.url ?? "").trim();
    this.enabled = url !== "" && isAllowedUrl(url);
    if (url && !this.enabled) this.log.warn("[wake] off: wake URL must be https (http only on loopback)");
    this.auth = wakeAuthHeader(opts.header, opts.key);
    if (this.enabled && !this.auth) this.log.warn("[wake] on without a key (no auth header)");
  }

  get armed(): boolean {
    return this.enabled && !this.fired;
  }

  held(event: WakeHeldEvent): void {
    if (!this.enabled || this.fired) return;
    this.fired = true;
    this.posts += 1;
    this.lastPost = this.post({
      reason: failureCode(event.err),
      heldCount: Math.max(1, Math.floor(event.heldCount)),
      firstHeldAt: new Date(event.firstHeldAt).toISOString(),
    });
  }

  succeeded(): void {
    this.rearm("success");
  }

  idle(): void {
    this.rearm("no_held_events");
  }

  private rearm(why: string): void {
    if (!this.fired) return;
    this.fired = false;
    this.log.info(`[wake] re-armed reason=${why}`);
  }

  private async post(body: { reason: string; heldCount: number; firstHeldAt: string }): Promise<void> {
    const started = Date.now();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.auth) headers[this.auth.name] = this.auth.value;
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.opts.url as string, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
        redirect: "error",
      });
      await res.body?.cancel().catch(() => undefined);
      const line = `status=${res.status} reason=${body.reason} heldCount=${body.heldCount} ms=${Date.now() - started}`;
      if (res.ok) this.log.info(`[wake] sent ${line}`);
      else this.log.warn(`[wake] failed ${line} (hold continues)`);
    } catch (err) {
      this.log.warn(`[wake] failed err=${safeErr(err)} reason=${body.reason} (hold continues)`);
    }
  }
}
