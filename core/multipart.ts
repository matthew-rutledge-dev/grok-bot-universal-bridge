/**
 * Minimal multipart/form-data parser (RFC 7578) for callback bodies. No dependencies.
 * The HTTP layer only captures the raw bytes (already capped by the route's maxBytes);
 * parsing happens in the handler, i.e. after the callback token was checked.
 */
export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export interface MultipartLimits {
  /** Max parts (fields + files). Default 32. */
  maxParts?: number;
  /** Max bytes of one non-file field. Default 64 KiB. */
  maxFieldBytes?: number;
}

export class MultipartError extends Error {
  constructor(readonly code: "multipart_invalid" | "multipart_too_many_parts" | "multipart_field_too_large") {
    super(code);
    this.name = "MultipartError";
  }
}

/** Raw multipart body, parsed lazily (after auth). */
export class MultipartBody {
  constructor(
    readonly raw: Buffer,
    readonly boundary: string,
  ) {}

  parse(limits: MultipartLimits = {}): MultipartPart[] {
    return parseMultipart(this.raw, this.boundary, limits);
  }
}

/** boundary from a content-type header, or undefined when not multipart/form-data. */
export function multipartBoundary(contentType: string | undefined): string | undefined {
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType)) return undefined;
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType);
  return m ? (m[1] ?? m[2]) : undefined;
}

function dispositionParam(value: string, key: string): string | undefined {
  const star = new RegExp(`;\\s*${key}\\*=([^;]+)`, "i").exec(value);
  if (star) {
    const v = star[1].trim().replace(/^"|"$/g, "");
    const m = /^[^']*'[^']*'(.*)$/.exec(v);
    try {
      return decodeURIComponent(m ? m[1] : v);
    } catch {
      /* fall through */
    }
  }
  const q = new RegExp(`;\\s*${key}="((?:[^"\\\\]|\\\\.)*)"`, "i").exec(value);
  if (q) return q[1].replace(/\\(.)/g, "$1");
  const t = new RegExp(`;\\s*${key}=([^;\\s]+)`, "i").exec(value);
  return t ? t[1] : undefined;
}

export function parseMultipart(raw: Buffer, boundary: string, limits: MultipartLimits = {}): MultipartPart[] {
  const maxParts = limits.maxParts ?? 32;
  const maxField = limits.maxFieldBytes ?? 64 * 1024;
  const delim = Buffer.from(`--${boundary}`);
  const next = Buffer.from(`\r\n--${boundary}`);
  let pos = raw.indexOf(delim);
  if (pos < 0) throw new MultipartError("multipart_invalid");
  const parts: MultipartPart[] = [];
  for (;;) {
    pos += delim.length;
    if (raw[pos] === 0x2d && raw[pos + 1] === 0x2d) break; // closing "--"
    if (raw[pos] !== 0x0d || raw[pos + 1] !== 0x0a) throw new MultipartError("multipart_invalid");
    pos += 2;
    const end = raw.indexOf(next, pos);
    if (end < 0) throw new MultipartError("multipart_invalid");
    const part = raw.subarray(pos, end);
    const hEnd = part.indexOf("\r\n\r\n");
    if (hEnd < 0) throw new MultipartError("multipart_invalid");
    const headers: Record<string, string> = {};
    for (const line of part.subarray(0, hEnd).toString("utf8").split("\r\n")) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const disp = headers["content-disposition"] ?? "";
    if (!/^form-data\b/i.test(disp)) throw new MultipartError("multipart_invalid");
    const name = dispositionParam(disp, "name");
    if (!name) throw new MultipartError("multipart_invalid");
    const filename = dispositionParam(disp, "filename");
    const data = part.subarray(hEnd + 4);
    if (filename === undefined && data.length > maxField) throw new MultipartError("multipart_field_too_large");
    parts.push({ name, ...(filename !== undefined ? { filename } : {}), ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}), data });
    if (parts.length > maxParts) throw new MultipartError("multipart_too_many_parts");
    pos = end + 2;
  }
  return parts;
}
