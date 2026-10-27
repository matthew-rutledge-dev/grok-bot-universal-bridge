import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateRoutes } from "../../core/allowlist.js";
import { isSecretRef } from "../../core/secrets.js";
import { legacyPathProblem, type AdapterContext, type SourceAdapter } from "../../core/bridge.js";
import type { HeldItem } from "../../core/hold.js";
import type { HttpResponse } from "../../core/http.js";
import { MultipartBody, MultipartError } from "../../core/multipart.js";
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
  type UploadedFile,
  wakeRefs,
  type ResolvedAttachment,
} from "./attachments.js";
import { chunk, formatLegacyPrompt, formatPrompt, stripMention, type WakePromptFormat } from "./format.js";
import { UserDirectory, type WakeIdentity } from "./users.js";
import {
  CHAT_HANDLER,
  CHAT_WORKING_DELAY_MS,
  chatUrlFromPlanner,
  invokePlanner,
  PROFILE_RE,
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
 * Grok Build chat-hop routes (`handler: "grokbuild-chat"`, `profile`) call the local chat
 * process instead: see CHAT_HANDLER in planner.ts.
 *
 * Reply: POST /discord/callback { channelId | userId, content?, attachments?, replyToMessageId?,
 * statusMessageId?, threadContent? } as JSON, or as multipart/form-data (a `payload_json` part
 * and/or plain text fields, plus file parts; same caps and MIME rules). Only channels that
 * appear in an enabled route (or a DM channel that already passed the allowlist) can be posted
 * to. `userId` opens a DM with that user, only when the user is in dmCallbacks.allowUsers
 * (empty by default = deny).
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
    /** Grok Build chat hop: env:/file: ref to the /chat URL. Default: the planner URL with /plan -> /chat. */
    chatUrlRef?: string;
    /** Grok Build chat hop: post the working message only after this long (default 15 s). */
    chatWorkingDelayMs?: number;
  };
  /** Callbacks that DM a user by id. Deny by default: only these user ids (plus the dm section's users, below). */
  dmCallbacks?: { allowUsers: string[] };
  voice?: VoiceConfig;
  /**
   * Direct messages, per user. Deny by default. Use this OR a `{ dm: "true" }` route, not both.
   * policy: "allowlist" (default) = only dmRoutes users and allowUsers; "pairing" = also users an
   * owner paired with `!pair <userId>` (memory only, like the older bridge); "disabled" = ignore DMs.
   */
  dm?: {
    policy?: "allowlist" | "pairing" | "disabled";
    /** Users allowed to DM without their own agent: they get defaultAgent. */
    allowUsers?: string[];
    /** Registry alias for allowUsers and paired users. Unset = those users are refused (no agent). */
    defaultAgent?: string;
    /** May run `!pair <userId>` (DM or any channel the bot sees); may receive DM callbacks. */
    ownerIds?: string[];
    /** Trailer slug (default "dm"). */
    slug?: string;
    /** Trailer map= value for defaultAgent users (default: the alias). */
    map?: string;
  };
  /** One user -> one agent. Same allowlist as DM callbacks by userId. */
  dmRoutes?: { userId: string; agent: string; map?: string }[];
  /** Extra channels callbacks may post to that have no inbound route (outbound only). */
  callbackChannels?: string[];
  /** Also serve these root paths (agents/handlers still on an older bridge's URLs). Same auth. */
  legacyPaths?: { callback?: string; voicePlay?: string; voiceStream?: string };
  /** "compact" (default) or "legacy" (the older bridge's d:-line + thin JSON). */
  wakePromptFormat?: WakePromptFormat;
  /** Optional read-only seed of operator labels (host-only file path). */
  /** User directory: seed labels file; max entries (default 5000, least recently seen dropped). */
  users?: { seedPath?: string; max?: number };
}

export interface DiscordAdapterOptions {
  /** Used for callback url attachments and the planner call. */
  fetchImpl?: typeof fetch;
  /** Test hook: Grok Voice websocket URL. */
  grokVoiceUrl?: string;
  /** Planner pulse interval (default 5 s). */
  pulseMs?: number;
  /** Chat-hop typing interval (default 8 s). */
  typingMs?: number;
}

export const PLANNER_DONE_EMOJI = "✅";

export const HOLD_STATUS_TEXT = "Bot is waking up, holding your message…";
export const HOLD_DELIVERED_TEXT = "Delivered. The bot is on it.";
export const HOLD_GAVE_UP_TEXT = "❌ Couldn't reach the bot, please try again.";
export const FAILED_TEXT = "❌ Couldn't deliver that message.";
export const NOT_PAIRED_TEXT = "Not paired. Ask the owner to run `!pair <yourId>` (deny-by-default).";
export const DELIVERED_EMOJI = "✅";
export const NOT_ACCEPTED_EMOJI = "⚠️";
export const FAILED_EMOJI = "❌";
/** Callback text cap (chunked into 2000-character messages). */
export const MAX_CALLBACK_CONTENT = 32_000;

export interface DiscordCallbackBody {
  channelId?: unknown;
  userId?: unknown;
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
  // Every *Ref must be a reference, never a literal (same rule as wake.*).
  const refs: [string, unknown][] = [
    ["tokenRef", c.tokenRef],
    ["callbackTokenRef", c.callbackTokenRef],
    ["planner.urlRef", c.planner?.urlRef],
    ["planner.tokenRef", c.planner?.tokenRef],
    ["planner.chatUrlRef", c.planner?.chatUrlRef],
    ["voice.piperHostRef", c.voice?.piperHostRef],
    ["voice.piperPortRef", c.voice?.piperPortRef],
    ["voice.grokApiKeyRef", c.voice?.grokApiKeyRef],
  ];
  for (const [k, v] of refs) if (v !== undefined && v !== "" && !isSecretRef(v)) p.push(`discord.${k} must be env:NAME or file:/absolute/path (literal values refused)`);
  for (const [section, obj] of [["planner", c.planner], ["voice", c.voice]] as const) {
    for (const k of Object.keys(obj ?? {})) {
      if (/^(url|token|key|apiKey|grokApiKey|piperHost|piperPort|host|port)$/i.test(k)) p.push(`discord.${section}.${k}: literal values refused; use ${k}Ref`);
    }
  }
  for (const [i, r] of (c.routes ?? []).entries()) {
    const keys = Object.keys(r.match ?? {});
    const ok = (keys.length === 2 && keys.includes("guild") && keys.includes("channel")) || (keys.length === 1 && keys[0] === "dm");
    if (!ok) p.push(`discord.routes[${i}]: match must be { guild, channel } or { dm: "true" }`);
    if (r.handler !== undefined && r.handler !== PLANNER_HANDLER && r.handler !== CHAT_HANDLER) {
      p.push(`discord.routes[${i}]: handler must be "${PLANNER_HANDLER}", "${CHAT_HANDLER}" or unset`);
    }
    if (r.handler === CHAT_HANDLER && (typeof r.profile !== "string" || !PROFILE_RE.test(r.profile))) {
      p.push(`discord.routes[${i}]: a ${CHAT_HANDLER} route needs a short profile name (letters, digits, . _ -)`);
    }
  }
  const hop = (r: Route) => r.handler === PLANNER_HANDLER || r.handler === CHAT_HANDLER;
  if ((c.routes ?? []).some(hop) && (!c.planner?.urlRef || !c.planner?.tokenRef)) {
    p.push("discord.planner.urlRef and tokenRef required when a route uses the local-planner or grokbuild-chat handler");
  }
  if ((c.routes ?? []).some((r) => r.enabled && hop(r)) && !c.callbackTokenRef) {
    p.push("discord.callbackTokenRef required when a local-planner or grokbuild-chat route is enabled (the hop replies through the callback)");
  }
  if (c.planner?.chatWorkingDelayMs !== undefined && (!Number.isFinite(c.planner.chatWorkingDelayMs) || c.planner.chatWorkingDelayMs < 0)) {
    p.push("discord.planner.chatWorkingDelayMs must be >= 0");
  }
  if (c.dmCallbacks !== undefined) {
    const u = c.dmCallbacks?.allowUsers;
    if (!Array.isArray(u) || u.some((x) => typeof x !== "string" || !SNOWFLAKE.test(x))) p.push("discord.dmCallbacks.allowUsers must be an array of user ids (no wildcards)");
  }
  const ids = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string" && SNOWFLAKE.test(x));
  if (c.dm !== undefined || c.dmRoutes !== undefined) {
    if ((c.routes ?? []).some((r) => r?.match && "dm" in r.match)) p.push('discord: use dm/dmRoutes or a { dm: "true" } route, not both');
    const d = c.dm ?? {};
    if (d.policy !== undefined && !["allowlist", "pairing", "disabled"].includes(d.policy)) p.push("discord.dm.policy must be allowlist, pairing or disabled");
    if (d.allowUsers !== undefined && !ids(d.allowUsers)) p.push("discord.dm.allowUsers must be user ids (no wildcards)");
    if (d.ownerIds !== undefined && !ids(d.ownerIds)) p.push("discord.dm.ownerIds must be user ids");
    if (d.defaultAgent !== undefined && (typeof d.defaultAgent !== "string" || !d.defaultAgent)) p.push("discord.dm.defaultAgent must be a registry alias");
    if (d.slug !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(String(d.slug))) p.push("discord.dm.slug must be a short name");
    if (c.dmRoutes !== undefined) {
      if (!Array.isArray(c.dmRoutes)) p.push("discord.dmRoutes must be an array");
      else {
        const seen = new Set<string>();
        c.dmRoutes.forEach((r, i) => {
          if (!r || typeof r.userId !== "string" || !SNOWFLAKE.test(r.userId)) p.push(`discord.dmRoutes[${i}].userId must be a user id (no wildcards)`);
          else if (seen.has(r.userId)) p.push(`discord.dmRoutes[${i}]: user listed twice`);
          else seen.add(r.userId);
          if (!r || typeof r.agent !== "string" || !r.agent) p.push(`discord.dmRoutes[${i}].agent must be a registry alias`);
        });
      }
    }
  }
  if (c.callbackChannels !== undefined && !ids(c.callbackChannels)) p.push("discord.callbackChannels must be channel ids");
  if (c.wakePromptFormat !== undefined && c.wakePromptFormat !== "compact" && c.wakePromptFormat !== "legacy") p.push("discord.wakePromptFormat must be compact or legacy");
  for (const [k, v] of Object.entries(c.legacyPaths ?? {})) {
    const problem = legacyPathProblem(v, ["discord", "grokbuild", "tesla"]);
    if (problem) p.push(`discord.legacyPaths.${k}: ${problem}`);
  }
  if (c.users?.seedPath !== undefined && typeof c.users.seedPath !== "string") p.push("discord.users.seedPath must be a file path");
  if (c.users?.max !== undefined && !(Number.isInteger(c.users.max) && c.users.max >= 1 && c.users.max <= 100_000)) p.push("discord.users.max must be an integer 1..100000");
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
  opts: { format?: WakePromptFormat; who?: WakeIdentity; label?: string; callbackUrl?: string } = {},
): { event?: InboundEvent; skip?: "bot_author" | "empty" } {
  const text = stripMention(m.content, botUserId);
  if (!text && !(m.attachments?.length)) return { skip: "empty" };
  // DMs carry the user too, so dmRoutes can send each user to their own agent ({ dm } routes still match).
  const match: Record<string, string> = m.guildId ? { guild: m.guildId, channel: m.channelId } : { dm: "true", user: m.authorId };
  const route = routes.find((r) => Object.keys(r.match).length > 0 && Object.keys(r.match).every((k) => r.match[k] === match[k]));
  const slug = typeof route?.slug === "string" && route.slug ? route.slug : m.guildId ? "channel" : "dm";
  const refs = wakeRefs(m.attachments);
  const args = {
    slug,
    messageId: m.id,
    guildId: m.guildId,
    channelId: m.channelId,
    userId: m.authorId,
    label: opts.label ?? m.authorLabel,
    alias: typeof route?.map === "string" ? route.map : (route?.agent ?? ""),
    text,
    channelName: m.channelName,
    attachments: refs,
    who: opts.who,
  };
  const who = opts.who && Object.keys(opts.who).length ? opts.who : undefined;
  let callbackBaseUrl: string | undefined;
  let callbackPath: string | undefined;
  try {
    if (opts.callbackUrl) ({ origin: callbackBaseUrl, pathname: callbackPath } = new URL(opts.callbackUrl));
  } catch {
    /* no callback URL */
  }
  return {
    event: {
      eventId: m.id,
      lane: m.channelId,
      actor: m.authorId,
      actorGroups: m.roleIds,
      match,
      addressed: m.guildId ? m.mentionsBot : true,
      prompt: opts.format === "legacy" ? formatLegacyPrompt(args) : formatPrompt(args),
      // Same fields as the older bridge's sendPrompt metadata (source is set by the core).
      metadata: {
        hop: `d:${slug}:${m.id}`,
        discordMessageId: m.id,
        discordChannelId: m.channelId,
        discordUserId: m.authorId,
        discordGuildId: m.guildId,
        ...(who ? { discordUser: who } : {}),
        ...(callbackBaseUrl ? { callbackBaseUrl, callbackPath } : {}),
        ...(refs.length ? { attachments: refs } : {}),
      },
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
  /** Chat hops whose working message isn't posted yet: origin id -> cancel. */
  private readonly chatHolds = new Map<string, () => void>();
  private voice?: VoiceService;
  private users?: UserDirectory;
  /** Users an owner paired with !pair (memory only). */
  private readonly paired = new Set<string>();
  /** Chat hops showing "typing…": origin id -> stop. */
  private readonly chatTyping = new Map<string, () => void>();
  /**
   * Hops still waiting on their reply, by origin message id (cap 1000, oldest dropped).
   * A reply or a start failure marks the hop finished, so a "Working on it." send that was
   * still in flight is deleted (or forgotten) when it resolves and never starts its pulse.
   */
  private readonly hops = new Map<string, { finished: boolean }>();
  readonly legacyCallbackPath?: string;

  constructor(
    private readonly cfg: DiscordAdapterConfig,
    private readonly port: DiscordPort,
    private readonly opts: DiscordAdapterOptions = {},
  ) {
    const problems = validateDiscordConfig(cfg);
    if (problems.length) throw new Error(problems.join("; "));
    // Config routes first; per-user DM routes after (config can't also have a { dm } route).
    this.routes = [...cfg.routes, ...dmRoutesFor(cfg)];
    this.callbackTokenRef = cfg.callbackTokenRef;
    this.legacyCallbackPath = cfg.legacyPaths?.callback;
  }

  private get dmPolicy(): "allowlist" | "pairing" | "disabled" | undefined {
    if (!this.cfg.dm && !this.cfg.dmRoutes) return undefined;
    return this.cfg.dm?.policy ?? "allowlist";
  }

  /** May a callback open a DM with this user? Deny by default. */
  dmCallbackAllowed(userId: string): boolean {
    if ((this.cfg.dmCallbacks?.allowUsers ?? []).includes(userId)) return true;
    const policy = this.dmPolicy;
    if (!policy || policy === "disabled") return false;
    if ((this.cfg.dmRoutes ?? []).some((r) => r.userId === userId)) return true;
    if ((this.cfg.dm?.allowUsers ?? []).includes(userId) || (this.cfg.dm?.ownerIds ?? []).includes(userId)) return true;
    return policy === "pairing" && this.paired.has(userId);
  }

  /** `!pair <userId>` from an owner: memory-only DM access with the default agent. */
  private async pairCommand(m: IncomingDiscordMessage): Promise<boolean> {
    if (this.dmPolicy !== "pairing") return false;
    const raw = m.content.trim();
    if (!raw.startsWith("!pair ") || !(this.cfg.dm?.ownerIds ?? []).includes(m.authorId)) return false;
    const target = raw.slice(6).trim().replace(/[<@!>]/g, "");
    if (!SNOWFLAKE.test(target)) return true;
    this.paired.add(target);
    const d = this.cfg.dm!;
    const has = this.routes.some((r) => r.match.dm === "true" && r.match.user === target);
    if (!has && d.defaultAgent) {
      this.routes.push({ id: "dm-paired", enabled: true, match: { dm: "true", user: target }, allowActors: [target], agent: d.defaultAgent, slug: d.slug ?? "dm", ...(d.map ? { map: d.map } : {}) });
    }
    this.ctx.audit({ action: "inbound", outcome: "allow", reason: "dm_paired", actor: target, lane: m.channelId });
    await this.port.send(m.channelId, `paired ${target}`, { replyTo: m.id }).catch(() => undefined);
    return true;
  }

  health(): Record<string, unknown> {
    return {
      ready: this.port.isReady ? this.port.isReady() : false,
      hasTokenConfigured: Boolean(this.ctx?.secret(this.cfg.tokenRef)),
      callbackPath: "/discord/callback",
      ...(this.legacyCallbackPath ? { legacyCallbackPath: this.legacyCallbackPath } : {}),
      routes: this.routes.filter((r) => r.enabled).length,
    };
  }

  init(ctx: AdapterContext): void {
    this.ctx = ctx;
    if (this.routes.some((r) => r.enabled && (r.handler === PLANNER_HANDLER || r.handler === CHAT_HANDLER)) && !(this.cfg.planner?.callbackUrl || ctx.callbackUrl)) {
      throw new Error("discord: a local-planner / grokbuild-chat route needs a callback URL (set http.publicBaseUrl or discord.planner.callbackUrl)");
    }
    // Working-message state survives a restart (callbacks after a restart still edit it).
    this.planner.load(ctx.dataFile("planner-status.json"));
    if (this.cfg.voice) {
      const voice = new VoiceService(this.cfg.voice, {
        port: this.port.voice,
        secret: (r) => ctx.secret(r),
        grokUrl: this.opts.grokVoiceUrl,
        onStreamEnded: () => ctx.audit({ action: "voice", outcome: "skipped", reason: "stream_dropped" }),
      });
      this.voice = voice;
      const max = { maxBytes: 24 * 1024 * 1024 };
      ctx.authedRoute("POST", "voice/play", "voice", (req) => voice.play(req.body), { ...max, legacyPath: this.cfg.legacyPaths?.voicePlay });
      ctx.authedRoute("POST", "voice/stream", "voice", (req) => voice.streamOp(req.body), { ...max, legacyPath: this.cfg.legacyPaths?.voiceStream });
    }
    this.users = new UserDirectory({ file: ctx.dataFile("user-directory.json"), seedPath: this.cfg.users?.seedPath, max: this.cfg.users?.max, warn: (l) => ctx.log.warn(l) });
    const u = this.users.load();
    ctx.log.info(`[discord] user directory users=${u.users} seed=${u.seeded}`);
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
    await this.port.connect(
      token,
      (m) => void this.onMessage(m),
      (u) => {
        if (!u.bot) this.users?.learn(u);
      },
    );
    this.ctx.log.info(`[discord] connected routes=${this.routes.length}`);
  }

  async stop(): Promise<void> {
    this.voice?.close();
    this.users?.flush();
    for (const stopTyping of this.chatTyping.values()) stopTyping();
    this.chatTyping.clear();
    this.planner.stopAll();
    for (const cancel of this.chatHolds.values()) cancel();
    this.chatHolds.clear();
    for (const hop of this.hops.values()) hop.finished = true;
    this.hops.clear();
    await this.port.disconnect();
  }

  /** Public for tests and the local smoke run. */
  async onMessage(m: IncomingDiscordMessage): Promise<SubmitResult | PlannerStarted | undefined> {
    if (m.authorIsBot && this.cfg.ignoreBots !== false) {
      this.ctx.audit({ action: "inbound", outcome: "skipped", reason: "bot_author", eventId: m.id, lane: m.channelId });
      return undefined;
    }
    // Names for the prompt are previewed here; the author is stored only once the allowlist passes.
    const author = { id: m.authorId, username: m.authorUsername ?? m.authorLabel, globalName: m.authorGlobalName, displayName: m.authorDisplayName };
    const named = this.users?.preview(author, m.authorLabel);
    if (await this.pairCommand(m)) return undefined;
    if (!m.guildId && this.dmPolicy === "disabled") {
      this.ctx.audit({ action: "inbound", outcome: "skipped", reason: "dm_disabled", eventId: m.id, lane: m.channelId });
      return undefined;
    }
    const { event, skip } = messageToEvent(m, this.port.botUserId(), this.routes, {
      format: this.cfg.wakePromptFormat,
      who: named?.who,
      label: named?.label,
      callbackUrl: this.ctx.callbackUrl,
    });
    if (!event) {
      this.ctx.audit({ action: "inbound", outcome: "skipped", reason: skip, eventId: m.id, lane: m.channelId });
      return undefined;
    }
    const authz = this.ctx.check(event);
    if (authz.ok) this.users?.learn(author);
    if (!authz.ok && !m.guildId && this.dmPolicy === "pairing" && (authz.reason === "no_route" || authz.reason === "actor_not_allowlisted")) {
      this.ctx.audit({ action: "inbound", outcome: "deny", reason: "dm_not_paired", eventId: m.id, lane: m.channelId, actor: m.authorId });
      await this.port.send(m.channelId, NOT_PAIRED_TEXT, { replyTo: m.id }).catch(() => undefined);
      return { accepted: false, reason: authz.reason };
    }
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
    if (authz.ok && authz.route.handler === CHAT_HANDLER) return this.startPlanner(m, event.prompt, authz.route, refs, "chat");
    return this.ctx.submit(event);
  }

  /** Planner hop: one working message, pulse edits, no agent wake. */
  private startPlanner(m: IncomingDiscordMessage, _prompt: string, route: Route, refs: ReturnType<typeof wakeRefs>, variant: "image" | "chat" = "image"): PlannerStarted {
    const base = { eventId: m.id, lane: m.channelId, actor: m.authorId, route: route.id, agent: route.agent };
    if (this.plannerSeen.has(m.id)) {
      this.ctx.audit({ ...base, action: "inbound", outcome: "deny", reason: "duplicate" });
      return { planner: true, done: Promise.resolve("inconclusive") };
    }
    this.plannerSeen.add(m.id);
    if (this.plannerSeen.size > 1000) this.plannerSeen.delete(this.plannerSeen.values().next().value as string);
    this.ctx.audit({ ...base, action: "inbound", outcome: "allow", reason: variant === "chat" ? "chat_hop" : "planner" });
    const done = this.runPlanner(m, route, refs, base, variant);
    return { planner: true, done };
  }

  private async runPlanner(
    m: IncomingDiscordMessage,
    route: Route,
    refs: ReturnType<typeof wakeRefs>,
    base: { eventId: string; lane: string; actor: string; route?: string; agent: string },
    variant: "image" | "chat" = "image",
  ): Promise<PlannerUserSignal> {
    const t0 = Date.now();
    const slug = typeof route.slug === "string" && route.slug ? route.slug : m.guildId ? "channel" : "dm";
    let workingId: string | undefined;
    const hop = { finished: false };
    this.hops.set(m.id, hop);
    if (this.hops.size > 1000) this.hops.delete(this.hops.keys().next().value as string);
    const postWorking = async () => {
      try {
        const id = await this.port.send(m.channelId, workingProgressText(Date.now() - t0), { replyTo: m.id });
        if (hop.finished) {
          // The reply (or a start failure) beat this send: drop the stale message, no pulse.
          await this.port.delete?.(m.channelId, id).catch(() => undefined);
          return;
        }
        workingId = id;
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
    };
    let hold: ReturnType<typeof setTimeout> | undefined;
    if (variant === "chat") {
      // Chat hop: only post "Working on it." if the reply takes longer than the delay.
      const delay = this.cfg.planner?.chatWorkingDelayMs ?? CHAT_WORKING_DELAY_MS;
      hold = setTimeout(() => {
        this.chatHolds.delete(m.id);
        void postWorking();
      }, delay);
      hold.unref?.();
      this.chatHolds.set(m.id, () => clearTimeout(hold));
      // Typing starts at once and repeats every 8 s until the reply (or pulseMaxMs).
      if (this.port.typing) {
        const typing = () => void this.port.typing!(m.channelId).catch(() => undefined);
        typing();
        const maxMs = this.cfg.planner?.pulseMaxMs ?? 30 * 60_000;
        const t = setInterval(() => (Date.now() - t0 > maxMs ? this.stopTyping(m.id) : typing()), this.opts.typingMs ?? 8000);
        t.unref?.();
        this.chatTyping.set(m.id, () => clearInterval(t));
      }
    } else {
      await postWorking();
    }
    const text = stripMention(m.content, this.port.botUserId());
    const plannerUrl = this.ctx.secret(this.cfg.planner?.urlRef);
    const url = variant === "chat" ? (this.ctx.secret(this.cfg.planner?.chatUrlRef) ?? chatUrlFromPlanner(plannerUrl)) : plannerUrl;
    const common = {
      userPrompt: text || "(attachment)",
      channelId: m.channelId,
      slug,
      messageId: m.id,
      callbackUrl: this.cfg.planner?.callbackUrl ?? this.ctx.callbackUrl,
      dryRun: false,
    };
    const result = await invokePlanner(
      url,
      this.ctx.secret(this.cfg.planner?.tokenRef),
      variant === "chat"
        ? { ...common, imagePath: "", profile: String(route.profile), attachments: refs.map((r) => ({ ...r })) }
        : { ...common, ...plannerImageFields(refs), ...(workingId ? { statusMessageId: workingId } : {}) },
      this.opts.fetchImpl,
    );
    const signal = plannerUserSignal(result);
    this.ctx.audit({ ...base, action: "planner", outcome: signal === "accepted" ? "ok" : signal === "start_failed" ? "error" : "skipped", reason: signal, type: variant === "chat" ? "chat_hop" : "planner", status: result.status, ms: Date.now() - t0 });
    if (signal === "accepted") {
      await this.port.react(m.channelId, m.id, PLANNER_DONE_EMOJI).catch(() => undefined);
    } else if (signal === "start_failed") {
      this.finishHop(m.id);
      this.stopTyping(m.id);
      this.chatHolds.get(m.id)?.();
      this.chatHolds.delete(m.id);
      this.planner.forget(m.id);
      if (workingId) await this.port.edit(m.channelId, workingId, PLANNER_START_FAILED_TEXT).catch(() => undefined);
      else if (variant === "chat") await this.port.send(m.channelId, PLANNER_START_FAILED_TEXT, { replyTo: m.id }).catch(() => undefined);
    } else {
      // transport / inconclusive: not a final failure, no red X. The callback may still arrive.
      this.ctx.log.warn(`[discord] planner ${signal} (not a final failure)`);
    }
    return signal;
  }

  /** Reply or start failure: a working-message send still in flight must not post or pulse. */
  private finishHop(id: string | undefined): void {
    if (!id) return;
    const hop = this.hops.get(id);
    if (hop) hop.finished = true;
    this.hops.delete(id);
  }

  private stopTyping(id: string | undefined): void {
    if (!id) return;
    this.chatTyping.get(id)?.();
    this.chatTyping.delete(id);
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
    delivered: async (item: HeldItem, result?: { body?: unknown }) => {
      const ch = item.ref?.channelId;
      if (ch && item.statusRef) await this.port.edit(ch, item.statusRef, HOLD_DELIVERED_TEXT);
      // Same reactions as the older bridge: ✅ accepted, ⚠️ answered but not accepted.
      const notAccepted = (result?.body as { accepted?: unknown } | null | undefined)?.accepted === false;
      if (ch && item.ref?.messageId) await this.port.react(ch, item.ref.messageId, notAccepted ? NOT_ACCEPTED_EMOJI : DELIVERED_EMOJI).catch(() => undefined);
    },
    failed: async (item: HeldItem, _err: unknown, info: { held: boolean }) => {
      const ch = item.ref?.channelId;
      if (!ch) return;
      const text = info.held ? HOLD_GAVE_UP_TEXT : FAILED_TEXT;
      if (item.statusRef) await this.port.edit(ch, item.statusRef, text);
      else await this.port.send(ch, text, { replyTo: item.ref?.messageId });
      if (item.ref?.messageId) await this.port.react(ch, item.ref.messageId, FAILED_EMOJI).catch(() => undefined);
    },
  };

  /** Channels replies may target: enabled guild routes, callbackChannels, allowlisted DM channels. */
  replyAllowed(channelId: string): boolean {
    if (this.dmChannels.has(channelId)) return true;
    if ((this.cfg.callbackChannels ?? []).includes(channelId)) return true;
    return this.routes.some((r) => r.enabled && r.match.channel === channelId);
  }

  /** multipart/form-data callback -> the JSON body shape plus uploaded files. */
  private fromMultipart(mp: MultipartBody): { body: DiscordCallbackBody; uploads: UploadedFile[] } {
    const parts = mp.parse({ maxParts: 32, maxFieldBytes: 256 * 1024 });
    const body: Record<string, unknown> = {};
    const uploads: UploadedFile[] = [];
    const json = parts.find((p) => p.name === "payload_json" && p.filename === undefined);
    if (json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json.data.toString("utf8"));
      } catch {
        throw new MultipartError("multipart_invalid");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MultipartError("multipart_invalid");
      Object.assign(body, parsed);
    }
    const TEXT = new Set(["channelId", "userId", "content", "replyToMessageId", "statusMessageId", "threadContent"]);
    for (const p of parts) {
      if (p.filename !== undefined) uploads.push({ filename: p.filename, contentType: p.contentType, data: p.data });
      else if (TEXT.has(p.name) && body[p.name] === undefined) body[p.name] = p.data.toString("utf8");
    }
    return { body: body as DiscordCallbackBody, uploads };
  }

  async handleCallback(raw: unknown): Promise<HttpResponse> {
    let b: DiscordCallbackBody;
    let uploads: UploadedFile[] = [];
    if (raw instanceof MultipartBody) {
      try {
        ({ body: b, uploads } = this.fromMultipart(raw));
      } catch (err) {
        const code = err instanceof MultipartError ? err.code : "multipart_invalid";
        this.ctx.audit({ action: "callback", outcome: "deny", reason: code });
        return { status: code === "multipart_invalid" ? 400 : 413, body: { ok: false, error: code } };
      }
    } else {
      b = (raw ?? {}) as DiscordCallbackBody;
    }
    let channelId = typeof b.channelId === "string" ? b.channelId : "";
    const userId = typeof b.userId === "string" ? b.userId : "";
    const content = typeof b.content === "string" ? b.content : "";
    if (channelId && userId) return { status: 400, body: { ok: false, error: "channelId_or_userId_not_both" } };
    if (!userId && !SNOWFLAKE.test(channelId)) return { status: 400, body: { ok: false, error: "channelId_required" } };
    if (userId && !SNOWFLAKE.test(userId)) return { status: 400, body: { ok: false, error: "userId invalid" } };
    const hasFiles = (Array.isArray(b.attachments) && b.attachments.length > 0) || uploads.length > 0;
    if (!content.trim() && !hasFiles) return { status: 400, body: { ok: false, error: "content_or_attachment_required" } };
    if (content.length > MAX_CALLBACK_CONTENT) return { status: 413, body: { ok: false, error: "content_too_long", max: MAX_CALLBACK_CONTENT } };
    if (this.port.isReady && !this.port.isReady()) return { status: 503, body: { ok: false, error: "discord_not_ready" } };
    if (userId) {
      // DM by user id: deny by default; dmRoutes users, dm.allowUsers/ownerIds, paired users, dmCallbacks.allowUsers.
      if (!this.dmCallbackAllowed(userId)) {
        this.ctx.audit({ action: "callback", outcome: "deny", reason: "dm_user_not_allowlisted", actor: userId });
        return { status: 403, body: { ok: false, error: "user_not_allowlisted" } };
      }
      if (!this.port.openDm) return { status: 501, body: { ok: false, error: "dm_not_supported" } };
      try {
        channelId = await this.port.openDm(userId);
      } catch (err) {
        return { status: 502, body: { ok: false, error: "dm_open_failed", detail: (err as Error).name } };
      }
      if (!SNOWFLAKE.test(channelId)) return { status: 502, body: { ok: false, error: "dm_open_failed" } };
      this.ctx.audit({ action: "callback", outcome: "allow", reason: "dm_by_user", actor: userId, lane: channelId });
    } else if (!this.replyAllowed(channelId)) {
      return { status: 403, body: { ok: false, error: "channel_not_allowlisted" } };
    }
    const replyTo = typeof b.replyToMessageId === "string" && SNOWFLAKE.test(b.replyToMessageId) ? b.replyToMessageId : undefined;
    let files: ResolvedAttachment[] = [];
    if (b.attachments !== undefined || uploads.length) {
      try {
        files = await resolveJsonAttachments(b.attachments, { fetchImpl: this.opts.fetchImpl, allowHttpHosts: this.cfg.attachments?.allowHttpHosts }, uploads);
      } catch (err) {
        const code = err instanceof AttachmentError ? err.code : "invalid_attachment";
        const n = (Array.isArray(b.attachments) ? b.attachments.length : 0) + uploads.length;
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
    this.finishHop(replyTo);
    this.stopTyping(replyTo);
    // A chat-hop reply that beats the working-message delay: cancel it, answer as a new reply.
    if (replyTo && this.chatHolds.has(replyTo)) {
      this.chatHolds.get(replyTo)!();
      this.chatHolds.delete(replyTo);
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
      return { status: 502, body: { ok: false, error: "deliver_failed", detail: (err as Error).name } };
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
    // messageId + chunks: the older bridge's response shape; messageIds: every message.
    return { status: 200, body: { ok: true, messageId: ids[0], messageIds: ids, chunks: parts.length, edited, attachments: files.length, thread } };
  }
}

export interface PlannerStarted {
  planner: true;
  /** Resolves with the planner signal once the HTTP call returns. */
  done: Promise<PlannerUserSignal>;
}

/** Routes for the dm section: one per dmRoutes user, then allowUsers with the default agent. */
export function dmRoutesFor(cfg: DiscordAdapterConfig): Route[] {
  if (!cfg.dm && !cfg.dmRoutes) return [];
  const d = cfg.dm ?? {};
  const enabled = (d.policy ?? "allowlist") !== "disabled";
  const slug = d.slug ?? "dm";
  const out: Route[] = [];
  for (const r of cfg.dmRoutes ?? []) {
    out.push({ id: "dm-user", enabled, match: { dm: "true", user: r.userId }, allowActors: [r.userId], agent: r.agent, slug, ...(r.map ? { map: r.map } : {}) });
  }
  if (d.defaultAgent) {
    const routed = new Set((cfg.dmRoutes ?? []).map((r) => r.userId));
    for (const u of d.allowUsers ?? []) {
      if (routed.has(u)) continue;
      out.push({ id: "dm-default", enabled, match: { dm: "true", user: u }, allowActors: [u], agent: d.defaultAgent, slug, ...(d.map ? { map: d.map } : {}) });
    }
  }
  return out;
}

function kindsOf(types: string[]): string {
  return [...new Set(types.map(mimeKind))].sort().join(",");
}

export async function createDiscordAdapter(cfg: DiscordAdapterConfig, port?: DiscordPort, opts?: DiscordAdapterOptions): Promise<DiscordAdapter> {
  if (port) return new DiscordAdapter(cfg, port, opts);
  const { createGatewayPort } = await import("./gateway.js");
  return new DiscordAdapter(cfg, await createGatewayPort(), opts);
}
