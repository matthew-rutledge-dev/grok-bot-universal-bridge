/** VIN-shaped: 17 characters, no I, O or Q. */
export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export interface VinAudit {
  actor: string;
  actorKeep: 6 | "full";
}

/**
 * Audit actor fields for a VIN (a VIN is not a secret; prompts keep their masked id / vin_last6 regardless).
 * - Allowlisted VIN with `audit_full_vin` on (the default): the full VIN.
 * - A foreign (non-allowlisted) VIN, or `audit_full_vin: false`: the last 6.
 * - Anything that isn't VIN-shaped (e.g. a free-form string from a decoded relay): written as "invalid", never raw.
 */
export function vinAuditActor(vin: string, allowlisted: boolean, fullVin: boolean): VinAudit {
  if (!VIN_RE.test(vin)) return { actor: "invalid", actorKeep: "full" };
  return allowlisted && fullVin ? { actor: vin, actorKeep: "full" } : { actor: vin, actorKeep: 6 };
}
