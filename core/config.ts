import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isSecretRef } from "./secrets.js";
import { DEFAULT_HOLD_MAX_SEC } from "./hold.js";

/**
 * Bridge config (config/bridge.json on the host; config/bridge.example.json in git).
 * Holds no secrets: only env:/file: references and paths.
 */
export interface AdapterEntry {
  enabled: boolean;
  /** Path to the adapter's own config (adapters/<name>/config.example.json shows the shape). */
  configPath: string;
}

export interface BridgeConfig {
  version: 1;
  http: {
    bind: string;
    port: number;
    publicBaseUrl: string;
    /** Inside a container only: allow 0.0.0.0 when the host publishes the port on 127.0.0.1. */
    allowNonLoopbackBind?: boolean;
  };
  /** Real registry: host-only, mode 600, mounted read-only. */
  registryPath: string;
  dataDir: string;
  hold: { maxSec: number; /** Optional retry backoff in ms (default 5000,10000,20000,30000). */ backoffMs?: number[] };
  wake?: { urlRef?: string; keyRef?: string; header?: string; timeoutMs?: number };
  audit?: { path?: string };
  callbackRateLimitPerMin?: number;
  adapters: Record<string, AdapterEntry>;
}

export interface LoadedConfig {
  config: BridgeConfig;
  /** Directory the config file is in; relative paths resolve against it. */
  baseDir: string;
  path(p: string): string;
}

export function validateBridgeConfig(raw: unknown): string[] {
  const p: string[] = [];
  if (!raw || typeof raw !== "object") return ["config is not an object"];
  const c = raw as Partial<BridgeConfig>;
  if (c.version !== 1) p.push("version must be 1");
  if (!c.http || typeof c.http.port !== "number") p.push("http.port required");
  if (c.http && typeof c.http.bind === "string" && !["127.0.0.1", "::1", "localhost"].includes(c.http.bind) && c.http.allowNonLoopbackBind !== true) {
    p.push("http.bind must be loopback (put the tunnel in front); inside a container set allowNonLoopbackBind and publish on 127.0.0.1 only");
  }
  if (!c.http?.publicBaseUrl) p.push("http.publicBaseUrl required");
  if (!c.registryPath) p.push("registryPath required");
  if (!c.adapters || typeof c.adapters !== "object") p.push("adapters required");
  for (const [k, v] of Object.entries(c.wake ?? {})) {
    if (k.endsWith("Ref") && v !== undefined && !isSecretRef(v)) p.push(`wake.${k} must be env:NAME or file:/path`);
    if (/^(url|key|token)$/i.test(k)) p.push(`wake.${k}: literal values refused; use ${k}Ref`);
  }
  return p;
}

export function loadBridgeConfig(file: string): LoadedConfig {
  const raw = JSON.parse(readFileSync(file, "utf8")) as BridgeConfig;
  const problems = validateBridgeConfig(raw);
  if (problems.length) throw new Error(`bridge config invalid: ${problems.join("; ")}`);
  raw.hold = { maxSec: raw.hold?.maxSec ?? DEFAULT_HOLD_MAX_SEC, backoffMs: raw.hold?.backoffMs };
  // Relative paths resolve against the working directory (the image uses /app).
  const baseDir = process.cwd();
  return { config: raw, baseDir, path: (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p)) };
}
