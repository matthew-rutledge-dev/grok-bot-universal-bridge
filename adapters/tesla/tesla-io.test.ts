import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import forge from "node-forge";
import WebSocket from "ws";
import {
  deriveEnergyTriggers,
  EnergyApiError,
  FleetEnergyClient,
  mapFetchError,
  mapHttpError,
  parseLiveStatus,
  TeslaAdapter,
  unwrap,
  DecodedJsonReceiver,
  type FetchLike,
  type TeslaConfig,
} from "./index.js";
import { mockRoutine, startBridge } from "../../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as TeslaConfig;
const VIN = "5YJ0000000EXAMPLE";
const SITE = "1111111111111111";
const API = "https://fleet-api.example.com";

// ---------- energy ----------

test("grid outage = island_status off_grid* or grid_status Inactive (no /islanded/ regex)", () => {
  const s = (o: object) => ({ siteId: "s", ...o });
  assert.deepEqual(deriveEnergyTriggers(s({ islandStatus: "on_grid" }), s({ islandStatus: "off_grid_unintentional" })), ["grid_islanded"]);
  assert.deepEqual(deriveEnergyTriggers(s({ islandStatus: "on_grid" }), s({ islandStatus: "off_grid_intentional" })), ["grid_islanded"]);
  assert.deepEqual(deriveEnergyTriggers(s({ gridStatus: "Active" }), s({ gridStatus: "Inactive" })), ["grid_islanded"]);
  assert.deepEqual(deriveEnergyTriggers(s({ gridStatus: "Active" }), s({ gridStatus: "Islanded" })), []);
  assert.deepEqual(deriveEnergyTriggers(s({ islandStatus: "off_grid" }), s({ islandStatus: "off_grid_unintentional" })), [], "still out");
  assert.deepEqual(deriveEnergyTriggers(undefined, s({ percentCharged: 22, backupReservePercent: 20 })), ["battery_below_reserve"]);
  assert.deepEqual(deriveEnergyTriggers(undefined, s({ stormModeActive: true })), ["storm_watch"]);
});

test("unwrap / parseLiveStatus tolerate empty and {response:{}}", () => {
  assert.deepEqual(unwrap(undefined), {});
  assert.deepEqual(unwrap({}), {});
  assert.deepEqual(unwrap({ response: {} }), {});
  assert.deepEqual(unwrap({ response: null }), {});
  assert.deepEqual(parseLiveStatus("s", { response: {} }), { siteId: "s" });
  assert.deepEqual(
    parseLiveStatus("s", { response: { grid_status: "Active", island_status: "on_grid", percentage_charged: "55", storm_mode_active: false, backup_reserve_percent: 99 } }),
    { siteId: "s", gridStatus: "Active", islandStatus: "on_grid", percentCharged: 55, stormModeActive: false },
    "backup_reserve_percent is not read from live_status",
  );
});

test("error mapping", () => {
  assert.equal(mapFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })).code, "fleet_api_unreachable");
  assert.equal(mapFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } })).code, "fleet_api_tls_error");
  assert.equal(mapFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } })).code, "fleet_api_tls_error");
  assert.equal(mapHttpError(401, "{}", null).code, "unauthorized");
  assert.equal(mapHttpError(401, '{"error":"login_required"}', null).code, "login_required");
  assert.equal(mapHttpError(403, '{"error":"Unauthorized missing scopes"}', null).code, "missing_scope");
  const rl = mapHttpError(429, "", "120");
  assert.equal(rl.code, "rate_limited");
  assert.equal(rl.retryAfterSec, 120);
  assert.equal(mapHttpError(429, "", null).retryAfterSec, 60);
  assert.equal(mapHttpError(500, "", null).code, "fleet_api_error");
});

interface Call {
  url: string;
  auth: string;
}
/** Scripted fake Fleet API: answer(url) -> status/body/headers or throw. */
function fakeApi(answer: (url: string, n: number) => { status: number; body?: unknown; headers?: Record<string, string> } | Error) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    const a = answer(url, calls.length);
    if (a instanceof Error) throw a;
    const body = a.body === undefined ? "" : typeof a.body === "string" ? a.body : JSON.stringify(a.body);
    return { status: a.status, headers: { get: (h: string) => a.headers?.[h.toLowerCase()] ?? null }, text: async () => body };
  };
  return { f, calls };
}

async function energyRig(answer: Parameters<typeof fakeApi>[0], patch: Partial<NonNullable<TeslaConfig["energy_poll"]>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tesla-energy-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "access-one\n");
  const api = fakeApi(answer);
  let clock = 1_000_000;
  const cfg: TeslaConfig = {
    ...example,
    energy_poll: { ...example.energy_poll!, enabled: true, api_base: API, token_ref: `file:${tokenFile}`, ...patch },
  };
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter(cfg, { fetchImpl: api.f, now: () => clock });
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  return {
    a, b, m, api, tokenFile,
    advance: (s: number) => (clock += s * 1000),
    close: async () => {
      await b.close();
      await m.close();
    },
  };
}

const live = (o: object) => ({ status: 200, body: { response: { grid_status: "Active", island_status: "on_grid", percentage_charged: 80, ...o } } });

test("energy: only energy_sites endpoints; token re-read every poll; site_info cached ~10 min; outage prompt", async () => {
  let island = "on_grid";
  const r = await energyRig((url) => (url.endsWith("/site_info") ? { status: 200, body: { response: { backup_reserve_percent: 20 } } } : live({ island_status: island })));
  try {
    assert.deepEqual(await r.a.tick(), []);
    writeFileSync(r.tokenFile, "access-two\n");
    r.advance(300);
    island = "off_grid_unintentional";
    assert.deepEqual(await r.a.tick(), ["grid_islanded"]);
    assert.match(r.m.hits[0].body.prompt, /grid_islanded \(unintentional outage\) \(priority high\)/);
    assert.equal(r.m.hits[0].body.prompt.includes(SITE), false, "site id masked");
    r.advance(300);
    await r.a.tick();
    r.advance(300);
    await r.a.tick();
    const urls = r.api.calls.map((c) => c.url);
    assert.ok(urls.every((u) => u.startsWith(`${API}/api/1/energy_sites/${SITE}/`)), "energy_sites only");
    assert.equal(urls.some((u) => /vehicles|wake_up|command/.test(u)), false);
    assert.equal(urls.filter((u) => u.endsWith("/site_info")).length, 2, "site_info at t=0 and after the 600 s TTL");
    assert.equal(urls.filter((u) => u.endsWith("/live_status")).length, 4);
    assert.equal(r.api.calls[0].auth, "Bearer access-one");
    assert.equal(r.api.calls.at(-1)!.auth, "Bearer access-two", "file: ref re-read");
  } finally {
    await r.close();
  }
});

test("energy: empty / {response:{}} -> no_data audit, lastEnergy kept (no re-arm)", async () => {
  const script = [live({ island_status: "off_grid_unintentional" }), { status: 200, body: "" }, { status: 200, body: { response: {} } }, live({ island_status: "off_grid_unintentional" })];
  const r = await energyRig((url) => (url.endsWith("/site_info") ? { status: 200, body: {} } : script.shift()!));
  try {
    assert.deepEqual(await r.a.tick(), ["grid_islanded"]);
    for (let i = 0; i < 3; i++) {
      r.advance(300);
      await r.a.tick();
    }
    assert.equal(r.m.hits.length, 1, "gap did not re-arm grid_islanded");
    assert.equal(r.b.audit.lines.filter((l) => l.reason === "no_data").length, 2);
  } finally {
    await r.close();
  }
});

test("energy: 429 skips polls until Retry-After passes", async () => {
  let n = 0;
  const r = await energyRig((url) => {
    if (url.endsWith("/site_info")) return { status: 200, body: {} };
    n++;
    return n === 1 ? { status: 429, headers: { "retry-after": "900" } } : live({});
  });
  try {
    await r.a.tick();
    assert.ok(r.b.audit.lines.some((l) => l.reason === "rate_limited" && l.outcome === "error"));
    r.advance(300);
    await r.a.tick();
    r.advance(300);
    await r.a.tick();
    assert.equal(n, 1, "no calls while rate limited");
    assert.equal(r.b.audit.lines.filter((l) => l.reason === "backoff_rate_limited").length, 2);
    r.advance(301);
    await r.a.tick();
    assert.equal(n, 2);
  } finally {
    await r.close();
  }
});

test("energy: 401 re-reads the token and retries once; a stale token audits unauthorized and backs off", async () => {
  const r = await energyRig((url, _n) => {
    if (url.endsWith("/site_info")) return { status: 200, body: {} };
    return readFileSync(r.tokenFile, "utf8").trim() === "access-good" ? live({}) : { status: 401, body: {} };
  });
  try {
    writeFileSync(r.tokenFile, "access-bad\n");
    await r.a.tick();
    assert.ok(r.b.audit.lines.some((l) => l.reason === "unauthorized"));
    const before = r.api.calls.length;
    r.advance(60);
    await r.a.tick();
    assert.equal(r.api.calls.length, before, "backing off");
    assert.ok(r.b.audit.lines.some((l) => l.reason === "backoff_unauthorized"));
    r.advance(600);
    writeFileSync(r.tokenFile, "access-good\n");
    const unauthBefore = r.b.audit.lines.filter((l) => l.reason === "unauthorized").length;
    await r.a.tick();
    assert.equal(r.b.audit.lines.filter((l) => l.reason === "unauthorized").length, unauthBefore);
    assert.equal(r.api.calls.at(-1)!.auth, "Bearer access-good");
  } finally {
    await r.close();
  }
});

test("energy client: 401 then rotated token on disk -> retried with the new token in the same poll", async () => {
  let token = "old";
  const api = fakeApi((url, n) => (n === 1 ? { status: 401 } : live({})));
  const a = new TeslaAdapter(
    { ...example, energy_poll: { ...example.energy_poll!, enabled: true, api_base: API, token_ref: "env:TESLA_TOKEN" } },
    { fetchImpl: api.f },
  );
  const env = { get TESLA_TOKEN() { return token; } } as unknown as Record<string, string>;
  a.init({ log: { info() {}, warn() {}, error() {} }, audit() {}, submit: async () => ({ accepted: false, reason: "no_route" }), secret: (ref: string) => (ref === "env:TESLA_TOKEN" ? env.TESLA_TOKEN : undefined) } as never);
  await a.start();
  try {
    const p = a.tick();
    token = "new";
    await p;
    assert.deepEqual(api.calls.map((c) => c.auth).slice(0, 2), ["Bearer old", "Bearer new"]);
  } finally {
    await a.stop();
  }
});

test("energy: missing scope / login_required / unreachable / tls are audited by code; a running poll skips the tick", async () => {
  const errs: Array<{ status: number; body?: unknown } | Error> = [
    Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }),
    { status: 403, body: { error: "Unauthorized missing scopes" } },
    { status: 401, body: { error: "login_required" } },
  ];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let slow = false;
  const r = await energyRig((url) => (url.endsWith("/site_info") ? { status: 200, body: {} } : errs.shift() ?? live({})));
  try {
    for (let i = 0; i < 4; i++) {
      r.advance(4000);
      await r.a.tick();
    }
    const reasons = r.b.audit.lines.filter((l) => l.outcome === "error").map((l) => l.reason);
    for (const c of ["fleet_api_unreachable", "fleet_api_tls_error", "missing_scope", "login_required"]) assert.ok(reasons.includes(c), c);
    assert.equal(JSON.stringify(r.b.audit.lines).includes("fleet-api.example.com"), false, "no URLs in audit");
    // in-progress skip
    const orig = (r.a as unknown as { energy: { liveStatus: (s: string) => Promise<unknown> } }).energy;
    const real = orig.liveStatus.bind(orig);
    orig.liveStatus = async (s: string) => {
      slow = true;
      await gate;
      return real(s);
    };
    r.advance(4000);
    const first = r.a.tick();
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(slow, true);
    await r.a.tick();
    assert.ok(r.b.audit.lines.some((l) => l.reason === "poll_in_progress"));
    release();
    await first;
  } finally {
    await r.close();
  }
});

// ---------- decoded receiver ----------

test("decoded receiver: loopback only; POST NDJSON from fleet-telemetry -> triggers", async () => {
  assert.throws(() => new DecodedJsonReceiver({ listen: "0.0.0.0:1" }), /loopback/);
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter({ ...example, telemetry: { ...example.telemetry!, enabled: true, decoded_listen: "127.0.0.1:0" } });
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  try {
    const port = a.telemetryPort();
    const rec = (t: string, v: object) => JSON.stringify({ data: [{ key: "DetailedChargeState", value: v }], createdAt: t, vin: VIN, isResend: false });
    const body = [rec("2026-01-01T00:00:00Z", { detailedChargeStateValue: "DetailedChargeStateCharging" }), rec("2026-01-01T01:00:00Z", { detailedChargeStateValue: "DetailedChargeStateComplete" })].join("\n");
    const res = await fetch(`http://127.0.0.1:${port}/records`, { method: "POST", body });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 2 });
    for (let i = 0; i < 50 && m.hits.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(m.hits.length, 1);
    assert.match(m.hits[0].body.prompt, /charge_complete/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`, { method: "POST", body: "{}" })).status, 404);
    const bad = await fetch(`http://127.0.0.1:${port}/records`, { method: "POST", body: "not json\n{\"vin\":\"\"}" });
    assert.deepEqual(await bad.json(), { accepted: 0 });
    assert.equal(b.audit.lines.filter((l) => l.reason === "bad_record").length, 2);
  } finally {
    await b.close();
    await m.close();
  }
});

test("decoded receiver: optional bearer token; a failing submit is audited, not thrown", async () => {
  const a = new TeslaAdapter({ ...example, telemetry: { ...example.telemetry!, enabled: true, decoded_listen: "127.0.0.1:0", decoded_token_ref: "env:RELAY_TOKEN" } });
  const audit: Array<{ reason?: string }> = [];
  a.init({
    log: { info() {}, warn() {}, error() {} },
    audit: (e: { reason?: string }) => audit.push(e),
    submit: async () => {
      throw new Error("boom");
    },
    secret: (ref: string) => (ref === "env:RELAY_TOKEN" ? "relay-secret" : undefined),
  } as never);
  await a.start();
  try {
    const url = `http://127.0.0.1:${a.telemetryPort()}/records`;
    const rec = (t: string, v: string) => JSON.stringify({ data: [{ key: "SentryMode", value: { sentryModeStateValue: v } }], createdAt: t, vin: VIN });
    assert.equal((await fetch(url, { method: "POST", body: rec("2026-01-01T00:00:00Z", "SentryModeStateArmed") })).status, 401);
    const ok = { authorization: "Bearer relay-secret" };
    assert.equal((await fetch(url, { method: "POST", headers: ok, body: rec("2026-01-01T00:00:00Z", "SentryModeStateArmed") })).status, 202);
    assert.equal((await fetch(url, { method: "POST", headers: ok, body: rec("2026-01-01T00:01:00Z", "SentryModeStateAware") })).status, 202);
    for (let i = 0; i < 50 && !audit.some((e) => e.reason === "ingest_failed"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(audit.some((e) => e.reason === "ingest_failed"));
  } finally {
    await a.stop();
  }
});

// ---------- mTLS receiver ----------

function makeCa(cn: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: "commonName", value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert, pem: forge.pki.certificateToPem(cert) };
}
function issue(ca: ReturnType<typeof makeCa>, cn: string, server: boolean) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Math.floor(Math.random() * 1e6) + 2);
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  cert.setSubject([{ name: "commonName", value: cn }]);
  cert.setIssuer(ca.cert.subject.attributes);
  const ext: object[] = [{ name: "basicConstraints", cA: false }, { name: "extKeyUsage", serverAuth: server, clientAuth: !server }];
  if (server) ext.push({ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }, { type: 2, value: "localhost" }] });
  cert.setExtensions(ext);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

test("mtls receiver: client cert required and verified; VIN from cert CN; payload VIN mismatch dropped; binary frames dropped", async () => {
  const serverCa = makeCa("example server ca");
  const vehicleCa = makeCa("example vehicle ca");
  const rogueCa = makeCa("example rogue ca");
  const server = issue(serverCa, "localhost", true);
  const car = issue(vehicleCa, VIN, false);
  const rogue = issue(rogueCa, VIN, false);
  const dir = mkdtempSync(join(tmpdir(), "tesla-mtls-"));
  const f = (n: string, s: string) => {
    const p = join(dir, n);
    writeFileSync(p, s);
    return `file:${p}`;
  };
  const m = await mockRoutine({ key: "routine-key" });
  const a = new TeslaAdapter({
    ...example,
    telemetry: {
      ...example.telemetry!,
      enabled: true,
      mode: "mtls",
      listen: "127.0.0.1:0",
      tls_cert: f("server.crt", server.cert),
      tls_key: f("server.key", server.key),
      client_ca: f("vehicle-ca.pem", vehicleCa.pem),
    },
  });
  const b = await startBridge({ routineUrl: m.url, adapters: [a] });
  const port = a.telemetryPort();
  const open = (cred?: { cert: string; key: string }) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/`, { ca: serverCa.pem, ...(cred ?? {}) });
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
      ws.once("unexpected-response", () => reject(new Error("rejected")));
    });
  try {
    await assert.rejects(open(), "no client cert -> handshake refused");
    await assert.rejects(open(rogue), "cert from another CA -> refused");
    // Plain TLS without a cert never gets an authorized socket either.
    await new Promise<void>((resolve) => {
      const s = tlsConnect({ host: "127.0.0.1", port, ca: serverCa.pem, servername: "localhost" });
      s.on("error", () => resolve());
      s.on("close", () => resolve());
      s.on("secureConnect", () => s.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n"));
    });

    const ws = await open(car);
    const send = (o: object) => ws.send(JSON.stringify(o));
    send({ data: [{ key: "SentryMode", value: { sentryModeStateValue: "SentryModeStateArmed" } }], createdAt: "2026-01-01T00:00:00Z" });
    send({ data: [{ key: "SentryMode", value: { sentryModeStateValue: "SentryModeStateAware" } }], createdAt: "2026-01-01T00:01:00Z", vin: "OTHERVIN000000009" });
    ws.send(Buffer.from([1, 2, 3]));
    send({ data: [{ key: "SentryMode", value: { sentryModeStateValue: "SentryModeStateAware" } }], createdAt: "2026-01-01T00:02:00Z", vin: VIN });
    for (let i = 0; i < 100 && m.hits.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    ws.close();
    assert.equal(m.hits.length, 1, "only the cert-matching record fired");
    assert.match(m.hits[0].body.prompt, /sentry_alert/);
    const reasons = b.audit.lines.map((l) => l.reason);
    assert.ok(reasons.includes("vin_cert_mismatch"));
    assert.ok(reasons.includes("undecodable_frame"));
    assert.equal(JSON.stringify(b.audit.lines).includes(VIN), false);
  } finally {
    await b.close();
    await m.close();
  }
});

test("EnergyApiError carries only a code", () => {
  const e = new EnergyApiError("rate_limited", 429, 5);
  assert.equal(e.message, "rate_limited");
  assert.throws(() => new FleetEnergyClient({ apiBase: "http://x.example.com", getToken: () => "t" }), /https/);
});
