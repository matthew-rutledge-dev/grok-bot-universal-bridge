#!/usr/bin/env node
// Convert the older Discord bridge's host config into universal-bridge host config.
//
//   node scripts/migrate-old-config.mjs --security <old>/config/security.json \
//        --channel-map <old>/config/channel-map.json --env <old>/.env \
//        [--registry <host>/registry.json] [--seed <old>/config/user-directory.seed.json] \
//        [--seed-target /app/config/user-directory.seed.json] [--out-dir <host>/migrated] \
//        [--env-out <host>/migrated/discord-extra.env] [--no-legacy-paths] [--planner-handler <old alias>]
//        [--gateway-url-ref env:NAME] [--gateway-token-ref env:NAME]
//
// Reads: security.json, channel-map.json, and the .env KEY NAMES plus non-secret values
// (ids, flags, policy, paths). Secret keys are never read for their value: they become
// env:NAME refs, so the same .env keeps working. Nothing secret is printed.
// Output: one JSON bundle on stdout ({ discord, registryAdditions, bridgePatch, env, warnings }),
// or, with --out-dir, discord.json / registry.additions.json / bridge.patch.json / warnings.txt
// (mode 600). Per-row sendPromptUrl values (they can carry secrets) are only written to
// --env-out (mode 600) as NAME=value lines; stdout shows the names only.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Keys whose values are secrets (or secret-bearing URLs): referenced, never copied or printed. */
export const SECRET_KEYS = new Set([
  "DISCORD_BOT_TOKEN",
  "GROK_BOT_GATEWAY_TOKEN",
  "GROK_BOT_SENDPROMPT_URL",
  "CALLBACK_TOKEN",
  "LOCAL_PLANNER_URL",
  "LOCAL_PLANNER_TOKEN",
  "SENDPROMPT_WAKE_URL",
  "SENDPROMPT_WAKE_KEY",
  "XAI_API_KEY",
]);

/**
 * Old local_handler values that mean the local media planner. The names (the canonical one and
 * its deprecated alias) are host-specific and kept out of git: pass each with
 * --planner-handler <name> (repeatable). Any other value kept the agent wake in the old bridge.
 */
export const MEDIA_PLANNER_HANDLERS = [];
const ID = /^\d{5,25}$/;

export const DEFAULT_GATEWAY_URL_REF = "env:GROK_BOT_SENDPROMPT_URL";
export const DEFAULT_GATEWAY_TOKEN_REF = "env:GROK_BOT_GATEWAY_TOKEN";
// Mirrors core/secrets.ts isSecretRef (file: needs an absolute path, per this platform's
// path.isAbsolute), and additionally refuses any whitespace in the ref.
const isRef = (v) => typeof v === "string" && !/\s/.test(v) && (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(v) || (v.startsWith("file:") && v.length > 5 && isAbsolute(v.slice(5))));

export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

const csv = (v) => String(v ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const uniq = (a) => [...new Set(a.filter((x) => typeof x === "string" && x))];
const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 64);
const envName = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export function isLocalPlannerRow(row, handlers = MEDIA_PLANNER_HANDLERS) {
  return Boolean(row?.enabled) && row.primary_llm === "local" && row.wake_agent === false && handlers.includes(String(row.local_handler ?? "").trim());
}
export function isGrokBuildRow(row, handlers = MEDIA_PLANNER_HANDLERS) {
  if (!row?.enabled || row.primary_llm !== "local" || row.wake_agent !== false || row.harness !== "grok-build") return false;
  if (handlers.includes(String(row.local_handler ?? "").trim())) return false;
  return typeof row.profile === "string" && row.profile.trim().length > 0;
}

/**
 * Pure conversion. `env` holds the old .env (secret values are ignored), `registry` the
 * existing host registry (aliases are reused by agentId). Returns the bundle plus extraEnv
 * (NAME -> value for per-row sendPrompt URLs; write it only to a mode-600 file).
 */
export function convert({ security = {}, channelMap = {}, env = {}, registry = { agents: {} }, seedTarget, legacyPaths = true, plannerHandlers = [], gatewayUrlRef = DEFAULT_GATEWAY_URL_REF, gatewayTokenRef = DEFAULT_GATEWAY_TOKEN_REF }) {
  for (const [flag, v] of [["--gateway-url-ref", gatewayUrlRef], ["--gateway-token-ref", gatewayTokenRef]]) {
    if (!isRef(v)) throw new Error(`${flag} must be an env:NAME or file:/path ref, not a literal`);
  }
  const handlers = [...MEDIA_PLANNER_HANDLERS, ...plannerHandlers];
  const warnings = [];
  const extraEnv = {};
  const registryAdditions = {};
  const known = new Map(); // agentId -> alias
  for (const [alias, a] of Object.entries(registry?.agents ?? {})) if (a?.agentId && !known.has(a.agentId)) known.set(a.agentId, alias);
  const taken = new Set(Object.keys(registry?.agents ?? {}));
  const isZero = (id) => !id || /^[0-]+$/.test(String(id));

  const aliasFor = (agentId, hint, urlRef) => {
    if (known.has(agentId)) return known.get(agentId);
    let base = slugify(hint) || "agent";
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}-${n}`;
    taken.add(alias);
    known.set(agentId, alias);
    registryAdditions[alias] = { agentId, deliver: { kind: "sendprompt", urlRef, keyRef: gatewayTokenRef } };
    return alias;
  };

  const envAllow = csv(env.DISCORD_ALLOWFROM);
  const envRoles = csv(env.DISCORD_ALLOW_ROLES);
  const envChannels = csv(env.DISCORD_ALLOW_CHANNELS);
  const pin = String(env.DISCORD_GUILD_ID ?? "").trim();
  const mentionDefault = String(env.REQUIRE_MENTION_DEFAULT ?? "true").trim() !== "false";
  const guilds = Object.entries(security.guilds ?? {}).filter(([id, g]) => {
    if (!ID.test(id)) return false;
    if (pin && pin !== id) {
      warnings.push(`guild ${id} skipped: DISCORD_GUILD_ID pins another guild`);
      return false;
    }
    return true;
  });
  if (!guilds.length) warnings.push("no usable guild in security.json: every channel route is disabled");

  const defaultUrlRef = channelMap.defaultSendPromptUrl ? "env:DISCORD_DEFAULT_SENDPROMPT_URL" : gatewayUrlRef;
  if (channelMap.defaultSendPromptUrl) extraEnv.DISCORD_DEFAULT_SENDPROMPT_URL = String(channelMap.defaultSendPromptUrl);

  const routes = [];
  const routeChannels = new Set();
  for (const row of channelMap.channels ?? []) {
    if (!row || !ID.test(String(row.channelId ?? ""))) {
      warnings.push("channel-map row without a valid channelId skipped");
      continue;
    }
    const slug = row.slug || row.channelId;
    const planner = isLocalPlannerRow(row, handlers);
    const chat = !planner && isGrokBuildRow(row, handlers);
    if (!planner && !chat && row.wake_agent === false) {
      warnings.push(`row ${slug}: wake_agent=false without a known local_handler or grok-build harness+profile still woke the agent in the old bridge; kept as an agent route`);
      if (row.local_handler) warnings.push(`row ${slug}: local_handler "${String(row.local_handler).slice(0, 64)}" is not a known planner handler; if it is the media planner's handler name (or its deprecated alias), rerun with --planner-handler <that name>`);
    }
    let agent;
    let urlRef = defaultUrlRef;
    if (row.sendPromptUrl) {
      const name = `DISCORD_SENDPROMPT_URL_${envName(slug)}`;
      extraEnv[name] = String(row.sendPromptUrl);
      urlRef = `env:${name}`;
    }
    if (planner || chat) {
      agent = slugify(row.alias) || `local-hop-${slugify(slug) || "row"}`; // labels the audit only; no wake
    } else if (isZero(row.agentId)) {
      agent = slugify(row.alias || slug) || "unassigned";
      if (row.enabled) warnings.push(`row ${slug}: enabled without an agentId (old bridge refused it: channel_map_missing_agent); route disabled`);
    } else {
      agent = aliasFor(row.agentId, row.alias || slug, urlRef);
      if (row.sendPromptUrl && registry?.agents?.[agent]) warnings.push(`row ${slug}: per-row sendPromptUrl ignored, the registry entry "${agent}" already says how to deliver`);
    }
    const oldMap = row.alias || (isZero(row.agentId) ? "" : row.agentId);
    for (const [gi, [gid, g]] of guilds.entries()) {
      const allowChannels = uniq([...(g.allowChannels ?? []), ...envChannels]);
      const channelOk = allowChannels.length === 0 || allowChannels.includes(row.channelId);
      if (!channelOk && row.enabled) warnings.push(`row ${slug}: not in allowChannels for guild ${gid}; route disabled`);
      const enabled = Boolean(row.enabled) && g.enabled !== false && channelOk && (planner || chat || !isZero(row.agentId));
      const route = {
        id: guilds.length > 1 ? `${slugify(slug) || "row"}-g${gi + 1}` : slugify(slug) || "row",
        enabled,
        match: { guild: gid, channel: row.channelId },
        allowActors: uniq([...(g.allowFrom ?? []), ...envAllow]),
        allowGroups: uniq([...(g.allowRoles ?? []), ...envRoles]),
        agent,
        requireAddressed: row.requireMention ?? g.requireMention ?? mentionDefault,
        slug,
      };
      if (row.label) route.label = String(row.label);
      if (oldMap && oldMap !== agent) route.map = oldMap;
      if (planner) route.handler = "local-planner";
      if (chat) Object.assign(route, { handler: "grokbuild-chat", profile: row.profile.trim() });
      if (!route.allowActors.length && enabled) warnings.push(`row ${slug}: no allowFrom users (deny-by-default: nobody can use it)`);
      routes.push(route);
      routeChannels.add(row.channelId);
    }
  }

  // DMs: policy, allowlist, owners, per-user agents, default agent.
  const dm = security.dm ?? {};
  const rawPolicy = String(env.DISCORD_DM_POLICY || dm.policy || "pairing");
  const policy = rawPolicy === "allowlist" || rawPolicy === "disabled" ? rawPolicy : "pairing";
  const allowUsers = uniq([...(dm.allowFrom ?? []), ...envAllow]).filter((u) => ID.test(u));
  const ownerIds = uniq([dm.ownerId, env.DISCORD_OWNER_ID, ...guilds.map(([, g]) => g.ownerId)].map((x) => String(x ?? "").trim())).filter((u) => ID.test(u));
  const dmOut = { policy, allowUsers, ownerIds };
  if (dm.slug) dmOut.slug = dm.slug;
  if (dm.defaultAgentId && !isZero(dm.defaultAgentId)) {
    dmOut.defaultAgent = aliasFor(dm.defaultAgentId, dm.alias || "dm-default", gatewayUrlRef);
    const oldMap = dm.alias || dm.defaultAgentId;
    if (oldMap !== dmOut.defaultAgent) dmOut.map = oldMap;
  }
  const dmRoutes = [];
  for (const [userId, raw] of Object.entries(dm.agentsByUser ?? {})) {
    const a = typeof raw === "string" ? { agentId: raw } : raw ?? {};
    const agentId = String(a.agentId ?? "").trim();
    if (!ID.test(userId) || !agentId) continue;
    if (!allowUsers.includes(userId)) {
      warnings.push(`dm.agentsByUser ${userId}: not on dm.allowFrom/DISCORD_ALLOWFROM (the old bridge needed pairing for them); skipped`);
      continue;
    }
    const agent = aliasFor(agentId, a.alias || `dm-${userId.slice(-4)}`, gatewayUrlRef);
    const oldMap = a.alias || dm.alias || agentId;
    dmRoutes.push({ userId, agent, ...(oldMap !== agent ? { map: oldMap } : {}) });
  }
  if (!dmOut.defaultAgent && allowUsers.some((u) => !dmRoutes.some((r) => r.userId === u))) {
    warnings.push("some DM-allowlisted users have no agentsByUser entry and there is no defaultAgentId: their DMs stay refused (dm_no_agent), as before");
  }

  const callbackChannels = uniq([...guilds.flatMap(([, g]) => g.allowChannels ?? []), ...envChannels]).filter((c) => ID.test(c) && !routeChannels.has(c));
  const discord = {
    tokenRef: "env:DISCORD_BOT_TOKEN",
    callbackTokenRef: "env:CALLBACK_TOKEN",
    ignoreBots: security.ignoreBots !== false,
    wakePromptFormat: String(env.WAKE_PROMPT_FORMAT ?? "").trim().toLowerCase() === "legacy" ? "legacy" : "compact",
    routes,
    dm: dmOut,
    dmRoutes,
    ...(callbackChannels.length ? { callbackChannels } : {}),
    attachments: { allowHttpHosts: [] },
    planner: { urlRef: "env:LOCAL_PLANNER_URL", tokenRef: "env:LOCAL_PLANNER_TOKEN", pulseMaxMs: 1800000, chatWorkingDelayMs: 15000 },
    voice: { enabled: false, channels: [], piperHostRef: "env:PIPER_HOST", piperPortRef: "env:PIPER_PORT", grokApiKeyRef: "env:XAI_API_KEY" },
  };
  const cbPath = String(env.CALLBACK_PATH || "/callback").trim();
  if (legacyPaths) discord.legacyPaths = { callback: cbPath.startsWith("/") ? cbPath : `/${cbPath}`, voicePlay: "/voice/play", voiceStream: "/voice/stream" };
  const cbBase = String(env.CALLBACK_BASE_URL ?? "").trim();
  if (cbBase && /^https?:\/\//.test(cbBase)) discord.planner.callbackUrl = `${cbBase.replace(/\/+$/, "")}${legacyPaths ? discord.legacyPaths.callback : "/discord/callback"}`;
  if (seedTarget) discord.users = { seedPath: seedTarget };

  warnings.push("voice: the old bridge joined any voice channel; list the allowed voice channel ids in discord.voice.channels and set enabled: true");
  warnings.push("voice: the old Piper defaults were PIPER_HOST=host.docker.internal, PIPER_PORT=10200; set them in .env if you relied on the defaults");
  if (security.hostAdmins && Object.keys(security.hostAdmins).length) warnings.push("security.hostAdmins dropped: the old bridge never used it at runtime (no Discord access, no command)");
  if ("LOCAL_PLANNER_POWERSHELL" in env) warnings.push("LOCAL_PLANNER_POWERSHELL dropped: the old 0.2.14 bridge no longer read it (the planner hop is a plain HTTP POST to LOCAL_PLANNER_URL)");
  if (String(env.HTTP_ONLY ?? "") === "1") warnings.push("HTTP_ONLY=1: bridgePatch disables the discord adapter (same effect: no Gateway login)");
  for (const k of SECRET_KEYS) if (!(k in env)) warnings.push(`.env has no ${k} (fine if that feature is unused)`);

  const holdMax = Number(env.SENDPROMPT_HOLD_MAX_SEC ?? 900);
  const rate = Number(env.CALLBACK_RATE_LIMIT_PER_MIN ?? 90);
  const bridgePatch = {
    hold: { maxSec: Number.isFinite(holdMax) && holdMax >= 0 ? Math.floor(holdMax) : 900 },
    wake: { urlRef: "env:SENDPROMPT_WAKE_URL", keyRef: "env:SENDPROMPT_WAKE_KEY", header: String(env.SENDPROMPT_WAKE_HEADER || "Authorization"), timeoutMs: 5000 },
    callbackRateLimitPerMin: Number.isFinite(rate) && rate >= 0 ? Math.floor(rate) : 90,
    adapters: { discord: { enabled: String(env.HTTP_ONLY ?? "") !== "1" } },
  };
  for (const [alias, a] of Object.entries(registryAdditions)) {
    warnings.push(`registry: new alias "${alias}" (sendprompt via ${a.deliver.urlRef}); an http:// URL that is not loopback is refused, use the https tunnel URL or switch it to a webhook routine`);
  }
  const refs = new Set();
  const walk = (v) => {
    if (typeof v === "string" && v.startsWith("env:")) refs.add(v.slice(4));
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk({ discord, registryAdditions, bridgePatch });
  return {
    bundle: { discord, registryAdditions, bridgePatch, env: { referenced: [...refs].sort(), extraWritten: Object.keys(extraEnv).sort() }, warnings },
    extraEnv,
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const readJson = (p, what) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`cannot read ${what} (${e.code ?? e.name})`);
    process.exit(2);
  }
};
function writePrivate(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
}

if (/migrate-old-config\.mjs$/.test(process.argv[1] ?? "")) {
  const sec = arg("--security");
  const map = arg("--channel-map");
  if (!sec || !map) {
    console.error("usage: migrate-old-config.mjs --security <security.json> --channel-map <channel-map.json> [--env <.env>] [--registry <registry.json>] [--seed <seed.json>] [--seed-target <path in container>] [--out-dir <dir>] [--env-out <file>] [--no-legacy-paths] [--planner-handler <name>] [--gateway-url-ref <env:NAME|file:path>] [--gateway-token-ref <env:NAME|file:path>]");
    process.exit(2);
  }
  const envFile = arg("--env");
  const env = envFile ? parseEnv(readFileSync(envFile, "utf8")) : {};
  const registry = arg("--registry") ? readJson(arg("--registry"), "registry") : { agents: {} };
  const seed = arg("--seed");
  const seedTarget = arg("--seed-target") ?? (seed && existsSync(seed) ? "/app/config/user-directory.seed.json" : undefined);
  for (const flag of ["--gateway-url-ref", "--gateway-token-ref"]) {
    if (process.argv.includes(flag) && !isRef(arg(flag))) {
      console.error(`${flag} must be an env:NAME or file:/path ref (literal values are refused)`);
      process.exit(2);
    }
  }
  const { bundle, extraEnv } = convert({
    security: readJson(sec, "security.json"),
    channelMap: readJson(map, "channel-map.json"),
    env,
    registry,
    seedTarget,
    legacyPaths: !process.argv.includes("--no-legacy-paths"),
    plannerHandlers: process.argv.flatMap((a, i) => (a === "--planner-handler" && process.argv[i + 1] ? [process.argv[i + 1]] : [])),
    gatewayUrlRef: arg("--gateway-url-ref") ?? DEFAULT_GATEWAY_URL_REF,
    gatewayTokenRef: arg("--gateway-token-ref") ?? DEFAULT_GATEWAY_TOKEN_REF,
  });
  const envOut = arg("--env-out");
  const outDir = arg("--out-dir");
  // Create every output directory before the first write, so --env-out may live inside a fresh --out-dir.
  if (outDir) mkdirSync(outDir, { recursive: true });
  if (envOut) mkdirSync(dirname(resolve(envOut)), { recursive: true });
  if (Object.keys(extraEnv).length) {
    if (envOut) writePrivate(envOut, Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    else bundle.warnings.push(`${Object.keys(extraEnv).length} URL value(s) need --env-out <file> (never printed): ${Object.keys(extraEnv).join(", ")}`);
  }
  if (outDir) {
    writePrivate(join(outDir, "discord.json"), JSON.stringify(bundle.discord, null, 2) + "\n");
    writePrivate(join(outDir, "registry.additions.json"), JSON.stringify(bundle.registryAdditions, null, 2) + "\n");
    writePrivate(join(outDir, "bridge.patch.json"), JSON.stringify(bundle.bridgePatch, null, 2) + "\n");
    writePrivate(join(outDir, "warnings.txt"), bundle.warnings.join("\n") + "\n");
    console.log(`wrote discord.json, registry.additions.json, bridge.patch.json, warnings.txt (${bundle.warnings.length} warnings)`);
    console.log(`env names referenced: ${bundle.env.referenced.join(", ")}`);
  } else {
    console.log(JSON.stringify(bundle, null, 2));
  }
}
