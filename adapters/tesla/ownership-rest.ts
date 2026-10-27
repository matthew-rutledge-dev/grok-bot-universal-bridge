import { EnergyApiError, FLEET_API_HOSTS, NHTSA_HOSTS, baseUrlProblem, guardedGet, mapHttpError, type FetchLike, type TestHostOverride } from "./energy.js";

/**
 * Slow REST pulls for ownership events (daily / weekly, never per telemetry record):
 *
 *   Fleet API (access token, region base URL):
 *     GET /api/1/vehicles/{vin}/service_data      service status (documented endpoint, body undocumented)
 *     GET /api/1/dx/warranty/details?vin={vin}    activeWarranty / upcomingWarranty / expiredWarranty
 *     GET /api/1/vehicles/{vin}/release_notes     after a version change only
 *     GET /api/1/vehicles/{vin}/recent_alerts     optional backup for the telemetry Alerts stream
 *   NHTSA (public, no token, no VIN sent):
 *     GET {nhtsa_base}/recalls/recallsByVehicle?make=TESLA&model=...&modelYear=...
 *
 * Fleet API has no recalls endpoint, so recalls come from NHTSA by make/model/year (the model and
 * year are read from the VIN on this host or set in config; the VIN itself never leaves). None of
 * these calls wakes a car or touches vehicle_data; the token goes to the Fleet API base only.
 * Each Fleet API answer below 500 is billed by Tesla, so the defaults are one call per car per
 * day (service) or week (warranty, recalls).
 */
export interface OwnershipRestOptions {
  apiBase: string;
  getToken: () => string | undefined;
  nhtsaBase?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Response body cap (default MAX_BODY_BYTES, 1 MiB). */
  maxBodyBytes?: number;
  /** TESTS ONLY (see TestHostOverride): extra hosts for both bases. */
  testHosts?: TestHostOverride;
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export class OwnershipRestClient {
  private readonly fetchImpl: FetchLike;
  readonly nhtsaBase: string;
  constructor(private readonly o: OwnershipRestOptions) {
    const p = baseUrlProblem(o.apiBase, FLEET_API_HOSTS, "tesla.ownership.rest.api_base", o.testHosts);
    if (p) throw new Error(p);
    this.nhtsaBase = (o.nhtsaBase ?? "https://api.nhtsa.gov").replace(/\/+$/, "");
    const q = baseUrlProblem(this.nhtsaBase, NHTSA_HOSTS, "tesla.ownership.rest.nhtsa_base", o.testHosts);
    if (q) throw new Error(q);
    this.fetchImpl = o.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async get(url: string, token: string | undefined): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const { status, body, retryAfter } = await guardedGet(this.fetchImpl, url, headers, this.o.timeoutMs ?? 15_000, this.o.maxBodyBytes);
    if (status < 200 || status >= 300) throw mapHttpError(status, body, retryAfter);
    if (!body.trim()) return {};
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  private fleet(path: string): Promise<unknown> {
    const token = this.o.getToken();
    if (!token) return Promise.reject(new EnergyApiError("no_token"));
    return this.get(`${this.o.apiBase.replace(/\/+$/, "")}${path}`, token);
  }

  private vin(vin: string): string {
    if (!VIN_RE.test(vin)) throw new EnergyApiError("fleet_api_error");
    return vin;
  }

  serviceData(vin: string): Promise<unknown> {
    return this.fleet(`/api/1/vehicles/${this.vin(vin)}/service_data`);
  }

  warranty(vin: string): Promise<unknown> {
    return this.fleet(`/api/1/dx/warranty/details?vin=${this.vin(vin)}`);
  }

  releaseNotes(vin: string): Promise<unknown> {
    return this.fleet(`/api/1/vehicles/${this.vin(vin)}/release_notes`);
  }

  recentAlerts(vin: string): Promise<unknown> {
    return this.fleet(`/api/1/vehicles/${this.vin(vin)}/recent_alerts`);
  }

  /** NHTSA recalls by make/model/year. No token and no VIN go to NHTSA. */
  recalls(model: string, modelYear: number): Promise<unknown> {
    if (!/^[A-Za-z0-9 -]{1,40}$/.test(model) || !Number.isInteger(modelYear) || modelYear < 2008 || modelYear > 2100) {
      return Promise.reject(new EnergyApiError("fleet_api_error"));
    }
    const q = new URLSearchParams({ make: "TESLA", model: model.toUpperCase(), modelYear: String(modelYear) });
    return this.get(`${this.nhtsaBase}/recalls/recallsByVehicle?${q}`, undefined);
  }
}
