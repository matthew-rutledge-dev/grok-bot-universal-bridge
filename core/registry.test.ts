import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Registry, validateRegistry } from "./registry.js";

const example = JSON.parse(readFileSync(new URL("../config/registry.example.json", import.meta.url), "utf8"));

test("the shipped example registry is valid", () => {
  assert.deepEqual(validateRegistry(example), []);
});

test("literal keys in the registry are refused", () => {
  const bad = { version: 1, agents: { a: { agentId: "x", deliver: { kind: "webhook", url: "https://example.com/x", key: "literal" } } } };
  assert.ok(validateRegistry(bad).some((p) => /literal deliver.key is refused/.test(p)));
});

test("resolve fails closed without a key, and refuses plain http off loopback", () => {
  const reg = Registry.fromObject(
    {
      version: 1,
      agents: {
        nokey: { agentId: "1", deliver: { kind: "webhook", url: "https://example.com/a/b", keyRef: "env:NOPE" } },
        plain: { agentId: "2", deliver: { kind: "webhook", url: "http://example.com/a/b", keyRef: "env:K" } },
        ok: { agentId: "3", deliver: { kind: "webhook", urlRef: "env:U", keyRef: "env:K" } },
      },
    },
    { K: "k1", U: "https://example.com/automations/webhook/11111111" },
  );
  assert.equal(reg.resolve("nokey").agent, undefined);
  assert.ok(reg.resolve("plain").problems.some((p) => /https/.test(p)));
  assert.equal(reg.resolve("ok").agent?.agentId, "3");
  const pub = reg.describe("ok");
  assert.equal(pub.target, "https://example.com/automations/webhook/…");
  assert.equal(JSON.stringify(pub).includes("k1"), false);
});
