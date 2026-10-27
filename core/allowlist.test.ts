import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, validateRoutes } from "./allowlist.js";
import type { InboundEvent, Route } from "./types.js";

const ev = (over: Partial<InboundEvent> = {}): InboundEvent => ({
  eventId: "e1",
  lane: "l1",
  actor: "u1",
  match: { guild: "g1", channel: "c1" },
  addressed: true,
  prompt: "hi",
  ...over,
});
const route = (over: Partial<Route> = {}): Route => ({
  enabled: true,
  match: { guild: "g1", channel: "c1" },
  allowActors: ["u1"],
  agent: "example-agent",
  ...over,
});

test("deny by default: no routes at all", () => {
  assert.deepEqual(authorize(undefined, ev()), { ok: false, reason: "no_route" });
  assert.deepEqual(authorize([], ev()), { ok: false, reason: "no_route" });
});

test("deny: no row matches the event's fields", () => {
  assert.equal(authorize([route({ match: { guild: "g1", channel: "other" } })], ev()).ok, false);
});

test("deny: an empty match never matches everything", () => {
  const r = authorize([route({ match: {} })], ev());
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "no_route");
});

test("deny: empty allowActors means nobody", () => {
  const r = authorize([route({ allowActors: [] })], ev());
  assert.equal(!r.ok && r.reason, "actor_not_allowlisted");
});

test("deny: actor not listed", () => {
  const r = authorize([route()], ev({ actor: "u2" }));
  assert.equal(!r.ok && r.reason, "actor_not_allowlisted");
});

test("deny: first matching row disabled wins over a later enabled row", () => {
  const r = authorize([route({ enabled: false }), route()], ev());
  assert.equal(!r.ok && r.reason, "route_disabled");
});

test("deny: groups required and actor has none of them", () => {
  const r = authorize([route({ allowGroups: ["r1"] })], ev({ actorGroups: ["r2"] }));
  assert.equal(!r.ok && r.reason, "group_not_allowlisted");
});

test("deny: requireAddressed and not addressed", () => {
  const r = authorize([route({ requireAddressed: true })], ev({ addressed: false }));
  assert.equal(!r.ok && r.reason, "not_addressed");
});

test("allow: exact match, listed actor, group overlap", () => {
  const r = authorize([route({ allowGroups: ["r1"], requireAddressed: true })], ev({ actorGroups: ["r1", "r9"] }));
  assert.equal(r.ok, true);
});

test("allow: '*' actor wildcard only when written explicitly", () => {
  assert.equal(authorize([route({ allowActors: ["*"] })], ev({ actor: "anyone" })).ok, true);
});

test("validateRoutes flags missing fields", () => {
  const p = validateRoutes([{ enabled: "yes", match: {}, agent: "" }], "x");
  assert.equal(p.length, 4);
  assert.deepEqual(validateRoutes("nope", "x"), ["x: routes must be an array"]);
});
