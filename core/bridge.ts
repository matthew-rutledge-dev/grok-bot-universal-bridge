import { dirname, join } from "node:path";
import { authorize, type AuthzResult } from "./allowlist.js";
import type { AuditEntry, AuditSink } from "./audit.js";
import { deliver, DeliveryConfigError, failureCode, type FetchLike } from "./deliver.js";
import { HoldQueue, type HeldItem, type HoldUi } from "./hold.js";
import { safeEqual, tokenFromHeaders, type Handler, type HttpResponse, HttpServer } from "./http.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import type { Registry } from "./registry.js";
import { readRef, resolveSecret, type SecretEnv } from "./secrets.js";
import { NO_WAKE, type WakeHook } from "./wake.js";
import { consoleLogger, type DenyReason, type InboundEvent, type Logger, type Route } from "./types.js";

export type EventState = "queued" | "held" | "delivered" | "failed";

export type SubmitResult =
  | { accepted: true; id: string; state: EventState; agent: string }
  | { accepted: false; reason: DenyReason };

/** What the core gives each adapter. */
export interface AdapterContext {
  readonly name: string;
  readonly log: Logger;
  /** Base URL agents use to reach this adapter's callback (e.g. https://bridge.example.com/discord/callback). */
  readonly callbackUrl: string;
  submit(event: InboundEvent): Promise<SubmitResult>;
  /** Same allowlist check submit uses, without delivering (for outbound checks). */
  check(event: InboundEvent): AuthzResult;
  audit(entry: Omit<AuditEntry, "adapter">): void;
  /** Register an HTTP route under /<adapter>/... */
  route(method: "GET" | "POST", subpath: string, handler: Handler, opts?: { maxBytes?: number }): void;
  /** Same, behind the adapter's callback token + rate limit (agent-facing routes such as voice). */
  authedRoute(
    method: "GET" | "POST",
    subpath: string,
    action: AuditEntry["action"],
    handler: Handler,
    opts?: { maxBytes?: number },
  ): void;
  secret(ref: string | undefined): string | undefined;
  state(eventId: string): EventState | undefined;
  /** Raw value of an env:/file: reference (no placeholder filtering). Throws on a bad shape. */
  raw(ref: string): string | undefined;
  /** Path for adapter-owned state under the data dir ("" = memory only). */
  dataFile(name: string): string;
}

/** One source adapter. See adapters/README.md. */
export interface SourceAdapter {
  readonly name: string;
  /** Deny-by-default route table (from the adapter's config). */
  readonly routes: Route[];
  /** env:/file: reference for the callback bearer token. Unset = no callback (fail-closed 503 if handleCallback exists). */
  readonly callbackTokenRef?: string;
  /** Max callback body bytes (attachments). */
  readonly callbackMaxBytes?: number;
  init(ctx: AdapterContext): Promise<void> | void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Status UI while held / after delivery. Optional. */
  readonly ui?: Partial<HoldUi>;
  /** Agent reply. Body already authenticated by the core. */
  handleCallback?(body: unknown): Promise<HttpResponse>;
}

export interface BridgeOptions {
  registry: Registry;
  audit: AuditSink;
  http: HttpServer;
  holdFile: string;
  holdMaxSec: number;
  /** "" when unset: ctx.callbackUrl is then "" (only allowed when no callback route is live). */
  publicBaseUrl?: string;
  callbackRateLimitPerMin?: number;
  wake?: WakeHook;
  log?: Logger;
  env?: SecretEnv;
  fetchImpl?: FetchLike;
  delayMs?: (failures: number) => number;
  /** Cap on remembered event states (default 10000). Oldest are dropped first. */
  maxStates?: number;
}

const DEFAULT_MAX_STATES = 10_000;
const STATE_TTL_MS = 6 * 60 * 60 * 1000;

export class Bridge {
  readonly hold: HoldQueue;
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly states = new Map<string, { state: EventState; at: number }>();
  private readonly log: Logger;
  private readonly limiter: SlidingWindowRateLimiter;

  constructor(private readonly opts: BridgeOptions) {
    this.log = opts.log ?? consoleLogger;
    this.limiter = new SlidingWindowRateLimiter(opts.callbackRateLimitPerMin ?? 90);
    this.hold = new HoldQueue({
      filePath: opts.holdFile,
      maxMs: Math.max(0, opts.holdMaxSec) * 1000,
      wake: opts.wake ?? NO_WAKE,
      log: this.log,
      delayMs: opts.delayMs,
      send: (item) => this.send(item),
      ui: this.uiRouter(),
      onTry: (item, outcome, err) => {
        const action = outcome === "ok" ? "deliver" : outcome === "held" ? (item.tries > 1 ? "retry" : "hold") : "give_up";
        this.opts.audit.write({
          adapter: item.adapter,
          action,
          outcome: outcome === "ok" ? "ok" : outcome === "held" ? "held" : "error",
          reason: err ? failureCode(err) : undefined,
          agent: item.agent,
          eventId: item.id,
          lane: item.lane,
          tries: item.tries,
        });
      },
    });
    opts.http.route("GET", "/healthz", () => ({
      status: 200,
      body: { ok: true, adapters: [...this.adapters.keys()], held: this.hold.heldCount() },
    }));
  }

  async add(adapter: SourceAdapter): Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(adapter.name)) throw new Error(`bad adapter name ${adapter.name}`);
    if (this.adapters.has(adapter.name)) throw new Error(`adapter ${adapter.name} added twice`);
    this.adapters.set(adapter.name, adapter);
    const name = adapter.name;
    const ctx: AdapterContext = {
      name,
      log: this.log,
      callbackUrl: this.opts.publicBaseUrl ? `${this.opts.publicBaseUrl.replace(/\/+$/, "")}/${name}/callback` : "",
      submit: (event) => this.submit(adapter, event),
      check: (event) => authorize(adapter.routes, event),
      audit: (entry) => this.opts.audit.write({ ...entry, adapter: name }),
      route: (method, subpath, handler, o) => this.opts.http.route(method, `/${name}/${subpath.replace(/^\/+/, "")}`, handler, o),
      authedRoute: (method, subpath, action, handler, o) =>
        this.opts.http.route(method, `/${name}/${subpath.replace(/^\/+/, "")}`, this.guard(adapter, action, handler), o),
      secret: (ref) => resolveSecret(ref, this.opts.env ?? process.env),
      raw: (ref) => readRef(ref, this.opts.env ?? process.env),
      state: (eventId) => this.stateOf(`${name}:${eventId}`),
      dataFile: (file) => (this.opts.holdFile ? join(dirname(this.opts.holdFile), `${name}-${file}`) : ""),
    };
    if (adapter.handleCallback) this.registerCallback(adapter);
    await adapter.init(ctx);
  }

  async start(): Promise<void> {
    await this.hold.load();
    for (const a of this.adapters.values()) await a.start();
  }

  async stop(): Promise<void> {
    this.hold.stop();
    for (const a of this.adapters.values()) await a.stop().catch(() => undefined);
  }

  stateOf(id: string): EventState | undefined {
    const s = this.states.get(id);
    if (!s) return undefined;
    if (Date.now() - s.at > STATE_TTL_MS) {
      this.states.delete(id);
      return undefined;
    }
    return s.state;
  }

  private stateWrites = 0;

  private setState(id: string, state: EventState): void {
    // Re-insert so Map order is oldest-update first.
    this.states.delete(id);
    this.states.set(id, { state, at: Date.now() });
    const max = this.opts.maxStates ?? DEFAULT_MAX_STATES;
    if (++this.stateWrites % 256 === 0 || this.states.size > max) this.sweepStates(max);
  }

  /** Drop expired states, then the oldest ones above the cap. */
  sweepStates(max = this.opts.maxStates ?? DEFAULT_MAX_STATES): void {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [id, s] of this.states) if (s.at < cutoff) this.states.delete(id);
    for (const id of this.states.keys()) {
      if (this.states.size <= max) break;
      this.states.delete(id);
    }
  }

  stateCount(): number {
    return this.states.size;
  }

  async submit(adapter: SourceAdapter, event: InboundEvent): Promise<SubmitResult> {
    const ev: InboundEvent = { ...event, adapter: adapter.name };
    const id = `${adapter.name}:${ev.eventId}`;
    const base = { adapter: adapter.name, action: "inbound" as const, eventId: id, lane: ev.lane, actor: ev.actor };
    const deny = (reason: DenyReason, extra?: Partial<AuditEntry>): SubmitResult => {
      this.opts.audit.write({ ...base, outcome: "deny", reason, ...extra });
      return { accepted: false, reason };
    };
    if (this.stateOf(id) || this.hold.has(id)) return deny("duplicate");
    const authz = authorize(adapter.routes, ev);
    if (!authz.ok) return deny(authz.reason, { route: authz.route?.id });
    const alias = authz.route.agent;
    if (!this.opts.registry.has(alias)) return deny("agent_unknown", { route: authz.route.id });
    const resolved = this.opts.registry.resolve(alias);
    if (!resolved.agent) return deny("agent_not_ready", { route: authz.route.id, agent: alias });
    this.opts.audit.write({ ...base, outcome: "allow", agent: alias, route: authz.route.id });
    this.setState(id, "queued");
    await this.hold.submit({
      id,
      adapter: adapter.name,
      lane: `${adapter.name}:${ev.lane}`,
      agent: alias,
      request: { agentId: resolved.agent.agentId, prompt: ev.prompt, metadata: { ...(ev.metadata ?? {}), source: adapter.name, eventId: ev.eventId } },
      ref: ev.ref,
    });
    return { accepted: true, id, state: this.stateOf(id) ?? "queued", agent: alias };
  }

  private async send(item: HeldItem) {
    const r = this.opts.registry.resolve(item.agent);
    if (!r.agent) throw new DeliveryConfigError("agent not ready");
    return deliver(r.agent, item.request, { from: `bridge:${item.adapter}`, requestId: item.id, fetchImpl: this.opts.fetchImpl });
  }

  private uiRouter(): HoldUi {
    return {
      holding: async (item) => {
        this.setState(item.id, "held");
        return this.adapters.get(item.adapter)?.ui?.holding?.(item);
      },
      delivered: async (item, result, info) => {
        this.setState(item.id, "delivered");
        await this.adapters.get(item.adapter)?.ui?.delivered?.(item, result, info);
      },
      failed: async (item, err, info) => {
        this.setState(item.id, "failed");
        await this.adapters.get(item.adapter)?.ui?.failed?.(item, err, info);
      },
    };
  }

  private registerCallback(adapter: SourceAdapter): void {
    this.opts.http.route(
      "POST",
      `/${adapter.name}/callback`,
      this.guard(adapter, "callback", (req) => adapter.handleCallback!(req.body)),
      { maxBytes: adapter.callbackMaxBytes },
    );
  }

  /**
   * Callback auth for any agent-facing route: header-only bearer (constant
   * time), ?token= refused, 503 when no token is configured, shared rate limit.
   */
  private guard(adapter: SourceAdapter, action: AuditEntry["action"], handler: Handler): Handler {
    const name = adapter.name;
    return async (req) => {
      const expected = resolveSecret(adapter.callbackTokenRef, this.opts.env ?? process.env);
      const audit = (outcome: AuditEntry["outcome"], reason?: string, status?: number) =>
        this.opts.audit.write({ adapter: name, action, outcome, reason, status });
      if (!expected) {
        audit("deny", "callback_token_unset", 503);
        return { status: 503, body: { ok: false, error: "callback_disabled" } };
      }
      if (req.query.has("token")) {
        audit("deny", "query_token_refused", 400);
        return { status: 400, body: { ok: false, error: "use the Authorization header, not ?token=" } };
      }
      const got = tokenFromHeaders(req.headers);
      if (!safeEqual(got, expected)) {
        audit("deny", "bad_token", 401);
        return { status: 401, body: { ok: false, error: "unauthorized" } };
      }
      const rl = this.limiter.check(name);
      if (!rl.allowed) {
        audit("deny", "rate_limited", 429);
        return { status: 429, body: { ok: false, error: "rate_limited" }, headers: { "retry-after": String(rl.retryAfterSec) } };
      }
      const out = await handler(req);
      audit(out.status < 400 ? "ok" : "error", (out.body as { error?: string } | null)?.error, out.status);
      return out;
    };
  }
}
