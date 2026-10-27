#!/usr/bin/env node
// Manual LIVE voice check against a deployed bridge and a real Discord voice channel.
// CI can't reach Discord, so this is run by the operator after cutover (see docs/VOICE-LIVE-TEST.md).
//
// Every input is an env:/file: reference; literal values are refused (so nothing secret lands
// in shell history):
//   node scripts/voice-live-check.mjs --bridge env:VOICE_CHECK_BRIDGE_URL \
//        --token file:/run/secrets/discord-callback-token --channel env:VOICE_CHECK_CHANNEL [--speech] [--drop]
//
//   --bridge   base URL of the bridge (e.g. the loopback URL on the host)
//   --token    the Discord adapter's callback token
//   --channel  an allowlisted voice channel id (discord.voice.channels)
//   --speech   also speak a short line through the default engine (needs Piper configured)
//   --drop     drop-recovery step: asks you to disconnect the bot from the voice channel,
//              then checks the stream is released and play works again (no stuck 409)
//   --drop-timeout-s N  how long to wait for the drop (default 60)
//
// Prints one PASS/FAIL line per step; exit code 0 only when every step passed.
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(name);

function readRef(label, ref) {
  if (typeof ref !== "string" || !ref) throw new Error(`${label}: missing (use env:NAME or file:/absolute/path)`);
  if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    const v = process.env[ref.slice(4)];
    if (!v || !v.trim()) throw new Error(`${label}: ${ref} is not set`);
    return v.trim();
  }
  if (ref.startsWith("file:") && isAbsolute(ref.slice(5))) {
    const v = readFileSync(ref.slice(5), "utf8").split(/\r?\n/)[0].trim();
    if (!v) throw new Error(`${label}: file is empty`);
    return v;
  }
  throw new Error(`${label}: literal values are refused; use env:NAME or file:/absolute/path`);
}

let failed = 0;
const results = [];
function report(step, ok, detail = "") {
  if (!ok) failed++;
  const line = `${ok ? "PASS" : "FAIL"} ${step}${detail ? ` (${detail})` : ""}`;
  results.push(line);
  console.log(line);
}

async function main() {
  let base, token, channelId;
  try {
    base = readRef("--bridge", arg("--bridge")).replace(/\/+$/, "");
    token = readRef("--token", arg("--token"));
    channelId = readRef("--channel", arg("--channel"));
  } catch (e) {
    console.error(`usage error: ${e.message}`);
    process.exit(2);
  }
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const call = async (path, body) => {
    const res = await fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers, body: JSON.stringify(body) });
    let json = {};
    try {
      json = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, body: json };
  };
  const stream = (b) => call("/discord/voice/stream", b);
  const play = (b = {}) => call("/discord/voice/play", { channelId, ...b });

  const h = await call("/healthz").catch((e) => ({ status: 0, body: { error: e.name } }));
  report("1 healthz", h.status === 200, `status ${h.status}`);
  if (h.status !== 200) return;

  // Start clean: a stream left open by an earlier run would make every play 409.
  await stream({ op: "close" });

  const tone = await play();
  report("2 play tone (you should hear ~2 s)", tone.status === 200, `status ${tone.status}${tone.body.error ? ` ${tone.body.error}` : ""}`);
  if (tone.status === 401 || tone.status === 403 || tone.status === 503) {
    console.log("stopping: fix the token / voice.channels / voice.enabled first (see docs/VOICE-LIVE-TEST.md)");
    return;
  }

  if (flag("--speech")) {
    const sp = await play({ text: "Voice check from the universal bridge." });
    report("3 play speech", sp.status === 200, `status ${sp.status}${sp.body.error ? ` ${sp.body.error}` : ""}`);
  }

  const open = await stream({ op: "open", channelId });
  report("4 stream open", open.status === 200 && open.body.open === true, `status ${open.status}`);
  const busy = await play();
  report("5 play while streaming answers 409", busy.status === 409, `status ${busy.status} ${busy.body.error ?? ""}`.trim());
  if (flag("--speech")) {
    const add = await stream({ op: "add", id: "check", text: "Stream layer check." });
    report("6 stream add speech layer", add.status === 200, `status ${add.status}`);
  }
  const st = await stream({ op: "status" });
  report("7 stream status reports open", st.status === 200 && st.body.open === true, `open=${st.body.open}`);
  const close = await stream({ op: "close" });
  report("8 stream close", close.status === 200, `status ${close.status}`);
  const after = await play();
  report("9 play after close", after.status === 200, `status ${after.status}`);

  if (flag("--drop")) {
    const o = await stream({ op: "open", channelId });
    report("10 stream open (drop test)", o.status === 200, `status ${o.status}`);
    const timeout = Number(arg("--drop-timeout-s") ?? 60) * 1000;
    console.log("ACTION: in Discord, disconnect the bot from the voice channel now (right-click the bot > Disconnect).");
    const t0 = Date.now();
    let released = false;
    while (Date.now() - t0 < timeout) {
      const s = await stream({ op: "status" });
      if (s.body.open === false) {
        released = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    report("11 dropped stream released (status open=false)", released, released ? `${Math.round((Date.now() - t0) / 1000)} s` : "timed out");
    const p = await play();
    report("12 play after the drop (no stuck 409)", p.status === 200, `status ${p.status}${p.body.error ? ` ${p.body.error}` : ""}`);
  }
}

main()
  .catch((e) => {
    report("run", false, e?.name ?? "error");
  })
  .finally(() => {
    console.log(failed ? `RESULT: FAIL (${failed} step(s))` : "RESULT: PASS");
    process.exit(failed ? 1 : 0);
  });
