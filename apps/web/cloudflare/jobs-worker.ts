/**
 * The dedicated Jobs Worker.
 *
 * The background-job handler graph (authzed, stripe, slack, the workflow runner, the response
 * pipeline) is larger than the Next.js server bundle can afford inside the 64 MiB Worker limit, so it
 * lives in its own Worker, deployed from this entry, while the request-serving shards carry only the
 * Next app.
 *
 * `fetch` is a stub, not the app: Cloudflare requires `fetch` to be present, and this Worker is never
 * routed user traffic. It does double as the way to start (or restart) the schedule by hand, which is
 * why it returns the scheduler's state rather than an empty 200.
 *
 * Nothing that reaches the job handlers is imported at the top of this file. Cloudflare evaluates a
 * Worker's module graph while *validating* an upload, and secrets are not part of that validation
 * environment, so the graph's top-level `new PrismaClient(…)` (`packages/database/src/client.ts`) reads
 * an empty `DATABASE_URL` and rejects every deploy with `code: 10021` before the Worker is ever
 * invoked. Importing on first use defers that evaluation into a handler, where the Worker's `env` is
 * available; see `worker-env.ts`.
 *
 * There are no Cron Triggers here, deliberately: see `jobs-scheduler.ts`.
 */
import { logger } from "@formbricks/logger";
import { type CloudflareJobsEnv, type CloudflareQueueBatch } from "@/lib/jobs/cf";
import { type WorkerEnv, applyWorkerEnv } from "./worker-env";

export { JobsScheduler } from "./jobs-scheduler";

type SchedulerBinding = { getByName: (name: string) => { ensure: () => Promise<void> } };

const SCHEDULER_NAME = "recurring";

/**
 * Starts the recurring schedule if it is not already running. Safe to call from anywhere and on every
 * invocation — the Durable Object seeds only what is missing and re-arms the alarm every time, so this
 * is both the bootstrap after a deploy and the repair path if an alarm is ever lost.
 */
const ensureSchedule = async (env: WorkerEnv | undefined): Promise<void> => {
  const scheduler = env?.JOBS_SCHEDULER as SchedulerBinding | undefined;

  if (!scheduler) {
    return;
  }

  await scheduler.getByName(SCHEDULER_NAME).ensure();
};

const jobsWorker = {
  async fetch(_request: Request, env: WorkerEnv): Promise<Response> {
    applyWorkerEnv(env);

    try {
      await ensureSchedule(env);
    } catch (error) {
      // The message goes in the body rather than only to the logs: this Worker serves no user traffic and
      // is never routed, so the body is read by whoever (or whatever) is starting the schedule — the
      // deploy workflow pokes this endpoint and prints this response when the schedule does not start.
      logger.error({ err: error }, "Could not start the recurring schedule");

      const message = error instanceof Error ? error.message : String(error);

      return new Response(`Could not start the recurring schedule: ${message}`, { status: 500 });
    }

    return new Response("Formbricks jobs worker", { status: 200 });
  },

  async queue(batch: CloudflareQueueBatch, env: WorkerEnv): Promise<void> {
    applyWorkerEnv(env);
    // Before dispatching, so a schedule that stopped for any reason restarts with the first job that
    // flows through — which is also how the schedule comes back after the alarm budget is exhausted.
    //
    // Guarded on purpose: starting the schedule is best-effort and self-heals on the next invocation,
    // but a throw here happens *before* any message is dispatched, so Cloudflare redelivers the whole
    // batch unprocessed. A transient Durable Object hiccup — routine for a moment right after a deploy
    // — would then fail every batch until each job exhausts its retries and lands in the dead-letter
    // queue, which is exactly how unrelated jobs stop being delivered. The `fetch` handler already
    // treats this call as non-fatal for the same reason; the consumer must too.
    try {
      await ensureSchedule(env);
    } catch (error) {
      logger.error({ err: error }, "Could not start the recurring schedule before consuming the batch");
    }

    const { handleCloudflareQueueBatch } = await import("@/lib/jobs/cf");
    await handleCloudflareQueueBatch(batch, env as CloudflareJobsEnv);
  },
};

export default jobsWorker;
