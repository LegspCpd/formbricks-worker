import { withSentryConfig } from "@sentry/nextjs";
import createJiti from "jiti";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Single source of truth for image-optimizer hosts (ENG-1678); shared with the runtime
// `isExternalImageSrc` check in lib/image-hosts.ts so remotePatterns and the per-<Image>
// `unoptimized` decision can never drift apart.
import { LOOPBACK_HOSTS, OPTIMIZABLE_IMAGE_HOSTS } from "./lib/optimizable-image-hosts.mjs";

// `apps/web/.env` is a tracked symlink to the repository-root `.env`, which is intentionally kept
// untracked. On a fresh clone (notably Cloudflare Workers Builds) that target does not exist, so the
// symlink dangles and Next's env loader aborts the build with `ENOENT: stat 'apps/web/.env'`.
// Materialize an empty root `.env` when it is missing so the symlink resolves; real configuration
// still comes from the process environment. The repo root is two levels up from this config file.
const repositoryRootEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
if (!existsSync(repositoryRootEnv)) {
  try {
    writeFileSync(repositoryRootEnv, "");
  } catch {
    // Read-only filesystem — leave it to Next to report the original failure if it still occurs.
  }
}

const jiti = createJiti(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
jiti("./lib/env");

const LOOPBACK_WILDCARD_ORIGINS = LOOPBACK_HOSTS.map((host) => `http://${host}:*`);

const getLoopbackOriginVariants = (value) => {
  if (!value) {
    return [];
  }

  try {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK_HOSTS.includes(url.hostname)) {
      return [];
    }

    const portSuffix = url.port ? `:${url.port}` : "";
    const alternateHost = url.hostname === "localhost" ? "127.0.0.1" : "localhost";

    return [
      `${url.protocol}//${url.hostname}${portSuffix}`,
      `${url.protocol}//${alternateHost}${portSuffix}`,
    ];
  } catch {
    return [];
  }
};

const getUniqueValues = (values) => [...new Set(values.filter(Boolean))];

// NOTE: every `process.env.*` read in this file shapes the build output and MUST be listed in the
// `build.env` array of apps/web/turbo.json — the web build's own task config since ENG-1682, not the
// root turbo.json — so Turborepo hashes it into the cache key. Adding a read here without updating
// that file serves stale cached builds — from the local Turbo cache and the CI build-output cache
// alike. Enforced by lib/turbo-build-env.test.ts. Read env vars directly (`process.env.<NAME>` or
// `process.env["<NAME>"]`), not via destructuring, so that guardrail can detect them.

/** @type {import('next').NextConfig} */

const nextConfig = {
  assetPrefix: process.env.ASSET_PREFIX_URL || undefined,
  allowedDevOrigins: process.env.NODE_ENV === "production" ? undefined : LOOPBACK_HOSTS,
  basePath: process.env.BASE_PATH || undefined,
  poweredByHeader: false,
  // Enable source maps only when uploading to Sentry (CI/production); skip for faster local builds
  productionBrowserSourceMaps: !!process.env.SENTRY_AUTH_TOKEN,
  // Heavy server-only libraries stay out of Turbopack's module graph; OpenNext bundles them with
  // esbuild afterwards, which is far cheaper than type-checking/compiling them as part of the app.
  // `googleapis` alone is ~190 MB / 1.8k files and dominated the build.
  //
  // `@aws-sdk/client-s3` and `@aws-sdk/s3-presigned-post` are just as heavy, but they cannot be moved
  // out of the module graph from here: they are part of Next.js' built-in `serverExternalPackages`
  // list, and this option only ever adds entries to it. The way that frustrates the Node.js middleware
  // bundler is handled in `open-next.config.ts` (`middleware.install`). The entries listed here are
  // server-only routes that never reach the middleware.
  //
  // `posthog-node` is deliberately NOT listed even though it is just as heavy. Turbopack externalises
  // it into a hashed `.next/node_modules/posthog-node-<hash>` chunk, and `@opennextjs/cloudflare`
  // rewrites that chunk back to `await import("posthog-node")` so the Node.js middleware bundler can
  // bundle the real package. That bundler resolves with `conditions: ["module"]` and therefore picks
  // `dist/entrypoints/index.node.mjs`, whose relative ESM imports (`../client.mjs`, `../exports.mjs`,
  // `@posthog/core`'s `./featureFlagUtils.mjs`, ...) are then left untransformed: `openNextEdgePlugins`
  // marks every `.mjs` request as external, so the middleware output ends up with relative `.mjs`
  // imports that do not exist next to it, and `wrangler deploy` fails with `Could not resolve`.
  // Letting Turbopack bundle it keeps the ESM graph inside the app's own module ids instead.
  serverExternalPackages: [
    "@authzed/authzed-node",
    "@grpc/grpc-js",
    "@prisma/instrumentation",
    "pino",
    "pino-pretty",
    "pino-opentelemetry-transport",
    "stripe",
    "xlsx",
  ],
  outputFileTracingIncludes: {
    "/api/auth/**/*": ["../../node_modules/jose/**/*"],
    // pino loads transport code in worker threads via dynamic require() — the file tracer
    // only traces static imports and misses these runtime-loaded files.
    // Include the full pino package (worker.js needs transport-stream.js, etc.)
    // and its transport targets with their dependencies.
    "/*": [
      "../../node_modules/pino/**/*",
      "../../node_modules/pino-opentelemetry-transport/**/*",
      "../../node_modules/pino-abstract-transport/**/*",
      "../../node_modules/otlp-logger/**/*",
    ],
  },
  turbopack: {},
  experimental: {
    proxyClientMaxBodySize: "16mb",
    turbopackFileSystemCacheForBuild: true,
    // A Cloudflare Worker script is capped at 64 MiB *uncompressed*, and what is uploaded is the
    // whole OpenNext output. Next writes a `.map` next to every server chunk and each one embeds
    // the full sources of everything that chunk pulled in, so `.next/server` came out at 711 MiB
    // with ~600 MiB of that being source maps. OpenNext copies the tree into `.open-next`, and the
    // maps then sit in the bundle's build directory (and in the file tracer's input) for nothing:
    // a Worker never serves them, and Cloudflare's stack traces use the maps wrangler uploads
    // itself. `serverSourceMaps` covers the webpack server build, `turbopackSourceMaps` the
    // Turbopack one this repo builds with.
    serverSourceMaps: false,
    turbopackSourceMaps: false,
  },
  // Type errors never change the emitted build output, and the `tsc` pass is one of the most
  // expensive phases of a cold build. Cloudflare Workers Builds caps every build at 20 minutes on a
  // 2-vCPU box, so the CF build sets FORMBRICKS_SKIP_TYPECHECK=1 and relies on the dedicated
  // `pnpm typecheck` task instead. Local `pnpm build` still type-checks.
  typescript: { ignoreBuildErrors: process.env.FORMBRICKS_SKIP_TYPECHECK === "1" },
  transpilePackages: ["@formbricks/database", "@formbricks/workflows"],
  images: {
    // Optimize image processing to reduce CPU time and prevent timeouts
    deviceSizes: [640, 750, 828, 1080, 1200, 1920], // Removed 3840 to avoid processing huge images
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384], // Standard sizes for smaller images
    formats: ["image/webp"], // WebP is faster to process and smaller than JPEG/PNG
    minimumCacheTTL: 60, // Cache optimized images for at least 60 seconds
    dangerouslyAllowSVG: true, // Allow SVG images
    // Only universal provider/CDN hosts are optimized (ENG-1678). Same-origin `/storage/...` uploads
    // are relative paths (local images, always optimized) and need no entry; the deployment's own
    // domain is intentionally NOT listed since the same build serves every domain. Arbitrary
    // user-provided external URLs are rendered `unoptimized` (see lib/image-hosts.ts) instead of
    // being allowlisted, so the optimizer never acts as an open proxy.
    remotePatterns: OPTIMIZABLE_IMAGE_HOSTS.map((hostname) => ({
      protocol: LOOPBACK_HOSTS.includes(hostname) ? "http" : "https",
      hostname,
    })),
  },
  async redirects() {
    return [
      {
        source: "/i/:path*",
        destination: "/:path*",
        permanent: false,
      },
      {
        source: "/api/v1/surveys",
        destination: "/api/v1/management/surveys",
        permanent: true,
      },
      {
        source: "/api/v1/responses",
        destination: "/api/v1/management/responses",
        permanent: true,
      },
      {
        source: "/api/v1/me",
        destination: "/api/v1/management/me",
        permanent: true,
      },
      // Redirect old project URLs to new workspace URLs
      {
        source: "/environments/:environmentId/project/:path*",
        destination: "/environments/:environmentId/workspace/:path*",
        permanent: true,
      },
      {
        source: "/organizations/:organizationId/projects/new/:path*",
        destination: "/organizations/:organizationId/workspaces/new/:path*",
        permanent: true,
      },
      {
        source: "/projects/:projectId",
        destination: "/workspaces/:projectId",
        permanent: true,
      },
      // Redirect old workspace-scoped account settings to the account-scoped routes.
      {
        source: "/workspaces/:workspaceId/settings/account",
        destination: "/account/settings/profile",
        permanent: true,
      },
      {
        source: "/workspaces/:workspaceId/settings/account/:path*",
        destination: "/account/settings/:path*",
        permanent: true,
      },
      // Old workspace-scoped org settings need workspaceId -> organizationId resolution, so they go
      // through a server route shim (not a static redirect). Non-permanent: the target is resolved
      // at request time.
      {
        source: "/workspaces/:workspaceId/settings/organization",
        destination: "/legacy-organization-settings/:workspaceId",
        permanent: false,
      },
      {
        source: "/workspaces/:workspaceId/settings/organization/:path*",
        destination: "/legacy-organization-settings/:workspaceId/:path*",
        permanent: false,
      },
    ];
  },
  async headers() {
    const isProduction = process.env.NODE_ENV === "production";
    const scriptSrcUnsafeEval = isProduction ? "" : " 'unsafe-eval'";
    const allowLoopbackSources = !isProduction || process.env.E2E_TESTING === "1";
    const devLoopbackSources = allowLoopbackSources
      ? getUniqueValues([
          ...LOOPBACK_WILDCARD_ORIGINS,
          ...getLoopbackOriginVariants(process.env.WEBAPP_URL),
          ...getLoopbackOriginVariants(process.env.BETTER_AUTH_URL),
          ...getLoopbackOriginVariants(process.env.NEXTAUTH_URL),
          ...getLoopbackOriginVariants(process.env.S3_ENDPOINT_URL),
        ])
      : [];
    const devLoopbackSourceList = devLoopbackSources.length > 0 ? ` ${devLoopbackSources.join(" ")}` : "";

    const cspBase = `default-src 'self'; script-src 'self' 'unsafe-inline'${scriptSrcUnsafeEval} https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' blob: data:${devLoopbackSourceList} https:; font-src 'self' data: https:; connect-src 'self'${devLoopbackSourceList} https: wss:; frame-src 'self' https://app.cal.com https:; media-src 'self' https:; object-src 'self' data: https:; base-uri 'self'; form-action 'self'`;

    return [
      {
        // Apply X-Frame-Options and restricted frame-ancestors to all routes except those starting with /s/ or /c/
        source: "/((?!s/|c/).*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          },
          {
            key: "Content-Security-Policy",
            value: `${cspBase}; frame-ancestors 'self'`,
          },
        ],
      },
      {
        // Allow surveys (/s/*) and contact survey links (/c/*) to be embedded in iframes on any domain
        // Note: These routes need frame-ancestors * to support embedding surveys in customer websites
        source: "/(s|c)/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `${cspBase}; frame-ancestors *`,
          },
        ],
      },
      {
        // matching all API routes
        source: "/api/(v1|v2)/client/:path*",
        headers: [
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,OPTIONS,PATCH,DELETE,POST,PUT" },
          {
            key: "Access-Control-Allow-Headers",
            value:
              "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Cache-Control",
          },
        ],
      },
      {
        // matching all API routes
        source: "/api/capture/:path*",
        headers: [
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,OPTIONS,PATCH,DELETE,POST,PUT" },
          {
            key: "Access-Control-Allow-Headers",
            value:
              "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Cache-Control",
          },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      {
        // Everything under /js EXCEPT the survey locale bundles, which are JSON and get their own rule
        // below. One rule has to win outright: both would otherwise set Content-Type on the same path.
        source: "/js/((?!locales/).*)",
        headers: [
          {
            key: "Cache-Control",
            value:
              "public, max-age=3600, s-maxage=2592000, stale-while-revalidate=3600, stale-if-error=86400",
          },
          {
            key: "Content-Type",
            value: "application/javascript; charset=UTF-8",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
          {
            key: "Vary",
            value: "Accept-Encoding",
          },
        ],
      },
      {
        // Survey locale bundles, fetched on demand by the survey runtime instead of being compiled into
        // the widget. Cached as long as the bundle itself: each request carries a `?v=` content hash of
        // the locale sources, so a translation change lands on a new URL rather than waiting out the CDN.
        source: "/js/locales/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value:
              "public, max-age=3600, s-maxage=2592000, stale-while-revalidate=3600, stale-if-error=86400",
          },
          {
            key: "Content-Type",
            value: "application/json; charset=UTF-8",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
          {
            key: "Vary",
            value: "Accept-Encoding",
          },
        ],
      },
      // Favicon files - long cache since they rarely change
      {
        source: "/favicon/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=2592000, s-maxage=31536000, immutable",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
        ],
      },
      // Root favicon.ico - long cache
      {
        source: "/favicon.ico",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=2592000, s-maxage=31536000, immutable",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
        ],
      },
      // SVG files (icons, logos) - long cache since they're usually static
      {
        source: "/(.*)\\.svg",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=2592000, s-maxage=31536000, immutable",
          },
          {
            key: "Content-Type",
            value: "image/svg+xml",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
        ],
      },
      // Image backgrounds - medium cache (might update more frequently)
      {
        source: "/image-backgrounds/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
          {
            key: "Vary",
            value: "Accept-Encoding",
          },
        ],
      },
      // Video files - long cache since they're large and expensive to transfer
      {
        source: "/video/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=604800, s-maxage=31536000, stale-while-revalidate=604800",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
          {
            key: "Accept-Ranges",
            value: "bytes",
          },
        ],
      },
      // Animated backgrounds (4K videos) - very long cache since they're large and immutable
      {
        source: "/animated-bgs/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=604800, s-maxage=31536000, immutable",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
          {
            key: "Accept-Ranges",
            value: "bytes",
          },
        ],
      },
      // CSV templates - shorter cache since they might update with feature changes
      {
        source: "/sample-csv/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600",
          },
          {
            key: "Content-Type",
            value: "text/csv",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
        ],
      },
      // Web manifest and browser config files - medium cache
      {
        source: "/(site\\.webmanifest|browserconfig\\.xml)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
        ],
      },
      // Optimize caching for other static assets in public folder (fallback)
      {
        source: "/(images|fonts|icons)/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, s-maxage=31536000, immutable",
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
        ],
      },
    ];
  },
  async rewrites() {
    const posthogRewrites = process.env.POSTHOG_KEY
      ? [
          {
            source: "/ingest/static/:path*",
            destination: "https://eu-assets.i.posthog.com/static/:path*",
          },
          {
            source: "/ingest/:path*",
            destination: "https://eu.i.posthog.com/:path*",
          },
        ]
      : [];
    return [
      ...posthogRewrites,
      {
        source: "/api/v2/organizations/:organizationId/project-teams",
        destination: "/api/v2/organizations/:organizationId/workspace-teams",
      },
    ];
  },
  env: {
    NEXTAUTH_URL: process.env.NEXTAUTH_URL, // TODO: Remove this once we have a proper solution for the base path
    // Inlined at build time (Next's `env` config is applied through the bundler's define pass) so that the
    // `await import("./instrumentation-node")` branch in instrumentation.ts folds away to dead code when the
    // deployment target cannot run it. That import is the single most expensive edge of the module graph:
    // `@opentelemetry/auto-instrumentations-node` eagerly references every `@opentelemetry/instrumentation-*`
    // package (~10k files), and the Workers build — which has 8 GB of RAM and 20 minutes for the whole job —
    // can neither run the Node OTel SDK (the Prometheus exporter binds a TCP port) nor afford to compile it.
    // Self-hosted builds keep the default.
    FORMBRICKS_OTEL_ENABLED: process.env.FORMBRICKS_OTEL_ENABLED ?? "1",
  },
};

// set actions allowed origins
if (process.env.WEBAPP_URL) {
  nextConfig.experimental.serverActions = {
    allowedOrigins: [process.env.WEBAPP_URL.replace(/https?:\/\//, "")],
    bodySizeLimit: "2mb",
  };
}

// Build-time release identifier, derived exactly the way the runtime `SENTRY_RELEASE` is
// derived in lib/constants.ts. CI bumps apps/web/package.json to the release version before
// the image build (.github/actions/build-and-push-docker/action.yml), so the release the
// artifacts are uploaded under and the release the events are tagged with always agree.
// It doubles as the "is this an official release build?" signal below: only CI bumps this
// file, so an unbumped 0.0.0 means a local or self-hosted build.
const sentryRelease = (() => {
  try {
    const { version } = require("./package.json");
    return version && version !== "0.0.0" ? `${version}` : undefined;
  } catch {
    return undefined;
  }
})();

const sentryOptions = {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options
  // Production ingests into formbricks/formbricks (EU). "formbricks-cloud" lives in a
  // different org (formbricks-us), so uploads were rejected with "projects are invalid".
  project: "formbricks",
  org: "formbricks",

  // Enable logging to debug sourcemap generation issues
  silent: false,

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Automatically tree-shake Sentry logger statements to reduce bundle size
  disableLogger: false,

  sourcemaps: {
    // The SDK documents this as defaulting to true, but it only applies that default on the
    // same path that turns `productionBrowserSourceMaps` on for you — and line 57 already
    // sets that explicitly, so the SDK bails out first. Without this the generated .map
    // files stay in the image and are served publicly.
    deleteSourcemapsAfterUpload: true,

    // Only an official release build uploads. A local or self-hosted build carries 0.0.0, and
    // its token either has no access to this org (so the upload fails) or does (so a laptop
    // would create a git-SHA release in our production project). "disable-upload" skips the
    // upload while still injecting Debug IDs — `true` would skip those too, which would leave
    // the image unsymbolicatable and defeat the point of the read-secrets.sh change. The
    // string is honoured by the underlying bundler plugin; @sentry/nextjs types the field as
    // boolean, so re-verify this if the SDK is upgraded.
    disable: sentryRelease ? false : "disable-upload",
  },

  release: { name: sentryRelease },

  // The plugin's default is to log an upload failure and leave the build green, which is why
  // a wrong project slug went unnoticed for two years. On a release build, fail instead: an
  // image whose source maps never uploaded produces unreadable production stack traces.
  errorHandler: sentryRelease
    ? (err) => {
        throw err;
      }
    : undefined,
};

// Always enable Sentry plugin to inject Debug IDs
// Runtime Sentry reporting still depends on DSN being set via environment variables
const exportConfig = process.env.SENTRY_AUTH_TOKEN ? withSentryConfig(nextConfig, sentryOptions) : nextConfig;

// Initialize OpenNext for Cloudflare Workers (production build handled by opennextjs-cloudflare)
if (process.env.NODE_ENV !== "production") {
  try {
    const { initOpenNextCloudflareForDev } = await import("@opennextjs/cloudflare");
    initOpenNextCloudflareForDev();
  } catch {
    // @opennextjs/cloudflare not installed in dev without cf config — safe to ignore
  }
}

export default exportConfig;
