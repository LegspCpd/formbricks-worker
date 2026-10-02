const UNRECOVERABLE_ERROR_NAME = "UnrecoverableError";

/**
 * Marks a job failure as permanent, so the engine should stop retrying it.
 *
 * This is deliberately a plain `Error` subclass owned by this package rather than a re-export of
 * BullMQ's `UnrecoverableError`. BullMQ detects the sentinel by `instanceof` **or** by
 * `err.name === "UnrecoverableError"` (see `bullmq/dist/cjs/classes/job.js`), so this class keeps the
 * exact "move straight to failed, consume one attempt" semantics — while letting the job *handlers*
 * stay importable on runtimes that cannot load BullMQ (Cloudflare Workers). The name is the contract;
 * changing it would silently turn a permanent failure back into an endlessly retried one.
 */
export class UnrecoverableError extends Error {
  constructor(message = "Unrecoverable job error") {
    super(message);
    this.name = UNRECOVERABLE_ERROR_NAME;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Engine-neutral test for the permanent-failure sentinel, by name so it is stable across realms. */
export const isUnrecoverableError = (error: unknown): boolean =>
  error instanceof UnrecoverableError || (error instanceof Error && error.name === UNRECOVERABLE_ERROR_NAME);
