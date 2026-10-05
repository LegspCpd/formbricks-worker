import { register } from "node:module";

// See `./wasm-module-loader.ts` for why plain Node needs this. The runner and the other `db:*`
// scripts are launched with `--import` pointing at this module, which registers the hooks before any
// application module (and therefore before Prisma loads its query compiler) is evaluated.
register(new URL("./wasm-module-loader.js", import.meta.url));
