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
 *   buildRoot defaults to the first of `.open-next/server-functions/default/apps/web/.next`,
 *   `.open-next/server-functions/default/.next`, or `apps/web/.next` that exists.
 */
import fs from "node:fs";
import path from "node:path";

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
  const serverDir = path.join(root, "server");

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

  // Best-fit-decreasing: place each route (largest first) into the shard it grows the least while
  // still fitting the budget, otherwise open a new shard. This keeps shared files from being paid
  // for twice as far as a naive first-fit would.
  const shards = [];
  for (const route of [...routes].sort((a, b) => b.bytes - a.bytes)) {
    let best = null;
    let bestGrowth = Infinity;
    for (const shard of shards) {
      let growth = 0;
      for (const [file, size] of route.files) if (!shard.files.has(file)) growth += size;
      if (shard.bytes + growth <= budget && growth < bestGrowth) {
        best = shard;
        bestGrowth = growth;
      }
    }
    if (best) {
      for (const [file, size] of route.files) {
        if (!best.files.has(file)) {
          best.files.set(file, size);
          best.bytes += size;
        }
      }
      best.routes.push(route.route);
    } else {
      const files = new Map(route.files);
      shards.push({ files, bytes: route.bytes, routes: [route.route] });
    }
  }

  shards.sort((a, b) => b.bytes - a.bytes);
  const mib = (n) => (n / 1048576).toFixed(2);
  const union = new Map();
  for (const route of routes) for (const [file, size] of route.files) union.set(file, size);
  const unionBytes = [...union.values()].reduce((sum, size) => sum + size, 0);

  console.log("::group::Shard feasibility (pre-flight)");
  console.log(`build output:   ${root}`);
  console.log(`routes traced:  ${routes.length}`);
  console.log(`shared floor:   ${mib(baseBytes)} MiB (required by every route)`);
  console.log(`union:          ${mib(unionBytes)} MiB (distinct files across all routes)`);
  console.log(`budget / shard: ${budgetMiB} MiB`);
  console.log(`shards needed:  ${shards.length}\n`);

  for (const [index, shard] of shards.entries()) {
    const top = [...shard.routes].sort().slice(0, 3).join(", ");
    console.log(
      `  shard-${index + 1}: ${mib(shard.bytes).padStart(8)} MiB  ${String(shard.routes.length).padStart(4)} routes  (${top}${shard.routes.length > 3 ? ", ..." : ""})`
    );
  }

  const overBudget = shards.filter((shard) => shard.bytes > 64 * 1024 * 1024);
  if (overBudget.length > 0) {
    console.log(`\n::warning::${overBudget.length} shard(s) still exceed the hard 64 MiB cap.`);
  }
  console.log("::endgroup::");

  const manifest = {
    generatedAt: new Date().toISOString(),
    budgetBytes: budget,
    sharedFloorBytes: baseBytes,
    shards: shards.map((shard, index) => ({
      name: `shard-${index + 1}`,
      bytes: shard.bytes,
      routes: shard.routes.sort(),
    })),
  };
  const manifestPath = path.join(process.cwd(), "server-shards.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifestPath}`);
};

main();
