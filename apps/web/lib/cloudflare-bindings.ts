import "server-only";
import { setCloudflareEnv } from "@formbricks/cache";
import { type CloudflareQueueBinding, setCloudflareQueueBinding } from "@formbricks/jobs";
import { setR2Bucket } from "@formbricks/storage";

type CacheKvBinding = Parameters<typeof setCloudflareEnv>[0]["CACHE_KV"];
type R2BucketBinding = Parameters<typeof setR2Bucket>[0];

interface CloudflareRuntimeEnv {
  CACHE_KV?: CacheKvBinding;
  JOBS_QUEUE?: CloudflareQueueBinding;
  STORAGE_R2?: R2BucketBinding;
}

let initialization: Promise<void> | null = null;
let r2StorageConfigured = false;

const initializeCloudflareBindings = async (): Promise<void> => {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = (getCloudflareContext() as { env?: CloudflareRuntimeEnv } | undefined)?.env;

    if (!env) {
      return;
    }

    if (env.CACHE_KV) {
      setCloudflareEnv({ CACHE_KV: env.CACHE_KV });
    }

    if (env.STORAGE_R2) {
      setR2Bucket(env.STORAGE_R2);
      r2StorageConfigured = true;
    }

    // The jobs queue producer binding. Handed to `@formbricks/jobs/cf` so the request-scope producer
    // and the in-Worker job handlers can enqueue without importing the OpenNext adapter themselves.
    if (env.JOBS_QUEUE) {
      setCloudflareQueueBinding(env.JOBS_QUEUE);
    }
  } catch {
    // Not on Cloudflare (local dev, vitest) — keep the Redis/S3 defaults.
  }
};

export const ensureCloudflareBindings = async (): Promise<void> => {
  initialization ??= initializeCloudflareBindings();
  await initialization;
};

export const isR2StorageConfigured = async (): Promise<boolean> => {
  await ensureCloudflareBindings();
  return r2StorageConfigured;
};
