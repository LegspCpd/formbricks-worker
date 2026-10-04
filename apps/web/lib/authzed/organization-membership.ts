import "server-only";
import type { TAuthzedProjectionResult } from "./projection";

/**
 * Organization-membership projection.
 *
 * Formbricks on Cloudflare Workers answers authorization directly from PostgreSQL (see
 * `lib/authorization/db-evaluator.ts`), so there is no SpiceDB graph to project into. These entry
 * points are kept so the mutation-hook call sites and the jobs graph keep their shape, but they are
 * deliberate no-ops: every relationship they used to write is now read from the source tables at
 * decision time, which cannot go stale.
 */

export type { TAuthzedProjectionResult } from "./projection";

export type TOrganizationMembershipProjectionTarget = Readonly<{
  organizationId: string;
  userId: string;
}>;

export type TOrganizationMembershipProjectionTargets = Readonly<{
  memberships?: ReadonlyArray<TOrganizationMembershipProjectionTarget>;
}>;

const DISABLED: TAuthzedProjectionResult = { status: "disabled" };

export const reconcileOrganizationMemberships = async (
  _targets: TOrganizationMembershipProjectionTargets
): Promise<TAuthzedProjectionResult> => DISABLED;

/** Reconcile a single membership. Retained for the mutation-hook call sites. */
export const reconcileOrganizationMembership = async (
  _organizationId: string,
  _userId: string
): Promise<TAuthzedProjectionResult> => DISABLED;

export const deleteOrganizationRelationships = async (
  _organizationId: string
): Promise<TAuthzedProjectionResult> => DISABLED;

export const deleteUserOrganizationRelationships = async (
  _userId: string
): Promise<TAuthzedProjectionResult> => DISABLED;
