import { JOB_NAMES } from "@/src/constants";
import type { BackgroundJobProducer, EnqueuedJob } from "@/src/contracts";
import {
  type TResponsePipelineJobData,
  type TWebhookDeliveryJobData,
  type TWorkflowRunJobData,
  ZResponsePipelineJobData,
  ZWebhookDeliveryJobData,
  ZWorkflowRunJobData,
} from "@/src/types";

/**
 * The subset of Cloudflare's `Queue` binding this producer uses. Declared structurally (rather than
 * importing `@cloudflare/workers-types`) so this package keeps zero runtime dependencies and can be
 * bundled for a Worker without pulling the Cloudflare type packages into the build graph.
 */
export interface CloudflareQueueBinding {
  send: (body: unknown, options?: { delaySeconds?: number }) => Promise<void>;
  sendBatch?: (messages: { body: unknown }[]) => Promise<void>;
}

let queueBinding: CloudflareQueueBinding | undefined;

/**
 * Injects the `JOBS_QUEUE` producer binding. Called once per Worker isolate from the runtime glue
 * (`apps/web/lib/cloudflare-bindings.ts` and the Worker `queue()` handler) — this package has no
 * `getCloudflareContext()` of its own, because it must stay free of the OpenNext adapter.
 */
export const setCloudflareQueueBinding = (binding: CloudflareQueueBinding | undefined): void => {
  queueBinding = binding;
};

/**
 * The injected binding, or `undefined` when this process is not a Cloudflare Worker (self-hosted,
 * tests). Exported so callers can tell the two engines apart without importing the BullMQ graph.
 */
export const getCloudflareQueueBinding = (): CloudflareQueueBinding | undefined => queueBinding;

const requireQueueBinding = (): CloudflareQueueBinding => {
  if (!queueBinding) {
    throw new Error("Cloudflare JOBS_QUEUE binding is not configured");
  }

  return queueBinding;
};

/** A collision-resistant id for a one-shot job with no natural deterministic key. */
export const newCloudflareJobId = (jobName: string): string =>
  `cf-${jobName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Pushes one message onto the bound queue. Cloudflare Queues has no server-side dedupe, so
 * idempotency has to travel in the body: the deterministic `jobId` is what the consumer and any
 * replay key off.
 */
export const sendToCloudflareQueue = async (
  jobName: string,
  data: unknown,
  jobId: string
): Promise<EnqueuedJob> => {
  await requireQueueBinding().send({ data, jobId, jobName });

  return { jobId, jobName, queueName: jobName };
};

/** `response-pipeline.process` on Cloudflare Queues. Validates the payload before it leaves the isolate. */
export const enqueueResponsePipelineJob = async (data: TResponsePipelineJobData): Promise<EnqueuedJob> =>
  sendToCloudflareQueue(
    JOB_NAMES.responsePipeline,
    ZResponsePipelineJobData.parse(data),
    newCloudflareJobId(JOB_NAMES.responsePipeline)
  );

/**
 * `webhook-delivery.process` on Cloudflare Queues. `jobId` is required and deterministic (derived by
 * the pipeline job from its own id + the webhookId) so a pipeline retry after a partial fan-out
 * re-enqueues only the children that never made it — the same contract as the BullMQ producer, minus
 * BullMQ's server-side jobId dedupe (the handler is idempotent per delivery regardless).
 */
export const enqueueWebhookDeliveryJob = async (
  data: TWebhookDeliveryJobData,
  options: { jobId: string }
): Promise<EnqueuedJob> =>
  sendToCloudflareQueue(JOB_NAMES.webhookDelivery, ZWebhookDeliveryJobData.parse(data), options.jobId);

/**
 * `workflow-run.process` on Cloudflare Queues. The deterministic `jobId` (the run id) mirrors the
 * BullMQ producer; the WorkflowRun row stays the durable, backend-neutral source of truth.
 */
export const enqueueWorkflowRunJob = async (
  data: TWorkflowRunJobData,
  options?: { jobId: string }
): Promise<EnqueuedJob> =>
  sendToCloudflareQueue(
    JOB_NAMES.workflowRun,
    ZWorkflowRunJobData.parse(data),
    options?.jobId ?? newCloudflareJobId(JOB_NAMES.workflowRun)
  );

/**
 * Request-scope producer seam, Cloudflare-backed. Where the BullMQ producer talks to Redis over TCP,
 * this pushes onto the Worker's own `JOBS_QUEUE` binding; the `queue()` consumer wraps the Worker
 * (`consumeQueueBatch`) and dispatches through the same handler registry. `createCloudflareJobProducer`
 * is the same factory under its original name — both are exported so the aliased `@formbricks/jobs/cf`
 * surface can offer either spelling to an import site.
 */
export const getBackgroundJobProducer = (): BackgroundJobProducer => ({
  enqueueResponsePipeline: enqueueResponsePipelineJob,
});

export const createCloudflareJobProducer = getBackgroundJobProducer;
