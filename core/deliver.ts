import { randomUUID } from "node:crypto";
import type { ResolvedAgent } from "./registry.js";
import type { DeliveryRequest, DeliveryResult } from "./types.js";

/** HTTP-level delivery failure. `body` is capped and never logged by the core. */
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
 * Auth problems and other 4xx fail fast.
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

/** Short, content-free reason code for logs and the wake body. */
export function failureCode(err: unknown): string {
  if (err instanceof DeliveryError) return /\b1033\b/.test(err.body) ? "tunnel_1033" : `http_${err.status}`;
  if (err instanceof DeliveryConfigError) return "config";
  const e = err as { name?: string } | null;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "timeout";
  return "network";
}

export type FetchLike = typeof fetch;

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  fetchImpl: FetchLike,
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
  opts: { from: string; requestId?: string; fetchImpl?: FetchLike },
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
  opts: { fetchImpl?: FetchLike },
): Promise<DeliveryResult> {
  if (!agent.key) throw new DeliveryConfigError("gateway token missing (fail-closed)");
  return post(agent.url, { Authorization: `Bearer ${agent.key}` }, req, agent.timeoutMs, opts.fetchImpl ?? fetch);
}

export async function deliver(
  agent: ResolvedAgent,
  req: DeliveryRequest,
  opts: { from: string; requestId?: string; fetchImpl?: FetchLike },
): Promise<DeliveryResult> {
  return agent.kind === "webhook" ? deliverWebhook(agent, req, opts) : deliverSendPrompt(agent, req, opts);
}
