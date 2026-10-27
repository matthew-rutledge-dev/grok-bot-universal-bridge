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
 * Mask an identifier for audit lines: keep the last 4 characters.
 * "5YJ0000000EXAMPLE" -> "…MPLE". Short values become "…".
 */
export function maskId(raw: string | undefined | null): string {
  const v = (raw ?? "").trim();
  if (v.length <= 4) return "…";
  return `…${v.slice(-4)}`;
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
