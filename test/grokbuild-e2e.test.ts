/**
 * Grok Build end to end on loopback: the real service wiring (buildService)
 * with a fake sendPrompt Gateway, a fake wake routine and a fake Grok Build
 * client. Nothing leaves 127.0.0.1.
 *
 *   read-only refuses writes -> flip the switch off (no restart) ->
 *   prompt -> held while the Gateway sleeps -> wake POST -> delivered ->
 *   the agent's callback -> the client reads the reply.
 *   Unauthorized, non-allowlisted and rate-limited requests fail.
 *   The live-check script passes against the same bridge and prints no secret.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { buildService } from "../src/service.js";
import { silentLogger } from "../core/types.js";
import { tmp, until } from "./helpers.js";

const CLIENT_TOKEN = "e2e-client-token-0001";
const OTHER_TOKEN = "e2e-other-token-0002";
const BURST_TOKEN = "e2e-burst-token-0003";
const CALLBACK_TOKEN = "e2e-callback-token-0004";
const GATEWAY_TOKEN = "e2e-gateway-token-0005";
const WAKE_KEY = "e2e-wake-key-0006";
const SECRET_PROMPT = "e2e: refactor the parser please";

interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

/** Loopback server answering from a status script, then 200. `after` runs after each 200. */
async function fakeServer(script: number[], after?: (hit: Hit) => void) {
  const hits: Hit[] = [];
  const queue = [...script];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep */
      }
      const hit = { path: req.url ?? "/", headers: req.headers, body };
      hits.push(hit);
      const status = queue.length ? queue.shift()! : 200;
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status === 200 ? { ok: true } : { ok: false }));
      if (status === 200 && after) setImmediate(() => after(hit));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, hits, queue, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

/** What a Grok Build harness does: knows the bridge URL and its own token, nothing else. */
class FakeGrokBuildClient {
  constructor(
    private readonly base: string,
    private readonly token: string | undefined,
  ) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any, retryAfter: res.headers.get("retry-after") };
  }
  prompt(bot: string, prompt: string, requestId?: string) {
    return this.req("POST", "/grokbuild/prompt", { bot, prompt, ...(requestId ? { requestId } : {}) });
  }
  read(requestId: string) {
    return this.req("GET", `/grokbuild/requests/${requestId}`);
  }
  status() {
    return this.req("GET", "/grokbuild/status");
  }
}

function runLiveCheck(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/grokbuild-live-check.mjs", ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

test("grokbuild end to end: read-only, flip, prompt -> wake -> callback, refusals, live check", async () => {
  const dir = tmp("ub-gb-e2e-");
  // The fake agent behind the Gateway answers through the bridge callback, like a real Grok Bot would.
  let bridgeBase = "";
  let agentReplies = 0;
  const gateway = await fakeServer([], (hit) => {
    const trailer = String(hit.body?.prompt ?? "").split("\n").pop() ?? "";
    const m = /^\u27C2 gb:(\S+) client=(\S+) reply=(\S+)$/.exec(trailer);
    if (!m) return;
    const path = new URL(m[3]).pathname; // the public URL points at the tunnel; the fake agent dials loopback
    agentReplies += 1;
    void fetch(`${bridgeBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CALLBACK_TOKEN}` },
      body: JSON.stringify({ requestId: m[1], client: m[2], content: m[1].startsWith("live-check-") ? "live-check ok" : "Done: parser refactored." }),
    });
  });
  const wake = await fakeServer([]);
  const registry = {
    version: 1,
    agents: {
      "example-agent": {
        agentId: "11111111-1111-4111-8111-111111111111",
        deliver: { kind: "sendprompt", url: `${gateway.url}/api/sendPrompt`, keyRef: "env:EXAMPLE_GATEWAY_TOKEN", timeoutMs: 2000 },
      },
      "broken-agent": { agentId: "22222222-2222-4222-8222-222222222222", deliver: { kind: "sendprompt", url: `${gateway.url}/api/sendPrompt`, keyRef: "env:MISSING_TOKEN" } },
    },
  };
  const example = JSON.parse(readFileSync("adapters/grokbuild/config.example.json", "utf8"));
  const grokbuild = {
    ...example,
    promptsPerMin: 30,
    clients: {
      "example-client": { tokenRef: "env:GROKBUILD_CLIENT_TOKEN" },
      "other-client": { tokenRef: "env:OTHER_CLIENT_TOKEN" },
      "burst-client": { tokenRef: "env:BURST_CLIENT_TOKEN", promptsPerMin: 5 },
    },
    routes: [
      ...example.routes,
      { id: "disabled", enabled: false, match: { client: "example-client", bot: "disabled-agent" }, allowActors: ["example-client"], agent: "example-agent" },
      { id: "broken", enabled: true, match: { client: "example-client", bot: "broken-agent" }, allowActors: ["example-client"], agent: "broken-agent" },
    ],
  };
  const regPath = join(dir, "registry.json");
  writeFileSync(regPath, JSON.stringify(registry));
  chmodSync(regPath, 0o600);
  writeFileSync(join(dir, "grokbuild.json"), JSON.stringify(grokbuild));
  const auditPath = join(dir, "data", "audit.jsonl");
  const bridgeCfg = {
    version: 1,
    http: { bind: "127.0.0.1", port: 0, publicBaseUrl: "https://bridge.example.com" },
    registryPath: regPath,
    dataDir: join(dir, "data"),
    hold: { maxSec: 60, backoffMs: [100, 150, 200] },
    wake: { urlRef: "env:BRIDGE_WAKE_URL", keyRef: "env:BRIDGE_WAKE_KEY" },
    audit: { path: auditPath },
    callbackRateLimitPerMin: 90,
    adapters: {
      discord: { enabled: false, configPath: "adapters/discord/config.example.json" },
      grokbuild: { enabled: true, configPath: join(dir, "grokbuild.json") },
      tesla: { enabled: false, configPath: "adapters/tesla/config.example.json" },
    },
  };
  const cfgFile = join(dir, "bridge.json");
  writeFileSync(cfgFile, JSON.stringify(bridgeCfg));
  // Mutable on purpose: the read-only switch and tokens are re-read per request, like a host env/file change.
  const env: Record<string, string | undefined> = {
    EXAMPLE_GATEWAY_TOKEN: GATEWAY_TOKEN,
    BRIDGE_WAKE_URL: `${wake.url}/wake`,
    BRIDGE_WAKE_KEY: WAKE_KEY,
    GROKBUILD_CLIENT_TOKEN: CLIENT_TOKEN,
    OTHER_CLIENT_TOKEN: OTHER_TOKEN,
    BURST_CLIENT_TOKEN: BURST_TOKEN,
    GROKBUILD_CALLBACK_TOKEN: CALLBACK_TOKEN,
    GROKBUILD_READ_ONLY: "1",
  };
  const svc = await buildService(cfgFile, { env, log: silentLogger });
  const port = await svc.start();
  bridgeBase = `http://127.0.0.1:${port}`;
  const client = new FakeGrokBuildClient(bridgeBase, CLIENT_TOKEN);
  const liveEnv = { LIVE_BRIDGE_URL: bridgeBase, LIVE_CLIENT_TOKEN: CLIENT_TOKEN, LIVE_CALLBACK_TOKEN: CALLBACK_TOKEN };
  const liveArgs = ["--bridge-url-ref", "env:LIVE_BRIDGE_URL", "--client-token-ref", "env:LIVE_CLIENT_TOKEN", "--callback-token-ref", "env:LIVE_CALLBACK_TOKEN", "--bot", "example-agent"];
  const noSecrets = (s: string) => ![CLIENT_TOKEN, CALLBACK_TOKEN, bridgeBase, `127.0.0.1:${port}`].some((v) => s.includes(v));
  try {
    // 1. Read-only refuses writes and delivers nothing.
    const st = await client.status();
    assert.deepEqual([st.status, st.body.readOnly, st.body.replyChannel, st.body.bots], [200, true, "ready", ["example-agent", "broken-agent"]]);
    const ro = await client.prompt("example-agent", SECRET_PROMPT, "e2e-readonly-1");
    assert.deepEqual([ro.status, ro.body.error], [403, "read_only"]);
    assert.equal((await client.read("e2e-readonly-1")).status, 404, "a refused prompt leaves no record");
    const liveRo = await runLiveCheck([...liveArgs, "--expect", "read-only"], liveEnv);
    assert.equal(liveRo.code, 0, liveRo.out);
    assert.match(liveRo.out, /RESULT: all checks passed/);
    assert.ok(noSecrets(liveRo.out), "live check printed a secret");
    assert.equal(gateway.hits.length, 0);

    // 2. The operator flips read-only off (env change, no restart).
    env.GROKBUILD_READ_ONLY = "0";
    assert.equal((await client.status()).body.readOnly, false);

    // 3. Gateway asleep: the prompt is held, the wake hook fires once, then it is delivered.
    gateway.queue.push(503, 503);
    const sent = await client.prompt("example-agent", SECRET_PROMPT, "e2e-req-00000001");
    assert.deepEqual([sent.status, sent.body.state], [202, "held"]);
    await until(() => wake.hits.length === 1);
    assert.equal(wake.hits[0].headers.authorization, `Bearer ${WAKE_KEY}`);
    assert.ok(!JSON.stringify(wake.hits[0].body).includes("e2e"), "wake body carries no content or ids");
    await until(() => gateway.hits.length === 3, 8000);
    const hit = gateway.hits[2];
    assert.equal(hit.path, "/api/sendPrompt");
    assert.equal(hit.headers.authorization, `Bearer ${GATEWAY_TOKEN}`);
    assert.equal(hit.body.agentId, "11111111-1111-4111-8111-111111111111");
    assert.match(hit.body.prompt, /untrusted data/);
    assert.ok(hit.body.prompt.includes(SECRET_PROMPT));
    assert.match(hit.body.prompt, /\u27C2 gb:e2e-req-00000001 client=example-client reply=https:\/\/bridge\.example\.com\/grokbuild\/callback$/);
    assert.equal(hit.body.metadata.requestId, "e2e-req-00000001");

    // 4. The agent's callback lands; the client reads the reply.
    let read = await client.read("e2e-req-00000001");
    await until(() => agentReplies === 1);
    const end = Date.now() + 5000;
    while (Date.now() < end && !(read.body.replies?.length > 0)) {
      await new Promise((r) => setTimeout(r, 20));
      read = await client.read("e2e-req-00000001");
    }
    assert.equal(read.body.state, "delivered");
    assert.equal(read.body.replies[0].content, "Done: parser refactored.");
    assert.equal(wake.hits.length, 1, "still exactly one wake POST for the outage after delivery");
    assert.equal((await new FakeGrokBuildClient(bridgeBase, OTHER_TOKEN).read("e2e-req-00000001")).status, 404, "another client cannot read it");

    // 5. Unauthorized requests fail.
    assert.equal((await new FakeGrokBuildClient(bridgeBase, undefined).prompt("example-agent", "x")).status, 401);
    assert.equal((await new FakeGrokBuildClient(bridgeBase, "wrong-token").prompt("example-agent", "x")).status, 401);
    assert.equal((await new FakeGrokBuildClient(bridgeBase, "wrong-token").read("e2e-req-00000001")).status, 401);
    assert.equal((await new FakeGrokBuildClient(bridgeBase, undefined).req("POST", `/grokbuild/prompt?token=${CLIENT_TOKEN}`, { bot: "example-agent", prompt: "x" })).status, 400);
    const cbBad = await new FakeGrokBuildClient(bridgeBase, "wrong-token").req("POST", "/grokbuild/callback", { requestId: "e2e-req-00000001", content: "forged" });
    assert.equal(cbBad.status, 401);
    const cbClient = await client.req("POST", "/grokbuild/callback", { requestId: "e2e-req-00000001", content: "forged" });
    assert.equal(cbClient.status, 401, "a client token is not a callback token");

    // 6. Non-allowlisted requests fail and deliver nothing.
    const before = gateway.hits.length;
    const other = await new FakeGrokBuildClient(bridgeBase, OTHER_TOKEN).prompt("example-agent", "x");
    assert.deepEqual([other.status, other.body.error], [403, "no_route"]);
    assert.deepEqual([(await client.prompt("not-routed-agent", "x")).body.error, (await client.prompt("disabled-agent", "x")).body.error], ["no_route", "route_disabled"]);
    const broken = await client.prompt("broken-agent", "x");
    assert.deepEqual([broken.status, broken.body.error], [503, "agent_not_ready"]);
    assert.equal((await client.prompt("Example-Agent", "x")).status, 400);
    assert.equal(gateway.hits.length, before);

    // 7. Rate-limited requests fail with Retry-After.
    const burst = new FakeGrokBuildClient(bridgeBase, BURST_TOKEN);
    const codes: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 7; i++) {
      const r = await burst.prompt("example-agent", "x");
      codes.push(r.status);
      if (r.status === 429) retryAfter = r.retryAfter;
    }
    assert.deepEqual(codes, [403, 403, 403, 403, 403, 429, 429]);
    assert.ok(Number(retryAfter) >= 1);

    // 8. The live check passes in writable mode and sends one real prompt end to end.
    const liveRw = await runLiveCheck([...liveArgs, "--expect", "writable", "--send", "--wait-reply-sec", "20"], liveEnv);
    assert.equal(liveRw.code, 0, liveRw.out);
    assert.match(liveRw.out, /PASS the agent's reply came back through the callback/);
    assert.ok(noSecrets(liveRw.out), "live check printed a secret");
    const literal = await runLiveCheck(["--bridge-url-ref", bridgeBase, "--client-token-ref", "env:LIVE_CLIENT_TOKEN", "--bot", "example-agent", "--expect", "writable"], liveEnv);
    assert.equal(literal.code, 2);
    assert.match(literal.out, /literal values are refused/);
    assert.ok(noSecrets(literal.out));
    const wrongMode = await runLiveCheck([...liveArgs, "--expect", "read-only"], liveEnv);
    assert.equal(wrongMode.code, 1, "the live check notices the switch is not what the operator expects");

    // 9. Fail closed when tokens are unset: 503, never open.
    env.GROKBUILD_CALLBACK_TOKEN = "";
    const noCb = await client.prompt("example-agent", "x");
    assert.deepEqual([noCb.status, noCb.body.error], [503, "reply_channel_unset"]);
    assert.equal((await client.req("POST", "/grokbuild/callback", { requestId: "e2e-req-00000001", content: "x" })).status, 503);
    env.GROKBUILD_CLIENT_TOKEN = "";
    env.OTHER_CLIENT_TOKEN = undefined;
    env.BURST_CLIENT_TOKEN = "changeme";
    const noClient = await new FakeGrokBuildClient(bridgeBase, "").prompt("example-agent", "x");
    assert.deepEqual([noClient.status, noClient.body.error], [503, "client_auth_unset"]);

    // 10. Audit: content-free, ids masked.
    const audit = readFileSync(auditPath, "utf8");
    for (const s of [SECRET_PROMPT, "e2e-req-00000001", CLIENT_TOKEN, CALLBACK_TOKEN, GATEWAY_TOKEN, WAKE_KEY, gateway.url]) {
      assert.ok(!audit.includes(s), `audit leaks ${s.slice(0, 8)}…`);
    }
    const lines = audit.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.every((l) => l.actor === undefined || /^…/.test(l.actor)), "actors (client ids) are masked");
    assert.ok(lines.some((l) => l.action === "callback" && l.reason === "reply_stored" && l.eventId === "…0001"));
    assert.ok(lines.some((l) => l.reason === "read_only"));
    assert.ok(lines.some((l) => l.reason === "rate_limited"));
    assert.ok(lines.some((l) => l.reason === "client_token_unset" && l.status === 503));
  } finally {
    await svc.stop();
    await gateway.close();
    await wake.close();
  }
});
