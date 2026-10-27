import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Local-planner hop, ported from the existing Discord bridge.
 *
 * A route with `handler: "local-planner"` does NOT wake the agent. The bridge:
 *   1. replies ONCE with "Working on it. (0s)" and edits it every 5 s;
 *   2. POSTs the planner (URL + bearer from refs) with the REAL Discord
 *      message id, the callback URL and the working message id, on the query
 *      string and in the JSON body (never a token on the query string);
 *   3. never aborts that call: the listener may hold it until the job exits.
 *
 * Outcomes: accepted -> ✅ reaction, the working message stays until the
 * planner's callback edits it (success OR failure text). start_failed (not
 * configured, bad URL, 401/403/404) -> the working message is edited to
 * "Couldn't start that.". A dropped connection / timeout is transport: a
 * warning only, never a red X.
 */
export interface PlannerRequest {
  userPrompt: string;
  /** attachment[0] CDN URL (base image). Empty when text-only. */
  imagePath: string;
  /** attachment[1] CDN URL (optional reference). */
  referenceImagePath?: string;
  /** Up to two attachment URLs: [base, optional reference]. */
  imagePaths?: string[];
  channelId: string;
  slug: string;
  /** Inbound Discord message id. Never a placeholder. */
  messageId: string;
  /** Bridge callback URL. No token: auth stays on the callback request headers. */
  callbackUrl: string;
  /** The bridge's "Working on it." message id, when one was posted. */
  statusMessageId?: string;
  dryRun: boolean;
  /** Grok Build chat hop only: short profile name the local chat process runs. */
  profile?: string;
  /** Grok Build chat hop only: inbound attachment refs (URLs, never downloaded). */
  attachments?: { url: string; filename?: string; contentType?: string; size?: number }[];
}

export interface PlannerResult {
  ok: boolean;
  status: number;
  exitCode?: number;
  detail?: string;
}

export const PLANNER_HANDLER = "local-planner";
/**
 * Grok Build chat-hop variant: same listener and auth, but POSTs to /chat (the planner URL
 * with a trailing /plan swapped for /chat, or planner.chatUrlRef) with the route's `profile`
 * and the attachment refs. The working message is only posted after chatWorkingDelayMs
 * (default 15 s); if the reply arrives first it's a new reply and no working message is posted.
 */
export const CHAT_HANDLER = "grokbuild-chat";
export const CHAT_WORKING_DELAY_MS = 15_000;
export const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** /plan -> /chat on the planner URL. undefined when the URL doesn't end in /plan. */
export function chatUrlFromPlanner(plannerUrl: string | undefined): string | undefined {
  if (!plannerUrl) return undefined;
  try {
    const u = new URL(plannerUrl.trim());
    if (!/\/plan\/?$/.test(u.pathname)) return undefined;
    u.pathname = u.pathname.replace(/\/plan\/?$/, "/chat");
    return u.toString();
  } catch {
    return undefined;
  }
}
export const PLANNER_WORKING_TEXT = "Working on it.";
export const PLANNER_START_FAILED_TEXT = "Couldn't start that.";
export const PLANNER_PULSE_MS = 5_000;

export function workingProgressText(elapsedMs: number): string {
  return `${PLANNER_WORKING_TEXT} (${Math.max(0, Math.round(elapsedMs / 1000))}s)`;
}

export type PlannerUserSignal = "start_failed" | "transport" | "accepted" | "inconclusive";

export function plannerUserSignal(r: PlannerResult): PlannerUserSignal {
  if (r.detail === "planner_not_configured" || r.detail === "planner_bad_url" || r.status === 401 || r.status === 403 || r.status === 404) {
    return "start_failed";
  }
  if (r.status === 0 || r.detail === "planner_transport") return "transport";
  return r.ok ? "accepted" : "inconclusive";
}

/** a[0] = base (imagePath), a[1] = optional reference. a[2+] ignored. */
export function plannerImageFields(refs: ReadonlyArray<{ url: string }>): Pick<PlannerRequest, "imagePath" | "referenceImagePath" | "imagePaths"> {
  const urls = refs.map((r) => (typeof r.url === "string" ? r.url.trim() : "")).filter(Boolean).slice(0, 2);
  return {
    imagePath: urls[0] ?? "",
    ...(urls[1] ? { referenceImagePath: urls[1] } : {}),
    ...(urls.length ? { imagePaths: urls } : {}),
  };
}

export const PLANNER_STRIPPED_PARAMS = ["token", "access_token", "key"] as const;

export function withPlannerQuery(plannerUrl: string, messageId: string, callbackUrl: string, statusMessageId?: string): string {
  const u = new URL(plannerUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("planner_bad_url");
  u.searchParams.set("messageId", messageId);
  u.searchParams.set("callbackUrl", callbackUrl);
  if (statusMessageId?.trim()) u.searchParams.set("statusMessageId", statusMessageId.trim());
  else u.searchParams.delete("statusMessageId");
  // Never forward credentials on the query string.
  for (const k of PLANNER_STRIPPED_PARAMS) u.searchParams.delete(k);
  return u.toString();
}

export async function invokePlanner(
  url: string | undefined,
  token: string | undefined,
  body: PlannerRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<PlannerResult> {
  if (!url?.trim() || !token?.trim() || !body.callbackUrl) return { ok: false, status: 0, detail: "planner_not_configured" };
  let requestUrl: string;
  try {
    requestUrl = withPlannerQuery(url.trim(), body.messageId, body.callbackUrl, body.statusMessageId);
  } catch {
    return { ok: false, status: 0, detail: "planner_bad_url" };
  }
  try {
    // No abort signal on purpose (see header).
    const res = await fetchImpl(requestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token.trim()}` },
      body: JSON.stringify(body),
    });
    try {
      const parsed = (await res.json()) as { ok?: boolean; exitCode?: number; error?: string };
      return {
        ok: res.ok && parsed.ok === true,
        status: res.status,
        ...(typeof parsed.exitCode === "number" ? { exitCode: parsed.exitCode } : {}),
        ...(typeof parsed.error === "string" ? { detail: parsed.error.slice(0, 120) } : {}),
      };
    } catch {
      return { ok: false, status: res.status, detail: "planner_bad_response" };
    }
  } catch {
    return { ok: false, status: 0, detail: "planner_transport" };
  }
}

export interface PlannerEntry {
  channelId: string;
  statusMessageId: string;
  at: number;
  stop?: () => void;
}

/** Persisted entries older than this are dropped on load. */
export const PLANNER_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Working messages by origin message id (cap 200, oldest dropped), plus their pulse timers.
 * With a file, entries survive a restart (mode 600, atomic rename), so a planner callback that
 * lands after a bridge restart still edits its "Working on it." message. Pulse timers don't
 * survive (the message just stops ticking).
 */
export class PlannerStatusBook {
  private readonly byOrigin = new Map<string, PlannerEntry>();
  constructor(
    private readonly max = 200,
    private file = "",
    private readonly onWriteError: () => void = () => undefined,
  ) {}

  /** Load persisted entries (call once at init). */
  load(file: string, now = Date.now()): number {
    this.file = file;
    if (!file) return 0;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
      for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
        const { origin, channelId, statusMessageId, at } = (e ?? {}) as Record<string, unknown>;
        if (![origin, channelId, statusMessageId].every((x) => typeof x === "string" && /^\d{5,25}$/.test(x as string))) continue;
        if (typeof at !== "number" || now - at > PLANNER_STATE_TTL_MS) continue;
        this.byOrigin.set(origin as string, { channelId: channelId as string, statusMessageId: statusMessageId as string, at });
      }
    } catch {
      /* none yet */
    }
    return this.byOrigin.size;
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      rmSync(tmp, { force: true });
      const entries = [...this.byOrigin].map(([origin, e]) => ({ origin, channelId: e.channelId, statusMessageId: e.statusMessageId, at: e.at }));
      writeFileSync(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      this.onWriteError();
    }
  }

  remember(originId: string, channelId: string, statusMessageId: string, stop?: () => void, now = Date.now()): void {
    this.byOrigin.get(originId)?.stop?.();
    this.byOrigin.delete(originId);
    this.byOrigin.set(originId, { channelId, statusMessageId, at: now, stop });
    while (this.byOrigin.size > this.max) {
      const oldest = this.byOrigin.keys().next().value;
      if (oldest === undefined) break;
      this.byOrigin.get(oldest)?.stop?.();
      this.byOrigin.delete(oldest);
    }
    this.save();
  }

  lookup(originId: string | undefined) {
    return originId ? this.byOrigin.get(originId) : undefined;
  }

  /** Stop the pulse (callback arrived or start failed) but keep the entry. */
  stopPulse(originId: string | undefined): void {
    const e = this.lookup(originId);
    e?.stop?.();
    if (e) e.stop = undefined;
  }

  forget(originId: string | undefined): void {
    if (!originId || !this.byOrigin.has(originId)) return;
    this.byOrigin.get(originId)?.stop?.();
    this.byOrigin.delete(originId);
    this.save();
  }

  size(): number {
    return this.byOrigin.size;
  }

  /** Shutdown: stop every pulse timer but KEEP the persisted entries. */
  stopAll(): void {
    for (const e of this.byOrigin.values()) {
      e.stop?.();
      e.stop = undefined;
    }
  }

  /** Drop everything (memory and file). */
  clear(): void {
    this.stopAll();
    this.byOrigin.clear();
    this.save();
  }
}
