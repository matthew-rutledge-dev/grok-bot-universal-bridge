/**
 * Shared types for the core and every source adapter.
 *
 * An adapter turns something that happened at its source (a chat message, a
 * CLI request, a telemetry record) into an InboundEvent. The core decides
 * whether it may go anywhere (allowlist), which Grok Bot gets it (registry),
 * and delivers it with hold-and-retry. Replies come back through the
 * adapter's authenticated callback route.
 */

/** One thing that happened at a source and may be delivered to a Grok Bot. */
export interface InboundEvent {
  /** Adapter name, e.g. "discord". Set by the core. */
  adapter?: string;
  /** Source-unique id (message id, request id, ...). Used for dedupe and logs. */
  eventId: string;
  /** Ordering key. Events in one lane are delivered in order. */
  lane: string;
  /** Who caused it (user id, client id, vehicle id). Checked against the route's allowActors. */
  actor: string;
  /** Characters of the actor kept in audit lines (default 4), or "full" for no masking (the Tesla adapter, for VINs). */
  actorKeep?: 4 | 6 | "full";
  /** Optional groups the actor belongs to (roles). Checked against route.allowGroups. */
  actorGroups?: string[];
  /** Fields the route table matches on, e.g. { guild, channel }. Exact match only. */
  match: Record<string, string>;
  /** True when the event explicitly addressed the bridge (mention, direct request). */
  addressed?: boolean;
  /** Full prompt text for the agent, formatted by the adapter. */
  prompt: string;
  /** Extra metadata sent with the delivery. No secrets. */
  metadata?: Record<string, unknown>;
  /**
   * Adapter-private routing data kept with a held event (for example the
   * channel to post status into). Persisted in the hold store, so no secrets.
   */
  ref?: Record<string, string>;
}

/** One row in an adapter's route table. Deny-by-default: no row, no delivery. */
export interface Route {
  /** Optional stable id for logs (no spaces). */
  id?: string;
  enabled: boolean;
  /** Every key must equal the event's match value. An empty match never matches. */
  match: Record<string, string>;
  /** Actor ids allowed on this route. Empty = nobody. "*" = any actor (use only where the source already authenticates the actor). */
  allowActors: string[];
  /** Optional: when non-empty the actor must be in at least one of these groups. */
  allowGroups?: string[];
  /** Registry alias of the Grok Bot that gets matching events. */
  agent: string;
  /** When true the event must be addressed (e.g. a mention). */
  requireAddressed?: boolean;
  /** Adapter-specific extras (slug, label, ...). The core ignores them. */
  [extra: string]: unknown;
}

export type DenyReason =
  | "no_route"
  | "route_disabled"
  | "actor_not_allowlisted"
  | "group_not_allowlisted"
  | "not_addressed"
  | "agent_unknown"
  | "agent_not_ready"
  | "read_only"
  | "duplicate";

export interface DeliveryRequest {
  agentId: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryResult {
  status: number;
  body: unknown;
}

export interface Logger {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

export const consoleLogger: Logger = {
  info: (l) => console.log(l),
  warn: (l) => console.warn(l),
  error: (l) => console.error(l),
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
