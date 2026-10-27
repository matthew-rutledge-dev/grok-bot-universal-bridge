import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateRoutes } from "../../core/allowlist.js";
import type { AdapterContext, SourceAdapter } from "../../core/bridge.js";
import type { HeldItem } from "../../core/hold.js";
import type { HttpResponse } from "../../core/http.js";
import type { InboundEvent, Route } from "../../core/types.js";
import type { SubmitResult } from "../../core/bridge.js";
import {
  AttachmentError,
  attachmentHttpStatus,
  MAX_TOTAL_ATTACHMENT_BYTES,
  mimeKind,
  normalizeMime,
  resolveJsonAttachments,
  validateAllowHttpHosts,
  wakeRefs,
  type ResolvedAttachment,
} from "./attachments.js";
import { chunk, formatPrompt, stripMention } from "./format.js";
import {
  invokePlanner,
  PLANNER_HANDLER,
  PLANNER_PULSE_MS,
  PLANNER_START_FAILED_TEXT,
  PlannerStatusBook,
  plannerImageFields,
  plannerUserSignal,
  workingProgressText,
  type PlannerUserSignal,
} from "./planner.js";
import type { DiscordPort, IncomingDiscordMessage } from "./port.js";
import { validateVoiceConfig, VoiceService, type VoiceConfig } from "./voice/service.js";

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
 * Attachments: inbound refs only (see attachments.ts); callbacks may attach
 * files (base64 data or https url), checked against the MIME allowlist and caps.
 *
 * Planner routes (`handler: "local-planner"`) skip the agent: see planner.ts.
 *
 * Voice: POST /discord/voice/play and /discord/voice/stream (callback token),
 * see voice/service.ts.
 *
 * Reply: POST /discord/callback { channelId, content?, attachments?, replyToMessageId?,
 * statusMessageId?, threadContent? }. Only channels that appear in an enabled
 * route (or a DM channel that already passed the allowlist) can be posted to.
 */
export interface DiscordAdapterConfig {
  tokenRef: string;
  callbackTokenRef?: string;
  ignoreBots?: boolean;
  routes: Route[];
  attachments?: {
    /** Loopback hosts allowed over plain http for callback url attachments (tests / local smoke only). */
    allowHttpHosts?: string[];
  };
  planner?: {
    /** env:/file: ref holding the planner listener URL (http or https). */
    urlRef: string;
    /** env:/file: ref holding the planner bearer token. */
    tokenRef: string;
    /** Callback URL handed to the planner. Default: this bridge's public /discord/callback. */
    callbackUrl?: string;
    /** Stop the 5 s progress edits after this long (default 30 min). The message is left as is. */
    pulseMaxMs?: number;
  };
  voice?: VoiceConfig;
}

export interface DiscordAdapterOptions {
  /** Used for callback url attachments and the planner call. */
  fetchImpl?: typeof fetch;
  /** Test hook: Grok Voice websocket URL. */
  grokVoiceUrl?: string;
  /** Planner pulse interval (default 5 s). */
  pulseMs?: number;
}

export const PLANNER_DONE_EMOJI = "✅";

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
  threadContent?: unknown;
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
    if (r.handler !== undefined && r.handler !== PLANNER_HANDLER) p.push(`discord.routes[${i}]: handler must be "${PLANNER_HANDLER}" or unset`);
  }
  if ((c.routes ?? []).some((r) => r.handler === PLANNER_HANDLER) && (!c.planner?.urlRef || !c.planner?.tokenRef)) {
    p.push("discord.planner.urlRef and tokenRef required when a route uses the local-planner handler");
  }
  if (c.planner?.callbackUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(String(c.planner.callbackUrl))) {
    p.push("discord.planner.callbackUrl must be an http(s) URL");
  }
  p.push(...validateAllowHttpHosts(c.attachments?.allowHttpHosts), ...validateVoiceConfig(c.voice));
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
        attachments: wakeRefs(m.attachments),
      }),
      metadata: { hop: `d:${slug}:${m.id}`, ...(m.attachments?.length ? { attachments: wakeRefs(m.attachments) } : {}) },
      ref: m.guildId ? { channelId: m.channelId, messageId: m.id } : { channelId: m.channelId, messageId: m.id, dm: "true" },
    },
  };
}

export class DiscordAdapter implements SourceAdapter {
  readonly name = "discord";
  readonly routes: Route[];
  readonly callbackTokenRef?: string;
  /** 25 MiB of files as base64 plus JSON overhead. */
  readonly callbackMaxBytes = Math.ceil((MAX_TOTAL_ATTACHMENT_BYTES * 4) / 3) + 1024 * 1024;
  private ctx!: AdapterContext;
  /** DM channels that already passed the allowlist (replies may go there). Persisted in the data dir. */
  private readonly dmChannels = new Set<string>();
  private dmFile = "";
  readonly planner = new PlannerStatusBook();
  private readonly plannerSeen = new Set<string>();
  private voice?: VoiceService;

  constructor(
    private readonly cfg: DiscordAdapterConfig,
    private readonly port: DiscordPort,
    private readonly opts: DiscordAdapterOptions = {},
  ) {
    const problems = validateDiscordConfig(cfg);
    if (problems.length) throw new Error(problems.join("; "));
    this.routes = cfg.routes;
    this.callbackTokenRef = cfg.callbackTokenRef;
  }

  init(ctx: AdapterContext): void {
    this.ctx = ctx;
    if (this.cfg.voice) {
      const voice = new VoiceService(this.cfg.voice, { port: this.port.voice, secret: (r) => ctx.secret(r), grokUrl: this.opts.grokVoiceUrl });
      this.voice = voice;
      const max = { maxBytes: 24 * 1024 * 1024 };
      ctx.authedRoute("POST", "voice/play", "voice", (req) => voice.play(req.body), max);
      ctx.authedRoute("POST", "voice/stream", "voice", (req) => voice.streamOp(req.body), max);
    }
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
    this.voice?.close();
    this.planner.clear();
    await this.port.disconnect();
  }

  /** Public for tests and the local smoke run. */
  async onMessage(m: IncomingDiscordMessage): Promise<SubmitResult | PlannerStarted | undefined> {
    if (m.authorIsBot && this.cfg.ignoreBots !== false) {
      this.ctx.audit({ action: "inbound", outcome: "skipped", reason: "bot_author", eventId: m.id, lane: m.channelId });
      return undefined;
    }
    const { event, skip } = messageToEvent(m, this.port.botUserId(), this.routes);
    if (!event) {
      this.ctx.audit({ action: "inbound", outcome: "skipped", reason: skip, eventId: m.id, lane: m.channelId });
      return undefined;
    }
    const authz = this.ctx.check(event);
    const refs = wakeRefs(m.attachments);
    if (authz.ok && refs.length) {
      // Content-free: count, declared bytes, kinds. No names, no URLs.
      this.ctx.audit({
        action: "attachment",
        outcome: "ok",
        reason: "inbound_refs",
        eventId: m.id,
        lane: m.channelId,
        count: refs.length,
        bytes: refs.reduce((n, r) => n + (Number.isFinite(r.size) ? Number(r.size) : 0), 0),
        kinds: kindsOf(refs.map((r) => normalizeMime(r.contentType, r.filename ?? ""))),
      });
    }
    // Record an allowlisted DM channel BEFORE delivery, so a crash mid-hold still lets the reply through.
    if (!m.guildId && authz.ok) this.allowDmChannel(m.channelId);
    if (authz.ok && authz.route.handler === PLANNER_HANDLER) return this.startPlanner(m, event.prompt, authz.route, refs);
    return this.ctx.submit(event);
  }

  /** Planner hop: one working message, pulse edits, no agent wake. */
  private startPlanner(m: IncomingDiscordMessage, _prompt: string, route: Route, refs: ReturnType<typeof wakeRefs>): PlannerStarted {
    const base = { eventId: m.id, lane: m.channelId, actor: m.authorId, route: route.id, agent: route.agent };
    if (this.plannerSeen.has(m.id)) {
      this.ctx.audit({ ...base, action: "inbound", outcome: "deny", reason: "duplicate" });
      return { planner: true, done: Promise.resolve("inconclusive") };
    }
    this.plannerSeen.add(m.id);
    if (this.plannerSeen.size > 1000) this.plannerSeen.delete(this.plannerSeen.values().next().value as string);
    this.ctx.audit({ ...base, action: "inbound", outcome: "allow", reason: "planner" });
    const done = this.runPlanner(m, route, refs, base);
    return { planner: true, done };
  }

  private async runPlanner(
    m: IncomingDiscordMessage,
    route: Route,
    refs: ReturnType<typeof wakeRefs>,
    base: { eventId: string; lane: string; actor: string; route?: string; agent: string },
  ): Promise<PlannerUserSignal> {
    const t0 = Date.now();
    const slug = typeof route.slug === "string" && route.slug ? route.slug : m.guildId ? "channel" : "dm";
    let workingId: string | undefined;
    try {
      workingId = await this.port.send(m.channelId, workingProgressText(0), { replyTo: m.id });
      const id = workingId;
      const pulseMs = this.opts.pulseMs ?? PLANNER_PULSE_MS;
      const maxMs = this.cfg.planner?.pulseMaxMs ?? 30 * 60_000;
      const timer = setInterval(() => {
        const elapsed = Date.now() - t0;
        if (elapsed > maxMs) {
          this.planner.stopPulse(m.id);
          return;
        }
        void this.port.edit(m.channelId, id, workingProgressText(elapsed)).catch(() => undefined);
      }, pulseMs);
      timer.unref?.();
      this.planner.remember(m.id, m.channelId, id, () => clearInterval(timer));
    } catch {
      this.ctx.log.warn("[discord] planner working message failed");
    }
    const text = stripMention(m.content, this.port.botUserId());
    const result = await invokePlanner(
      this.ctx.secret(this.cfg.planner?.urlRef),
      this.ctx.secret(this.cfg.planner?.tokenRef),
      {
        userPrompt: text || "(attachment)",
        ...plannerImageFields(refs),
        channelId: m.channelId,
        slug,
        messageId: m.id,
        callbackUrl: this.cfg.planner?.callbackUrl ?? this.ctx.callbackUrl,
        ...(workingId ? { statusMessageId: workingId } : {}),
        dryRun: false,
      },
      this.opts.fetchImpl,
    );
    const signal = plannerUserSignal(result);
    this.ctx.audit({ ...base, action: "planner", outcome: signal === "accepted" ? "ok" : signal === "start_failed" ? "error" : "skipped", reason: signal, status: result.status, ms: Date.now() - t0 });
    if (signal === "accepted") {
      await this.port.react(m.channelId, m.id, PLANNER_DONE_EMOJI).catch(() => undefined);
    } else if (signal === "start_failed") {
      this.planner.forget(m.id);
      if (workingId) await this.port.edit(m.channelId, workingId, PLANNER_START_FAILED_TEXT).catch(() => undefined);
    } else {
      // transport / inconclusive: not a final failure, no red X. The callback may still arrive.
      this.ctx.log.warn(`[discord] planner ${signal} (not a final failure)`);
    }
    return signal;
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
    const hasFiles = Array.isArray(b.attachments) && b.attachments.length > 0;
    if (!content.trim() && !hasFiles) return { status: 400, body: { ok: false, error: "content_or_attachment_required" } };
    if (content.length > 8000) return { status: 413, body: { ok: false, error: "content too long (max 8000)" } };
    if (!this.replyAllowed(channelId)) return { status: 403, body: { ok: false, error: "channel_not_allowlisted" } };
    const replyTo = typeof b.replyToMessageId === "string" && SNOWFLAKE.test(b.replyToMessageId) ? b.replyToMessageId : undefined;
    let files: ResolvedAttachment[] = [];
    if (b.attachments !== undefined) {
      try {
        files = await resolveJsonAttachments(b.attachments, { fetchImpl: this.opts.fetchImpl, allowHttpHosts: this.cfg.attachments?.allowHttpHosts });
      } catch (err) {
        const code = err instanceof AttachmentError ? err.code : "invalid_attachment";
        const n = Array.isArray(b.attachments) ? b.attachments.length : 0;
        this.ctx.audit({ action: "attachment", outcome: "deny", reason: code, eventId: replyTo, lane: channelId, count: n });
        return { status: attachmentHttpStatus(code), body: { ok: false, error: code } };
      }
      if (files.length) {
        this.ctx.audit({
          action: "attachment",
          outcome: "ok",
          reason: "outbound",
          eventId: replyTo,
          lane: channelId,
          count: files.length,
          bytes: files.reduce((n, f) => n + f.buffer.length, 0),
          kinds: kindsOf(files.map((f) => f.contentType)),
        });
      }
    }
    // A planner reply edits its "Working on it." message (success or failure text).
    this.planner.stopPulse(replyTo);
    const remembered = this.planner.lookup(replyTo);
    const explicit = typeof b.statusMessageId === "string" && SNOWFLAKE.test(b.statusMessageId) ? b.statusMessageId : undefined;
    const statusId = explicit ?? (remembered?.channelId === channelId ? remembered.statusMessageId : undefined);
    const parts = content ? chunk(content) : [""];
    const out = files.map((f) => ({ filename: f.filename, contentType: f.contentType, buffer: f.buffer }));
    const ids: string[] = [];
    let edited = false;
    try {
      let i = 0;
      if (statusId) {
        try {
          await this.port.edit(channelId, statusId, parts[0], { files: out });
          ids.push(statusId);
          edited = true;
          i = 1;
        } catch {
          this.ctx.log.warn("[discord] status edit failed; sending a new message");
        }
      }
      for (; i < parts.length; i++) {
        const first = ids.length === 0;
        ids.push(await this.port.send(channelId, parts[i], { replyTo: first ? replyTo : undefined, ...(first && !edited ? { files: out } : {}) }));
      }
    } catch (err) {
      return { status: 502, body: { ok: false, error: "discord_send_failed", detail: (err as Error).name } };
    }
    if (replyTo && remembered) this.planner.forget(replyTo);
    let thread = false;
    const threadText = typeof b.threadContent === "string" ? b.threadContent.trim().slice(0, 6000) : "";
    if (threadText && ids[0]) {
      try {
        await this.port.thread(channelId, ids[0], "Planner log", chunk(threadText));
        thread = true;
      } catch {
        this.ctx.log.warn("[discord] thread post failed");
      }
    }
    return { status: 200, body: { ok: true, messageIds: ids, edited, attachments: files.length, thread } };
  }
}

export interface PlannerStarted {
  planner: true;
  /** Resolves with the planner signal once the HTTP call returns. */
  done: Promise<PlannerUserSignal>;
}

function kindsOf(types: string[]): string {
  return [...new Set(types.map(mimeKind))].sort().join(",");
}

export async function createDiscordAdapter(cfg: DiscordAdapterConfig, port?: DiscordPort, opts?: DiscordAdapterOptions): Promise<DiscordAdapter> {
  if (port) return new DiscordAdapter(cfg, port, opts);
  const { createGatewayPort } = await import("./gateway.js");
  return new DiscordAdapter(cfg, await createGatewayPort(), opts);
}
