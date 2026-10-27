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
  | "fleet_api_error";

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

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

const TLS_CODES = /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|ERR_CERT)/;

/** Network/TLS failure -> code. Never the message (it can echo a URL). */
export function mapFetchError(err: unknown): EnergyApiError {
  if (err instanceof EnergyApiError) return err;
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
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
    return new EnergyApiError("rate_limited", status, Number.isNaN(sec) ? 60 : sec);
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
}

export class FleetEnergyClient implements EnergyStatusSource {
  private readonly fetchImpl: FetchLike;
  constructor(private readonly o: FleetEnergyClientOptions) {
    if (!/^https:\/\//.test(o.apiBase)) throw new Error("tesla.energy_poll.api_base must be an https URL");
    this.fetchImpl = o.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async get(siteId: string, what: "live_status" | "site_info"): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]+$/.test(siteId)) throw new EnergyApiError("fleet_api_error");
    const token = this.o.getToken();
    if (!token) throw new EnergyApiError("no_token");
    const url = `${this.o.apiBase.replace(/\/+$/, "")}/api/1/energy_sites/${siteId}/${what}`;
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw mapFetchError(e);
    }
    const body = await res.text().catch(() => "");
    if (res.status < 200 || res.status >= 300) throw mapHttpError(res.status, body, res.headers.get("retry-after"));
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
