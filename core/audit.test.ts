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

test("actorKeep: default 4, 6 keeps six, \"full\" writes a VIN-shaped actor unmasked and anything else as invalid; other ids stay masked", () => {
  const base = { adapter: "tesla", action: "observe" as const, outcome: "ok" as const, eventId: "tesla:555555555555555555", lane: "vehicle:…MPLE" };
  assert.equal(auditLine({ ...base, actor: "5YJ0000000EXAMPLE" }).actor, "…MPLE");
  assert.equal(auditLine({ ...base, actor: "5YJ0000000EXAMPLE", actorKeep: 6 }).actor, "…XAMPLE");
  const full = auditLine({ ...base, actor: "5YJ0000000EXAMPLE", actorKeep: "full" });
  assert.equal(full.actor, "5YJ0000000EXAMPLE");
  assert.equal(full.eventId, "…5555");
  assert.equal(auditLine({ ...base, actor: "5YJ0000000\nEXAMPLE", actorKeep: "full" }).actor, "invalid");
  assert.equal(auditLine({ ...base, actor: "not-a-vin-but-a-long-free-form-string", actorKeep: "full" }).actor, "invalid", "only VIN-shaped actors are written unmasked");
  assert.equal(auditLine({ ...base, actor: "5YJ0000000EXAMPLQ", actorKeep: "full" }).actor, "invalid", "Q is not a VIN character");
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
