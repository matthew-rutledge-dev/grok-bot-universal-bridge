import type { DenyReason, InboundEvent, Route } from "./types.js";

/**
 * Deny-by-default route matching.
 *
 * - No route table, or no row whose `match` equals the event's fields: deny.
 * - A row with an empty `match` never matches (it would match everything).
 * - First matching row wins, even if it is disabled (so a disabled row can
 *   switch a source off without deleting it).
 * - `allowActors` empty: nobody. `"*"`: any actor.
 * - `allowGroups` non-empty: the actor must be in one of them.
 */
export type AuthzResult =
  | { ok: true; route: Route }
  | { ok: false; reason: DenyReason; route?: Route };

export function routeMatches(route: Route, match: Record<string, string>): boolean {
  const keys = Object.keys(route.match ?? {});
  if (keys.length === 0) return false;
  return keys.every((k) => {
    const want = route.match[k];
    return typeof want === "string" && want !== "" && match[k] === want;
  });
}

export function findRoute(routes: readonly Route[] | undefined, match: Record<string, string>): Route | undefined {
  if (!routes || routes.length === 0) return undefined;
  return routes.find((r) => routeMatches(r, match));
}

export function actorAllowed(route: Route, actor: string): boolean {
  const list = Array.isArray(route.allowActors) ? route.allowActors : [];
  if (list.length === 0) return false;
  if (list.includes("*")) return true;
  return actor !== "" && list.includes(actor);
}

export function groupAllowed(route: Route, groups: readonly string[] | undefined): boolean {
  const want = Array.isArray(route.allowGroups) ? route.allowGroups : [];
  if (want.length === 0) return true;
  const have = new Set(groups ?? []);
  return want.some((g) => have.has(g));
}

export function authorize(routes: readonly Route[] | undefined, event: InboundEvent): AuthzResult {
  const route = findRoute(routes, event.match);
  if (!route) return { ok: false, reason: "no_route" };
  if (route.enabled !== true) return { ok: false, reason: "route_disabled", route };
  if (!actorAllowed(route, event.actor)) return { ok: false, reason: "actor_not_allowlisted", route };
  if (!groupAllowed(route, event.actorGroups)) return { ok: false, reason: "group_not_allowlisted", route };
  if (route.requireAddressed === true && event.addressed !== true) {
    return { ok: false, reason: "not_addressed", route };
  }
  if (typeof route.agent !== "string" || route.agent.trim() === "") {
    return { ok: false, reason: "agent_unknown", route };
  }
  return { ok: true, route };
}

/** Validate a route table at startup. Returns problems (empty = fine). */
export function validateRoutes(routes: unknown, label: string): string[] {
  const problems: string[] = [];
  if (routes === undefined) return problems;
  if (!Array.isArray(routes)) return [`${label}: routes must be an array`];
  routes.forEach((r, i) => {
    const at = `${label}.routes[${i}]`;
    if (!r || typeof r !== "object") {
      problems.push(`${at}: not an object`);
      return;
    }
    const row = r as Partial<Route>;
    if (typeof row.enabled !== "boolean") problems.push(`${at}: enabled must be true or false`);
    if (!row.match || typeof row.match !== "object" || Object.keys(row.match).length === 0) {
      problems.push(`${at}: match must have at least one field`);
    }
    if (!Array.isArray(row.allowActors)) problems.push(`${at}: allowActors must be an array`);
    if (typeof row.agent !== "string" || !row.agent) problems.push(`${at}: agent alias required`);
  });
  return problems;
}
