import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpServer } from "./http.js";
import { silentLogger } from "./types.js";

test("malformed percent-encoding answers 400 and the server keeps serving (regression)", async () => {
  const http = new HttpServer(silentLogger);
  http.route("GET", "/x/requests/:id", (req) => ({ status: 200, body: { id: req.params.id } }));
  const port = await http.listen("127.0.0.1", 0);
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/x/requests/%E0`);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { ok: false, error: "bad_path_encoding" });
    const good = await fetch(`http://127.0.0.1:${port}/x/requests/a%20b`);
    assert.deepEqual(await good.json(), { id: "a b" });
  } finally {
    await http.close();
  }
});

test("a throwing handler and an unserialisable answer both give 500, not a crash (regression)", async () => {
  const http = new HttpServer(silentLogger);
  http.route("GET", "/boom", () => {
    throw new Error("boom");
  });
  http.route("GET", "/cycle", () => {
    const o: Record<string, unknown> = {};
    o.self = o; // JSON.stringify throws inside .then -> must hit the .catch
    return { status: 200, body: o };
  });
  const port = await http.listen("127.0.0.1", 0);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/boom`)).status, 500);
    assert.equal((await fetch(`http://127.0.0.1:${port}/cycle`)).status, 500);
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404, "still alive");
  } finally {
    await http.close();
  }
});

test("listen refuses an empty bind address (regression)", async () => {
  await assert.rejects(new HttpServer(silentLogger).listen("", 0), /bind address required/);
});

test("handlers get the exact raw body; a text/plain string answer is written unquoted", async () => {
  const http = new HttpServer(silentLogger);
  let seen = "";
  http.route("POST", "/echo", (req) => {
    seen = req.rawBody?.toString("utf8") ?? "";
    return { status: 200, body: "challenge-abc", headers: { "content-type": "text/plain" } };
  });
  http.route("POST", "/json", () => ({ status: 200, body: "still-json" }));
  const port = await http.listen("127.0.0.1", 0);
  try {
    const raw = '{"b": 1,  "a":"x"}';
    const r = await fetch(`http://127.0.0.1:${port}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    assert.equal(await r.text(), "challenge-abc");
    assert.equal(r.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(seen, raw, "byte-exact, not re-serialised");
    const j = await fetch(`http://127.0.0.1:${port}/json`, { method: "POST", body: "{}" });
    assert.equal(await j.text(), '"still-json"', "no content-type override keeps JSON encoding");
  } finally {
    await http.close();
  }
});

test("raw body is byte-exact for multibyte UTF-8 (split across chunks) and for invalid UTF-8 on rawBody routes", async () => {
  const http = new HttpServer(silentLogger);
  const seen: { raw?: Buffer; body?: unknown }[] = [];
  http.route("POST", "/json", (req) => (seen.push({ raw: req.rawBody, body: req.body }), { status: 200, body: { ok: true } }));
  http.route("POST", "/raw", (req) => (seen.push({ raw: req.rawBody, body: req.body }), { status: 200, body: { ok: true } }), { rawBody: true });
  const port = await http.listen("127.0.0.1", 0);
  try {
    const multi = Buffer.from('{"msg":"héllo ✓ 😀 日本"}', "utf8");
    // Send in tiny chunks so multibyte sequences straddle chunk boundaries.
    const { request } = await import("node:http");
    await new Promise<void>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/json", method: "POST", headers: { "content-type": "application/json", "content-length": multi.length } }, (res) => (res.resume(), res.on("end", resolve)));
      r.on("error", reject);
      for (let i = 0; i < multi.length; i += 3) r.write(multi.subarray(i, i + 3));
      r.end();
    });
    assert.ok(seen[0].raw!.equals(multi));
    assert.deepEqual(seen[0].body, { msg: "héllo ✓ 😀 日本" });
    const invalid = Buffer.from([0x7b, 0xff, 0xfe, 0xc3, 0x7d]);
    const r = await fetch(`http://127.0.0.1:${port}/raw`, { method: "POST", body: invalid });
    assert.equal(r.status, 200, "rawBody routes are not JSON-parsed by the core");
    assert.ok(seen[1].raw!.equals(invalid));
    assert.equal(seen[1].body, undefined);
    const j = await fetch(`http://127.0.0.1:${port}/json`, { method: "POST", body: invalid });
    assert.equal(j.status, 400, "normal routes still reject invalid JSON");
  } finally {
    await http.close();
  }
});

test("oversize bodies get a clean 413 (by content-length and by counting a chunked body), not a reset", async () => {
  const http = new HttpServer(silentLogger);
  let calls = 0;
  http.route("POST", "/small", () => (calls++, { status: 200, body: { ok: true } }), { maxBytes: 1024 });
  http.route("POST", "/small-raw", () => (calls++, { status: 200, body: { ok: true } }), { maxBytes: 1024, rawBody: true });
  const port = await http.listen("127.0.0.1", 0);
  try {
    for (const path of ["/small", "/small-raw"]) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: "x".repeat(64 * 1024) });
      assert.equal(r.status, 413, path);
      assert.deepEqual(await r.json(), { ok: false, error: "body_too_large" });
    }
    // Chunked (no content-length): counted while streaming.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/small", method: "POST", headers: { "transfer-encoding": "chunked" } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      r.on("error", reject);
      for (let i = 0; i < 16; i++) r.write("y".repeat(1024));
      r.end();
    });
    assert.equal(status, 413);
    // Exactly at the limit is fine.
    assert.equal((await fetch(`http://127.0.0.1:${port}/small-raw`, { method: "POST", body: "z".repeat(1024) })).status, 200);
    assert.equal(calls, 1, "handlers never see an oversize body");
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404, "server still serving");
  } finally {
    await http.close();
  }
});
