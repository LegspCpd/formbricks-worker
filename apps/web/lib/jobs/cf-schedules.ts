import { type TGlobalScopeJobData, type TRecurringJobKey, recurringJobDescriptors } from "@formbricks/jobs";
import { RECURRING_JOB_SCHEDULES_BY_KEY } from "@/lib/jobs/recurring-schedules";

/**
 * The Cloudflare engine's scheduling, derived from the app's recurring-job declarations.
 *
 * Cloudflare Cron Triggers are not usable here: an account on the Workers Free plan may hold five in
 * total (`code: 10072`) and this one is spoken for by other Workers, so a deploy that declares any cron
 * is rejected. Durable Object alarms have no such budget — a Worker may have unlimited Durable Objects,
 * each of which can hold one alarm — and the documentation recommends exactly this shape for recurring
 * work: keep the schedule in storage, have `alarm()` process what is due and then reschedule itself.
 * `cloudflare/jobs-scheduler.ts` is that Durable Object; this module is the table it reads.
 *
 * Nothing here touches the job-handler graph. The Durable Object wakes on every tick and must not load
 * tens of megabytes of handlers to find out what is due, so the schedules come from
 * `recurring-schedules.ts` (the single source of truth, shared with the BullMQ registrations) and the
 * payload comes from the fact that every recurring job is a global-scope sweep. A test holds both of
 * those to their declarations.
 */

/**
 * The floor for an interval schedule. Cloudflare's per-minute granularity is not the reason — an alarm
 * can fire at any millisecond — the queues budget is: a 5s sweep would enqueue 17,280 messages a day and
 * spend over a million queue operations a month on its own, which is the whole Workers Free allowance
 * (and would bill on Paid). At a minute it is 43,200 messages a month. This mirrors the clamp the cron
 * version of this file applied, for a different reason.
 */
export const CLOUDFLARE_MIN_INTERVAL_MS = 60_000;

/**
 * The UTC hour the once-a-day sweeps share. They used to be four separate declarations at their own
 * wall-clock times; sharing one alarm keeps the Durable Object's wake-ups to one a day instead of four
 * and removes any need to match a fire time back to a job. Each is an idempotent sweep whose own logic
 * decides what is due, so only the instant moves — every job still runs exactly once a day.
 */
export const CLOUDFLARE_DAILY_HOUR_UTC = 2;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A schedule as Cloudflare can express it: a repeating interval, or once a day at a fixed UTC hour. */
export type CloudflareJobSchedule = { everyMs: number; kind: "interval" } | { kind: "daily" };

export interface CloudflareScheduledJob {
  /** The payload every recurring job's schema accepts — they are all global-scope sweeps. */
  data: TGlobalScopeJobData;
  jobName: string;
  schedule: CloudflareJobSchedule;
}

const toCloudflareSchedule = (
  schedule: (typeof RECURRING_JOB_SCHEDULES_BY_KEY)[TRecurringJobKey]
): CloudflareJobSchedule =>
  schedule.kind === "every"
    ? { everyMs: schedule.everyMs, kind: "interval" }
    : // Every `cron`-kind registration is a once-a-day sweep, so the pattern and its time zone reduce to
      // "daily" here. What the pattern and zone still own is the *app's* notion of which survey is due;
      // the alarm only decides when to look.
      { kind: "daily" };

export const CLOUDFLARE_SCHEDULED_JOBS: CloudflareScheduledJob[] = (
  Object.keys(RECURRING_JOB_SCHEDULES_BY_KEY) as TRecurringJobKey[]
).map((key) => ({
  data: { scope: "global" },
  jobName: recurringJobDescriptors[key].name,
  schedule: toCloudflareSchedule(RECURRING_JOB_SCHEDULES_BY_KEY[key]),
}));

const intervalFloor = (everyMs: number): number => Math.max(everyMs, CLOUDFLARE_MIN_INTERVAL_MS);

/** The UTC instant of `CLOUDFLARE_DAILY_HOUR_UTC` on the UTC day containing `reference`. */
const dailyInstantOn = (reference: number): number =>
  Math.floor(reference / DAY_MS) * DAY_MS + CLOUDFLARE_DAILY_HOUR_UTC * HOUR_MS;

/**
 * The next time a job should run, given when it last ran.
 *
 * Both branches skip missed ticks rather than replaying them: a Worker that was down for a day must not
 * come back and fire a per-minute sweep 1,440 times. The catch-up therefore jumps straight to the first
 * boundary after `now`.
 */
export const nextRunAtAfter = (schedule: CloudflareJobSchedule, lastRunAt: number, now: number): number => {
  if (schedule.kind === "daily") {
    const next = dailyInstantOn(lastRunAt);
    return next <= now ? dailyInstantOn(now + DAY_MS) : next;
  }

  const step = intervalFloor(schedule.everyMs);
  const next = lastRunAt + step;

  if (next > now) {
    return next;
  }

  // The smallest `lastRunAt + k * step` that is strictly after `now`. `Math.floor(...) + 1` rather than
  // `Math.ceil(...)`: a `next` that landed exactly on `now` would give a zero multiple and hand back
  // `now`, which the Durable Object would treat as immediately due and re-fire — a hot loop.
  return next + (Math.floor((now - next) / step) + 1) * step;
};

/**
 * When a job first runs after it is scheduled. Seeding at `lastRunAt = now` puts an interval one step
 * out — so enabling the scheduler does not fire every sweep at once — and a daily job at the next
 * `CLOUDFLARE_DAILY_HOUR_UTC`, which is the earliest instant that is not already in the past.
 */
export const initialRunAt = (schedule: CloudflareJobSchedule, now: number): number =>
  nextRunAtAfter(schedule, now, now);
