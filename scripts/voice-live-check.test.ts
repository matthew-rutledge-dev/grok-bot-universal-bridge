import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiscordAdapter, type DiscordAdapterConfig } from "../adapters/discord/index.js";
import { BOT, FakeDiscordPort, mockRoutine, startBridge, tmp } from "../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("../adapters/discord/config.example.json", import.meta.url), "utf8")) as DiscordAdapterConfig;
const VCH = "777777777777777777";
const script = new URL("./voice-live-check.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function run(args: string[], env: Record<string, string>, onLine?: (l: string) => void) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const l of s.split("\n")) if (l) onLine?.(l);
    });
    p.stderr.on("data", (d) => (out += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

test("voice live-check script: refs only; full checklist incl. drop recovery passes against a loopback bridge", async () => {
  const bad = await run(["--bridge", "http://127.0.0.1:1", "--token", "env:T", "--channel", "env:C"], {});
  assert.equal(bad.code, 2);
  assert.match(bad.out, /literal values are refused/);

  const routine = await mockRoutine({ key: "routine-key" });
  const port = new FakeDiscordPort(BOT);
  const adapter = new DiscordAdapter({ ...example, voice: { ...example.voice, enabled: true } }, port);
  const b = await startBridge({ routineUrl: routine.url, adapters: [adapter], env: { DISCORD_BOT_TOKEN: "aaa.bbb.ccc", DISCORD_CALLBACK_TOKEN: "cb-discord", DISCORD_PLANNER_URL: "http://127.0.0.1:9/plan", DISCORD_PLANNER_TOKEN: "t" } });
  const dir = tmp("ubridge-voicecheck-");
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "cb-discord\n");
  try {
    const r = await run(
      ["--bridge", "env:VOICE_CHECK_BRIDGE_URL", "--token", `file:${tokenFile}`, "--channel", "env:VOICE_CHECK_CHANNEL", "--drop", "--drop-timeout-s", "10"],
      { VOICE_CHECK_BRIDGE_URL: b.base, VOICE_CHECK_CHANNEL: VCH },
      (l) => {
        // Stand-in for the operator disconnecting the bot in Discord.
        if (l.startsWith("ACTION:")) setTimeout(() => port.voice.drop(), 200);
      },
    );
    assert.equal(r.code, 0, r.out);
    for (const step of ["1 healthz", "2 play tone", "4 stream open", "5 play while streaming answers 409", "8 stream close", "11 dropped stream released", "12 play after the drop"]) {
      assert.match(r.out, new RegExp(`PASS ${step}`), step);
    }
    assert.match(r.out, /RESULT: PASS/);
    assert.equal(r.out.includes("cb-discord"), false, "the token is never printed");
    const wrong = await run(["--bridge", "env:VOICE_CHECK_BRIDGE_URL", "--token", "env:WRONG", "--channel", "env:VOICE_CHECK_CHANNEL"], { VOICE_CHECK_BRIDGE_URL: b.base, VOICE_CHECK_CHANNEL: VCH, WRONG: "nope" });
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, /FAIL 2 play tone .*status 401/);
    assert.match(wrong.out, /stopping: fix the token/);
  } finally {
    await b.close();
    await routine.close();
  }
});
