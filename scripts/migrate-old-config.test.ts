import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain .mjs script, no types
import { convert, parseEnv } from "./migrate-old-config.mjs";
import { DiscordAdapter, validateDiscordConfig, type DiscordAdapterConfig } from "../adapters/discord/index.js";
import { Registry } from "../core/registry.js";
import { BOT, FakeDiscordPort, discordMessage, mockPlanner, mockRoutine, startBridge, tmp, until } from "../test/helpers.js";

// The older bridge's host files, in the live shape, with placeholder values only.
const G = "111111111111111111";
const [U1, U2, U3] = ["600000000000000001", "600000000000000002", "600000000000000003"];
const PAIR_ME = "800000000000000001";
const CH = { chat: "200000000000000011", media: "200000000000000012", llm: "200000000000000013", off: "200000000000000014" };
const OUTBOUND = ["200000000000000021", "200000000000000022", "200000000000000023", "200000000000000024", "200000000000000025"];
const ID = { chat: "a1111111-1111-4111-8111-111111111111", d1: "b1111111-1111-4111-8111-111111111111", d2: "b2222222-2222-4222-8222-222222222222", d3: "b3333333-3333-4333-8333-333333333333", def: "c1111111-1111-4111-8111-111111111111" };
const SECRET = "sentinel-secret-value";
const PH = "example-media-handler";
const ROW_URL = "https://row.example.com/hook/sentinel-url-secret";

const security = {
  version: 1,
  description: "placeholder",
  guilds: { [G]: { enabled: true, label: "example-guild", requireMention: false, ownerId: U1, allowFrom: [U1, U2, U3], allowRoles: [], allowChannels: [CH.chat, CH.media, CH.llm, ...OUTBOUND] } },
  dm: { policy: "pairing", allowFrom: [U1, U2, U3], ownerId: U1, defaultAgentId: ID.def, agentsByUser: { [U1]: ID.d1, [U2]: { agentId: ID.d2, alias: "Example_person" }, [U3]: { agentId: ID.d3 } } },
  hostAdmins: { "example-host-a": [U1] },
  ignoreBots: true,
};
const channelMap = {
  version: 1,
  defaultSendPromptUrl: null,
  channels: [
    { enabled: true, channelId: CH.chat, slug: "example-chat", alias: "chat-agent", agentId: ID.chat, sendPromptUrl: ROW_URL, requireMention: false },
    { enabled: true, channelId: CH.media, slug: "example-media", alias: "media-planner", agentId: ID.chat, primary_llm: "local", wake_agent: false, local_handler: "example-media-handler", requireMention: false },
    { enabled: true, channelId: CH.llm, slug: "example-llm", alias: "", agentId: "00000000-0000-0000-0000-000000000000", primary_llm: "local", wake_agent: false, harness: "grok-build", profile: "example-profile", requireMention: false },
    { enabled: false, channelId: CH.off, slug: "example-off", alias: "off-agent", agentId: "", requireMention: true },
  ],
};
const dotenv = [
  `DISCORD_BOT_TOKEN=${SECRET}-1`,
  `GROK_BOT_GATEWAY_TOKEN=${SECRET}-2`,
  `GROK_BOT_SENDPROMPT_URL=https://gw.example.com/api/sendPrompt?k=${SECRET}-3`,
  `CALLBACK_TOKEN=${SECRET}-4`,
  `LOCAL_PLANNER_URL=https://planner.example.com/plan?k=${SECRET}-5`,
  `LOCAL_PLANNER_TOKEN=${SECRET}-6`,
  `SENDPROMPT_WAKE_URL=https://wake.example.com/${SECRET}-7`,
  `SENDPROMPT_WAKE_KEY=${SECRET}-8`,
  `XAI_API_KEY=${SECRET}-9`,
  `DISCORD_GUILD_ID=${G}`,
  `DISCORD_ALLOWFROM=${U1},${U2},${U3}`,
  "DISCORD_ALLOW_ROLES=",
  "DISCORD_ALLOW_CHANNELS=",
  `DISCORD_OWNER_ID=${U1}`,
  "DISCORD_DM_POLICY=pairing",
  "REQUIRE_MENTION_DEFAULT=true",
  "WAKE_PROMPT_FORMAT=compact",
  "CALLBACK_PATH=/callback",
  "CALLBACK_BASE_URL=http://127.0.0.1:18083",
  "HTTP_ONLY=0",
  "LOCAL_PLANNER_POWERSHELL=example.ps1",
  "SENDPROMPT_HOLD_MAX_SEC=1800",
  "# comment line",
].join("\n");

function files() {
  const dir = tmp("ubridge-migrate-");
  const p = (n: string) => join(dir, n);
  writeFileSync(p("security.json"), JSON.stringify(security));
  writeFileSync(p("channel-map.json"), JSON.stringify(channelMap));
  writeFileSync(p(".env"), dotenv);
  writeFileSync(p("seed.json"), JSON.stringify({ version: 1, users: { [U1]: { label: "Example One" } } }));
  return { dir, p };
}

test("migrate-old-config: maps every old key, prints no secret, output validates", () => {
  const { dir, p } = files();
  const script = new URL("./migrate-old-config.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const r = spawnSync(process.execPath, [script, "--security", p("security.json"), "--channel-map", p("channel-map.json"), "--env", p(".env"), "--seed", p("seed.json"), "--planner-handler", PH], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("sentinel"), "no secret value or secret URL on stdout");
  const bundle = JSON.parse(r.stdout);
  const d = bundle.discord as DiscordAdapterConfig;
  assert.deepEqual(validateDiscordConfig(d), []);
  assert.equal(d.tokenRef, "env:DISCORD_BOT_TOKEN");
  assert.equal(d.callbackTokenRef, "env:CALLBACK_TOKEN");
  assert.equal(d.voice!.grokApiKeyRef, "env:XAI_API_KEY");
  assert.deepEqual(d.legacyPaths, { callback: "/callback", voicePlay: "/voice/play", voiceStream: "/voice/stream" });
  assert.equal(d.planner!.callbackUrl, "http://127.0.0.1:18083/callback");
  assert.equal(d.wakePromptFormat, "compact");
  assert.equal(d.users!.seedPath, "/app/config/user-directory.seed.json");
  const byCh = Object.fromEntries(d.routes.map((x) => [x.match.channel, x]));
  assert.deepEqual(byCh[CH.chat].allowActors, [U1, U2, U3]);
  assert.equal(byCh[CH.chat].requireAddressed, false);
  assert.equal(byCh[CH.chat].handler, undefined);
  assert.equal(byCh[CH.chat].map, undefined, "alias chat-agent is also the registry alias");
  assert.equal(byCh[CH.media].handler, "local-planner");
  assert.deepEqual([byCh[CH.llm].handler, byCh[CH.llm].profile, byCh[CH.llm].enabled], ["grokbuild-chat", "example-profile", true]);
  assert.equal(byCh[CH.off].enabled, false);
  assert.deepEqual(d.callbackChannels, OUTBOUND);
  assert.deepEqual(d.dm, { policy: "pairing", allowUsers: [U1, U2, U3], ownerIds: [U1], defaultAgent: "dm-default", map: ID.def });
  assert.deepEqual(d.dmRoutes!.map((x) => [x.userId, x.map]), [[U1, ID.d1], [U2, "Example_person"], [U3, ID.d3]]);
  assert.equal(new Set(d.dmRoutes!.map((x) => x.agent)).size, 3, "three users, three agents");
  // Registry: new aliases are sendprompt refs (the per-row URL only by env name).
  assert.equal(bundle.registryAdditions["chat-agent"].deliver.urlRef, "env:DISCORD_SENDPROMPT_URL_EXAMPLE_CHAT");
  assert.equal(bundle.registryAdditions["chat-agent"].deliver.keyRef, "env:GROK_BOT_GATEWAY_TOKEN");
  assert.deepEqual(bundle.env.extraWritten, ["DISCORD_SENDPROMPT_URL_EXAMPLE_CHAT"]);
  assert.ok(bundle.warnings.some((w: string) => /needs --env-out|need --env-out/.test(w)));
  assert.ok(bundle.warnings.some((w: string) => /hostAdmins dropped/.test(w)));
  assert.ok(bundle.warnings.some((w: string) => /LOCAL_PLANNER_POWERSHELL dropped/.test(w)));
  assert.deepEqual(bundle.bridgePatch.hold, { maxSec: 1800 });
  assert.equal(bundle.bridgePatch.wake.urlRef, "env:SENDPROMPT_WAKE_URL");
  assert.equal(bundle.bridgePatch.adapters.discord.enabled, true);
  for (const k of ["DISCORD_BOT_TOKEN", "CALLBACK_TOKEN", "LOCAL_PLANNER_URL", "LOCAL_PLANNER_TOKEN", "GROK_BOT_GATEWAY_TOKEN", "XAI_API_KEY", "SENDPROMPT_WAKE_KEY"]) assert.ok(bundle.env.referenced.includes(k), k);
  // Registry additions are valid against the real registry loader.
  const reg = Registry.fromObject({ version: 1, agents: bundle.registryAdditions }, { GROK_BOT_SENDPROMPT_URL: "https://gw.example.com/api/sendPrompt", GROK_BOT_GATEWAY_TOKEN: "t", DISCORD_SENDPROMPT_URL_EXAMPLE_CHAT: "https://gw.example.com/x" });
  assert.equal(reg.resolve("chat-agent").problems.length, 0);

  // --out-dir and --env-out: mode 600 files; URL values only in the env file.
  const out = join(dir, "out");
  const r2 = spawnSync(process.execPath, [script, "--security", p("security.json"), "--channel-map", p("channel-map.json"), "--env", p(".env"), "--out-dir", out, "--env-out", join(dir, "extra.env"), "--planner-handler", PH], { encoding: "utf8" });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(!r2.stdout.includes("sentinel"));
  assert.equal(readFileSync(join(dir, "extra.env"), "utf8"), `DISCORD_SENDPROMPT_URL_EXAMPLE_CHAT=${ROW_URL}\n`);
  for (const f of ["discord.json", "registry.additions.json", "bridge.patch.json", "warnings.txt"]) {
    assert.ok(!readFileSync(join(out, f), "utf8").includes("sentinel"), f);
    if (process.platform !== "win32") assert.equal(statSync(join(out, f)).mode & 0o777, 0o600, f);
  }
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "extra.env")).mode & 0o777, 0o600);
});

test("migrate-old-config: fresh --out-dir with --env-out inside it (and a nested env-out parent) is created before any write", () => {
  const { dir, p } = files();
  const script = new URL("./migrate-old-config.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const out = join(dir, "fresh", "out");
  assert.ok(!existsSync(join(dir, "fresh")));
  const r = spawnSync(process.execPath, [script, "--security", p("security.json"), "--channel-map", p("channel-map.json"), "--env", p(".env"), "--out-dir", out, "--env-out", join(out, "extra.env"), "--planner-handler", PH], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.ok(!r.stdout.includes("sentinel"));
  assert.equal(readFileSync(join(out, "extra.env"), "utf8"), `DISCORD_SENDPROMPT_URL_EXAMPLE_CHAT=${ROW_URL}\n`);
  for (const f of ["discord.json", "registry.additions.json", "bridge.patch.json", "warnings.txt"]) assert.ok(existsSync(join(out, f)), f);
  // env-out in its own fresh nested directory outside out-dir.
  const envNested = join(dir, "env", "deep", "extra.env");
  const r2 = spawnSync(process.execPath, [script, "--security", p("security.json"), "--channel-map", p("channel-map.json"), "--env", p(".env"), "--out-dir", join(dir, "o2"), "--env-out", envNested, "--planner-handler", PH], { encoding: "utf8" });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(existsSync(envNested));
  if (process.platform !== "win32") assert.equal(statSync(join(out, "extra.env")).mode & 0o777, 0o600);
});

test("migrate-old-config: reuses existing registry aliases by agentId; HTTP_ONLY, legacy format, env pin, wake_agent without handler", () => {
  const env = parseEnv(dotenv + "\nHTTP_ONLY=1\nWAKE_PROMPT_FORMAT=legacy\nDISCORD_ALLOW_CHANNELS=" + CH.chat);
  const map2 = { ...channelMap, channels: [...channelMap.channels, { enabled: true, channelId: "200000000000000015", slug: "half-local", alias: "half", agentId: ID.chat, wake_agent: false }] };
  const { bundle } = convert({ security, channelMap: map2, env, registry: { agents: { "existing-chat": { agentId: ID.chat } } }, plannerHandlers: [PH] });
  const d = bundle.discord as DiscordAdapterConfig;
  assert.equal(bundle.bridgePatch.adapters.discord.enabled, false);
  assert.equal(d.wakePromptFormat, "legacy");
  const chat = d.routes.find((r) => r.match.channel === CH.chat)!;
  assert.equal(chat.agent, "existing-chat");
  assert.equal(chat.map, "chat-agent", "the old trailer map= value is kept");
  assert.equal(bundle.registryAdditions["existing-chat"], undefined);
  const half = d.routes.find((r) => r.match.channel === "200000000000000015")!;
  assert.equal(half.handler, undefined, "wake_agent=false alone still woke the agent");
  assert.ok(bundle.warnings.some((w: string) => /half-local: wake_agent=false/.test(w)));
  assert.ok(bundle.warnings.some((w: string) => /half-local: not in allowChannels/.test(w)));
  const alias = { ...channelMap, channels: [{ ...channelMap.channels[1], local_handler: "example-old-handler" }] };
  assert.equal(convert({ security, channelMap: alias, env }).bundle.discord.routes[0].handler, undefined);
  assert.ok(convert({ security, channelMap: alias, env }).bundle.warnings.some((w: string) => /--planner-handler/.test(w)));
  assert.equal(convert({ security, channelMap: alias, env, plannerHandlers: ["example-old-handler"] }).bundle.discord.routes[0].handler, "local-planner");
  const pinned = convert({ security, channelMap, env: { ...env, DISCORD_GUILD_ID: "100000000000000001" } }).bundle;
  assert.ok(pinned.discord.routes.length === 0 && pinned.warnings.some((w: string) => /pins another guild/.test(w)));
});

test("migrated config end to end: guild wake, each DM route, default agent via pairing, planner and chat hops, legacy /callback", async () => {
  const { bundle } = convert({ security, channelMap, env: parseEnv(dotenv), legacyPaths: true, plannerHandlers: [PH] });
  const routine = await mockRoutine({ key: "routine-key" });
  const planner = await mockPlanner({ token: "planner-token" });
  const port = new FakeDiscordPort(BOT);
  const adapter = new DiscordAdapter(bundle.discord, port, { pulseMs: 30 });
  const agents = Object.fromEntries(Object.entries(bundle.registryAdditions as Record<string, { agentId: string }>).map(([a, v]) => [a, v.agentId]));
  const env = { DISCORD_BOT_TOKEN: "aaa.bbb.ccc", CALLBACK_TOKEN: "cb-old", LOCAL_PLANNER_URL: planner.url, LOCAL_PLANNER_TOKEN: "planner-token" };
  const b = await startBridge({ routineUrl: routine.url, adapters: [adapter], env, agents });
  const auth = { authorization: "Bearer cb-old" };
  try {
    // Guild channel wake (no mention needed: requireMention false).
    await adapter.onMessage(discordMessage({ id: "500000000000000001", guildId: G, channelId: CH.chat, authorId: U2, content: "hello", mentionsBot: false }));
    await until(() => routine.hits.length === 1);
    assert.equal(routine.hits[0].body.agentId, ID.chat);
    assert.match(routine.hits[0].body.prompt, / map=chat-agent$/);
    // Each DM route reaches its own agent.
    for (const [i, u] of [U1, U2, U3].entries()) {
      await adapter.onMessage(discordMessage({ id: `50000000000000070${i}`, guildId: null, channelId: `90000000000000002${i}`, authorId: u, content: "dm", mentionsBot: false }));
    }
    await until(() => routine.hits.length === 4);
    assert.deepEqual(routine.hits.slice(1).map((h) => h.body.agentId), [ID.d1, ID.d2, ID.d3]);
    assert.match(routine.hits[2].body.prompt, / map=Example_person$/);
    // Pairing: the owner pairs a new user, who then reaches the default agent.
    await adapter.onMessage(discordMessage({ id: "500000000000000002", guildId: null, channelId: "900000000000000031", authorId: U1, content: `!pair ${PAIR_ME}`, mentionsBot: false }));
    await adapter.onMessage(discordMessage({ id: "500000000000000003", guildId: null, channelId: "900000000000000032", authorId: PAIR_ME, content: "hi", mentionsBot: false }));
    await until(() => routine.hits.length === 5);
    assert.equal(routine.hits[4].body.agentId, ID.def);
    // Planner and chat hops: no agent wake.
    const p1 = (await adapter.onMessage(discordMessage({ id: "500000000000000004", guildId: G, channelId: CH.media, authorId: U1, content: "draw", mentionsBot: false }))) as { done: Promise<string> };
    assert.equal(await p1.done, "accepted");
    const p2 = (await adapter.onMessage(discordMessage({ id: "500000000000000005", guildId: G, channelId: CH.llm, authorId: U1, content: "chat", mentionsBot: false }))) as { done: Promise<string> };
    assert.equal(await p2.done, "accepted");
    assert.deepEqual(planner.hits.map((h) => h.url.pathname), ["/plan", "/chat"]);
    assert.equal(planner.hits[1].body.profile, "example-profile");
    assert.equal(planner.hits[0].body.callbackUrl, "http://127.0.0.1:18083/callback");
    assert.equal(routine.hits.length, 5);
    // Callbacks on the legacy path: channel text, outbound-only channel, DM by userId.
    assert.equal((await b.call("POST", "/callback", { channelId: CH.chat, content: "reply" }, auth)).status, 200);
    assert.equal((await b.call("POST", "/callback", { channelId: OUTBOUND[0], content: "ops note" }, auth)).status, 200);
    assert.equal((await b.call("POST", "/callback", { userId: U3, content: "dm reply" }, auth)).status, 200);
    assert.equal((await b.call("POST", "/callback", { userId: "800000000000000002", content: "x" }, auth)).status, 403);
  } finally {
    await b.close();
    await routine.close();
    await planner.close();
  }
});

test("migrate-old-config: --gateway-url-ref / --gateway-token-ref override the registry-addition refs; defaults unchanged; literals refused", () => {
  const { dir, p } = files();
  const script = new URL("./migrate-old-config.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const base = ["--security", p("security.json"), "--channel-map", p("channel-map.json"), "--env", p(".env"), "--planner-handler", PH];
  const run = (extra: string[]) => spawnSync(process.execPath, [script, ...base, ...extra], { encoding: "utf8" });
  const refsOf = (stdout: string) => JSON.parse(stdout);
  const def = run([]);
  assert.equal(def.status, 0, def.stderr);
  const defAdds = Object.values(refsOf(def.stdout).registryAdditions) as any[];
  assert.ok(defAdds.length > 0);
  for (const a of defAdds) assert.equal(a.deliver.keyRef, "env:GROK_BOT_GATEWAY_TOKEN");
  assert.ok(defAdds.some((a) => a.deliver.urlRef === "env:GROK_BOT_SENDPROMPT_URL"));
  const over = run(["--gateway-url-ref", "env:EXAMPLE_GATEWAY_URL", "--gateway-token-ref", "file:/run/secrets/example-gateway-token"]);
  assert.equal(over.status, 0, over.stderr);
  const b = refsOf(over.stdout);
  const adds = Object.values(b.registryAdditions) as any[];
  for (const a of adds) {
    assert.equal(a.deliver.keyRef, "file:/run/secrets/example-gateway-token");
    assert.notEqual(a.deliver.urlRef, "env:GROK_BOT_SENDPROMPT_URL");
  }
  assert.ok(adds.some((a) => a.deliver.urlRef === "env:EXAMPLE_GATEWAY_URL"));
  assert.ok(b.env.referenced.includes("EXAMPLE_GATEWAY_URL"));
  assert.ok(!b.env.referenced.includes("GROK_BOT_GATEWAY_TOKEN"));
  for (const bad of [["--gateway-url-ref", "https://example.invalid/x"], ["--gateway-token-ref", "sentinel-literal"], ["--gateway-url-ref"]]) {
    const r = run(bad);
    assert.equal(r.status, 2, bad.join(" "));
    assert.ok(!r.stderr.includes("sentinel-literal") && !r.stderr.includes("example.invalid"));
    assert.ok(!/\n\s+at /.test(r.stderr), "no stack trace");
  }
  assert.throws(() => convert({ security: {}, channelMap: {}, gatewayTokenRef: "literal" }), /env:NAME or file/);
  void dir;
});
