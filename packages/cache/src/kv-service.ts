import { logger } from "@formbricks/logger";
import type { RedisClient } from "@/types/client";
import { type CacheError, ErrorCode, type Result, err, ok } from "@/types/error";
import type { CacheKey } from "@/types/keys";
import { ZCacheKey } from "@/types/keys";
import { ZTtlMs, ZTtlMsOptional } from "@/types/service";
import { validateInputs } from "./utils/validation";

const NULLABLE_BOX_MARKER = "__fb_nullable_v1";

interface NullableCacheBox<T> {
  [NULLABLE_BOX_MARKER]: true;
  value: T | null;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string; expiration?: number; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export class KVCacheService {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async get<T>(key: CacheKey): Promise<Result<T | null, CacheError>> {
    const validation = validateInputs([key, ZCacheKey]);
    if (!validation.ok) {
      return validation;
    }

    try {
      const value = await this.kv.get(key);
      if (value === null) {
        return ok(null);
      }

      try {
        return ok(JSON.parse(value) as T);
      } catch (parseError) {
        logger.warn({ key, parseError }, "Corrupted cache data detected, treating as cache miss");
        return err({ code: ErrorCode.CacheCorruptionError });
      }
    } catch (error) {
      logger.error({ error, key }, "Cache get operation failed");
      return err({ code: ErrorCode.RedisOperationError });
    }
  }

  async exists(key: CacheKey): Promise<Result<boolean, CacheError>> {
    const validation = validateInputs([key, ZCacheKey]);
    if (!validation.ok) {
      return validation;
    }

    try {
      const value = await this.kv.get(key);
      return ok(value !== null);
    } catch (error) {
      logger.error({ error, key }, "Cache exists operation failed");
      return err({ code: ErrorCode.RedisOperationError });
    }
  }

  async set(key: CacheKey, value: unknown, ttlMs?: number): Promise<Result<void, CacheError>> {
    const validation = validateInputs([key, ZCacheKey], [ttlMs, ZTtlMsOptional]);
    if (!validation.ok) {
      return validation;
    }

    if (value === undefined) {
      logger.warn({ key, ttlMs }, "cache.set called with undefined; skipping write");
      return ok(undefined);
    }

    try {
      const serialized = JSON.stringify(value);
      const options: { expirationTtl?: number } = {};
      if (ttlMs !== undefined) {
        options.expirationTtl = Math.max(1, Math.floor(ttlMs / 1000));
      }
      await this.kv.put(key, serialized, options);
      return ok(undefined);
    } catch (error) {
      logger.error({ error, key, ttlMs }, "Cache set operation failed");
      return err({ code: ErrorCode.RedisOperationError });
    }
  }

  async del(keys: CacheKey[]): Promise<Result<void, CacheError>> {
    for (const key of keys) {
      const validation = validateInputs([key, ZCacheKey]);
      if (!validation.ok) {
        return validation;
      }
    }

    try {
      await Promise.all(keys.map((key) => this.kv.delete(key)));
      return ok(undefined);
    } catch (error) {
      logger.error({ error, keys }, "Cache delete operation failed");
      return err({ code: ErrorCode.RedisOperationError });
    }
  }

  async tryLock(key: CacheKey, value: string, ttlMs: number): Promise<Result<boolean, CacheError>> {
    const validation = validateInputs([key, ZCacheKey], [ttlMs, ZTtlMs]);
    if (!validation.ok) {
      return validation;
    }

    try {
      const existing = await this.kv.get(key);
      if (existing !== null) {
        return ok(false);
      }
      await this.kv.put(key, value, { expirationTtl: Math.max(1, Math.floor(ttlMs / 1000)) });
      return ok(true);
    } catch (error) {
      logger.error({ error, key, ttlMs }, "Cache lock operation failed");
      return err({ code: ErrorCode.RedisOperationError });
    }
  }

  async withCache<T extends NonNullable<unknown>>(
    fn: () => Promise<T>,
    key: CacheKey,
    ttlMs: number
  ): Promise<T> {
    const cachedValue = await this.tryGetCachedValue<T>(key);
    if (cachedValue !== undefined) {
      return cachedValue;
    }

    const fresh = await fn();
    await this.trySetCache(key, fresh, ttlMs);
    return fresh;
  }

  async withCacheNullable<T extends NonNullable<unknown>>(
    fn: () => Promise<T | null>,
    key: CacheKey,
    ttlMs: number
  ): Promise<T | null> {
    const cachedValue = await this.tryGetCachedValue<unknown>(key);
    if (cachedValue !== undefined) {
      if (this.isNullableCacheBox<T>(cachedValue)) {
        return cachedValue.value;
      }
    }

    const fresh = await fn();
    const box: NullableCacheBox<T> = { [NULLABLE_BOX_MARKER]: true, value: fresh };
    await this.trySetCache(key, box, ttlMs);
    return fresh;
  }

  getRedisClient(): RedisClient | null {
    return null;
  }

  private isNullableCacheBox<T>(value: unknown): value is NullableCacheBox<T> {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<string, unknown>)[NULLABLE_BOX_MARKER] === true &&
      Object.hasOwn(value, "value")
    );
  }

  private async tryGetCachedValue<T>(key: CacheKey): Promise<T | undefined> {
    try {
      const cacheResult = await this.get<T>(key);
      if (cacheResult.ok && cacheResult.data !== null) {
        return cacheResult.data;
      }
    } catch (error) {
      logger.debug({ error, key }, "Cache get threw; proceeding to compute fresh value");
    }
    return undefined;
  }

  private async trySetCache(key: CacheKey, value: unknown, ttlMs: number): Promise<void> {
    if (value === undefined || value === null) {
      return;
    }
    try {
      const setResult = await this.set(key, value, ttlMs);
      if (!setResult.ok) {
        logger.debug({ error: setResult.error, key, ttlMs }, "Failed to cache fresh data");
      }
    } catch (error) {
      logger.debug({ error, key, ttlMs }, "Cache set threw; returning fresh result");
    }
  }
}
