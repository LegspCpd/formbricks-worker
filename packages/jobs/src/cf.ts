/* v8 ignore start */
/**
 * The BullMQ-free surface of `@formbricks/jobs` for Cloudflare Workers.
 *
 * Every export here is reachable without importing `bullmq` or `ioredis`, so a Worker bundle that
 * resolves `@formbricks/jobs` to this subpath (see the `FORMBRICKS_JOBS_ENGINE` alias in
 * `next.config.mjs`) keeps the job *handlers*, the dispatch registry and the payload schemas — but not
 * the Redis client graph that cannot run on workerd. The BullMQ-backed entry (`@formbricks/jobs`)
 * stays the self-hosted default; the two share one dispatch implementation (`processJob`).
 */
export { UnrecoverableError, isUnrecoverableError } from "./errors";
export type {
  BackgroundJobLike,
  BackgroundJobProducer,
  EnqueuedJob,
  JobExecutionContext,
  JobHandler,
  JobHandlerOverrides,
} from "./contracts";
export { consumeQueueBatch } from "./cf-consumer";
export type { CloudflareQueueBatch, CloudflareQueueMessage } from "./cf-consumer";
export {
  enqueueResponsePipelineJob,
  enqueueWebhookDeliveryJob,
  enqueueWorkflowRunJob,
  getBackgroundJobProducer,
  getCloudflareQueueBinding,
  newCloudflareJobId,
  sendToCloudflareQueue,
  setCloudflareQueueBinding,
} from "./cf-producer";
export type { CloudflareQueueBinding } from "./cf-producer";
export { JOB_NAMES, ONE_SHOT_JOB_NAMES } from "./constants";
export { processJob } from "./processors/registry";
export {
  type JobsRuntimeHandle,
  type JobsRuntimeOptions,
  type RecurringJobHandle,
  recurringJobs,
  startJobsRuntime,
} from "./cf-runtime";
export { recurringJobDefinitions, recurringJobDescriptors } from "./recurring";
export type { RecurringJobDescriptor, TRecurringJobKey } from "./recurring";
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
/* v8 ignore stop */
