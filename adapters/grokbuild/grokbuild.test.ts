import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GrokBuildAdapter, validateGrokBuildConfig, type GrokBuildConfig } from "./index.js";
import { mockRoutine, startBridge, until } from "../../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as GrokBuildConfig;
const env = { GROKBUILD_CLIENT_TOKEN: "client-token", GROKBUILD_CALLBACK_TOKEN: "cb-grokbuild", OTHER_CLIENT_TOKEN: "other-token" };
const client = { authorization: "Bearer client-token" };
const cfg = (over: Partial<GrokBuildConfig> = {}): GrokBuildConfig => ({
  ...example,
  readOnly: "",
  clients: { ...example.clients, "other-client": { tokenRef: "env:OTHER_CLIENT_TOKEN" } },
  ...over,
});

async function setup(over: Partial<GrokBuildConfig> = {}, script: number[] = []) {
  const m = await mockRoutine({ key: "routine-key", script });
  const adapter = new GrokBuildAdapter(cfg(over));
  const b = await startBridge({ routineUrl: m.url, adapters: [adapter], env });
  return { m, adapter, b, close: async () => (await b.close(), await m.close()) };
}

test("example config validates; route match must be { client, bot }", () => {
  assert.deepEqual(validateGrokBuildConfig(example), []);
  assert.match(validateGrokBuildConfig({ ...example, routes: [{ ...example.routes[0], match: { client: "x" } }] }).join(), /client, bot/);
});

test("prompt -> routine -> agent reply -> client reads it", async () => {
  const s = await setup();
  try {
    const sent = await s.b.call("POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "summarise the diff", requestId: "req-00000001" }, client);
    assert.deepEqual([sent.status, sent.body.state], [202, "delivered"]);
    const hit = s.m.hits[0];
    assert.equal(hit.headers.authorization, "Bearer routine-key");
    assert.equal(hit.headers["x-automation-key"], "routine-key");
    assert.match(hit.body.prompt, /untrusted data/);
    assert.match(hit.body.prompt, /\u27C2 gb:req-00000001 client=example-client reply=https:\/\/bridge\.example\.com\/grokbuild\/callback$/);
    const cb = await s.b.call("POST", "/grokbuild/callback", { requestId: "req-00000001", content: "Done: 3 files changed." }, { authorization: "Bearer cb-grokbuild" });
    assert.equal(cb.status, 200);
    const read = await s.b.call("GET", "/grokbuild/requests/req-00000001", undefined, client);
    assert.equal(read.body.state, "delivered");
    assert.equal(read.body.replies[0].content, "Done: 3 files changed.");
  } finally {
    await s.close();
  }
});

test("auth and allowlist: bad token, unrouted bot, another client's request", async () => {
  const s = await setup();
  try {
    assert.equal((await s.b.call("POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "x" })).status, 401);
    assert.equal((await s.b.call("POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "x" }, { authorization: "Bearer nope" })).status, 401);
    const unrouted = await s.b.call("POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "x" }, { authorization: "Bearer other-token" });
    assert.deepEqual([unrouted.status, unrouted.body.error], [403, "no_route"]);
    await s.b.call("POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "x", requestId: "req-00000002" }, client);
    const peek = await s.b.call("GET", "/grokbuild/requests/req-00000002", undefined, { authorization: "Bearer other-token" });
    assert.equal(peek.status, 404);
    assert.equal((await s.b.call("POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "x", requestId: "req-00000002" }, client)).status, 409);
    assert.equal((await s.b.call("POST", "/grokbuild/callback", { requestId: "nope-0000", content: "x" }, { authorization: "Bearer cb-grokbuild" })).status, 404);
    assert.equal(s.m.hits.length, 1);
  } finally {
    await s.close();
  }
});

test("read-only fails closed: unrecognised value refuses prompts", async () => {
  for (const ro of ["1", "maybe"]) {
    const s = await setup({ readOnly: ro });
    try {
      const r = await s.b.call("POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "x" }, client);
      assert.deepEqual([r.status, r.body.error], [403, "read_only"]);
      assert.equal(s.m.hits.length, 0);
    } finally {
      await s.close();
    }
  }
  const off = await setup({ readOnly: "${GROKBUILD_READ_ONLY}" });
  assert.equal(off.adapter.readOnly, false);
  await off.close();
});

test("held while the routine sleeps; status moves held -> delivered", async () => {
  const s = await setup({}, [530, 502]);
  try {
    const sent = await s.b.call("POST", "/grokbuild/prompt", { bot: "example-agent", prompt: "x", requestId: "req-00000003" }, client);
    assert.equal(sent.body.state, "held");
    await until(() => s.m.hits.length === 3);
    await until(() => s.b.bridge.stateOf("grokbuild:req-00000003") === "delivered");
    const read = await s.b.call("GET", "/grokbuild/requests/req-00000003", undefined, client);
    assert.equal(read.body.state, "delivered");
  } finally {
    await s.close();
  }
});
