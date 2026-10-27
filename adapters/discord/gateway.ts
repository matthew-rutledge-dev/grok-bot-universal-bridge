import type { DiscordPort, IncomingDiscordMessage } from "./port.js";

/**
 * discord.js implementation of DiscordPort. Loaded lazily so tests and the
 * other adapters never need a Discord connection.
 *
 * Intents: Guilds, GuildMessages, MessageContent, DirectMessages.
 * Bot permissions: View Channel, Send Messages, Read Message History.
 */
export async function createGatewayPort(): Promise<DiscordPort> {
  const djs = await import("discord.js");
  const { Client, GatewayIntentBits, Partials, ChannelType } = djs;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
  });

  async function textChannel(channelId: string) {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !("send" in ch) || !("messages" in ch)) throw new Error("channel is not text-capable");
    return ch as unknown as {
      send(o: { content: string; reply?: { messageReference: string; failIfNotExists: boolean } }): Promise<{ id: string }>;
      messages: { edit(id: string, o: { content: string }): Promise<unknown> };
    };
  }

  return {
    async connect(token, onMessage) {
      client.on("messageCreate", (msg) => {
        const me = client.user?.id ?? null;
        const m: IncomingDiscordMessage = {
          id: msg.id,
          channelId: msg.channelId,
          guildId: msg.guildId ?? null,
          authorId: msg.author.id,
          authorIsBot: msg.author.bot,
          authorLabel: msg.member?.displayName ?? msg.author.globalName ?? msg.author.username,
          roleIds: msg.member ? [...msg.member.roles.cache.keys()] : [],
          content: msg.content,
          mentionsBot: Boolean(me && msg.mentions.users.has(me)),
          channelName:
            msg.channel.type === ChannelType.DM ? undefined : ("name" in msg.channel ? String(msg.channel.name ?? "") : undefined),
          attachments: [...msg.attachments.values()].map((a) => ({
            url: a.url,
            filename: a.name ?? undefined,
            contentType: a.contentType ?? undefined,
            size: a.size,
          })),
        };
        onMessage(m);
      });
      await client.login(token);
    },
    async disconnect() {
      await client.destroy();
    },
    botUserId: () => client.user?.id ?? null,
    async send(channelId, content, opts) {
      const ch = await textChannel(channelId);
      const sent = await ch.send({
        content,
        ...(opts?.replyTo ? { reply: { messageReference: opts.replyTo, failIfNotExists: false } } : {}),
      });
      return sent.id;
    },
    async edit(channelId, messageId, content) {
      const ch = await textChannel(channelId);
      await ch.messages.edit(messageId, { content });
    },
  };
}
