import "server-only";
import type { TAuthzedProjectionResult } from "./projection";

/**
 * Team/workspace projection.
 *
 * Authorization is answered directly from PostgreSQL (see `lib/authorization/db-evaluator.ts`), so
 * there is no SpiceDB graph to maintain. These are no-ops kept for the mutation-hook call sites.
 */

export type { TAuthzedProjectionResult } from "./projection";

export type TTeamMembershipProjectionTarget = Readonly<{
  teamId: string;
  userId: string;
}>;

export type TWorkspaceTeamProjectionTarget = Readonly<{
  teamId: string;
  workspaceId: string;
}>;

export type TTeamWorkspaceProjectionTargets = Readonly<{
  teamIds?: ReadonlyArray<string>;
  teamMemberships?: ReadonlyArray<TTeamMembershipProjectionTarget>;
  workspaceIds?: ReadonlyArray<string>;
  workspaceTeamGrants?: ReadonlyArray<TWorkspaceTeamProjectionTarget>;
}>;

const DISABLED: TAuthzedProjectionResult = { status: "disabled" };

export const reconcileTeamWorkspaceRelationships = async (
  _targets: TTeamWorkspaceProjectionTargets
): Promise<TAuthzedProjectionResult> => DISABLED;

export const deleteUserTeamRelationships = async (_userId: string): Promise<TAuthzedProjectionResult> =>
  DISABLED;
