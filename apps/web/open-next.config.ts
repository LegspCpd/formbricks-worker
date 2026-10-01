import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The middleware runs on the Edge runtime: `middleware.ts` (formerly `proxy.ts`) imports no Prisma, so
// Next.js compiles it for Edge and `@opennextjs/cloudflare` emits a small Edge `handler.mjs` instead of
// the old ~45 MiB Node bundle.
//
// Sharding. The whole app does not fit in one Worker: the server bundle is ~150 MiB against Cloudflare's
// 64 MiB uncompressed cap, and the Cloudflare adapter does not split an app across Workers on its own.
// `FORMBRICKS_SHARD` selects which shard this build produces. `createServerBundle` gives the `default`
// function every route NOT claimed by an entry in `functions`, and the adapter only ever bundles
// `default` (`worker.js` hardcodes `./server-functions/default/handler.mjs`). So to make `default` be
// exactly one shard, every OTHER shard's routes are claimed in `functions` -- they get built as separate
// server-function folders, which this deploy ignores. The route lists come from `server-shards.json`,
// written by `scripts/compute-server-shards.mjs` from Next's own route traces.
const here = path.dirname(fileURLToPath(import.meta.url));
const shardName = process.env.FORMBRICKS_SHARD;

const readShardPlan = () => {
  const manifestPath = path.join(here, "server-shards.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `FORMBRICKS_SHARD=${shardName} but ${manifestPath} is missing. ` +
        "Run `node scripts/compute-server-shards.mjs` first."
    );
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
};

/** Claims every other shard's routes so `default` keeps only this shard's. */
const buildShard = () => {
  const plan = readShardPlan();
  const others = (plan.shards ?? []).filter((shard) => shard.name !== shardName);
  if (others.length === 0) {
    throw new Error(`FORMBRICKS_SHARD=${shardName} matches no shard in server-shards.json.`);
  }

  // One claim entry for every other shard's routes, not one per shard. `bundleServer` bundles only
  // `default`, so these entries are never deployed -- their entire purpose is to register the route
  // as "already handled" so `createServerBundle` leaves it out of `default`'s remaining routes.
  // Splitting them across `functions[shard-2]`, `functions[shard-3]`, ... would build and discard a
  // full ~150 MiB esbuild bundle each; a single entry does the same job with one.
  //
  // Route templates are the trace paths verbatim (`app/<path>/page` or `app/<path>/route`), which is
  // exactly the `RouteTemplate` format these options expect, and exactly the format
  // `createServerBundle` derives when it walks the standalone server for `remainingRoutes`.
  const claimedRoutes = others.flatMap((other) => other.routes);
  return { functions: { others: { routes: claimedRoutes, patterns: [] } } };
};

const config = defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
});

// Only an explicit shard build changes the shape; the default (unset) build stays exactly as before,
// so a single-Worker build and the tooling that depends on it are unaffected.
const shardOverrides = shardName ? buildShard() : {};

const openNextConfig = {
  ...config,
  ...shardOverrides,
};

export default openNextConfig;
