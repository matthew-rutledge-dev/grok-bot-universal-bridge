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

test("maskDeliveryMessage: quoted JSON token keys are redacted on the stringify fallback", () => {
  const token = "tok_EXAMPLE_not_a_real_secret";
  const secret = "sec_EXAMPLE_not_a_real_secret";
  const password = "pw_EXAMPLE_not_a_real_secret";
  const compact = `{"token":"${token}","secret":"${secret}","api_key":"${token}","password":"${password}","authorization":"Bearer ${token}"}`;
  const out = maskDeliveryMessage(compact);
  for (const v of [token, secret, password, "Bearer " + token]) {
    assert.equal(out.includes(v), false, `fallback must not leak ${v}`);
  }
  assert.match(out, /"token":"…"/);
  const keyVal = "key_EXAMPLE_not_a_real_secret";
  const pretty = maskDeliveryMessage(JSON.stringify({ token, key: keyVal, status: "conflict" }));
  assert.equal(pretty.includes(token), false);
  assert.equal(pretty.includes(keyVal), false);
  assert.match(pretty, /"token":"…"/);
  assert.match(pretty, /"key":"…"/);
  assert.match(pretty, /"status":"conflict"/);
});

test("maskDeliveryMessage: user-facing text strips URLs entirely; logs may keep the host", () => {
  const raw = "see https://example.com/api/sendPrompt?x=1 for details";
  const user = maskDeliveryMessage(raw, { max: 80, urls: "strip" });
  assert.match(user, /\[url\]/);
  assert.equal(user.includes("example.com"), false);
  assert.equal(user.includes("sendPrompt"), false);
  const log = maskDeliveryMessage(raw);
  assert.equal(log.includes("sendPrompt?x=1"), false);
  assert.match(log, /example\.com/);
});

