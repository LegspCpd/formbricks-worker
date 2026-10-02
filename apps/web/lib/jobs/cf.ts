import "server-only";
import {
  type CloudflareQueueBatch,
  type CloudflareQueueBinding,
  consumeQueueBatch,
  setCloudflareQueueBinding,
} from "@formbricks/jobs";
import { getJobHandlerOverrides } from "@/lib/jobs/recurring-registrations";

/**
 * The runtime `env` a Cloudflare Queues consumer receives. Only the binding this module wires is
 * typed; the rest of the Worker `env` is validated elsewhere.
 */
export interface CloudflareJobsEnv {
  JOBS_QUEUE?: CloudflareQueueBinding;
}

/**
 * Hands the Worker's `JOBS_QUEUE` producer binding to `@formbricks/jobs`. Idempotent and cheap, so it
 * is safe to call on every invocation: a `queue()` consumer does not run inside a Next.js request, so
 * `getCloudflareContext()` is not available there and the binding has to come from the Worker `env`
 * the handler is called with.
 */
export const configureCloudflareJobs = (env: CloudflareJobsEnv | undefined): void => {
  if (env?.JOBS_QUEUE) {
    setCloudflareQueueBinding(env.JOBS_QUEUE);
  }
};

/**
 * The Worker's `queue()` handler body. Dispatches every message in the batch through the same handler
 * overrides the self-hosted BullMQ worker registers (`getJobHandlerOverrides`), so the two engines run
 * identical handler code — only the transport differs.
 */
export const handleCloudflareQueueBatch = async (
  batch: CloudflareQueueBatch,
  env: CloudflareJobsEnv | undefined
): Promise<void> => {
  configureCloudflareJobs(env);
  await consumeQueueBatch(batch, getJobHandlerOverrides());
};
