import { createClient } from "redis";
import { logger } from "@formbricks/logger";
import type { RedisClient } from "@/types/client";
import { type CacheError, ErrorCode, type Result, err, ok } from "@/types/error";
import { CacheService } from "./service";
import { KVCacheService } from "./kv-service";

interface CloudflareEnv {
  CACHE_KV?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
      keys: { name: string }[];
      list_complete: boolean;
      cursor?: string;
    }>;
  };
}

const getCloudflareEnv = (): CloudflareEnv | null => {
  try {
    const g = globalThis as unknown as { __cloudflareEnv?: CloudflareEnv };
    if (g.__cloudflareEnv?.CACHE_KV) {
      return g.__cloudflareEnv;
    }
  } catch {
    // not on Cloudflare
  }
  return null;
};

export const setCloudflareEnv = (env: CloudflareEnv): void => {
  (globalThis as unknown as { __cloudflareEnv?: CloudflareEnv }).__cloudflareEnv = env;
};

export async function createRedisClientFromEnv(): Promise<Result<RedisClient, CacheError>> {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.error("REDIS_URL is required to create the Redis client");
    return err({
      code: ErrorCode.RedisConfigurationError,
    });
  }

  const client = createClient({
    url,
    socket: {
      connectTimeout: 3000,
    },
    pingInterval: 300_000,
  });

  client.on("error", (error) => {
    logger.error(error, "Redis client error");
    try {
      resetCacheFactory();
      client.destroy();
    } catch (e) {
      logger.error(e, "Error destroying Redis client");
    }
  });

  client.on("connect", () => {
    logger.info("Redis client connected");
  });

  client.on("ready", () => {
    logger.info("Redis client ready");
  });

  client.on("end", () => {
    logger.info("Redis client disconnected");
  });

  try {
    await client.connect();
    return ok(client as RedisClient);
  } catch (error) {
    logger.error(error, "Redis client connection failed");
    return err({ code: ErrorCode.RedisConnectionError });
  }
}

const globalForCache = globalThis as unknown as {
  formbricksCache: CacheService | KVCacheService | undefined;
  formbricksCacheInitializing: Promise<Result<CacheService | KVCacheService, CacheError>> | undefined;
};

let singleton: CacheService | KVCacheService | null = globalForCache.formbricksCache ?? null;

export async function getCacheService(): Promise<Result<CacheService | KVCacheService, CacheError>> {
  if (singleton) {
    if (singleton instanceof KVCacheService) {
      return ok(singleton);
    }
    const rc = singleton.getRedisClient();
    if (rc?.isReady && rc.isOpen) return ok(singleton);
  }

  if (globalForCache.formbricksCache) {
    if (globalForCache.formbricksCache instanceof KVCacheService) {
      singleton = globalForCache.formbricksCache;
      return ok(globalForCache.formbricksCache);
    }
    const rc = globalForCache.formbricksCache.getRedisClient();
    if (rc?.isReady && rc.isOpen) {
      singleton = globalForCache.formbricksCache;
      return ok(globalForCache.formbricksCache);
    }
  }

  if (globalForCache.formbricksCacheInitializing) {
    const result = await globalForCache.formbricksCacheInitializing;
    if (result.ok) {
      singleton = result.data;
    }
    return result;
  }

  globalForCache.formbricksCacheInitializing = (async (): Promise<Result<CacheService | KVCacheService, CacheError>> => {
    const cfEnv = getCloudflareEnv();
    if (cfEnv?.CACHE_KV) {
      logger.info("Using Cloudflare KV cache service");
      const svc = new KVCacheService(cfEnv.CACHE_KV);
      singleton = svc;
      globalForCache.formbricksCache = svc;
      return ok(svc);
    }

    const clientResult = await createRedisClientFromEnv();
    if (!clientResult.ok) {
      logger.error({ error: clientResult.error }, "Redis client creation failed");
      return err({ code: clientResult.error.code });
    }

    const client = clientResult.data;
    logger.debug("Redis connection established");
    const svc = new CacheService(client);
    singleton = svc;
    globalForCache.formbricksCache = svc;
    logger.debug("Cache service created");
    return ok(svc);
  })();

  const result = await globalForCache.formbricksCacheInitializing;
  if (!result.ok) {
    globalForCache.formbricksCacheInitializing = undefined;
    logger.error({ error: result.error }, "Cache service creation failed");
  }
  return result;
}

export function resetCacheFactory(): void {
  singleton = null;
  globalForCache.formbricksCache = undefined;
  globalForCache.formbricksCacheInitializing = undefined;
}
