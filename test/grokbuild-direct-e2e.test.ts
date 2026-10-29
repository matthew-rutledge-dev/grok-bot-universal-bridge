/**
 * Direct-reply round trip on loopback with the real service wiring (buildService):
 * a fake Grok Build client asks the bridge for a reply route, posts the prompt
 * straight to a fake webhook routine (not through the bridge), the fake bot behind
 * that routine answers on the reply URL with the one-time token, and the client's
 * long-poll read gets the reply. Nothing leaves 127.0.0.1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { buildService } from "../src/service.js";
import { silentLogger } from "../core/types.js";
import { tmp } from "./helpers.js";

const CLIENT_TOKEN = "e2e-direct-client-0001";
const CALLBACK_TOKEN = "e2e-direct-callback-0002";
const ROUTINE_KEY = "e2e-direct-routine-0003";
const REPLY_TEXT = "e2e direct: done, 2 files changed";

test("direct reply end to end: expect -> webhook routine -> bot posts reply -> long-poll read", async () => {
  const dir = tmp("ub-gb-direct-");
  let bridgeBase = "";
  let botPosts = 0;
  // The fake routine + bot: accepts the webhook, then replies the way the routine prompt tells a real bot to.
  const routine: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const ok = req.headers.authorization === `Bearer ${ROUTINE_KEY}`;
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify({ success: ok, runUuid: "run-0001" }));
      if (!ok) return;
      const body = JSON.parse(raw);
      const reply = body.reply as { url: string; requestId: string; token: string };
      botPosts += 1;
      setTimeout(() => {
        void fetch(`${bridgeBase}${new URL(reply.url).pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${reply.token}` },
          body: JSON.stringify({ requestId: reply.requestId, content: REPLY_TEXT }),
        });
      }, 150);
    });
  });
  await new Promise<void>((r) => routine.listen(0, "127.0.0.1", () => r()));
  const routineUrl = `http://127.0.0.1:${(routine.address() as AddressInfo).port}/webhook`;

  const example = JSON.parse(readFileSync("adapters/grokbuild/config.example.json", "utf8"));
  writeFileSync(join(dir, "grokbuild.json"), JSON.stringify({ ...example, routes: [] }));
  const regPath = join(dir, "registry.json");
  writeFileSync(regPath, JSON.stringify({ version: 1, agents: {} }));
  chmodSync(regPath, 0o600);
  const auditPath = join(dir, "data", "audit.jsonl");
  const cfgFile = join(dir, "bridge.json");
  writeFileSync(
    cfgFile,
    JSON.stringify({
      version: 1,
      http: { bind: "127.0.0.1", port: 0, publicBaseUrl: "https://bridge.example.com" },
      registryPath: regPath,
      dataDir: join(dir, "data"),
      hold: { maxSec: 60 },
      audit: { path: auditPath },
      adapters: {
        discord: { enabled: false, configPath: "adapters/discord/config.example.json" },
        grokbuild: { enabled: true, configPath: join(dir, "grokbuild.json") },
        tesla: { enabled: false, configPath: "adapters/tesla/config.example.json" },
      },
    }),
  );
  const env = { GROKBUILD_CLIENT_TOKEN: CLIENT_TOKEN, GROKBUILD_CALLBACK_TOKEN: CALLBACK_TOKEN, GROKBUILD_READ_ONLY: "0" };
  const svc = await buildService(cfgFile, { env, log: silentLogger });
  const port = await svc.start();
  bridgeBase = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${bridgeBase}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  let token = "";
  try {
    const st = await call("GET", "/grokbuild/status");
    assert.equal(st.body.directReplies, "ready");
    const requestId = "e2e-direct-0000001";
    const ex = await call("POST", "/grokbuild/expect", { requestId, bot: "example-agent" });
    assert.equal(ex.status, 201);
    token = ex.body.replyToken;
    // The client posts the prompt to the routine itself (the bridge delivers nothing here).
    const payload = { kind: "prompt", prompt: "refactor please", bot: "example-agent", from: "grokbuild", sentAt: new Date().toISOString(), requestId, reply: { url: ex.body.replyUrl, requestId, token, expiresAt: ex.body.expiresAt } };
    const sent = await fetch(routineUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ROUTINE_KEY}` }, body: JSON.stringify(payload) });
    assert.equal(sent.status, 200);
    const read = await call("GET", `/grokbuild/requests/${requestId}?waitSec=10`);
    assert.deepEqual([read.status, read.body.state, read.body.replies[0]?.content], [200, "replied", REPLY_TEXT]);
    assert.equal(botPosts, 1);
  } finally {
    await svc.stop();
    await new Promise<void>((r) => (routine.closeAllConnections(), routine.close(() => r())));
  }
  const audit = readFileSync(auditPath, "utf8");
  assert.match(audit, /direct_reply_stored/);
  for (const secret of [token, CLIENT_TOKEN, REPLY_TEXT, "refactor please"]) assert.ok(!audit.includes(secret), "audit leaked a secret or text");
});
