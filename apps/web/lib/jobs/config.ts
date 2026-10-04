import "server-only";
import type { JobsRuntimeOptions } from "@formbricks/jobs";
import { env } from "@/lib/env";

const DEFAULT_BULLMQ_WORKER_CONCURRENCY = 1;
const DEFAULT_BULLMQ_WORKER_COUNT = 1;

export interface JobsWorkerBootstrapConfig {
  enabled: boolean;
  runtimeOptions: JobsRuntimeOptions | null;
}

export interface JobsQueueingConfig {
  enabled: boolean;
  redisUrl: string | null;
}

export const BULLMQ_WORKER_CONCURRENCY = env.BULLMQ_WORKER_CONCURRENCY ?? DEFAULT_BULLMQ_WORKER_CONCURRENCY;
export const BULLMQ_WORKER_COUNT = env.BULLMQ_WORKER_COUNT ?? DEFAULT_BULLMQ_WORKER_COUNT;

/**
 * The background-jobs transport, selected at build time by `FORMBRICKS_JOBS_ENGINE` (see the alias in
 * next.config.mjs). Two values mean the jobs travel through Cloudflare Queues rather than BullMQ/Redis:
 *
 * - `cloudflare`: the app itself runs on a Worker and enqueues through its `JOBS_QUEUE` binding.
 * - `http`: the app runs somewhere else (Vercel here) and enqueues onto the same queue over Cloudflare's
 *   HTTP push API — see `@formbricks/jobs/http`.
 *
 * Neither has a Redis to gate queueing on and neither runs an in-process worker, so both are handled
 * identically here: enqueueing stays enabled, and the BullMQ worker bootstrap stays off.
 */
const JOBS_ENGINE = env.FORMBRICKS_JOBS_ENGINE;
const isCloudflareQueueEngine = (): boolean => JOBS_ENGINE === "cloudflare" || JOBS_ENGINE === "http";

const getBullMqWorkerEnabled = (): boolean => {
  if (isCloudflareQueueEngine()) {
    return false;
  }

  if (env.BULLMQ_WORKER_ENABLED !== undefined) {
    return env.BULLMQ_WORKER_ENABLED === "1";
  }

  return env.NODE_ENV !== "test";
};

export const BULLMQ_WORKER_ENABLED = getBullMqWorkerEnabled();
export const BULLMQ_EXTERNAL_WORKER_ENABLED = env.BULLMQ_EXTERNAL_WORKER_ENABLED === "1";

const hasBullMqConsumer = (): boolean => BULLMQ_WORKER_ENABLED || BULLMQ_EXTERNAL_WORKER_ENABLED;

export const getJobsQueueingConfig = (): JobsQueueingConfig => {
  // A Cloudflare Queues engine has no Redis: the transport is the Worker binding or the HTTP push API,
  // and the consumer is the jobs Worker. Queueing is therefore enabled unconditionally — the enqueue
  // path does not consult `redisUrl` on those engines.
  if (isCloudflareQueueEngine()) {
    return {
      enabled: true,
      redisUrl: null,
    };
  }

  if (!env.REDIS_URL || !hasBullMqConsumer()) {
    return {
      enabled: false,
      redisUrl: null,
    };
  }

  return {
    enabled: true,
    redisUrl: env.REDIS_URL,
  };
};

export const getJobsWorkerBootstrapConfig = (): JobsWorkerBootstrapConfig => {
  if (!BULLMQ_WORKER_ENABLED) {
    return {
      enabled: false,
      runtimeOptions: null,
    };
  }

  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL is required to start the BullMQ worker");
  }

  return {
    enabled: true,
    runtimeOptions: {
      concurrency: BULLMQ_WORKER_CONCURRENCY,
      redisUrl: env.REDIS_URL,
      workerCount: BULLMQ_WORKER_COUNT,
    },
  };
};
