import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

// The Worker that gets deployed. Nothing is created here: `wrangler deploy` owns the Worker itself,
// this script only makes sure its bindings resolve to real resources. Override with
// CLOUDFLARE_WORKER_NAME when the Worker in your account is named differently.
const DEFAULT_WORKER_NAME = "formbricks-worker";

// Prefix for the resources that have to be created when the Worker does not already bind one.
// Override with CLOUDFLARE_RESOURCE_PREFIX to keep several deployments apart in one account.
const DEFAULT_RESOURCE_PREFIX = "formbricks";

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
  queue_id: string;
  queue_name: string;
  created_on: string;
}

// A subset of the entries returned by GET /accounts/{id}/workers/scripts/{name}/settings. Every
// binding carries the resource it points at under a type-specific key.
interface WorkerBinding {
  name?: string;
  type?: string;
  namespace_id?: string;
  bucket_name?: string;
  queue_name?: string;
  service?: string;
  id?: string;
  database_id?: string;
}

interface ResolvedBindings {
  cacheKvId: string;
  tagCacheKvId: string;
  memoryCacheKvId: string;
  r2BucketName: string;
  queueName: string;
  deadLetterQueueName: string;
  selfReference: string;
  hyperdriveId: string | null;
}

const runDatabaseMigrations = (): void => {
  console.log("Running database migrations...");

  const databaseUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or MIGRATE_DATABASE_URL) is required to run migrations");
  }

  const repoRootDir = resolve(__dirname, "../../..");
  const migrationRunnerPath = resolve(repoRootDir, "packages/database/dist/scripts/apply-migrations.js");
  // Prisma's `runtime = "cloudflare"` client loads its query compiler through the bundler-only
  // `?module` convention, which plain Node cannot satisfy; this hook supplies the missing shape. See
  // the module for the full story.
  const wasmModuleLoaderPath = resolve(
    repoRootDir,
    "packages/database/dist/scripts/register-wasm-module-loader.js"
  );

  try {
    // `pnpm build:cf:full` already built `@formbricks/database` (it is part of the `@formbricks/web^...`
    // graph), and `dist/scripts/apply-migrations.js` is one of its `vite build` outputs. Rebuilding it here
    // burned a second full generate/build/tsc pass; on Cloudflare Workers Builds — 2 vCPU, 8 GB, 20 minutes
    // for the whole job — that is time the build cannot spare. Only build when the artifact is genuinely
    // missing, which keeps this script usable standalone.
    if (!existsSync(migrationRunnerPath) || !existsSync(wasmModuleLoaderPath)) {
      console.log("  Building @formbricks/database...");
      execSync("pnpm build --filter=@formbricks/database", {
        cwd: repoRootDir,
        stdio: "inherit",
        env: { ...process.env },
      });
    }

    if (!existsSync(migrationRunnerPath)) {
      throw new Error(`Migration runner not found at ${migrationRunnerPath}`);
    }

    if (!existsSync(wasmModuleLoaderPath)) {
      throw new Error(`Wasm module loader not found at ${wasmModuleLoaderPath}`);
    }

    console.log("  Applying migrations with the Formbricks migration runner...");
    execSync(
      `node --import ${JSON.stringify(pathToFileURL(wasmModuleLoaderPath).href)} ${JSON.stringify(migrationRunnerPath)}`,
      {
        cwd: repoRootDir,
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: databaseUrl },
      }
    );

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

const getWorkerName = (): string => process.env.CLOUDFLARE_WORKER_NAME?.trim() || DEFAULT_WORKER_NAME;

const getResourceNames = (): {
  cacheKv: string;
  tagCacheKv: string;
  memoryCacheKv: string;
  r2Bucket: string;
  jobsQueue: string;
  jobsDeadLetterQueue: string;
  jobsWorkerName: string;
} => {
  const prefix = process.env.CLOUDFLARE_RESOURCE_PREFIX?.trim() || DEFAULT_RESOURCE_PREFIX;
  const workerName = getWorkerName();
  return {
    cacheKv: `${prefix}_cache_kv`,
    tagCacheKv: `${prefix}_tag_cache_kv`,
    memoryCacheKv: `${prefix}_memory_cache_kv`,
    r2Bucket: `${prefix}-storage`,
    jobsQueue: `${prefix}-jobs`,
    jobsDeadLetterQueue: `${prefix}-jobs-dlq`,
    // The dedicated jobs Worker is named after the main one so a renamed deployment stays consistent.
    jobsWorkerName: `${workerName}-jobs`,
  };
};

const cloudflareApi = async <T>(path: string, options: RequestInit = {}): Promise<CloudflareResponse<T>> => {
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

// Reads what the Worker in this account already has bound, so an existing deployment is reused
// instead of duplicated. Returns null when the Worker does not exist yet.
const fetchWorkerBindings = async (workerName: string): Promise<Map<string, WorkerBinding> | null> => {
  const accountId = getCloudflareAccountId();
  const token = getCloudflareApiToken();
  const url = `${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/settings`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 404) {
    return null;
  }

  const data = (await response.json()) as CloudflareResponse<{ bindings?: WorkerBinding[] }>;
  if (!data.success) {
    // A missing Workers Scripts:Read scope must not break a first deployment that has nothing to
    // reuse anyway, so fall back to finding or creating the resources by name.
    console.warn(
      `  Could not read the settings of Worker "${workerName}": ${data.errors.map((e) => e.message).join(", ")}`
    );
    console.warn("  Falling back to looking the resources up by name.");
    return null;
  }

  const bindings = new Map<string, WorkerBinding>();
  for (const binding of data.result?.bindings ?? []) {
    if (binding?.type && binding?.name) {
      bindings.set(`${binding.type}:${binding.name}`, binding);
    }
  }
  return bindings;
};

const reuseBinding = <K extends keyof WorkerBinding>(
  bindings: Map<string, WorkerBinding> | null,
  type: string,
  bindingName: string,
  key: K
): string | null => {
  const value = bindings?.get(`${type}:${bindingName}`)?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
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
  const data = await cloudflareApi<KVNamespace>(`/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return data.result;
};

const findR2Bucket = async (name: string): Promise<R2Bucket | null> => {
  const accountId = getCloudflareAccountId();
  try {
    const data = await cloudflareApi<{ buckets: R2Bucket[] }>(
      `/accounts/${accountId}/r2/buckets?per_page=100`
    );
    return data.result.buckets?.find((b) => b.name === name) ?? null;
  } catch {
    return null;
  }
};

const createR2Bucket = async (name: string): Promise<R2Bucket> => {
  const accountId = getCloudflareAccountId();
  const data = await cloudflareApi<R2Bucket>(`/accounts/${accountId}/r2/buckets`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return data.result;
};

const findQueue = async (name: string): Promise<Queue | null> => {
  const accountId = getCloudflareAccountId();
  try {
    const data = await cloudflareApi<Queue[]>(`/accounts/${accountId}/queues?per_page=100`);
    return data.result.find((q) => q.queue_name === name) ?? null;
  } catch {
    return null;
  }
};

const createQueue = async (name: string): Promise<Queue> => {
  const accountId = getCloudflareAccountId();
  const data = await cloudflareApi<Queue>(`/accounts/${accountId}/queues`, {
    method: "POST",
    body: JSON.stringify({ queue_name: name }),
  });
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
    return existing.queue_name;
  }
  const created = await createQueue(name);
  console.log(`  Created Queue "${created.queue_name}"`);
  return created.queue_name;
};

const resolveBindings = async (
  bindings: Map<string, WorkerBinding> | null,
  names: ReturnType<typeof getResourceNames>,
  workerName: string
): Promise<ResolvedBindings> => {
  const cacheKvId =
    reuseBinding(bindings, "kv_namespace", "CACHE_KV", "namespace_id") ??
    (await ensureKVNamespace(names.cacheKv));
  const tagCacheKvId =
    reuseBinding(bindings, "kv_namespace", "TAG_CACHE_KV", "namespace_id") ??
    (await ensureKVNamespace(names.tagCacheKv));
  const memoryCacheKvId =
    reuseBinding(bindings, "kv_namespace", "MEMORY_CACHE_KV", "namespace_id") ??
    (await ensureKVNamespace(names.memoryCacheKv));

  // Both R2 bindings point at the same bucket: uploads and the incremental cache share it.
  const r2BucketName =
    reuseBinding(bindings, "r2_bucket", "STORAGE_R2", "bucket_name") ??
    reuseBinding(bindings, "r2_bucket", "NEXT_INC_CACHE_R2_BUCKET", "bucket_name") ??
    (await ensureR2Bucket(names.r2Bucket));

  const queueName =
    reuseBinding(bindings, "queue", "JOBS_QUEUE", "queue_name") ?? (await ensureQueue(names.jobsQueue));

  // The dead-letter queue is a separate queue the consumer forwards to after `max_retries`. It is only
  // read by the jobs Worker, so it is never a binding on the main Worker; ensure it exists regardless.
  const deadLetterQueueName = await ensureQueue(names.jobsDeadLetterQueue);

  const selfReference = reuseBinding(bindings, "service", "WORKER_SELF_REFERENCE", "service") ?? workerName;

  // Hyperdrive is optional. Only add it when the Worker already uses it or one was handed to us.
  const hyperdriveId =
    process.env.CLOUDFLARE_HYPERDRIVE_ID?.trim() ||
    reuseBinding(bindings, "hyperdrive", "HYPERDRIVE", "id") ||
    null;

  return {
    cacheKvId,
    tagCacheKvId,
    memoryCacheKvId,
    r2BucketName,
    queueName,
    deadLetterQueueName,
    selfReference,
    hyperdriveId,
  };
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Rewrites one key inside a binding object, whatever it currently holds. Matching the value rather
// than a placeholder means the script also works when the file already carries real ids, and keeps
// every comment in the file intact.
const setBindingValue = (content: string, bindingName: string, key: string, value: string): string => {
  const pattern = new RegExp(
    `("binding"\\s*:\\s*"${escapeRegExp(bindingName)}"[^{}]*?"${escapeRegExp(key)}"\\s*:\\s*)"[^"]*"`
  );
  if (!pattern.test(content)) {
    throw new Error(`Could not find "${key}" for binding "${bindingName}" in wrangler.jsonc`);
  }
  return content.replace(pattern, `$1"${value}"`);
};

const setWorkerName = (content: string, workerName: string): string => {
  const pattern = /(^|\n)(\s*)"name"\s*:\s*"[^"]*"/;
  if (!pattern.test(content)) {
    throw new Error('Could not find the top-level "name" in wrangler.jsonc');
  }
  return content.replace(pattern, `$1$2"name": "${workerName}"`);
};

// Adds or replaces the (optional) Hyperdrive binding, reusing the commented-out placeholder that
// ships with the repository so the surrounding explanation keeps working.
const upsertHyperdrive = (content: string, id: string): string => {
  const block = `"hyperdrive": [\n    {\n      "binding": "HYPERDRIVE",\n      "id": "${id}"\n    }\n  ],`;

  const commented = /^[ \t]*\/\/\s*"hyperdrive"\s*:\s*\[[\s\S]*?^[ \t]*\/\/\s*\],[ \t]*\r?\n/gm;
  if (commented.test(content)) {
    return content.replace(commented, `  ${block}\n`);
  }

  const existing = /"hyperdrive"\s*:\s*\[[\s\S]*?\n[ \t]*\],[ \t]*\r?\n/;
  if (existing.test(content)) {
    return content.replace(existing, `  ${block}\n`);
  }

  const assets = /(^|\n)(\s*)"assets"\s*:/;
  if (!assets.test(content)) {
    throw new Error('Could not find the "assets" block in wrangler.jsonc to insert "hyperdrive" before');
  }
  return content.replace(assets, `$1  ${block}\n$1$2"assets":`);
};

const updateWranglerConfig = (workerName: string, resolved: ResolvedBindings): void => {
  const wranglerPath = resolve(__dirname, "../wrangler.jsonc");
  let content = readFileSync(wranglerPath, "utf-8");

  content = setWorkerName(content, workerName);

  content = setBindingValue(content, "CACHE_KV", "id", resolved.cacheKvId);
  content = setBindingValue(content, "TAG_CACHE_KV", "id", resolved.tagCacheKvId);
  content = setBindingValue(content, "MEMORY_CACHE_KV", "id", resolved.memoryCacheKvId);

  // Both R2 entries have to end up on the same bucket, so rewrite them from the same value.
  content = setBindingValue(content, "STORAGE_R2", "bucket_name", resolved.r2BucketName);
  content = setBindingValue(content, "NEXT_INC_CACHE_R2_BUCKET", "bucket_name", resolved.r2BucketName);

  content = setBindingValue(content, "JOBS_QUEUE", "queue", resolved.queueName);
  content = setBindingValue(content, "WORKER_SELF_REFERENCE", "service", resolved.selfReference);

  if (resolved.hyperdriveId) {
    content = upsertHyperdrive(content, resolved.hyperdriveId);
  }

  writeFileSync(wranglerPath, content);
  console.log(`  Updated ${wranglerPath}`);
};

// The jobs Worker's config carries the queue names and its own Worker name as literals (Cloudflare only
// accepts literal values there), so they are rewritten from the resolved resources. Only the `queue`
// and the dead-letter queue are touched: the `binding` names are fixed by the code.
const updateJobsWranglerConfig = (
  names: ReturnType<typeof getResourceNames>,
  resolved: ResolvedBindings
): void => {
  const wranglerPath = resolve(__dirname, "../wrangler.jobs.jsonc");
  let content = readFileSync(wranglerPath, "utf-8");

  content = setWorkerName(content, names.jobsWorkerName);

  const repointQueue = (key: "queue" | "dead_letter_queue", value: string): void => {
    const pattern = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`, "g");
    if (!pattern.test(content)) {
      throw new Error(`Could not find "${key}" in wrangler.jobs.jsonc`);
    }
    content = content.replace(pattern, `$1"${value}"`);
  };

  repointQueue("queue", resolved.queueName);
  repointQueue("dead_letter_queue", resolved.deadLetterQueueName);

  writeFileSync(wranglerPath, content);
  console.log(`  Updated ${wranglerPath}`);
};

const main = async (): Promise<void> => {
  console.log("=== Formbricks Cloudflare Setup ===\n");

  const workerName = getWorkerName();
  const names = getResourceNames();

  console.log(`Worker:           ${workerName}`);
  console.log(`Jobs Worker:      ${names.jobsWorkerName}`);
  console.log(
    `Resource prefix:  ${process.env.CLOUDFLARE_RESOURCE_PREFIX?.trim() || DEFAULT_RESOURCE_PREFIX}`
  );

  try {
    runDatabaseMigrations();

    console.log("\nLooking for what this Worker already binds...");
    const bindings = await fetchWorkerBindings(workerName);
    if (bindings === null) {
      console.warn(`  Worker "${workerName}" does not exist in this account yet.`);
      console.warn("  `wrangler deploy` will create it. Set the CLOUDFLARE_WORKER_NAME secret if you");
      console.warn("  meant to deploy into a Worker that already exists.");
    } else if (bindings.size === 0) {
      console.log("  The Worker exists but has no bindings yet.");
    } else {
      console.log(`  Found ${bindings.size} existing binding(s) to reuse:`);
      for (const [key, binding] of bindings) {
        const target =
          binding.namespace_id ?? binding.bucket_name ?? binding.queue_name ?? binding.service ?? binding.id;
        console.log(`    ${key}${target ? ` -> ${target}` : ""}`);
      }
    }

    console.log("\nResolving resources...");
    const resolved = await resolveBindings(bindings, names, workerName);

    updateWranglerConfig(workerName, resolved);
    updateJobsWranglerConfig(names, resolved);

    console.log("\n=== Setup complete! ===");
  } catch (error) {
    console.error("\nSetup failed:", error);
    process.exit(1);
  }
};

main();
