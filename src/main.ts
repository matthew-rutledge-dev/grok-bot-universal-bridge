import { buildService } from "./service.js";

/**
 * Entry point.
 *   BRIDGE_CONFIG   path to the bridge config (default ./config/bridge.json)
 *   --check         validate config, registry and adapter configs; print readiness (no secrets); exit
 */
async function main(): Promise<void> {
  const file = process.env.BRIDGE_CONFIG?.trim() || "./config/bridge.json";
  const svc = await buildService(file);
  if (process.argv.includes("--check")) {
    const agents = svc.registry.aliases().map((a) => svc.registry.describe(a));
    console.log(JSON.stringify({ ok: true, adapters: [...svc.adapters.keys()], agents, wake: svc.wake.enabled ? "on" : "off" }, null, 2));
    return;
  }
  await svc.start();
  const shutdown = async (sig: string) => {
    console.log(`[bridge] ${sig}: stopping (held events stay in the hold file)`);
    await svc.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`[bridge] fatal: ${(err as Error).message}`);
  process.exit(1);
});
