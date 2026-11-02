import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { MemoryAudit } from "./audit.js";
import { BACKUP_INCOMING_DIR, backupNameProblem, registerBackupRoute } from "./backup.js";
import { HttpServer } from "./http.js";
import { Registry } from "./registry.js";
import { silentLogger, type Logger } from "./types.js";
import { tmp } from "../test/helpers.js";

const KEY = "test-upload-key-not-a-secret-000000"; // >= 32 chars
const DAY = "2026-01-02";
const registry = Registry.fromObject(JSON.parse(readFileSync("config/registry.example.json", "utf8")), {});

async function server(opts: { env?: Record<string, string>; maxBytes?: number; log?: Logger; root?: string } = {}) {
  const root = opts.root ?? tmp("ubridge-backup-");
  const audit = new MemoryAudit();
  const http = new HttpServer(silentLogger);
  registerBackupRoute(http, {
    registry,
    audit,
    env: opts.env ?? { BRIDGE_BACKUP_UPLOAD_KEY: KEY },
    log: opts.log ?? silentLogger,
    root,
    maxBytes: opts.maxBytes,
    now: () => new Date(`${DAY}T23:59:00Z`),
  });
  const port = await http.listen("127.0.0.1", 0);
  return { root, audit, http, port };
}

/** Raw POST: chunked (no content-length) unless `length` is given; `chunks` are written in order. */
function post(
  port: number,
  query: string,
  chunks: Buffer[],
  o: { auth?: string; length?: number; abortAfterFirst?: boolean } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/octet-stream" };
    if (o.auth !== undefined) headers.authorization = o.auth;
    if (o.length !== undefined) headers["content-length"] = String(o.length);
    const req = request({ host: "127.0.0.1", port, method: "POST", path: `/backup/upload?${query}`, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined }));
    });
    req.on("error", reject);
    if (o.abortAfterFirst) {
      req.write(chunks[0], () => setTimeout(() => req.destroy(), 50));
      return;
    }
    for (const c of chunks) req.write(c);
    req.end();
  });
}

const auth = `Bearer ${KEY}`;
const incomingOf = (root: string) => join(root, "example-agent", BACKUP_INCOMING_DIR);
const leftovers = (root: string) => (existsSync(incomingOf(root)) ? readdirSync(incomingOf(root)) : []);

test("backup names: only [A-Za-z0-9._-]{1,128}, never . or ..", () => {
  for (const ok of ["db.sqlite.gz", "a", "A-b_c.1", "x".repeat(128), "...", ".hidden"]) assert.equal(backupNameProblem(ok), null, ok);
  for (const bad of [null, "", ".", "..", "a/b", "a\\b", "../x", "x".repeat(129), "a b", "a%2Fb", "ä"]) assert.notEqual(backupNameProblem(bad), null, String(bad));
  for (const reserved of ["CON", "con", "PRN.txt", "aux.tar.gz", "Nul", "nul.", "COM1", "com9.bak", "LPT1", "lpt9.x"]) {
    assert.equal(backupNameProblem(reserved), "name_reserved", reserved);
  }
  for (const fine of ["COM0", "LPT10", "console.log", "nullable", "con-1", "auxiliary.txt", "com1x"]) assert.equal(backupNameProblem(fine), null, fine);
});

test("env unset, empty or shorter than 32 chars: 404 like an unknown path, nothing written; a short key warns at startup without its value", async () => {
  const short = "k".repeat(31);
  for (const env of [{}, { BRIDGE_BACKUP_UPLOAD_KEY: "" }, { BRIDGE_BACKUP_UPLOAD_KEY: "  " }, { BRIDGE_BACKUP_UPLOAD_KEY: short }, { BRIDGE_BACKUP_UPLOAD_KEY: ` ${short} ` }]) {
    const warnings: string[] = [];
    const log: Logger = { ...silentLogger, warn: (m: string) => warnings.push(m) };
    const s = await server({ env, log });
    try {
      const r = await post(s.port, "bot=example-agent&name=a.bin", [Buffer.from("x")], { auth: `Bearer ${env.BRIDGE_BACKUP_UPLOAD_KEY ?? ""}` });
      assert.equal(warnings.length, env.BRIDGE_BACKUP_UPLOAD_KEY?.trim() ? 1 : 0);
      assert.match(warnings[0] ?? "shorter than 32", /shorter than 32/);
      assert.equal(warnings.join("").includes(short), false);
      assert.deepEqual(s.audit.lines, []);
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, { ok: false, error: "not_found" });
      assert.deepEqual(readdirSync(s.root), []);
    } finally {
      await s.http.close();
    }
  }
});

test("auth: missing key 401, wrong key 403, ?token= refused; audit has no key and nothing is written", async () => {
  const s = await server();
  try {
    assert.equal((await post(s.port, "bot=example-agent&name=a.bin", [Buffer.from("x")])).status, 401);
    assert.equal((await post(s.port, "bot=example-agent&name=a.bin", [Buffer.from("x")], { auth: "Basic abc" })).status, 401);
    assert.equal((await post(s.port, "bot=example-agent&name=a.bin", [Buffer.from("x")], { auth: "Bearer wrong" })).status, 403);
    assert.equal((await post(s.port, "bot=example-agent&name=a.bin", [Buffer.from("x")], { auth: `Bearer ${KEY}x` })).status, 403);
    assert.equal((await post(s.port, `bot=example-agent&name=a.bin&token=${KEY}`, [Buffer.from("x")], { auth })).status, 400);
    assert.deepEqual(readdirSync(s.root), []);
    assert.deepEqual(
      s.audit.lines.map((l) => [l.adapter, l.action, l.outcome, l.reason, l.status]),
      [
        ["backup", "upload", "auth_fail", "missing_key", 401],
        ["backup", "upload", "auth_fail", "missing_key", 401],
        ["backup", "upload", "auth_fail", "bad_key", 403],
        ["backup", "upload", "auth_fail", "bad_key", 403],
        ["backup", "upload", "bad_request", "query_token_refused", 400],
      ],
    );
    assert.equal(JSON.stringify(s.audit.lines).includes(KEY), false);
  } finally {
    await s.http.close();
  }
});

test("path traversal and bad aliases: 400, nothing written outside (or inside) the root", async () => {
  const s = await server();
  try {
    const bad = [
      "bot=example-agent&name=..%2Fescape",
      "bot=example-agent&name=a%2Fb",
      "bot=example-agent&name=..",
      "bot=example-agent&name=.",
      "bot=example-agent&name=",
      "bot=example-agent",
      "bot=example-agent&name=a%5Cb",
      "bot=example-agent&name=%2Fetc%2Fpasswd",
      "bot=example-agent&name=CON",
      "bot=example-agent&name=nul.txt",
      "bot=example-agent&name=com1.tar.gz",
      "bot=..&name=a.bin",
      "bot=..%2F..&name=a.bin",
      "bot=unknown-agent&name=a.bin",
      "bot=Example-Agent&name=a.bin",
      "bot=__proto__&name=a.bin",
      "bot=&name=a.bin",
      "name=a.bin",
    ];
    for (const q of bad) {
      const r = await post(s.port, q, [Buffer.from("x")], { auth });
      assert.equal(r.status, 400, q);
    }
    assert.deepEqual(readdirSync(s.root), []);
    assert.ok(s.audit.lines.every((l) => l.outcome === "bad_request"));
  } finally {
    await s.http.close();
  }
});

test("success: 201 {path, bytes, sha256} matching the stored bytes (streamed, chunked and with content-length)", async () => {
  const s = await server();
  try {
    const parts = [randomBytes(70_000), randomBytes(1), randomBytes(200_000)];
    const all = Buffer.concat(parts);
    const sha = createHash("sha256").update(all).digest("hex");
    const r = await post(s.port, "bot=example-agent&name=db.sqlite.gz", parts, { auth });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { path: `example-agent/${DAY}/db.sqlite.gz`, bytes: all.length, sha256: sha });
    assert.deepEqual(leftovers(s.root), [], "temp file unlinked after publish");
    const stored = readFileSync(join(s.root, "example-agent", DAY, "db.sqlite.gz"));
    assert.equal(createHash("sha256").update(stored).digest("hex"), sha);

    const small = Buffer.from("hello");
    const r2 = await post(s.port, "bot=example-gateway-agent&name=notes.txt", [small], { auth, length: small.length });
    assert.equal(r2.status, 201);
    assert.equal(r2.body.bytes, 5);
    assert.equal(r2.body.sha256, createHash("sha256").update(small).digest("hex"));

    const empty = await post(s.port, "bot=example-agent&name=empty.bin", [], { auth, length: 0 });
    assert.equal(empty.status, 201);
    assert.equal(empty.body.bytes, 0);

    const ok = s.audit.lines.filter((l) => l.outcome === "ok");
    assert.equal(ok.length, 3);
    assert.deepEqual(
      { agent: ok[0].agent, name: ok[0].name, bytes: ok[0].bytes, sha256: ok[0].sha256, status: ok[0].status },
      { agent: "example-agent", name: "db.sqlite.gz", bytes: all.length, sha256: sha, status: 201 },
    );
  } finally {
    await s.http.close();
  }
});

test("duplicate name on the same day: 409 and the first file is untouched", async () => {
  const s = await server();
  try {
    assert.equal((await post(s.port, "bot=example-agent&name=a.bin", [Buffer.from("first")], { auth })).status, 201);
    const r = await post(s.port, "bot=example-agent&name=a.bin", [Buffer.from("second, longer")], { auth });
    assert.equal(r.status, 409);
    assert.equal(readFileSync(join(s.root, "example-agent", DAY, "a.bin"), "utf8"), "first");
    assert.equal(s.audit.lines.at(-1)?.outcome, "conflict");
  } finally {
    await s.http.close();
  }
});

test("oversize: 413 by content-length (nothing opened) and while streaming (partial file removed); server keeps serving", async () => {
  const s = await server({ maxBytes: 1024 });
  try {
    const big = randomBytes(5000);
    const byLength = await post(s.port, "bot=example-agent&name=big1.bin", [big], { auth, length: big.length });
    assert.equal(byLength.status, 413);
    const streamed = await post(s.port, "bot=example-agent&name=big2.bin", [big.subarray(0, 1000), big.subarray(1000)], { auth });
    assert.equal(streamed.status, 413);
    assert.equal(existsSync(join(s.root, "example-agent", DAY, "big1.bin")), false);
    assert.equal(existsSync(join(s.root, "example-agent", DAY, "big2.bin")), false);
    assert.deepEqual(leftovers(s.root), []);
    assert.deepEqual(
      s.audit.lines.map((l) => [l.outcome, l.reason, l.status]),
      [
        ["too_large", "content_length", 413],
        ["too_large", "streamed", 413],
      ],
    );
    // Exactly at the cap is fine.
    const r = await post(s.port, "bot=example-agent&name=edge.bin", [big.subarray(0, 1024)], { auth });
    assert.equal(r.status, 201);
    assert.equal(r.body.bytes, 1024);
  } finally {
    await s.http.close();
  }
});

test("client abort mid-upload: partial file removed, audited as error, same name can be retried", async () => {
  const s = await server();
  try {
    await post(s.port, "bot=example-agent&name=cut.bin", [randomBytes(4096)], { auth, length: 100_000, abortAfterFirst: true }).catch(() => undefined);
    const file = join(s.root, "example-agent", DAY, "cut.bin");
    const end = Date.now() + 3000;
    while (Date.now() < end && !s.audit.lines.some((l) => l.outcome === "error")) await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.audit.lines.at(-1)?.outcome, "error");
    assert.equal(existsSync(file), false);
    assert.deepEqual(leftovers(s.root), []);
    const retry = await post(s.port, "bot=example-agent&name=cut.bin", [Buffer.from("ok")], { auth });
    assert.equal(retry.status, 201);
  } finally {
    await s.http.close();
  }
});

test("in flight: only a .part under .incoming exists, never the final name; a killed upload's stray .part does not block a retry", async () => {
  const root = tmp("ubridge-backup-");
  const s = await server({ root });
  const file = join(root, "example-agent", DAY, "killed.bin");
  try {
    // Hold an upload open mid-body: the final name must not exist yet.
    const pending = new Promise<void>((resolve) => {
      const req = request(
        { host: "127.0.0.1", port: s.port, method: "POST", path: "/backup/upload?bot=example-agent&name=killed.bin", headers: { authorization: auth, "content-length": "100000" } },
        () => undefined,
      );
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.write(randomBytes(4096), async () => {
        const end = Date.now() + 3000;
        while (Date.now() < end && leftovers(root).length === 0) await new Promise((r) => setTimeout(r, 10));
        assert.equal(leftovers(root).length, 1);
        assert.match(leftovers(root)[0], /^[0-9a-f]{24}\.part$/);
        assert.equal(existsSync(file), false, "no file under the real name while streaming");
        req.destroy();
      });
    });
    await pending;
    // Simulate a process kill: a stray .part the cleanup never got to.
    writeFileSync(join(incomingOf(root), "0123456789abcdef01234567.part"), "truncated");
    const end = Date.now() + 3000;
    while (Date.now() < end && !s.audit.lines.some((l) => l.outcome === "error")) await new Promise((r) => setTimeout(r, 20));
    assert.equal(existsSync(file), false);
    const retry = await post(s.port, "bot=example-agent&name=killed.bin", [Buffer.from("complete")], { auth });
    assert.equal(retry.status, 201);
    assert.equal(readFileSync(file, "utf8"), "complete");
    // A name that looks like the temp dir is just a normal file in the date folder.
    const lookalike = await post(s.port, `bot=example-agent&name=${BACKUP_INCOMING_DIR}`, [Buffer.from("x")], { auth });
    assert.equal(lookalike.status, 201);
    assert.equal(lookalike.body.path, `example-agent/${DAY}/${BACKUP_INCOMING_DIR}`);
  } finally {
    await s.http.close();
  }
});

test("a symlinked alias or date directory is refused (500, nothing written through it)", async (t) => {
  const outside = tmp("ubridge-backup-outside-");
  for (const which of ["alias", "date"] as const) {
    const root = tmp("ubridge-backup-");
    try {
      if (which === "alias") symlinkSync(outside, join(root, "example-agent"), "junction");
      else {
        mkdirSync(join(root, "example-agent"), { recursive: true });
        symlinkSync(outside, join(root, "example-agent", DAY), "junction");
      }
    } catch {
      t.skip("cannot create a directory link here");
      return;
    }
    const s = await server({ root });
    try {
      const r = await post(s.port, "bot=example-agent&name=a.bin", [Buffer.from("x")], { auth });
      assert.equal(r.status, 500, which);
      assert.deepEqual(readdirSync(outside), [], which);
      assert.equal(s.audit.lines.at(-1)?.reason, "symlink_dir");
    } finally {
      await s.http.close();
    }
  }
});

test("two concurrent uploads of the same name: exactly one 201, the other 409 (link() keeps O_EXCL semantics), no temp left", async () => {
  const s = await server();
  try {
    const a = Buffer.alloc(300_000, 1);
    const b = Buffer.alloc(300_000, 2);
    const rs = await Promise.all([
      post(s.port, "bot=example-agent&name=race.bin", [a.subarray(0, 1000), a.subarray(1000)], { auth }),
      post(s.port, "bot=example-agent&name=race.bin", [b.subarray(0, 1000), b.subarray(1000)], { auth }),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    const winner = rs.find((r) => r.status === 201)!;
    const stored = readFileSync(join(s.root, "example-agent", DAY, "race.bin"));
    assert.equal(createHash("sha256").update(stored).digest("hex"), winner.body.sha256);
    assert.deepEqual(leftovers(s.root), []);
  } finally {
    await s.http.close();
  }
});
