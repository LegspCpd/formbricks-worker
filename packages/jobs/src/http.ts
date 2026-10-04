/* v8 ignore start */
/**
 * The Cloudflare-Queues-over-HTTP surface of `@formbricks/jobs`.
 *
 * This exists for a deployment whose web tier is **not** a Worker — Vercel, in this repo's case — but
 * whose background jobs still run on the Cloudflare jobs Worker (`cloudflare/jobs-worker.ts`). The
 * jobs Worker consumes the `formbricks-jobs` queue and dispatches through the same handler registry
 * as the self-hosted BullMQ worker; all this surface has to do is *enqueue* onto that same queue.
 *
 * A Worker would do that through its `JOBS_QUEUE` binding, which a Node/serverless process does not
 * have. Cloudflare exposes the identical operation over HTTP — `POST
 * /accounts/{account_id}/queues/{queue_id}/messages` — so this module injects an HTTP-backed
 * `CloudflareQueueBinding` and then re-exports the Cloudflare surface unchanged. Every producer in
 * `cf-producer.ts` (`getBackgroundJobProducer`, `enqueueWorkflowRunJob`, …) therefore works here with
 * no second implementation: the only difference is the transport underneath `send`.
 *
 * Import it for its side effect (it wires the binding at module load) and use it in place of
 * `@formbricks/jobs` — see the `FORMBRICKS_JOBS_ENGINE=http` alias in `next.config.mjs`.
 */
import { type CloudflareQueueBinding, setCloudflareQueueBinding } from "./cf-producer";

export * from "./cf";

interface HttpQueueConfig {
  accountId: string;
  apiToken: string;
  queueId: string;
}

const readHttpQueueConfig = (): HttpQueueConfig | null => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_QUEUES_API_TOKEN;
  const queueId = process.env.CLOUDFLARE_JOBS_QUEUE_ID;

  if (!accountId || !apiToken || !queueId) {
    return null;
  }

  return { accountId, apiToken, queueId };
};

/**
 * Publishes one message through Cloudflare's HTTP push API. The body shape matches what the queue
 * consumer reads (`cf-consumer.ts`'s `parseEnvelope`): `{ data, jobId, jobName }`. Config is resolved
 * per call rather than at module load so a missing variable surfaces as a failed enqueue with a clear
 * message instead of a crash while the serverless bundle is being evaluated.
 */
const httpQueueBinding: CloudflareQueueBinding = {
  send: async (body) => {
    const config = readHttpQueueConfig();

    if (!config) {
      throw new Error(
        "Cloudflare Queues HTTP producer is not configured: set CLOUDFLARE_ACCOUNT_ID, " +
          "CLOUDFLARE_QUEUES_API_TOKEN and CLOUDFLARE_JOBS_QUEUE_ID"
      );
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/queues/${config.queueId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      }
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Cloudflare Queues publish failed (${response.status} ${response.statusText}): ${detail.slice(0, 500)}`
      );
    }
  },
};

setCloudflareQueueBinding(httpQueueBinding);
/* v8 ignore stop */
