import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, DeliveryConfigError, DeliveryError, isGatewayConflict, isRetryable } from "./deliver.js";
import { mockRoutine } from "../test/helpers.js";

test("webhook delivery sends Bearer + X-Automation-Key and the prompt payload", async () => {
  const m = await mockRoutine({ key: "k1" });
  try {
    const res = await deliver(
      { alias: "a", agentId: "11111111", kind: "webhook", url: m.url, key: "k1", timeoutMs: 2000 },
      { agentId: "11111111", prompt: "hello", metadata: { source: "test" } },
      { from: "bridge:test", requestId: "r-1" },
    );
    assert.equal(res.status, 200);
    const h = m.hits[0];
    assert.equal(h.headers.authorization, "Bearer k1");
    assert.equal(h.headers["x-automation-key"], "k1");
    assert.equal(h.body.kind, "prompt");
    assert.equal(h.body.prompt, "hello");
    assert.equal(h.body.requestId, "r-1");
  } finally {
    await m.close();
  }
});

test("sendprompt delivery sends only Bearer and the {agentId,prompt,metadata} body", async () => {
  const m = await mockRoutine({ key: "t1" });
  try {
    await deliver({ alias: "a", agentId: "x", kind: "sendprompt", url: m.url, key: "t1", timeoutMs: 2000 }, { agentId: "x", prompt: "p" }, { from: "f" });
    assert.equal(m.hits[0].headers["x-automation-key"], undefined);
    assert.deepEqual(m.hits[0].body, { agentId: "x", prompt: "p" });
  } finally {
    await m.close();
  }
});

test("a 200 with success:false is a rejection, not a delivery", async () => {
  const m = await mockRoutine({ script: [-200] });
  try {
    await assert.rejects(
      deliver({ alias: "a", agentId: "x", kind: "webhook", url: m.url, key: "k", timeoutMs: 2000 }, { agentId: "x", prompt: "p" }, { from: "f" }),
      (e: unknown) => e instanceof DeliveryError && !isRetryable(e),
    );
  } finally {
    await m.close();
  }
});

test("retry classification", () => {
  for (const s of [502, 503, 504, 530, 408, 429]) assert.equal(isRetryable(new DeliveryError("x", s)), true, `status ${s}`);
  for (const s of [400, 401, 403, 404, 422]) assert.equal(isRetryable(new DeliveryError("x", s)), false, `status ${s}`);
  assert.equal(isRetryable(new DeliveryError("x", 409)), false, "409 is a gateway reject, not a generic retry");
  assert.equal(isGatewayConflict(new DeliveryError("x", 409)), true);
  assert.equal(isGatewayConflict(new DeliveryError("x", 401)), false);
  assert.equal(isRetryable(new DeliveryError("x", 500, "error code: 1033")), true);
  assert.equal(isRetryable(new DeliveryConfigError("no key")), false);
  assert.equal(isRetryable(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })), true);
  assert.equal(isRetryable(Object.assign(new Error("x"), { name: "TimeoutError" })), true);
});

test("a 409 from the gateway is logged with a masked message, never the raw token or full id", async () => {
  const lines: string[] = [];
  const agentId = "11111111-1111-4111-8111-111111111111";
  const token = "tok_EXAMPLE_not_a_real_secret";
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ message: `active agent is ${agentId}`, token }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  await assert.rejects(
    deliver(
      { alias: "a", agentId, kind: "sendprompt", url: "http://127.0.0.1/api/sendPrompt", key: "k", timeoutMs: 2000 },
      { agentId, prompt: "p" },
      { from: "bridge:test", fetchImpl, log: { info() {}, warn: (l) => lines.push(l), error() {} } },
    ),
    (e: unknown) => e instanceof DeliveryError && e.status === 409,
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[deliver\] rejected code=http_409 message=/);
  assert.match(lines[0], /…1111/);
  assert.equal(lines[0].includes(agentId), false, "full agent id must not be logged");
  assert.equal(lines[0].includes(token), false, "token must not be logged");
  assert.ok(lines[0].length < 280, "masked line stays short");
});
