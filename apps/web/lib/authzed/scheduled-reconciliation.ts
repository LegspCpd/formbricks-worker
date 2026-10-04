import "server-only";

/**
 * Scheduled reconciliation.
 *
 * SpiceDB is not reachable from a Cloudflare Worker (gRPC/TCP is unavailable), so authorization is
 * answered directly from PostgreSQL (`lib/authorization/db-evaluator.ts`). There is no projection to
 * audit or repair, which makes this recurring job a genuine no-op rather than a degraded one: the
 * decision reads the source tables, so it can never drift from them.
 */
export const processAuthzedScheduledReconciliationJob = async (): Promise<void> => {};
