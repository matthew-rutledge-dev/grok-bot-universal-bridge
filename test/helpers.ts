import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordPort, IncomingDiscordMessage } from "../adapters/discord/port.js";

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
export class FakeDiscordPort implements DiscordPort {
  sent: { id: string; channelId: string; content: string; replyTo?: string }[] = [];
  edits: { channelId: string; messageId: string; content: string }[] = [];
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
  async send(channelId: string, content: string, opts?: { replyTo?: string }) {
    const id = String(this.next++);
    this.sent.push({ id, channelId, content, replyTo: opts?.replyTo });
    return id;
  }
  async edit(channelId: string, messageId: string, content: string) {
    this.edits.push({ channelId, messageId, content });
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
