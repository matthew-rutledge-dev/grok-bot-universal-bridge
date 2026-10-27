import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * User directory: Discord user id -> names, learned from allowlisted human message authors
 * (and interaction users), plus an optional read-only seed of operator labels. Bounded:
 * at most `max` entries (default 5000), least recently seen dropped first; seed labels are
 * kept apart and never evicted.
 *
 * Names and timestamps only (no message text, no tokens). Stored in the data dir
 * (`discord-user-directory.json`, mode 600, atomic, debounced). Labels from the seed
 * always win; names are display only, the user id stays the authority.
 *
 * Seed format (host-only file, e.g. the old bridge's config/user-directory.seed.json):
 *   { "version": 1, "users": { "<userId>": { "label": "…", "username"?: "…", "displayName"?: "…" } } }
 */
export interface UserEntry {
  username?: string;
  globalName?: string;
  displayName?: string;
  label?: string;
  firstSeen: string;
  lastSeen?: string;
}

/** Same keys as the old bridge's wake JSON / metadata.discordUser. */
export interface WakeIdentity {
  un?: string;
  dn?: string;
  lb?: string;
}

const ID = /^\d{5,25}$/;
const MAX_NAME = 64;
export const USER_DIRECTORY_MAX = 5000;

function clean(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, MAX_NAME) : undefined;
}

function toIdentity(e: UserEntry | undefined): WakeIdentity {
  const out: WakeIdentity = {};
  if (e?.username) out.un = e.username;
  if (e?.displayName) out.dn = e.displayName;
  if (e?.label) out.lb = e.label;
  return out;
}

export class UserDirectory {
  private readonly users = new Map<string, UserEntry>();
  private readonly seedLabels = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: { file: string; seedPath?: string; writeDelayMs?: number; now?: () => Date; warn?: (l: string) => void; max?: number }) {}

  private get max(): number {
    return Math.max(1, this.opts.max ?? USER_DIRECTORY_MAX);
  }

  /** Insert as most recently seen, then drop the least recently seen past the cap. */
  private put(id: string, e: UserEntry): void {
    this.users.delete(id);
    this.users.set(id, e);
    while (this.users.size > this.max) {
      const oldest = this.users.keys().next().value;
      if (oldest === undefined) break;
      this.users.delete(oldest);
    }
  }

  private now() {
    return (this.opts.now ?? (() => new Date()))().toISOString();
  }

  load(): { users: number; seeded: number } {
    const saved = this.read(this.opts.file) as { users?: Record<string, Partial<UserEntry>> } | undefined;
    // Oldest lastSeen first, so the cap keeps the most recently seen users.
    const rows = Object.entries(saved?.users ?? {}).sort(([, a], [, b]) => String(a?.lastSeen ?? a?.firstSeen ?? "").localeCompare(String(b?.lastSeen ?? b?.firstSeen ?? "")));
    for (const [id, e] of rows) {
      if (!ID.test(id) || !e || typeof e !== "object") continue;
      this.put(id, {
        username: clean(e.username),
        globalName: clean(e.globalName),
        displayName: clean(e.displayName),
        label: clean(e.label),
        firstSeen: typeof e.firstSeen === "string" ? e.firstSeen : this.now(),
        lastSeen: typeof e.lastSeen === "string" ? e.lastSeen : undefined,
      });
    }
    let seeded = 0;
    const seed = this.read(this.opts.seedPath ?? "") as { users?: Record<string, { label?: unknown; username?: unknown; displayName?: unknown }> } | undefined;
    for (const [id, s] of Object.entries(seed?.users ?? {})) {
      if (!ID.test(id) || !s || typeof s !== "object") continue;
      const label = clean(s.label);
      if (label) this.seedLabels.set(id, label);
      const e = this.users.get(id) ?? { firstSeen: this.now() };
      if (label) e.label = label;
      e.username ??= clean(s.username);
      e.displayName ??= clean(s.displayName);
      this.put(id, e);
      seeded++;
    }
    return { users: this.users.size, seeded };
  }

  private merged(input: { id: string; username?: string | null; globalName?: string | null; displayName?: string | null }): UserEntry {
    const prev = this.users.get(input.id);
    const username = clean(input.username);
    const globalName = clean(input.globalName);
    const displayName = clean(input.displayName) ?? globalName ?? username;
    const now = this.now();
    return {
      username: username ?? prev?.username,
      globalName: globalName ?? prev?.globalName,
      displayName: displayName ?? prev?.displayName,
      label: this.seedLabels.get(input.id) ?? prev?.label,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
    };
  }

  learn(input: { id: string; username?: string | null; globalName?: string | null; displayName?: string | null }): void {
    if (!ID.test(input.id)) return;
    this.put(input.id, this.merged(input));
    this.schedule();
  }

  /** Identity and label as if `input` were learned, without storing anything (pre-allowlist). */
  preview(input: { id: string; username?: string | null; globalName?: string | null; displayName?: string | null }, fallback: string): { who: WakeIdentity; label: string } {
    const e = ID.test(input.id) ? this.merged(input) : this.users.get(input.id);
    const who = toIdentity(e);
    return { who, label: who.lb ?? who.dn ?? who.un ?? fallback };
  }

  size(): number {
    return this.users.size;
  }

  identity(id: string): WakeIdentity {
    return toIdentity(this.users.get(id));
  }


  /** Prompt label: seed label, else display name, else username, else the fallback. */
  label(id: string, fallback: string): string {
    const w = this.identity(id);
    return w.lb ?? w.dn ?? w.un ?? fallback;
  }

  get(id: string): UserEntry | undefined {
    return this.users.get(id);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.write();
  }

  private schedule(): void {
    if (!this.opts.file) return;
    const delay = this.opts.writeDelayMs ?? 2000;
    if (delay <= 0) return this.write();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, delay);
    this.timer.unref?.();
  }

  private write(): void {
    if (!this.opts.file) return;
    try {
      mkdirSync(dirname(this.opts.file), { recursive: true });
      const tmp = `${this.opts.file}.tmp`;
      rmSync(tmp, { force: true });
      const users = Object.fromEntries([...this.users.entries()].sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(tmp, JSON.stringify({ version: 1, users }), { mode: 0o600 });
      renameSync(tmp, this.opts.file);
    } catch {
      this.opts.warn?.("[discord] user directory write failed (memory only)");
    }
  }

  private read(path: string): unknown {
    if (!path) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") this.opts.warn?.("[discord] user directory/seed file unreadable");
      return undefined;
    }
  }
}
