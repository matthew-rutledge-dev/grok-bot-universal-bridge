import { escapeTrailerMark, oneLine } from "../../core/redact.js";
import type { DiscordAttachmentRef } from "./port.js";

/**
 * Compact wake prompt, the same grammar the existing Discord bridge sends
 * (so agent-side reply skills keep working after the pointer-only switch):
 *
 *   Discord #<channel> from <label>: <text>
 *   Discord DM from <label>: <text>
 *   ⟂ d:<slug>:<msgId> u=<userId> c=<channelId> [g=<guildId>] [map=<alias>] [a=<url>]...
 */
export const TRAILER_MARK = "\u27C2";

export interface PromptArgs {
  slug: string;
  messageId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  label: string;
  alias: string;
  text: string;
  channelName?: string;
  attachments?: DiscordAttachmentRef[];
}

const enc = (v: string) => v.replace(/[%\s\u0000-\u001f\u007f]/g, (ch) => encodeURIComponent(ch));

export function stripMention(content: string, botUserId: string | null): string {
  if (!botUserId) return content.trim();
  return content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
}

export function formatPrompt(a: PromptArgs): string {
  // Only the bridge may write the trailer mark: escape it in everything a user controls.
  const who = escapeTrailerMark(oneLine(a.label)) || `user ${a.userId}`;
  const where = a.guildId ? `Discord #${escapeTrailerMark(oneLine(a.channelName ?? "")) || a.slug}` : "Discord DM";
  const trailer = [TRAILER_MARK, `d:${a.slug}:${a.messageId}`, `u=${a.userId}`, `c=${a.channelId}`];
  if (a.guildId) trailer.push(`g=${a.guildId}`);
  if (a.alias) trailer.push(`map=${enc(a.alias)}`);
  for (const r of a.attachments ?? []) trailer.push(`a=${r.url.replace(/\s/g, "%20")}`);
  // Same header as the existing bridge: "(N attachment[s])", and no ": text" when the message is attachment-only.
  const n = a.attachments?.length ?? 0;
  const att = n > 0 ? ` (${n} attachment${n === 1 ? "" : "s"})` : "";
  const header = `${where} from ${who}${att}:`;
  const body = a.text ? `${header} ${escapeTrailerMark(a.text)}` : header;
  return `${body}\n${trailer.join(" ")}`;
}

/** Split text into Discord-sized chunks (2000 chars), preferring line breaks. */
export function chunk(text: string, max = 2000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

export type WakePromptFormat = "compact" | "legacy";

/**
 * Legacy wake prompt (the older bridge's WAKE_PROMPT_FORMAT=legacy, its 0.2.13 shape):
 *
 *   d:<slug>:<msgId>
 *   {"id":"d:<slug>:<msgId>","g":<guildId|null>,"u":"<userId>","map":"<alias>","un"?,"dn"?,"lb"?,"c":"<channelId>","a"?:[{url,filename?,contentType?,size?}]}
 *   <text>
 *
 * Kept only for rollback of agent-side readers; compact is the default.
 */
export function formatLegacyPrompt(a: PromptArgs & { who?: { un?: string; dn?: string; lb?: string } }): string {
  const id = `d:${a.slug}:${a.messageId}`;
  const thin: Record<string, unknown> = { id, g: a.guildId, u: a.userId, map: a.alias };
  if (a.who?.un) thin.un = a.who.un;
  if (a.who?.dn) thin.dn = a.who.dn;
  if (a.who?.lb) thin.lb = a.who.lb;
  if (a.channelId) thin.c = a.channelId;
  if (a.attachments?.length) {
    thin.a = a.attachments.map((r) => ({
      url: r.url,
      ...(r.filename ? { filename: r.filename } : {}),
      ...(r.contentType ? { contentType: r.contentType } : {}),
      ...(typeof r.size === "number" ? { size: r.size } : {}),
    }));
  }
  // The user's text can't fake the first two lines: they are always written by the bridge first.
  return [id, JSON.stringify(thin), a.text].join("\n");
}
