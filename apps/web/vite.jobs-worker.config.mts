import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Builds the dedicated Jobs Worker bundle from `cloudflare/jobs-worker.ts`.
 *
 * This is a standalone, non-Next bundle — like the authzed CLI and env-validator builds — because the
 * job handler graph must ship without the Next.js server runtime, and it has to run on workerd rather
 * than Node. `vite-tsconfig-paths` resolves the app's `@/*` aliases, and `server-only` (a Next.js
 * build-time marker with no runtime meaning in a Worker) is aliased to an empty stub.
 *
 * Output is ESM with node builtins left external; `nodejs_compat` in `wrangler.jobs.jsonc` supplies
 * them at runtime. `wrangler` then bundles and minifies this single file for deploy.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: [
      // Mirror the Workers build's engine alias (next.config.mjs `turbopack.resolveAlias`): the job
      // handlers import `@formbricks/jobs` for `UnrecoverableError` and the child-job enqueue calls,
      // and resolving that to the BullMQ-free `/cf` surface is what keeps `bullmq`/`ioredis` — which
      // cannot run on workerd — out of this bundle. Anchored to the bare specifier so it does not also
      // rewrite the `@formbricks/jobs/cf` replacement itself.
      { find: /^@formbricks\/jobs$/, replacement: "@formbricks/jobs/cf" },
      {
        find: "server-only",
        replacement: fileURLToPath(new URL("./scripts/docker/server-only-empty.ts", import.meta.url)),
      },
    ],
  },
  build: {
    copyPublicDir: false,
    emptyOutDir: true,
    outDir: "dist/jobs-worker",
    // `esnext` rather than `node24`: the target is workerd, whose syntax support tracks the V8 version
    // Cloudflare ships, not the local Node version.
    target: "esnext",
    ssr: "cloudflare/jobs-worker.ts",
    rollupOptions: {
      // `cloudflare:*` are workerd builtins (e.g. `cloudflare:sockets`, reached through `pg` →
      // `pg-cloudflare`); they exist only at runtime inside a Worker, so rollup must not try to
      // resolve them. `node:*` builtins are supplied by the `nodejs_compat` flag.
      external: [/^cloudflare:/, /^node:/],
      output: {
        entryFileNames: "index.mjs",
      },
    },
  },
  ssr: {
    // Bundle the whole app graph; only workerd/node builtins stay external (see above).
    noExternal: true,
  },
});