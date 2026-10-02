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
 * this module bridges the two: it derives one cron expression per recurring job and, at fire time,
 * maps the `controller.cron` string back to the job(s) to run.
 *
 * Time-zone note: a job declared with a time zone (e.g. survey scheduling at 00:00 Europe/Berlin) is
 * registered at its *UTC* wall-clock equivalent here, because Cloudflare crons are UTC-only. The
 * schedule therefore fires at the right UTC instant for the current offset; a DST shift moves the
 * local wall clock by an hour until the config is regenerated. Scheduling *semantics* (which survey
 * runs when) stay in the app.
 */

interface CronJobMapping {
  cron: string;
  jobNames: string[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

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
    ? registration.schedule.cronPattern
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
