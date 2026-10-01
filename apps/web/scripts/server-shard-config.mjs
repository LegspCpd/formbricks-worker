/**
 * Reads the shard plan written by `compute-server-shards.mjs` and prints the `functions` /
 * route-selection config the OpenNext build needs for a single shard.
 *
 * `@opennextjs/cloudflare` always bundles the `default` server function (its `worker.js` template
 * hardcodes `./server-functions/default/handler.mjs`), and `createServerBundle` gives `default` every
 * route that is NOT claimed by an entry in `functions`. So to build one shard as the `default`
 * function, the config must claim every OTHER shard's routes in `functions` -- then `default`'s trace
 * is exactly this shard's routes.
 *
 * The build runs once per shard, each with its own `buildOutputPath` (`.open-next-shard-N`), from the
 * same single `next build`. This script emits the per-shard OpenNext config fragment and the route
 * list, so the build/CI layer does not have to re-derive them.
 *
 * Usage:
 *   node scripts/server-shard-config.mjs list                 # print shard names and route counts
 *   node scripts/server-shard-config.mjs routes <shard>       # print one shard's routes (newline sep)
 *   node scripts/server-shard-config.mjs others <shard>       # print every OTHER shard's routes
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "..", "server-shards.json");

const readManifest = () => {
  if (!fs.existsSync(manifestPath)) {
    console.error(
      `::error::${manifestPath} is missing. Run \`node scripts/compute-server-shards.mjs\` first.`
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
};

/** OpenNext route templates are `app/<path>/page` or `app/<path>/route`; the trace path already is. */
const toRouteTemplate = (route) => route;

const main = () => {
  const [command, shardName] = process.argv.slice(2);
  const manifest = readManifest();
  const shards = manifest.shards ?? [];

  if (command === "list") {
    for (const shard of shards) {
      console.log(`${shard.name}\t${(shard.bytes / 1048576).toFixed(2)} MiB\t${shard.routes.length} routes`);
    }
    return;
  }

  if (!shardName) {
    console.error("::error::missing shard name");
    process.exit(1);
  }

  const shard = shards.find((entry) => entry.name === shardName);
  if (!shard) {
    console.error(`::error::unknown shard "${shardName}"`);
    process.exit(1);
  }

  if (command === "routes") {
    for (const route of shard.routes) console.log(toRouteTemplate(route));
    return;
  }

  if (command === "others") {
    // Routes in `pinnedRoutes` are present in every shard and must stay in `default`, so they are
    // never part of a claim list -- matches `open-next.config.ts`.
    const pinned = new Set(manifest.pinnedRoutes ?? []);
    for (const other of shards) {
      if (other.name === shardName) continue;
      for (const route of other.routes) {
        if (pinned.has(route)) continue;
        console.log(toRouteTemplate(route));
      }
    }
    return;
  }

  console.error(`::error::unknown command "${command}"`);
  process.exit(1);
};

main();
