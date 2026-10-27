import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildService } from "../src/service.js";
import { silentLogger } from "../core/types.js";
import { BOT, FakeDiscordPort, tmp } from "./helpers.js";

/** Host-style layout: configs in their own dir (like config.host/), the repo's examples untouched. */
function hostDir(opts: { publicBaseUrl?: string; discord?: Record<string, unknown> }) {
  const dir = tmp("ubridge-svc-");
  const reg = JSON.parse(readFileSync("config/registry.example.json", "utf8"));
  writeFileSync(join(dir, "registry.json"), JSON.stringify(reg));
  chmodSync(join(dir, "registry.json"), 0o600);
  const discord = { ...JSON.parse(readFileSync("adapters/discord/config.example.json", "utf8")), ...(opts.discord ?? {}) };
  writeFileSync(join(dir, "discord.json"), JSON.stringify(discord));
  const http: Record<string, unknown> = { bind: "127.0.0.1", port: 0 };
  if (opts.publicBaseUrl) http.publicBaseUrl = opts.publicBaseUrl;
  const bridge = {
    version: 1,
    http,
    registryPath: join(dir, "registry.json"),
    dataDir: join(dir, "data"),
    hold: { maxSec: 60 },
    adapters: { discord: { enabled: true, configPath: join(dir, "discord.json") } },
  };
  writeFileSync(join(dir, "bridge.json"), JSON.stringify(bridge));
  return join(dir, "bridge.json");
}

const build = (file: string) => buildService(file, { discordPort: new FakeDiscordPort(BOT), env: {}, log: silentLogger });

test("publicBaseUrl: not needed without a live callback route; required (clear error) once one is enabled", async () => {
  const noCallback = { callbackTokenRef: undefined };
  const svc = await build(hostDir({ discord: noCallback }));
  assert.deepEqual([...svc.adapters.keys()], ["discord"]);
  await assert.rejects(build(hostDir({})), /http\.publicBaseUrl required: callback route enabled for discord/);
  const ok = await build(hostDir({ publicBaseUrl: "https://bridge.example.com" }));
  assert.deepEqual([...ok.adapters.keys()], ["discord"]);
});

test("a Discord route that references an alias in the wrong case fails at startup with the fix", async () => {
  const ex = JSON.parse(readFileSync("adapters/discord/config.example.json", "utf8"));
  const routes = ex.routes.map((r: { agent: string }, i: number) => (i === 0 ? { ...r, agent: "Example-Agent" } : r));
  await assert.rejects(
    build(hostDir({ publicBaseUrl: "https://bridge.example.com", discord: { routes } })),
    /discord\.routes\[0\]: agent "Example-Agent" must be lowercase "example-agent"/,
  );
});
