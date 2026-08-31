// The isolation suite, run against the PgBouncer-pooled endpoint.
//
// Everything else here connects to Neon's DIRECT host, where one client owns one backend for
// its lifetime. Production does not: `DATABASE_URL` is the `-pooler` host, PgBouncer in
// transaction mode, where the backend is handed to a DIFFERENT client between transactions.
//
// That is precisely the condition the SET LOCAL argument is about, and until now it was only
// ever argued — from Postgres semantics and a demonstration that session GUCs persist — never
// exercised against the thing that actually multiplexes. An argument about pooling that has
// never met a pooler is a hypothesis.
//
// What this suite can and cannot establish, since the distinction matters:
//
//   IT CAN     run the whole isolation battery through PgBouncer and show the answers are the
//              same as on a direct connection, and show that identity never survives a
//              transaction boundary across many interleaved pooled clients.
//   IT CANNOT  prove a specific backend was reused by a specific pair of clients — PgBouncer
//              does not expose that mapping, and pg_backend_pid() through a transaction-mode
//              pooler is not a stable handle. The evidence is statistical: many clients, many
//              transactions, interleaved, and no identity ever crosses. A leak of the kind
//              being ruled out would have to hide from all of them.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { connect, truncateAll, assertMarked, acquireSuiteLock, releaseSuiteLock } from "./db.js";
import { seedAccounts } from "./seed.js";
import { rotateAppPassword, connectAsApp, appUrl } from "./app-role.js";
import { collectIsolationFailures } from "./raw-isolation.js";
import { withTenantTransaction } from "../repo/index.js";
import { students } from "../schema/index.js";

let owner, pooled, pooledDb, password, alder, birch;

before(async () => {
  owner = await connect();
  await acquireSuiteLock(owner);
  await assertMarked(owner);
  await truncateAll(owner);
  ({ alder, birch } = await seedAccounts(owner));

  password = await rotateAppPassword(owner);
  pooled = await connectAsApp(password, { pooled: true });
  pooledDb = drizzle(pooled, { casing: "snake_case" });
});

after(async () => {
  await pooled?.end();
  if (owner) await releaseSuiteLock(owner).catch(() => {});
  await owner?.end();
});

describe("it really is the pooled endpoint", () => {
  test("the host is the -pooler one, and it is a different host from the direct connection", () => {
    const pooledHost = new URL(appUrl(password, { pooled: true })).hostname;
    const directHost = new URL(appUrl(password)).hostname;
    assert.ok(pooledHost.split(".")[0].endsWith("-pooler"), `expected a pooler host, got ${pooledHost}`);
    assert.notEqual(pooledHost, directHost, "the suite must not be quietly testing the direct host");
  });

  test("it is the same database, reached as the non-bypassing app role", async () => {
    const { rows } = await pooled.query("select current_user as who, current_database() as db");
    assert.equal(rows[0].who, "rydeahorse_app");
    const { rows: direct } = await owner.query("select current_database() as db");
    assert.equal(rows[0].db, direct[0].db);
  });
});

describe("the isolation battery, through PgBouncer", () => {
  test("every check that holds on a direct connection holds on the pooled one", async () => {
    const failures = await collectIsolationFailures({
      client: pooled, db: pooledDb, alder, birch, label: "pooled",
    });
    assert.deepEqual(failures, [], `\n  - ${failures.join("\n  - ")}\n`);
  });

  test("a raw query outside a tenant transaction still returns nothing here", async () => {
    const rows = await pooledDb.select().from(students);
    assert.deepEqual(rows, [], "the pooled connection must fail closed exactly like the direct one");
    const { rows: actual } = await owner.query("select count(*)::int n from students");
    assert.equal(actual[0].n, 9);
  });
});

describe("identity does not survive a transaction boundary under the pooler", () => {
  test("across many interleaved pooled clients, no tenant's identity is ever visible to another", async () => {
    // Six concurrent clients through PgBouncer, each doing an identified transaction followed
    // by an unidentified one. With a transaction-mode pooler these interleave across a smaller
    // set of backends, so if identity outlived a transaction, an unidentified read would come
    // back populated — with SOMEONE's rows, not necessarily its own.
    const tenants = [
      { acc: alder, tr: alder.trainers[0] },
      { acc: alder, tr: alder.trainers[1] },
      { acc: birch, tr: birch.trainers[0] },
    ];
    const clients = await Promise.all(
      Array.from({ length: 6 }, () => connectAsApp(password, { pooled: true })),
    );
    try {
      const results = await Promise.all(
        clients.map(async (c, i) => {
          const db = drizzle(c, { casing: "snake_case" });
          const { acc, tr } = tenants[i % tenants.length];

          const identified = await withTenantTransaction(
            c,
            { accountId: acc.accountId, trainerId: tr.trainerId },
            () => db.select().from(students),
          );

          // A separate transaction on the same client, with NO identity — standing in for the
          // next request to be handed this backend.
          await c.query("begin");
          const anonymous = await db.select().from(students);
          const { rows: guc } = await c.query(
            "select coalesce(current_setting('app.trainer_id', true), '') as v",
          );
          await c.query("commit");

          return { i, expected: new Set(tr.students), identified, anonymous, leaked: guc[0].v };
        }),
      );

      for (const r of results) {
        assert.deepEqual(
          new Set(r.identified.map((x) => x.id)),
          r.expected,
          `client ${r.i} did not see exactly its own tenant's roster`,
        );
        assert.deepEqual(
          r.anonymous,
          [],
          `client ${r.i} saw ${r.anonymous.length} rows without an identity — something leaked forward`,
        );
        assert.equal(r.leaked, "", `client ${r.i} inherited a stale app.trainer_id: ${r.leaked}`);
      }
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
    }
  });

  test("a rolled-back tenant transaction leaves nothing behind either", async () => {
    await assert.rejects(
      withTenantTransaction(
        pooled,
        { accountId: alder.accountId, trainerId: alder.trainers[0].trainerId },
        async () => {
          await pooledDb.select().from(students);
          throw new Error("deliberate failure inside the tenant transaction");
        },
      ),
      /deliberate failure/,
    );

    // withTenantTransaction rolls back on error; SET LOCAL is reverted by ROLLBACK just as by
    // COMMIT, so the next transaction on this connection must be anonymous again.
    await pooled.query("begin");
    const after = await pooledDb.select().from(students);
    const { rows } = await pooled.query(
      "select coalesce(current_setting('app.trainer_id', true), '') as v",
    );
    await pooled.query("commit");
    assert.deepEqual(after, [], "a rolled-back transaction must not leave identity behind");
    assert.equal(rows[0].v, "");
  });
});
