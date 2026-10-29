import type { SourceAdapter } from "../core/bridge.js";
import { createDiscordAdapter, type DiscordAdapterConfig } from "./discord/index.js";
import { createGrokBuildAdapter, type GrokBuildConfig } from "./grokbuild/index.js";
import { createTeslaAdapter, type TeslaConfig } from "./tesla/index.js";
import { createTwitchAdapter, type TwitchConfig } from "./twitch/index.js";

/**
 * Adapter factories by name. Adding a source = a new folder under adapters/
 * plus one line here (see adapters/README.md). Factories get the adapter's
 * parsed config file and must validate it (deny-by-default).
 */
export const ADAPTERS: Record<string, (config: unknown) => Promise<SourceAdapter> | SourceAdapter> = {
  discord: (c) => createDiscordAdapter(c as DiscordAdapterConfig),
  grokbuild: (c) => createGrokBuildAdapter(c as GrokBuildConfig),
  tesla: (c) => createTeslaAdapter(c as TeslaConfig),
  twitch: (c) => createTwitchAdapter(c as TwitchConfig),
};
