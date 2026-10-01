import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

// The middleware runs on the Edge runtime: `middleware.ts` (formerly `proxy.ts`) imports no Prisma, so
// Next.js compiles it for Edge and `@opennextjs/cloudflare` emits a small Edge `handler.mjs` instead of
// the old ~45 MiB Node bundle. That Node bundle needed a `middleware.install` hook to work around
// `@aws-sdk/*` tracing (the packages are in Next's `serverExternalPackages`, so only their `dist-cjs`
// builds were traced, while their `exports` map points the `module` condition at a `dist-es/*` the
// traced copy did not contain -> 44 `Could not resolve` errors). With Edge middleware there is no Node
// middleware to trace, so the hook is gone: keeping it only ran an extra `npm install` that failed with
// `ENOENT ... /node_modules/.bin` -> `Could not install dependencies`.
const config = defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
});

export default config;
