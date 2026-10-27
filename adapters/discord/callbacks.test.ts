import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiscordAdapter, validateDiscordConfig, type DiscordAdapterConfig, type PlannerStarted } from "./index.js";
import { chatUrlFromPlanner, PLANNER_START_FAILED_TEXT, PlannerStatusBook } from "./planner.js";
import { parseMultipart, multipartBoundary, MultipartError } from "../../core/multipart.js";
import { BOT, CHANNEL, FakeDiscordPort, GUILD, PNG_1X1, USER, discordMessage, mockPlanner, mockRoutine, startBridge, tmp, until } from "../../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as DiscordAdapterConfig;
const auth = { authorization: "Bearer cb-discord" };
const PCH = "200000000000000001";
const CHAT = "200000000000000002";
const MSG = "500000000000000001";
const OTHER_USER = "300000000000000009";

async function setup(cfgOver: Partial<DiscordAdapterConfig> = {}, opts: { holdFile?: string; answer?: Parameters<typeof mockPlanner>[0]["answer"] } = {}) {
  const routine = await mockRoutine({ key: "routine-key" });
  const planner = await mockPlanner({ token: "planner-token", answer: opts.answer });
  const port = new FakeDiscordPort(BOT);
  const adapter = new DiscordAdapter({ ...example, ...cfgOver }, port, { pulseMs: 30 });
  const env = { DISCORD_BOT_TOKEN: "aaa.bbb.ccc", DISCORD_CALLBACK_TOKEN: "cb-discord", DISCORD_PLANNER_URL: planner.url, DISCORD_PLANNER_TOKEN: "planner-token" };
  const b = await startBridge({ routineUrl: routine.url, adapters: [adapter], env, holdFile: opts.holdFile });
  return { routine, planner, port, adapter, b, close: async () => (await b.close(), await routine.close(), await planner.close()) };
}

/** Build a multipart body by hand (no client library). */
function multipart(parts: Array<{ name: string; value?: string; filename?: string; type?: string; data?: Buffer }>, boundary = "example-boundary-1234") {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp = `form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ""}`;
    chunks.push(Buffer.from(`--${boundary}\r\ncontent-disposition: ${disp}\r\n${p.type ? `content-type: ${p.type}\r\n` : ""}\r\n`));
    chunks.push(p.data ?? Buffer.from(p.value ?? ""));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

async function post(base: string, m: { body: Buffer; type: string }, headers: Record<string, string> = auth) {
  const res = await fetch(`${base}/discord/callback`, { method: "POST", headers: { "content-type": m.type, ...headers }, body: m.body });
  return { status: res.status, body: (await res.json()) as any };
}

test("multipart parser: fields, files, quoted/encoded names, limits, malformed bodies", () => {
  assert.equal(multipartBoundary("multipart/form-data; boundary=abc"), "abc");
  assert.equal(multipartBoundary('multipart/form-data; boundary="a b"'), "a b");
  assert.equal(multipartBoundary("application/json"), undefined);
  const m = multipart([{ name: "content", value: "hi" }, { name: "files[0]", filename: "a.png", type: "image/png", data: PNG_1X1 }]);
  const parts = parseMultipart(m.body, "example-boundary-1234");
  assert.deepEqual(parts.map((p) => [p.name, p.filename, p.contentType, p.data.length]), [["content", undefined, undefined, 2], ["files[0]", "a.png", "image/png", PNG_1X1.length]]);
  const enc = Buffer.from(`--b\r\ncontent-disposition: form-data; name="f"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt\r\n\r\nx\r\n--b--`);
  assert.equal(parseMultipart(enc, "b")[0].filename, "résumé.txt");
  const code = (fn: () => unknown) => {
    try {
      fn();
      return "ok";
    } catch (e) {
      return e instanceof MultipartError ? e.code : "other";
    }
  };
  assert.equal(code(() => parseMultipart(Buffer.from("garbage"), "b")), "multipart_invalid");
  assert.equal(code(() => parseMultipart(Buffer.from("--b\r\ncontent-disposition: form-data; name=\"x\"\r\n\r\nno end"), "b")), "multipart_invalid");
  const many = multipart(Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, value: "v" })));
  assert.equal(code(() => parseMultipart(many.body, "example-boundary-1234")), "multipart_too_many_parts");
  const big = multipart([{ name: "content", value: "x".repeat(70 * 1024) }]);
  assert.equal(code(() => parseMultipart(big.body, "example-boundary-1234")), "multipart_field_too_large");
});

test("multipart callbacks: payload_json or text fields + file parts, same caps and MIME rules, parsed only after auth", async () => {
  const s = await setup();
  try {
    // Unauthenticated (even malformed) multipart never reaches the parser.
    assert.equal((await post(s.b.base, { body: Buffer.from("garbage"), type: "multipart/form-data; boundary=x" }, {})).status, 401);
    assert.equal((await post(s.b.base, { body: Buffer.from("garbage"), type: "multipart/form-data; boundary=x" })).body.error, "multipart_invalid");

    const ok = await post(s.b.base, multipart([{ name: "payload_json", value: JSON.stringify({ channelId: CHANNEL, content: "here you go" }) }, { name: "files[0]", filename: "out.png", type: "image/png", data: PNG_1X1 }]));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.attachments, 1);
    const sent = s.port.sent.at(-1)!;
    assert.deepEqual([sent.channelId, sent.content, sent.files?.[0].filename, sent.files?.[0].contentType], [CHANNEL, "here you go", "out.png", "image/png"]);
    assert.deepEqual(sent.files?.[0].buffer, PNG_1X1);

    const fields = await post(s.b.base, multipart([{ name: "channelId", value: CHANNEL }, { name: "content", value: "plain fields" }, { name: "file", filename: "notes.txt", data: Buffer.from("hello") }]));
    assert.equal(fields.status, 200);
    assert.equal(s.port.sent.at(-1)!.files?.[0].contentType, "text/plain", "MIME guessed from the name");

    const exe = await post(s.b.base, multipart([{ name: "channelId", value: CHANNEL }, { name: "f", filename: "setup.exe", type: "image/png", data: PNG_1X1 }]));
    assert.deepEqual([exe.status, exe.body.error], [415, "unsupported_media_type"]);
    const mime = await post(s.b.base, multipart([{ name: "channelId", value: CHANNEL }, { name: "f", filename: "blob", type: "application/x-msdownload", data: PNG_1X1 }]));
    assert.deepEqual([mime.status, mime.body.error], [415, "unsupported_media_type"]);
    const eleven = await post(s.b.base, multipart([{ name: "channelId", value: CHANNEL }, ...Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, filename: `${i}.png`, type: "image/png", data: PNG_1X1 }))]));
    assert.deepEqual([eleven.status, eleven.body.error], [400, "too_many_attachments"]);
    const mixed = await post(
      s.b.base,
      multipart([
        { name: "payload_json", value: JSON.stringify({ channelId: CHANNEL, attachments: Array.from({ length: 5 }, (_, i) => ({ filename: `j${i}.png`, data: PNG_1X1.toString("base64") })) }) },
        ...Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, filename: `${i}.png`, type: "image/png", data: PNG_1X1 })),
      ]),
    );
    assert.equal(mixed.body.error, "too_many_attachments", "uploads and JSON attachments share the 10-file cap");
    const nine = Buffer.alloc(9 * 1024 * 1024, 0x61);
    const tooBig = await post(s.b.base, multipart([{ name: "channelId", value: CHANNEL }, { name: "f", filename: "big.txt", type: "text/plain", data: nine }]));
    assert.deepEqual([tooBig.status, tooBig.body.error], [400, "attachment_too_large"]);
    const seven = Buffer.alloc(7 * 1024 * 1024, 0x61);
    const total = await post(s.b.base, multipart([{ name: "channelId", value: CHANNEL }, ...[0, 1, 2, 3].map((i) => ({ name: `f${i}`, filename: `${i}.txt`, type: "text/plain", data: seven }))]));
    assert.deepEqual([total.status, total.body.error], [400, "attachment_too_large"], "25 MiB total");
    const notAllowed = await post(s.b.base, multipart([{ name: "channelId", value: "100000000000000000" }, { name: "content", value: "x" }]));
    assert.equal(notAllowed.status, 403);
    const lines = JSON.stringify(s.b.audit.lines);
    assert.equal(lines.includes("out.png") || lines.includes("here you go"), false, "no names or text in the audit");
    assert.ok(s.b.audit.lines.some((l) => l.action === "attachment" && l.reason === "outbound" && l.kinds === "image" && l.count === 1));
  } finally {
    await s.close();
  }
});

test("DM-by-userId callbacks: deny by default, allowlisted users only", async () => {
  const s0 = await setup({ dmCallbacks: undefined });
  try {
    const r = await s0.b.call("POST", "/discord/callback", { userId: USER, content: "hi" }, auth);
    assert.deepEqual([r.status, r.body.error], [403, "user_not_allowlisted"], "no dmCallbacks = deny");
    assert.equal(s0.port.dms.length, 0);
  } finally {
    await s0.close();
  }
  const s = await setup({ dmCallbacks: { allowUsers: [USER] } });
  try {
    const denied = await s.b.call("POST", "/discord/callback", { userId: OTHER_USER, content: "hi" }, auth);
    assert.deepEqual([denied.status, denied.body.error], [403, "user_not_allowlisted"]);
    assert.ok(s.b.audit.lines.some((l) => l.reason === "dm_user_not_allowlisted" && l.actor === "…0009"));
    const ok = await s.b.call("POST", "/discord/callback", { userId: USER, content: "your render is done" }, auth);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(s.port.dms, [USER]);
    assert.deepEqual([s.port.sent.at(-1)!.channelId, s.port.sent.at(-1)!.content], [`6${USER.slice(1)}`, "your render is done"]);
    assert.equal((await s.b.call("POST", "/discord/callback", { userId: USER, channelId: CHANNEL, content: "x" }, auth)).body.error, "channelId_or_userId_not_both");
    assert.equal((await s.b.call("POST", "/discord/callback", { userId: "abc", content: "x" }, auth)).body.error, "userId invalid");
    s.port.failDm.add(USER);
    assert.deepEqual((await s.b.call("POST", "/discord/callback", { userId: USER, content: "x" }, auth)).body.error, "dm_open_failed");
    // Multipart works with userId too.
    s.port.failDm.clear();
    const mp = await post(s.b.base, multipart([{ name: "userId", value: USER }, { name: "f", filename: "a.png", type: "image/png", data: PNG_1X1 }]));
    assert.equal(mp.status, 200);
  } finally {
    await s.close();
  }
  assert.match(validateDiscordConfig({ ...example, dmCallbacks: { allowUsers: ["*"] } }).join(), /no wildcards/);
  assert.match(validateDiscordConfig({ ...example, dmCallbacks: {} as never }).join(), /allowUsers must be an array/);
});

const chatRoutes = example.routes.map((r) => (r.handler === "grokbuild-chat" ? { ...r, enabled: true } : r));

test("Grok Build chat hop: /chat + profile + attachment refs; a fast reply never posts a working message", async () => {
  assert.equal(chatUrlFromPlanner("http://127.0.0.1:1/plan?x=1"), "http://127.0.0.1:1/chat?x=1");
  assert.equal(chatUrlFromPlanner("http://127.0.0.1:1/other"), undefined);
  assert.match(validateDiscordConfig({ ...example, routes: [{ ...chatRoutes.at(-1)!, profile: "bad profile!" }] }).join(), /short profile name/);
  assert.match(validateDiscordConfig({ ...example, routes: [{ ...chatRoutes.at(-1)!, profile: undefined }] }).join(), /short profile name/);
  const s = await setup({ routes: chatRoutes, planner: { ...example.planner!, chatWorkingDelayMs: 300 } });
  try {
    const att = [{ url: "https://cdn.example.com/attachments/1/2/notes.txt", filename: "notes.txt", contentType: "text/plain", size: 5 }];
    const r = (await s.adapter.onMessage(discordMessage({ id: MSG, channelId: CHAT, content: `<@${BOT}> summarise this`, attachments: att }))) as PlannerStarted;
    assert.equal(await r.done, "accepted");
    const hit = s.planner.hits[0];
    assert.equal(hit.url.pathname, "/chat");
    assert.deepEqual([hit.body.profile, hit.body.userPrompt, hit.body.attachments, hit.body.imagePath], ["example-profile", "summarise this", att, ""]);
    assert.equal(hit.url.searchParams.get("messageId"), MSG);
    assert.equal(s.port.sent.length, 0, "no working message before the delay");
    const cb = await s.b.call("POST", "/discord/callback", { channelId: CHAT, content: "Summary: ...", replyToMessageId: MSG }, auth);
    assert.equal(cb.body.edited, false);
    await new Promise((res) => setTimeout(res, 400));
    assert.deepEqual(s.port.sent.map((m) => [m.content, m.replyTo]), [["Summary: ...", MSG]], "the answer is a new reply; the working message was cancelled");
    assert.equal(s.routine.hits.length, 0, "chat hops never wake the agent");
    assert.ok(s.b.audit.lines.some((l) => l.action === "planner" && l.type === "chat_hop" && l.reason === "accepted"));
  } finally {
    await s.close();
  }
});

test("Grok Build chat hop: a slow reply posts the working message after the delay and then edits it; start failure says so", async () => {
  const s = await setup({ routes: chatRoutes, planner: { ...example.planner!, chatWorkingDelayMs: 40 } });
  try {
    await ((await s.adapter.onMessage(discordMessage({ id: MSG, channelId: CHAT, content: `<@${BOT}> hello` }))) as PlannerStarted).done;
    await until(() => s.port.sent.length === 1, 3000);
    assert.match(s.port.sent[0].content, /^Working on it\. \(\d+s\)$/);
    const cb = await s.b.call("POST", "/discord/callback", { channelId: CHAT, content: "Hi!", replyToMessageId: MSG }, auth);
    assert.equal(cb.body.edited, true);
    assert.equal(s.port.edits.at(-1)!.content, "Hi!");
  } finally {
    await s.close();
  }
  const f = await setup({ routes: chatRoutes, planner: { ...example.planner!, chatWorkingDelayMs: 5000 } }, { answer: () => ({ status: 404, body: { ok: false } }) });
  try {
    assert.equal(await ((await f.adapter.onMessage(discordMessage({ id: MSG, channelId: CHAT, content: `<@${BOT}> hello` }))) as PlannerStarted).done, "start_failed");
    assert.deepEqual(f.port.sent.map((m) => m.content), [PLANNER_START_FAILED_TEXT]);
  } finally {
    await f.close();
  }
});

test("planner working-message state survives a restart (mode 600, TTL on load)", async () => {
  const dir = tmp("ubridge-planner-");
  const holdFile = join(dir, "hold.json");
  const s1 = await setup({}, { holdFile });
  let workingId = "";
  try {
    await ((await s1.adapter.onMessage(discordMessage({ id: MSG, channelId: PCH, content: `<@${BOT}> make it blue` }))) as PlannerStarted).done;
    workingId = s1.port.sent[0].id;
  } finally {
    await s1.close();
  }
  const file = join(dir, "discord-planner-status.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.entries.map((e: { origin: string; statusMessageId: string }) => [e.origin, e.statusMessageId]), [[MSG, workingId]], "stop() keeps the persisted entry");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const s2 = await setup({}, { holdFile });
  try {
    const cb = await s2.b.call("POST", "/discord/callback", { channelId: PCH, content: "Done after restart.", replyToMessageId: MSG }, auth);
    assert.equal(cb.body.edited, true, JSON.stringify(cb.body));
    assert.deepEqual([s2.port.edits.at(-1)!.messageId, s2.port.edits.at(-1)!.content], [workingId, "Done after restart."]);
    assert.equal(s2.adapter.planner.size(), 0, "forgotten once the reply edited it");
  } finally {
    await s2.close();
  }
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).entries, []);
  // TTL and junk filtering on load.
  writeFileSync(file, JSON.stringify({ version: 1, entries: [{ origin: MSG, channelId: PCH, statusMessageId: "900000000000000001", at: Date.now() - 25 * 3600_000 }, { origin: "x", channelId: PCH, statusMessageId: "1", at: Date.now() }, { origin: "500000000000000002", channelId: PCH, statusMessageId: "900000000000000002", at: Date.now() }] }));
  const book = new PlannerStatusBook();
  assert.equal(book.load(file), 1);
  assert.equal(book.lookup("500000000000000002")?.statusMessageId, "900000000000000002");
  void GUILD;
});
