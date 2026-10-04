import { PrismaPg } from "@prisma/adapter-pg";
import { cpus } from "node:os";
import { Client, type PoolConfig } from "pg";
import { logger } from "@formbricks/logger";

interface TParsedPrismaPgConfig {
  adapter: PrismaPg;
  connectionString: string;
}

const PRISMA_ONLY_PARAMS = new Set([
  "connection_limit",
  "pool_timeout",
  "connect_timeout",
  "max_idle_connection_lifetime",
  "max_connection_lifetime",
  "pgbouncer",
  "schema",
  "socket_timeout",
  "sslaccept",
  "statement_cache_size",
]);

// Strictly positive — for params where 0 makes no sense (e.g. connection pool size).
const toPositiveInt = (value: string | null): number | undefined => {
  if (value === null || value.trim() === "") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

// Non-negative — for params where 0 has the documented meaning of "disable /
// unlimited" (e.g. connect_timeout=0 means wait indefinitely, idle lifetime=0
// means never expire). Preserves Prisma 6 semantics for these knobs.
const toNonNegativeInt = (value: string | null): number | undefined => {
  if (value === null || value.trim() === "") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const toMillis = (seconds: number | undefined): number | undefined =>
  seconds === undefined ? undefined : seconds * 1000;

// `navigator.userAgent` is `"Cloudflare-Workers"` on workerd, and `WebSocketPair` exists only there.
const isWorkerdRuntime = (): boolean => {
  const runtime = globalThis as { WebSocketPair?: unknown; navigator?: { userAgent?: string } };
  return (
    runtime.navigator?.userAgent === "Cloudflare-Workers" || typeof runtime.WebSocketPair !== "undefined"
  );
};

// Match Prisma 6's default connection_limit: 2 * num_logical_cpus + 1, min 2.
// pg's own default is a hardcoded 10, which silently halves pool capacity on
// 8+ core hosts. Compute once at module load; cpu count is fixed for the
// process lifetime.
//
// workerd is different: a Worker invocation may hold only **6 simultaneous
// outbound connections** (Cloudflare's hard platform limit; the request is
// queued inside the runtime until a slot frees, with no error of its own). A
// pool of 10 therefore over-subscribes that budget — and because this file pins
// `maxUses` to 1, every query opens a *fresh* connect, so a burst of parallel
// queries (the pipeline's `Promise.all`, or a batch) asks the runtime for more
// than six dials at once. The blocked dials never reach us, the slot they were
// checked out for is never released, and pg-pool fails the next checkout with
// `timeout exceeded when trying to connect`. Keep the workerd pool at or under
// the platform ceiling so the pool can never enter that state; 5 leaves one
// connection of headroom for the non-DB dials a job also makes (the Resend API,
// webhook delivery).
const WORKERD_CONNECTION_LIMIT = 5;

const DEFAULT_CONNECTION_LIMIT = (() => {
  const cpuCount = cpus().length;
  if (isWorkerdRuntime()) {
    return WORKERD_CONNECTION_LIMIT;
  }
  return Math.max(2 * cpuCount + 1, 2);
})();

// pg-pool uses the same knob for the TCP connect timeout and for how long a
// checkout waits for a free client. 5s is tight when the first query has to open
// a cold Postgres connection from an edge runtime; give it more headroom there.
//
// On workerd it is set just above Hyperdrive's own 15s initial-connection
// timeout so the two timers do not race: Hyperdrive then wins the race and
// reports the real cause, instead of the pool reporting a generic checkout
// timeout for a dial Hyperdrive was already about to fail.
const DEFAULT_CONNECTION_TIMEOUT_MILLIS = isWorkerdRuntime() ? 20_000 : 5_000;

// Upper bound on how long a single query may run. This is the only thing that
// recovers a *pool slot* pinned by a query whose socket death is never detected:
// `pg` releases a client when the connection emits `error`/`end`, but a socket
// that a suspended Worker isolate or Hyperdrive tears down silently (no FIN/RST)
// produces neither, so the awaited query never settles and `pool.query`'s release
// callback never runs. Once every slot is held, each further query waits out
// `connectionTimeoutMillis` and fails with `timeout exceeded when trying to
// connect`, which is exactly the failure this whole file exists to avoid.
//
// 30s sits under Hyperdrive's 60s max query duration, so a slow-but-alive query
// is cut off by the pooler first when it is genuinely stuck, not by this timer.
// Only applied on workerd: Node deployments keep Prisma's "no timeout" default
// unless the operator sets `socket_timeout` explicitly.
const WORKERD_QUERY_TIMEOUT_MILLIS = 30_000;

// How many queries a single pooled connection may serve before pg-pool destroys
// it. On workerd this is pinned to 1, and that is the load-bearing value for the
// whole file: the Prisma client is a module-scope singleton, so its `pg.Pool`
// outlives the queue invocation that populated it. A `cloudflare:sockets`
// connection is bound to the I/O context that opened it — importantly *not* the
// request context, which `no_handle_cross_request_promise_resolution` handles —
// so a socket opened in invocation A and reused in invocation B never delivers a
// `ReadyForQuery`: the query hangs until `query_timeout`, the job exceeds its
// wall-time budget, and the batch is redelivered forever. `maxUses: 1` makes a
// connection's whole lifecycle (open → one query → release → destroy) fit inside
// a single invocation, so no connection is ever reused across contexts. The cost
// is one local TCP connect per query, which is exactly what Hyperdrive is built
// for: it keeps the expensive Postgres connections warm on Cloudflare's side.
// Node deployments keep pooling normally (Prisma's default `maxUses` is
// unlimited) because their sockets are not context-bound.
const WORKERD_MAX_USES = 1;

// `setTimeout` returns a Node timer locally but a plain number on workerd, where
// `unref` does not exist, so it is invoked defensively through this helper.
type TimerHandle = ReturnType<typeof setTimeout>;

const unrefTimer = (timer: TimerHandle): void => {
  const unref = (timer as { unref?: () => void }).unref;
  if (unref) {
    unref.call(timer);
  }
};

// The handful of `pg` internals this file reaches into. They are not in
// `@types/pg` because they are private, but they are stable across the 8.x line
// and are the only hooks that let us bound a connect on workerd.
interface PgClientInternals {
  _connect: (callback: (error?: Error) => void) => void;
  _connectionTimeoutMillis?: number;
  connectionTimeoutHandle?: TimerHandle;
}

// pg's built-in connect timeout recovers a stalled connect by calling
// `stream.destroy()`. On workerd `getStream()` hands back `pg-cloudflare`'s
// `CloudflareSocket`, whose `connect()` parks on `await this._cfWriter.ready`
// with no timeout of its own, and whose `destroy()` only sets a flag and calls
// `end()` — while the connect is still pending that is a no-op (or throws on the
// not-yet-created writer), so neither an `error` nor an `end` event ever reaches
// the pool. `pg-pool.newClient` then waits on the connect callback forever: the
// queued query never runs, `query_timeout` never arms (it fires only after a
// client is acquired), and the invocation burns its whole wall-time budget with
// no log — exactly the failure this whole file exists to prevent.
//
// This subclass owns the connect deadline instead. It arms a timer against the
// same `connectionTimeoutMillis` and, on expiry, settles pg's connect callback
// with a real error, which makes `pg-pool` drop the dead client and fail the
// queued query promptly instead of hanging. It clears pg's own timer first so
// the broken `stream.destroy()` path never runs, then destroys the socket
// best-effort. Only wired in on workerd; Node keeps the stock `pg.Client`.
class BoundedConnectClient extends Client {
  connectionTimeoutHandle?: TimerHandle;

  _connect(callback: (error?: Error) => void): void {
    const internals = this as unknown as PgClientInternals;
    const deadline = internals._connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MILLIS;
    let settled = false;
    let timer: TimerHandle | undefined;

    // Single-settle wrapper: whichever fires first — the real connect callback or
    // our deadline — wins, and the other path is a no-op.
    const settle = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      callback(error);
    };

    // `0` means "wait indefinitely" (Prisma's connect_timeout=0 semantics), so
    // only arm a deadline for a positive timeout.
    if (deadline > 0) {
      timer = setTimeout(() => {
        settle(new Error("Connection terminated due to connection timeout"));
        try {
          this.connection.stream.destroy();
        } catch {
          // `pg-cloudflare`'s `destroy()` can throw while the connect is still
          // pending; the connect callback above is what actually frees the slot.
        }
      }, deadline);
      unrefTimer(timer);
    }

    // Run pg's own `_connect` (which starts the socket and arms its internal
    // timer), then take that timer away so its ineffective `destroy()` path
    // cannot fire after ours.
    (Client.prototype as unknown as PgClientInternals)._connect.call(this, settle);
    if (internals.connectionTimeoutHandle) {
      clearTimeout(internals.connectionTimeoutHandle);
      internals.connectionTimeoutHandle = undefined;
    }
  }
}

const getConnectionString = (url: URL): string => {
  const sanitizedUrl = new URL(url.toString());

  PRISMA_ONLY_PARAMS.forEach((param) => {
    sanitizedUrl.searchParams.delete(param);
  });

  return sanitizedUrl.toString();
};

// Translate Prisma's sslaccept param to pg's ssl PoolConfig.
//   accept_invalid_certs → ssl: { rejectUnauthorized: false }
//   strict               → ssl: { rejectUnauthorized: true }   (enables SSL too)
//   absent               → undefined; pg honors sslmode in the URL
//   unknown value        → warn and default to strict (fail closed)
const sslConfigFromSslAccept = (value: string | null): PoolConfig["ssl"] | undefined => {
  if (value === null) return undefined;

  switch (value) {
    case "accept_invalid_certs":
      return { rejectUnauthorized: false };
    case "strict":
      return { rejectUnauthorized: true };
    default:
      logger.warn(
        { sslaccept: value },
        "Unknown sslaccept value in DATABASE_URL; defaulting to strict (rejectUnauthorized: true)"
      );
      return { rejectUnauthorized: true };
  }
};

export const createPrismaPgAdapter = (databaseUrl = process.env.DATABASE_URL): TParsedPrismaPgConfig => {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to create a Prisma PostgreSQL adapter.");
  }

  if (databaseUrl.startsWith("prisma://") || databaseUrl.startsWith("prisma+postgres://")) {
    throw new Error(
      "Prisma Accelerate URLs are not supported by Formbricks' PostgreSQL adapter. Use a direct PostgreSQL DATABASE_URL."
    );
  }

  const parsedUrl = new URL(databaseUrl);
  const schema = parsedUrl.searchParams.get("schema") ?? undefined;
  // connection_limit must be strictly positive; max:0 in pg disables the pool.
  // Fall back to Prisma 6's formula so multi-core hosts keep their previous
  // capacity instead of silently dropping to pg's default of 10.
  const connectionLimit =
    toPositiveInt(parsedUrl.searchParams.get("connection_limit")) ?? DEFAULT_CONNECTION_LIMIT;
  // connect_timeout → pg's TCP-connect timeout. 0 means "wait indefinitely"
  // (Prisma 6 semantics; pg also honors this). pool_timeout (Prisma's
  // "max wait for a pooled connection") has no pg equivalent — warn instead
  // of silently misapplying it to a different knob.
  const connectTimeoutSeconds = toNonNegativeInt(parsedUrl.searchParams.get("connect_timeout"));
  const connectionTimeoutMillis = toMillis(connectTimeoutSeconds) ?? DEFAULT_CONNECTION_TIMEOUT_MILLIS;
  const poolTimeoutRaw = parsedUrl.searchParams.get("pool_timeout");
  if (poolTimeoutRaw !== null && poolTimeoutRaw.trim() !== "") {
    logger.warn(
      { pool_timeout: poolTimeoutRaw },
      "pool_timeout in DATABASE_URL is a Prisma-only param with no pg equivalent; ignoring."
    );
  }
  // 0 = "never expire idle connections" (Prisma 6 semantics).
  const maxIdleConnectionLifetime = toMillis(
    toNonNegativeInt(parsedUrl.searchParams.get("max_idle_connection_lifetime"))
  );
  // 0 = "no max lifetime" (Prisma 6 semantics).
  const maxConnectionLifetime = toNonNegativeInt(parsedUrl.searchParams.get("max_connection_lifetime"));
  // socket_timeout → pg's `query_timeout` (a client-side read timeout). Prisma 6
  // used socket_timeout for the same purpose, so translating it keeps existing
  // connection strings meaningful instead of silently dropping the setting.
  const socketTimeoutSeconds = toNonNegativeInt(parsedUrl.searchParams.get("socket_timeout"));
  const queryTimeoutMillis =
    toMillis(socketTimeoutSeconds) ?? (isWorkerdRuntime() ? WORKERD_QUERY_TIMEOUT_MILLIS : undefined);
  const ssl = sslConfigFromSslAccept(parsedUrl.searchParams.get("sslaccept"));
  const connectionString = getConnectionString(parsedUrl);

  const poolConfig: PoolConfig = {
    connectionString,
    connectionTimeoutMillis,
    idleTimeoutMillis: maxIdleConnectionLifetime ?? 300_000,
    max: connectionLimit,
    ...(isWorkerdRuntime() && { maxUses: WORKERD_MAX_USES, Client: BoundedConnectClient }),
    ...(maxConnectionLifetime !== undefined && { maxLifetimeSeconds: maxConnectionLifetime }),
    ...(queryTimeoutMillis !== undefined && { query_timeout: queryTimeoutMillis }),
    ...(ssl !== undefined && { ssl }),
  };

  return {
    adapter: new PrismaPg(poolConfig, schema ? { schema } : undefined),
    connectionString,
  };
};
