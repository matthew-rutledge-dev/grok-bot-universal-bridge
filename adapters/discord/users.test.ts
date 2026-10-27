import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserDirectory, USER_DIRECTORY_MAX } from "./users.js";
import { tmp } from "../../test/helpers.js";

const id = (n: number) => `6000000000000${String(n).padStart(5, "0")}`;

test("user directory: bounded LRU (least recently seen dropped), seed labels never evicted, cap survives reload", () => {
  assert.equal(USER_DIRECTORY_MAX, 5000);
  const dir = tmp("ubridge-users-cap-");
  const seed = join(dir, "seed.json");
  writeFileSync(seed, JSON.stringify({ version: 1, users: { [id(0)]: { label: "Seeded Label" } } }));
  const file = join(dir, "dir.json");
  let t = 0;
  const now = () => new Date(1_700_000_000_000 + t++ * 1000);
  const d = new UserDirectory({ file, seedPath: seed, writeDelayMs: 0, max: 3, now });
  d.load();
  for (let i = 1; i <= 3; i++) d.learn({ id: id(i), username: `user-${i}` });
  d.learn({ id: id(1), username: "user-1" }); // touch: 1 is now the most recent
  d.learn({ id: id(4), username: "user-4" });
  assert.equal(d.size(), 3);
  assert.equal(d.get(id(2)), undefined, "least recently seen dropped first");
  assert.ok(d.get(id(1)) && d.get(id(3)) && d.get(id(4)));
  // The seeded user was evicted from the entries but keeps its label when seen again.
  d.learn({ id: id(0), username: "seeded-handle" });
  assert.equal(d.get(id(0))!.label, "Seeded Label");
  d.flush();
  assert.equal(Object.keys(JSON.parse(readFileSync(file, "utf8")).users).length, 3);
  // Reload with a smaller cap keeps the most recently seen.
  const d2 = new UserDirectory({ file, writeDelayMs: 0, max: 2 });
  d2.load();
  assert.deepEqual([d2.get(id(4))?.username, d2.get(id(0))?.username], ["user-4", "seeded-handle"]);
  assert.equal(d2.size(), 2);
});

test("user directory: preview names without storing", () => {
  const d = new UserDirectory({ file: "" });
  const p = d.preview({ id: id(7), username: "handle", displayName: "Shown" }, "fallback");
  assert.deepEqual(p, { who: { un: "handle", dn: "Shown" }, label: "Shown" });
  assert.equal(d.size(), 0);
});
