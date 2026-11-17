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
 * a reject, not a successful dedupe. A permanent gateway code such as
 * send/agent-unavailable fails fast. A 409 with no code, or an unknown code,
 * may be retried on an already-held item for a short grace window after a wake.
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

/** After a wake, an unclassified 409 on a held item is retried this long before giving up. */
export const GATEWAY_CONFLICT_GRACE_MS = 60_000;

/** `kind/name` codes from a gateway 409 body (failureCode or code). */
const GATEWAY_CODE_RE = /^[a-z][a-z0-9_-]{0,32}\/[a-z][a-z0-9_-]{0,63}$/i;

/** Gateway 409 codes that will not recover on retry (no signed-in box session, etc.). */
export const PERMANENT_GATEWAY_CODES: ReadonlySet<string> = new Set(["send/agent-unavailable"]);

function pickGatewayCodeField(v: unknown): string[] {
  if (!v || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["failureCode", "code"]) if (typeof o[k] === "string") out.push(o[k] as string);
  if (o.error && typeof o.error === "object") out.push(...pickGatewayCodeField(o.error));
  return out;
}

/** Parse a safe `kind/name` failure code from a gateway 409 body. */
export function parseGatewayFailureCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    for (const raw of pickGatewayCodeField(parsed)) {
      const code = raw.trim().toLowerCase();
      if (GATEWAY_CODE_RE.test(code)) return code;
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

export function gatewayConflictCode(err: unknown): string | undefined {
  return isGatewayConflict(err) ? parseGatewayFailureCode((err as DeliveryError).body) : undefined;
}

/** A 409 whose gateway code is known to be permanent: fail fast, do not grace-retry. */
export function isPermanentGatewayConflict(err: unknown): boolean {
  const code = gatewayConflictCode(err);
  return code !== undefined && PERMANENT_GATEWAY_CODES.has(code);
}

/** Short, content-free reason code for logs and the wake body. */
export function failureCode(err: unknown): string {
  if (err instanceof DeliveryError) {
    if (/\b1033\b/.test(err.body)) return "tunnel_1033";
    const gw = err.status === 409 ? parseGatewayFailureCode(err.body) : undefined;
    return gw ?? `http_${err.status}`;
  }
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
    const failure = parseGatewayFailureCode(text);
    log?.warn(
      failure
        ? `[deliver] rejected code=http_409 failure=${failure}`
        : `[deliver] rejected code=http_409 message=${maskDeliveryMessage(text)}`,
    );
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
