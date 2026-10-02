import "server-only";
import { logger } from "@formbricks/logger";
import {
  RECURRING_JOB_REGISTRATIONS,
  RECURRING_JOB_REGISTRATIONS_BY_KEY,
} from "@/lib/jobs/recurring-registrations";

/**
 * Cloudflare Cron Triggers can only reference literal cron expressions declared in `wrangler*.jsonc`,
 * and they run in UTC. The app's recurring jobs are declared with engine-neutral schedules (an
 * `everyMs` interval or a cron pattern plus a time zone) in `lib/jobs/recurring-registrations.ts`, so
 * this module bridges the two: it derives one cron expression per schedule *shape* and, at fire time,
 * maps the `controller.cron` string back to the job(s) to run.
 *
 * Why the daily jobs share one trigger: a Workers account on the Free plan may hold **five** Cron
 * Triggers in total (`code: 10072`; Workers Paid raises it to 1,000). The four `kind: "cron"`
 * registrations are all once-a-day sweeps, so declaring them separately would spend four of those five
 * slots on the same cadence and leave no room for anything else — including a trigger another Worker on
 * the account might need. They therefore share `CLOUDFLARE_DAILY_CRON`.
 *
 * What that costs: each daily sweep runs at the shared UTC hour rather than its declared wall-clock
 * time, so e.g. usage telemetry moves from 02:15 to 02:00 UTC and survey scheduling from 00:00
 * Europe/Berlin to 02:00 UTC. Every job still runs exactly once a day, and each is an idempotent,
 * self-scoped sweep whose own logic decides what is due — the trigger only decides *when it looks*. A
 * job that ever needs a distinct cadence should be declared with `kind: "every"`, which keeps its own
 * trigger (subject to the same five-trigger budget).
 */

interface CronJobMapping {
  cron: string;
  jobNames: string[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The single trigger every `kind: "cron"` (once-a-day) registration hangs off. See the note above. */
export const CLOUDFLARE_DAILY_CRON = "0 2 * * *";

/** Converts an `everyMs` interval to the nearest Cloudflare cron (its floor is one minute). */
const everyMsToCron = (everyMs: number): string => {
  if (everyMs < MINUTE_MS) {
    // Cloudflare cannot fire faster than once a minute; document the degradation rather than dropping
    // the job entirely, so a fast poller still makes progress.
    return "* * * * *";
  }

  if (everyMs < HOUR_MS && everyMs % MINUTE_MS === 0) {
    return `*/${(everyMs / MINUTE_MS).toString()} * * * *`;
  }

  if (everyMs % HOUR_MS === 0) {
    const hours = everyMs / HOUR_MS;
    return hours >= 24 ? `0 */${(hours / 24).toString()} * * *` : `0 */${hours.toString()} * * *`;
  }

  return "* * * * *";
};

const toCronExpression = (registration: (typeof RECURRING_JOB_REGISTRATIONS)[number]): string =>
  registration.schedule.kind === "cron"
    ? CLOUDFLARE_DAILY_CRON
    : everyMsToCron(registration.schedule.everyMs);

/**
 * The cron → jobs map the Worker's `scheduled()` handler dispatches from. Built once at module load
 * from the same registrations that drive registration, so a new recurring job is covered here without
 * a second declaration.
 */
export const CLOUDFLARE_CRON_JOBS: CronJobMapping[] = (() => {
  const byCron = new Map<string, string[]>();

  for (const registration of RECURRING_JOB_REGISTRATIONS) {
    const cron = toCronExpression(registration);
    const existing = byCron.get(cron) ?? [];
    existing.push(registration.job.name);
    byCron.set(cron, existing);
  }

  return [...byCron.entries()].map(([cron, jobNames]) => ({ cron, jobNames }));
})();

/** The literal cron expressions to declare under `triggers.crons` in `wrangler*.jsonc`. */
export const CLOUDFLARE_CRON_TRIGGERS: string[] = CLOUDFLARE_CRON_JOBS.map((mapping) => mapping.cron);

/**
 * Runs every recurring job scheduled for the cron that just fired. The handler and payload come from
 * the registration the job name maps to, so the dispatcher carries no per-job logic of its own.
 */
export const handleCloudflareScheduled = async (cron: string): Promise<void> => {
  const mapping = CLOUDFLARE_CRON_JOBS.find((entry) => entry.cron === cron);

  if (!mapping) {
    logger.warn({ cron }, "No recurring job is registered for this Cloudflare cron trigger");
    return;
  }

  const registrationsByName = new Map(
    RECURRING_JOB_REGISTRATIONS.map((registration) => [registration.job.name, registration])
  );

  await Promise.all(
    mapping.jobNames.map(async (jobName) => {
      const registration = registrationsByName.get(jobName);

      if (!registration) {
        logger.warn({ jobName }, "Cloudflare cron references an unknown recurring job");
        return;
      }

      try {
        await registration.handler(
          { scope: "global" },
          {
            attempt: 1,
            jobId: `cron:${cron}:${jobName}:${Date.now().toString()}`,
            jobName,
            maxAttempts: 1,
            queueName: "cloudflare-cron",
          }
        );
      } catch (error) {
        // One job failing must not stop its cron-mates: Cloudflare does not retry cron invocations, so
        // the job's own idempotency (a global sweep) is what covers the missed tick.
        logger.error({ err: error, cron, jobName }, "Cloudflare scheduled job failed");
      }
    })
  );
};

// Re-exported so the Worker entry can key its debug logging off the same source of truth.
export { RECURRING_JOB_REGISTRATIONS_BY_KEY };
