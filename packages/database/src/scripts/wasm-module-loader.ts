import { fileURLToPath } from "node:url";

/**
 * Node module-loader hooks that give Prisma's Cloudflare-runtime query compiler the shape plain Node
 * needs. Registered from the CLI (`--import`), so it is never part of what ships to a bundler.
 *
 * `runtime = "cloudflare"` makes the generated client load its query compiler as
 * `const { default: module } = await import("./query_compiler_fast_bg.wasm?module")`. `?module` is a
 * bundler convention — wrangler and Next answer it with a `WebAssembly.Module` as the default export.
 * Node has no such convention: it loads the `.wasm` itself and exposes the module's *exports*, so
 * `default` is `undefined` and Prisma aborts with "The loaded wasm module was unexpectedly `undefined`
 * or `null` once loaded". This hook supplies the missing shape for the plain-Node entry points (the
 * migration runner and the other `db:*` scripts) without changing what Workers and Next receive.
 */

const WASM_MODULE_QUERY = "?module";

const asWasmModuleUrl = (specifier: string, parentURL: string | undefined): URL | undefined => {
  let url: URL;
  try {
    url = new URL(specifier, parentURL);
  } catch {
    return undefined;
  }

  return url.pathname.endsWith(".wasm") && url.search === WASM_MODULE_QUERY ? url : undefined;
};

export const resolve = async (
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (specifier: string, context: unknown) => Promise<unknown>
): Promise<unknown> => {
  const url = asWasmModuleUrl(specifier, context.parentURL);
  if (url === undefined) {
    return await nextResolve(specifier, context);
  }

  // Answered by `load`; keeping the query in the URL is what lets the two hooks agree on one identity.
  return { url: url.href, format: "module", shortCircuit: true };
};

export const load = async (
  url: string,
  context: unknown,
  nextLoad: (url: string, context: unknown) => Promise<unknown>
): Promise<unknown> => {
  const matched = asWasmModuleUrl(url, undefined);
  if (matched === undefined) {
    return await nextLoad(url, context);
  }

  const wasmFileUrl = new URL(matched.href);
  wasmFileUrl.search = "";

  // Handing back the compiled module reads the bytes at import time; the source is a path, not the
  // binary, so this stays cheap.
  return {
    format: "module",
    shortCircuit: true,
    source: `import { readFileSync } from "node:fs";\nexport default new WebAssembly.Module(readFileSync(${JSON.stringify(
      fileURLToPath(wasmFileUrl)
    )}));\n`,
  };
};
