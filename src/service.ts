import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "../adapters/index.js";
import { DiscordAdapter, type DiscordAdapterConfig } from "../adapters/discord/index.js";
import type { DiscordPort } from "../adapters/discord/port.js";
import { JsonlAudit } from "../core/audit.js";
import { Bridge, type SourceAdapter } from "../core/bridge.js";
import { loadBridgeConfig } from "../core/config.js";
import type { FetchLike } from "../core/deliver.js";
import { holdRetryDelayMs } from "../core/hold.js";
import { HttpServer } from "../core/http.js";
import { Registry } from "../core/registry.js";
import { filePermissionWarning, resolveSecret, type SecretEnv } from "../core/secrets.js";
import { HttpWakeHook } from "../core/wake.js";
import { consoleLogger, type Logger } from "../core/types.js";

/** Everything main.ts wires up, as a function so tests and the smoke run use the same wiring. */
export interface ServiceOverrides {
  /** Replace the discord.js gateway (tests / local smoke only). */
  discordPort?: DiscordPort;
  env?: SecretEnv;
  fetchImpl?: FetchLike;
  log?: Logger;
}

export interface Service {
  bridge: Bridge;
  http: HttpServer;
  adapters: Map<string, SourceAdapter>;
  registry: Registry;
  wake: HttpWakeHook;
  config: ReturnType<typeof loadBridgeConfig>["config"];
  start(): Promise<number>;
  stop(): Promise<void>;
}

export async function buildService(configFile: string, o: ServiceOverrides = {}): Promise<Service> {
  const log = o.log ?? consoleLogger;
  const env = o.env ?? process.env;
  const { config, path } = loadBridgeConfig(configFile);
  const registryPath = path(config.registryPath);
  const warn = filePermissionWarning(registryPath);
  if (warn) log.warn(`[registry] ${warn}`);
  const registry = Registry.fromFile(registryPath, env);
  const http = new HttpServer(log);
  const wake = new HttpWakeHook({
    url: resolveSecret(config.wake?.urlRef, env),
    key: resolveSecret(config.wake?.keyRef, env),
    header: config.wake?.header,
    timeoutMs: config.wake?.timeoutMs,
    fetchImpl: o.fetchImpl,
    log,
  });
  const dataDir = path(config.dataDir || "./data");
  const backoff = Array.isArray(config.hold.backoffMs) && config.hold.backoffMs.length ? config.hold.backoffMs : undefined;
  const bridge = new Bridge({
    registry,
    audit: new JsonlAudit(path(config.audit?.path || join(dataDir, "audit.jsonl"))),
    http,
    holdFile: join(dataDir, "hold.json"),
    holdMaxSec: config.hold.maxSec,
    publicBaseUrl: config.http.publicBaseUrl,
    callbackRateLimitPerMin: config.callbackRateLimitPerMin,
    wake,
    log,
    env,
    fetchImpl: o.fetchImpl,
    delayMs: backoff ? (f) => (f <= 0 ? 0 : backoff[Math.min(f, backoff.length) - 1]) : holdRetryDelayMs,
  });
  const adapters = new Map<string, SourceAdapter>();
  for (const [name, entry] of Object.entries(config.adapters)) {
    if (!entry.enabled) continue;
    const factory = ADAPTERS[name];
    if (!factory) throw new Error(`unknown adapter ${name} (no folder under adapters/)`);
    const adapterCfg = JSON.parse(readFileSync(path(entry.configPath), "utf8"));
    const adapter =
      name === "discord" && o.discordPort ? new DiscordAdapter(adapterCfg as DiscordAdapterConfig, o.discordPort) : await factory(adapterCfg);
    await bridge.add(adapter);
    adapters.set(name, adapter);
  }
  return {
    bridge,
    http,
    adapters,
    registry,
    wake,
    config,
    async start() {
      const port = await http.listen(config.http.bind, config.http.port);
      await bridge.start();
      log.info(
        `[bridge] listening ${config.http.bind}:${port} adapters=${[...adapters.keys()].join(",") || "none"} holdMaxSec=${config.hold.maxSec} wake=${wake.enabled ? "on" : "off"}`,
      );
      return port;
    },
    async stop() {
      await bridge.stop();
      await http.close();
    },
  };
}
