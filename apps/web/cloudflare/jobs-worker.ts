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
    await ensureSchedule(env);

    return new Response("Formbricks jobs worker", { status: 200 });
  },

  async queue(batch: CloudflareQueueBatch, env: WorkerEnv): Promise<void> {
    applyWorkerEnv(env);
    // Before dispatching, so a schedule that stopped for any reason restarts with the first job that
    // flows through — which is also how the schedule comes back after the alarm budget is exhausted.
    await ensureSchedule(env);

    const { handleCloudflareQueueBatch } = await import("@/lib/jobs/cf");
    await handleCloudflareQueueBatch(batch, env as CloudflareJobsEnv);
  },
};

export default jobsWorker;
