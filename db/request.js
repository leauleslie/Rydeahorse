// The request boundary: one connection, one tenant, one transaction, released whatever happens.
//
// Everything below this file assumes it is handed a connection that is already inside a tenant
// transaction. Nothing below it knows where that connection came from. That is the whole point
// of the split — the repository and the engine should not care whether this process is a
// long-lived server with a pool or a serverless invocation with a single client, and today the
// answer is not settled.
//
// So connections arrive through a PROVIDER: something that can hand out a lease and take it
// back. Two are supplied, and a third is easy to write:
//
//   poolProvider(pool)     checks out of a pg.Pool. The long-lived-server shape.
//   clientProvider(client) hands back one client it does not own. Tests, scripts, and the
//                          serverless shape where the invocation already has a connection.
//
// Why a pool matters here, measured against this project's own database: a warm query costs
// about 33ms, and opening a NEW connection costs about 220ms even when everything is warm —
// TLS and auth, paid before any work happens. A pool pays that once; a connection per request
// pays it every time. That is the difference between a Day view that feels instant and one
// that feels sluggish, and it is why the default is a real pool.
//
// One thing a pool cannot fix: Neon suspends an idle compute, and waking it costs roughly a
// second (measured: 961ms on the first connect of a run, ~220ms after). An idle pool does not
// reliably keep it awake. If that latency matters, keep the compute warm — a periodic
// lightweight query, or Neon's always-on setting — rather than expecting the pool to do it.
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { forTenant, withTenantTransaction } from "./repo/index.js";

const DEFAULTS = {
  // Small on purpose. Neon caps connections, and a scheduling app for one barn does not need
  // depth — it needs the connections it has to be warm.
  max: 10,
  // BOUNDED CHECKOUT. Without this a pool under pressure queues forever and a slow query
  // becomes a hung page with no error to show. Same reasoning as the lock_timeout around the
  // trainer-day advisory lock: in a request path, waiting without limit is not patience, it is
  // an outage that never reports itself.
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  // A runaway query should die rather than hold a connection out of the pool indefinitely.
  // Applied once per new connection, so it costs nothing per request.
  statementTimeoutMs: 15_000,
  // The client-side companion to it, covering the case the server cannot: a socket that died.
  queryTimeoutMs: 30_000,
};

/**
 * A pool with the settings this application actually needs.
 * @param connectionString the POOLED endpoint in production; any Postgres URL works.
 */
export function createPool({ connectionString, ...overrides } = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const pool = new pg.Pool({
    connectionString,
    max: cfg.max,
    connectionTimeoutMillis: cfg.connectionTimeoutMillis,
    idleTimeoutMillis: cfg.idleTimeoutMillis,
    // keepAlive so a dead socket is noticed, and query_timeout so an in-flight query on one
    // REJECTS rather than hanging. A server-side statement_timeout cannot help there — the
    // server is already gone. Learned from a test suite that waited 648 seconds on a connection
    // Neon had terminated.
    keepAlive: true,
    query_timeout: cfg.queryTimeoutMs,
  });

  // NOT optional. node-postgres emits 'error' on connections that fail while idle in the pool —
  // which Neon causes routinely, because it terminates connections when it suspends the
  // compute. An EventEmitter 'error' with no listener throws, and this one is emitted outside
  // any request, so it would take down the process rather than fail a request. The pool
  // discards the broken connection on its own; this listener exists so that discarding it is
  // not fatal.
  pool.on("error", (err) => {
    if (cfg.onIdleError) cfg.onIdleError(err);
  });

  if (cfg.statementTimeoutMs) {
    pool.on("connect", (client) => {
      client.query(`set statement_timeout = ${Number(cfg.statementTimeoutMs)}`).catch(() => {});
    });
  }

  return pool;
}

/** Leases connections from a pg.Pool. The long-lived-server shape. */
export function poolProvider(pool) {
  return {
    async acquire() {
      const client = await pool.connect();
      return {
        client,
        release(err) {
          // Passing the error DESTROYS the connection instead of returning it. A connection
          // whose transaction failed may still be in an aborted state, and handing that to the
          // next request produces "current transaction is aborted" on a query that is fine.
          client.release(err || undefined);
        },
      };
    },
  };
}

/**
 * Hands back a client it does not own — releasing is a no-op and never closes it.
 * For tests, scripts, and any runtime that already has exactly one connection per unit of work.
 */
export function clientProvider(client) {
  return {
    async acquire() {
      return { client, release() {} };
    },
  };
}

/**
 * Run `fn` with a repository bound to one tenant, inside one transaction, on one connection.
 *
 * This is the shape every request handler should use, and the only one under which the RLS
 * policies apply. `fn` receives a repository that can both read and write.
 *
 *   await withRequest(provider, { accountId, trainerId }, async (repo) => {
 *     const lessons = await repo.bookings.listOn(date);
 *     await repo.write.bookings.cancel({ bookingId, now });
 *   });
 *
 * The connection is released in a `finally`, so a throw anywhere — including from `fn` — cannot
 * leak it. That matters more than it sounds: one unreleased connection per failed request
 * drains the pool, and the symptom is not the original error but every later request timing
 * out on checkout, long after the cause has scrolled away.
 */
export async function withRequest(provider, tenant, fn) {
  const lease = await provider.acquire();
  let failure;
  try {
    // drizzle binds to a specific connection, so it is built per request rather than shared.
    // It is a thin wrapper; this costs nothing measurable.
    const db = drizzle(lease.client, { casing: "snake_case" });
    const repo = forTenant(db, { ...tenant, client: lease.client });
    return await withTenantTransaction(lease.client, tenant, () => fn(repo, db));
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    lease.release(failure);
  }
}

/**
 * Convenience for the common server case: build a pool once at startup, then use `run` per
 * request. Kept separate from withRequest so nothing is forced to own a pool.
 */
export function createRuntime(options) {
  const pool = createPool(options);
  const provider = poolProvider(pool);
  return {
    pool,
    run: (tenant, fn) => withRequest(provider, tenant, fn),
    close: () => pool.end(),
  };
}
