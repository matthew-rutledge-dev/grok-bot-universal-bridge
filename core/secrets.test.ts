import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filePermissionWarning, isPlaceholderSecret, isSecretRef, requireSecret, resolveSecret } from "./secrets.js";
import { tmp } from "../test/helpers.js";

test("env: and file: references resolve", () => {
  const dir = tmp();
  const f = join(dir, "k");
  writeFileSync(f, "from-file\nignored\n");
  assert.equal(resolveSecret("env:A", { A: " v1 " }), "v1");
  assert.equal(resolveSecret(`file:${f}`), "from-file");
  assert.equal(resolveSecret("file:/nope/missing"), undefined);
});

test("literal values are refused", () => {
  assert.throws(() => resolveSecret("sk-literal-value"), /env:NAME or file:/);
});

test("placeholders count as missing", () => {
  for (const v of ["", "changeme", "${X}", "<token>", "placeholder"]) assert.equal(isPlaceholderSecret(v), true);
  assert.equal(resolveSecret("env:A", { A: "changeme" }), undefined);
});

test("requireSecret names the reference, never a value", () => {
  assert.throws(() => requireSecret("env:MISSING_ONE", "discord token", {}), (e: Error) => {
    assert.match(e.message, /discord token: secret missing or placeholder \(env:MISSING_ONE\)/);
    return true;
  });
});

test("file permission warning on group/world readable files (POSIX)", { skip: process.platform === "win32" }, () => {
  const f = join(tmp(), "registry.json");
  writeFileSync(f, "{}");
  chmodSync(f, 0o644);
  assert.match(filePermissionWarning(f) ?? "", /expected 600/);
  chmodSync(f, 0o600);
  assert.equal(filePermissionWarning(f), undefined);
});

test("file: references must be absolute", () => {
  assert.equal(isSecretRef("file:relative/key"), false);
  assert.throws(() => resolveSecret("file:./key"), /absolute/);
  assert.equal(isSecretRef(`file:${join(tmp(), "k")}`), true);
});
