import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

// AWS SDK v3 packages expose `module: ./dist-es/*` and `require: ./dist-cjs/*`. The traced
// node_modules copy that OpenNext uses when bundling the Node.js middleware only carries the
// `dist-cjs` files, so esbuild fails with 44 "Could not resolve" errors for `@smithy/*`,
// `@aws-sdk/core`, `@aws-sdk/nested-clients/*`, `@aws/lambda-invoke-store` and `tslib`. Proxy never
// touches object storage, so these packages are kept out of the middleware bundle instead.
export default {
  ...defineCloudflareConfig({
    incrementalCache: r2IncrementalCache,
  }),
  edgeExternals: ["@aws-sdk/*", "@smithy/*", "@aws/lambda-invoke-store", "tslib"],
};
