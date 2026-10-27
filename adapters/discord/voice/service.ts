import type { HttpResponse } from "../../../core/http.js";
import type { VoicePort, VoiceStreamHandle } from "../port.js";
import { resolveVoiceEngine, synthesizeGrokVoice, synthesizePiper } from "./engines.js";
import { buildTonePcm, clampGain, mixLocalBed, PcmMixer, toVoicePcm, wavToVoicePcm } from "./mix.js";

/**
 * POST /discord/voice/play and /discord/voice/stream, ported from the existing
 * bridge. Same bodies, same error codes. Differences: voice is off unless
 * `voice.enabled`, and only channels in `voice.channels` can be joined
 * (deny by default). Piper host/port and the Grok Voice key come from refs.
 *
 * play:   { channelId, text?, voice?: "local"|"piper"|"grok"|"grok-voice-latest"|"grok-voice-3.0", bed?: true }
 *         no text = 2 s tone. 409 while a stream is open.
 * stream: { op: "open", channelId } | { op: "add", id, text, voice? } | { op: "add", id, audioBase64 (16-bit PCM wav, <= 3 min), loop?, gain? }
 *         | { op: "remove", id } | { op: "status" } | { op: "close" }
 *         Speech gain defaults to 1 (one-shot); wav defaults to loop + gain 0.25.
 */
export interface VoiceConfig {
  enabled?: boolean;
  /** Voice channel ids the bot may join. Empty = none. */
  channels?: string[];
  /** Local Piper (Wyoming protocol) host and port, as env:/file: refs. */
  piperHostRef?: string;
  piperPortRef?: string;
  /** Grok Voice API key ref (only used when a request asks for voice: "grok"). */
  grokApiKeyRef?: string;
}

export interface VoiceDeps {
  port: VoicePort | undefined;
  secret: (ref: string | undefined) => string | undefined;
  grokUrl?: string;
}

const CHANNEL = /^[0-9]{17,20}$/;
const KNOWN_ADD = new Set(["too_many_layers", "voice_engine", "wav_format", "audio_too_long", "pcm_format", "grok_voice_not_configured", "piper_not_configured", "piper_format", "piper_empty"]);
const NOT_CONFIGURED = new Set(["grok_voice_not_configured", "piper_not_configured"]);

export function validateVoiceConfig(v: unknown): string[] {
  if (v === undefined) return [];
  const c = v as VoiceConfig;
  const p: string[] = [];
  if (!c || typeof c !== "object") return ["discord.voice must be an object"];
  if (c.channels !== undefined && (!Array.isArray(c.channels) || c.channels.some((x) => typeof x !== "string" || !CHANNEL.test(x)))) {
    p.push("discord.voice.channels must be voice channel ids");
  }
  return p;
}

const err = (status: number, error: string): HttpResponse => ({ status, body: { ok: false, error } });
const cleanId = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 64) : "");

export class VoiceService {
  private stream: { channelId: string; mixer: PcmMixer; handle: VoiceStreamHandle } | null = null;
  /**
   * One voice operation at a time (play, or a stream open/close). Without it a
   * play racing an open could leak a stream or destroy the shared guild
   * connection the stream uses. While busy: 409 voice_busy.
   */
  private busy: "play" | "open" | null = null;

  private async exclusive(kind: "play" | "open", fn: () => Promise<HttpResponse>): Promise<HttpResponse> {
    if (this.busy) return err(409, "voice_busy");
    this.busy = kind;
    try {
      return await fn();
    } finally {
      this.busy = null;
    }
  }

  constructor(
    private readonly cfg: VoiceConfig,
    private readonly deps: VoiceDeps,
  ) {}

  status() {
    if (!this.stream) return { open: false, channelId: null as string | null, layers: [] as ReturnType<PcmMixer["list"]> };
    return { open: true, channelId: this.stream.channelId, layers: this.stream.mixer.list() };
  }

  private gate(channelId: string): HttpResponse | undefined {
    if (!this.cfg.enabled) return err(503, "voice_disabled");
    if (!this.deps.port) return err(503, "voice_not_available");
    if (!channelId || !CHANNEL.test(channelId)) return err(400, "channel_id_required");
    if (!(this.cfg.channels ?? []).includes(channelId)) return err(403, "voice_channel_not_allowlisted");
    return undefined;
  }

  private async speak(text: string, engine: "local" | "grok"): Promise<Buffer> {
    if (engine === "grok") {
      const key = this.deps.secret(this.cfg.grokApiKeyRef);
      if (!key) throw new Error("grok_voice_not_configured");
      return toVoicePcm(await synthesizeGrokVoice(text, key, this.deps.grokUrl));
    }
    const host = this.deps.secret(this.cfg.piperHostRef);
    const port = Number(this.deps.secret(this.cfg.piperPortRef));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("piper_not_configured");
    return toVoicePcm(await synthesizePiper(text, host, port));
  }

  async play(raw: unknown): Promise<HttpResponse> {
    const t0 = Date.now();
    const body = (raw ?? {}) as { channelId?: unknown; text?: unknown; voice?: unknown; bed?: unknown };
    const channelId = cleanId(body.channelId);
    const denied = this.gate(channelId);
    if (denied) return this.done(denied, t0);
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 240) : "";
    let engine: "local" | "grok";
    try {
      engine = resolveVoiceEngine(body.voice);
    } catch {
      return this.done(err(400, "voice_engine"), t0);
    }
    if (this.stream) return this.done(err(409, "voice_stream_open"), t0);
    return this.exclusive("play", () => this.playNow(channelId, text, engine, body.bed === true, t0));
  }

  private async playNow(channelId: string, text: string, engine: "local" | "grok", bed: boolean, t0: number): Promise<HttpResponse> {
    const body = { bed };
    try {
      let pcm = text ? await this.speak(text, engine) : buildTonePcm(2);
      if (text && body.bed === true) pcm = mixLocalBed(pcm);
      await this.deps.port!.play(channelId, pcm);
      return this.done({ status: 200, body: { ok: true, channelId, spoke: Boolean(text), engine, bed: body.bed === true } }, t0);
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (msg === "not_a_voice_channel") return this.done(err(400, msg), t0);
      if (msg === "voice_busy") return this.done(err(409, msg), t0);
      if (NOT_CONFIGURED.has(msg)) return this.done(err(503, msg), t0);
      return this.done(err(502, "voice_play_failed"), t0);
    }
  }

  async streamOp(raw: unknown): Promise<HttpResponse> {
    const t0 = Date.now();
    const body = (raw ?? {}) as Record<string, unknown>;
    const op = typeof body.op === "string" ? body.op : "";
    if (!this.cfg.enabled) return this.done(err(503, "voice_disabled"), t0);
    if (op === "status") return { status: 200, body: { ok: true, ...this.status() } };
    if (op === "close") {
      if (this.busy) return err(409, "voice_busy");
      return this.done({ status: 200, body: { ok: true, closed: this.close() } }, t0);
    }
    if (op === "open") {
      const channelId = cleanId(body.channelId);
      const denied = this.gate(channelId);
      if (denied) return this.done(denied, t0);
      if (this.stream?.channelId === channelId) return { status: 200, body: { ok: true, ...this.status() } };
      return this.exclusive("open", async () => {
        this.close();
        const mixer = new PcmMixer();
        try {
          const handle = await this.deps.port!.openStream(channelId, () => mixer.nextFrame());
          this.stream = { channelId, mixer, handle };
          return this.done({ status: 200, body: { ok: true, ...this.status() } }, t0);
        } catch (e) {
          const msg = (e as Error)?.message ?? "";
          if (msg === "voice_busy") return err(409, msg);
          return this.done(msg === "not_a_voice_channel" ? err(400, msg) : err(502, "voice_stream_failed"), t0);
        }
      });
    }
    const mixer = this.stream?.mixer;
    if (!mixer) return this.done(err(409, "voice_stream_closed"), t0);
    const id = cleanId(body.id);
    if (op === "remove") {
      if (!id) return this.done(err(400, "layer_id_required"), t0);
      return this.done({ status: 200, body: { ok: true, removed: mixer.remove(id), ...this.status() } }, t0);
    }
    if (op !== "add") return this.done(err(400, "voice_stream_op"), t0);
    if (!id) return this.done(err(400, "layer_id_required"), t0);
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 240) : "";
    const audioBase64 = typeof body.audioBase64 === "string" ? body.audioBase64 : "";
    if (Boolean(text) === Boolean(audioBase64)) return this.done(err(400, "layer_source"), t0);
    try {
      let pcm: Buffer;
      let loop = body.loop === true;
      let gain = typeof body.gain === "number" ? body.gain : NaN;
      let engine: "local" | "grok" | "wav" = "wav";
      if (text) {
        engine = resolveVoiceEngine(body.voice);
        pcm = await this.speak(text, engine);
        if (!Number.isFinite(gain)) gain = 1;
      } else {
        pcm = wavToVoicePcm(Buffer.from(audioBase64, "base64"));
        loop = body.loop !== false;
        if (!Number.isFinite(gain)) gain = 0.25;
      }
      mixer.add({ id, pcm, loop, gain: clampGain(gain) });
      return this.done({ status: 200, body: { ok: true, engine, ...this.status() } }, t0);
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      const status = NOT_CONFIGURED.has(msg) ? 503 : KNOWN_ADD.has(msg) ? 400 : 502;
      return this.done(err(status, KNOWN_ADD.has(msg) ? msg : "voice_stream_failed"), t0);
    }
  }

  close(): boolean {
    if (!this.stream) return false;
    try {
      this.stream.handle.close();
    } catch {
      /* already gone */
    }
    this.stream = null;
    return true;
  }

  /** The core's authedRoute writes the audit line (action voice, outcome, status, error code). */
  private done(r: HttpResponse, _t0: number): HttpResponse {
    return r;
  }
}
