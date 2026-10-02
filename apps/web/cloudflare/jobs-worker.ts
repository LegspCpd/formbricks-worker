/**
 * The dedicated Jobs Worker.
 *
 * The background-job handler graph (authzed, stripe, slack, the workflow runner, the response
 * pipeline) is larger than the Next.js server bundle can afford inside the 64 MiB Worker limit, so it
 * lives in its own Worker, deployed from this entry, while the request-serving shards carry only the
 * Next app.
 *
 * `fetch` is a stub, not the app: Cloudflare requires `fetch` to be present, and this Worker is never
 * routed user traffic — it only consumes the `JOBS_QUEUE` and runs the cron triggers declared in
 * `wrangler.jobs.jsonc`.
 *
 * Nothing that reaches the job handlers is imported at the top of this file. Cloudflare evaluates a
 * Worker's module graph while *validating* an upload, and secrets are not part of that validation
 * environment, so the graph's top-level `new PrismaClient(…)` (`packages/database/src/client.ts`) reads
 * an empty `DATABASE_URL` and rejects every deploy with `code: 10021` before the Worker is ever
 * invoked. Importing on first use defers that evaluation into a handler, where the Worker's `env` is
 * available.
 */
import { type CloudflareJobsEnv, type CloudflareQueueBatch } from "@/lib/jobs/cf";

type WorkerEnv = Record<string, unknown>;

type QueueController = {
  cron: string;
};

/**
 * Copies this Worker's string bindings onto `process.env` — the pattern the Workers documentation
 * gives for code that reads its configuration through `process.env`, which is all of the app's
 * (`lib/env.ts`).
 *
 * `??=` rather than plain assignment: compatibility dates on or after 2025-04-01 already populate
 * `process.env` (see `nodejs_compat_populate_process_env`), and the runtime's value must win. Only
 * strings are copied, so object bindings such as `JOBS_QUEUE` are left out of the environment.
 */
const applyWorkerEnv = (env: WorkerEnv | undefined): void => {
  if (!env) {
    return;
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      process.env[key] ??= value;
    }
  }
};

const jobsWorker = {
  async fetch(): Promise<Response> {
    return new Response("Formbricks jobs worker", { status: 200 });
  },

  async queue(batch: CloudflareQueueBatch, env: WorkerEnv): Promise<void> {
    applyWorkerEnv(env);

    const { handleCloudflareQueueBatch } = await import("@/lib/jobs/cf");
    await handleCloudflareQueueBatch(batch, env as CloudflareJobsEnv);
  },

  async scheduled(controller: QueueController, env: WorkerEnv): Promise<void> {
    applyWorkerEnv(env);

    const { handleCloudflareScheduled } = await import("@/lib/jobs/cf-schedules");
    await handleCloudflareScheduled(controller.cron);
  },
};

export default jobsWorker;
