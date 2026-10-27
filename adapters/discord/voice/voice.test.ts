import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { DiscordAdapter, validateDiscordConfig, type DiscordAdapterConfig } from "../index.js";
import { resolveVoiceEngine, synthesizeGrokVoice, synthesizePiper } from "./engines.js";
import { buildTonePcm, FRAME_BYTES, mixLocalBed, PcmMixer, toVoicePcm, wavToVoicePcm } from "./mix.js";
import { BOT, FakeDiscordPort, mockRoutine, startBridge } from "../../../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8")) as DiscordAdapterConfig;
const VCH = "777777777777777777";
const auth = { authorization: "Bearer cb-discord" };

function wav(rate: number, channels: number, samples: number[]): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Loopback Wyoming-protocol Piper: answers synthesize with audio-start/chunk/stop. */
async function mockPiper(rate = 24000) {
  const texts: string[] = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      const head = JSON.parse(buf.subarray(0, nl).toString());
      if (buf.length < nl + 1 + head.data_length) return;
      texts.push(JSON.parse(buf.subarray(nl + 1, nl + 1 + head.data_length).toString()).text);
      const ev = (type: string, data?: object, payload?: Buffer) => {
        const d = data ? Buffer.from(JSON.stringify(data)) : Buffer.alloc(0);
        sock.write(JSON.stringify({ type, data_length: d.length, payload_length: payload?.length ?? 0 }) + "\n");
        sock.write(d);
        if (payload) sock.write(payload);
      };
      ev("audio-start", { rate, width: 2, channels: 1 });
      ev("audio-chunk", { rate, width: 2, channels: 1 }, Buffer.alloc(rate * 2 / 10, 1)); // 100 ms
      ev("audio-stop");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, texts, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Loopback stand-in for the Grok Voice realtime socket. */
async function mockGrokVoice() {
  const seen: { auth?: string; types: string[] } = { types: [] };
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", (ws, req) => {
    seen.auth = req.headers.authorization;
    ws.on("message", (raw) => {
      const ev = JSON.parse(raw.toString());
      seen.types.push(ev.type);
      if (ev.type === "response.create") {
        ws.send(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(4800 * 2, 2).toString("base64") }));
        ws.send(JSON.stringify({ type: "response.done" }));
      }
    });
  });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}/v1/realtime`, seen, close: () => new Promise<void>((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(() => r()))) };
}

test("mixer + wav + resample keep the existing behavior", () => {
  const tone = buildTonePcm(2);
  assert.equal(tone.length, 48000 * 2 * 4);
  const mixer = new PcmMixer();
  mixer.add({ id: "a", pcm: Buffer.alloc(FRAME_BYTES * 2, 0), loop: false, gain: 1 });
  mixer.add({ id: "bed", pcm: Buffer.alloc(FRAME_BYTES, 0), loop: true, gain: 5 });
  assert.deepEqual(mixer.list().map((l) => [l.id, l.framesLeft]), [["a", 2], ["bed", -1]]);
  assert.equal(mixer.nextFrame().length, FRAME_BYTES);
  mixer.nextFrame();
  assert.deepEqual(mixer.list().map((l) => l.id), ["bed"], "one-shot layer dropped when done; loop stays");
  assert.throws(() => mixer.add({ id: "x", pcm: Buffer.alloc(3), loop: false, gain: 1 }), /pcm_format/);
  const pcm = wavToVoicePcm(wav(24000, 1, [1000, -1000, 1000, -1000]));
  assert.equal(pcm.length, 8 * 4, "24 kHz mono -> 48 kHz stereo doubles frames");
  assert.equal(pcm.readInt16LE(0), 1000);
  assert.equal(pcm.readInt16LE(2), 1000);
  assert.throws(() => wavToVoicePcm(Buffer.from("not a wav file at all, definitely not RIFF data..")), /wav_format/);
  assert.equal(toVoicePcm({ pcm: Buffer.alloc(2205 * 2), rate: 22050, channels: 1, width: 2 }).length, 4800 * 4);
  assert.equal(mixLocalBed(Buffer.alloc(400), () => 0.5).length, 400);
  assert.equal(resolveVoiceEngine(undefined), "local");
  assert.equal(resolveVoiceEngine("grok-voice-3.0"), "grok");
  assert.throws(() => resolveVoiceEngine("other"), /voice_engine/);
});

test("Piper (Wyoming) and Grok Voice engines against loopback mocks", async () => {
  const piper = await mockPiper();
  const grok = await mockGrokVoice();
  try {
    const clip = await synthesizePiper("hello there", "127.0.0.1", piper.port);
    assert.deepEqual([clip.rate, clip.channels, clip.pcm.length], [24000, 1, 4800]);
    assert.deepEqual(piper.texts, ["hello there"]);
    const g = await synthesizeGrokVoice("read this", "example-key", grok.url);
    assert.deepEqual([g.rate, g.channels, g.pcm.length], [48000, 1, 9600]);
    assert.equal(grok.seen.auth, "Bearer example-key");
    assert.deepEqual(grok.seen.types, ["session.update", "conversation.item.create", "response.create"]);
    await assert.rejects(synthesizeGrokVoice("x", ""), /grok_voice_not_configured/);
  } finally {
    await piper.close();
    await grok.close();
  }
});

async function setup(voice: DiscordAdapterConfig["voice"], envOver: Record<string, string> = {}, grokUrl?: string) {
  const routine = await mockRoutine({ key: "routine-key" });
  const port = new FakeDiscordPort(BOT);
  const adapter = new DiscordAdapter({ ...example, voice }, port, { grokVoiceUrl: grokUrl });
  const env = { DISCORD_BOT_TOKEN: "aaa.bbb.ccc", DISCORD_CALLBACK_TOKEN: "cb-discord", DISCORD_PLANNER_URL: "http://127.0.0.1:9/plan", DISCORD_PLANNER_TOKEN: "t", ...envOver };
  const b = await startBridge({ routineUrl: routine.url, adapters: [adapter], env });
  return { port, b, close: async () => (await b.close(), await routine.close()) };
}

test("voice routes: callback-token auth, off by default, channel allowlist, tone, Piper speech, 409 while streaming", async () => {
  const piper = await mockPiper();
  const s = await setup({ ...example.voice, enabled: true }, { PIPER_HOST: "127.0.0.1", PIPER_PORT: String(piper.port) });
  try {
    assert.equal((await s.b.call("POST", "/discord/voice/play", { channelId: VCH })).status, 401);
    assert.equal((await s.b.call("POST", "/discord/voice/play?token=cb-discord", { channelId: VCH })).status, 400);
    const unlisted = await s.b.call("POST", "/discord/voice/play", { channelId: "100000000000000000" }, auth);
    assert.deepEqual([unlisted.status, unlisted.body.error], [403, "voice_channel_not_allowlisted"]);
    assert.equal((await s.b.call("POST", "/discord/voice/play", { channelId: "12" }, auth)).body.error, "channel_id_required");
    assert.equal((await s.b.call("POST", "/discord/voice/play", { channelId: VCH, voice: "nope" }, auth)).body.error, "voice_engine");
    const tone = await s.b.call("POST", "/discord/voice/play", { channelId: VCH }, auth);
    assert.deepEqual([tone.status, tone.body.spoke, tone.body.engine], [200, false, "local"]);
    assert.deepEqual(s.port.voice.played[0], { channelId: VCH, bytes: 48000 * 2 * 4 });
    const spoke = await s.b.call("POST", "/discord/voice/play", { channelId: VCH, text: "dinner is ready", bed: true }, auth);
    assert.deepEqual([spoke.status, spoke.body.spoke, spoke.body.bed], [200, true, true]);
    assert.equal(s.port.voice.played[1].bytes, 4800 * 4);
    assert.deepEqual(piper.texts, ["dinner is ready"]);
    const grok = await s.b.call("POST", "/discord/voice/play", { channelId: VCH, text: "x", voice: "grok" }, auth);
    assert.deepEqual([grok.status, grok.body.error], [503, "grok_voice_not_configured"]);
    s.port.voice.notVoice.add(VCH);
    assert.deepEqual((await s.b.call("POST", "/discord/voice/play", { channelId: VCH }, auth)).body.error, "not_a_voice_channel");
    s.port.voice.notVoice.clear();
    assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "open", channelId: VCH }, auth)).status, 200);
    const busy = await s.b.call("POST", "/discord/voice/play", { channelId: VCH }, auth);
    assert.deepEqual([busy.status, busy.body.error], [409, "voice_stream_open"]);
    const voiceLines = s.b.audit.lines.filter((l) => l.action === "voice");
    assert.ok(voiceLines.some((l) => l.reason === "bad_token" && l.status === 401));
    assert.ok(!JSON.stringify(s.b.audit.lines).includes("dinner"), "no spoken text in the audit");
  } finally {
    await s.close();
    await piper.close();
  }
});

test("voice stream: open / add wav bed + speech / status / remove / close, Grok Voice via key ref", async () => {
  const grok = await mockGrokVoice();
  const s = await setup({ ...example.voice, enabled: true }, { GROK_VOICE_API_KEY: "example-key" }, grok.url);
  try {
    assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "add", id: "x", text: "hi" }, auth)).status, 409);
    const open = await s.b.call("POST", "/discord/voice/stream", { op: "open", channelId: VCH }, auth);
    assert.deepEqual([open.body.open, open.body.channelId], [true, VCH]);
    const bed = await s.b.call("POST", "/discord/voice/stream", { op: "add", id: "music", audioBase64: wav(48000, 2, Array(1920 * 2).fill(1000)).toString("base64") }, auth);
    assert.equal(bed.status, 200, JSON.stringify(bed.body));
    const speech = await s.b.call("POST", "/discord/voice/stream", { op: "add", id: "line", text: "hello", voice: "grok" }, auth);
    assert.deepEqual([speech.status, speech.body.engine], [200, "grok"]);
    const st = await s.b.call("POST", "/discord/voice/stream", { op: "status" }, auth);
    assert.deepEqual(st.body.layers.map((l: { id: string; loop: boolean }) => [l.id, l.loop]), [["music", true], ["line", false]]);
    const frames = s.port.voice.pump(3);
    assert.equal(frames[0].length, FRAME_BYTES);
    assert.equal(frames[0].readInt16LE(0), 250 + 0x0202, "wav at default gain 0.25 plus speech at gain 1");
    assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "add", id: "bad", audioBase64: "AAAA" }, auth)).body.error, "wav_format");
    assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "add", id: "both", text: "a", audioBase64: "AAAA" }, auth)).body.error, "layer_source");
    assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "remove", id: "music" }, auth)).body.removed, true);
    assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "dance" }, auth)).body.error, "voice_stream_op");
    assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "close" }, auth)).body.closed, true);
    assert.equal(s.port.voice.streams[0].closed, true);
    assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "status" }, auth)).body.open, false);
  } finally {
    await s.close();
    await grok.close();
  }
});

test("voice is off unless enabled; channel ids are validated", async () => {
  const s = await setup({ ...example.voice, enabled: false });
  try {
    const r = await s.b.call("POST", "/discord/voice/play", { channelId: VCH }, auth);
    assert.deepEqual([r.status, r.body.error], [503, "voice_disabled"]);
    assert.equal(s.port.voice.played.length, 0);
  } finally {
    await s.close();
  }
  assert.match(validateDiscordConfig({ ...example, voice: { enabled: true, channels: ["general"] } }).join(), /voice.channels must be voice channel ids/);
});

// ---- review nits ----
import { MAX_LAYERS } from "./mix.js";
import { MAX_PIPER_BYTES } from "./engines.js";
import { guardVoice } from "./guard.js";
import { FakeVoicePort } from "../../../test/helpers.js";

test("nit 4: a stream holds at most 16 layers (400 too_many_layers); replacing an id is fine", async () => {
  assert.equal(MAX_LAYERS, 16);
  const m = new PcmMixer();
  for (let i = 0; i < 16; i++) m.add({ id: `l${i}`, pcm: Buffer.alloc(FRAME_BYTES), loop: true, gain: 1 });
  assert.throws(() => m.add({ id: "l16", pcm: Buffer.alloc(FRAME_BYTES), loop: true, gain: 1 }), /too_many_layers/);
  m.add({ id: "l3", pcm: Buffer.alloc(FRAME_BYTES), loop: false, gain: 1 });
  const s = await setup({ ...example.voice, enabled: true });
  try {
    await s.b.call("POST", "/discord/voice/stream", { op: "open", channelId: VCH }, auth);
    const w = wav(48000, 2, Array(8).fill(1)).toString("base64");
    for (let i = 0; i < 16; i++) assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "add", id: `l${i}`, audioBase64: w }, auth)).status, 200);
    const over = await s.b.call("POST", "/discord/voice/stream", { op: "add", id: "l16", audioBase64: w }, auth);
    assert.deepEqual([over.status, over.body.error], [400, "too_many_layers"]);
  } finally {
    await s.close();
  }
});

test("nit 5: busy lock: concurrent play/open answer 409 voice_busy and never leak a stream", async () => {
  const s = await setup({ ...example.voice, enabled: true });
  try {
    let release!: () => void;
    s.port.voice.gate = new Promise<void>((r) => (release = r));
    const slowPlay = s.b.call("POST", "/discord/voice/play", { channelId: VCH }, auth);
    await new Promise((r) => setTimeout(r, 30));
    const open = await s.b.call("POST", "/discord/voice/stream", { op: "open", channelId: VCH }, auth);
    const play2 = await s.b.call("POST", "/discord/voice/play", { channelId: VCH }, auth);
    const close = await s.b.call("POST", "/discord/voice/stream", { op: "close" }, auth);
    assert.deepEqual([open.status, open.body.error, play2.status, play2.body.error, close.status], [409, "voice_busy", 409, "voice_busy", 409]);
    release();
    assert.equal((await slowPlay).status, 200);
    s.port.voice.gate = new Promise<void>((r) => (release = r));
    const slowOpen = s.b.call("POST", "/discord/voice/stream", { op: "open", channelId: VCH }, auth);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await s.b.call("POST", "/discord/voice/stream", { op: "open", channelId: VCH }, auth)).body.error, "voice_busy");
    release();
    assert.equal((await slowOpen).status, 200);
    assert.equal(s.port.voice.streams.length, 1, "exactly one stream opened");
  } finally {
    await s.close();
  }
  // Gateway-side backstop: no play while a stream is open, no two joins at once.
  const raw = new FakeVoicePort();
  const v = guardVoice(raw);
  const h = await v.openStream(VCH, () => Buffer.alloc(FRAME_BYTES));
  await assert.rejects(v.play(VCH, Buffer.alloc(4)), /voice_busy/);
  await assert.rejects(v.openStream(VCH, () => Buffer.alloc(FRAME_BYTES)), /voice_busy/);
  h.close();
  h.close();
  await v.play(VCH, Buffer.alloc(4));
  let release!: () => void;
  raw.gate = new Promise<void>((r) => (release = r));
  const p1 = v.play(VCH, Buffer.alloc(4));
  await assert.rejects(v.openStream(VCH, () => Buffer.alloc(FRAME_BYTES)), /voice_busy/);
  release();
  await p1;
  assert.equal(raw.played.length, 2);
});

test("nit 9: the Piper receive buffer is capped", async () => {
  assert.equal(MAX_PIPER_BYTES, 16 * 1024 * 1024);
  const piper = await mockPiper();
  try {
    await assert.rejects(synthesizePiper("hello", "127.0.0.1", piper.port, 5000, 1024), /piper_too_large/);
    assert.equal((await synthesizePiper("hello", "127.0.0.1", piper.port)).pcm.length, 4800);
  } finally {
    await piper.close();
  }
});
