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
  /** Raw names for the user directory (optional; authorLabel is the fallback). */
  authorUsername?: string;
  authorGlobalName?: string | null;
  authorDisplayName?: string | null;
  roleIds: string[];
  content: string;
  mentionsBot: boolean;
  channelName?: string;
  attachments?: DiscordAttachmentRef[];
}

/** A file to post (already validated against the attachment allowlist). */
export interface OutgoingFile {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

/** Handle for an open voice stream; frames are pulled every 20 ms. */
export interface VoiceStreamHandle {
  close(): void;
}

/**
 * Voice: join a guild voice channel and play 48 kHz stereo s16le PCM.
 * Errors use the codes "not_a_voice_channel" or anything else (= 502).
 */
export interface VoicePort {
  /** Join, play the clip, leave. */
  play(channelId: string, pcm: Buffer): Promise<void>;
  /**
   * Join and keep playing nextFrame() (3840-byte frames) until close().
   * onEnded fires (once) when the stream ends WITHOUT close(): Discord dropped the
   * connection, the bot was moved/kicked, or the player failed.
   */
  openStream(channelId: string, nextFrame: () => Buffer, onEnded?: () => void): Promise<VoiceStreamHandle>;
}

export interface DiscordPort {
  /** Connect and call onMessage for every message the bot can see. */
  connect(
    token: string,
    onMessage: (m: IncomingDiscordMessage) => void,
    /** Interaction users (names only, for the user directory). */
    onUser?: (u: { id: string; username?: string; globalName?: string | null; displayName?: string | null; bot?: boolean }) => void,
  ): Promise<void>;
  /** Gateway logged in and ready (healthz discordReady). */
  isReady?(): boolean;
  /** Show "typing…" in a channel (lasts about 10 s). */
  typing?(channelId: string): Promise<void>;
  disconnect(): Promise<void>;
  botUserId(): string | null;
  /** Post a message. Returns its id. */
  send(channelId: string, content: string, opts?: { replyTo?: string; files?: OutgoingFile[] }): Promise<string>;
  /** Edit a message the bot posted. Files are attached to the edited message. */
  edit(channelId: string, messageId: string, content: string, opts?: { files?: OutgoingFile[] }): Promise<void>;
  /** React to a message (planner accepted = ✅). */
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Start a thread on a message and post text into it (planner threadContent). */
  thread(channelId: string, messageId: string, name: string, parts: string[]): Promise<void>;
  /** Open (or reuse) the DM channel with a user. Returns the DM channel id. */
  openDm?(userId: string): Promise<string>;
  /** Voice, when the gateway supports it. */
  readonly voice?: VoicePort;
}
