import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import fs from "node:fs";
import path from "node:path";

// The middleware runs on the Edge runtime: `middleware.ts` (formerly `proxy.ts`) imports no Prisma, so
// Next.js compiles it for Edge and `@opennextjs/cloudflare` emits a small Edge `handler.mjs` instead of
// the old ~45 MiB Node bundle.
//
// Sharding. The whole app does not fit in one Worker: the server bundle is ~150 MiB against Cloudflare's
// 64 MiB uncompressed cap, and the Cloudflare adapter does not split an app across Workers on its own.
// `FORMBRICKS_SHARD` selects which shard this build produces. `createServerBundle` gives the `default`
// function every route NOT claimed by an entry in `functions`, and the adapter only ever bundles
// `default` (`worker.js` hardcodes `./server-functions/default/handler.mjs`). So to make `default` be
// exactly one shard, every OTHER shard's routes are claimed in `functions` -- they get built but this
// deploy ignores them. The route lists come from `server-shards.json`, written by
// `scripts/compute-server-shards.mjs` from Next's own route traces.
//
// Three constraints shape the code below:
//
// 1. The adapter compiles this file with esbuild into a temp dir (`compileOpenNextConfigNode`) and
//    imports the *bundle*, so `import.meta.url` would point at that temp dir. The manifest is therefore
//    resolved from `process.cwd()`, which every `opennextjs-cloudflare` command sets to apps/web.
// 2. It is compiled twice: once for Node and once for the edge (`platform: "browser"`), where the Node
//    builtins do not resolve. They are declared in `edgeExternals` so the edge compile leaves them
//    alone; without that the whole build fails with `Could not resolve "node:fs"` even with no shard
//    selected, because the edge variant is always produced.
// 3. The compiled config is copied into the Worker and re-imported at request time
//    (`createGenericHandler` -> `import("./open-next.config.mjs")`). So top-level code here runs inside
//    workerd: it must not touch `fs` or `path`. Those are reached only from `buildShard()`, which runs
//    solely when `FORMBRICKS_SHARD` is set -- a build-time-only variable the Worker never defines.
const shardName = process.env.FORMBRICKS_SHARD;

/** Claims every other shard's routes so `default` keeps only this shard's. Build-time only. */
const buildShard = () => {
  const manifestPath = path.join(process.cwd(), "server-shards.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `FORMBRICKS_SHARD=${shardName} but ${manifestPath} is missing. ` +
        "Run `node scripts/compute-server-shards.mjs` first."
    );
  }

  const plan = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const others = (plan.shards ?? []).filter((shard) => shard.name !== shardName);
  if (others.length === 0) {
    throw new Error(`FORMBRICKS_SHARD=${shardName} matches no shard in server-shards.json.`);
  }

  // Any route in `pinnedRoutes` appears in every shard already, so claiming it would only remove it
  // from this shard's `default` (the reverse of what is wanted). They are never claimed.
  const pinned = new Set(plan.pinnedRoutes ?? []);

  // One claim entry for every other shard's routes, not one per shard. `bundleServer` bundles only
  // `default`, so these entries are never deployed -- their entire purpose is to register the route
  // as "already handled" so `createServerBundle` leaves it out of `default`'s remaining routes.
  // Splitting them across `functions[shard-2]`, `functions[shard-3]`, ... would build and discard a
  // full ~150 MiB esbuild bundle each; a single entry does the same job with one.
  //
  // Route templates are the trace paths verbatim (`app/<path>/page` or `app/<path>/route`), which is
  // exactly the `RouteTemplate` format these options expect, and exactly the format
  // `createServerBundle` derives when it walks the standalone server for `remainingRoutes`.
  const claimedRoutes = others.flatMap((other) => other.routes).filter((route) => !pinned.has(route));
  return { functions: { others: { routes: claimedRoutes, patterns: [] } } };
};

const config = defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
});

const openNextConfig = {
  ...config,
  // Keep the adapter's default (`["node:crypto"]`) and add the builtins this file imports.
  edgeExternals: [...(config.edgeExternals ?? []), "node:fs", "node:path"],
  // Only an explicit shard build changes the shape; the default (unset) build stays exactly as before,
  // so a single-Worker build and the tooling that depends on it are unaffected. `FORMBRICKS_SHARD` is
  // unset in the Worker, so `buildShard` -- and its `fs`/`path` use -- never runs at request time.
  ...(shardName ? buildShard() : {}),
};

export default openNextConfig;
