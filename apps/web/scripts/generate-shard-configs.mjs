/**
 * Turns the shard plan into the Wrangler configs and the router's route table.
 *
 * The app does not fit in one Worker (the OpenNext server bundle is ~125 MiB against Cloudflare's
 * 64 MiB uncompressed cap), so it is deployed as several Workers plus one router:
 *
 *   - `wrangler.router.jsonc`  the Worker the world talks to. It owns the static assets and forwards
 *                              every app request to the shard that owns the route.
 *   - `wrangler.<shard>.jsonc` one per shard. Each runs the same OpenNext server, built with only its
 *                              own routes in `default` (see open-next.config.ts + FORMBRICKS_SHARD).
 *
 * Cloudflare has no built-in multi-Worker split (the adapter only ever bundles `default`), so the
 * routing table is derived here from the plan `compute-server-shards.mjs` wrote and handed to the
 * router as a generated module (`cloudflare/shard-plan.ts`).
 *
 * Assets. A Worker may own only one asset collection, and the router is the one that needs it: it is
 * the Worker that receives public traffic, so Cloudflare serves `/_next/static/...` and the `public/`
 * files from its asset layer *before* the router's `fetch` ever runs.
 *
 * One shard owns a second copy, the one the router falls back to (see `fallbackBinding`). It is the
 * shard that Next's `/_next/image` reaches -- the route table has no entry for it, so it lands on the
 * fallback -- and the image optimizer reads its source through `env.ASSETS`. That binding cannot be a
 * service binding back to the router: a service binding invokes the target's `fetch` handler, not its
 * asset layer, so it would re-enter the router rather than resolve the file. Giving the fallback shard
 * its own copy keeps the whole topology free of binding cycles -- no shard depends on the router, and
 * only the router depends on the shards -- so the shards deploy first and the router last.
 *
 * Usage: node scripts/generate-shard-configs.mjs
 *   Reads `wrangler.jsonc` (the resolved base config) and `server-shards.json`.
 *   Writes `wrangler.router.jsonc`, `wrangler.<shard>.jsonc` and `cloudflare/shard-plan.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..");

/**
 * Next's internal rewrites, which the router has to honour itself: the destination is a real route,
 * and it is not necessarily on the shard that would otherwise receive the source path. Left to a
 * shard's own Next server, the rewrite would resolve to a route that shard does not bundle and 404.
 * `next.config.mjs`'s `rewrites()` is the source of truth; the one internal entry is listed here by
 * hand because parsing that file would mean re-evaluating it with the build's environment.
 */
const INTERNAL_REWRITES = [
  {
    sourceTemplate: "app/api/v2/organizations/[organizationId]/project-teams/route",
    destinationTemplate: "app/api/v2/organizations/[organizationId]/workspace-teams/route",
  },
];

/** Server-level traces, not routes a URL can address. */
const SERVER_LEVEL_TRACES = new Set(["instrumentation", "middleware"]);
/** Next's internal error boundaries. They ship in every shard but have no URL of their own. */
const INTERNAL_BOUNDARY_TEMPLATES = [
  "app/_not-found/page",
  "app/_global-error/page",
  "_not-found",
  "_global-error",
];

/** The asset directory the OpenNext build writes, and the binding its handlers read it through. */
const ASSETS_DIRECTORY = ".open-next/assets";
const ASSETS_BINDING = "ASSETS";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `wrangler.jsonc` carries comments (including a commented-out Hyperdrive block) that `JSON.parse`
 * rejects. This strips line and block comments while respecting string literals, so a `//` inside a
 * URL is left alone.
 */
const stripJsonc = (text) => {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
};

const readJson = (file) => JSON.parse(stripJsonc(fs.readFileSync(path.join(appDir, file), "utf8")));
const writeJson = (file, value) => {
  fs.writeFileSync(path.join(appDir, file), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`Wrote ${file}`);
};

/**
 * A Next route template (`app/<path>/page` or `app/<path>/route`) as a URL regex.
 *
 * Route groups -- `(app)`, `(auth)`, `(redirects)`, ... -- are parenthesised folders that never appear
 * in a URL. `[x]` is one segment, `[...x]` is one or more, `[[...x]]` is zero or more (so the slash
 * before it has to be part of the optional group).
 */
const routeTemplateToRegex = (template, basePath) => {
  const parts = template.split("/").filter(Boolean);
  if (parts[0] === "app") parts.shift();
  if (parts[parts.length - 1] === "page" || parts[parts.length - 1] === "route") parts.pop();
  const segments = parts.filter((segment) => !/^\(.*\)$/.test(segment));

  let source = `^${escapeRegExp(basePath)}`;
  for (const segment of segments) {
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) source += "(?:/.*)?";
    else if (/^\[\.\.\..+\]$/.test(segment)) source += "/.+";
    else if (/^\[.+\]$/.test(segment)) source += "/[^/]+";
    else source += `/${escapeRegExp(segment)}`;
  }
  return `${source}/?$`;
};

/** How many URL segments a template fixes, and how many it leaves open. Drives match order. */
const specificityOf = (template) => {
  const parts = template.split("/").filter(Boolean);
  if (parts[0] === "app") parts.shift();
  if (parts[parts.length - 1] === "page" || parts[parts.length - 1] === "route") parts.pop();
  const segments = parts.filter((segment) => !/^\(.*\)$/.test(segment));
  return {
    catchAlls: segments.filter((segment) => /^\[\[?\.\.\..+\]\]?$/.test(segment)).length,
    dynamics: segments.filter((segment) => /^\[/.test(segment)).length,
    length: segments.length,
  };
};

const main = () => {
  const base = readJson("wrangler.jsonc");
  const plan = readJson("server-shards.json");
  const shards = plan.shards ?? [];
  if (shards.length === 0) {
    console.error("::error::server-shards.json has no shards; run compute-server-shards.mjs first.");
    process.exit(1);
  }

  const basePath = (process.env.BASE_PATH || "").replace(/\/$/, "");
  const baseName = base.name;

  // Cloudflare allows 64 bindings of every kind on one Worker, and the router spends one service
  // binding per shard (plus its assets binding). Past that the router cannot be configured at all, so
  // stop with a clear message instead of emitting a config the deploy would reject.
  const MAX_BINDINGS = 64;
  if (shards.length + 1 > MAX_BINDINGS) {
    console.error(
      `::error::the plan has ${shards.length} shards; the router can hold at most ${MAX_BINDINGS - 1} ` +
        "service bindings (64 bindings per Worker). The shards are too small to be viable -- the shared " +
        "runtime has to shrink, or the budget in compute-server-shards.mjs has to rise."
    );
    process.exit(1);
  }

  const bindingFor = (index) => `SHARD_${index + 1}`;
  const workerNameFor = (shard) => `${baseName}-${shard.name}`;
  // The shard every unmatched request lands on: it renders Next's redirects and 404 page, and it is
  // the one the router forwards `/_next/image` to.
  const fallbackBinding = bindingFor(0);

  // --- Route table ------------------------------------------------------------------------------
  //
  // One entry per URL the app answers. Ordered most-specific first -- literal routes before dynamic
  // ones, catch-alls last, longer paths before shorter prefixes -- so `/workspaces/x/settings` lands
  // on the shard that owns it rather than on the shard that owns `/workspaces/[id]`.
  const owned = [];
  for (const [index, shard] of shards.entries()) {
    for (const route of shard.routes) {
      if (SERVER_LEVEL_TRACES.has(route)) continue;
      if (INTERNAL_BOUNDARY_TEMPLATES.includes(route)) continue;
      // Pinned routes ship in every shard; only the first owner is emitted, and any shard serves it.
      if (owned.some((entry) => entry.template === route)) continue;
      owned.push({ template: route, binding: bindingFor(index) });
    }
  }

  owned.sort((a, b) => {
    const sa = specificityOf(a.template);
    const sb = specificityOf(b.template);
    if (sa.catchAlls !== sb.catchAlls) return sa.catchAlls - sb.catchAlls;
    if (sa.dynamics !== sb.dynamics) return sa.dynamics - sb.dynamics;
    if (sa.length !== sb.length) return sb.length - sa.length;
    return a.template.localeCompare(b.template);
  });

  const byTemplate = new Map(owned.map((entry) => [entry.template, entry]));
  const shardRoutes = owned.map((entry) => ({
    binding: entry.binding,
    source: routeTemplateToRegex(entry.template, basePath),
  }));

  // --- Internal rewrites ------------------------------------------------------------------------
  const shardAliases = INTERNAL_REWRITES.map((rewrite) => {
    const destination = byTemplate.get(rewrite.destinationTemplate);
    if (!destination) {
      console.error(`::error::rewrite destination ${rewrite.destinationTemplate} is not in any shard.`);
      process.exit(1);
    }
    return { binding: destination.binding, source: routeTemplateToRegex(rewrite.sourceTemplate, basePath) };
  });

  // Duplicate URLs are fine as long as the shards involved all define them; only a URL no shard owns
  // would 404, and that cannot happen because every route above came from the plan.
  const seen = new Map();
  for (const route of shardRoutes) {
    if (seen.has(route.source) && seen.get(route.source) !== route.binding) {
      console.log(
        `::notice::URL pattern ${route.source} is served by both ${seen.get(route.source)} and ${route.binding}`
      );
    }
    seen.set(route.source, route.binding);
  }

  // --- Router config ----------------------------------------------------------------------------
  //
  // `not_found_handling` is deliberately absent. `single-page-application` (what the single-Worker
  // config used) answers an unmatched navigation request with `index.html` and never invokes the
  // Worker, which would stop the router from ever reaching the shard that renders the route. Without
  // it, the default behaviour applies: a matching asset is served, everything else runs the router.
  writeJson("wrangler.router.jsonc", {
    $schema: base.$schema,
    name: baseName,
    main: "cloudflare/shard-router.ts",
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    minify: base.minify,
    observability: base.observability,
    assets: { directory: ASSETS_DIRECTORY, binding: ASSETS_BINDING },
    services: shards.map((shard, index) => ({ binding: bindingFor(index), service: workerNameFor(shard) })),
    ...(base.vars ? { vars: base.vars } : {}),
  });

  // --- Shard configs ----------------------------------------------------------------------------
  //
  // One config per shard. They are identical apart from the name, except that the fallback shard owns
  // the assets (the router forwards `/_next/image` to it -- see the file header). The self-reference
  // keeps the shard's cache-revalidation queue in its own namespace, which is what the adapter's
  // `WORKER_SELF_REFERENCE` expects.
  for (const [index, shard] of shards.entries()) {
    const workerName = workerNameFor(shard);
    writeJson(`wrangler.${shard.name}.jsonc`, {
      $schema: base.$schema,
      name: workerName,
      main: ".open-next/worker.js",
      compatibility_date: base.compatibility_date,
      compatibility_flags: base.compatibility_flags,
      minify: base.minify,
      observability: base.observability,
      ...(base.kv_namespaces ? { kv_namespaces: base.kv_namespaces } : {}),
      ...(base.r2_buckets ? { r2_buckets: base.r2_buckets } : {}),
      ...(base.queues ? { queues: base.queues } : {}),
      ...(base.hyperdrive ? { hyperdrive: base.hyperdrive } : {}),
      ...(index === 0 ? { assets: { directory: ASSETS_DIRECTORY, binding: ASSETS_BINDING } } : {}),
      services: [{ binding: "WORKER_SELF_REFERENCE", service: workerName }],
      ...(base.vars ? { vars: base.vars } : {}),
    });
  }

  // --- Generated module -------------------------------------------------------------------------
  const planModule = `// AUTO-GENERATED by scripts/generate-shard-configs.mjs. Do not edit by hand.
//
// The routing table the shard router matches against, written from \`server-shards.json\` after the
// OpenNext build. The plan is derived from Next's own route traces, so it cannot live in the
// repository; the committed copy is an empty placeholder so the app type-checks on a fresh clone and
// CI regenerates this file before the router is built.

export interface ShardRoute {
  /** The service binding on the router that points at the shard owning this route. */
  binding: string;
  /** An anchored regular expression source matching the route's URL path. */
  source: string;
}

/** Routes, ordered most-specific first. */
export const shardRoutes: ShardRoute[] = ${JSON.stringify(shardRoutes, null, 2)};

/** Next's internal rewrites, mapped to the shard that owns the rewrite's destination. */
export const shardAliases: ShardRoute[] = ${JSON.stringify(shardAliases, null, 2)};

/** Used when no route matches: redirects, image requests, the 404 boundary, and anything else. */
export const fallbackBinding = ${JSON.stringify(fallbackBinding)};
`;
  fs.writeFileSync(path.join(appDir, "cloudflare", "shard-plan.ts"), planModule);
  console.log(
    `Wrote cloudflare/shard-plan.ts (${shardRoutes.length} routes, ${shardAliases.length} aliases)`
  );
};

main();
