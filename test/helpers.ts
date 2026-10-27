import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordPort, IncomingDiscordMessage, OutgoingFile, VoicePort } from "../adapters/discord/port.js";

export interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

/**
 * Loopback mock of a Grok Bot webhook routine (and of a wake routine).
 * `script` is a queue of statuses to answer with first; afterwards 200 { success: true, runUuid }.
 * Status 530 answers with a Cloudflare-style 1033 body, like a sleeping tunnel.
 * Status -200 answers 200 with { success: false } (a routine that refused the run).
 */
export async function mockRoutine(opts: { key?: string; script?: number[] } = {}) {
  const hits: Hit[] = [];
  const script = [...(opts.script ?? [])];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep */
      }
      hits.push({ path: req.url ?? "/", headers: req.headers, body });
      if (opts.key && req.headers.authorization !== `Bearer ${opts.key}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ success: false, error: "unauthorized" }));
        return;
      }
      const status = script.shift() ?? 200;
      if (status === -200) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: false }));
        return;
      }
      if (status === 530) {
        res.writeHead(530, { "content-type": "text/plain" }).end("error code: 1033");
        return;
      }
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(status < 300 ? { success: true, runUuid: `run-${hits.length}` } : { success: false }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/automations/webhook/11111111`,
    base: `http://127.0.0.1:${port}`,
    hits,
    script,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** In-memory Discord: records every post and edit. */
/** 1x1 transparent PNG. */
export const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

/**
 * Loopback mock of the Discord CDN. Each path answers with its type/body.
 * `chunked: true` omits content-length (the bridge must still enforce the cap).
 */
export async function mockCdn(files: Record<string, { type: string; body: Buffer; status?: number; chunked?: boolean }>) {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    hits.push(path);
    const f = files[path];
    if (!f) return void res.writeHead(404).end("not found");
    if (f.chunked) {
      res.writeHead(f.status ?? 200, { "content-type": f.type, "transfer-encoding": "chunked" });
      const step = 64 * 1024;
      for (let i = 0; i < f.body.length; i += step) res.write(f.body.subarray(i, i + step));
      return void res.end();
    }
    res.writeHead(f.status ?? 200, { "content-type": f.type, "content-length": String(f.body.length) }).end(f.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

export interface PlannerHit {
  url: URL;
  headers: IncomingHttpHeaders;
  body: any;
}

/**
 * Loopback mock of a local planner listener. `answer` decides each reply:
 * a status + JSON body, or "drop" (destroy the socket = transport failure).
 */
export async function mockPlanner(opts: { token: string; answer?: (h: PlannerHit) => { status: number; body: unknown } | "drop" }) {
  const hits: PlannerHit[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep */
      }
      const hit = { url: new URL(req.url ?? "/", "http://127.0.0.1"), headers: req.headers, body };
      hits.push(hit);
      if (req.headers.authorization !== `Bearer ${opts.token}`) {
        return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "unauthorized" }));
      }
      const a = opts.answer?.(hit) ?? { status: 202, body: { ok: true, exitCode: 0 } };
      if (a === "drop") return void req.socket.destroy();
      res.writeHead(a.status, { "content-type": "application/json" }).end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/plan`,
    hits,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

export class FakeVoicePort implements VoicePort {
  played: { channelId: string; bytes: number }[] = [];
  streams: { channelId: string; closed: boolean; frames: number }[] = [];
  notVoice = new Set<string>();
  private pull: (() => Buffer) | undefined;
  async play(channelId: string, pcm: Buffer) {
    if (this.notVoice.has(channelId)) throw new Error("not_a_voice_channel");
    this.played.push({ channelId, bytes: pcm.length });
  }
  async openStream(channelId: string, nextFrame: () => Buffer) {
    if (this.notVoice.has(channelId)) throw new Error("not_a_voice_channel");
    const s = { channelId, closed: false, frames: 0 };
    this.streams.push(s);
    this.pull = nextFrame;
    return { close: () => { s.closed = true; this.pull = undefined; } };
  }
  /** Pull n 20 ms frames (what the gateway pump does). Returns the frames. */
  pump(n: number): Buffer[] {
    const out: Buffer[] = [];
    for (let i = 0; i < n && this.pull; i++) out.push(this.pull());
    const s = this.streams[this.streams.length - 1];
    if (s) s.frames += out.length;
    return out;
  }
}

export class FakeDiscordPort implements DiscordPort {
  sent: { id: string; channelId: string; content: string; replyTo?: string; files?: OutgoingFile[] }[] = [];
  edits: { channelId: string; messageId: string; content: string; files?: OutgoingFile[] }[] = [];
  reactions: { channelId: string; messageId: string; emoji: string }[] = [];
  threads: { channelId: string; messageId: string; name: string; parts: string[] }[] = [];
  /** Message ids whose edit throws (simulates a deleted status message). */
  failEdits = new Set<string>();
  readonly voice = new FakeVoicePort();
  private next = 900000000000000000n;
  private handler: ((m: IncomingDiscordMessage) => void) | undefined;
  connectedWith = "";
  constructor(private readonly me = "444444444444444444") {}
  async connect(token: string, onMessage: (m: IncomingDiscordMessage) => void) {
    this.connectedWith = token ? "token" : "";
    this.handler = onMessage;
  }
  async disconnect() {
    this.handler = undefined;
  }
  botUserId() {
    return this.me;
  }
  async send(channelId: string, content: string, opts?: { replyTo?: string; files?: OutgoingFile[] }) {
    const id = String(this.next++);
    this.sent.push({ id, channelId, content, replyTo: opts?.replyTo, ...(opts?.files?.length ? { files: opts.files } : {}) });
    return id;
  }
  async edit(channelId: string, messageId: string, content: string, opts?: { files?: OutgoingFile[] }) {
    if (this.failEdits.has(messageId)) throw new Error("Unknown Message");
    this.edits.push({ channelId, messageId, content, ...(opts?.files?.length ? { files: opts.files } : {}) });
  }
  async react(channelId: string, messageId: string, emoji: string) {
    this.reactions.push({ channelId, messageId, emoji });
  }
  async thread(channelId: string, messageId: string, name: string, parts: string[]) {
    this.threads.push({ channelId, messageId, name, parts });
  }
  emit(m: IncomingDiscordMessage) {
    this.handler?.(m);
  }
}

export function tmp(prefix = "ubridge-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
}

export const GUILD = "111111111111111111";
export const CHANNEL = "222222222222222222";
export const USER = "333333333333333333";
export const BOT = "444444444444444444";

export function discordMessage(over: Partial<IncomingDiscordMessage> = {}): IncomingDiscordMessage {
  return {
    id: "555555555555555555",
    channelId: CHANNEL,
    guildId: GUILD,
    authorId: USER,
    authorIsBot: false,
    authorLabel: "example-user",
    roleIds: [],
    content: `<@${BOT}> hello there`,
    mentionsBot: true,
    channelName: "example-chat",
    ...over,
  };
}

import { MemoryAudit } from "../core/audit.js";
import { Bridge, type SourceAdapter } from "../core/bridge.js";
import { HttpServer } from "../core/http.js";
import { Registry } from "../core/registry.js";
import { silentLogger } from "../core/types.js";

/** A running bridge on 127.0.0.1:<random> with one webhook agent pointed at `routineUrl`. */
export async function startBridge(opts: {
  routineUrl: string;
  adapters: SourceAdapter[];
  env?: Record<string, string>;
  holdFile?: string;
  delayMs?: (f: number) => number;
  rateLimit?: number;
}) {
  const env = { AGENT_URL: opts.routineUrl, AGENT_KEY: "routine-key", ...(opts.env ?? {}) };
  const registry = Registry.fromObject(
    {
      version: 1,
      agents: {
        "example-agent": { agentId: "11111111-1111-4111-8111-111111111111", deliver: { kind: "webhook", urlRef: "env:AGENT_URL", keyRef: "env:AGENT_KEY" } },
        "broken-agent": { agentId: "x", deliver: { kind: "webhook", urlRef: "env:AGENT_URL", keyRef: "env:MISSING" } },
      },
    },
    env,
  );
  const audit = new MemoryAudit();
  const http = new HttpServer(silentLogger);
  const bridge = new Bridge({
    registry,
    audit,
    http,
    holdFile: opts.holdFile ?? "",
    holdMaxSec: 60,
    publicBaseUrl: "https://bridge.example.com",
    callbackRateLimitPerMin: opts.rateLimit,
    log: silentLogger,
    env,
    delayMs: opts.delayMs ?? (() => 20),
  });
  for (const a of opts.adapters) await bridge.add(a);
  const port = await http.listen("127.0.0.1", 0);
  await bridge.start();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return {
    bridge,
    audit,
    base,
    call,
    close: async () => {
      await bridge.stop();
      await http.close();
    },
  };
}
