import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

const config = defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
});

export default {
  ...config,
  middleware: {
    ...config.middleware,
    // `proxy.ts` reads a session through Prisma, so Next.js compiles it for the Node runtime, and
    // `@opennextjs/cloudflare` re-bundles that output with `conditions: ["module"]` and
    // `mainFields: ["module", "main"]` (see `bundle-node-middleware.js`).
    //
    // `@aws-sdk/client-s3` and `@aws-sdk/s3-presigned-post` belong to Next.js' built-in
    // `serverExternalPackages` list, so they are never bundled and Next only traces the files Node
    // itself would `require` - the `dist-cjs` builds. The AWS SDK v3 packages point the `module`
    // condition at `dist-es/*` through their `exports` map, a directory the traced copy of
    // `middleware/node_modules` does not contain, which fails the build with 44 `Could not resolve`
    // errors (`@smithy/core`, `@aws-sdk/core`, `@aws-crypto/*`, `@aws/lambda-invoke-store`, `tslib`).
    //
    // `outputFileTracingIncludes` cannot fix this: with Turbopack Next.js reports
    // `buildTraceContext: undefined`, so the include/exclude pass - which is driven by
    // `chunksTrace.entryNameFilesMap` - never runs. Installing the packages into the middleware
    // output instead does work: this hook runs before the middleware bundler is invoked (see the
    // order in `@opennextjs/cloudflare/dist/cli/build/build.js`), and the copies npm installs
    // contain `dist-es` next to `dist-cjs`. Pinned to the versions the workspace resolves so the
    // build stays reproducible.
    install: {
      packages: [
        "@aws-sdk/client-s3@3.1007.0",
        "@aws-sdk/s3-request-presigner@3.1007.0",
        "@aws-sdk/s3-presigned-post@3.1007.0",
      ],
      // These are pure JS packages with no install scripts; skipping them keeps the extra install step
      // as short and as unlikely to fail as possible.
      additionalArgs: "--ignore-scripts --no-audit --no-fund",
    },
  },
};
