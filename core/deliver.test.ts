import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, DeliveryConfigError, DeliveryError, isRetryable } from "./deliver.js";
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
  assert.equal(isRetryable(new DeliveryError("x", 500, "error code: 1033")), true);
  assert.equal(isRetryable(new DeliveryConfigError("no key")), false);
  assert.equal(isRetryable(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })), true);
  assert.equal(isRetryable(Object.assign(new Error("x"), { name: "TimeoutError" })), true);
});
