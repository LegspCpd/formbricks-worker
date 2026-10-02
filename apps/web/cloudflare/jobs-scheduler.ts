import { DurableObject } from "cloudflare:workers";
import { newCloudflareJobId, sendToCloudflareQueue, setCloudflareQueueBinding } from "@formbricks/jobs";
import { logger } from "@formbricks/logger";
import { type WorkerEnv, applyWorkerEnv } from "./worker-env";

/**
 * The recurring-job scheduler for the Cloudflare engine.
 *
 * Cron Triggers can not be used: an account on the Workers Free plan may hold five in total
 * (`code: 10072`) and this account's are spoken for, so declaring any cron is rejected at deploy time.
 * Durable Object alarms have no such budget, and the documentation recommends this exact shape for
 * recurring work — a single alarm that processes what is due and reschedules itself.
 *
 * One alarm covers every job: the next run time of each is kept in storage, the alarm is set to the
 * earliest of them, and each alarm run advances only the jobs that came due. The schedules themselves
 * come from `lib/jobs/cf-schedules.ts`, which derives them from the same declarations the BullMQ path
 * registers — this class owns no cadence of its own.
 *
 * The alarm does not run the jobs. It enqueues each due job onto `JOBS_QUEUE`, so the work happens in
 * the queue consumer: that keeps this object to a storage read, a few sends and an alarm write, and it
 * means the job-handler graph is never part of its wake-up cost. It also means the retry and
 * dead-letter semantics for a recurring run are the queue's, which is what the one-shot jobs get too.
 *
 * Everything the app's graph would drag in is imported *inside* the handlers, never at module scope —
 * see `worker-env.ts` for why that is load-bearing rather than stylistic.
 */

const STORAGE_KEY = "run-times";

type RunTimes = Record<string, number>;

const isRunTimes = (value: unknown): value is RunTimes => typeof value === "object" && value !== null;

export class JobsScheduler extends DurableObject {
  /**
   * Seeds any job that has no run time yet and makes sure an alarm is set. Idempotent, so the Worker
   * entry can call it from every handler: it is what starts the schedule after a deploy and what
   * restarts it if the alarm is ever lost — the documentation notes that an `alarm()` which keeps
   * failing is retried only six times, after which the schedule stays stopped until the next
   * `setAlarm`.
   */
  async ensure(): Promise<void> {
    const env = this.env as WorkerEnv;
    applyWorkerEnv(env);

    const { CLOUDFLARE_SCHEDULED_JOBS, initialRunAt } = await import("@/lib/jobs/cf-schedules");

    const now = Date.now();
    const runTimes = await this.readRunTimes();
    const scheduledNames = new Set(CLOUDFLARE_SCHEDULED_JOBS.map((job) => job.jobName));
    let changed = false;

    for (const job of CLOUDFLARE_SCHEDULED_JOBS) {
      if (runTimes[job.jobName] === undefined) {
        runTimes[job.jobName] = initialRunAt(job.schedule, now);
        changed = true;
      }
    }

    // A job that no longer exists must not keep an alarm alive for itself.
    for (const jobName of Object.keys(runTimes)) {
      if (!scheduledNames.has(jobName)) {
        delete runTimes[jobName];
        changed = true;
      }
    }

    if (changed) {
      await this.ctx.storage.put(STORAGE_KEY, runTimes);
    }

    await this.armAlarm(runTimes);
  }

  async alarm(): Promise<void> {
    const env = this.env as WorkerEnv;
    applyWorkerEnv(env);

    const { CLOUDFLARE_SCHEDULED_JOBS, initialRunAt, nextRunAtAfter } =
      await import("@/lib/jobs/cf-schedules");

    const now = Date.now();
    const runTimes = await this.readRunTimes();

    setCloudflareQueueBinding(env.JOBS_QUEUE as Parameters<typeof setCloudflareQueueBinding>[0]);

    for (const job of CLOUDFLARE_SCHEDULED_JOBS) {
      const dueAt = runTimes[job.jobName] ?? initialRunAt(job.schedule, now);

      if (dueAt > now) {
        runTimes[job.jobName] = dueAt;
        continue;
      }

      try {
        await sendToCloudflareQueue(job.jobName, job.data, newCloudflareJobId(job.jobName));
      } catch (error) {
        // Swallowed on purpose. The docs are explicit that an `alarm()` which throws is retried six times
        // and then never again, so a queue hiccup must not be allowed to end the schedule; the job is
        // rescheduled below and the next run retries the sweep, which is idempotent by design.
        logger.error({ err: error, jobName: job.jobName }, "Could not enqueue a scheduled job");
      }

      // Advanced from `dueAt`, not from `now`: measuring from now would let a run that fired late shift
      // every following run, so a schedule would drift further behind on every hiccup.
      runTimes[job.jobName] = nextRunAtAfter(job.schedule, dueAt, now);
    }

    await this.ctx.storage.put(STORAGE_KEY, runTimes);
    await this.armAlarm(runTimes);
  }

  private async readRunTimes(): Promise<RunTimes> {
    const stored = await this.ctx.storage.get(STORAGE_KEY);

    return isRunTimes(stored) ? stored : {};
  }

  /**
   * Points the single alarm at the earliest pending run. Called on every path — including after a job
   * failed to enqueue — because an alarm that is not re-set is a schedule that silently stops.
   */
  private async armAlarm(runTimes: RunTimes): Promise<void> {
    const pending = Object.values(runTimes);

    if (pending.length === 0) {
      logger.warn("No scheduled jobs to arm an alarm for; `ensure()` re-seeds them");
      return;
    }

    await this.ctx.storage.setAlarm(Math.min(...pending));
  }
}
