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

test("a literal deliver.url is only accepted for loopback / example.com / .test hosts", () => {
  const mk = (url: string) => ({ version: 1, agents: { a: { agentId: "x", deliver: { kind: "webhook", url, keyRef: "env:K" } } } });
  for (const ok of ["http://127.0.0.1:1340/api/sendPrompt", "https://example.com/a", "https://hooks.example.com/a", "https://routine.test/a"]) {
    assert.deepEqual(validateRegistry(mk(ok)), [], ok);
  }
  for (const bad of ["https://hooks.real-service.invalid/automations/webhook/abc", "https://example.com.attacker.invalid/x"]) {
    assert.ok(validateRegistry(mk(bad)).some((p) => /use urlRef/.test(p)), bad);
  }
});

test("aliases must be lowercase: clear error with the fix, no silent normalising; route case mismatch is named", async () => {
  const bad = { version: 1, agents: { "Example-Agent": example.agents["example-agent"] } };
  const msg = validateRegistry(bad).join();
  assert.match(msg, /registry aliases must be lowercase/);
  assert.match(msg, /Rename it to "example-agent" here and in every adapter route's "agent" field/);
  assert.throws(() => Registry.fromObject(bad, {}), /must be lowercase/);
  const { routeAliasCaseProblem } = await import("./registry.js");
  assert.equal(
    routeAliasCaseProblem("Example-Agent", ["example-agent"], "discord.routes[0]"),
    'discord.routes[0]: agent "Example-Agent" must be lowercase "example-agent" (registry aliases are lowercase and case-sensitive)',
  );
  assert.equal(routeAliasCaseProblem("example-agent", ["example-agent"], "x"), undefined);
  assert.equal(routeAliasCaseProblem("other-agent", ["example-agent"], "x"), undefined, "unknown aliases stay a runtime deny (agent_unknown)");
});
