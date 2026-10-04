import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

// The middleware runs on the Edge runtime: `middleware.ts` (formerly `proxy.ts`) imports no Prisma, so
// Next.js compiles it for Edge and `@opennextjs/cloudflare` emits a small Edge `handler.mjs` instead of
// the old ~45 MiB Node bundle.
//
// The app itself is deployed to Vercel; this config only shapes the OpenNext build that the jobs
// Worker's build command runs alongside its own bundle.
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
});
