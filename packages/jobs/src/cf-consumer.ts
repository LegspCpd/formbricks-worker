import { logger } from "@formbricks/logger";
import type { BackgroundJobLike, JobHandlerOverrides } from "@/src/contracts";
import { isUnrecoverableError } from "@/src/errors";
import { processJob } from "@/src/processors/registry";

/**
 * The subset of a Cloudflare Queues message this consumer touches. Cloudflare delivers messages in
 * batches, each with a delivery attempt count and explicit `ack()`/`retry()` controls — the analogue
 * of BullMQ's job lifecycle, which `processJob` is already written against via `BackgroundJobLike`.
 */
export interface CloudflareQueueMessage {
  ack: () => void;
  attempts?: number;
  body: unknown;
  id?: string;
  retry: (options?: { delaySeconds?: number }) => void;
}

export interface CloudflareQueueBatch {
  messages: CloudflareQueueMessage[];
  queue: string;
}

interface CfJobEnvelope {
  data: unknown;
  jobId?: string;
  jobName: string;
}

const isJobEnvelope = (body: unknown): body is CfJobEnvelope =>
  typeof body === "object" &&
  body !== null &&
  typeof (body as { jobName?: unknown }).jobName === "string" &&
  "data" in body;

const parseEnvelope = (body: unknown): CfJobEnvelope | null => {
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      return isJobEnvelope(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return isJobEnvelope(body) ? body : null;
};

/**
 * The default retry budget for one Cloudflare-delivered message. Cloudflare Queues' own consumer
 * `max_retries` is the outer bound; this mirrors the BullMQ per-job `attempts` semantics so
 * `processJob`'s `attempt`/`maxAttempts` context reads the same on both engines.
 */
const DEFAULT_MAX_ATTEMPTS = 3;

const toBackgroundJobLike = (
  envelope: CfJobEnvelope,
  message: CloudflareQueueMessage
): BackgroundJobLike => ({
  attemptsMade: Math.max((message.attempts ?? 1) - 1, 0),
  data: envelope.data,
  id: envelope.jobId ?? message.id ?? null,
  name: envelope.jobName,
  opts: { attempts: DEFAULT_MAX_ATTEMPTS },
  queueName: message.id,
});

/**
 * Consumes a batch of Cloudflare Queues messages and dispatches each through the shared job registry.
 *
 * One message failing must not fail its batch-mates: Cloudflare re-delivers the whole batch on a throw,
 * so an unhandled rejection would replay every message in it. Each message is therefore acked on
 * success and retried individually. An explicit `UnrecoverableError` (still detected by name) is
 * acked — retrying a permanent failure only burns the consumer's retry budget.
 *
 * Unknown job names are dropped by `processJob` itself (ENG-2235) — a schedule that outlived its code
 * is an operational fact, and a Cloudflare queue with no per-name DDL has no "failed set" to grow.
 */
export const consumeQueueBatch = async (
  batch: CloudflareQueueBatch,
  handlerOverrides?: JobHandlerOverrides
): Promise<void> => {
  for (const message of batch.messages) {
    const envelope = parseEnvelope(message.body);

    if (!envelope) {
      // An unparseable body is not retriable: retrying would replay a payload this build cannot read.
      logger.error({ messageId: message.id, queueName: batch.queue }, "Dropping unparseable job message");
      message.ack();
      continue;
    }

    const job = toBackgroundJobLike(envelope, message);

    try {
      await processJob(job, handlerOverrides);
      message.ack();
    } catch (error) {
      if (isUnrecoverableError(error)) {
        logger.error(
          { err: error, jobId: job.id, jobName: job.name, queueName: batch.queue },
          "Permanent job failure; acknowledging without retry"
        );
        message.ack();
        continue;
      }

      logger.error(
        { err: error, jobId: job.id, jobName: job.name, queueName: batch.queue, attempts: message.attempts },
        "Job failed; scheduling retry"
      );
      message.retry();
    }
  }
};
