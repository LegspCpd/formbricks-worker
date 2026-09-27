// Re-export everything from factory
export { getCacheService, setCloudflareEnv } from "./client";
export type { CacheService } from "./service";
export { KVCacheService } from "./kv-service";

// Export cache keys
export { createCacheKey } from "./cache-keys";

// Export types
export type { CacheKey } from "./types/keys";
export type { CacheError, Result } from "./types/error";
export { ErrorCode } from "./types/error";
