import { Readable } from "node:stream";
import type { DiscordPort, IncomingDiscordMessage, OutgoingFile, VoicePort } from "./port.js";
import { guardVoice } from "./voice/guard.js";
import { FRAME_BYTES } from "./voice/mix.js";

/**
 * discord.js implementation of DiscordPort. Loaded lazily so tests and the
 * other adapters never need a Discord connection.
 *
 * Intents: Guilds, GuildMessages, MessageContent, DirectMessages, GuildVoiceStates.
 * Bot permissions: View Channel, Send Messages, Read Message History, Attach Files,
 * Add Reactions, Create Public Threads, Send Messages in Threads, and Connect + Speak
 * for voice. Voice needs @discordjs/voice and an Opus library (opusscript).
 */
export async function createGatewayPort(): Promise<DiscordPort> {
  const djs = await import("discord.js");
  const { Client, GatewayIntentBits, Partials, ChannelType, AttachmentBuilder } = djs;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
  });

  type Msg = { id: string; react(e: string): Promise<unknown>; startThread(o: { name: string }): Promise<{ send(o: { content: string }): Promise<unknown> }> };
  async function textChannel(channelId: string) {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !("send" in ch) || !("messages" in ch)) throw new Error("channel is not text-capable");
    return ch as unknown as {
      send(o: Record<string, unknown>): Promise<{ id: string }>;
      messages: { edit(id: string, o: Record<string, unknown>): Promise<unknown>; delete(id: string): Promise<unknown>; fetch(id: string): Promise<Msg> };
    };
  }
  const files = (f: OutgoingFile[] | undefined) => (f?.length ? { files: f.map((x) => new AttachmentBuilder(x.buffer, { name: x.filename })) } : {});

  async function voiceChannel(channelId: string) {
    const ch = await client.channels.fetch(channelId);
    if (!ch || ch.type !== ChannelType.GuildVoice || !ch.guild) throw new Error("not_a_voice_channel");
    return ch;
  }

  // One guild voice connection is shared: guardVoice refuses (voice_busy) a play
  // while a stream is open or a join is in flight.
  const voice: VoicePort = guardVoice({ play: playNow, openStream: openNow });

  async function playNow(channelId: string, pcm: Buffer) {
    const ch = await voiceChannel(channelId);
    const v = await import("@discordjs/voice");
    const connection = v.joinVoiceChannel({ channelId: ch.id, guildId: ch.guild.id, adapterCreator: ch.guild.voiceAdapterCreator, selfDeaf: true });
    const seconds = pcm.length / (48000 * 4);
    try {
      await v.entersState(connection, v.VoiceConnectionStatus.Ready, 15_000);
      const player = v.createAudioPlayer();
      connection.subscribe(player);
      player.play(v.createAudioResource(Readable.from(pcm), { inputType: v.StreamType.Raw }));
      await v.entersState(player, v.AudioPlayerStatus.Playing, 10_000);
      await v.entersState(player, v.AudioPlayerStatus.Idle, Math.max(15_000, Math.ceil(seconds * 1000) + 5_000));
    } finally {
      connection.destroy();
    }
  }

  async function openNow(channelId: string, nextFrame: () => Buffer, onEnded?: () => void) {
    const ch = await voiceChannel(channelId);
    const v = await import("@discordjs/voice");
    const connection = v.joinVoiceChannel({ channelId: ch.id, guildId: ch.guild.id, adapterCreator: ch.guild.voiceAdapterCreator, selfDeaf: true });
    const stream = new Readable({ read() {} });
    const player = v.createAudioPlayer();
    try {
      await v.entersState(connection, v.VoiceConnectionStatus.Ready, 15_000);
      connection.subscribe(player);
      stream.push(Buffer.alloc(FRAME_BYTES));
      player.play(v.createAudioResource(stream, { inputType: v.StreamType.Raw }));
      await v.entersState(player, v.AudioPlayerStatus.Playing, 10_000);
    } catch (err) {
      connection.destroy();
      stream.destroy();
      throw err;
    }
    const timer = setInterval(() => {
      if (!stream.push(nextFrame())) stream.resume();
    }, 20);
    timer.unref?.();
    let done = false;
    const end = (byUs: boolean) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      stream.push(null);
      try {
        connection.destroy();
      } catch {
        /* already destroyed */
      }
      if (!byUs) onEnded?.();
    };
    // Discord dropped us: give it 5 s to reconnect on its own (standard @discordjs/voice
    // pattern), otherwise end the stream so the busy lock is released.
    connection.on(v.VoiceConnectionStatus.Disconnected, () => {
      Promise.race([
        v.entersState(connection, v.VoiceConnectionStatus.Signalling, 5_000),
        v.entersState(connection, v.VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => end(false));
    });
    connection.on(v.VoiceConnectionStatus.Destroyed, () => end(false));
    player.on("error", () => end(false));
    return { close: () => end(true) };
  }

  return {
    voice,
    async connect(token, onMessage, onUser) {
      client.on("interactionCreate", (i) => {
        const member = i.member as { displayName?: string } | null;
        onUser?.({ id: i.user.id, username: i.user.username, globalName: i.user.globalName, displayName: member?.displayName, bot: i.user.bot });
      });
      client.on("messageCreate", (msg) => {
        const me = client.user?.id ?? null;
        const m: IncomingDiscordMessage = {
          id: msg.id,
          channelId: msg.channelId,
          guildId: msg.guildId ?? null,
          authorId: msg.author.id,
          authorIsBot: msg.author.bot,
          authorLabel: msg.member?.displayName ?? msg.author.globalName ?? msg.author.username,
          authorUsername: msg.author.username,
          authorGlobalName: msg.author.globalName,
          authorDisplayName: msg.member?.displayName,
          roleIds: msg.member ? [...msg.member.roles.cache.keys()] : [],
          content: msg.content,
          mentionsBot: Boolean(me && msg.mentions.users.has(me)),
          channelName:
            msg.channel.type === ChannelType.DM ? undefined : ("name" in msg.channel ? String(msg.channel.name ?? "") : undefined),
          // URL refs only (CDN url, fallback proxyURL). Voice messages arrive here as audio/ogg attachments.
          attachments: [...msg.attachments.values()]
            .map((a) => ({
              url: a.url || a.proxyURL,
              filename: a.name ?? undefined,
              contentType: a.contentType ?? undefined,
              size: a.size,
            }))
            .filter((a) => Boolean(a.url)),
        };
        onMessage(m);
      });
      await client.login(token);
    },
    async disconnect() {
      await client.destroy();
    },
    botUserId: () => client.user?.id ?? null,
    isReady: () => client.isReady(),
    async typing(channelId) {
      const ch = await client.channels.fetch(channelId);
      if (ch && "sendTyping" in ch) await (ch as { sendTyping(): Promise<unknown> }).sendTyping();
    },
    async send(channelId, content, opts) {
      const ch = await textChannel(channelId);
      const sent = await ch.send({
        content,
        ...files(opts?.files),
        ...(opts?.replyTo ? { reply: { messageReference: opts.replyTo, failIfNotExists: false } } : {}),
      });
      return sent.id;
    },
    async openDm(userId) {
      const user = await client.users.fetch(userId);
      return (await user.createDM()).id;
    },
    async edit(channelId, messageId, content, opts) {
      const ch = await textChannel(channelId);
      await ch.messages.edit(messageId, { content, ...files(opts?.files) });
    },
    async delete(channelId, messageId) {
      const ch = await textChannel(channelId);
      await ch.messages.delete(messageId);
    },
    async react(channelId, messageId, emoji) {
      const ch = await textChannel(channelId);
      await (await ch.messages.fetch(messageId)).react(emoji);
    },
    async thread(channelId, messageId, name, parts) {
      const ch = await textChannel(channelId);
      const t = await (await ch.messages.fetch(messageId)).startThread({ name: name.slice(0, 100) || "Details" });
      for (const p of parts) await t.send({ content: p });
    },
  };
}
