import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

interface CloudflareResponse<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

interface KVNamespace {
  id: string;
  title: string;
}

interface R2Bucket {
  name: string;
}

interface Queue {
  name: string;
  created_on: string;
}

const runDatabaseMigrations = (): void => {
  console.log("Running database migrations...");

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  try {
    const prismaDir = resolve(__dirname, "../../../packages/database");
    execSync("npx prisma migrate deploy", {
      cwd: prismaDir,
      stdio: "inherit",
      env: { ...process.env },
    });
    console.log("  Database migrations applied successfully");
  } catch (error) {
    console.error("  Database migrations failed:", error);
    throw error;
  }
};

const getCloudflareApiToken = (): string => {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error("CLOUDFLARE_API_TOKEN is required");
  }
  return token;
};

const getCloudflareAccountId = (): string => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  }
  return accountId;
};

const cloudflareApi = async <T>(
  path: string,
  options: RequestInit = {}
): Promise<CloudflareResponse<T>> => {
  const token = getCloudflareApiToken();
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = (await response.json()) as CloudflareResponse<T>;
  if (!data.success) {
    throw new Error(`Cloudflare API error: ${data.errors.map((e) => e.message).join(", ")}`);
  }
  return data;
};

const findKVNamespace = async (title: string): Promise<KVNamespace | null> => {
  const accountId = getCloudflareAccountId();
  const data = await cloudflareApi<KVNamespace[]>(
    `/accounts/${accountId}/storage/kv/namespaces?per_page=100`
  );
  return data.result.find((ns) => ns.title === title) ?? null;
};

const createKVNamespace = async (title: string): Promise<KVNamespace> => {
  const accountId = getCloudflareAccountId();
  const data = await cloudflareApi<KVNamespace>(
    `/accounts/${accountId}/storage/kv/namespaces`,
    {
      method: "POST",
      body: JSON.stringify({ title }),
    }
  );
  return data.result;
};

const findR2Bucket = async (name: string): Promise<R2Bucket | null> => {
  const accountId = getCloudflareAccountId();
  try {
    const data = await cloudflareApi<R2Bucket[]>(
      `/accounts/${accountId}/r2/buckets?per_page=100`
    );
    return data.result.find((b) => b.name === name) ?? null;
  } catch {
    return null;
  }
};

const createR2Bucket = async (name: string): Promise<R2Bucket> => {
  const accountId = getCloudflareAccountId();
  const data = await cloudflareApi<R2Bucket>(
    `/accounts/${accountId}/r2/buckets`,
    {
      method: "POST",
      body: JSON.stringify({ name }),
    }
  );
  return data.result;
};

const findQueue = async (name: string): Promise<Queue | null> => {
  const accountId = getCloudflareAccountId();
  try {
    const data = await cloudflareApi<Queue[]>(
      `/accounts/${accountId}/queues?per_page=100`
    );
    return data.result.find((q) => q.name === name) ?? null;
  } catch {
    return null;
  }
};

const createQueue = async (name: string): Promise<Queue> => {
  const accountId = getCloudflareAccountId();
  const data = await cloudflareApi<Queue>(
    `/accounts/${accountId}/queues`,
    {
      method: "POST",
      body: JSON.stringify({ name }),
    }
  );
  return data.result;
};

const ensureKVNamespace = async (title: string): Promise<string> => {
  const existing = await findKVNamespace(title);
  if (existing) {
    console.log(`  KV namespace "${title}" already exists: ${existing.id}`);
    return existing.id;
  }
  const created = await createKVNamespace(title);
  console.log(`  Created KV namespace "${title}": ${created.id}`);
  return created.id;
};

const ensureR2Bucket = async (name: string): Promise<string> => {
  const existing = await findR2Bucket(name);
  if (existing) {
    console.log(`  R2 bucket "${name}" already exists`);
    return existing.name;
  }
  const created = await createR2Bucket(name);
  console.log(`  Created R2 bucket "${created.name}"`);
  return created.name;
};

const ensureQueue = async (name: string): Promise<string> => {
  const existing = await findQueue(name);
  if (existing) {
    console.log(`  Queue "${name}" already exists`);
    return existing.name;
  }
  const created = await createQueue(name);
  console.log(`  Created Queue "${created.name}"`);
  return created.name;
};

const updateWranglerConfig = (config: {
  cacheKvId: string;
  tagCacheKvId: string;
  memoryCacheKvId: string;
  r2BucketName: string;
  queueName: string;
}): void => {
  const wranglerPath = resolve(__dirname, "../wrangler.jsonc");
  let content = readFileSync(wranglerPath, "utf-8");

  content = content.replace(/"id":\s*"formbricks_cache_kv"/, `"id": "${config.cacheKvId}"`);
  content = content.replace(/"id":\s*"formbricks_tag_cache_kv"/, `"id": "${config.tagCacheKvId}"`);
  content = content.replace(/"id":\s*"formbricks_memory_cache_kv"/, `"id": "${config.memoryCacheKvId}"`);
  content = content.replace(/"bucket_name":\s*"formbricks-storage"/, `"bucket_name": "${config.r2BucketName}"`);
  content = content.replace(/"name":\s*"formbricks-jobs"/, `"name": "${config.queueName}"`);

  writeFileSync(wranglerPath, content);
  console.log("  Updated wrangler.jsonc with resource IDs");
};

const main = async (): Promise<void> => {
  console.log("=== Formbricks Cloudflare Setup ===\n");

  try {
    runDatabaseMigrations();

    console.log("\nSetting up Cloudflare resources...");

    const cacheKvId = await ensureKVNamespace("formbricks_cache_kv");
    const tagCacheKvId = await ensureKVNamespace("formbricks_tag_cache_kv");
    const memoryCacheKvId = await ensureKVNamespace("formbricks_memory_cache_kv");
    const r2BucketName = await ensureR2Bucket("formbricks-storage");
    const queueName = await ensureQueue("formbricks-jobs");

    updateWranglerConfig({
      cacheKvId,
      tagCacheKvId,
      memoryCacheKvId,
      r2BucketName,
      queueName,
    });

    console.log("\n=== Setup complete! ===");
  } catch (error) {
    console.error("\nSetup failed:", error);
    process.exit(1);
  }
};

main();
