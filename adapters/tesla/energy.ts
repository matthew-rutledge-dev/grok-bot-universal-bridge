/**
 * Read-only Fleet API energy client: live_status (each poll) and site_info (cached).
 * Only energy_sites endpoints. Never vehicle endpoints, never commands, never wakes.
 *
 * Token: an ACCESS token only (scope energy_device_data), read through the getter on
 * every request so a file: ref rewritten by the plugin/host is picked up. The bridge
 * never refreshes: Tesla refresh tokens rotate and are single-use, so a second refresher
 * would race the plugin and both would end up at login_required.
 */

export type EnergyErrorCode =
  | "fleet_api_unreachable"
  | "fleet_api_tls_error"
  | "unauthorized"
  | "login_required"
  | "missing_scope"
  | "rate_limited"
  | "no_token"
  | "fleet_api_error"
  | "redirect_refused"
  | "response_too_large";

export class EnergyApiError extends Error {
  constructor(
    readonly code: EnergyErrorCode,
    readonly status?: number,
    readonly retryAfterSec?: number,
  ) {
    super(code);
    this.name = "EnergyApiError";
  }
}

export interface EnergyStatus {
  siteId: string;
  gridStatus?: string;
  islandStatus?: string;
  percentCharged?: number;
  backupReservePercent?: number;
  stormModeActive?: boolean;
}

/** Energy live_status / site_info reader (site endpoints only, never vehicle_data). */
export interface EnergyStatusSource {
  liveStatus(siteId: string): Promise<EnergyStatus>;
  /** Optional: backup_reserve_percent lives in site_info. Called rarely (cached). */
  backupReserve?(siteId: string): Promise<number | undefined>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "error" }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** WHATWG stream when the implementation has one (global fetch does); read with a size cap. */
  body?: unknown;
}>;

/** Documented Fleet API regional base hosts (developer.tesla.com, "Regions and Countries"). */
export const FLEET_API_HOSTS = [
  "fleet-api.prd.na.vn.cloud.tesla.com",
  "fleet-api.prd.eu.vn.cloud.tesla.com",
  "fleet-api.prd.cn.vn.cloud.tesla.cn",
] as const;
export const NHTSA_HOSTS = ["api.nhtsa.gov"] as const;
/** Largest response body read from any REST call; bigger answers are aborted mid-stream. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** TESTS ONLY: extra hosts (and plain http) a client may call, e.g. a local mock server. Never set from config. */
export interface TestHostOverride {
  hosts: string[];
  allowHttp?: boolean;
}

/**
 * Problem with a base URL, or undefined when it is https://<allowlisted host> with no credentials,
 * no port other than 443, no path beyond "/", no query or fragment.
 */
export function baseUrlProblem(raw: string | undefined, hosts: readonly string[], label: string, test?: TestHostOverride): string | undefined {
  let u: URL;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    return `${label} must be an https URL`;
  }
  const testHost = test?.hosts.includes(u.hostname) ?? false;
  if (u.protocol !== "https:" && !(testHost && test?.allowHttp && u.protocol === "http:")) return `${label} must be an https URL`;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return `${label} must be a bare base URL (no credentials, path, query or fragment)`;
  if (u.port && u.port !== "443" && !testHost) return `${label} must use the default https port`;
  if (!hosts.includes(u.hostname.toLowerCase()) && !testHost) return `${label} must be one of: ${hosts.map((h) => `https://${h}`).join(", ")}`;
  return undefined;
}

/**
 * One GET with redirects refused and the body capped at `maxBytes` while it streams (the request
 * is aborted past the cap). Returns status, capped body text and Retry-After. Network errors are
 * mapped to codes; never the message (it can echo a URL).
 */
export async function guardedGet(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ status: number; body: string; retryAfter: string | null }> {
  const ctrl = new AbortController();
  const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(timeoutMs)]);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal, redirect: "error" });
  } catch (e) {
    throw mapFetchError(e);
  }
  if (res.status >= 300 && res.status < 400) {
    ctrl.abort();
    throw new EnergyApiError("redirect_refused", res.status);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    ctrl.abort();
    throw new EnergyApiError("response_too_large", res.status);
  }
  let body = "";
  const stream = res.body as { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null | undefined;
  try {
    if (stream && typeof stream.getReader === "function") {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        n += value.byteLength;
        if (n > maxBytes) {
          ctrl.abort();
          await reader.cancel().catch(() => undefined);
          throw new EnergyApiError("response_too_large", res.status);
        }
        chunks.push(value);
      }
      body = Buffer.concat(chunks).toString("utf8");
    } else {
      body = await res.text();
      if (Buffer.byteLength(body, "utf8") > maxBytes) throw new EnergyApiError("response_too_large", res.status);
    }
  } catch (e) {
    if (e instanceof EnergyApiError) throw e;
    // A body that fails mid-read is treated like no body for error statuses, and as unreachable on success.
    if (res.status < 200 || res.status >= 300) body = "";
    else throw mapFetchError(e);
  }
  return { status: res.status, body, retryAfter: res.headers.get("retry-after") };
}

/** A Retry-After longer than this is capped (a bad header must not silence polling for days). */
export const MAX_RETRY_AFTER_S = 3600;

const TLS_CODES = /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|ERR_CERT)/;

/** Network/TLS failure -> code. Never the message (it can echo a URL). */
export function mapFetchError(err: unknown): EnergyApiError {
  if (err instanceof EnergyApiError) return err;
  const e = err as { code?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  if (typeof e?.cause?.message === "string" && /redirect/i.test(e.cause.message)) return new EnergyApiError("redirect_refused");
  const code = String(e?.cause?.code ?? e?.code ?? "");
  return new EnergyApiError(TLS_CODES.test(code) ? "fleet_api_tls_error" : "fleet_api_unreachable");
}

/** HTTP status (+ body) -> code. */
export function mapHttpError(status: number, body: string, retryAfter: string | null): EnergyApiError {
  if (status === 429) {
    const n = Number(retryAfter);
    let sec = Number.isFinite(n) && n > 0 ? Math.ceil(n) : NaN;
    if (Number.isNaN(sec) && retryAfter) {
      const at = Date.parse(retryAfter);
      if (!Number.isNaN(at)) sec = Math.max(1, Math.ceil((at - Date.now()) / 1000));
    }
    return new EnergyApiError("rate_limited", status, Number.isNaN(sec) ? 60 : Math.min(MAX_RETRY_AFTER_S, sec));
  }
  if (status === 401) return new EnergyApiError(/login_required/i.test(body) ? "login_required" : "unauthorized", status);
  if (status === 403 && /scope/i.test(body)) return new EnergyApiError("missing_scope", status);
  if (status === 403) return new EnergyApiError("unauthorized", status);
  return new EnergyApiError("fleet_api_error", status);
}

/** `{ response: {...} }` -> inner object; empty / `{ response: {} }` / junk -> {}. */
export function unwrap(raw: unknown): Record<string, unknown> {
  const inner = (raw as { response?: unknown } | null | undefined)?.response;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {};
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** live_status body -> EnergyStatus. Fields absent stay undefined. */
export function parseLiveStatus(siteId: string, raw: unknown): EnergyStatus {
  const r = unwrap(raw);
  const s: EnergyStatus = { siteId };
  if (typeof r.grid_status === "string") s.gridStatus = r.grid_status;
  if (typeof r.island_status === "string") s.islandStatus = r.island_status;
  const pc = n(r.percentage_charged);
  if (pc !== undefined) s.percentCharged = pc;
  if (typeof r.storm_mode_active === "boolean") s.stormModeActive = r.storm_mode_active;
  return s;
}

/** True when the status carries at least one field the triggers read. */
export function hasEnergyData(s: EnergyStatus): boolean {
  return s.gridStatus !== undefined || s.islandStatus !== undefined || s.percentCharged !== undefined || s.stormModeActive !== undefined;
}

export interface FleetEnergyClientOptions {
  /** Region Fleet API base URL (https). */
  apiBase: string;
  /** Re-read on every request (file: refs are re-read from disk). */
  getToken: () => string | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Response body cap (default MAX_BODY_BYTES). */
  maxBodyBytes?: number;
  /** TESTS ONLY (see TestHostOverride). */
  testHosts?: TestHostOverride;
}

export class FleetEnergyClient implements EnergyStatusSource {
  private readonly fetchImpl: FetchLike;
  constructor(private readonly o: FleetEnergyClientOptions) {
    const p = baseUrlProblem(o.apiBase, FLEET_API_HOSTS, "tesla.energy_poll.api_base", o.testHosts);
    if (p) throw new Error(p);
    this.fetchImpl = o.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async get(siteId: string, what: "live_status" | "site_info"): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]+$/.test(siteId)) throw new EnergyApiError("fleet_api_error");
    const token = this.o.getToken();
    if (!token) throw new EnergyApiError("no_token");
    const url = `${this.o.apiBase.replace(/\/+$/, "")}/api/1/energy_sites/${siteId}/${what}`;
    const { status, body, retryAfter } = await guardedGet(
      this.fetchImpl, url, { authorization: `Bearer ${token}`, accept: "application/json" }, this.o.timeoutMs ?? 15_000, this.o.maxBodyBytes,
    );
    if (status < 200 || status >= 300) throw mapHttpError(status, body, retryAfter);
    if (!body.trim()) return {};
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  async liveStatus(siteId: string): Promise<EnergyStatus> {
    return parseLiveStatus(siteId, await this.get(siteId, "live_status"));
  }

  async backupReserve(siteId: string): Promise<number | undefined> {
    return n(unwrap(await this.get(siteId, "site_info")).backup_reserve_percent);
  }
}

export type EnergyTrigger = "grid_islanded" | "battery_below_reserve" | "storm_watch";

/** Grid outage: island_status off_grid* or grid_status Inactive. */
export function gridOutage(s: EnergyStatus | undefined): boolean {
  if (!s) return false;
  return (s.islandStatus ?? "").startsWith("off_grid") || s.gridStatus === "Inactive";
}

/** off_grid_unintentional (or Inactive without an island status) is the real outage; off_grid_intentional is user-chosen. */
export function unintentionalOutage(s: EnergyStatus): boolean {
  return s.islandStatus === "off_grid_unintentional" || (s.islandStatus === undefined && s.gridStatus === "Inactive");
}

export function deriveEnergyTriggers(prev: EnergyStatus | undefined, next: EnergyStatus, marginPercent = 5): EnergyTrigger[] {
  const out: EnergyTrigger[] = [];
  if (gridOutage(next) && !gridOutage(prev)) out.push("grid_islanded");
  const below = (s: EnergyStatus | undefined) =>
    s?.percentCharged !== undefined && s.backupReservePercent !== undefined && s.percentCharged < s.backupReservePercent + marginPercent;
  if (below(next) && !below(prev)) out.push("battery_below_reserve");
  if (next.stormModeActive === true && prev?.stormModeActive !== true) out.push("storm_watch");
  return out;
}
