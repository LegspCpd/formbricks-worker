/// <reference types="vitest" />
import { resolve } from "path";
import dts from "vite-plugin-dts";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  build: {
    // Not minified on purpose. Vitest inlines workspace packages into its SSR transform, which
    // rewrites every identifier that matches an imported binding name — and it does not skip label
    // positions. Minification renames labels to single letters, so a label can land on the local name
    // of an import (`import { z as e }` plus a minified `e: for (...)`), and the rewrite emits
    // `__vite_ssr_import_1__.z: for (...)`, which fails to parse. That surfaces as an unrelated
    // `SyntaxError: Unexpected token ':'` in any consumer test that imports this package. Consumers
    // minify their own bundles, so nothing is lost by leaving this one readable.
    minify: false,
    lib: {
      // Three entry points: the BullMQ-backed default (`.`) and the BullMQ-free Cloudflare surfaces
      // (`./cf` for a Worker, `./http` for a non-Worker process enqueueing onto the same queue). They
      // share chunks, so `cf`/`http` do not re-bundle the schemas they re-export.
      entry: {
        cf: resolve(__dirname, "src/cf.ts"),
        http: resolve(__dirname, "src/http.ts"),
        index: resolve(__dirname, "src/index.ts"),
      },
      // ESM keeps `.js`, CJS gets `.cjs` — matching the paths in the package's `exports` map.
      fileName: (format, entryName) => (format === "cjs" ? `${entryName}.cjs` : `${entryName}.js`),
      formats: ["es", "cjs"],
    },
    rollupOptions: {
      external: ["@formbricks/logger", "bullmq", "ioredis", "zod"],
    },
  },
  test: {
    environment: "node",
    globals: true,
    coverage: {
      exclude: ["src/index.ts"],
      reporter: ["text", "json", "html", "lcov"],
    },
  },
  plugins: [
    ...(process.env.FORMBRICKS_SKIP_DTS !== "1"
      ? [
          dts({
            include: ["src/**/*"],
            exclude: ["src/**/*.test.ts"],
            entryRoot: "src",
            outDir: "dist",
          }),
        ]
      : []),
  ],
});
