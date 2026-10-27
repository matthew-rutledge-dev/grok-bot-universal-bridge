import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateBridgeConfig } from "./config.js";

const example = JSON.parse(readFileSync(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
const withHttp = (http: Record<string, unknown>) => ({ ...example, http: { ...example.http, ...http } });

test("the shipped example is valid", () => {
  assert.deepEqual(validateBridgeConfig(example), []);
});

test("an unset or empty bind is refused (regression: it would listen on every interface)", () => {
  const { bind: _drop, ...noBind } = example.http;
  assert.match(validateBridgeConfig({ ...example, http: noBind }).join(), /http.bind required/);
  assert.match(validateBridgeConfig(withHttp({ bind: " " })).join(), /http.bind required/);
});

test("non-loopback bind needs allowNonLoopbackBind", () => {
  assert.match(validateBridgeConfig(withHttp({ bind: "0.0.0.0" })).join(), /must be loopback/);
  assert.deepEqual(validateBridgeConfig(withHttp({ bind: "0.0.0.0", allowNonLoopbackBind: true })), []);
});
