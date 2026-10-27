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
}

export interface PlannerResult {
  ok: boolean;
  status: number;
  exitCode?: number;
  detail?: string;
}

export const PLANNER_HANDLER = "local-planner";
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

export function withPlannerQuery(plannerUrl: string, messageId: string, callbackUrl: string, statusMessageId?: string): string {
  const u = new URL(plannerUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("planner_bad_url");
  u.searchParams.set("messageId", messageId);
  u.searchParams.set("callbackUrl", callbackUrl);
  if (statusMessageId?.trim()) u.searchParams.set("statusMessageId", statusMessageId.trim());
  else u.searchParams.delete("statusMessageId");
  u.searchParams.delete("token");
  return u.toString();
}

export async function invokePlanner(
  url: string | undefined,
  token: string | undefined,
  body: PlannerRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<PlannerResult> {
  if (!url?.trim() || !token?.trim()) return { ok: false, status: 0, detail: "planner_not_configured" };
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

/** Working messages by origin message id (cap 200, oldest dropped), plus their pulse timers. */
export class PlannerStatusBook {
  private readonly byOrigin = new Map<string, { channelId: string; statusMessageId: string; stop?: () => void }>();
  constructor(private readonly max = 200) {}

  remember(originId: string, channelId: string, statusMessageId: string, stop?: () => void): void {
    this.forget(originId);
    this.byOrigin.set(originId, { channelId, statusMessageId, stop });
    while (this.byOrigin.size > this.max) {
      const oldest = this.byOrigin.keys().next().value;
      if (oldest === undefined) break;
      this.forget(oldest);
    }
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
    if (!originId) return;
    this.byOrigin.get(originId)?.stop?.();
    this.byOrigin.delete(originId);
  }

  size(): number {
    return this.byOrigin.size;
  }

  clear(): void {
    for (const id of [...this.byOrigin.keys()]) this.forget(id);
  }
}
