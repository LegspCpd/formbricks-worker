import {
  type JobHandler,
  type JobHandlerOverrides,
  ONE_SHOT_JOB_NAMES,
  type RecurringJobHandle,
  type TGlobalScopeJobData,
  type TRecurringBackgroundJobSchedule,
  type TRecurringJobKey,
  type TResponsePipelineJobData,
  type TWebhookDeliveryJobData,
  type TWorkflowRunJobData,
  recurringJobs,
} from "@formbricks/jobs";
import { processAuthzedProjectionDeliveryJob } from "@/lib/authzed/outbox-processor";
import { processAuthzedScheduledReconciliationJob } from "@/lib/authzed/scheduled-reconciliation";
import { RECURRING_JOB_SCHEDULES_BY_KEY } from "@/lib/jobs/recurring-schedules";
import { processUsageTelemetryJob } from "@/lib/telemetry/process-usage-telemetry-job";
import { processWorkflowsUsageSnapshotJob } from "@/modules/ee/workflows/lib/analytics/process-workflows-usage-snapshot-job";
import { processWorkflowRunJob } from "@/modules/ee/workflows/lib/runner/process-workflow-run-job";
import { processWorkflowRunReconcileJob } from "@/modules/ee/workflows/lib/runner/process-workflow-run-reconcile-job";
import { processResponsePipelineJob } from "@/modules/response-pipeline/lib/process-response-pipeline-job";
import { processWebhookDeliveryJob } from "@/modules/response-pipeline/lib/process-webhook-delivery-job";
import { processSurveyArchivePurgeJob } from "@/modules/survey/archive/lib/process-survey-archive-purge-job";
import { processSurveySchedulingJob } from "@/modules/survey/scheduling/lib/process-survey-scheduling-job";

/**
 * Adapts an app handler to the worker's override signature. The worker validates the payload against
 * the job's schema before dispatching, so this is the single place where that already-checked value is
 * narrowed — rather than one unchecked cast per job.
 */
const toJobHandlerOverride =
  <TData>(handler: JobHandler<TData>): NonNullable<JobHandlerOverrides[string]> =>
  async (data, context) => {
    await handler(data as TData, context);
  };

interface RecurringJobRegistration {
  handler: JobHandler<TGlobalScopeJobData>;
  job: RecurringJobHandle;
  schedule: TRecurringBackgroundJobSchedule;
}

/**
 * What runs for each recurring job. Keyed by `TRecurringJobKey` deliberately: declaring a new job in
 * `recurringJobDescriptors` without adding it here is a build error rather than a job that quietly never
 * runs — its handler would never be registered.
 *
 * The job name, schedule identity and payload live with the declaration in `@formbricks/jobs`, and the
 * timing lives in `recurring-schedules.ts`, so none of them is spelled out here — which is what keeps a
 * schedule and its handler in step.
 */
const RECURRING_JOB_HANDLERS_BY_KEY: Record<TRecurringJobKey, JobHandler<TGlobalScopeJobData>> = {
  authzedProjectionDelivery: processAuthzedProjectionDeliveryJob,
  authzedReconciliationAudit: processAuthzedScheduledReconciliationJob,
  surveyArchivePurge: processSurveyArchivePurgeJob,
  surveyScheduling: processSurveySchedulingJob,
  usageTelemetry: processUsageTelemetryJob,
  workflowRunReconcile: processWorkflowRunReconcileJob,
  workflowsUsageSnapshot: processWorkflowsUsageSnapshotJob,
};

/**
 * Pairs each handler with its schedule and job handle, all three read from the same key. That pairing
 * used to be written out per entry, where a key could be given another job's handle and still
 * type-check — worse than a swap, since both entries then upsert the same scheduler and one job's
 * schedule is never registered at all. Deriving by key removes the failure mode instead of testing for
 * it.
 */
export const RECURRING_JOB_REGISTRATIONS_BY_KEY: Record<TRecurringJobKey, RecurringJobRegistration> =
  Object.fromEntries(
    (Object.keys(RECURRING_JOB_SCHEDULES_BY_KEY) as TRecurringJobKey[]).map((key) => [
      key,
      {
        handler: RECURRING_JOB_HANDLERS_BY_KEY[key],
        job: recurringJobs[key],
        schedule: RECURRING_JOB_SCHEDULES_BY_KEY[key],
      },
    ])
  ) as Record<TRecurringJobKey, RecurringJobRegistration>;

export const RECURRING_JOB_REGISTRATIONS: readonly RecurringJobRegistration[] = Object.values(
  RECURRING_JOB_REGISTRATIONS_BY_KEY
);

/** Handler overrides for every job whose real implementation lives in this app. */
export const getJobHandlerOverrides = (): JobHandlerOverrides => ({
  [ONE_SHOT_JOB_NAMES.responsePipeline]:
    toJobHandlerOverride<TResponsePipelineJobData>(processResponsePipelineJob),
  [ONE_SHOT_JOB_NAMES.webhookDelivery]:
    toJobHandlerOverride<TWebhookDeliveryJobData>(processWebhookDeliveryJob),
  [ONE_SHOT_JOB_NAMES.workflowRun]: toJobHandlerOverride<TWorkflowRunJobData>(processWorkflowRunJob),
  ...Object.fromEntries(
    RECURRING_JOB_REGISTRATIONS.map((registration) => [
      registration.job.name,
      toJobHandlerOverride(registration.handler),
    ])
  ),
});
