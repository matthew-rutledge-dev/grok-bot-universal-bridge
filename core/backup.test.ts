import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { link, open, type FileHandle } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { MemoryAudit } from "./audit.js";
import { BACKUP_INCOMING_DIR, backupNameProblem, DEFAULT_BACKUP_MIN_FREE_BYTES, parseMinFree, registerBackupRoute, type BackupFsOps } from "./backup.js";
import { HttpServer } from "./http.js";
import { Registry } from "./registry.js";
import { silentLogger, type Logger } from "./types.js";
import { tmp } from "../test/helpers.js";

const KEY = "test-upload-key-not-a-secret-000000"; // >= 32 chars
const DAY = "2026-01-02";
const registry = Registry.fromObject(JSON.parse(readFileSync("config/registry.example.json", "utf8")), {});

const TIB = 1024 ** 4;
const GIB = 1024 ** 3;

async function server(
  opts: { env?: Record<string, string>; maxBytes?: number; log?: Logger; root?: string; fsOps?: Partial<BackupFsOps>; spaceRecheckBytes?: number } = {},
) {
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
    // Fake a roomy disk unless a test says otherwise (the runner's real free space varies).
    fsOps: { freeBytes: async () => TIB, ...(opts.fsOps ?? {}) },
    spaceRecheckBytes: opts.spaceRecheckBytes,
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

test("BACKUP_MIN_FREE_BYTES: default 5 GiB, 0 disables, junk warns (without the value mattering) and falls back to the default", async () => {
  assert.equal(DEFAULT_BACKUP_MIN_FREE_BYTES, 5 * GIB);
  assert.equal(parseMinFree(undefined), 5 * GIB);
  assert.equal(parseMinFree(" "), 5 * GIB);
  assert.equal(parseMinFree("0"), 0);
  assert.equal(parseMinFree("1073741824"), GIB);
  for (const bad of ["abc", "-1", "1.5", "5GiB", "1e9", "99999999999999999999"]) assert.equal(parseMinFree(bad), undefined, bad);
  const warnings: string[] = [];
  const s = await server({
    env: { BRIDGE_BACKUP_UPLOAD_KEY: KEY, BACKUP_MIN_FREE_BYTES: "lots" },
    log: { ...silentLogger, warn: (m: string) => warnings.push(m) },
    fsOps: { freeBytes: async () => 5 * GIB + 10 },
  });
  try {
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /BACKUP_MIN_FREE_BYTES/);
    // Default reserve applied: 5 GiB + 10 free, 11 bytes declared -> refused.
    const r = await post(s.port, "bot=example-agent&name=a.bin", [Buffer.alloc(11)], { auth, length: 11 });
    assert.equal(r.status, 507);
  } finally {
    await s.http.close();
  }
});

test("low space: 507 insufficient_storage before anything is written; the cap counts when Content-Length is absent; reserve 0 skips statfs", async () => {
  const reserve = 1000;
  let calls = 0;
  const s = await server({
    env: { BRIDGE_BACKUP_UPLOAD_KEY: KEY, BACKUP_MIN_FREE_BYTES: String(reserve) },
    maxBytes: 4096,
    fsOps: {
      freeBytes: async () => {
        calls++;
        return reserve + 2000;
      },
    },
  });
  try {
    const tooBig = await post(s.port, "bot=example-agent&name=a.bin", [Buffer.alloc(2001)], { auth, length: 2001 });
    assert.equal(tooBig.status, 507);
    assert.deepEqual(tooBig.body, { ok: false, error: "insufficient_storage" });
    // Chunked: the 4096-byte cap is assumed, so even a tiny body is refused.
    const chunked = await post(s.port, "bot=example-agent&name=b.bin", [Buffer.alloc(10)], { auth });
    assert.equal(chunked.status, 507);
    assert.deepEqual(readdirSync(s.root), [], "nothing created under the root");
    assert.deepEqual(
      s.audit.lines.map((l) => [l.outcome, l.reason, l.status]),
      [
        ["no_space", "below_reserve", 507],
        ["no_space", "below_reserve", 507],
      ],
    );
    // Fits exactly: free - declared == reserve.
    const fits = await post(s.port, "bot=example-agent&name=c.bin", [Buffer.alloc(2000)], { auth, length: 2000 });
    assert.equal(fits.status, 201);
    assert.equal(calls, 3);
  } finally {
    await s.http.close();
  }
  const off = await server({
    env: { BRIDGE_BACKUP_UPLOAD_KEY: KEY, BACKUP_MIN_FREE_BYTES: "0" },
    fsOps: {
      freeBytes: async () => {
        throw new Error("statfs must not be called");
      },
    },
  });
  try {
    assert.equal((await post(off.port, "bot=example-agent&name=a.bin", [Buffer.from("x")], { auth })).status, 201);
  } finally {
    await off.http.close();
  }
});

test("space re-checked while streaming: dropping below the reserve mid-upload gives 507, temp removed, no final file", async () => {
  let calls = 0;
  const s = await server({
    env: { BRIDGE_BACKUP_UPLOAD_KEY: KEY, BACKUP_MIN_FREE_BYTES: "1000" },
    spaceRecheckBytes: 1024,
    fsOps: { freeBytes: async () => (++calls === 1 ? TIB : 999) },
  });
  try {
    const r = await post(s.port, "bot=example-agent&name=grow.bin", [randomBytes(800), randomBytes(800), randomBytes(800)], { auth });
    assert.equal(r.status, 507);
    assert.equal(existsSync(join(s.root, "example-agent", DAY, "grow.bin")), false);
    assert.deepEqual(leftovers(s.root), []);
    assert.equal(s.audit.lines.at(-1)?.reason, "below_reserve_streaming");
  } finally {
    await s.http.close();
  }
});

test("ENOSPC mid-stream: 507, empty .incoming, no final file, and the server keeps serving", async () => {
  let writes = 0;
  let full = true;
  const s = await server({
    fsOps: {
      write: async (fh, buf, offset, length) => {
        if (full && ++writes > 1) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        return (await fh.write(buf, offset, length)).bytesWritten;
      },
    },
  });
  try {
    const r = await post(s.port, "bot=example-agent&name=full.bin", [randomBytes(70_000), randomBytes(70_000), randomBytes(70_000)], { auth });
    assert.equal(r.status, 507);
    assert.deepEqual(r.body, { ok: false, error: "insufficient_storage" });
    assert.equal(existsSync(join(s.root, "example-agent", DAY, "full.bin")), false);
    assert.deepEqual(leftovers(s.root), []);
    assert.deepEqual([s.audit.lines.at(-1)?.outcome, s.audit.lines.at(-1)?.reason], ["no_space", "ENOSPC"]);
    full = false;
    assert.equal((await post(s.port, "bot=example-agent&name=full.bin", [Buffer.from("fits now")], { auth })).status, 201);
  } finally {
    await s.http.close();
  }
});

test("no hard links (link fails EPERM/ENOTSUP/EXDEV/ENOSYS/EOPNOTSUPP): exclusive copy publishes the file; a name that appears meanwhile still gives 409", async () => {
  for (const code of ["EPERM", "ENOTSUP", "EXDEV", "ENOSYS", "EOPNOTSUPP"]) {
    let racer = false;
    const s = await server({
      fsOps: {
        link: async (_temp, final) => {
          // Simulate another upload winning the name between the early check and the publish.
          if (racer && final.includes(DAY)) writeFileSync(final, "someone else");
          throw Object.assign(new Error("hard links unsupported"), { code });
        },
      },
    });
    try {
      const body = randomBytes(100_000);
      const r = await post(s.port, "bot=example-agent&name=copy.bin", [body], { auth });
      assert.equal(r.status, 201, code);
      const stored = readFileSync(join(s.root, "example-agent", DAY, "copy.bin"));
      assert.equal(createHash("sha256").update(stored).digest("hex"), r.body.sha256);
      assert.equal(r.body.sha256, createHash("sha256").update(body).digest("hex"));
      assert.deepEqual(leftovers(s.root), []);

      racer = true;
      const dup = await post(s.port, "bot=example-agent&name=raced.bin", [Buffer.from("mine")], { auth });
      assert.equal(dup.status, 409, code);
      assert.equal(readFileSync(join(s.root, "example-agent", DAY, "raced.bin"), "utf8"), "someone else", "never overwritten");
      assert.deepEqual(leftovers(s.root), []);
    } finally {
      await s.http.close();
    }
  }
});

test("any other link error is a 500 (no copy fallback), temp removed", async () => {
  const s = await server({
    fsOps: {
      link: async () => {
        throw Object.assign(new Error("io"), { code: "EIO" });
      },
      openExcl: async (path) => {
        if (path.includes(DAY)) throw new Error("copy must not be tried");
        return open(path, "wx");
      },
    },
  });
  try {
    const r = await post(s.port, "bot=example-agent&name=a.bin", [Buffer.from("x")], { auth });
    assert.equal(r.status, 500);
    assert.equal(s.audit.lines.at(-1)?.reason, "EIO");
    assert.equal(existsSync(join(s.root, "example-agent", DAY, "a.bin")), false);
    assert.deepEqual(leftovers(s.root), []);
  } finally {
    await s.http.close();
  }
});

const noLink: Partial<BackupFsOps> = {
  link: async () => {
    throw Object.assign(new Error("hard links unsupported"), { code: "EPERM" });
  },
};

test("copy mode fsyncs the copied final file (and the temp file) before answering 201", async () => {
  const synced: string[] = [];
  const s = await server({
    fsOps: {
      ...noLink,
      sync: async (fh, path) => {
        synced.push(path);
        await fh.sync();
      },
    },
  });
  try {
    const r = await post(s.port, "bot=example-agent&name=synced.bin", [randomBytes(3 * 1024 * 1024)], { auth });
    assert.equal(r.status, 201);
    const final = join(s.root, "example-agent", DAY, "synced.bin");
    assert.equal(synced.length, 2);
    assert.match(synced[0], /\.part$/);
    assert.equal(synced[1], final);
    assert.equal(createHash("sha256").update(readFileSync(final)).digest("hex"), r.body.sha256);
  } finally {
    await s.http.close();
  }
});

test("copy mode, concurrent publish of one name: one 201, one 409, and the winner's file is never deleted", async () => {
  const s = await server({ fsOps: noLink });
  try {
    const a = Buffer.alloc(2 * 1024 * 1024, 1);
    const b = Buffer.alloc(2 * 1024 * 1024, 2);
    const rs = await Promise.all([
      post(s.port, "bot=example-agent&name=race.bin", [a.subarray(0, 1000), a.subarray(1000)], { auth }),
      post(s.port, "bot=example-agent&name=race.bin", [b.subarray(0, 1000), b.subarray(1000)], { auth }),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    const winner = rs.find((r) => r.status === 201)!;
    const stored = readFileSync(join(s.root, "example-agent", DAY, "race.bin"));
    assert.equal(stored.length, a.length);
    assert.equal(createHash("sha256").update(stored).digest("hex"), winner.body.sha256);
    assert.deepEqual(leftovers(s.root), []);
  } finally {
    await s.http.close();
  }
});

test("copy mode: a create error that is not EEXIST (e.g. EACCES) never deletes a file another request published", async () => {
  const s = await server({
    fsOps: {
      ...noLink,
      openExcl: async (path) => {
        if (!path.includes(DAY)) return open(path, "wx");
        // Another request publishes the name, then our create fails for an unrelated reason.
        writeFileSync(path, "published by someone else");
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    },
  });
  try {
    const r = await post(s.port, "bot=example-agent&name=theirs.bin", [Buffer.from("mine")], { auth });
    assert.equal(r.status, 500);
    assert.equal(readFileSync(join(s.root, "example-agent", DAY, "theirs.bin"), "utf8"), "published by someone else");
    assert.deepEqual(leftovers(s.root), []);
  } finally {
    await s.http.close();
  }
});

test("copy mode: ENOSPC while copying removes the final file this request created and answers 507", async () => {
  let ours: FileHandle | undefined;
  const s = await server({
    fsOps: {
      ...noLink,
      openExcl: async (path) => {
        const fh = await open(path, "wx");
        if (path.includes(DAY)) ours = fh;
        return fh;
      },
      write: async (fh, buf, offset, length) => {
        if (fh === ours) throw Object.assign(new Error("full"), { code: "ENOSPC" });
        return (await fh.write(buf, offset, length)).bytesWritten;
      },
    },
  });
  try {
    const r = await post(s.port, "bot=example-agent&name=copyfull.bin", [randomBytes(10_000)], { auth });
    assert.equal(r.status, 507);
    assert.equal(existsSync(join(s.root, "example-agent", DAY, "copyfull.bin")), false);
    assert.deepEqual(leftovers(s.root), []);
  } finally {
    await s.http.close();
  }
});

test("ENOSPC/EDQUOT creating the temp file: 507 no_space, not 500", async () => {
  for (const code of ["ENOSPC", "EDQUOT"]) {
    const s = await server({
      fsOps: {
        openExcl: async () => {
          throw Object.assign(new Error("full"), { code });
        },
      },
    });
    try {
      const r = await post(s.port, "bot=example-agent&name=a.bin", [Buffer.from("x")], { auth });
      assert.equal(r.status, 507, code);
      assert.deepEqual([s.audit.lines.at(-1)?.outcome, s.audit.lines.at(-1)?.reason], ["no_space", code]);
    } finally {
      await s.http.close();
    }
  }
});

test("statfs failing fails closed: 500 with a warning, before writing or mid-stream, nothing left behind", async () => {
  const warnings: string[] = [];
  const log: Logger = { ...silentLogger, warn: (m: string) => warnings.push(m) };
  const before = await server({
    log,
    fsOps: {
      freeBytes: async () => {
        throw Object.assign(new Error("statfs"), { code: "EIO" });
      },
    },
  });
  try {
    const r = await post(before.port, "bot=example-agent&name=a.bin", [Buffer.from("x")], { auth });
    assert.equal(r.status, 500);
    assert.equal(before.audit.lines.at(-1)?.reason, "statfs_EIO");
    assert.deepEqual(readdirSync(before.root), []);
    assert.ok(warnings.some((w) => /statfs_EIO/.test(w)));
  } finally {
    await before.http.close();
  }
  let calls = 0;
  const mid = await server({
    log,
    spaceRecheckBytes: 1024,
    fsOps: {
      freeBytes: async () => {
        if (++calls === 1) return TIB;
        throw Object.assign(new Error("statfs"), { code: "EIO" });
      },
    },
  });
  try {
    const r = await post(mid.port, "bot=example-agent&name=b.bin", [randomBytes(800), randomBytes(800), randomBytes(800)], { auth });
    assert.equal(r.status, 500);
    assert.equal(mid.audit.lines.at(-1)?.reason, "statfs_EIO");
    assert.equal(existsSync(join(mid.root, "example-agent", DAY, "b.bin")), false);
    assert.deepEqual(leftovers(mid.root), []);
  } finally {
    await mid.http.close();
  }
});

test("publish mode is probed on the first upload and logged once (link, or copy with a warning)", async () => {
  for (const [ops, expect] of [
    [{}, "link"],
    [noLink, "copy"],
  ] as const) {
    const lines: string[] = [];
    const log: Logger = { ...silentLogger, info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
    const s = await server({ log, fsOps: ops });
    try {
      for (const n of ["one.bin", "two.bin"]) assert.equal((await post(s.port, `bot=example-agent&name=${n}`, [Buffer.from(n)], { auth })).status, 201);
      const modeLines = lines.filter((l) => l.includes("publish mode"));
      assert.equal(modeLines.length, 1, expect);
      assert.match(modeLines[0], new RegExp(`publish mode: ${expect}`));
      assert.deepEqual(leftovers(s.root), [], "probe files removed");
    } finally {
      await s.http.close();
    }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send headers and a first chunk of a declared 100 kB body, then disconnect after `ms`. */
function postAndDisconnect(port: number, query: string, ms: number): void {
  const req = request({ host: "127.0.0.1", port, method: "POST", path: `/backup/upload?${query}`, headers: { authorization: auth, "content-length": "100000" } });
  req.on("error", () => undefined);
  req.write(randomBytes(1000));
  setTimeout(() => req.destroy(), ms);
}

async function waitForAudit(audit: MemoryAudit, pred: (l: Record<string, unknown>) => boolean, ms = 2000): Promise<Record<string, unknown>> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = audit.lines.find(pred);
    if (hit) return hit;
    await sleep(10);
  }
  assert.fail(`no matching audit line within ${ms} ms: ${JSON.stringify(audit.lines)}`);
}

test("client disconnects during a slow statfs (setup, before streaming): the handler settles, no fd or .part left, audited as an abort", async () => {
  const handles: FileHandle[] = [];
  const s = await server({
    fsOps: {
      freeBytes: async () => {
        await sleep(300);
        return TIB;
      },
      openExcl: async (path) => {
        const fh = await open(path, "wx");
        handles.push(fh);
        return fh;
      },
    },
  });
  try {
    const t0 = Date.now();
    postAndDisconnect(s.port, "bot=example-agent&name=gone.bin", 100);
    const line = await waitForAudit(s.audit, () => true);
    assert.ok(Date.now() - t0 < 2000);
    assert.deepEqual([line.outcome, line.reason, line.status], ["error", "client_aborted", 499]);
    assert.ok(handles.every((h) => h.fd === -1), "every file handle closed");
    assert.deepEqual(leftovers(s.root), []);
    assert.equal(existsSync(join(s.root, "example-agent", DAY, "gone.bin")), false);
    assert.equal(s.audit.lines.length, 1);
  } finally {
    await s.http.close();
  }
});

test("client disconnects during the publish-mode probe (temp already open): fd closed, .part removed, audited as an abort", async () => {
  const handles: FileHandle[] = [];
  const s = await server({
    fsOps: {
      link: async (a, b) => {
        if (a.endsWith(".probe")) await sleep(300);
        await link(a, b);
      },
      openExcl: async (path) => {
        const fh = await open(path, "wx");
        handles.push(fh);
        return fh;
      },
    },
  });
  try {
    postAndDisconnect(s.port, "bot=example-agent&name=gone2.bin", 100);
    const line = await waitForAudit(s.audit, () => true);
    assert.deepEqual([line.outcome, line.reason], ["error", "client_aborted"]);
    assert.equal(handles.length, 1, "the temp file was opened before the abort was seen");
    assert.equal(handles[0].fd, -1, "and closed");
    assert.deepEqual(leftovers(s.root), [], "no .part and no probe files");
    // The server still works afterwards.
    assert.equal((await post(s.port, "bot=example-agent&name=after.bin", [Buffer.from("ok")], { auth })).status, 201);
  } finally {
    await s.http.close();
  }
});

test("concurrent first uploads share one probe: the mode is probed and logged once", async () => {
  const lines: string[] = [];
  let probeLinks = 0;
  const s = await server({
    log: { ...silentLogger, info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) },
    fsOps: {
      link: async (a, b) => {
        if (a.endsWith(".probe")) {
          probeLinks++;
          await sleep(100);
        }
        await link(a, b);
      },
    },
  });
  try {
    const rs = await Promise.all(["p1.bin", "p2.bin", "p3.bin"].map((n) => post(s.port, `bot=example-agent&name=${n}`, [Buffer.from(n)], { auth })));
    assert.deepEqual(rs.map((r) => r.status), [201, 201, 201]);
    assert.equal(probeLinks, 1);
    assert.equal(lines.filter((l) => l.includes("publish mode")).length, 1);
    assert.deepEqual(leftovers(s.root), []);
  } finally {
    await s.http.close();
  }
});
