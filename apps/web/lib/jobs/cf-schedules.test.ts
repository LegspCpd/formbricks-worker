import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CLOUDFLARE_CRON_TRIGGERS } from "@/lib/jobs/cf-schedules";

/**
 * Cloudflare only accepts literal cron strings in `wrangler.jobs.jsonc`, so the array there cannot be
 * imported from `lib/jobs/cf-schedules.ts` and has to be kept in sync by hand. A drifted list is
 * silent: a cron that is declared but unmapped is a no-op, and a job whose cron was never declared
 * simply never fires. This asserts the two agree so a schedule change fails here instead of in
 * production.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerJobsPath = path.resolve(here, "..", "..", "wrangler.jobs.jsonc");

describe("jobs Worker cron triggers stay in sync with the recurring registrations", () => {
  const wranglerJobs = JSON.parse(
    fs.readFileSync(wranglerJobsPath, "utf-8").replace(/^\s*\/\/.*$/gm, "")
  ) as { triggers?: { crons?: string[] } };

  test("every derived cron is declared in wrangler.jobs.jsonc", () => {
    const declared = wranglerJobs.triggers?.crons ?? [];

    expect(declared.length).toBeGreaterThan(0);
    for (const cron of CLOUDFLARE_CRON_TRIGGERS) {
      expect(declared, `cron "${cron}" is derived but not declared in wrangler.jobs.jsonc`).toContain(cron);
    }
  });

  test("every declared cron maps back to at least one recurring job", () => {
    const declared = wranglerJobs.triggers?.crons ?? [];

    for (const cron of declared) {
      expect(
        CLOUDFLARE_CRON_TRIGGERS,
        `cron "${cron}" is declared in wrangler.jobs.jsonc but maps to no recurring job`
      ).toContain(cron);
    }
  });

  // The limit that a deploy actually failed on: `Trigger configuration for "…" was only partially
  // updated: This account has reached the Workers Free limit of 5 cron triggers per account …
  // [code: 10072]`. Free-plan deploys are the target here, so the declared set has to stay inside it —
  // and stay there on a Paid account too, where the same count is simply cheap.
  test("the declared triggers fit the Workers Free plan's per-account limit", () => {
    expect(CLOUDFLARE_CRON_TRIGGERS.length).toBeLessThanOrEqual(5);
  });
});
