import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiscordAdapter, NOT_PAIRED_TEXT, dmRoutesFor, validateDiscordConfig, type DiscordAdapterConfig } from "./index.js";
import { legacyPathProblem } from "../../core/bridge.js";
import { BOT, CHANNEL, FakeDiscordPort, GUILD, USER, discordMessage, mockPlanner, mockRoutine, startBridge, tmp, until } from "../../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as DiscordAdapterConfig;
const auth = { authorization: "Bearer cb-discord" };
// Placeholder ids only.
const U1 = "600000000000000001";
const U2 = "600000000000000002";
const U3 = "600000000000000003";
const DEFAULT_USER = "600000000000000004";
const OWNER = "700000000000000001";
const STRANGER = "800000000000000001";
const DMCH = (n: number) => `90000000000000001${n}`;
const AGENTS = { "agent-one": "a1111111-1111-4111-8111-111111111111", "agent-two": "a2222222-2222-4222-8222-222222222222", "agent-three": "a3333333-3333-4333-8333-333333333333", "agent-default": "a4444444-4444-4444-8444-444444444444" };
const guildRoutes = example.routes;

async function setup(over: Partial<DiscordAdapterConfig> = {}, o: { holdFile?: string; script?: number[] } = {}) {
  const routine = await mockRoutine({ key: "routine-key", script: o.script });
  const planner = await mockPlanner({ token: "planner-token" });
  const port = new FakeDiscordPort(BOT);
  const adapter = new DiscordAdapter({ ...example, dm: undefined, dmRoutes: undefined, legacyPaths: undefined, routes: guildRoutes, ...over }, port, { pulseMs: 30, typingMs: 20 });
  const env = { DISCORD_BOT_TOKEN: "aaa.bbb.ccc", DISCORD_CALLBACK_TOKEN: "cb-discord", DISCORD_PLANNER_URL: planner.url, DISCORD_PLANNER_TOKEN: "planner-token" };
  const b = await startBridge({ routineUrl: routine.url, adapters: [adapter], env, agents: AGENTS, holdFile: o.holdFile });
  return { routine, planner, port, adapter, b, close: async () => (await b.close(), await routine.close(), await planner.close()) };
}

const dmMsg = (user: string, n: number, text = "hi") =>
  discordMessage({ id: `50000000000000010${n}`, guildId: null, channelId: DMCH(n), authorId: user, content: text, mentionsBot: false, channelName: undefined });

const dmCfg: Partial<DiscordAdapterConfig> = {
  dm: { policy: "pairing", allowUsers: [DEFAULT_USER], defaultAgent: "agent-default", ownerIds: [OWNER] },
  dmRoutes: [
    { userId: U1, agent: "agent-one" },
    { userId: U2, agent: "agent-two", map: "Agent_Two" },
    { userId: U3, agent: "agent-three" },
  ],
};

test("dmRoutes: each allowlisted DM user reaches their own agent; others fall back to the default agent or are refused", async () => {
  const s = await setup(dmCfg);
  try {
    for (const [i, u] of [U1, U2, U3, DEFAULT_USER].entries()) {
      const r = (await s.adapter.onMessage(dmMsg(u, i))) as { accepted?: boolean };
      assert.equal(r.accepted, true, u);
    }
    await until(() => s.routine.hits.length === 4);
    const byAgent = s.routine.hits.map((h) => h.body.agentId);
    assert.deepEqual(byAgent, [AGENTS["agent-one"], AGENTS["agent-two"], AGENTS["agent-three"], AGENTS["agent-default"]]);
    assert.match(s.routine.hits[1].body.prompt, / map=Agent_Two$/);
    assert.match(s.routine.hits[0].body.prompt, /^Discord DM from example-user: hi\n\u27C2 d:dm:/);
    // Stranger: refused, told how to pair (policy pairing), nothing delivered.
    const r = (await s.adapter.onMessage(dmMsg(STRANGER, 5))) as { accepted?: boolean };
    assert.equal(r.accepted, false);
    assert.equal(s.port.sent.at(-1)!.content, NOT_PAIRED_TEXT);
    assert.equal(s.routine.hits.length, 4);
    assert.ok(s.b.audit.lines.some((l) => l.reason === "dm_not_paired"));
  } finally {
    await s.close();
  }
});

test("pairing: only an owner's !pair grants DM access (default agent) and DM callbacks; memory only", async () => {
  const s = await setup(dmCfg);
  try {
    // A non-owner can't pair anyone (the text is just a refused DM).
    await s.adapter.onMessage(dmMsg(STRANGER, 1, `!pair ${STRANGER}`));
    await s.adapter.onMessage(dmMsg(STRANGER, 2));
    assert.equal(s.routine.hits.length, 0);
    let cb = await s.b.call("POST", "/discord/callback", { userId: STRANGER, content: "x" }, auth);
    assert.equal(cb.status, 403);
    // The owner pairs in a guild channel the bot can see (no route needed).
    await s.adapter.onMessage(discordMessage({ id: "500000000000000001", authorId: OWNER, content: `!pair <@${STRANGER}>`, mentionsBot: false }));
    assert.equal(s.port.sent.at(-1)!.content, `paired ${STRANGER}`);
    const r = (await s.adapter.onMessage(dmMsg(STRANGER, 3))) as { accepted?: boolean };
    assert.equal(r.accepted, true);
    await until(() => s.routine.hits.length === 1);
    assert.equal(s.routine.hits[0].body.agentId, AGENTS["agent-default"]);
    cb = await s.b.call("POST", "/discord/callback", { userId: STRANGER, content: "x" }, auth);
    assert.equal(cb.status, 200);
    // A fresh adapter (restart) forgets the pairing, like the older bridge.
    const again = new DiscordAdapter({ ...example, routes: guildRoutes, ...dmCfg }, new FakeDiscordPort(BOT));
    assert.equal(again.dmCallbackAllowed(STRANGER), false);
  } finally {
    await s.close();
  }
});

test("DM callbacks by userId use the same allowlist (dmRoutes, allowUsers, owners); policy allowlist/disabled; validation", async () => {
  const s = await setup({ ...dmCfg, dm: { ...dmCfg.dm, policy: "allowlist" } });
  try {
    for (const u of [U1, U2, U3, DEFAULT_USER, OWNER]) {
      const r = await s.b.call("POST", "/discord/callback", { userId: u, content: "hello" }, auth);
      assert.equal(r.status, 200, u);
    }
    const no = await s.b.call("POST", "/discord/callback", { userId: STRANGER, content: "hello" }, auth);
    assert.deepEqual([no.status, no.body.error], [403, "user_not_allowlisted"]);
    // allowlist policy: a stranger's DM is refused without the pairing hint.
    const sent = s.port.sent.length;
    await s.adapter.onMessage(dmMsg(STRANGER, 1));
    assert.equal(s.port.sent.length, sent);
  } finally {
    await s.close();
  }
  const off = new DiscordAdapter({ ...example, routes: guildRoutes, ...dmCfg, dm: { ...dmCfg.dm, policy: "disabled" } }, new FakeDiscordPort(BOT));
  assert.equal(off.dmCallbackAllowed(U1), false);
  assert.ok(dmRoutesFor({ ...example, ...dmCfg, dm: { policy: "disabled" } }).every((r) => !r.enabled));
  const v = (o: Partial<DiscordAdapterConfig>) => validateDiscordConfig({ ...example, ...o }).join("; ");
  assert.match(v({ ...dmCfg, routes: [...guildRoutes, { enabled: false, match: { dm: "true" }, allowActors: [], agent: "example-agent" }] }), /use dm\/dmRoutes or a \{ dm: "true" \} route, not both/);
  assert.match(v({ routes: guildRoutes, dmRoutes: [{ userId: "*", agent: "a" }] }), /userId must be a user id/);
  assert.match(v({ routes: guildRoutes, dmRoutes: [{ userId: U1, agent: "a" }, { userId: U1, agent: "b" }] }), /listed twice/);
  assert.match(v({ routes: guildRoutes, dm: { policy: "open" as never } }), /policy must be/);
  assert.match(v({ routes: guildRoutes, dm: { allowUsers: ["*"] } }), /allowUsers must be user ids/);
  assert.equal(v({ routes: guildRoutes, ...dmCfg }), "");
});

test("policy disabled ignores every DM", async () => {
  const s = await setup({ ...dmCfg, dm: { ...dmCfg.dm, policy: "disabled" } });
  try {
    assert.equal(await s.adapter.onMessage(dmMsg(U1, 1)), undefined);
    assert.ok(s.b.audit.lines.some((l) => l.reason === "dm_disabled"));
    assert.equal(s.routine.hits.length, 0);
  } finally {
    await s.close();
  }
});

test("delivery reactions: ✅ accepted, ❌ failed, ⚠️ answered but not accepted", async () => {
  const s = await setup({}, { script: [200, 401] });
  try {
    await s.adapter.onMessage(discordMessage({ id: "500000000000000002" }));
    await until(() => s.port.reactions.length === 1);
    assert.deepEqual(s.port.reactions[0], { channelId: CHANNEL, messageId: "500000000000000002", emoji: "✅" });
    await s.adapter.onMessage(discordMessage({ id: "500000000000000003" }));
    await until(() => s.port.reactions.length === 2);
    assert.equal(s.port.reactions[1].emoji, "❌");
    await s.adapter.ui.delivered({ ref: { channelId: CHANNEL, messageId: "500000000000000004" } } as never, { body: { accepted: false } });
    assert.equal(s.port.reactions[2].emoji, "⚠️");
  } finally {
    await s.close();
  }
});

test("healthz: discordReady + adapter health; callback 503 discord_not_ready; old response shape and error codes", async () => {
  const s = await setup();
  try {
    let h = await s.b.call("GET", "/healthz");
    assert.equal(h.body.discordReady, true);
    assert.deepEqual(Object.keys(h.body.health.discord).sort(), ["callbackPath", "hasTokenConfigured", "ready", "routes"]);
    assert.equal(h.body.health.discord.hasTokenConfigured, true);
    const ok = await s.b.call("POST", "/discord/callback", { channelId: CHANNEL, content: "x".repeat(4500) }, auth);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.chunks, 3);
    assert.equal(ok.body.messageId, ok.body.messageIds[0]);
    const big = await s.b.call("POST", "/discord/callback", { channelId: CHANNEL, content: "x".repeat(32_001) }, auth);
    assert.deepEqual([big.status, big.body.error], [413, "content_too_long"]);
    const noCh = await s.b.call("POST", "/discord/callback", { content: "x" }, auth);
    assert.equal(noCh.body.error, "channelId_required");
    s.port.ready = false;
    h = await s.b.call("GET", "/healthz");
    assert.equal(h.body.discordReady, false);
    const nr = await s.b.call("POST", "/discord/callback", { channelId: CHANNEL, content: "x" }, auth);
    assert.deepEqual([nr.status, nr.body.error], [503, "discord_not_ready"]);
  } finally {
    await s.close();
  }
});

test("legacy root paths (/callback, /voice/play, /voice/stream) share auth; callbackChannels allow outbound-only channels", async () => {
  const OUT = "200000000000000099";
  const s = await setup({ legacyPaths: { callback: "/callback", voicePlay: "/voice/play", voiceStream: "/voice/stream" }, callbackChannels: [OUT], voice: { ...example.voice!, enabled: true } });
  try {
    assert.equal((await s.b.call("POST", "/callback", { channelId: CHANNEL, content: "x" })).status, 401);
    assert.equal((await s.b.call("POST", "/callback?token=cb-discord", { channelId: CHANNEL, content: "x" })).status, 400);
    assert.equal((await s.b.call("POST", "/callback", { channelId: CHANNEL, content: "legacy" }, auth)).status, 200);
    assert.equal((await s.b.call("POST", "/callback", { channelId: OUT, content: "outbound only" }, auth)).status, 200);
    assert.equal((await s.b.call("POST", "/callback", { channelId: "200000000000000098", content: "x" }, auth)).status, 403);
    assert.equal((await s.b.call("POST", "/voice/play", { channelId: "777777777777777777" }, auth)).status, 200);
    assert.equal((await s.b.call("POST", "/voice/stream", { op: "status" }, auth)).status, 200);
    assert.equal((await s.b.call("POST", "/voice/play", { channelId: "777777777777777777" })).status, 401);
    const h = await s.b.call("GET", "/healthz");
    assert.equal(h.body.health.discord.legacyCallbackPath, "/callback");
  } finally {
    await s.close();
  }
  assert.match(String(legacyPathProblem("/discord/x", ["discord"])), /collides/);
  assert.match(String(legacyPathProblem("/healthz", [])), /reserved/);
  assert.match(String(legacyPathProblem("callback", [])), /must look like/);
  assert.match(validateDiscordConfig({ ...example, legacyPaths: { callback: "/grokbuild/callback" } }).join(";"), /collides/);
  assert.match(validateDiscordConfig({ ...example, callbackChannels: ["*"] }).join(";"), /callbackChannels must be channel ids/);
});

test("legacy wake format, metadata fields, user directory seed labels (mode 600), interaction users learned", async () => {
  const dir = tmp("ubridge-users-");
  const seed = join(dir, "seed.json");
  writeFileSync(seed, JSON.stringify({ version: 1, users: { [USER]: { label: "Example Person" } } }));
  const s = await setup({ wakePromptFormat: "legacy", users: { seedPath: seed } }, { holdFile: join(dir, "hold.json") });
  try {
    await s.adapter.onMessage(discordMessage({ id: "500000000000000005", authorUsername: "example-handle", authorDisplayName: "Shown Name" }));
    await until(() => s.routine.hits.length === 1);
    const body = s.routine.hits[0].body;
    const [first, json, text] = body.prompt.split("\n");
    assert.equal(first, "d:example-chat:500000000000000005");
    assert.deepEqual(JSON.parse(json), { id: first, g: GUILD, u: USER, map: "example-agent", un: "example-handle", dn: "Shown Name", lb: "Example Person", c: CHANNEL });
    assert.equal(text, "hello there");
    assert.deepEqual(
      { ...body.metadata, eventId: undefined, source: undefined },
      { hop: first, discordMessageId: "500000000000000005", discordChannelId: CHANNEL, discordUserId: USER, discordGuildId: GUILD, discordUser: { un: "example-handle", dn: "Shown Name", lb: "Example Person" }, callbackBaseUrl: "https://bridge.example.com", callbackPath: "/discord/callback", eventId: undefined, source: undefined },
    );
    s.port.userHandler?.({ id: "600000000000000009", username: "button-user", bot: false });
    await s.adapter.stop();
    const file = join(dir, "discord-user-directory.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.users[USER].label, "Example Person");
    assert.equal(saved.users["600000000000000009"].username, "button-user");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!readFileSync(file, "utf8").includes("hello there"), "no message text");
  } finally {
    await s.close();
  }
  // Compact (default) uses the seed label too.
  const s2 = await setup({ users: { seedPath: seed } });
  try {
    await s2.adapter.onMessage(discordMessage({ id: "500000000000000006" }));
    await until(() => s2.routine.hits.length === 1);
    assert.match(s2.routine.hits[0].body.prompt, /^Discord #example-chat from Example Person: hello there\n/);
  } finally {
    await s2.close();
  }
});

test("chat hop on a channel route: typing at once and until the reply; working message only when slow", async () => {
  const routes = guildRoutes.map((r) => (r.handler === "grokbuild-chat" ? { ...r, enabled: true } : r));
  const s = await setup({ routes, planner: { ...example.planner!, chatWorkingDelayMs: 60_000 } });
  try {
    const CHAT = "200000000000000002";
    const started = (await s.adapter.onMessage(discordMessage({ id: "500000000000000007", channelId: CHAT }))) as { done: Promise<string> };
    assert.equal(await started.done, "accepted");
    assert.equal(s.planner.hits[0].url.pathname, "/chat");
    assert.equal(s.planner.hits[0].body.profile, "example-profile");
    await until(() => s.port.typings.length >= 2);
    const r = await s.b.call("POST", "/discord/callback", { channelId: CHAT, content: "answer", replyToMessageId: "500000000000000007" }, auth);
    assert.equal(r.status, 200);
    const n = s.port.typings.length;
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(s.port.typings.length, n, "typing stops after the reply");
    assert.ok(!s.port.sent.some((m) => m.content.startsWith("Working on it.")), "fast reply: no working message");
  } finally {
    await s.close();
  }
});

test("voice: a Discord drop is audited stream_dropped through the adapter, and play works again", async () => {
  const s = await setup({ voice: { ...example.voice!, enabled: true } });
  try {
    const VCH = "777777777777777777";
    assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "open", channelId: VCH }, auth)).status, 200);
    assert.equal((await s.b.call("POST", "/discord/voice/play", { channelId: VCH }, auth)).status, 409);
    s.port.voice.drop();
    assert.ok(s.b.audit.lines.some((l) => l.action === "voice" && l.reason === "stream_dropped" && l.adapter === "discord"));
    assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "status" }, auth)).body.open, false);
    assert.equal((await s.b.call("POST", "/discord/voice/play", { channelId: VCH }, auth)).status, 200);
  } finally {
    await s.close();
  }
});
