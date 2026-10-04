import "server-only";
import type { TAuthzedOutboxDrainResult } from "./outbox-types";

/**
 * AuthZed projection outbox delivery.
 *
 * On Cloudflare Workers there is no SpiceDB to deliver into: authorization reads PostgreSQL directly
 * (`lib/authorization/db-evaluator.ts`), so a projection is never needed and cannot be stale. These
 * entry points keep the jobs graph's shape but do no work — in particular they never touch the
 * `AuthzedProjectionOutbox` table, whose source-table triggers only ever fire on SpiceDB deployments.
 */

const EMPTY_DRAIN: TAuthzedOutboxDrainResult = {
  claimed: 0,
  deadLettered: 0,
  delivered: 0,
  failed: 0,
  remaining: 0,
  status: "drained",
};

export const processAuthzedOutboxBatch = async (
  _leaseOwner?: string,
  _batchSize?: number
): Promise<Readonly<{ claimed: number; deadLettered: number; delivered: number; failed: number }>> => ({
  claimed: 0,
  deadLettered: 0,
  delivered: 0,
  failed: 0,
});

export const drainAuthzedOutbox = async (_maxBatches = 100): Promise<TAuthzedOutboxDrainResult> =>
  EMPTY_DRAIN;

export const processAuthzedProjectionDeliveryJob = async (): Promise<void> => {};
