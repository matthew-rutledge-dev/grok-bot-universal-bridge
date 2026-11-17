import { test } from "node:test";
import assert from "node:assert/strict";
import { maskDeliveryMessage, MASKED_DELIVERY_MESSAGE_MAX } from "./redact.js";

test("maskDeliveryMessage: tokens and URLs stripped, ids truncated, capped", () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const token = "tok_EXAMPLE_not_a_real_secret";
  const out = maskDeliveryMessage(
    JSON.stringify({ message: `active agent is ${agentId}`, token, url: "https://example.com/api/sendPrompt?x=1" }),
  );
  assert.match(out, /active agent is …1111/);
  assert.equal(out.includes(agentId), false);
  assert.equal(out.includes(token), false);
  assert.equal(out.includes("sendPrompt?x=1"), false);
  const raw = maskDeliveryMessage(`see https://example.com/api/sendPrompt?x=1 token=${token}`);
  assert.equal(raw.includes(token), false);
  assert.equal(raw.includes("sendPrompt?x=1"), false);
  const long = maskDeliveryMessage("rejected " + "z".repeat(500));
  assert.equal(long.length, MASKED_DELIVERY_MESSAGE_MAX);
  assert.ok(long.endsWith("…"));
});
