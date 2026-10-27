/**
 * Fail-closed boolean flags (shared with the grokbuild client's read-only switch).
 *
 * - unset, empty, or an unexpanded ${...} placeholder: the default
 * - 1/true/yes/on: true; 0/false/no/off: false (case-insensitive)
 * - anything else: the SAFE value, with a warning
 */
const ON = ["1", "true", "yes", "on"];
const OFF = ["0", "false", "no", "off"];
const PLACEHOLDER = /^\$\{[^}]*\}$/;

export interface FlagResolution {
  value: boolean;
  source: "default" | "on" | "off" | "unrecognised";
  warning?: string;
}

export function resolveFlag(
  raw: unknown,
  opts: { name: string; defaultValue: boolean; safeValue: boolean },
): FlagResolution {
  if (typeof raw === "boolean") return { value: raw, source: raw ? "on" : "off" };
  if (typeof raw !== "string") return { value: opts.defaultValue, source: "default" };
  const v = raw.trim();
  if (v === "" || PLACEHOLDER.test(v)) return { value: opts.defaultValue, source: "default" };
  const lower = v.toLowerCase();
  if (ON.includes(lower)) return { value: true, source: "on" };
  if (OFF.includes(lower)) return { value: false, source: "off" };
  return {
    value: opts.safeValue,
    source: "unrecognised",
    warning: `${opts.name}=${JSON.stringify(v.slice(0, 32))} is not a recognised value; using the safe value (${opts.safeValue}).`,
  };
}
