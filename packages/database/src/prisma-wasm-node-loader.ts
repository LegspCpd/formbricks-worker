/**
 * Prisma 7's `prisma-client` generator, when `runtime = "cloudflare"`, loads its query compiler — a
 * WebAssembly module — through a *bundler-only* import form:
 *
 *   await import("./query_compiler_fast_bg.wasm?module")
 *
 * Turbopack, esbuild and wrangler understand the `?module` query and hand back a `WebAssembly.Module`.
 * Plain Node does not: it treats the whole specifier as a path, fails to find
 * `query_compiler_fast_bg.wasm?module` on disk, and the error surfaces later as a
 * `PrismaClientKnownRequestError` on the first query ("Cannot find module
 * '...query_compiler_fast_bg.js' imported from ...query_compiler_fast_bg.wasm").
 *
 * That would break every Node-side Prisma entry point: the migration runner (which `setup-cloudflare`
 * and the Docker/Kubernetes start-up both spawn), the seeds, the SAML/backfill scripts and the
 * integration tests.
 *
 * This module teaches the Node ESM loader the same `?module` semantics: it intercepts `.wasm`
 * specifiers, compiles the file once and returns the compiled `WebAssembly.Module` as the module's
 * default export — exactly what the generated `getQueryCompilerWasmModule()` expects. It targets the
 * synchronous `module.registerHooks()` API (Node >= 22.15), which runs in the importing thread and so
 * also covers the `await import()` calls Prisma makes later, at query time.
 *
 * Import it for its side effect (or call `registerPrismaWasmNodeLoader()`) at the top of every
 * Node-only Prisma entry point. It is a no-op on runtimes without `process.versions.node` (e.g.
 * workerd) and must never be pulled into a Worker bundle — none of those entry points are.
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const compiledModules = new Map<string, object>();
let registered = false;

// The repo's Node tsconfig only includes the `ES2021` lib, which declares the `WebAssembly` namespace
// as a type but not as a value. Reading the constructor off `globalThis` keeps this file typed without
// pulling in the DOM/WebWorker libs for the whole package.
const getWasmModuleConstructor = (): { new (bytes: Uint8Array): object } =>
  (globalThis as unknown as { WebAssembly: { Module: new (bytes: Uint8Array) => object } }).WebAssembly
    .Module;

// Read `process` off `globalThis` (rather than the ambient binding) so this is a genuine runtime check
// that survives a non-Node embedder, and so TypeScript does not fold it away.
const isNodeRuntime = (): boolean =>
  (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node !== undefined;

export const registerPrismaWasmNodeLoader = (): void => {
  // workerd and other non-Node runtimes load the real `?module` import themselves, so there is nothing
  // to emulate — and no `node:module` to reach for.
  if (!isNodeRuntime()) {
    return;
  }

  if (registered) {
    return;
  }

  if (typeof registerHooks !== "function") {
    throw new Error(
      "Formbricks runs its Node-side Prisma client against a Cloudflare-targeted build, which needs " +
        "Node >= 22.15 (module.registerHooks). Upgrade Node and retry. See .nvmrc for the pinned version."
    );
  }

  registered = true;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.includes(".wasm")) {
        return nextResolve(specifier, context);
      }

      // Keep the `?module` query intact so the `load` hook recognises the request, but turn it into a
      // real URL so Node hands it back to us instead of resolving it as a path.
      return {
        shortCircuit: true,
        url: new URL(specifier, context.parentURL ?? pathToFileURL(`${process.cwd()}/`).href).href,
        format: "module",
      };
    },

    load(url, context, nextLoad) {
      if (!url.includes(".wasm")) {
        return nextLoad(url, context);
      }

      // Read the file behind the `?module` query, compile it once, and expose the compiled module
      // through `globalThis` so the synthetic module source below can reference it.
      const filePath = fileURLToPath(url.split("?")[0]);

      if (!compiledModules.has(filePath)) {
        // Compile once into a reusable module. workerd is the only embedder that forbids this, and this
        // hook never runs there.
        const WasmModule = getWasmModuleConstructor();
        compiledModules.set(filePath, new WasmModule(readFileSync(filePath)));
      }

      const globalKey = `__formbricks_prisma_wasm__${filePath}`;
      (globalThis as unknown as Record<string, unknown>)[globalKey] = compiledModules.get(filePath);

      return {
        shortCircuit: true,
        format: "module",
        source: `export default globalThis[${JSON.stringify(globalKey)}];`,
      };
    },
  });
};

// Register on import so a plain side-effect import is enough at every entry point. The package declares
// `sideEffects: false`, so callers that could have the bare import tree-shaken should keep an explicit
// `registerPrismaWasmNodeLoader()` call instead.
registerPrismaWasmNodeLoader();
