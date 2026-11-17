/** Helpers that keep identifiers and secrets out of logs, audit lines and API answers. */

/** Hide the last path segment (webhook routine ids are secrets) and any query. */
export function redactUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const segs = u.pathname.split("/").filter(Boolean);
    const shown = segs.length ? segs.slice(0, -1).concat("…").join("/") : "";
    return `${u.protocol}//${u.host}/${shown}`;
  } catch {
    return "(invalid URL)";
  }
}

/**
 * Mask an identifier for audit lines: keep the last 4 characters (or `keep`, 4 or 6).
 * "5YJ0000000EXAMPLE" -> "…MPLE" (keep 6: "…XAMPLE"). Short values become "…".
 */
export function maskId(raw: string | undefined | null, keep: 4 | 6 = 4): string {
  const v = (raw ?? "").trim();
  if (v.length <= keep) return "…";
  return `…${v.slice(-keep)}`;
}

/** Error class / code only. Never the message: it can echo a URL or a key. */
export function safeErr(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown }; status?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : typeof err;
  const code = e?.cause?.code ?? e?.code;
  const status = typeof e?.status === "number" ? `/http_${e.status}` : "";
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? `${name}/${code}${status}` : `${name}${status}`;
}

/**
 * Neutralise the routing-trailer mark (U+27C2) in untrusted text, so a sender
 * cannot fake a "⟂ d:..." / "⟂ gb:..." line. The mark becomes the literal text "\u27C2".
 */
export function escapeTrailerMark(s: string): string {
  return s.replace(/\u27C2/g, "\\u27C2");
}

/** One line, no control characters, trimmed and capped. */
export function oneLine(s: string, max = 80): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Max length of a masked gateway / delivery body excerpt written to logs. */
export const MASKED_DELIVERY_MESSAGE_MAX = 200;

// Quoted JSON keys ("token":"value") and bare token=value / token: value forms.
const TOKENISH =
  /(?<![A-Za-z0-9_])["']?(?:authorization|bearer|token|api[_-]?key|secret|password|credential|key)s?["']?\s*[:=]\s*["']?[^\s"',}]{8,}/gi;
const SENSITIVE_KEY = /^(authorization|bearer|token|api[_-]?key|secret|password|credential|key)s?$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const LONG_HEX = /\b[0-9a-f]{16,}\b/gi;
const LONG_DEC = /\b\d{10,}\b/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

function pickMessage(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v;
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  for (const k of ["message", "error", "reason", "detail", "error_message", "errorMessage"]) {
    const got = pickMessage(o[k]);
    if (got) return got;
  }
  return undefined;
}

/** Replace string values of token-like keys before a fallback JSON.stringify. */
export function redactSensitiveFields(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactSensitiveFields);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) && typeof val === "string" ? "…" : redactSensitiveFields(val);
    }
    return out;
  }
  return v;
}

export type MaskDeliveryUrls = "redact" | "strip";

/**
 * Gateway / delivery body for logs and user-facing give-up text: one line,
 * tokens and URLs redacted, ids truncated, capped (default 200 characters).
 * `urls: "redact"` (default, for logs) keeps the host via redactUrl.
 * `urls: "strip"` replaces every URL with `[url]` (user-facing text).
 */
export function maskDeliveryMessage(
  raw: string,
  maxOrOpts: number | { max?: number; urls?: MaskDeliveryUrls } = MASKED_DELIVERY_MESSAGE_MAX,
): string {
  const opts = typeof maxOrOpts === "number" ? { max: maxOrOpts } : maxOrOpts;
  const max = opts.max ?? MASKED_DELIVERY_MESSAGE_MAX;
  const stripUrls = opts.urls === "strip";
  let text = raw ?? "";
  try {
    const parsed = JSON.parse(text) as unknown;
    const picked = pickMessage(parsed);
    if (picked) text = picked;
    else if (parsed && typeof parsed === "object") text = JSON.stringify(redactSensitiveFields(parsed));
  } catch {
    /* keep raw */
  }
  text = text.replace(URL_RE, (u) => (stripUrls ? "[url]" : (redactUrl(u) ?? "[url]")));
  text = text.replace(TOKENISH, (m) => m.replace(/[^\s"',}]{8,}$/i, "…"));
  text = text.replace(JWT, "…");
  text = text.replace(UUID, (id) => `…${id.slice(-4)}`);
  text = text.replace(LONG_HEX, (id) => `…${id.slice(-4)}`);
  text = text.replace(LONG_DEC, (id) => `…${id.slice(-4)}`);
  return oneLine(text, max);
}
