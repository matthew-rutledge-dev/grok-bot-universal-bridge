import type { VoicePort, VoiceStreamHandle } from "../port.js";

/**
 * Wraps a raw voice implementation so it can never run a one-shot play (which
 * destroys the guild's voice connection when it ends) while a stream is open,
 * and never runs two joins at once. Throws "voice_busy" instead (HTTP 409).
 * VoiceService has its own lock in front; this is the gateway-side backstop.
 */
export function guardVoice(raw: VoicePort): VoicePort {
  let busy = false;
  let streamOpen = false;
  const claim = () => {
    if (busy || streamOpen) throw new Error("voice_busy");
    busy = true;
  };
  return {
    async play(channelId, pcm) {
      claim();
      try {
        await raw.play(channelId, pcm);
      } finally {
        busy = false;
      }
    },
    async openStream(channelId, nextFrame): Promise<VoiceStreamHandle> {
      claim();
      try {
        const h = await raw.openStream(channelId, nextFrame);
        streamOpen = true;
        let closed = false;
        return {
          close() {
            if (closed) return;
            closed = true;
            streamOpen = false;
            h.close();
          },
        };
      } finally {
        busy = false;
      }
    },
  };
}
