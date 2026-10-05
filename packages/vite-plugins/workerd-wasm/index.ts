import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { type Plugin, type ResolvedConfig } from "vite";

/**
 * Prisma 7's query compiler is a WebAssembly module. `workerd` refuses to compile WebAssembly from
 * bytes at runtime (`WebAssembly.Module(bytes)` throws "Wasm code generation disallowed by
 * embedder"), so the only form that runs in a Worker is a build-time `import` — which is what
 * `@prisma/client`'s `wasm-compiler-edge` runtime emits:
 * `await import("./query_compiler_fast_bg.wasm?module")`.
 *
 * Wrangler already knows how to bundle that: its default module rules map every wasm glob (with or
 * without the `?module` query) to `CompiledWasm`, and the Cloudflare adapter's
 * `setWranglerExternal()` esbuild plugin keeps `.wasm`/`.wasm?module` specifiers external so they
 * survive to wrangler. The gap is the intermediate bundlers (this repo's Vite/Rollup builds, and
 * Next/Turbopack) which would otherwise try to parse the binary as JavaScript and fail with
 * "Unexpected character '\0'".
 *
 * This plugin closes that gap: it marks every `.wasm`/`.wasm?module` import external so the
 * specifier is emitted verbatim, then copies the referenced `.wasm` file next to each emitted chunk
 * so the relative specifier still resolves once the bundle is written to disk.
 *
 * The emscripten glue ships as a sibling `.js` of the same name (`query_compiler_fast_bg.js`) and is
 * copied along with it. `@prisma/client` hands the runtime the literal `importName:
 * "./query_compiler_fast_bg.js"` and the runtime imports it *relative to the wasm*, so a bundle that
 * carries the `.wasm` but not its glue resolves the module and then dies with `ERR_MODULE_NOT_FOUND`
 * on the first query. wrangler supplies the compiled module itself and never looks for the glue, which
 * is why Workers tolerate its absence while a plain Node process (the migration runner) does not.
 */
export function workerdWasmPlugin(): Plugin {
  const WASM_SPECIFIER = /\.wasm(?:\?module)?$/;
  const assets = new Map<string, string>();
  let config: ResolvedConfig;

  return {
    name: "formbricks:workerd-wasm",
    apply: "build",
    enforce: "pre",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    resolveId(source, importer) {
      if (!WASM_SPECIFIER.test(source)) {
        return null;
      }

      const cleanSource = source.replace(/\?module$/, "");
      const base = importer ? path.dirname(importer) : config.root;
      const absolutePath = path.isAbsolute(cleanSource) ? cleanSource : path.resolve(base, cleanSource);

      assets.set(absolutePath, path.basename(cleanSource));

      // Keep the original specifier (including `?module`) and declare it external: Rollup then
      // emits the import untouched instead of trying to read the binary.
      return { id: source, external: true };
    },

    generateBundle(_options, bundle) {
      if (assets.size === 0) {
        return;
      }

      const destinationDirs = new Set<string>();

      for (const output of Object.values(bundle)) {
        const code = output.type === "chunk" ? output.code : String(output.source);
        for (const basename of assets.values()) {
          if (code.includes(basename)) {
            destinationDirs.add(path.dirname(path.join(config.build.outDir, output.fileName)));
          }
        }
      }

      for (const destinationDir of destinationDirs) {
        const absoluteDestinationDir = path.resolve(config.root, destinationDir);
        mkdirSync(absoluteDestinationDir, { recursive: true });

        for (const [absolutePath, basename] of assets) {
          copyFileSync(absolutePath, path.join(absoluteDestinationDir, basename));

          // The emscripten glue, copied next to the wasm it pairs with (see the plugin doc). Its
          // emitted name is always the wasm's with a `.js` extension, because that is the literal
          // `importName` Prisma's runtime resolves against the wasm's own location.
          const glueSource = absolutePath.replace(/\.wasm$/, ".js");
          if (existsSync(glueSource)) {
            copyFileSync(glueSource, path.join(absoluteDestinationDir, basename.replace(/\.wasm$/, ".js")));
          }
        }
      }
    },
  };
}
