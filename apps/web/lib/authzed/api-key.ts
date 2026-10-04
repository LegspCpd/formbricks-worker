import "server-only";
import type { TAuthzedProjectionResult } from "./projection";

/**
 * API-key projection.
 *
 * Authorization is answered directly from PostgreSQL (see `lib/authorization/db-evaluator.ts`), so
 * there is no SpiceDB graph to maintain. These are no-ops kept for the mutation-hook call sites.
 */

export type { TAuthzedProjectionResult } from "./projection";

export type TApiKeyWorkspaceProjectionTarget = Readonly<{
  apiKeyId: string;
  workspaceId: string;
}>;

export type TApiKeyProjectionTargets = Readonly<{
  apiKeyIds?: ReadonlyArray<string>;
  apiKeyWorkspaceGrants?: ReadonlyArray<TApiKeyWorkspaceProjectionTarget>;
}>;

export const reconcileApiKeyRelationships = async (
  _targets: TApiKeyProjectionTargets
): Promise<TAuthzedProjectionResult> => ({ status: "disabled" });
