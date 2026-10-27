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
  return `${where} from ${who}: ${escapeTrailerMark(a.text)}\n${trailer.join(" ")}`;
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
