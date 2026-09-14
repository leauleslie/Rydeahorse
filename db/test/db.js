// Connections for the test suites. Every one of them goes through the guard in guard.js.
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTestDatabaseUrl, ProductionDatabaseRefusal } from "./guard.js";

// Same reasoning as drizzle.config.js: .env.local lives at the repo root, one level up, and
// npm scripts here run with db/ as cwd, so dotenv-by-cwd would miss it. loadEnvFile does not
// clobber variables already set in the shell, so a one-off override still wins.
const envLocal = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.local");
if (existsSync(envLocal)) process.loadEnvFile(envLocal);

// Layer 2 of the guard (see guard.js). Only `npm run test:mark` creates this, and only
// against an empty database — which is why production can never carry it.
export const MARKER_TABLE = "_rydeahorse_test_marker";

// Emptiness is judged on these. If any holds a row, the database has content someone cares
// about and is not a scratch branch.
const CORE_TABLES = ["accounts", "trainers", "horses", "students", "bookings"];

// Both database suites TRUNCATE and reseed the whole database, so two of them running at once
// destroy each other's fixtures mid-assertion — and the failures that produces are the
// confusing kind: a duplicate key from a seed, or a row count that was right a millisecond
// ago. `node --test` runs test FILES concurrently by default, so this is the normal case, not
// an exotic one.
//
// The npm script pins --test-concurrency=1, but a flag is a thing someone runs without. This
// lock is the structural version of the same rule: a session-level advisory lock held for the
// life of the suite's setup connection, released automatically when that connection closes
// (including on a crash). A second suite blocks in `before` until the first is done.
const SUITE_LOCK_KEY = "8274611903482";

/**
 * Serialize whole suites against this database. Call once, before truncating, and pair it
 * with releaseSuiteLock.
 *
 * Two details, both learned the hard way:
 *
 * A session-level advisory lock is released when the session ends — but on Neon "the session
 * ends" is not prompt. Closing the socket does not immediately reap the backend, so a lock
 * left to be cleaned up by disconnection can keep the NEXT suite waiting for minutes. Hence
 * releaseSuiteLock, called explicitly before the connection closes. Relying on the implicit
 * release is what turned a 7-second suite into a 4-minute one.
 *
 * And this polls `pg_try_advisory_lock` rather than blocking in `pg_advisory_lock`, so a lock
 * genuinely stuck behind a crashed run fails with a message that says so instead of hanging
 * forever with no output.
 */
export async function acquireSuiteLock(client, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await client.query("select pg_try_advisory_lock($1::bigint) as got", [
      SUITE_LOCK_KEY,
    ]);
    if (rows[0].got) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the suite lock on the test ` +
          `database.\nAnother suite is still running, or a previous run died holding it — an ` +
          `advisory lock is released when its backend exits, which on Neon can lag a closed ` +
          `socket by minutes.\nCheck for stragglers:\n` +
          `  select pid, state, query from pg_stat_activity where datname = current_database();`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Release the suite lock. Call in `after`, BEFORE closing the connection. */
export async function releaseSuiteLock(client) {
  await client.query("select pg_advisory_unlock($1::bigint)", [SUITE_LOCK_KEY]);
}

// Every one of these exists because a suite hung for 648 seconds instead of failing.
//
// Neon terminated a connection that a concurrency test was holding a transaction on, and
// node-postgres left the in-flight query's promise unsettled — so the test waited for the
// runner to give up rather than erroring. The logs read `read ECONNRESET` and `Connection
// terminated unexpectedly` AFTER the test had already been abandoned.
//
// None of this makes a dropped connection less likely. It makes one fail in seconds, with a
// message, instead of looking like a deadlock. `query_timeout` is the load-bearing one: it is
// client-side, so it fires even when the socket is gone and no server-side timeout ever will.
const CLIENT_TIMEOUTS = {
  keepAlive: true,
  connectionTimeoutMillis: 15_000,
  // Client-side. The backstop for a socket that died mid-query.
  query_timeout: 60_000,
  // Server-side. Kills a runaway query rather than letting it hold a lock.
  statement_timeout: 30_000,
  // Generous on purpose: the concurrency suites deliberately hold a transaction open while
  // another one races them. That is seconds, never a minute.
  idle_in_transaction_session_timeout: 60_000,
};

/** Open a raw client against the guarded test database. Refuses before opening a socket. */
export async function connect() {
  const client = new Client({
    connectionString: resolveTestDatabaseUrl(),
    ...CLIENT_TIMEOUTS,
  });
  await client.connect();
  return client;
}

/**
 * Layer 2. Runs after connecting, and every suite calls it before writing anything.
 *
 * This is an ALLOW list: the database must prove it is a test database. The deny list in
 * guard.js can only reject targets it recognises, and in CI — where DATABASE_URL is usually
 * absent — it has nothing to compare against and would pass a pasted production URL.
 */
export async function assertMarked(client) {
  const { rows } = await client.query(
    "select to_regclass($1) is not null as marked",
    [`public.${MARKER_TABLE}`],
  );
  if (!rows[0].marked) {
    const { rows: who } = await client.query(
      "select current_database() db, inet_server_addr()::text addr",
    );
    throw new ProductionDatabaseRefusal(
      `The target database is not marked as a test database.\n` +
        `  connected to: ${who[0].db} (${who[0].addr ?? "unknown host"})\n` +
        `  expected table: public.${MARKER_TABLE}\n\n` +
        "These suites TRUNCATE every table, so they will not run against a database that has\n" +
        "not been explicitly designated. If this really is your test branch, run:\n\n" +
        "  npm run test:mark\n\n" +
        "which marks it — and which itself refuses unless the database is empty. That is what\n" +
        "makes production unmarkable: production has rows.",
    );
  }
}

/** True when every table this project owns is empty. The precondition for marking. */
export async function isEmpty(client) {
  for (const table of CORE_TABLES) {
    const { rows } = await client.query(
      `select exists (select 1 from ${client.escapeIdentifier(table)} limit 1) as any`,
    );
    if (rows[0].any) return false;
  }
  return true;
}

/**
 * Wipe every application table. Discovered from the catalogue rather than listed, so a table
 * added next month is cleaned without anyone remembering to update this file.
 *
 * One TRUNCATE for all of them: CASCADE across separate statements would fight the foreign
 * keys, and a single statement lets Postgres drop them all at once.
 */
export async function truncateAll(client) {
  await assertMarked(client);
  const { rows } = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> $1`,
    [MARKER_TABLE],
  );
  if (!rows.length) return;
  const list = rows.map((r) => client.escapeIdentifier(r.table_name)).join(", ");
  await client.query(`truncate table ${list} restart identity cascade`);
}

/** A drizzle handle over a guarded client, plus the client itself for raw SQL.
 *
 * `casing: "snake_case"` is not optional. The schema files declare `trainerId: uuid()` with no
 * explicit column name, so drizzle derives the column from the property key — and derives it
 * as `"trainerId"` unless told otherwise. drizzle.config.js sets this for the generator; the
 * runtime needs it set again or every query names columns that do not exist. */
export async function connectDrizzle() {
  const client = await connect();
  return { client, db: drizzle(client, { casing: "snake_case" }) };
}
