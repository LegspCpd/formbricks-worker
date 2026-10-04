import "server-only";
import type { TAuthzedProjectionResult } from "./projection";

/**
 * Feedback-directory projection.
 *
 * Authorization is answered directly from PostgreSQL (see `lib/authorization/db-evaluator.ts`), so
 * there is no SpiceDB graph to maintain. These are no-ops kept for the mutation-hook call sites.
 */

export type { TAuthzedProjectionResult } from "./projection";

export type TFeedbackDirectoryAssignmentProjectionTarget = Readonly<{
  feedbackDirectoryId: string;
  workspaceId: string;
}>;

export type TFeedbackDirectoryProjectionTargets = Readonly<{
  feedbackDirectoryIds?: ReadonlyArray<string>;
  assignments?: ReadonlyArray<TFeedbackDirectoryAssignmentProjectionTarget>;
}>;

const DISABLED: TAuthzedProjectionResult = { status: "disabled" };

export const reconcileFeedbackDirectoryRelationships = async (
  _targets: TFeedbackDirectoryProjectionTargets
): Promise<TAuthzedProjectionResult> => DISABLED;

/** Full-deployment prune for an unattributable hashed assignment resource. */
export const deleteFeedbackDirectoryAssignmentRelationships = async (
  _assignmentIds: ReadonlyArray<string>
): Promise<TAuthzedProjectionResult> => DISABLED;
