#!/usr/bin/env node
// Grok Build adapter live check: run by the host operator against a deployed bridge.
//
//   node scripts/grokbuild-live-check.mjs \
//     --bridge-url-ref env:GROKBUILD_BRIDGE_URL \
//     --client-token-ref file:/run/secrets/grokbuild-client-token \
//     [--callback-token-ref env:GROKBUILD_CALLBACK_TOKEN] \
//     --bot example-agent \
//     --expect read-only|writable \
//     [--send] [--wait-reply-sec 300]
//
// Every URL and token is an env:NAME or file:/absolute/path reference. Literal
// values are refused (they would land in shell history). Nothing secret is
// printed: no URL, host, token, prompt text or full request id.
//
// Without --send it writes nothing: every probe is either refused by the
// bridge (401/400/403/404) or read-only (healthz, status). With --expect
// writable --send it sends ONE short prompt to --bot, waits until the bridge
// reports it delivered, and (with --wait-reply-sec) until the agent's reply
// comes back through /grokbuild/callback.
//
// Exit: 0 all checks passed, 1 a check failed, 2 usage or reference error.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PLACEHOLDERS = new Set(["", "changeme", "change-me", "placeholder", "replace-me", "todo", "xxx"]);

function usage(msg) {
  console.error(`grokbuild-live-check: ${msg}`);
  console.error("usage: --bridge-url-ref env:NAME|file:/abs --client-token-ref env:NAME|file:/abs [--callback-token-ref ...] --bot <alias> --expect read-only|writable [--send] [--wait-reply-sec N]");
  process.exit(2);
}

function parseArgs(argv) {
  const out = { send: false, waitReplySec: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    if (a === "--bridge-url-ref") out.urlRef = val();
    else if (a === "--client-token-ref") out.clientRef = val();
    else if (a === "--callback-token-ref") out.callbackRef = val();
    else if (a === "--bot") out.bot = val();
    else if (a === "--expect") out.expect = val();
    else if (a === "--send") out.send = true;
    else if (a === "--wait-reply-sec") out.waitReplySec = Number(val());
    else usage(`unknown argument ${JSON.stringify(a.slice(0, 40))}`);
  }
  return out;
}

function isRef(ref) {
  if (typeof ref !== "string") return false;
  const r = ref.trim();
  if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(r)) return true;
  return r.startsWith("file:") && r.length > 5 && isAbsolute(r.slice(5));
}

/** Resolve an env:/file: reference. Literals are refused; the value is never printed. */
function resolveRef(ref, label) {
  if (!isRef(ref)) usage(`${label} must be env:NAME or file:/absolute/path (literal values are refused)`);
  const r = ref.trim();
  let v;
  if (r.startsWith("env:")) v = process.env[r.slice(4)];
  else {
    try {
      v = readFileSync(r.slice(5), "utf8").split(/\r?\n/)[0];
    } catch {
      v = undefined;
    }
  }
  const t = (v ?? "").trim();
  if (PLACEHOLDERS.has(t.toLowerCase()) || /^\$\{[^}]*\}$/.test(t) || /^<[^>]*>$/.test(t)) {
    usage(`${label}: reference is unset or a placeholder (${r.startsWith("env:") ? r : "file"})`);
  }
  return t;
}

const args = parseArgs(process.argv.slice(2));
if (!args.urlRef) usage("--bridge-url-ref is required");
if (!args.clientRef) usage("--client-token-ref is required");
if (!args.bot || !ALIAS.test(args.bot)) usage("--bot must be a lowercase registry alias");
if (args.expect !== "read-only" && args.expect !== "writable") usage("--expect must be read-only or writable");
if (args.send && args.expect !== "writable") usage("--send only makes sense with --expect writable");
if (!Number.isFinite(args.waitReplySec) || args.waitReplySec < 0 || args.waitReplySec > 3600) usage("--wait-reply-sec must be 0-3600");

const rawUrl = resolveRef(args.urlRef, "--bridge-url-ref");
const clientToken = resolveRef(args.clientRef, "--client-token-ref");
const callbackToken = args.callbackRef ? resolveRef(args.callbackRef, "--callback-token-ref") : undefined;
let base;
try {
  const u = new URL(rawUrl);
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) usage("bridge URL must be https (http only on loopback)");
  if (u.username || u.password || u.search) usage("bridge URL must not carry credentials or a query");
  base = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
} catch {
  usage("bridge URL reference does not hold a valid URL");
}
const secrets = [clientToken, callbackToken, rawUrl, base].filter(Boolean);

let failures = 0;
function scrub(s) {
  let out = String(s);
  for (const v of secrets) out = out.split(v).join("<redacted>");
  return out;
}
function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(scrub(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`));
}
const mask = (id) => (id && id.length > 4 ? `…${id.slice(-4)}` : "…");

async function call(method, path, { body, token, headers = {} } = {}) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    let json = {};
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: json, retryAfter: res.headers.get("retry-after") };
  } catch (err) {
    return { status: 0, body: { error: err?.name ?? "network" } };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrongToken = randomBytes(24).toString("hex");

console.log(`grokbuild live check: expect=${args.expect} bot=${args.bot} send=${args.send ? "yes" : "no"} bridge=(${new URL(base).protocol.replace(":", "")}, from ref)`);

// 1. Liveness and the client's own view (no writes).
const h = await call("GET", "/healthz");
check("healthz answers 200 with the grokbuild adapter", h.status === 200 && Array.isArray(h.body.adapters) && h.body.adapters.includes("grokbuild"), `status=${h.status}`);
const st = await call("GET", "/grokbuild/status", { token: clientToken });
check("client token is accepted (GET /grokbuild/status)", st.status === 200, `status=${st.status}${st.body.error ? ` error=${st.body.error}` : ""}`);
check(`read-only switch is ${args.expect === "read-only" ? "ON" : "OFF"}`, st.status === 200 && st.body.readOnly === (args.expect === "read-only"), `readOnly=${st.body.readOnly}`);
if (args.expect === "writable") check("reply channel is ready (callback token + public URL set)", st.body.replyChannel === "ready", `replyChannel=${st.body.replyChannel}`);
check(`--bot is routed for this client`, Array.isArray(st.body.bots) && st.body.bots.includes(args.bot), `routed bots=${Array.isArray(st.body.bots) ? st.body.bots.length : 0}`);

// 2. Refusals (nothing is delivered).
const noTok = await call("POST", "/grokbuild/prompt", { body: { bot: args.bot, prompt: "live check: must be refused" } });
check("prompt without a token is refused (401)", noTok.status === 401, `status=${noTok.status}`);
const badTok = await call("POST", "/grokbuild/prompt", { body: { bot: args.bot, prompt: "live check: must be refused" }, token: wrongToken });
check("prompt with a wrong token is refused (401)", badTok.status === 401, `status=${badTok.status}`);
const qTok = await call("POST", `/grokbuild/prompt?token=${wrongToken}`, { body: { bot: args.bot, prompt: "live check: must be refused" } });
check("token in the query string is refused (400)", qTok.status === 400, `status=${qTok.status}`);
const unrouted = await call("POST", "/grokbuild/prompt", { body: { bot: `live-check-unrouted-${randomBytes(3).toString("hex")}`, prompt: "live check: must be refused" }, token: clientToken });
const unroutedWant = args.expect === "read-only" ? "read_only" : "no_route";
check(`prompt to a non-allowlisted bot is refused (403 ${unroutedWant})`, unrouted.status === 403 && unrouted.body.error === unroutedWant, `status=${unrouted.status} error=${unrouted.body.error}`);
const unknown = await call("GET", `/grokbuild/requests/live-check-${randomUUID().slice(0, 8)}`, { token: clientToken });
check("unknown request id answers 404", unknown.status === 404, `status=${unknown.status}`);
const cbNoTok = await call("POST", "/grokbuild/callback", { body: { requestId: "live-check-none", content: "x" } });
check("callback without a token is refused (401, or 503 while unset)", cbNoTok.status === 401 || (args.expect === "read-only" && cbNoTok.status === 503), `status=${cbNoTok.status}`);
if (callbackToken) {
  const cb = await call("POST", "/grokbuild/callback", { body: { requestId: `live-check-${randomUUID().slice(0, 8)}`, content: "x" }, token: callbackToken });
  check("callback token is accepted (unknown request id answers 404, nothing stored)", cb.status === 404, `status=${cb.status}`);
}

// 3. The real write path.
if (args.expect === "read-only") {
  const ro = await call("POST", "/grokbuild/prompt", { body: { bot: args.bot, prompt: "live check: must be refused while read-only" }, token: clientToken });
  check("prompt to the routed bot is refused while read-only (403 read_only)", ro.status === 403 && ro.body.error === "read_only", `status=${ro.status} error=${ro.body.error}`);
} else if (!args.send) {
  console.log("SKIP sending a real prompt (pass --send to wake the agent once)");
} else {
  const requestId = `live-check-${randomUUID()}`;
  const sent = await call("POST", "/grokbuild/prompt", {
    token: clientToken,
    body: { bot: args.bot, requestId, prompt: "Grok Build bridge live check. Reply through the bridge callback with exactly: live-check ok", replyHint: "one short line" },
  });
  check("prompt to the routed bot is accepted (202)", sent.status === 202, `status=${sent.status} state=${sent.body.state ?? sent.body.error} id=${mask(requestId)}`);
  if (sent.status === 202) {
    const deliverBy = Date.now() + Math.max(60, args.waitReplySec) * 1000;
    let state = sent.body.state;
    while (state !== "delivered" && state !== "failed" && Date.now() < deliverBy) {
      await sleep(2000);
      const r = await call("GET", `/grokbuild/requests/${requestId}`, { token: clientToken });
      state = r.body.state ?? state;
    }
    check("the bridge delivered it to the agent (state delivered)", state === "delivered", `state=${state}`);
    if (args.waitReplySec > 0 && state === "delivered") {
      const replyBy = Date.now() + args.waitReplySec * 1000;
      let replies = 0;
      while (Date.now() < replyBy) {
        const r = await call("GET", `/grokbuild/requests/${requestId}`, { token: clientToken });
        replies = Array.isArray(r.body.replies) ? r.body.replies.length : 0;
        if (replies > 0) break;
        await sleep(3000);
      }
      check("the agent's reply came back through the callback", replies > 0, `replies=${replies}`);
    } else if (args.waitReplySec === 0) console.log("SKIP waiting for the agent's reply (pass --wait-reply-sec N)");
  }
}

console.log(failures ? `RESULT: ${failures} check(s) failed` : "RESULT: all checks passed");
process.exit(failures ? 1 : 0);
