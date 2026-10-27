/**
 * End-to-end smoke run on loopback only. No real Discord, no real Grok Bot.
 *
 *  A) Starts the real service (src/main.ts) as a child process with the
 *     grokbuild adapter, a mock webhook routine and a mock wake routine.
 *     Shows: auth + allowlist, hold while the routine "sleeps" (HTTP 530 /
 *     1033), wake POST that FAILS while the hold continues, restart with a
 *     held event (reloaded from the hold file), delivery, agent callback,
 *     client reading the reply, and the audit file.
 *  B) Builds the same service in-process with the Discord gateway replaced by
 *     an in-memory port (no Discord token), and shows a mention being held,
 *     ONE status message edited on delivery, and a callback reply posted.
 *  C) Discord media, voice and the local-planner hop, in-process with a mock
 *     Discord CDN and a mock planner listener on loopback: inbound attachment
 *     refs, callback files (base64 + CDN url), allowlist refusals, the planner
 *     "Working on it." message edited by the planner's own callback, a
 *     dropped planner connection that shows no red X, and voice play/stream
 *     through an in-memory voice port.
 *
 * Prints evidence as Markdown. Exit code 0 only if every check passed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildService } from "../src/service.js";
import { BOT, CHANNEL, GUILD, USER, FakeDiscordPort, PNG_1X1, discordMessage, mockCdn, mockPlanner, mockRoutine, tmp, until } from "../test/helpers.js";
import { silentLogger } from "../core/types.js";

const out: string[] = [];
let failures = 0;
const say = (l = "") => out.push(l);
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  say(`- [${ok ? "x" : " "}] ${label}${detail ? ` (${detail})` : ""}`);
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}

function writeConfigs(dir: string, routineUrl: string, wakeUrl: string, port: number, adapters: Record<string, boolean>, discordOver: Record<string, unknown> = {}) {
  const registry = {
    version: 1,
    agents: {
      "example-agent": {
        agentId: "11111111-1111-4111-8111-111111111111",
        deliver: { kind: "webhook", urlRef: "env:EXAMPLE_AGENT_WEBHOOK_URL", keyRef: "env:EXAMPLE_AGENT_WEBHOOK_KEY", timeoutMs: 3000 },
      },
    },
  };
  const regPath = join(dir, "registry.json");
  writeFileSync(regPath, JSON.stringify(registry, null, 2));
  chmodSync(regPath, 0o600);
  const discord = JSON.parse(readFileSync("adapters/discord/config.example.json", "utf8"));
  const grokbuild = JSON.parse(readFileSync("adapters/grokbuild/config.example.json", "utf8"));
  writeFileSync(join(dir, "discord.json"), JSON.stringify({ ...discord, ...discordOver }));
  writeFileSync(join(dir, "grokbuild.json"), JSON.stringify(grokbuild));
  const bridge = {
    version: 1,
    http: { bind: "127.0.0.1", port, publicBaseUrl: "https://bridge.example.com" },
    registryPath: regPath,
    dataDir: join(dir, "data"),
    hold: { maxSec: 120, backoffMs: [200, 300, 400, 500] },
    wake: { urlRef: "env:BRIDGE_WAKE_URL", keyRef: "env:BRIDGE_WAKE_KEY" },
    callbackRateLimitPerMin: 90,
    adapters: {
      discord: { enabled: Boolean(adapters.discord), configPath: join(dir, "discord.json") },
      grokbuild: { enabled: Boolean(adapters.grokbuild), configPath: join(dir, "grokbuild.json") },
      tesla: { enabled: false, configPath: "adapters/tesla/config.example.json" },
    },
  };
  const file = join(dir, "bridge.json");
  writeFileSync(file, JSON.stringify(bridge, null, 2));
  return {
    file,
    env: {
      EXAMPLE_AGENT_WEBHOOK_URL: routineUrl,
      EXAMPLE_AGENT_WEBHOOK_KEY: "routine-key",
      BRIDGE_WAKE_URL: wakeUrl,
      BRIDGE_WAKE_KEY: "wake-key",
      DISCORD_BOT_TOKEN: "aaa.bbb.ccc",
      DISCORD_CALLBACK_TOKEN: "cb-discord",
      GROKBUILD_CLIENT_TOKEN: "client-token",
      GROKBUILD_CALLBACK_TOKEN: "cb-grokbuild",
      GROKBUILD_READ_ONLY: "",
      DISCORD_PLANNER_URL: "",
      DISCORD_PLANNER_TOKEN: "",
    },
  };
}

function startProcess(configFile: string, env: Record<string, string>, logs: string[]): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    env: { ...process.env, ...env, BRIDGE_CONFIG: configFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => logs.push(...String(d).trim().split("\n")));
  child.stderr!.on("data", (d) => logs.push(...String(d).trim().split("\n")));
  return child;
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((r) => child.once("exit", r));
  child.kill(process.platform === "win32" ? undefined : "SIGTERM");
  await done;
}

async function waitHealthy(base: string) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return (await r.json()) as { ok: boolean; adapters: string[]; held: number };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("bridge did not become healthy");
}

async function api(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

async function partA() {
  say("### A. Real service process: grokbuild adapter, hold/retry, wake failure, restart, callback, audit");
  say();
  const routine = await mockRoutine({ key: "routine-key" });
  const wake = await mockRoutine({ script: [500, 500, 500] });
  const dir = tmp("ubridge-smoke-a-");
  const port = await freePort();
  const { file, env } = writeConfigs(dir, routine.url, wake.url, port, { grokbuild: true });
  const base = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const client = { authorization: "Bearer client-token" };
  let child = startProcess(file, env, logs);
  try {
    const h = await waitHealthy(base);
    check("service process starts on loopback and answers /healthz", h.ok && h.adapters.join() === "grokbuild", `adapters=${h.adapters.join()}`);

    const mal = await fetch(`${base}/grokbuild/requests/%E0`, { headers: client });
    const alive = await waitHealthy(base);
    check("malformed path encoding answers 400 and the process stays up", mal.status === 400 && alive.ok && child.exitCode === null, `HTTP ${mal.status}`);
    const bad = await api(base, "POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "x" }, { authorization: "Bearer wrong" });
    check("wrong client token is refused", bad.status === 401, `HTTP ${bad.status}`);
    const unrouted = await api(base, "POST", "/grokbuild/prompt", { bot: "not-routed", prompt: "x" }, client);
    check("unrouted bot is denied by default", unrouted.status === 403 && unrouted.body.error === "no_route", `HTTP ${unrouted.status} ${unrouted.body.error}`);

    const r1 = await api(base, "POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "smoke: awake routine", requestId: "smoke-awake-1" }, client);
    check("prompt delivered at once while the routine is awake", r1.status === 202 && r1.body.state === "delivered", `state=${r1.body.state}`);
    const hit = routine.hits[0];
    check(
      "routine got Bearer + X-Automation-Key and the prompt payload",
      hit?.headers.authorization === "Bearer routine-key" && hit?.headers["x-automation-key"] === "routine-key" && hit?.body.kind === "prompt",
      `kind=${hit?.body.kind} from=${hit?.body.from}`,
    );

    // The routine "sleeps": every POST answers 530 / 1033 until we wake it.
    routine.script.push(...Array(200).fill(530));
    const r2 = await api(base, "POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "smoke: sleeping routine", requestId: "smoke-sleep-1" }, client);
    check("prompt is HELD while the routine answers 530/1033", r2.body.state === "held", `state=${r2.body.state}`);
    await until(() => wake.hits.length >= 1, 5000);
    check("wake POST fired once, content-free", wake.hits.length === 1 && Object.keys(wake.hits[0].body).sort().join() === "firstHeldAt,heldCount,reason", `body keys=${Object.keys(wake.hits[0]?.body ?? {}).sort().join(",")}, reason=${wake.hits[0]?.body.reason}`);
    await until(() => routine.hits.length >= 4, 5000);
    const holdFile = join(dir, "data", "hold.json");
    const persisted = existsSync(holdFile) ? JSON.parse(readFileSync(holdFile, "utf8")).items.length : 0;
    check("wake failed (HTTP 500) and the event is still held and retried", (await waitHealthy(base)).held === 1 && routine.hits.length >= 4, `retries so far=${routine.hits.length - 1}`);
    check("held event mirrored to the hold file", persisted === 1, `items=${persisted}`);

    // Restart while held: the event must survive.
    await stopProcess(child);
    check(
      "service stopped while an event was held",
      child.exitCode !== null || child.signalCode !== null,
      process.platform === "win32" ? "hard kill on Windows: no graceful shutdown" : "SIGTERM",
    );
    const before = routine.hits.length;
    child = startProcess(file, env, logs);
    const h2 = await waitHealthy(base);
    check("after restart the held event is reloaded from the hold file", h2.held === 1, `held=${h2.held}`);
    await until(() => routine.hits.length > before, 5000);
    routine.script.length = 0; // the computer wakes up
    await until(() => logs.some((l) => l.includes("[hold] delivered after")), 10_000);
    const left = JSON.parse(readFileSync(holdFile, "utf8")).items.length;
    check("delivered after the routine woke up; hold file emptied", left === 0, `hold items=${left}, total routine POSTs=${routine.hits.length}`);
    const late = await api(base, "POST", "/grokbuild/callback", { requestId: "smoke-sleep-1", content: "Late reply after restart." }, { authorization: "Bearer cb-grokbuild" });
    const lateRead = await api(base, "GET", "/grokbuild/requests/smoke-sleep-1", undefined, client);
    check("request record survived the restart; the agent's late reply lands and the client reads it", late.status === 200 && lateRead.body.replies?.[0]?.content === "Late reply after restart.", `callback HTTP ${late.status}, replies=${lateRead.body.replies?.length}`);
    const r3 = await api(base, "POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "smoke: reply path", requestId: "smoke-reply-1" }, client);
    const noTok = await api(base, "POST", "/grokbuild/callback", { requestId: "smoke-reply-1", content: "nope" });
    const qTok = await api(base, "POST", "/grokbuild/callback?token=cb-grokbuild", { requestId: "smoke-reply-1", content: "nope" });
    const okCb = await api(base, "POST", "/grokbuild/callback", { requestId: "smoke-reply-1", content: "Smoke reply from the agent." }, { authorization: "Bearer cb-grokbuild" });
    check("callback: no token 401, ?token= 400, Bearer 200", r3.status === 202 && noTok.status === 401 && qTok.status === 400 && okCb.status === 200, `${noTok.status}/${qTok.status}/${okCb.status}`);
    const read = await api(base, "GET", "/grokbuild/requests/smoke-reply-1", undefined, client);
    check("client reads the agent's reply", read.body.replies?.[0]?.content === "Smoke reply from the agent.", `state=${read.body.state} replies=${read.body.replies?.length}`);

    const audit = readFileSync(join(dir, "data", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const text = JSON.stringify(audit);
    check("audit file has no prompt text, tokens or full request ids", !/smoke: |routine-key|client-token|cb-grokbuild|smoke-sleep-1/.test(text), `${audit.length} lines`);
    say();
    say("Audit lines (data/audit.jsonl, as written):");
    say("```");
    for (const l of audit) say(JSON.stringify(l));
    say("```");
    say();
    say("Service log lines (hold / wake / restart):");
    say("```");
    for (const l of logs.filter((x) => /\[(hold|wake|bridge|grokbuild)\]/.test(x))) say(l);
    say("```");
  } finally {
    await stopProcess(child);
    await routine.close();
    await wake.close();
  }
}

async function partB() {
  say();
  say("### B. Same wiring in-process with the Discord gateway replaced by an in-memory port");
  say();
  const routine = await mockRoutine({ key: "routine-key", script: [530, 530] });
  const dir = tmp("ubridge-smoke-b-");
  const port = await freePort();
  const { file, env } = writeConfigs(dir, routine.url, "", port, { discord: true, grokbuild: true });
  const fake = new FakeDiscordPort(BOT);
  const svc = await buildService(file, { discordPort: fake, env: { ...env, BRIDGE_WAKE_URL: "" }, log: silentLogger });
  const base = `http://127.0.0.1:${await svc.start()}`;
  try {
    const discord = svc.adapters.get("discord") as unknown as { onMessage: (m: ReturnType<typeof discordMessage>) => Promise<{ accepted: boolean } | undefined> };
    check("discord adapter connected through the port with the bot token", fake.connectedWith === "token");
    const denied = await discord.onMessage(discordMessage({ id: "700000000000000001", mentionsBot: false, content: "no mention" }));
    check("message without a mention is denied (requireAddressed)", denied?.accepted === false);
    const r = await discord.onMessage(discordMessage({ id: "700000000000000002" }));
    check("allowlisted mention accepted", r?.accepted === true);
    await until(() => fake.edits.length >= 1, 5000);
    check("ONE status message posted while held, then edited on delivery", fake.sent.length === 1 && fake.edits.length === 1, `posted="${fake.sent[0]?.content}" edited="${fake.edits[0]?.content}"`);
    const p: string = routine.hits.at(-1)?.body.prompt ?? "";
    check("routine got the compact Discord wake prompt", p.startsWith("Discord #example-chat from example-user: hello there\n\u27C2 d:example-chat:700000000000000002"), p.split("\n")[1]);
    const cb = await api(base, "POST", "/discord/callback", { channelId: CHANNEL, content: "Agent reply via callback", replyToMessageId: "700000000000000002" }, { authorization: "Bearer cb-discord" });
    check("callback reply posted to the allowlisted channel", cb.status === 200 && fake.sent.at(-1)?.content === "Agent reply via callback", `HTTP ${cb.status}`);
    const other = await api(base, "POST", "/discord/callback", { channelId: "999999999999999999", content: "x" }, { authorization: "Bearer cb-discord" });
    check("callback to a channel outside the routes is refused", other.status === 403, `HTTP ${other.status}`);
    const audit = readFileSync(join(dir, "data", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check("discord audit trail recorded with masked ids", audit.some((l) => l.adapter === "discord" && l.action === "deliver" && l.eventId === "…0002") && !JSON.stringify(audit).includes(USER) && !JSON.stringify(audit).includes(GUILD));
    say();
    say("```");
    for (const l of audit) say(JSON.stringify(l));
    say("```");
  } finally {
    await svc.stop();
    await routine.close();
  }
}

async function partC() {
  say();
  say("### C. Discord attachments, voice and the local-planner hop (mock CDN + mock planner on loopback)");
  say();
  const routine = await mockRoutine({ key: "routine-key" });
  const cdn = await mockCdn({
    "/attachments/1/2/render.png": { type: "image/png", body: PNG_1X1 },
    "/attachments/1/2/setup.exe": { type: "application/x-msdownload", body: Buffer.from("MZ") },
  });
  const dir = tmp("ubridge-smoke-c-");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const cbAuth = { authorization: "Bearer cb-discord" };
  let dropNext = false;
  // The mock planner accepts, then (like the real listener) POSTs its result to the callback URL it was given.
  const planner = await mockPlanner({
    token: "planner-token",
    answer: (h) => {
      if (dropNext) return "drop";
      const cbUrl = h.url.searchParams.get("callbackUrl")!;
      setTimeout(() => {
        void fetch(cbUrl, {
          method: "POST",
          headers: { "content-type": "application/json", ...cbAuth },
          body: JSON.stringify({
            channelId: h.body.channelId,
            content: "Done: here is the edit.",
            replyToMessageId: h.url.searchParams.get("messageId"),
            statusMessageId: h.url.searchParams.get("statusMessageId"),
            attachments: [{ url: `${cdn.base}/attachments/1/2/render.png` }],
          }),
        });
      }, 50);
      return { status: 202, body: { ok: true, exitCode: 0 } };
    },
  });
  const voiceCh = "777777777777777777";
  const plannerCh = "200000000000000001";
  const { file, env } = writeConfigs(dir, routine.url, "", port, { discord: true }, {
    attachments: { allowHttpHosts: ["127.0.0.1"] },
    planner: { urlRef: "env:DISCORD_PLANNER_URL", tokenRef: "env:DISCORD_PLANNER_TOKEN", callbackUrl: `${base}/discord/callback` },
    voice: { enabled: true, channels: [voiceCh] },
  });
  const fake = new FakeDiscordPort(BOT);
  const svc = await buildService(file, {
    discordPort: fake,
    env: { ...env, BRIDGE_WAKE_URL: "", DISCORD_PLANNER_URL: `${planner.url}?messageId=PLACEHOLDER`, DISCORD_PLANNER_TOKEN: "planner-token" },
    log: silentLogger,
  });
  await svc.start();
  try {
    type Started = { accepted?: boolean; planner?: true; done?: Promise<string> };
    const discord = svc.adapters.get("discord") as unknown as { onMessage: (m: ReturnType<typeof discordMessage>) => Promise<Started | undefined> };
    // 1. inbound attachments (incl. a voice message) -> agent gets URL refs, nothing downloaded
    const refs = [
      { url: `${cdn.base}/attachments/1/2/render.png?ex=1`, filename: "render.png", contentType: "image/png", size: PNG_1X1.length },
      { url: `${cdn.base}/attachments/1/2/voice-message.ogg`, filename: "voice-message.ogg", contentType: "audio/ogg", size: 2048 },
    ];
    const r1 = await discord.onMessage(discordMessage({ id: "700000000000000011", content: `<@${BOT}>`, attachments: refs }));
    const p: string = routine.hits.at(-1)?.body.prompt ?? "";
    check(
      "inbound image + voice message reach the agent as a= refs and metadata (not fetched)",
      r1?.accepted === true && p.startsWith("Discord #example-chat from example-user (2 attachments):") && p.includes(` a=${refs[1].url}`) && routine.hits.at(-1)?.body.metadata.attachments.length === 2 && cdn.hits.length === 0,
      p.split("\n")[0],
    );
    // 2. callback files: base64 + mock CDN url; exe refused; unlisted channel refused before any fetch
    const cb = await api(base, "POST", "/discord/callback", {
      channelId: CHANNEL,
      content: "Files attached.",
      replyToMessageId: "700000000000000011",
      attachments: [{ filename: "summary.md", data: Buffer.from("# summary").toString("base64") }, { url: `${cdn.base}/attachments/1/2/render.png` }],
    }, cbAuth);
    const sentFiles = fake.sent.at(-1)?.files?.map((f) => `${f.filename}:${f.contentType}`).join(", ");
    check("callback posts base64 + CDN-url attachments", cb.status === 200 && cb.body.attachments === 2, sentFiles);
    const exe = await api(base, "POST", "/discord/callback", { channelId: CHANNEL, content: "x", attachments: [{ url: `${cdn.base}/attachments/1/2/setup.exe` }] }, cbAuth);
    check("executable from the CDN refused with 415", exe.status === 415 && exe.body.error === "unsupported_media_type", `HTTP ${exe.status} ${exe.body.error}`);
    const hitsBefore = cdn.hits.length;
    const off = await api(base, "POST", "/discord/callback", { channelId: "999999999999999999", content: "x", attachments: [{ url: `${cdn.base}/attachments/1/2/render.png` }] }, cbAuth);
    check("callback to an unrouted channel refused before any CDN fetch", off.status === 403 && cdn.hits.length === hitsBefore, `HTTP ${off.status}`);
    // 3. planner hop end to end
    const sentBefore = fake.sent.length;
    const r2 = await discord.onMessage(discordMessage({ id: "700000000000000012", channelId: plannerCh, content: `<@${BOT}> make the sky purple`, attachments: [refs[0]] }));
    const signal = await r2?.done;
    const working = fake.sent[sentBefore];
    const ph = planner.hits[0];
    check("planner route posts ONE \"Working on it.\" reply and does not wake the agent", working?.content === "Working on it. (0s)" && working.replyTo === "700000000000000012" && routine.hits.length === 1, `"${working?.content}"`);
    check(
      "planner called with the real message id, callback URL and status id; no token on the query string",
      signal === "accepted" && ph.url.searchParams.get("messageId") === "700000000000000012" && ph.url.searchParams.get("callbackUrl") === `${base}/discord/callback` && ph.url.searchParams.get("statusMessageId") === working.id && !ph.url.searchParams.has("token") && ph.headers.authorization === "Bearer planner-token" && ph.body.imagePath === refs[0].url,
      `signal=${signal}`,
    );
    await until(() => fake.edits.some((e) => e.content === "Done: here is the edit."), 5000);
    const final = fake.edits.find((e) => e.content === "Done: here is the edit.");
    check("planner's own callback edits the working message (with the CDN file); no extra message", final?.messageId === working.id && final.files?.[0]?.filename === "render.png" && fake.sent.length === sentBefore + 1, `files=${final?.files?.length}`);
    check("accepted planner hop reacts \u2705 on the user's message", fake.reactions.some((x) => x.messageId === "700000000000000012" && x.emoji === "\u2705"));
    dropNext = true;
    const r3 = await discord.onMessage(discordMessage({ id: "700000000000000013", channelId: plannerCh, content: `<@${BOT}> again` }));
    const s3 = await r3?.done;
    const w3 = fake.sent.at(-1)!;
    const noRedX = ![...fake.sent, ...fake.edits].some((m) => m.messageId === w3.id || m.id === w3.id ? /\u274C|Couldn't start/.test(m.content) : false);
    check("planner connection dropped (listener timeout): no red X, working message left for the late callback", s3 === "transport" && noRedX && w3.content.startsWith("Working on it."), `signal=${s3}`);
    // 4. voice
    const play = await api(base, "POST", "/discord/voice/play", { channelId: voiceCh }, cbAuth);
    const noAuth = await api(base, "POST", "/discord/voice/play", { channelId: voiceCh });
    const unlisted = await api(base, "POST", "/discord/voice/play", { channelId: "100000000000000000" }, cbAuth);
    check("voice play: callback token required, channel allowlist, tone played", play.status === 200 && noAuth.status === 401 && unlisted.status === 403 && fake.voice.played.length === 1, `${play.status}/${noAuth.status}/${unlisted.status}`);
    const open = await api(base, "POST", "/discord/voice/stream", { op: "open", channelId: voiceCh }, cbAuth);
    const busy = await api(base, "POST", "/discord/voice/play", { channelId: voiceCh }, cbAuth);
    const closed = await api(base, "POST", "/discord/voice/stream", { op: "close" }, cbAuth);
    check("voice stream open blocks play (409) until closed", open.status === 200 && busy.status === 409 && closed.body.closed === true, `${open.status}/${busy.status}`);
    const audit = readFileSync(join(dir, "data", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const att = audit.filter((l) => l.action === "attachment");
    const text = JSON.stringify(audit);
    check(
      "attachment + planner + voice audit lines are content-free (counts, kinds, codes; no names, URLs or text)",
      att.length >= 3 && audit.some((l) => l.action === "planner") && audit.some((l) => l.action === "voice") && !/render\.png|summary|voice-message|127\.0\.0\.1|sky purple|planner-token/.test(text),
      `${att.length} attachment lines`,
    );
    say();
    say("```");
    for (const l of audit.filter((x) => ["attachment", "planner", "voice"].includes(x.action))) say(JSON.stringify(l));
    say("```");
  } finally {
    await svc.stop();
    await routine.close();
    await planner.close();
    await cdn.close();
  }
}

const started = Date.now();
say(`## Local end-to-end smoke (${process.platform}, node ${process.version})`);
say();
try {
  await partA();
  await partB();
  await partC();
} catch (err) {
  failures += 1;
  say(`- [ ] smoke run threw: ${(err as Error).message}`);
}
say();
say(`Result: ${failures === 0 ? "PASS" : `FAIL (${failures})`} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
const text = out.join("\n");
console.log(text);
if (process.env.SMOKE_OUT) writeFileSync(process.env.SMOKE_OUT, text);
process.exit(failures === 0 ? 0 : 1);
