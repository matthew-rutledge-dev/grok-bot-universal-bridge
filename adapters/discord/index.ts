import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateRoutes } from "../../core/allowlist.js";
import type { AdapterContext, SourceAdapter } from "../../core/bridge.js";
import type { HeldItem } from "../../core/hold.js";
import type { HttpResponse } from "../../core/http.js";
import type { InboundEvent, Route } from "../../core/types.js";
import { chunk, formatPrompt, stripMention } from "./format.js";
import type { DiscordPort, IncomingDiscordMessage } from "./port.js";

/**
 * Discord source adapter.
 *
 * Inbound: Gateway messages -> InboundEvent. Guild messages match
 * { guild, channel }; direct messages match { dm: "true" }. Actor = user id,
 * groups = role ids. Bots are ignored unless ignoreBots is false.
 *
 * Status UI: when an event is held, ONE status message is posted as a reply
 * and then edited (delivered / gave up). No per-retry posts (rate limits).
 *
 * Reply: POST /discord/callback { channelId, content, replyToMessageId?, statusMessageId? }.
 * Only channels that appear in an enabled route (or a DM channel that already
 * passed the allowlist) can be posted to.
 */
export interface DiscordAdapterConfig {
  tokenRef: string;
  callbackTokenRef?: string;
  ignoreBots?: boolean;
  routes: Route[];
}

export const HOLD_STATUS_TEXT = "Bot is waking up, holding your message…";
export const HOLD_DELIVERED_TEXT = "Delivered. The bot is on it.";
export const HOLD_GAVE_UP_TEXT = "❌ Couldn't reach the bot, please try again.";
export const FAILED_TEXT = "❌ Couldn't deliver that message.";

export interface DiscordCallbackBody {
  channelId?: unknown;
  content?: unknown;
  replyToMessageId?: unknown;
  statusMessageId?: unknown;
  attachments?: unknown;
}

const SNOWFLAKE = /^\d{5,25}$/;

export function validateDiscordConfig(raw: unknown): string[] {
  const c = raw as Partial<DiscordAdapterConfig> | null;
  if (!c || typeof c !== "object") return ["discord: config is not an object"];
  const p = validateRoutes(c.routes, "discord");
  if (!c.tokenRef) p.push("discord: tokenRef required (env:NAME or file:/path)");
  for (const [i, r] of (c.routes ?? []).entries()) {
    const keys = Object.keys(r.match ?? {});
    const ok = (keys.length === 2 && keys.includes("guild") && keys.includes("channel")) || (keys.length === 1 && keys[0] === "dm");
    if (!ok) p.push(`discord.routes[${i}]: match must be { guild, channel } or { dm: "true" }`);
  }
  return p;
}

export function messageToEvent(
  m: IncomingDiscordMessage,
  botUserId: string | null,
  routes: Route[],
): { event?: InboundEvent; skip?: "bot_author" | "empty" } {
  const text = stripMention(m.content, botUserId);
  if (!text && !(m.attachments?.length)) return { skip: "empty" };
  const match: Record<string, string> = m.guildId ? { guild: m.guildId, channel: m.channelId } : { dm: "true" };
  const route = routes.find((r) => Object.keys(r.match).every((k) => r.match[k] === match[k]));
  const slug = typeof route?.slug === "string" && route.slug ? route.slug : m.guildId ? "channel" : "dm";
  return {
    event: {
      eventId: m.id,
      lane: m.channelId,
      actor: m.authorId,
      actorGroups: m.roleIds,
      match,
      addressed: m.guildId ? m.mentionsBot : true,
      prompt: formatPrompt({
        slug,
        messageId: m.id,
        guildId: m.guildId,
        channelId: m.channelId,
        userId: m.authorId,
        label: m.authorLabel,
        alias: route?.agent ?? "",
        text,
        channelName: m.channelName,
        attachments: m.attachments,
      }),
      metadata: { hop: `d:${slug}:${m.id}` },
      ref: m.guildId ? { channelId: m.channelId, messageId: m.id } : { channelId: m.channelId, messageId: m.id, dm: "true" },
    },
  };
}

export class DiscordAdapter implements SourceAdapter {
  readonly name = "discord";
  readonly routes: Route[];
  readonly callbackTokenRef?: string;
  readonly callbackMaxBytes = 64 * 1024;
  private ctx!: AdapterContext;
  /** DM channels that already passed the allowlist (replies may go there). Persisted in the data dir. */
  private readonly dmChannels = new Set<string>();
  private dmFile = "";

  constructor(
    private readonly cfg: DiscordAdapterConfig,
    private readonly port: DiscordPort,
  ) {
    const problems = validateDiscordConfig(cfg);
    if (problems.length) throw new Error(problems.join("; "));
    this.routes = cfg.routes;
    this.callbackTokenRef = cfg.callbackTokenRef;
  }

  init(ctx: AdapterContext): void {
    this.ctx = ctx;
    this.dmFile = ctx.dataFile("dm-channels.json");
    if (this.dmFile) {
      try {
        const raw = JSON.parse(readFileSync(this.dmFile, "utf8")) as { channels?: unknown };
        for (const c of Array.isArray(raw.channels) ? raw.channels : []) if (typeof c === "string" && SNOWFLAKE.test(c)) this.dmChannels.add(c);
      } catch {
        /* none yet */
      }
    }
  }

  /** Remember a DM channel that passed the allowlist (survives restarts). */
  private allowDmChannel(channelId: string): void {
    if (!SNOWFLAKE.test(channelId) || this.dmChannels.has(channelId)) return;
    this.dmChannels.add(channelId);
    if (!this.dmFile) return;
    try {
      mkdirSync(dirname(this.dmFile), { recursive: true });
      const tmp = `${this.dmFile}.tmp`;
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify({ version: 1, channels: [...this.dmChannels] }), { mode: 0o600 });
      renameSync(tmp, this.dmFile);
    } catch {
      this.ctx.log.warn("[discord] dm channel file write failed (memory only)");
    }
  }

  async start(): Promise<void> {
    const token = this.ctx.secret(this.cfg.tokenRef);
    if (!token) throw new Error("discord: bot token missing (fail-closed)");
    await this.port.connect(token, (m) => void this.onMessage(m));
    this.ctx.log.info(`[discord] connected routes=${this.routes.length}`);
  }

  async stop(): Promise<void> {
    await this.port.disconnect();
  }

  /** Public for tests and the local smoke run. */
  async onMessage(m: IncomingDiscordMessage) {
    if (m.authorIsBot && this.cfg.ignoreBots !== false) {
      this.ctx.audit({ action: "inbound", outcome: "skipped", reason: "bot_author", eventId: m.id, lane: m.channelId });
      return undefined;
    }
    const { event, skip } = messageToEvent(m, this.port.botUserId(), this.routes);
    if (!event) {
      this.ctx.audit({ action: "inbound", outcome: "skipped", reason: skip, eventId: m.id, lane: m.channelId });
      return undefined;
    }
    // Record an allowlisted DM channel BEFORE delivery, so a crash mid-hold still lets the reply through.
    if (!m.guildId && this.ctx.check(event).ok) this.allowDmChannel(m.channelId);
    return this.ctx.submit(event);
  }

  readonly ui = {
    holding: async (item: HeldItem) => {
      const ch = item.ref?.channelId;
      if (!ch) return undefined;
      // A held DM reloaded after a restart re-allows its reply channel.
      if (item.ref?.dm === "true") this.allowDmChannel(ch);
      if (item.statusRef) {
        await this.port.edit(ch, item.statusRef, HOLD_STATUS_TEXT);
        return item.statusRef;
      }
      return this.port.send(ch, HOLD_STATUS_TEXT, { replyTo: item.ref?.messageId });
    },
    delivered: async (item: HeldItem) => {
      const ch = item.ref?.channelId;
      if (ch && item.statusRef) await this.port.edit(ch, item.statusRef, HOLD_DELIVERED_TEXT);
    },
    failed: async (item: HeldItem, _err: unknown, info: { held: boolean }) => {
      const ch = item.ref?.channelId;
      if (!ch) return;
      const text = info.held ? HOLD_GAVE_UP_TEXT : FAILED_TEXT;
      if (item.statusRef) await this.port.edit(ch, item.statusRef, text);
      else await this.port.send(ch, text, { replyTo: item.ref?.messageId });
    },
  };

  /** Channels replies may target: enabled guild routes plus allowlisted DM channels. */
  replyAllowed(channelId: string): boolean {
    if (this.dmChannels.has(channelId)) return true;
    return this.routes.some((r) => r.enabled && r.match.channel === channelId);
  }

  async handleCallback(raw: unknown): Promise<HttpResponse> {
    const b = (raw ?? {}) as DiscordCallbackBody;
    const channelId = typeof b.channelId === "string" ? b.channelId : "";
    const content = typeof b.content === "string" ? b.content : "";
    if (!SNOWFLAKE.test(channelId)) return { status: 400, body: { ok: false, error: "channelId required" } };
    if (b.attachments !== undefined) return { status: 400, body: { ok: false, error: "attachments_not_supported_yet" } };
    if (!content.trim()) return { status: 400, body: { ok: false, error: "content required" } };
    if (content.length > 8000) return { status: 413, body: { ok: false, error: "content too long (max 8000)" } };
    if (!this.replyAllowed(channelId)) return { status: 403, body: { ok: false, error: "channel_not_allowlisted" } };
    const replyTo = typeof b.replyToMessageId === "string" && SNOWFLAKE.test(b.replyToMessageId) ? b.replyToMessageId : undefined;
    const statusId = typeof b.statusMessageId === "string" && SNOWFLAKE.test(b.statusMessageId) ? b.statusMessageId : undefined;
    const parts = chunk(content);
    const ids: string[] = [];
    try {
      let i = 0;
      if (statusId) {
        await this.port.edit(channelId, statusId, parts[0]);
        ids.push(statusId);
        i = 1;
      }
      for (; i < parts.length; i++) ids.push(await this.port.send(channelId, parts[i], { replyTo: ids.length === 0 ? replyTo : undefined }));
    } catch (err) {
      return { status: 502, body: { ok: false, error: "discord_send_failed", detail: (err as Error).name } };
    }
    return { status: 200, body: { ok: true, messageIds: ids } };
  }
}

export async function createDiscordAdapter(cfg: DiscordAdapterConfig, port?: DiscordPort): Promise<DiscordAdapter> {
  if (port) return new DiscordAdapter(cfg, port);
  const { createGatewayPort } = await import("./gateway.js");
  return new DiscordAdapter(cfg, await createGatewayPort());
}
