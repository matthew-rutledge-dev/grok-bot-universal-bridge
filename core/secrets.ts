import { readFileSync, statSync } from "node:fs";

/**
 * Secret references. Config and registry files never hold secret values,
 * only references:
 *
 *   env:NAME          -> process.env.NAME (the host renders .env, mode 600)
 *   file:/abs/path    -> first line of that file (e.g. a mounted secret)
 *
 * Anything else is refused, so a pasted literal key fails at startup instead
 * of sitting in a config file. Values are never logged or returned.
 */
export type SecretEnv = Record<string, string | undefined>;

const PLACEHOLDERS = new Set(["", "changeme", "change-me", "placeholder", "replace-me", "todo", "xxx"]);

export function isPlaceholderSecret(v: string | undefined): boolean {
  if (v === undefined) return true;
  const t = v.trim();
  if (PLACEHOLDERS.has(t.toLowerCase())) return true;
  if (/^\$\{[^}]*\}$/.test(t)) return true;
  if (/^<[^>]*>$/.test(t)) return true;
  return false;
}

export function isSecretRef(ref: unknown): ref is string {
  return typeof ref === "string" && /^(env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/.test(ref.trim());
}

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

/** Resolve a reference. Returns undefined when unset or a placeholder. Throws on a bad reference shape. */
export function resolveSecret(ref: string | undefined, env: SecretEnv = process.env): string | undefined {
  if (ref === undefined || ref === null || ref === "") return undefined;
  if (!isSecretRef(ref)) {
    throw new SecretError("secret reference must be env:NAME or file:/path (literal values are refused)");
  }
  const r = ref.trim();
  let value: string | undefined;
  if (r.startsWith("env:")) {
    value = env[r.slice(4)];
  } else {
    const path = r.slice(5);
    try {
      value = readFileSync(path, "utf8").split(/\r?\n/)[0];
    } catch {
      value = undefined;
    }
  }
  if (value === undefined) return undefined;
  const t = value.trim();
  return isPlaceholderSecret(t) ? undefined : t;
}

/** Like resolveSecret but throws (naming only the label and reference kind) when missing. */
export function requireSecret(ref: string | undefined, label: string, env: SecretEnv = process.env): string {
  const v = resolveSecret(ref, env);
  if (!v) {
    const kind = ref?.startsWith("file:") ? "file" : ref?.startsWith("env:") ? ref : "reference";
    throw new SecretError(`${label}: secret missing or placeholder (${kind})`);
  }
  return v;
}

/**
 * Warn when a secrets-bearing file is readable by group/other (POSIX only).
 * Returns a warning line or undefined.
 */
export function filePermissionWarning(path: string): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) return `${path} is mode ${mode.toString(8)}; expected 600 (or 400)`;
  } catch {
    return undefined;
  }
  return undefined;
}
