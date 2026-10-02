import { fileURLToPath } from "node:url";
import { type Plugin, defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * A stand-in for the module URL, which workerd does not implement: `import.meta.url` is `undefined`
 * inside a Worker.
 *
 * Prisma's generated client needs it at module scope — `packages/database/generated/prisma/client.ts`
 * starts with `globalThis['__dirname'] = path.dirname(fileURLToPath(import.meta.url))` — and
 * `fileURLToPath` rejects `undefined` with a TypeError. Because that runs while Cloudflare *validates*
 * the upload, the deploy fails with `code: 10021` before the Worker is ever invoked. The generated file
 * cannot be patched (it is rewritten by `prisma generate` on every build), and Vite's `define` does not
 * replace `import.meta.url`, so the substitution has to happen on the emitted chunk.
 *
 * A literal file URL is all that is needed: `__dirname` only exists to locate files on disk, which a
 * Worker never does — the query engine ships as the bundled base64 WASM module.
 */
const WORKERD_MODULE_URL = "file:///formbricks-jobs-worker/index.mjs";

const workerdImportMetaUrl: Plugin = {
  name: "formbricks:workerd-import-meta-url",
  // `renderChunk` rather than `transform`: which module bundling step compiled the Prisma client is an
  // implementation detail, and only the rendered chunk is guaranteed to hold the expression in its
  // final form. Every use of `import.meta.url` is replaced, not just Prisma's — on workerd the value is
  // undefined everywhere, so a constant is strictly better than leaving it as-is.
  renderChunk(code) {
    if (!code.includes("import.meta.url")) {
      return null;
    }

    return {
      code: code.replaceAll("import.meta.url", JSON.stringify(WORKERD_MODULE_URL)),
      map: null,
    };
  },
};

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
  plugins: [workerdImportMetaUrl, tsconfigPaths()],
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