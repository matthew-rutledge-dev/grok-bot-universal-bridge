/**
 * The slice of Discord the adapter needs. gateway.ts implements it with
 * discord.js; tests and the local smoke run use an in-memory fake.
 */
export interface DiscordAttachmentRef {
  url: string;
  filename?: string;
  contentType?: string;
  size?: number;
}

export interface IncomingDiscordMessage {
  id: string;
  channelId: string;
  /** null for direct messages. */
  guildId: string | null;
  authorId: string;
  authorIsBot: boolean;
  /** Display label (display name / username). Shown to the agent only. */
  authorLabel: string;
  roleIds: string[];
  content: string;
  mentionsBot: boolean;
  channelName?: string;
  attachments?: DiscordAttachmentRef[];
}

export interface DiscordPort {
  /** Connect and call onMessage for every message the bot can see. */
  connect(token: string, onMessage: (m: IncomingDiscordMessage) => void): Promise<void>;
  disconnect(): Promise<void>;
  botUserId(): string | null;
  /** Post a message. Returns its id. */
  send(channelId: string, content: string, opts?: { replyTo?: string }): Promise<string>;
  /** Edit a message the bot posted. */
  edit(channelId: string, messageId: string, content: string): Promise<void>;
}
