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
    assert.match(r.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(seen, raw, "byte-exact, not re-serialised");
    const j = await fetch(`http://127.0.0.1:${port}/json`, { method: "POST", body: "{}" });
    assert.equal(await j.text(), '"still-json"', "no content-type override keeps JSON encoding");
  } finally {
    await http.close();
  }
});
