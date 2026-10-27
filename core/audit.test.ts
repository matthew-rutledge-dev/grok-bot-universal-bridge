import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditLine, JsonlAudit } from "./audit.js";
import { tmp } from "../test/helpers.js";

test("audit masks ids and drops anything outside the allow list", () => {
  const line = auditLine({
    adapter: "discord",
    action: "inbound",
    outcome: "allow",
    eventId: "discord:555555555555555555",
    actor: "333333333333333333",
    lane: "222222222222222222",
    agent: "example-agent",
    // @ts-expect-error not an audit field: must be dropped
    prompt: "secret message text",
    token: "k1",
  });
  assert.equal(line.actor, "…3333");
  assert.equal(line.eventId, "…5555");
  assert.equal(line.agent, "example-agent");
  assert.equal("prompt" in line, false);
  assert.equal("token" in line, false);
  assert.match(String(line.ts), /^\d{4}-\d\d-\d\dT/);
});

test("JSONL audit appends one line per entry", () => {
  const p = join(tmp(), "a", "audit.jsonl");
  const a = new JsonlAudit(p);
  a.write({ adapter: "x", action: "callback", outcome: "deny", reason: "bad_token", status: 401 });
  a.write({ adapter: "x", action: "callback", outcome: "ok", status: 200 });
  const lines = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].reason, "bad_token");
});
