/* v8 ignore start */
// Owned by this package rather than re-exported from BullMQ: BullMQ detects the sentinel by name
// (`err.name === "UnrecoverableError"`) as well as by `instanceof`, so handlers can throw it even on
// runtimes that never load BullMQ (see `errors.ts`). The Cloudflare surface (`@formbricks/jobs/cf`)
// exports the same class, so a message consumer and a handler agree on the sentinel.
export { UnrecoverableError, isUnrecoverableError } from "./errors";
export type {
  BackgroundJobProducer,
  EnqueuedJob,
  JobHandlerOverrides,
  JobExecutionContext,
  JobHandler,
} from "./contracts";
export {
  ONE_SHOT_JOB_NAMES,
  enqueueResponsePipelineJob,
  enqueueTestLogJob,
  enqueueWebhookDeliveryJob,
  enqueueWorkflowRunJob,
  getBackgroundJobProducer,
  recurringJobs,
  scheduleTestLogJobAt,
  upsertRecurringTestLogJobSchedule,
} from "./queue";
export { processResponsePipelineJob } from "./processors/response-pipeline";
export { processTestLogJob } from "./processors/test-log";
export { processWebhookDeliveryJob } from "./processors/webhook-delivery";
export { processWorkflowRunJob } from "./processors/workflow-run";
export { startJobsRuntime } from "./runtime";
export type { JobsQueueHandle, RecurringJobHandle } from "./queue";
export type { TRecurringJobKey } from "./recurring";
export type { JobsRuntimeHandle, JobsRuntimeOptions } from "./runtime";
export type { TRecurringBackgroundJobSchedule } from "./schedules";
export {
  ZGlobalScopeJobData,
  ZResponsePipelineEvent,
  ZResponsePipelineJobData,
  ZSurveyArchivePurgeJobData,
  ZSurveySchedulingJobData,
  ZTestLogJobData,
  ZUsageTelemetryJobData,
  ZWebhookDeliveryJobData,
  ZWorkflowRunJobData,
  ZWorkflowsUsageSnapshotJobData,
  ZWorkflowRunReconcileJobData,
} from "./types";
export type {
  TGlobalScopeJobData,
  TResponsePipelineEvent,
  TResponsePipelineJobData,
  TSurveyArchivePurgeJobData,
  TSurveySchedulingJobData,
  TTestLogJobData,
  TUsageTelemetryJobData,
  TWebhookDeliveryJobData,
  TWorkflowsUsageSnapshotJobData,
  TWorkflowRunJobData,
  TWorkflowRunReconcileJobData,
} from "./types";
export type { BackgroundJobLike } from "./contracts";
// Cloudflare Queues producer surface, also exported from the BullMQ entry so shared modules (e.g. the
// runtime binding glue) can import it from one specifier. It carries no BullMQ dependency, so pulling
// it in here adds nothing to the BullMQ graph; under the Workers build this whole entry is aliased to
// `@formbricks/jobs/cf` anyway (see `FORMBRICKS_JOBS_ENGINE` in next.config.mjs).
export {
  createCloudflareJobProducer,
  getCloudflareQueueBinding,
  newCloudflareJobId,
  sendToCloudflareQueue,
  setCloudflareQueueBinding,
} from "./cf-producer";
export type { CloudflareQueueBinding } from "./cf-producer";
export { consumeQueueBatch } from "./cf-consumer";
export type { CloudflareQueueBatch, CloudflareQueueMessage } from "./cf-consumer";
/* v8 ignore stop */
