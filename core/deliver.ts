import { randomUUID } from "node:crypto";
import type { ResolvedAgent } from "./registry.js";
import { maskDeliveryMessage } from "./redact.js";
import type { DeliveryRequest, DeliveryResult, Logger } from "./types.js";

/** HTTP-level delivery failure. `body` is capped. A masked 409 excerpt may be logged. */
export class DeliveryError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body = "") {
    super(message);
    this.name = "DeliveryError";
    this.status = status;
    this.body = body.slice(0, 2000);
  }
}

/** Missing key / bad config. Never retried. */
export class DeliveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryConfigError";
  }
}

export const USER_AGENT = "grok-bot-universal-bridge/0.1";

/**
 * Hold-and-retry classification. A sleeping computer or a tunnel that is down:
 * HTTP 502/503/504/530, Cloudflare 1033 in the body, timeouts, network errors.
 * Auth problems and other 4xx fail fast. HTTP 409 from a sendPrompt gateway is
 * a reject (stale token, or an agent id the gateway no longer serves), not a
 * successful dedupe. A masked excerpt is logged. The hold path may retry a 409
 * on an already-held item for a short grace window after a wake.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof DeliveryConfigError) return false;
  if (err instanceof DeliveryError) {
    const s = err.status;
    if (s >= 400 && s < 500) return s === 408 || s === 429;
    if (s === 502 || s === 503 || s === 504 || s === 530) return true;
    if (s >= 520 && s <= 529) return true;
    return /\b1033\b/.test(err.body);
  }
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return true;
  const text = `${e?.message ?? ""} ${e?.cause?.code ?? ""} ${e?.cause?.message ?? ""}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|UND_ERR/i.test(text);
}

/** HTTP 409 from the delivery target (typically the sendPrompt gateway). */
export function isGatewayConflict(err: unknown): boolean {
  return err instanceof DeliveryError && err.status === 409;
}

/** After a wake, a 409 on a held item is retried this long before giving up. */
export const GATEWAY_CONFLICT_GRACE_MS = 60_000;

/** Short, content-free reason code for logs and the wake body. */
export function failureCode(err: unknown): string {
  if (err instanceof DeliveryError) return /\b1033\b/.test(err.body) ? "tunnel_1033" : `http_${err.status}`;
  if (err instanceof DeliveryConfigError) return "config";
  const e = err as { name?: string } | null;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "timeout";
  return "network";
}

export type FetchLike = typeof fetch;

export type DeliverOpts = { from: string; requestId?: string; fetchImpl?: FetchLike; log?: Logger };

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  fetchImpl: FetchLike,
  log?: Logger,
): Promise<DeliveryResult> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  const text = (await res.text()).slice(0, 4000);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (res.status === 409) {
    log?.warn(`[deliver] rejected code=http_409 message=${maskDeliveryMessage(text)}`);
  }
  if (!res.ok) throw new DeliveryError(`delivery HTTP ${res.status}`, res.status, text);
  return { status: res.status, body: parsed };
}

/**
 * Webhook-triggered routine. Same shape the grokbuild client sends:
 * { kind: "prompt", prompt, from, sentAt, requestId, agentId, metadata }.
 * A 200 with { success: false } is a rejection (not retried).
 */
export async function deliverWebhook(
  agent: ResolvedAgent,
  req: DeliveryRequest,
  opts: DeliverOpts,
): Promise<DeliveryResult> {
  if (!agent.key) throw new DeliveryConfigError("webhook key missing (fail-closed)");
  const payload = {
    kind: "prompt",
    prompt: req.prompt,
    from: opts.from,
    sentAt: new Date().toISOString(),
    requestId: opts.requestId ?? randomUUID(),
    agentId: req.agentId,
    metadata: req.metadata ?? {},
  };
  const res = await post(
    agent.url,
    { Authorization: `Bearer ${agent.key}`, "X-Automation-Key": agent.key },
    payload,
    agent.timeoutMs,
    opts.fetchImpl ?? fetch,
    opts.log,
  );
  if ((res.body as { success?: unknown } | null)?.success === false) {
    throw new DeliveryError("routine rejected the request", 422, "");
  }
  return res;
}

/** sendPrompt-style gateway (compatibility). Bearer token required. */
export async function deliverSendPrompt(
  agent: ResolvedAgent,
  req: DeliveryRequest,
  opts: Omit<DeliverOpts, "from">,
): Promise<DeliveryResult> {
  if (!agent.key) throw new DeliveryConfigError("gateway token missing (fail-closed)");
  return post(agent.url, { Authorization: `Bearer ${agent.key}` }, req, agent.timeoutMs, opts.fetchImpl ?? fetch, opts.log);
}

export async function deliver(
  agent: ResolvedAgent,
  req: DeliveryRequest,
  opts: DeliverOpts,
): Promise<DeliveryResult> {
  return agent.kind === "webhook" ? deliverWebhook(agent, req, opts) : deliverSendPrompt(agent, req, opts);
}
