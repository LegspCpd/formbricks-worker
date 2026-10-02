/**
 * The shard router.
 *
 * The app does not fit in one Worker (the OpenNext server bundle is ~125 MiB against Cloudflare's
 * 64 MiB uncompressed cap), so it is deployed as several shard Workers plus this router. Cloudflare
 * has no built-in multi-Worker split — the OpenNext adapter only ever bundles `default` — so the
 * dispatch is done here: this Worker keeps the deployment's public name, owns the static assets, and
 * forwards every app request to the shard that owns the route.
 *
 * Why a router rather than per-shard routing: a zone route can only match a path prefix, and Next's
 * routes are not prefix-clean (dynamic segments and catch-alls sit under shared prefixes such as
 * `/api/v1/...`). A single Worker that matches the real route table and hands the request to the
 * right shard over a service binding is the only way to keep one public hostname.
 *
 * Assets. Only this Worker and the shard it falls back to own an asset collection, so
 * `/_next/static/...` and the `public/` files are served here by Cloudflare's asset layer before this
 * `fetch` ever runs. The fallback shard owns its own copy because it is the one that runs Next's
 * `/_next/image` optimizer (the route table has no entry for it, so it lands on the fallback), and a
 * shard's `ASSETS` cannot be a service binding back to this Worker: a service binding invokes the
 * target's `fetch` handler, not its asset layer. Keeping the copy local leaves the topology free of
 * binding cycles, so the shards deploy first and this Worker last.
 *
 * Dispatch rules, in order:
 *   1. `shardRoutes` — literal routes before dynamic, catch-alls last, so `/workspaces/x/settings`
 *      lands on the shard that owns it rather than on the shard that owns `/workspaces/[id]`.
 *   2. `shardAliases` — the internal rewrites Next performs, sent to the shard owning the destination
 *      so that shard's own Next server resolves them.
 *   3. A missing file — anything with an extension the asset layer did not have is a genuine 404.
 *      Answering it here stops a missing image from being forwarded to a shard, whose `/_next/image`
 *      handler would look for it again.
 *   4. `fallbackBinding` — Next's redirects, `/_next/image`, the 404 boundary and anything else.
 *      Every shard carries the same Next routing tables, so the fallback shard renders any redirect
 *      or the 404 page.
 *
 * The route table is generated from `server-shards.json` (see `scripts/generate-shard-configs.mjs`);
 * the committed `shard-plan.ts` is an empty placeholder so the app type-checks on a fresh clone.
 */
import { type ShardRoute, fallbackBinding, shardAliases, shardRoutes } from "./shard-plan";

/** A service binding as this Worker uses it — just the `fetch` a `Fetcher` exposes. */
interface ServiceBinding {
  fetch: (input: Request) => Promise<Response>;
}

interface RouterEnv {
  /** One service binding per shard, named `SHARD_1`, `SHARD_2`, ... */
  [binding: string]: unknown;
}

interface CompiledRoute {
  binding: string;
  pattern: RegExp;
}

const compile = (routes: ShardRoute[]): CompiledRoute[] =>
  routes.map((route) => ({ binding: route.binding, pattern: new RegExp(route.source) }));

// Compiled once per isolate, not per request: `shardRoutes` is a few hundred entries and `fetch` runs
// on the hot path.
let compiledRoutes: CompiledRoute[] | null = null;
let compiledAliases: CompiledRoute[] | null = null;

const routesFor = (): CompiledRoute[] => (compiledRoutes ??= compile(shardRoutes));
const aliasesFor = (): CompiledRoute[] => (compiledAliases ??= compile(shardAliases));

const matchBinding = (routes: CompiledRoute[], pathname: string): string | null => {
  for (const route of routes) {
    if (route.pattern.test(pathname)) {
      return route.binding;
    }
  }
  return null;
};

const shardRouter = {
  fetch(request: Request, env: RouterEnv): Promise<Response> {
    const { pathname } = new URL(request.url);

    // A matching static asset never reaches here -- Cloudflare's asset layer answers it before this
    // `fetch` runs -- so this is purely the route dispatch: the app's own routes first, then the
    // shard that owns the rewrite destination, then the fallback (redirects, `/_next/image`, the 404
    // boundary, and anything else).
    const binding =
      matchBinding(routesFor(), pathname) ?? matchBinding(aliasesFor(), pathname) ?? fallbackBinding;
    return forward(binding, request, env);
  },
};

const forward = (binding: string, request: Request, env: RouterEnv): Promise<Response> => {
  const shard = env[binding] as ServiceBinding | undefined;

  if (!shard || typeof shard.fetch !== "function") {
    // A missing binding means the router and the shards are out of sync — it is a deployment bug,
    // not a user error, so it says so instead of returning the 404 a missing route would give.
    return Promise.resolve(
      new Response(`No service binding "${binding}" is configured on the shard router.`, { status: 502 })
    );
  }

  // The request is forwarded untouched: method, headers, body and URL all stay as they arrived, so
  // the shard's Next server sees exactly the request it would have seen as a single Worker.
  return shard.fetch(request);
};

export default shardRouter;
