import { readFileSync } from "node:fs";
import { isSecretRef, resolveSecret, type SecretEnv } from "./secrets.js";
import { redactUrl } from "./redact.js";

/**
 * The agent registry: alias -> Grok Bot id + how to deliver to it.
 *
 * The real registry lives ONLY on the deployment host, rendered from the
 * host's vault, mode 600, mounted read-only. Git holds only
 * config/registry.example.json. The bridge never writes it.
 *
 * Delivery kinds:
 *   webhook     Grok Bot webhook-triggered routine (documented path).
 *               POST JSON with Authorization: Bearer <key> + X-Automation-Key: <key>.
 *   sendprompt  A sendPrompt-style gateway (compatibility with existing bridges).
 *               POST { agentId, prompt, metadata } with Authorization: Bearer <token>.
 */
export type DeliveryKind = "webhook" | "sendprompt";

export interface RegistryAgentFile {
  agentId: string;
  label?: string;
  deliver: {
    kind: DeliveryKind;
    /** Literal URL only for loopback, example.com or *.test hosts; anything else must be urlRef (routine URLs are secrets). */
    url?: string;
    urlRef?: string;
    keyRef?: string;
    timeoutMs?: number;
  };
}

export interface RegistryFile {
  version: 1;
  agents: Record<string, RegistryAgentFile>;
}

export interface ResolvedAgent {
  alias: string;
  agentId: string;
  kind: DeliveryKind;
  url: string;
  key: string;
  timeoutMs: number;
}

export interface PublicAgent {
  alias: string;
  kind: DeliveryKind;
  target?: string;
  ready: boolean;
  problems: string[];
}

const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Aliases are case-sensitive and must be lowercase. They are NOT normalised:
 * "Example-Agent" is rejected with a hint, never silently mapped, so two
 * spellings can never point at different bots.
 */
export function aliasProblem(alias: string): string {
  const lower = alias.toLowerCase();
  const hint = ALIAS.test(lower) ? ` Rename it to "${lower}" here and in every adapter route's "agent" field (e.g. Discord routes).` : "";
  return `${alias}: registry aliases must be lowercase: start with a-z or 0-9, then a-z 0-9 . _ - (max 64).${hint}`;
}

/** A route's agent alias that only differs from a registry alias by case. Startup error. */
export function routeAliasCaseProblem(alias: string, known: readonly string[], where: string): string | undefined {
  if (!alias || known.includes(alias)) return undefined;
  const lower = alias.toLowerCase();
  if (lower !== alias && known.includes(lower)) {
    return `${where}: agent "${alias}" must be lowercase "${lower}" (registry aliases are lowercase and case-sensitive)`;
  }
  return undefined;
}

export class Registry {
  private constructor(
    private readonly file: RegistryFile,
    private readonly env: SecretEnv,
  ) {}

  static fromFile(path: string, env: SecretEnv = process.env): Registry {
    return Registry.fromObject(JSON.parse(readFileSync(path, "utf8")), env);
  }

  static fromObject(raw: unknown, env: SecretEnv = process.env): Registry {
    const problems = validateRegistry(raw);
    if (problems.length) throw new Error(`registry invalid: ${problems.join("; ")}`);
    return new Registry(raw as RegistryFile, env);
  }

  aliases(): string[] {
    return Object.keys(this.file.agents);
  }

  has(alias: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.file.agents, alias);
  }

  /** Resolve secrets now (they may rotate under the host's loader). */
  resolve(alias: string): { agent?: ResolvedAgent; problems: string[] } {
    if (!this.has(alias)) return { problems: ["unknown alias"] };
    const a = this.file.agents[alias];
    const problems: string[] = [];
    let url: string | undefined;
    try {
      url = a.deliver.urlRef ? resolveSecret(a.deliver.urlRef, this.env) : a.deliver.url;
    } catch (e) {
      problems.push((e as Error).message);
    }
    let key: string | undefined;
    try {
      key = resolveSecret(a.deliver.keyRef, this.env);
    } catch (e) {
      problems.push((e as Error).message);
    }
    if (!url) problems.push("delivery URL missing");
    else if (!isAllowedUrl(url)) problems.push("delivery URL must be https (http only on loopback)");
    if (!key) problems.push("delivery key missing (fail-closed: never sends unauthenticated)");
    if (problems.length || !url || !key) return { problems };
    return {
      agent: {
        alias,
        agentId: a.agentId,
        kind: a.deliver.kind,
        url,
        key,
        timeoutMs: a.deliver.timeoutMs && a.deliver.timeoutMs > 0 ? a.deliver.timeoutMs : 8000,
      },
      problems,
    };
  }

  describe(alias: string): PublicAgent {
    const a = this.file.agents[alias];
    const r = this.resolve(alias);
    return {
      alias,
      kind: a?.deliver.kind,
      target: r.agent ? redactUrl(r.agent.url) : undefined,
      ready: r.problems.length === 0,
      problems: r.problems,
    };
  }
}

export function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    return false;
  } catch {
    return false;
  }
}

/** Hosts a literal deliver.url may point at. Real routine URLs carry a secret id, so they must be refs. */
export function isLiteralUrlHostAllowed(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(h) || h === "example.com" || h.endsWith(".example.com") || h.endsWith(".test");
  } catch {
    return false;
  }
}

export function validateRegistry(raw: unknown): string[] {
  const p: string[] = [];
  if (!raw || typeof raw !== "object") return ["not an object"];
  const r = raw as Partial<RegistryFile>;
  if (r.version !== 1) p.push("version must be 1");
  if (!r.agents || typeof r.agents !== "object") return [...p, "agents must be an object"];
  for (const [alias, a] of Object.entries(r.agents)) {
    if (!ALIAS.test(alias)) p.push(aliasProblem(alias));
    if (!a || typeof a !== "object") {
      p.push(`${alias}: not an object`);
      continue;
    }
    if (typeof a.agentId !== "string" || !a.agentId) p.push(`${alias}: agentId required`);
    const d = a.deliver;
    if (!d || (d.kind !== "webhook" && d.kind !== "sendprompt")) p.push(`${alias}: deliver.kind must be webhook or sendprompt`);
    if (d && !d.url && !d.urlRef) p.push(`${alias}: deliver.url or deliver.urlRef required`);
    if (d?.url !== undefined && !isLiteralUrlHostAllowed(d.url)) {
      p.push(`${alias}: literal deliver.url only for loopback/example.com/.test hosts; use urlRef (env:/file:) for real routine URLs`);
    }
    if (d?.urlRef !== undefined && !isSecretRef(d.urlRef)) p.push(`${alias}: deliver.urlRef must be env:NAME or file:/path`);
    if (d && !isSecretRef(d.keyRef)) p.push(`${alias}: deliver.keyRef must be env:NAME or file:/path`);
    for (const k of Object.keys(d ?? {})) {
      if (/^(key|token|secret|password)$/i.test(k)) p.push(`${alias}: literal deliver.${k} is refused; use keyRef`);
    }
  }
  return p;
}
