import net from "node:net";
import WebSocket from "ws";
import type { PcmClip } from "./mix.js";

/** Ported from the existing Discord bridge (piper.ts, grok-voice.ts). Host, port and key come from refs. */
export const GROK_VOICE_URL = "wss://api.x.ai/v1/realtime?model=grok-voice-latest";

/** Ask a Wyoming-protocol Piper service (host/port from refs) for one spoken line. */
export function synthesizePiper(
  text: string,
  host: string,
  port: number,
  timeoutMs = 15_000,
): Promise<PcmClip> {
  const spoken = text.trim().slice(0, 240);
  if (!spoken) return Promise.reject(new Error("piper_text_required"));
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const chunks: Buffer[] = [];
    let buf = Buffer.alloc(0);
    let rate = 22050;
    let channels = 1;
    let width = 2;
    let settled = false;
    const finish = (err?: Error, clip?: PcmClip) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(clip as PcmClip);
    };
    const timer = setTimeout(() => finish(new Error("piper_timeout")), timeoutMs);
    socket.on("error", (err) => finish(err));
    socket.on("connect", () => {
      const data = Buffer.from(JSON.stringify({ text: spoken }), "utf8");
      const header = JSON.stringify({
        type: "synthesize",
        data_length: data.length,
        version: "1.6.0",
      });
      socket.write(header + "\n");
      socket.write(data);
    });
    const pump = () => {
      while (!settled) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        let ev: { type?: string; data_length?: number; payload_length?: number; data?: Record<string, number> };
        try {
          ev = JSON.parse(buf.subarray(0, nl).toString("utf8"));
        } catch {
          finish(new Error("piper_bad_event"));
          return;
        }
        const dataLen = Number(ev.data_length || 0);
        const payloadLen = Number(ev.payload_length || 0);
        const need = nl + 1 + dataLen + payloadLen;
        if (buf.length < need) return;
        const dataBytes = buf.subarray(nl + 1, nl + 1 + dataLen);
        const payload = buf.subarray(nl + 1 + dataLen, need);
        buf = buf.subarray(need);
        let data: Record<string, number> | undefined = ev.data;
        if (dataBytes.length) {
          try {
            data = JSON.parse(dataBytes.toString("utf8")) as Record<string, number>;
          } catch {
            finish(new Error("piper_bad_event"));
            return;
          }
        }
        if (ev.type === "audio-start" && data) {
          rate = Number(data.rate || rate);
          channels = Number(data.channels || channels);
          width = Number(data.width || width);
        }
        if (ev.type === "audio-chunk" && payload.length) chunks.push(Buffer.from(payload));
        if (ev.type === "error") {
          finish(new Error("piper_error"));
          return;
        }
        if (ev.type === "audio-stop") {
          finish(undefined, { pcm: Buffer.concat(chunks), rate, channels, width });
          return;
        }
      }
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      pump();
    });
    socket.on("close", () => {
      if (!settled) finish(new Error("piper_closed"));
    });
  });
}

/** Local Piper unless the caller explicitly asks for Grok Voice. */
export function resolveVoiceEngine(raw: unknown): "local" | "grok" {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value || value === "local" || value === "piper") return "local";
  if (value === "grok" || value === "grok-voice-latest" || value === "grok-voice-3.0") {
    return "grok";
  }
  throw new Error("voice_engine");
}

/**
 * Speak one line with the Voice Agent API.
 * `grok-voice-latest` is the Voice 3.0 alias. Output is 48 kHz mono s16le.
 */
export function synthesizeGrokVoice(
  text: string,
  apiKey: string,
  url = GROK_VOICE_URL,
  timeoutMs = 20_000,
): Promise<PcmClip> {
  const spoken = text.trim().slice(0, 240);
  if (!spoken) return Promise.reject(new Error("grok_text_required"));
  if (!apiKey.trim()) return Promise.reject(new Error("grok_voice_not_configured"));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err?: Error, clip?: PcmClip) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve(clip as PcmClip);
    };
    const timer = setTimeout(() => finish(new Error("grok_voice_timeout")), timeoutMs);
    ws.on("error", () => finish(new Error("grok_voice_transport")));
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: "ara",
          instructions: "Read the user message aloud exactly. Do not add words.",
          turn_detection: null,
          audio: {
            output: { format: { type: "audio/pcm", rate: 48000 } },
          },
        },
      }));
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: spoken }],
        },
      }));
      ws.send(JSON.stringify({ type: "response.create" }));
    });
    ws.on("message", (data) => {
      let event: { type?: string; delta?: string };
      try {
        event = JSON.parse(data.toString()) as { type?: string; delta?: string };
      } catch {
        return;
      }
      if (event.type === "response.output_audio.delta" && event.delta) {
        chunks.push(Buffer.from(event.delta, "base64"));
      }
      if (event.type === "error") finish(new Error("grok_voice_error"));
      if (event.type === "response.done" || event.type === "response.output_audio.done") {
        if (!chunks.length) {
          finish(new Error("grok_voice_empty"));
          return;
        }
        finish(undefined, {
          pcm: Buffer.concat(chunks),
          rate: 48000,
          channels: 1,
          width: 2,
        });
      }
    });
  });
}
