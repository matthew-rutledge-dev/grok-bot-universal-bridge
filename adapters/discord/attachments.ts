import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Attachment rules, ported from the existing Discord bridge.
 *
 * Inbound (Discord -> agent): the bridge does NOT download anything. It passes
 * up to 10 URL refs (Discord CDN `url`, fallback `proxyURL`) with filename,
 * contentType and size in the prompt trailer (`a=<url>`) and in
 * metadata.attachments. Voice messages are attachments too (audio/ogg), so
 * they travel the same way.
 *
 * Outbound (agent callback -> Discord): base64 `data` or an https `url` the
 * bridge fetches (15 s timeout). MIME allowlist (images/media, PDF, Office,
 * text/code, zip/tar/gz/7z/rar; never exe/msi/dmg/iso), 8 MiB per file,
 * 25 MiB total, 10 files.
 */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;

export const ALLOWED_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "video/mp4", "video/webm",
  "audio/mpeg", "audio/ogg", "audio/wav",
  "application/pdf", "text/plain",
  // office documents
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation", "application/rtf",
  "text/csv", "text/tab-separated-values",
  // text / code
  "text/markdown", "text/html", "text/css", "text/javascript", "application/javascript",
  "application/json", "application/xml", "text/xml", "application/x-yaml", "text/yaml",
  "text/x-python", "application/x-python", "text/x-shellscript", "application/x-sh",
  "application/x-powershell", "text/x-powershell",
  // archives
  "application/zip", "application/x-tar", "application/tar", "application/gzip", "application/x-gzip",
  "application/x-gtar", "application/x-7z-compressed", "application/vnd.rar", "application/x-rar-compressed",
]);

const EXT_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".mpeg": "audio/mpeg",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".wav": "audio/wav",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".xml": "application/xml", ".yml": "application/x-yaml", ".yaml": "application/x-yaml",
  ".py": "text/x-python", ".ps1": "application/x-powershell", ".sh": "application/x-sh", ".bash": "application/x-sh",
  ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".html": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".ts": "text/plain",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation", ".rtf": "application/rtf",
  ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip", ".tgz": "application/x-gtar",
  ".7z": "application/x-7z-compressed", ".rar": "application/vnd.rar",
};

export type AttachmentErrorCode =
  | "attachment_too_large"
  | "too_many_attachments"
  | "unsupported_media_type"
  | "attachment_fetch_failed"
  | "invalid_attachment"
  | "invalid_attachment_url";

export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AttachmentError";
  }
}

/** HTTP status for an attachment error (same mapping as the existing bridge). */
export function attachmentHttpStatus(code: AttachmentErrorCode): number {
  if (code === "unsupported_media_type") return 415;
  if (code === "attachment_fetch_failed") return 502;
  return 400;
}

export interface ResolvedAttachment {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

export interface WakeAttachmentRef {
  url: string;
  filename?: string;
  contentType?: string;
  size?: number;
}

export interface JsonAttachmentInput {
  filename?: unknown;
  contentType?: unknown;
  data?: unknown;
  url?: unknown;
}

export function guessMimeFromFilename(filename: string): string | undefined {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz")) return "application/gzip";
  const dot = lower.lastIndexOf(".");
  return dot < 0 ? undefined : EXT_MIME[lower.slice(dot)];
}

export function normalizeMime(raw: string | undefined, filename: string): string {
  const base = (raw ?? "").split(";")[0].trim().toLowerCase();
  if (base && base !== "application/octet-stream" && ALLOWED_MIME.has(base)) return base;
  if (base === "image/jpg") return "image/jpeg";
  const guessed = guessMimeFromFilename(filename);
  if (guessed) return guessed;
  return base || "application/octet-stream";
}

/** Refused by extension whatever MIME type the caller claims. */
export const BLOCKED_EXTENSIONS = [".exe", ".msi", ".dmg", ".iso", ".appimage", ".bat", ".cmd", ".scr", ".com"] as const;

export function assertExtensionAllowed(filename: string): void {
  const lower = filename.trim().toLowerCase().replace(/[.\s]+$/, "");
  if (BLOCKED_EXTENSIONS.some((ext) => lower.endsWith(ext))) throw new AttachmentError("unsupported_media_type", "blocked extension");
}

export function assertMimeAllowed(contentType: string): void {
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(base)) throw new AttachmentError("unsupported_media_type");
}

/** Short, content-free kind for audit lines: image, video, audio, pdf, office, text, archive, other. */
export function mimeKind(contentType: string | undefined): string {
  const m = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (/officedocument|msword|ms-excel|ms-powerpoint|opendocument|rtf/.test(m)) return "office";
  if (/zip|tar|gzip|7z|rar/.test(m)) return "archive";
  if (m.startsWith("text/") || /json|xml|yaml|javascript|python|x-sh|powershell/.test(m)) return "text";
  return "other";
}

export function safeFilename(name: unknown, fallback: string): string {
  const raw = (typeof name === "string" ? name : fallback).trim() || fallback;
  return raw.replace(/[/\\:\0<>|"?*\u0000-\u001f]/g, "_").slice(0, 200) || fallback;
}

function filenameFromUrl(urlStr: string): string {
  try {
    const last = new URL(urlStr).pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last).slice(0, 200);
  } catch {
    /* ignore */
  }
  return "attachment.bin";
}

export function decodeBase64Attachment(input: JsonAttachmentInput, maxBytes = MAX_ATTACHMENT_BYTES): ResolvedAttachment {
  if (typeof input.data !== "string" || !input.data.trim()) throw new AttachmentError("invalid_attachment", "data required");
  if (typeof input.filename !== "string" || !input.filename.trim()) throw new AttachmentError("invalid_attachment", "filename required for data");
  const filename = safeFilename(input.filename, "file.bin");
  assertExtensionAllowed(filename);
  const raw = input.data.trim().replace(/^data:[^;]+;base64,/i, "");
  if (!/^[A-Za-z0-9+/=\s_-]+$/.test(raw)) throw new AttachmentError("invalid_attachment", "invalid base64");
  // Reject before decoding when the encoded size already exceeds the cap.
  if (Math.floor((raw.length * 3) / 4) > maxBytes + 3) throw new AttachmentError("attachment_too_large");
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length === 0) throw new AttachmentError("invalid_attachment", "empty data");
  if (buffer.length > maxBytes) throw new AttachmentError("attachment_too_large");
  const contentType = normalizeMime(typeof input.contentType === "string" ? input.contentType : undefined, filename);
  assertMimeAllowed(contentType);
  return { filename, contentType, buffer };
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  /**
   * Hosts allowed over plain http (loopback only: tests and the local smoke
   * run's mock CDN). Everything else must be https.
   */
  allowHttpHosts?: readonly string[];
  timeoutMs?: number;
  /** Byte cap for this file (default 8 MiB; resolveJsonAttachments passes what is left of the 25 MiB total). */
  maxBytes?: number;
  /** DNS lookup (tests). Default: node:dns/promises lookup, all addresses. */
  lookup?: (host: string) => Promise<{ address: string }[]>;
}

export const MAX_REDIRECTS = 3;

/** Private, loopback, link-local, CGNAT, unspecified, multicast/reserved, ULA and v4-mapped forms. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (isIP(v) === 6) {
    if (v === "::" || v === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v)) return true; // hex-form v4-mapped: refuse
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
  }
  return false;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function validateAllowHttpHosts(hosts: unknown): string[] {
  if (hosts === undefined) return [];
  if (!Array.isArray(hosts)) return ["discord.attachments.allowHttpHosts must be an array"];
  return hosts.filter((h) => !LOOPBACK.has(String(h))).map((h) => `discord.attachments.allowHttpHosts: ${String(h)} is not loopback`);
}

function urlAllowed(u: URL, opts: FetchOptions): boolean {
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname) && (opts.allowHttpHosts ?? []).includes(u.hostname);
}

/**
 * Every hop: scheme rule (urlAllowed) and no private / loopback / link-local
 * target (literal IP or any DNS answer), unless the host is in allowHttpHosts.
 */
async function assertTargetAllowed(u: URL, opts: FetchOptions): Promise<void> {
  if (!urlAllowed(u, opts)) throw new AttachmentError("invalid_attachment_url", "https only");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if ((opts.allowHttpHosts ?? []).includes(u.hostname)) return;
  if (host === "localhost" || host.endsWith(".localhost")) throw new AttachmentError("invalid_attachment_url", "private target");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new AttachmentError("invalid_attachment_url", "private target");
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await (opts.lookup ?? ((h: string) => dnsLookup(h, { all: true })))(host);
  } catch {
    throw new AttachmentError("attachment_fetch_failed", "dns");
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new AttachmentError("invalid_attachment_url", "private target");
}

export async function fetchUrlAttachment(input: JsonAttachmentInput, opts: FetchOptions = {}): Promise<ResolvedAttachment> {
  if (typeof input.url !== "string" || !input.url.trim()) throw new AttachmentError("invalid_attachment", "url required");
  let current: URL;
  try {
    current = new URL(input.url.trim());
  } catch {
    throw new AttachmentError("invalid_attachment_url");
  }
  if (!urlAllowed(current, opts)) throw new AttachmentError("invalid_attachment_url", "https only");
  const filename = safeFilename(input.filename ?? filenameFromUrl(current.toString()), "attachment.bin");
  assertExtensionAllowed(filename);
  const maxBytes = Math.min(opts.maxBytes ?? MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    let res: Response | undefined;
    for (let hop = 0; ; hop++) {
      await assertTargetAllowed(current, opts);
      res = await (opts.fetchImpl ?? fetch)(current.toString(), { method: "GET", redirect: "manual", signal, headers: { accept: "*/*" } });
      if (res.status < 300 || res.status > 399 || res.status === 304) break;
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new AttachmentError("attachment_fetch_failed", "redirect without location");
      if (hop >= MAX_REDIRECTS) throw new AttachmentError("attachment_fetch_failed", "too many redirects");
      try {
        current = new URL(loc, current);
      } catch {
        throw new AttachmentError("invalid_attachment_url", "bad redirect");
      }
    }
    if (!res.ok) throw new AttachmentError("attachment_fetch_failed", `HTTP ${res.status}`);
    const contentType = normalizeMime(
      typeof input.contentType === "string" ? input.contentType : res.headers.get("content-type") ?? undefined,
      filename,
    );
    assertMimeAllowed(contentType);
    const len = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(len) && len > maxBytes) throw new AttachmentError("attachment_too_large");
    const buffer = await readCapped(res, maxBytes);
    if (buffer.length === 0) throw new AttachmentError("attachment_fetch_failed", "empty body");
    return { filename, contentType, buffer };
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError("attachment_fetch_failed", (err as Error)?.name ?? "fetch");
  }
}

/** Read a body but stop as soon as it passes the cap (no content-length trust). */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new AttachmentError("attachment_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Resolve callback attachments: each item has exactly one of data or url. */
export async function resolveJsonAttachments(items: unknown, opts: FetchOptions = {}): Promise<ResolvedAttachment[]> {
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) throw new AttachmentError("invalid_attachment", "attachments must be an array");
  if (items.length === 0) return [];
  if (items.length > MAX_ATTACHMENTS) throw new AttachmentError("too_many_attachments");
  const out: ResolvedAttachment[] = [];
  let total = 0;
  for (const item of items as JsonAttachmentInput[]) {
    if (!item || typeof item !== "object") throw new AttachmentError("invalid_attachment");
    const hasData = typeof item.data === "string" && item.data.length > 0;
    const hasUrl = typeof item.url === "string" && item.url.length > 0;
    if (hasData === hasUrl) throw new AttachmentError("invalid_attachment", "each attachment needs exactly one of data or url");
    // Per-file cap shrinks to what is left of the total, so the total is enforced while streaming too.
    const left = Math.min(MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES - total);
    if (left <= 0) throw new AttachmentError("attachment_too_large", "total exceeds 25 MiB");
    const r = hasData ? decodeBase64Attachment(item, left) : await fetchUrlAttachment(item, { ...opts, maxBytes: left });
    total += r.buffer.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new AttachmentError("attachment_too_large", "total exceeds 25 MiB");
    out.push(r);
  }
  return out;
}

/** Inbound: keep at most 10 refs with a URL. Nothing is fetched. */
export function wakeRefs(refs: readonly WakeAttachmentRef[] | undefined): WakeAttachmentRef[] {
  return (refs ?? []).filter((r) => typeof r.url === "string" && r.url).slice(0, MAX_ATTACHMENTS);
}

