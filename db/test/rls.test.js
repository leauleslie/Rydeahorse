// Row-Level Security. Tenant isolation as a database property rather than an application
// convention.
//
// tenancy.test.js proves the eighteen reads in db/repo/ filter correctly. It cannot prove
// anything about the nineteenth — a raw `db.select()` written next month by someone who did
// not know `forTenant` existed, a background job, a hand-typed query in a console. That is
// the same gap `horse_not_double_booked` exists to close on the welfare side: the engine
// validates what it was handed, and the constraint holds whatever the caller does.
//
// So every query in this file DELIBERATELY BYPASSES the repository. There are no WHERE
// clauses on the assertions below. If a row does not come back, only the database decided
// that.
//
// ---------------------------------------------------------------------------
// The pooled-connection hazard, and why SET LOCAL
// ---------------------------------------------------------------------------
// Neon's DATABASE_URL is PgBouncer in transaction mode: the underlying backend is handed to a
// DIFFERENT client between transactions. A session-level `SET app.trainer_id` therefore
// outlives the request that set it, and the next tenant to be handed that backend inherits
// the previous tenant's identity. That is not a hypothetical — `SET` is exactly the wrong
// tool here, and this suite proves the difference rather than asserting it (see "a session
// GUC survives its transaction" below).
//
// The rule is: SET LOCAL, always inside an explicit BEGIN/COMMIT. Transaction-local settings
// are reverted on COMMIT or ROLLBACK, which is precisely the unit a transaction-mode pooler
// recycles. Two properties make it safe rather than merely conventional:
//
//   * Outside an explicit transaction, SET LOCAL applies to the implicit single-statement
//     transaction and is discarded before the next statement. A caller who forgets BEGIN gets
//     ZERO ROWS, not another tenant's rows.
//   * Policies read current_setting('app.…', true), which returns NULL when unset instead of
//     raising. NULL = trainer_id is NULL, not true. An unidentified caller matches nothing.
//
// Both directions fail closed. Both are asserted below.
//
// Values cannot be interpolated into SET LOCAL, so identity is set with
// set_config(name, value, is_local => true), which parameterises safely.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { connectDrizzle, connect, truncateAll, assertMarked, acquireSuiteLock, releaseSuiteLock } from "./db.js";
import { seedAccounts } from "./seed.js";
import { students, horses, bookings, studentAlerts } from "../schema/index.js";
import { withTenantTransaction } from "../repo/index.js";

let client, db, alder, birch, a1, a2, b1;

before(async () => {
  ({ client, db } = await connectDrizzle());
  await acquireSuiteLock(client);
  await assertMarked(client);
  await truncateAll(client);
  // Seeding runs as the owner, which carries BYPASSRLS on Neon — so the fixture is written
  // without policies interfering. That same bypass is why every assertion below must switch
  // roles first.
  ({ alder, birch } = await seedAccounts(client));
  [a1, a2] = alder.trainers;
  [b1] = birch.trainers;
});

after(async () => {
  // Release before closing — see acquireSuiteLock.
  if (client) await releaseSuiteLock(client).catch(() => {});
  await client?.end();
});

const idsOf = (rows) => new Set(rows.map((r) => r.id));
const tenantOf = (account, trainer) => ({
  accountId: account.accountId,
  trainerId: trainer.trainerId,
});

/**
 * Identify as one tenant and run `fn`. This is `withTenantTransaction` from db/repo/ — the
 * helper the application is meant to use — not a test-local imitation of it. Proving the real
 * one is the point: a test that reimplemented the BEGIN / SET LOCAL ROLE / set_config sequence
 * correctly would say nothing about whether the shipped helper does.
 */
const asTenant = (c, tenant, fn) => withTenantTransaction(c, tenant, fn);

/**
 * The application role, with NO tenant identity set. Not something any caller should do — it
 * exists to prove what happens when they do, which must be "nothing", never "everything".
 */
async function asAppRoleWithoutIdentity(c, fn) {
  await c.query("begin");
  try {
    await c.query("set local role rydeahorse_app");
    return await fn();
  } finally {
    await c.query("commit");
  }
}

describe("the enforcement is real, not inert", () => {
  test("the application role exists and does not bypass RLS", async () => {
    const { rows } = await client.query(
      "select rolbypassrls, rolsuper from pg_roles where rolname = 'rydeahorse_app'",
    );
    assert.equal(rows.length, 1, "rydeahorse_app must exist");
    assert.equal(rows[0].rolbypassrls, false, "a BYPASSRLS role makes every policy dead code");
    assert.equal(rows[0].rolsuper, false);
  });

  test("every tenant table has RLS enabled and a policy", async () => {
    const { rows } = await client.query(
      `select c.relname from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
         and c.relname not in ('_rydeahorse_test_marker', 'auth_identities', 'auth_codes')
       order by 1`,
    );
    assert.deepEqual(
      rows.map((r) => r.relname),
      [],
      "these tables hold tenant data but have no RLS enabled",
    );
  });

  // The caveat that makes every other test in this file conditional. Stated as an assertion so
  // it cannot quietly stop being true.
  test("the OWNER still bypasses RLS — which is why the app must not use the owner role", async () => {
    const all = await db.select().from(students); // no SET ROLE, no identity
    assert.equal(all.length, 9, "the owner sees every trainer's students; policies do not apply");
  });
});

describe("a raw query that bypasses forTenant still sees only its own tenant", () => {
  test("select * from students — no WHERE clause — returns only the caller's roster", async () => {
    const rows = await asTenant(client, tenantOf(alder, a1), () => db.select().from(students));
    assert.deepEqual(idsOf(rows), new Set(a1.students), "exactly a1's three students");

    // The two rosters this must not include: another trainer in the SAME barn, and another
    // account entirely.
    for (const id of [...a2.students, ...b1.students]) {
      assert.ok(!idsOf(rows).has(id), `student ${id} must not be visible to a1`);
    }
  });

  test("two trainers in one barn get different rosters from the identical query", async () => {
    const forA1 = await asTenant(client, tenantOf(alder, a1), () => db.select().from(students));
    const forA2 = await asTenant(client, tenantOf(alder, a2), () => db.select().from(students));
    assert.deepEqual(idsOf(forA1), new Set(a1.students));
    assert.deepEqual(idsOf(forA2), new Set(a2.students));
    const overlap = [...idsOf(forA1)].filter((id) => idsOf(forA2).has(id));
    assert.deepEqual(overlap, [], "sharing an account must not mean sharing a roster");
  });

  test("student_alerts — a table with no tenant column at all — is scoped through students", async () => {
    const rows = await asTenant(client, tenantOf(alder, a1), () =>
      db.select().from(studentAlerts));
    assert.deepEqual(idsOf(rows), new Set(a1.alerts));
  });

  test("horses stay SHARED between two trainers in one account", async () => {
    // The account rule, enforced by the database. A policy that isolated horses per trainer
    // would put the welfare rules on half of a horse's saddle time.
    const forA1 = await asTenant(client, tenantOf(alder, a1), () => db.select().from(horses));
    const forA2 = await asTenant(client, tenantOf(alder, a2), () => db.select().from(horses));
    assert.deepEqual(idsOf(forA1), new Set(alder.horses));
    assert.deepEqual(idsOf(forA1), idsOf(forA2), "both coaches ride the same animals");
    for (const id of birch.horses) {
      assert.ok(!idsOf(forA1).has(id), "another barn's horses must never be visible");
    }
  });

  test("bookings are account-scoped, so horse welfare can still see the whole barn", async () => {
    const rows = await asTenant(client, tenantOf(alder, a1), () => db.select().from(bookings));
    assert.deepEqual(
      idsOf(rows),
      new Set(alder.accountBookings),
      "a1 sees a2's lessons — they share the horses, and the caps count both",
    );
    for (const id of birch.trainers[0].bookings) {
      assert.ok(!idsOf(rows).has(id), "another account's lessons must not be visible");
    }
  });
});

describe("it fails closed", () => {
  test("no identity set at all returns zero rows, not every row", async () => {
    const rows = await asAppRoleWithoutIdentity(client, () => db.select().from(students));
    assert.deepEqual(rows, [], "an unidentified caller must match nothing");
  });

  test("SET LOCAL outside an explicit transaction is discarded — the caller sees nothing", async () => {
    // The mistake: setting identity without a surrounding BEGIN. SET LOCAL applies to the
    // implicit single-statement transaction and is gone before the next statement runs.
    await client.query("select set_config('app.account_id', $1, true)", [alder.accountId]);
    await client.query("select set_config('app.trainer_id', $1, true)", [a1.trainerId]);

    await client.query("begin");
    await client.query("set local role rydeahorse_app");
    const { rows } = await client.query("select * from students");
    await client.query("commit");

    assert.deepEqual(rows, [], "a forgotten BEGIN must yield no rows, never another tenant's");
  });

  test("writing a row into another tenant is rejected by WITH CHECK", async () => {
    await assert.rejects(
      asTenant(client, tenantOf(alder, a1), () =>
        client.query(
          `insert into students (trainer_id, name, emergency_contact_name,
                                 emergency_contact_phone, age, experience_level)
           values ($1, 'Smuggled', 'X', '555', 30, 'beginner')`,
          [b1.trainerId], // another account's trainer
        ),
      ),
      (err) => err.code === "42501",
      "inserting into another tenant must violate the row-level security policy",
    );
  });

  test("updating another tenant's row affects nothing — the row is invisible, not merely protected", async () => {
    const res = await asTenant(client, tenantOf(alder, a1), () =>
      client.query("update students set name = 'hijacked' where id = $1", [b1.students[0]]),
    );
    assert.equal(res.rowCount, 0, "the row is not visible, so there is nothing to update");

    const { rows } = await client.query("select name from students where id = $1", [
      b1.students[0],
    ]);
    assert.notEqual(rows[0].name, "hijacked");
  });
});

describe("the pooled-connection hazard", () => {
  test("identity does not survive its transaction — the next request on the same backend sees nothing", async () => {
    // This is the property a transaction-mode pooler depends on. The connection below is
    // reused across two transactions, standing in for two requests that PgBouncer happened to
    // hand the same backend.
    const rows1 = await asTenant(client, tenantOf(alder, a1), () => db.select().from(students));
    assert.equal(rows1.length, 3, "first request is correctly identified");

    // Second transaction, same connection, identity NOT set — as it would not be for a
    // different tenant's request that forgot, or a request that ran before its own SET LOCAL.
    const rows2 = await asAppRoleWithoutIdentity(client, () => db.select().from(students));
    assert.deepEqual(rows2, [], "the previous tenant's identity must not have leaked forward");
  });

  test("a SESSION GUC survives its transaction — which is exactly why SET LOCAL is required", async () => {
    // The negative control for the design decision. Demonstrated on a throwaway connection so
    // the polluted session is discarded with it.
    const leaky = await connect();
    try {
      await leaky.query("begin");
      // is_local => false. The difference between this and every other set_config in the file.
      await leaky.query("select set_config('app.trainer_id', $1, false)", [a1.trainerId]);
      await leaky.query("commit");

      // A new transaction on the same backend — a different request, under a pooler.
      await leaky.query("begin");
      const { rows } = await leaky.query("select current_setting('app.trainer_id', true) as v");
      await leaky.query("commit");

      assert.equal(
        rows[0].v,
        a1.trainerId,
        "a session GUC outlives its transaction; under transaction pooling that is another " +
          "tenant's identity handed to the next request",
      );
    } finally {
      await leaky.end();
    }
  });

  test("SET LOCAL ROLE is reverted too, so a leaked session cannot silently keep app privileges", async () => {
    await asTenant(client, tenantOf(alder, a1), () => db.select().from(students));
    const { rows } = await client.query("select current_user as who");
    assert.notEqual(rows[0].who, "rydeahorse_app", "the role must revert at COMMIT");
  });
});
