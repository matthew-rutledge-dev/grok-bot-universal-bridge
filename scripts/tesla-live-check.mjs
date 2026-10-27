#!/usr/bin/env node
// Tesla adapter live check for the host operator. Read-only: it never publishes, never
// sends a vehicle command and never refreshes a token.
//
//   BRIDGE_CONFIG=/path/bridge.json node scripts/tesla-live-check.mjs [--listen 60] [--energy]
//   (or: node scripts/tesla-live-check.mjs --tesla-config /path/tesla.json ...)
//
// Prints only: ok/fail lines, masked VINs and site ids (last 4 characters), field names,
// message counts, file modes and reason codes. It never prints a broker URL, a username, a
// password, a token or a full VIN. Exit code 0 = every check passed.
//
// Checks:
//  1. tesla config parses; mode and refs resolve (resolved values are not shown)
//  2. mqtt mode: connects to the broker, subscribes to <topic_base>/+/v/+ and listens
//     --listen seconds (default 30), counting messages per masked VIN and field
//  3. energy token_ref: file exists, mode 600 (POSIX), non-empty; the plugin's tokens.json is
//     never read
//  4. --energy: one GET live_status per allowlisted site (read-only), status code only
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const listenS = Math.max(1, Number(arg("--listen", "30")) || 30);
const doEnergy = args.includes("--energy");

let failed = 0;
const ok = (msg) => console.log(`ok    ${msg}`);
const bad = (msg) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const info = (msg) => console.log(`      ${msg}`);
const mask = (v) => (typeof v === "string" && v.length > 4 ? `…${v.slice(-4)}` : "…");
const refKind = (ref) => (String(ref).startsWith("file:") ? "file ref" : String(ref).startsWith("env:") ? `env ref ${String(ref).slice(4)}` : "literal");

/** env:NAME / file:/abs (first line). Never printed. */
function resolveRef(ref) {
  const r = String(ref ?? "").trim();
  if (r.startsWith("env:")) return process.env[r.slice(4)]?.trim() || undefined;
  if (r.startsWith("file:") && isAbsolute(r.slice(5))) {
    try {
      return readFileSync(r.slice(5), "utf8").split(/\r?\n/)[0].trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function loadTeslaConfig() {
  const direct = arg("--tesla-config");
  if (direct) return { file: resolve(direct), cfg: JSON.parse(readFileSync(direct, "utf8")) };
  const bridgeFile = process.env.BRIDGE_CONFIG;
  if (!bridgeFile) throw new Error("set BRIDGE_CONFIG or pass --tesla-config");
  const bridge = JSON.parse(readFileSync(bridgeFile, "utf8"));
  const p = bridge?.adapters?.tesla?.configPath;
  if (!p) throw new Error("bridge config has no adapters.tesla.configPath");
  const file = isAbsolute(p) ? p : resolve(process.cwd(), p);
  if (!bridge.adapters.tesla.enabled) info("note: adapters.tesla.enabled is false in the bridge config");
  return { file, cfg: JSON.parse(readFileSync(file, "utf8")) };
}

async function checkMqtt(t) {
  const m = t.mqtt ?? {};
  const url = m.broker?.startsWith("env:") || m.broker?.startsWith("file:") ? resolveRef(m.broker) : m.broker;
  if (!url) return bad(`mqtt.broker does not resolve (${refKind(m.broker)})`);
  ok(`mqtt.broker resolves (${refKind(m.broker)}; ${url.startsWith("mqtts:") ? "TLS" : "plain"})`);
  const opts = { clientId: `${m.client_id || "bridge-tesla"}-livecheck`, clean: true, reconnectPeriod: 0, connectTimeout: 10_000 };
  if (m.username_ref) {
    opts.username = resolveRef(m.username_ref);
    if (!opts.username) return bad(`mqtt.username_ref does not resolve (${refKind(m.username_ref)})`);
  }
  if (m.password_ref) {
    opts.password = resolveRef(m.password_ref);
    if (!opts.password) return bad(`mqtt.password_ref does not resolve (${refKind(m.password_ref)})`);
  }
  if (m.ca_file) {
    try {
      opts.ca = readFileSync(m.ca_file.slice(5), "utf8");
    } catch {
      return bad("mqtt.ca_file is not readable");
    }
  }
  let connect;
  try {
    ({ connect } = await import("mqtt"));
  } catch {
    return bad("the mqtt package is not installed (run npm ci)");
  }
  const sub = `${m.topic_base}/+/v/+`;
  const counts = new Map();
  const vins = new Set();
  const allow = new Set(t.vin_allowlist ?? []);
  await new Promise((done) => {
    const c = connect(url, opts);
    const finish = () => c.end(true, {}, () => done());
    const timer = setTimeout(finish, 10_000 + listenS * 1000);
    c.on("error", (e) => {
      bad(`broker connection failed (${typeof e?.code === "number" ? `connack ${e.code}` : e?.code ?? "error"})`);
      clearTimeout(timer);
      finish();
    });
    c.on("connect", () => {
      ok("connected to the broker");
      c.subscribe(sub, { qos: m.qos ?? 1 }, (err, granted) => {
        if (err || granted?.[0]?.qos === 128) {
          bad("subscribe refused (check the broker ACL for the topic_base)");
          clearTimeout(timer);
          return finish();
        }
        ok(`subscribed to <topic_base>/+/v/+; listening ${listenS} s`);
        clearTimeout(timer);
        setTimeout(finish, listenS * 1000);
      });
    });
    c.on("message", (topic, payload) => {
      const rest = topic.slice(String(m.topic_base).length + 1).split("/");
      const vin = rest[0];
      vins.add(vin);
      const k = `${mask(vin)}${allow.has(vin) ? "" : " (not allowlisted)"} ${rest[2] ?? "?"}`;
      let shape = "json";
      try {
        JSON.parse(payload.toString("utf8"));
      } catch {
        shape = "bad_json";
      }
      counts.set(`${k} ${shape}`, (counts.get(`${k} ${shape}`) ?? 0) + 1);
    });
  });
  if (!counts.size) {
    bad(`no field messages in ${listenS} s (is fleet-telemetry running with records V:["mqtt"], and is a car awake and configured?)`);
    return;
  }
  ok(`${[...counts.values()].reduce((a, b) => a + b, 0)} field message(s) from ${vins.size} vehicle(s)`);
  for (const [k, n] of [...counts].sort()) info(`${k}: ${n}`);
  if (![...vins].some((v) => allow.has(v))) bad("no messages from an allowlisted VIN (check telemetry.vin_allowlist)");
}

function checkEnergyToken(e) {
  const ref = e.token_ref;
  if (!ref) return bad("energy_poll.token_ref is not set");
  if (/tokens\.json$/i.test(ref)) return bad("energy_poll.token_ref points at the plugin's tokens.json: use the separate access-token export file");
  if (ref.startsWith("file:")) {
    const path = ref.slice(5);
    try {
      const st = statSync(path);
      if (process.platform !== "win32" && (st.mode & 0o077) !== 0) bad(`token file mode is ${(st.mode & 0o777).toString(8)} (want 600)`);
      else ok(`token file exists${process.platform !== "win32" ? ", mode 600" : ""}; age ${Math.round((Date.now() - st.mtimeMs) / 60000)} min`);
    } catch {
      return bad("token file does not exist (is TESLA_FLEET_ACCESS_TOKEN_EXPORT_FILE set in the plugin, and has it refreshed once?)");
    }
  }
  const v = resolveRef(ref);
  if (!v) return bad(`token_ref does not resolve (${refKind(ref)})`);
  ok(`token_ref resolves (${refKind(ref)}; value not shown)`);
  return v;
}

async function checkEnergy(e, token) {
  for (const site of e.site_allowlist ?? []) {
    try {
      const res = await fetch(`${String(e.api_base).replace(/\/+$/, "")}/api/1/energy_sites/${encodeURIComponent(site)}/live_status`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 200) ok(`live_status ${mask(site)}: 200`);
      else bad(`live_status ${mask(site)}: HTTP ${res.status}${res.status === 401 ? " (token expired or wrong; the plugin refreshes it)" : res.status === 403 ? " (missing energy_device_data scope?)" : ""}`);
    } catch (err) {
      bad(`live_status ${mask(site)}: ${err?.cause?.code ?? err?.name ?? "error"}`);
    }
  }
}

try {
  const { file, cfg } = loadTeslaConfig();
  ok(`tesla config parsed (${file.split(/[\\/]/).pop()})`);
  const t = cfg.telemetry;
  if (t?.enabled) {
    const mode = t.mode ?? "decoded";
    ok(`telemetry mode ${mode}; ${t.vin_allowlist?.length ?? 0} allowlisted VIN(s): ${(t.vin_allowlist ?? []).map(mask).join(", ")}`);
    if (mode === "mqtt") await checkMqtt(t);
    else info(`mode ${mode}: no live listen check here (use --listen with mqtt mode)`);
  } else info("telemetry disabled");
  const e = cfg.energy_poll;
  if (e?.enabled) {
    const token = checkEnergyToken(e);
    if (token && doEnergy) await checkEnergy(e, token);
    else if (token) info("energy API not called (add --energy for one read-only live_status per site)");
  } else info("energy polling disabled");
} catch (err) {
  bad(`setup: ${err?.message ?? err}`);
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
