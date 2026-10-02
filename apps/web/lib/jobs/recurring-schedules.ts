import { type TRecurringBackgroundJobSchedule, type TRecurringJobKey } from "@formbricks/jobs";
import { USAGE_TELEMETRY_DAILY_CRON_PATTERN, USAGE_TELEMETRY_TIME_ZONE } from "@/lib/telemetry/constants";
import {
  WORKFLOWS_USAGE_SNAPSHOT_DAILY_CRON_PATTERN,
  WORKFLOWS_USAGE_SNAPSHOT_TIME_ZONE,
} from "@/modules/ee/workflows/lib/analytics/constants";
import { WORKFLOW_RUN_RECONCILE_INTERVAL_MS } from "@/modules/ee/workflows/lib/runner/reconcile-constants";
import {
  SURVEY_ARCHIVE_PURGE_DAILY_CRON_PATTERN,
  SURVEY_ARCHIVE_PURGE_TIME_ZONE,
} from "@/modules/survey/archive/lib/constants";
import {
  SURVEY_SCHEDULING_DAILY_CRON_PATTERN,
  SURVEY_SCHEDULING_TIME_ZONE,
} from "@/modules/survey/scheduling/lib/constants";

/**
 * When each recurring job runs — the single source of truth, kept apart from `recurring-registrations.ts`
 * (which pairs these with their handlers) so the schedules can be read without pulling the job-handler
 * graph in behind them. The Cloudflare scheduler needs exactly this half: it derives a Durable Object
 * alarm cadence from it, and loading tens of megabytes of handlers to read six intervals would make
 * every alarm expensive.
 *
 * Keyed by `TRecurringJobKey`, so declaring a job in `recurringJobDescriptors` without giving it a
 * schedule here is a build error rather than a job that quietly never runs.
 */
export const RECURRING_JOB_SCHEDULES_BY_KEY: Record<TRecurringJobKey, TRecurringBackgroundJobSchedule> = {
  authzedProjectionDelivery: {
    everyMs: 5_000,
    kind: "every",
  },
  authzedReconciliationAudit: {
    everyMs: 6 * 60 * 60 * 1_000,
    kind: "every",
  },
  surveyArchivePurge: {
    cronPattern: SURVEY_ARCHIVE_PURGE_DAILY_CRON_PATTERN,
    kind: "cron",
    timeZone: SURVEY_ARCHIVE_PURGE_TIME_ZONE,
  },
  surveyScheduling: {
    cronPattern: SURVEY_SCHEDULING_DAILY_CRON_PATTERN,
    kind: "cron",
    timeZone: SURVEY_SCHEDULING_TIME_ZONE,
  },
  usageTelemetry: {
    cronPattern: USAGE_TELEMETRY_DAILY_CRON_PATTERN,
    // The daily pattern keeps a long-running instance reporting. What covers an instance that is
    // *not* up at 02:15 UTC — the case the GTM need calls out, an instance identified and then
    // barely run (ENG-2107) — is that a missed tick is not skipped: the upsert re-adds the overdue
    // iteration with its original timestamp, so the delay clamps to 0 and it runs at the next boot.
    //
    // `immediately` fires **once per scheduler**, not once per boot. BullMQ's repeat strategy does
    // return "now" when it is set, but `addJobScheduler-11.lua` discards that: when the upsert
    // removed a pending job for this scheduler it sets `nextMillis = prevMillis` ("the job has been
    // removed and we want to replace it, so lets use the same millis"), which is every boot after
    // the first. So its real effect is the first-ever registration — which is exactly where it is
    // wanted, since this scheduler is new: every instance upgrading past this change registers it
    // for the first time and reports on that boot rather than waiting for the first 02:15 slot.
    // It is also cheap: `sendTelemetryEvents` is gated on a shared 24h timestamp in Redis, so that
    // run is a single Redis read whenever an update already went out.
    immediately: true,
    kind: "cron",
    timeZone: USAGE_TELEMETRY_TIME_ZONE,
  },
  workflowRunReconcile: {
    everyMs: WORKFLOW_RUN_RECONCILE_INTERVAL_MS,
    kind: "every",
  },
  workflowsUsageSnapshot: {
    cronPattern: WORKFLOWS_USAGE_SNAPSHOT_DAILY_CRON_PATTERN,
    kind: "cron",
    timeZone: WORKFLOWS_USAGE_SNAPSHOT_TIME_ZONE,
  },
};
