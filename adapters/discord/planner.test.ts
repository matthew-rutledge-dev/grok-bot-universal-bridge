import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DiscordAdapter, PLANNER_DONE_EMOJI, validateDiscordConfig, type DiscordAdapterConfig, type PlannerStarted } from "./index.js";
import { invokePlanner, PLANNER_START_FAILED_TEXT, plannerImageFields, plannerUserSignal, PlannerStatusBook, withPlannerQuery, workingProgressText } from "./planner.js";
import { BOT, FakeDiscordPort, GUILD, USER, discordMessage, mockPlanner, mockRoutine, startBridge, until } from "../../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as DiscordAdapterConfig;
const PCH = "200000000000000001"; // planner channel in the example config
const MSG = "500000000000000001";
const auth = { authorization: "Bearer cb-discord" };

async function setup(answer?: Parameters<typeof mockPlanner>[0]["answer"], envOver: Record<string, string> = {}) {
  const routine = await mockRoutine({ key: "routine-key" });
  const planner = await mockPlanner({ token: "planner-token", answer });
  const port = new FakeDiscordPort(BOT);
  const adapter = new DiscordAdapter(example, port, { pulseMs: 30 });
  const env = { DISCORD_BOT_TOKEN: "aaa.bbb.ccc", DISCORD_CALLBACK_TOKEN: "cb-discord", DISCORD_PLANNER_URL: `${planner.url}?token=leak&messageId=PLACEHOLDER`, DISCORD_PLANNER_TOKEN: "planner-token", ...envOver };
  const b = await startBridge({ routineUrl: routine.url, adapters: [adapter], env });
  const send = async (over = {}) => (await adapter.onMessage(discordMessage({ id: MSG, channelId: PCH, content: `<@${BOT}> make it blue`, ...over }))) as PlannerStarted;
  return { routine, planner, port, adapter, b, send, close: async () => (await b.close(), await routine.close(), await planner.close()) };
}

test("planner helpers keep the existing contract", () => {
  assert.equal(workingProgressText(0), "Working on it. (0s)");
  assert.equal(workingProgressText(12_400), "Working on it. (12s)");
  assert.equal(plannerUserSignal({ ok: false, status: 0, detail: "planner_not_configured" }), "start_failed");
  for (const s of [401, 403, 404]) assert.equal(plannerUserSignal({ ok: false, status: s }), "start_failed");
  assert.equal(plannerUserSignal({ ok: false, status: 0, detail: "planner_transport" }), "transport");
  assert.equal(plannerUserSignal({ ok: true, status: 202 }), "accepted");
  assert.equal(plannerUserSignal({ ok: false, status: 500 }), "inconclusive");
  assert.deepEqual(plannerImageFields([{ url: "https://cdn.example.com/a.png" }, { url: "https://cdn.example.com/b.png" }, { url: "https://cdn.example.com/c.png" }]), {
    imagePath: "https://cdn.example.com/a.png",
    referenceImagePath: "https://cdn.example.com/b.png",
    imagePaths: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"],
  });
  assert.deepEqual(plannerImageFields([]), { imagePath: "" });
  const u = new URL(withPlannerQuery("http://127.0.0.1:1/plan?token=x&messageId=placeholder&statusMessageId=old", "42", "https://bridge.example.com/discord/callback"));
  assert.equal(u.searchParams.get("messageId"), "42");
  assert.equal(u.searchParams.get("callbackUrl"), "https://bridge.example.com/discord/callback");
  assert.equal(u.searchParams.has("token"), false);
  assert.equal(u.searchParams.has("statusMessageId"), false);
  const book = new PlannerStatusBook(2);
  let stopped = 0;
  book.remember("a", "c", "1", () => stopped++);
  book.remember("b", "c", "2");
  book.remember("c", "c", "3");
  assert.equal(book.size(), 2);
  assert.equal(stopped, 1, "evicted entry's pulse is stopped");
});

test("config: a planner route needs planner refs; unknown handlers are refused", () => {
  const { planner: _p, ...noPlanner } = example;
  assert.match(validateDiscordConfig(noPlanner).join(), /planner.urlRef and tokenRef required/);
  const bad = { ...example, routes: [{ ...example.routes[0], handler: "shell" }] };
  assert.match(validateDiscordConfig(bad).join(), /handler must be "local-planner"/);
});

test("planner hop: ONE working message, real message id + callback URL, pulse edits, ✅, callback edits it; no agent wake", async () => {
  const s = await setup();
  try {
    const att = [{ url: "https://cdn.example.com/attachments/1/2/base.png", filename: "base.png", contentType: "image/png", size: 10 }];
    const r = await s.send({ attachments: att });
    assert.equal(r.planner, true);
    assert.equal(await r.done, "accepted");
    assert.equal(s.port.sent.length, 1, "exactly one message");
    const working = s.port.sent[0];
    assert.deepEqual([working.content, working.replyTo, working.channelId], ["Working on it. (0s)", MSG, PCH]);
    const hit = s.planner.hits[0];
    assert.equal(hit.headers.authorization, "Bearer planner-token");
    assert.equal(hit.url.searchParams.get("messageId"), MSG, "real message id, placeholder replaced");
    assert.equal(hit.url.searchParams.get("callbackUrl"), "https://bridge.example.com/discord/callback");
    assert.equal(hit.url.searchParams.get("statusMessageId"), working.id);
    assert.equal(hit.url.searchParams.has("token"), false, "never a token on the query string");
    assert.deepEqual(
      { p: hit.body.userPrompt, i: hit.body.imagePath, m: hit.body.messageId, c: hit.body.channelId, s: hit.body.statusMessageId, slug: hit.body.slug, d: hit.body.dryRun },
      { p: "make it blue", i: att[0].url, m: MSG, c: PCH, s: working.id, slug: "example-media", d: false },
    );
    assert.deepEqual(s.port.reactions, [{ channelId: PCH, messageId: MSG, emoji: PLANNER_DONE_EMOJI }]);
    await until(() => s.port.edits.length >= 2, 3000);
    assert.ok(s.port.edits.every((e) => e.messageId === working.id && /^Working on it\. \(\d+s\)$/.test(e.content)));
    // The planner's callback (success) edits the same message; pulse stops; no new message.
    const cb = await s.b.call("POST", "/discord/callback", { channelId: PCH, content: "Done: blue.", replyToMessageId: MSG, attachments: [{ filename: "out.png", data: "iVBORw0KGgo=" }], threadContent: "step 1\nstep 2" }, auth);
    assert.equal(cb.status, 200, JSON.stringify(cb.body));
    assert.equal(cb.body.edited, true);
    assert.equal(s.port.sent.length, 1);
    const last = s.port.edits[s.port.edits.length - 1];
    assert.deepEqual([last.messageId, last.content, last.files?.[0].filename], [working.id, "Done: blue.", "out.png"]);
    assert.deepEqual(s.port.threads, [{ channelId: PCH, messageId: working.id, name: "Planner log", parts: ["step 1\nstep 2"] }]);
    const n = s.port.edits.length;
    await new Promise((res) => setTimeout(res, 120));
    assert.equal(s.port.edits.length, n, "pulse stopped after the callback");
    assert.equal(s.adapter.planner.size(), 0);
    assert.equal(s.routine.hits.length, 0, "planner routes never wake the agent");
    const pl = s.b.audit.lines.find((l) => l.action === "planner")!;
    assert.deepEqual([pl.outcome, pl.reason, pl.status], ["ok", "accepted", 202]);
    // Same message again (gateway redelivery): ignored.
    await (await s.send()).done;
    assert.equal(s.planner.hits.length, 1);
  } finally {
    await s.close();
  }
});

test("planner failure callback edits the working message with the failure text (no new message)", async () => {
  const s = await setup();
  try {
    await (await s.send()).done;
    const cb = await s.b.call("POST", "/discord/callback", { channelId: PCH, content: "❌ The render failed (exit 3).", replyToMessageId: MSG }, auth);
    assert.equal(cb.body.edited, true);
    assert.equal(s.port.sent.length, 1);
    assert.equal(s.port.edits.at(-1)!.content, "❌ The render failed (exit 3).");
  } finally {
    await s.close();
  }
});

test("start failed (401 / not configured): working message becomes \"Couldn't start that.\"", async () => {
  const s = await setup(undefined, { DISCORD_PLANNER_TOKEN: "wrong-token" });
  try {
    assert.equal(await (await s.send()).done, "start_failed");
    assert.equal(s.port.edits.at(-1)!.content, PLANNER_START_FAILED_TEXT);
    assert.equal(s.port.reactions.length, 0);
    assert.equal(s.adapter.planner.size(), 0);
  } finally {
    await s.close();
  }
  const r = await invokePlanner(undefined, "t", { userPrompt: "x", imagePath: "", channelId: "1", slug: "s", messageId: "1", callbackUrl: "https://bridge.example.com/discord/callback", dryRun: false });
  assert.equal(plannerUserSignal(r), "start_failed");
});

test("listener timeout / dropped connection is NOT a red X: working message stays, the late callback still edits it", async () => {
  const s = await setup(() => "drop");
  try {
    assert.equal(await (await s.send()).done, "transport");
    assert.ok(s.port.edits.every((e) => e.content.startsWith("Working on it.")), "no failure text");
    assert.ok(![...s.port.sent, ...s.port.edits].some((m) => m.content.includes("❌") || m.content === PLANNER_START_FAILED_TEXT));
    assert.equal(s.port.reactions.length, 0);
    const cb = await s.b.call("POST", "/discord/callback", { channelId: PCH, content: "Finished anyway.", replyToMessageId: MSG }, auth);
    assert.equal(cb.body.edited, true);
    assert.equal(s.port.edits.at(-1)!.content, "Finished anyway.");
    assert.equal(s.b.audit.lines.find((l) => l.action === "planner")!.reason, "transport");
  } finally {
    await s.close();
  }
});

test("planner route is still deny-by-default: unlisted user and missing mention get nothing", async () => {
  const s = await setup();
  try {
    const a = await s.adapter.onMessage(discordMessage({ id: "500000000000000002", channelId: PCH, authorId: "888888888888888888" }));
    const b = await s.adapter.onMessage(discordMessage({ id: "500000000000000003", channelId: PCH, mentionsBot: false, content: "hi" }));
    assert.equal((a as { accepted?: boolean }).accepted, false);
    assert.equal((b as { accepted?: boolean }).accepted, false);
    assert.equal(s.planner.hits.length, 0);
    assert.equal(s.port.sent.length, 0);
    void GUILD;
    void USER;
  } finally {
    await s.close();
  }
});

test("deleted working message: the callback falls back to a new reply", async () => {
  const s = await setup();
  try {
    await (await s.send()).done;
    s.port.failEdits.add(s.port.sent[0].id);
    const cb = await s.b.call("POST", "/discord/callback", { channelId: PCH, content: "result", replyToMessageId: MSG }, auth);
    assert.equal(cb.status, 200);
    assert.equal(cb.body.edited, false);
    assert.deepEqual([s.port.sent[1].content, s.port.sent[1].replyTo], ["result", MSG]);
  } finally {
    await s.close();
  }
});
