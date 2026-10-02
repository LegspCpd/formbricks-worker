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

// The ceiling on how many Workers the app is split across.
//
// Measured, not assumed. CI builds every shard and reports its real `handler.mjs`. Two numbers came
// out of that, and together they decide this constant:
//
//   * every shard carries the same irreducible runtime -- 34.67 MiB, measured by building
//     `FORMBRICKS_SHARD=floor`;
//   * between them the routes need 123.68 MiB of shard-local content on top of it.
//
// Four shards would give each one 64 - 34.67 = 29.33 MiB of content room, so 4 x 29.33 = 117.3 MiB
// against the 123.68 MiB the routes actually need: 6.4 MiB short, and CI duly measured 75.81 and
// 78.06 MiB shards. The shortfall is structural, not a packing failure -- no assignment of routes to
// four shards can get the total below what the routes weigh. Five shards give 146.6 MiB of room,
// which clears it with margin for the route-trace model being imperfect.
const MAX_SHARDS = 5;

// One Worker also carries the Edge middleware (~1.2 MiB) plus the adapter runtime, so a shard's own
// server bundle is budgeted below the 64 MiB cap rather than at it.
//
// No separate "floor" is subtracted from this: a route's traced file list already includes the Next
// server runtime and the Prisma engine, because every route needs them, so the union of a shard's
// routes IS its bundle -- the shared runtime is counted once inside it, not added on top. (CI
// confirms it: a shard the model put at 60.00 MiB measured 56.40 MiB; adding a ~34 MiB floor would
// have predicted ~94.) `FORMBRICKS_SHARD=floor` is still measured by CI, but as a *diagnostic* of how
// much no route split can remove -- not as a term in this budget.
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

  // Longest-processing-time-first, over the routes' own traced closures: place each route (largest
  // first) into the shard that is currently smallest. Best-fit-decreasing -- which the previous
  // version used -- packs greedily into whichever shard has room, and that produced wildly uneven
  // shards: CI measured 77.91 MiB beside 48.01 MiB. Uneven shards are the failure mode here, because
  // the cap applies per shard, so it is the *largest* shard that decides whether the plan is viable.
  // LPT is the standard 4/3-approximation of the minimum makespan, so it keeps the largest shard as
  // small as the model allows.
  //
  // A shard's size is the union of its routes' traced files, and that union already contains the
  // shared runtime (every route needs it), so the budget is checked against the union directly.
  // The number of shards is fixed, not derived from a size budget, because the model below is not
  // accurate enough to decide it. CI measures every shard's real `handler.mjs`, and the gap between
  // what this model predicts and what esbuild emits is large and not one-directional -- it called one
  // shard 59.87 MiB that measured 75.81, and another 58.85 MiB that measured 55.12. A budget-driven
  // packer would act on those numbers and open the wrong number of shards. What the model *is* good
  // for is the relative sizes, which is what balancing needs, so it partitions into a fixed count and
  // CI decides whether that count was enough.
  //
  // N-way LPT: seed N shards, then place each route (largest first) into whichever shard it grows the
  // least. Even shards matter because the 64 MiB cap applies per shard -- it is the largest that
  // decides viability -- and the previous best-fit packer produced 77.91 MiB beside 48.01 MiB.
  const shards = Array.from({ length: MAX_SHARDS }, () => ({
    files: new Map(pinnedFiles),
    bytes: pinnedBytes,
    routes: [...pinnedNames].sort(),
  }));

  for (const route of [...packable]
    .filter((route) => !pinnedNames.has(route.route))
    .sort((a, b) => b.bytes - a.bytes)) {
    // What this route would actually add to a shard: only the files that shard does not already have.
    // Routes overlap heavily -- that is why a shard's bundle is smaller than the sum of its routes --
    // so charging a route its full size would spread the routes out for the wrong reason.
    const growthIn = (shard) => {
      let growth = 0;
      for (const [file, size] of route.files) if (!shard.files.has(file)) growth += size;
      return growth;
    };

    let target = shards[0];
    let smallest = Infinity;
    for (const shard of shards) {
      const size = shard.bytes + growthIn(shard);
      if (size < smallest) {
        smallest = size;
        target = shard;
      }
    }

    for (const [file, size] of route.files) {
      if (!target.files.has(file)) {
        target.files.set(file, size);
        target.bytes += size;
      }
    }
    target.routes.push(route.route);
  }

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
  console.log(`cap / shard:      ${budgetMiB} MiB`);
  console.log(`shard cap:        ${MAX_SHARDS}\n`);

  for (const [index, shard] of shards.entries()) {
    const top = [...shard.routes].sort().slice(0, 3).join(", ");
    console.log(
      `  shard-${index + 1}: ${mib(shard.bytes).padStart(8)} MiB  ${String(shard.routes.length).padStart(4)} routes  (${top}${shard.routes.length > 3 ? ", ..." : ""})`
    );
  }

  // Since the cap applies per shard, it is the *largest* shard that decides whether the plan is
  // viable -- one shard over is the whole deploy over.
  const largest = Math.max(...shards.map((shard) => shard.bytes));
  if (largest > budget) {
    console.log(
      `\n::warning::the largest shard is ${mib(largest)} MiB, over the ${budgetMiB} MiB budget -- it cannot fit under the 64 MiB cap. Fewer routes per shard, a smaller shared runtime, or more shards (max ${MAX_SHARDS}) is needed.`
    );
  } else {
    console.log(`\nEvery shard fits: the largest is ${mib(largest)} MiB, under the ${budgetMiB} MiB budget.`);
  }
  console.log("::endgroup::");

  const manifest = {
    generatedAt: new Date().toISOString(),
    budgetBytes: budget,
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
