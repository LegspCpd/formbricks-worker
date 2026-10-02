import { logger } from "@formbricks/logger";
import type { JobHandlerOverrides } from "@/src/contracts";
import { type TRecurringJobKey, recurringJobDescriptors } from "@/src/recurring";
import type { TRecurringBackgroundJobSchedule } from "@/src/schedules";

/**
 * Engine-neutral stand-ins for the BullMQ runtime surface, so `@formbricks/jobs/cf` is a complete
 * drop-in for `@formbricks/jobs` when the app aliases the package for a Worker build.
 *
 * On Cloudflare the recurring schedule is *not* registered with a queue (there is no Redis-backed
 * scheduler); a Durable Object holds it and wakes itself with its own alarms, then enqueues the job that
 * came due. These handles therefore satisfy the app's registration code path without doing any queue
 * work — the schedule lives in that object's storage, not in a queue.
 */

export interface RecurringJobHandle {
  readonly name: string;
  readonly scheduleId: string;
  readonly scope: string;
  remove: () => Promise<boolean>;
  upsert: (schedule: TRecurringBackgroundJobSchedule) => Promise<unknown>;
}

const toCloudflareRecurringJobHandle = (key: TRecurringJobKey): RecurringJobHandle => {
  const descriptor = recurringJobDescriptors[key];

  return {
    name: descriptor.name,
    scheduleId: descriptor.scheduleId,
    scope: descriptor.scope,
    remove: () => Promise.resolve(false),
    upsert: (schedule) => {
      // Deliberately a no-op, not a silent failure: on the Cloudflare engine the schedule is held by the
      // jobs Worker's Durable Object and woken by its alarms, so registering it here would be the wrong
      // place. Logged at debug so a misconfiguration (calling this on Cloudflare at all) is visible
      // without being noisy on every boot.
      logger.debug(
        { jobName: descriptor.name, scheduleId: descriptor.scheduleId, schedule },
        "Cloudflare recurring schedule is held by the jobs Worker's Durable Object; upsert is a no-op"
      );

      return Promise.resolve({ name: descriptor.name, scheduleId: descriptor.scheduleId });
    },
  };
};

export const recurringJobs = Object.freeze(
  Object.fromEntries(
    (Object.keys(recurringJobDescriptors) as TRecurringJobKey[]).map((key) => [
      key,
      toCloudflareRecurringJobHandle(key),
    ])
  ) as Record<TRecurringJobKey, RecurringJobHandle>
);

export interface JobsRuntimeOptions {
  concurrency?: number;
  jobHandlerOverrides?: JobHandlerOverrides;
  prefix?: string;
  redisUrl?: string;
  workerCount?: number;
}

export interface JobsRuntimeHandle {
  close: () => Promise<void>;
}

/**
 * The BullMQ runtime cannot start on workerd (it opens a TCP Redis connection). Cloudflare runs jobs
 * through a Queue consumer instead, so this exists only to keep the app's `instrumentation-jobs`
 * import graph resolvable under the alias — it is never reached, because the Workers build compiles
 * that whole branch out (`FORMBRICKS_INSTRUMENTATION_JOBS_ENABLED=0`).
 */
export const startJobsRuntime = (): Promise<JobsRuntimeHandle> =>
  Promise.reject(new Error("The BullMQ runtime is not available on the Cloudflare jobs engine"));
