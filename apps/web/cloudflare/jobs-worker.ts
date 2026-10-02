import { type CloudflareJobsEnv, type CloudflareQueueBatch, handleCloudflareQueueBatch } from "@/lib/jobs/cf";
import { handleCloudflareScheduled } from "@/lib/jobs/cf-schedules";

/**
 * The dedicated Jobs Worker.
 *
 * The background-job handler graph (authzed, stripe, slack, the workflow runner, the response
 * pipeline) is ~60 MiB — too large to coexist with the Next.js server bundle inside the 64 MiB Worker
 * limit. So it lives in its own Worker, deployed from this entry, while the request-serving shards
 * carry only the Next app.
 *
 * `fetch` is a stub, not the app: Cloudflare requires `fetch` to be present, and this Worker is never
 * routed user traffic — it only consumes the `JOBS_QUEUE` and runs the cron triggers declared in
 * `wrangler.jobs.jsonc`.
 */

const jobsWorker = {
  async fetch(): Promise<Response> {
    return new Response("Formbricks jobs worker", { status: 200 });
  },

  async queue(batch: CloudflareQueueBatch, env: CloudflareJobsEnv): Promise<void> {
    await handleCloudflareQueueBatch(batch, env);
  },

  async scheduled(controller: { cron: string }): Promise<void> {
    await handleCloudflareScheduled(controller.cron);
  },
};

export default jobsWorker;
