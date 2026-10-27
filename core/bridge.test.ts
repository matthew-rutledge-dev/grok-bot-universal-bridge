import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdapterContext, SourceAdapter } from "./bridge.js";
import type { InboundEvent, Route } from "./types.js";
import { mockRoutine, startBridge, until } from "../test/helpers.js";

class EchoAdapter implements SourceAdapter {
  readonly name = "echo";
  ctx!: AdapterContext;
  replies: unknown[] = [];
  constructor(
    readonly routes: Route[],
    readonly callbackTokenRef?: string,
  ) {}
  init(ctx: AdapterContext) {
    this.ctx = ctx;
  }
  async start() {}
  async stop() {}
  async handleCallback(body: unknown) {
    this.replies.push(body);
    return { status: 200, body: { ok: true } };
  }
}

const routes: Route[] = [
  { id: "r1", enabled: true, match: { room: "r1" }, allowActors: ["u1"], agent: "example-agent" },
  { id: "r2", enabled: true, match: { room: "r2" }, allowActors: ["u1"], agent: "broken-agent" },
  { id: "r3", enabled: true, match: { room: "r3" }, allowActors: ["u1"], agent: "no-such-agent" },
];
const ev = (over: Partial<InboundEvent> = {}): InboundEvent => ({
  eventId: "e1",
  lane: "r1",
  actor: "u1",
  match: { room: "r1" },
  prompt: "SECRET-PROMPT-TEXT",
  ...over,
});

test("submit: allow -> deliver; duplicate, unknown and not-ready agents are denied", async () => {
  const m = await mockRoutine({ key: "routine-key" });
  const a = new EchoAdapter(routes);
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  try {
    const ok = await a.ctx.submit(ev());
    assert.deepEqual(ok, { accepted: true, id: "echo:e1", state: "delivered", agent: "example-agent" });
    assert.equal(m.hits.length, 1);
    assert.equal(m.hits[0].body.metadata.source, "echo");
    assert.deepEqual(await a.ctx.submit(ev()), { accepted: false, reason: "duplicate" });
    assert.deepEqual(await a.ctx.submit(ev({ eventId: "e2", match: { room: "r2" } })), { accepted: false, reason: "agent_not_ready" });
    assert.deepEqual(await a.ctx.submit(ev({ eventId: "e3", match: { room: "r3" } })), { accepted: false, reason: "agent_unknown" });
    assert.deepEqual(await a.ctx.submit(ev({ eventId: "e4", actor: "u2" })), { accepted: false, reason: "actor_not_allowlisted" });
    assert.equal(m.hits.length, 1, "denied events never reach the routine");
  } finally {
    await b.close();
    await m.close();
  }
});

test("audit: one line per decision, ids masked, no prompt text anywhere", async () => {
  const m = await mockRoutine({ key: "routine-key", script: [503] });
  const a = new EchoAdapter(routes);
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  try {
    await a.ctx.submit(ev({ eventId: "evt-000012345" }));
    await until(() => b.audit.lines.some((l) => l.action === "deliver"));
    await a.ctx.submit(ev({ eventId: "e9", actor: "intruder" }));
    const actions = b.audit.lines.map((l) => `${l.action}:${l.outcome}`);
    assert.deepEqual(actions, ["inbound:allow", "hold:held", "deliver:ok", "inbound:deny"]);
    const all = JSON.stringify(b.audit.lines);
    assert.equal(all.includes("SECRET-PROMPT-TEXT"), false);
    assert.equal(all.includes("routine-key"), false);
    assert.equal(all.includes("intruder"), false);
    assert.equal(b.audit.lines[0].eventId, "…2345");
  } finally {
    await b.close();
    await m.close();
  }
});

test("callback auth: fail-closed without a token, header only, constant-time compare, rate limited", async () => {
  const m = await mockRoutine();
  const off = new EchoAdapter(routes);
  const on = Object.assign(new EchoAdapter(routes, "env:CB"), { name: "echo2" as const });
  const b = await startBridge({ routineUrl: m.url, adapters: [off, on as unknown as SourceAdapter], env: { CB: "cb-token" }, rateLimit: 3 });
  try {
    assert.equal((await b.call("POST", "/echo/callback", { x: 1 }, { authorization: "Bearer anything" })).status, 503);
    assert.equal((await b.call("POST", "/echo2/callback", { x: 1 })).status, 401);
    assert.equal((await b.call("POST", "/echo2/callback", { x: 1 }, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await b.call("POST", "/echo2/callback?token=cb-token", { x: 1 })).status, 400);
    assert.equal((await b.call("POST", "/echo2/callback", { x: 1 }, { authorization: "Bearer cb-token" })).status, 200);
    assert.equal((await b.call("POST", "/echo2/callback", { x: 2 }, { "x-callback-token": "cb-token" })).status, 200);
    assert.equal((await b.call("POST", "/echo2/callback", { x: 3 }, { authorization: "Bearer cb-token" })).status, 200);
    const limited = await b.call("POST", "/echo2/callback", { x: 4 }, { authorization: "Bearer cb-token" });
    assert.equal(limited.status, 429);
    assert.equal(on.replies.length, 3);
    assert.equal(off.replies.length, 0);
    const reasons = b.audit.lines.filter((l) => l.action === "callback").map((l) => l.reason ?? l.outcome);
    assert.deepEqual(reasons, ["callback_token_unset", "bad_token", "bad_token", "query_token_refused", "ok", "ok", "ok", "rate_limited"]);
    const health = await b.call("GET", "/healthz");
    assert.deepEqual(health.body, { ok: true, adapters: ["echo", "echo2"], held: 0 });
  } finally {
    await b.close();
    await m.close();
  }
});
