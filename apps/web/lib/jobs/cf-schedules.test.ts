import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { recurringJobDefinitions } from "@formbricks/jobs";
import {
  CLOUDFLARE_DAILY_HOUR_UTC,
  CLOUDFLARE_SCHEDULED_JOBS,
  initialRunAt,
  nextRunAtAfter,
} from "@/lib/jobs/cf-schedules";
import { RECURRING_JOB_REGISTRATIONS } from "@/lib/jobs/recurring-registrations";

/**
 * The Cloudflare schedule is derived from `recurring-schedules.ts`, so the job names in it come from the
 * same declarations the BullMQ path registers. What is *not* derived is the payload this engine sends
 * and the fact that the config declares no cron triggers at all — both are asserted here, because
 * neither failure is visible until a deploy or a job is due:
 *
 * - a payload the job's schema rejects is retried (or dead-lettered) instead of run;
 * - a declared cron trigger is rejected by the account's plan at deploy time (`code: 10072`).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerJobsPath = path.resolve(here, "..", "..", "wrangler.jobs.jsonc");

describe("the Cloudflare schedule stays in step with the recurring declarations", () => {
  test("every recurring job is scheduled, and nothing else is", () => {
    const registered = RECURRING_JOB_REGISTRATIONS.map((registration) => registration.job.name).sort();
    const scheduled = CLOUDFLARE_SCHEDULED_JOBS.map((job) => job.jobName).sort();

    expect(scheduled).toEqual(registered);
  });

  test("the payload this engine sends is accepted by every scheduled job's schema", () => {
    for (const job of CLOUDFLARE_SCHEDULED_JOBS) {
      const definition = recurringJobDefinitions[job.jobName];

      expect(definition, `no job definition for "${job.jobName}"`).toBeDefined();
      expect(
        definition.schema.safeParse(job.data).success,
        `"${job.jobName}" rejects the scheduler's payload`
      ).toBe(true);
    }
  });

  test("the jobs Worker declares no cron triggers", () => {
    const wranglerJobs = JSON.parse(
      fs.readFileSync(wranglerJobsPath, "utf-8").replace(/^\s*\/\/.*$/gm, "")
    ) as { triggers?: { crons?: string[] } };

    // A Workers Free account holds five Cron Triggers in total, per account, and this one is full — so
    // any cron here fails the deploy with `code: 10072`. The Durable Object in `wrangler.jobs.jsonc`
    // drives the schedule instead.
    expect(wranglerJobs.triggers?.crons ?? []).toEqual([]);
  });
});

describe("run-time arithmetic", () => {
  const MINUTE = 60_000;

  test("an interval below the floor is raised to it", () => {
    // The authzed projection sweep is declared at 5s for the self-hosted engine; on Cloudflare the floor
    // is a queue-operation budget, not a platform limit (see the constant's comment).
    const next = nextRunAtAfter({ everyMs: 5_000, kind: "interval" }, 1_000_000, 1_000_000);

    expect(next).toBe(1_000_000 + MINUTE);
  });

  test("missed runs are skipped, not replayed", () => {
    // Down for ten minutes: the sweep runs once, not ten times.
    const next = nextRunAtAfter({ everyMs: MINUTE, kind: "interval" }, 0, 10 * MINUTE);

    expect(next).toBe(11 * MINUTE);
  });

  test("a run due exactly at `now` moves forward instead of repeating", () => {
    // Returning `now` here would make the alarm immediately due again — the Durable Object would re-fire
    // the same job in a hot loop.
    const next = nextRunAtAfter({ everyMs: MINUTE, kind: "interval" }, 0, MINUTE);

    expect(next).toBe(2 * MINUTE);
  });

  test("a daily job lands on the shared UTC hour", () => {
    const before = Date.UTC(2026, 0, 1, 0, 30);
    const after = Date.UTC(2026, 0, 1, 5, 0);
    const expected = Date.UTC(2026, 0, 1, CLOUDFLARE_DAILY_HOUR_UTC);

    expect(initialRunAt({ kind: "daily" }, before)).toBe(expected);
    expect(initialRunAt({ kind: "daily" }, after)).toBe(expected + 24 * 60 * MINUTE);
  });

  test("a job's first run is one interval out, not immediately due", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0);

    expect(initialRunAt({ everyMs: 3 * MINUTE, kind: "interval" }, now)).toBe(now + 3 * MINUTE);
  });
});
