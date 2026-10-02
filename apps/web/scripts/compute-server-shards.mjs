/**
 * Pre-flight check for Cloudflare Worker deployment.
 *
 * A Worker script is capped at 64 MiB *uncompressed*, and this app's single server bundle exceeds
 * that. Splitting the app across several Workers is the only way to keep the full feature set, and
 * this script answers the one question that decision depends on: how many shards are needed, and how
 * big each one would be.
 *
 * It reads the Next.js build output directly. Every route emits a `<route>.js.nft.json` listing each
 * file Node would require to serve it, so the union of a shard's routes' traced files is a close
 * approximation of that shard's bundled `handler.mjs` (measured: the full union predicts 152 MiB
 * against an actual 150 MiB bundle, ~1% high -- which is why the default budget keeps headroom).
 *
 * Read-only: it never modifies the build output, so it cannot affect the deploy. Exits 0 even when it
 * cannot measure, so a diagnostic never fails the pipeline.
 *
 * Usage: node scripts/compute-server-shards.mjs [buildRoot] [budgetMiB]
 *   buildRoot defaults to whichever candidate build output holds the most route traces (the deployed
 *   `.open-next` copy keeps only a handful; `apps/web/.next` keeps all of them).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The size a shard's traced union is allowed to reach. Kept well under the 64 MiB cap on purpose: the
// union over-counts what esbuild emits (it charges every traced file, including the ones tree-shaking
// removes), and by an amount that varies per shard -- CI measured two shards whose unions were both
// ~60 MiB ship at 75.81 and 55.12 MiB. A budget near the cap therefore fills each shard to ~60 MiB of
// union and ships some of them over.
//
// 40 MiB keeps the largest shard's union far enough below the cap that even the worst over-count CI
// has seen (1.39x) stays under it, and the extra shards it opens carry less content each. That is the
// direction the measurements point: the two shards the four-shard plan could not fit were the two
// carrying the most content, and halving a shard's content is what brings it under the cap.
const PER_SHARD_BUDGET_MIB = 40;

// A guard against a runaway plan, not a target: with a budget the packer opens exactly as many shards
// as it needs, and this only stops a pathological plan from spanning dozens of Workers.
const MAX_SHARDS = 12;

// One Worker also carries the Edge middleware (~1.2 MiB) plus the adapter runtime, so a shard's own
// server bundle is budgeted below the 64 MiB cap rather than at it.
const DEFAULT_BUDGET_MIB = 60;

const CANDIDATE_ROOTS = [
  ".open-next/server-functions/default/apps/web/.next",
  ".open-next/server-functions/default/.next",
  "apps/web/.open-next/server-functions/default/apps/web/.next",
  "apps/web/.open-next/server-functions/default/.next",
  "apps/web/.next",
  ".next",
];

const findRoot = () => {
  // The `.open-next` copy is what gets deployed, but it does not retain every per-route
  // `<route>.js.nft.json` manifest -- only a handful survive the copy. The untouched `apps/web/.next`
  // has the full set, and the traced file list is what a shard's size depends on, so prefer whichever
  // candidate actually contains the most traces rather than the first that merely has a `server/` dir.
  let best = null;
  let bestCount = 0;
  for (const candidate of CANDIDATE_ROOTS) {
    const serverDir = path.join(candidate, "server");
    if (!fs.existsSync(serverDir)) continue;
    const count = collectTraces(serverDir, []).length;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
};

const collectTraces = (dir, acc) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTraces(full, acc);
    else if (entry.name.endsWith(".js.nft.json")) acc.push(full);
  }
  return acc;
};

const sizeCache = new Map();
const sizeOf = (file) => {
  let size = sizeCache.get(file);
  if (size === undefined) {
    try {
      const stat = fs.statSync(file);
      size = stat.isFile() ? stat.size : 0;
    } catch {
      size = 0;
    }
    sizeCache.set(file, size);
  }
  return size;
};

const main = () => {
  const root = process.argv[2] || findRoot();
  if (!root || !fs.existsSync(root)) {
    console.log("::warning::compute-server-shards: no Next.js build output found; skipping.");
    return;
  }

  const budgetMiB = Number(process.argv[3]) || DEFAULT_BUDGET_MIB;
  const budget = budgetMiB * 1024 * 1024;
  const contentBudget = PER_SHARD_BUDGET_MIB * 1024 * 1024;
  const serverDir = path.join(root, "server");

  // A route whose trace pulls in `@vercel/og` must always stay in the `default` function, whatever
  // shard it lands in. The adapter's `patchVercelOgLibrary` (run while bundling `default`) globs
  // EVERY route trace -- not just the ones this shard owns -- and copies the Edge build of the
  // library next to the route. A shard that merely *claims* such a route in `functions` never copies
  // its files, so that copy throws `ENOENT ... @vercel/og/index.edge.js` and the whole build dies.
  // Keeping these routes unclaimed puts them back in `default` for every shard, which is also what
  // the router expects: they are served identically by whichever shard gets the request.
  const OG_MARKER = "@vercel/og/index.node.js";

  const traceFiles = collectTraces(serverDir, []);
  if (traceFiles.length < 5) {
    console.log(
      `::warning::compute-server-shards: only ${traceFiles.length} route traces under ${serverDir}; skipping.`
    );
    return;
  }

  // route -> Map(absoluteFile -> bytes)
  const routes = [];
  for (const traceFile of traceFiles) {
    let partial;
    try {
      partial = JSON.parse(fs.readFileSync(traceFile, "utf8"));
    } catch {
      continue;
    }
    const base = path.dirname(traceFile);
    const files = new Map();
    for (const rel of partial.files ?? []) {
      const abs = path.resolve(base, rel);
      const size = sizeOf(abs);
      if (size > 0) files.set(abs, size);
    }
    let bytes = 0;
    for (const size of files.values()) bytes += size;
    routes.push({
      route: path
        .relative(serverDir, traceFile)
        .replace(/\.js\.nft\.json$/, "")
        .split(path.sep)
        .join("/"),
      files,
      bytes,
    });
  }

  // Files required by *every* route are the floor on any shard: no packing can go below it.
  let base = new Set(routes[0].files.keys());
  for (const route of routes.slice(1)) {
    if (base.size === 0) break;
    const next = new Set();
    for (const file of base) if (route.files.has(file)) next.add(file);
    base = next;
  }
  let baseBytes = 0;
  for (const file of base) baseBytes += routes[0].files.get(file) ?? sizeOf(file);

  // `copyTracedFiles` copies the instrumentation and middleware closures into EVERY function, but a
  // copied file is not a bundled file: the server bundle is what esbuild inlines from `index.mjs`, and
  // it tree-shakes the rest (the deployed metafile lists no @opentelemetry even though the
  // instrumentation trace does). So this is reported for context only — folding it into every shard
  // would assume copied == bundled and over-count by an order of magnitude.
  const alwaysIncluded = new Map();
  for (const name of ["instrumentation.js.nft.json", "middleware.js.nft.json"]) {
    const traceFile = path.join(serverDir, name);
    if (!fs.existsSync(traceFile)) continue;
    let partial;
    try {
      partial = JSON.parse(fs.readFileSync(traceFile, "utf8"));
    } catch {
      continue;
    }
    const traceDir = path.dirname(traceFile);
    for (const rel of partial.files ?? []) {
      const abs = path.resolve(traceDir, rel);
      const size = sizeOf(abs);
      if (size > 0) alwaysIncluded.set(abs, size);
    }
  }
  // Routes that describe the always-included traces rather than a page/route, and so must not be
  // listed as a shard's own routes.
  const serverLevelTraces = new Set(["instrumentation", "middleware"]);
  const packable = routes.filter((route) => !serverLevelTraces.has(route.route));

  // Routes whose trace pulls in `@vercel/og` end up in EVERY shard's `default` (see OG_MARKER above),
  // so they are pulled out of the packing below and seeded into every shard instead. Keys are absolute
  // paths, so normalise the separator before matching the forward-slash marker.
  //
  // Only the `@vercel/og` package files are charged to every shard, not the route's whole traced
  // closure: a copied-but-tree-shaken file does not ship, and the rest of that closure (sharp, otlp,
  // jsdom, ...) is already carried by nearly every other route's closure anyway. Charging the whole
  // closure here is what once turned a 4-shard plan into 14.
  const pinnedRoutes = packable.filter((route) =>
    [...route.files.keys()].some((file) => file.split(path.sep).join("/").endsWith(OG_MARKER))
  );
  const pinnedNames = new Set(pinnedRoutes.map((route) => route.route));
  const pinnedFiles = new Map();
  for (const route of pinnedRoutes) {
    for (const [file, size] of route.files) {
      if (file.split(path.sep).join("/").includes("/@vercel/og/")) pinnedFiles.set(file, size);
    }
  }
  let pinnedBytes = 0;
  for (const size of pinnedFiles.values()) pinnedBytes += size;

  // Best-fit-decreasing over the routes' own traced closures, against a per-shard budget.
  //
  // Best-fit, not balanced. Balancing (LPT) was tried and CI measured the result: it spread the heavy
  // shared files across every shard, so five shards came to 375 MiB total where four best-fit shards
  // came to 262 MiB -- the same app, 113 MiB more of it, because a file two shards share is stored
  // twice. Best-fit keeps related routes together so they share, which is what actually keeps the
  // largest shard small; CI measured 53-55 MiB shards under it where balancing gave 72-77 MiB.
  //
  // Each route (largest first) goes into the shard it grows the least, but only if that shard stays
  // within `PER_SHARD_BUDGET_MIB`; otherwise a new shard opens. The budget applies to the union
  // itself, because the union is what approximates the whole `handler.mjs`.
  const shards = [];
  const openShard = () => ({
    files: new Map(pinnedFiles),
    bytes: pinnedBytes,
    routes: [...pinnedNames].sort(),
  });

  for (const route of [...packable]
    .filter((route) => !pinnedNames.has(route.route))
    .sort((a, b) => b.bytes - a.bytes)) {
    // What this route would actually add to a shard: only the files that shard does not already have.
    // Routes overlap heavily -- that is why a shard's bundle is smaller than the sum of its routes --
    // so charging a route its full size would open new shards for the wrong reason.
    const growthIn = (shard) => {
      let growth = 0;
      for (const [file, size] of route.files) if (!shard.files.has(file)) growth += size;
      return growth;
    };

    let target = null;
    let bestGrowth = Infinity;
    for (const shard of shards) {
      const growth = growthIn(shard);
      // A shard may only take the route if it stays inside the budget. At the ceiling the routes have
      // to go somewhere, so the least-growth shard takes them and the overflow is reported instead.
      if (shards.length < MAX_SHARDS && shard.bytes + growth > contentBudget) continue;
      if (growth < bestGrowth) {
        bestGrowth = growth;
        target = shard;
      }
    }

    const shard = target ?? openShard();
    for (const [file, size] of route.files) {
      if (!shard.files.has(file)) {
        shard.files.set(file, size);
        shard.bytes += size;
      }
    }
    shard.routes.push(route.route);
    if (!shards.includes(shard)) shards.push(shard);
  }
  if (shards.length === 0) shards.push(openShard());

  shards.sort((a, b) => b.bytes - a.bytes);
  const mib = (n) => (n / 1048576).toFixed(2);
  const union = new Map();
  for (const route of routes) for (const [file, size] of route.files) union.set(file, size);
  const unionBytes = [...union.values()].reduce((sum, size) => sum + size, 0);
  const fixedBytes = [...alwaysIncluded.values()].reduce((sum, size) => sum + size, 0);

  console.log("::group::Shard feasibility (pre-flight)");
  console.log(`build output:     ${root}`);
  console.log(`routes traced:    ${routes.length}`);
  console.log(`shared floor:     ${mib(baseBytes)} MiB (files every route needs)`);
  console.log(
    `copied-but-unbundled: ${mib(fixedBytes)} MiB (instrumentation + middleware traces, context only)`
  );
  console.log(`union:            ${mib(unionBytes)} MiB (distinct files across all routes)`);
  console.log(`cap / shard:      ${budgetMiB} MiB (whole handler.mjs)`);
  console.log(`content / shard:  ${PER_SHARD_BUDGET_MIB} MiB (traced union budget)`);
  console.log(`shard ceiling:    ${MAX_SHARDS}\n`);

  for (const [index, shard] of shards.entries()) {
    const top = [...shard.routes].sort().slice(0, 3).join(", ");
    console.log(
      `  shard-${index + 1}: ${mib(shard.bytes).padStart(8)} MiB  ${String(shard.routes.length).padStart(4)} routes  (${top}${shard.routes.length > 3 ? ", ..." : ""})`
    );
  }

  // Since the cap applies per shard, it is the *largest* shard that decides whether the plan is viable
  // -- one shard over is the whole deploy over.
  const largest = Math.max(...shards.map((shard) => shard.bytes));
  const shardsOverBudget = shards.filter((shard) => shard.bytes > contentBudget).length;
  if (shardsOverBudget > 0) {
    console.log(
      `\n::warning::${shardsOverBudget} of ${shards.length} shards exceed the ${PER_SHARD_BUDGET_MIB} MiB content budget (largest ${mib(largest)} MiB). The heaviest route's own closure may not fit any shard; if so, splitting cannot fix it and the shared runtime has to shrink.`
    );
  } else {
    console.log(
      `\nEvery shard fits: the largest is ${mib(largest)} MiB of content, within the ${PER_SHARD_BUDGET_MIB} MiB budget.`
    );
  }
  console.log("::endgroup::");

  const manifest = {
    generatedAt: new Date().toISOString(),
    budgetBytes: budget,
    contentBudgetBytes: contentBudget,
    maxShards: MAX_SHARDS,
    sharedFloorBytes: baseBytes,
    // Present in every shard and never claimed, so `default` always keeps them (see OG_MARKER).
    pinnedRoutes: [...pinnedNames].sort(),
    shards: shards.map((shard, index) => ({
      name: `shard-${index + 1}`,
      // The union of this shard's routes' traced files, which is what its `handler.mjs` bundles.
      bytes: shard.bytes,
      routes: shard.routes.sort(),
    })),
  };
  const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server-shards.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifestPath}`);
};

main();
