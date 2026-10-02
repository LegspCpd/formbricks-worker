/**
 * The Worker `env`: bindings of every kind, plus the text and secret bindings configured on the Worker.
 * Only the string members are ever read here; the rest are passed through to the code that knows their
 * shape.
 */
export type WorkerEnv = Record<string, unknown>;

/**
 * Copies this Worker's string bindings onto `process.env`.
 *
 * This is the pattern the Workers documentation gives for code that reads its configuration through
 * `process.env`, which is all of the app's (`lib/env.ts`). It has to run *before* anything that does
 * such a read is imported, for two reasons:
 *
 * - Cloudflare evaluates a Worker's module graph while *validating* an upload, and secrets are not part
 *   of that validation environment, so a module-scope read of a secret fails the deploy with
 *   `code: 10021` before the Worker is ever invoked. Every module in this directory therefore imports
 *   the app's graph lazily, from inside a handler — by which point this has run.
 * - `lib/env.ts` validates the whole schema on import, so a missing variable is a hard throw at that
 *   moment rather than a later, narrower failure.
 *
 * `??=` rather than plain assignment: compatibility dates on or after 2025-04-01 already populate
 * `process.env` (`nodejs_compat_populate_process_env`), and the runtime's value must win. Only strings
 * are copied, so object bindings such as `JOBS_QUEUE` stay out of the environment.
 */
export const applyWorkerEnv = (env: WorkerEnv | undefined): void => {
  if (!env) {
    return;
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      process.env[key] ??= value;
    }
  }
};
