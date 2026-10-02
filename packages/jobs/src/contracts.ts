import type { ZodType } from "zod";
import type { TResponsePipelineJobData } from "@/src/types";

export interface JobExecutionContext {
  attempt: number;
  jobId: string;
  jobName: string;
  maxAttempts: number;
  queueName: string;
}

export interface EnqueuedJob {
  jobId: string;
  jobName: string;
  queueName: string;
}

/**
 * The engine-neutral subset of a queued message the dispatch path reads. BullMQ's `Job` satisfies it
 * structurally (`id`, `name`, `data`, `queueName`, `opts.attempts`, `attemptsMade`), and so does the
 * Cloudflare Queues adapter in `cf-consumer.ts` — which is what keeps `processors/registry.ts` free of
 * the `bullmq` dependency while still serving both runtimes from one dispatch implementation.
 */
export interface BackgroundJobLike {
  attemptsMade?: number;
  data: unknown;
  id?: number | string | null;
  name: string;
  opts?: { attempts?: number } | null;
  queueName?: string;
}

export type JobHandler<TData> = (data: TData, context: JobExecutionContext) => Promise<void>;

export type JobHandlerOverrides = Partial<Record<string, JobHandler<unknown>>>;

export interface BackgroundJobDefinition<TData> {
  handle: JobHandler<TData>;
  name: string;
  schema: ZodType<TData>;
}

export interface AnyBackgroundJobDefinition {
  handle: JobHandler<unknown>;
  name: string;
  schema: ZodType;
}

export const toAnyBackgroundJobDefinition = <TData>(
  definition: BackgroundJobDefinition<TData>
): AnyBackgroundJobDefinition => ({
  handle: async (data, context) => {
    await definition.handle(data as TData, context);
  },
  name: definition.name,
  schema: definition.schema,
});

/**
 * Engine-neutral seam for enqueueing from request scope. Only the paths the app actually calls live
 * here: recurring schedules are registered at boot through the `recurringJobs` handles, and the
 * remaining one-shot enqueues use the exported `enqueue*Job` functions directly.
 */
export interface BackgroundJobProducer {
  enqueueResponsePipeline: (data: TResponsePipelineJobData) => Promise<EnqueuedJob>;
}
