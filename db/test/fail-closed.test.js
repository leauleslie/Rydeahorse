// The opt-in gap, closed.
//
// 0002 put the policies in place, but they only bound callers who deliberately switched into
// the application role. A connection that just queried as the connecting role saw everything —
// so RLS protected the code that already knew about RLS, which is the code least in need of
// protection. The developer who has never heard of `withTenantTransaction` is the threat, and
// they were the one person it did not stop.
//
// 0003 closes it by credential separation rather than by policy: the application connects as
// `rydeahorse_app`, which owns nothing and has no BYPASSRLS. A query on that connection is
// subject to policy whether or not its author knew that.
//
// What this can and cannot do, stated once, plainly, because a security test that overstates
// its reach is worse than none:
//
//   IT CAN    make the application's own credentials incapable of seeing another tenant, so a
//             forgotten tenant transaction returns nothing instead of everything.
//   IT CANNOT stop someone holding the OWNER credentials. On Neon `neondb_owner` carries
//             BYPASSRLS, FORCE ROW LEVEL SECURITY does not override that, and the attribute
//             cannot be dropped without superuser. Both facts are asserted below so they
//             cannot quietly change.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { connect, truncateAll, assertMarked, acquireSuiteLock, releaseSuiteLock } from "./db.js";
import { seedAccounts } from "./seed.js";
import { rotateAppPassword, connectAsApp, APP_ROLE } from "./app-role.js";
import { collectIsolationFailures } from "./raw-isolation.js";
import { withTenantTransaction } from "../repo/index.js";
import { students, horses } from "../schema/index.js";

let owner, ownerDb, app, appDb, alder, birch;

before(async () => {
  owner = await connect();
  await acquireSuiteLock(owner);
  await assertMarked(owner);
  await truncateAll(owner);
  ownerDb = drizzle(owner, { casing: "snake_case" });

  // Seeding writes two accounts across one connection, which is a cross-tenant write. It works
  // only because the owner bypasses RLS — see the pinning test below.
  ({ alder, birch } = await seedAccounts(owner));

  const password = await rotateAppPassword(owner);
  app = await connectAsApp(password);
  appDb = drizzle(app, { casing: "snake_case" });
});

after(async () => {
  await app?.end();
  if (owner) await releaseSuiteLock(owner).catch(() => {});
  await owner?.end();
});

describe("the application connection cannot bypass anything", () => {
  test("it is the app role — not the owner, no BYPASSRLS, owns no tables", async () => {
    const { rows } = await app.query(`
      select current_user as who,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypass,
             (select count(*)::int from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relowner = current_user::regrole) as owns`);
    assert.equal(rows[0].who, APP_ROLE);
    assert.equal(rows[0].bypass, false, "a BYPASSRLS app role makes every policy dead code");
    assert.equal(rows[0].owns, 0, "owning a table would restore the exemption FORCE removes");
  });

  test("every tenant table is FORCED, not merely enabled", async () => {
    const { rows } = await owner.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relrowsecurity and not c.relforcerowsecurity
        order by 1`,
    );
    assert.deepEqual(rows.map((r) => r.relname), [], "these have RLS enabled but not forced");
  });
});

// ---------------------------------------------------------------------------
// THE TEST. A raw query, outside any tenant transaction, on the app's own connection.
// ---------------------------------------------------------------------------
describe("a raw query outside withTenantTransaction returns NOTHING", () => {
  test("select * from students — no tenant transaction, no WHERE clause — returns zero rows", async () => {
    // Exactly what a developer who has never heard of forTenant would write.
    const rows = await appDb.select().from(students);
    assert.deepEqual(rows, [], "it must return no rows, not every tenant's rows");

    // And the rows genuinely exist — otherwise this passes for the wrong reason.
    const { rows: actual } = await owner.query("select count(*)::int n from students");
    assert.equal(actual[0].n, 9, "nine students exist; the app connection simply cannot see them");
  });

  test("the same is true of every other tenant table", async () => {
    for (const [name, table] of [["students", students], ["horses", horses]]) {
      const rows = await appDb.select().from(table);
      assert.deepEqual(rows, [], `raw select on ${name} must return nothing`);
    }
    for (const name of ["bookings", "student_alerts", "offers", "lesson_types", "trainers"]) {
      const { rows } = await app.query(`select * from ${name}`);
      assert.deepEqual(rows, [], `raw select on ${name} must return nothing`);
    }
  });

  test("a raw INSERT outside a tenant transaction is refused too", async () => {
    await assert.rejects(
      app.query(
        `insert into students (trainer_id, name, emergency_contact_name,
                               emergency_contact_phone, age, experience_level)
         values ($1, 'Ghost', 'X', '555', 30, 'beginner')`,
        [alder.trainers[0].trainerId],
      ),
      (err) => err.code === "42501",
      "writing without an identity must violate the policy, not silently succeed",
    );
  });

  test("the SAME connection returns the right rows once inside a tenant transaction", async () => {
    // The fix must not be "nothing works" — it must be "nothing works until you say who you
    // are". Same connection, same query, one wrapper.
    const rows = await withTenantTransaction(
      app,
      { accountId: alder.accountId, trainerId: alder.trainers[0].trainerId },
      () => appDb.select().from(students),
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(
      new Set(rows.map((r) => r.id)),
      new Set(alder.trainers[0].students),
    );
  });

  test("full isolation still holds over the app connection", async () => {
    const failures = await collectIsolationFailures({
      client: app, db: appDb, alder, birch, label: "direct/app-role",
    });
    assert.deepEqual(failures, [], `\n  - ${failures.join("\n  - ")}\n`);
  });
});

describe("the limits of this, pinned so they cannot drift", () => {
  test("the OWNER still bypasses RLS — FORCE does not override BYPASSRLS", async () => {
    // Verified directly rather than assumed: this is why the fix is credential separation and
    // not FORCE. If Neon ever stops granting BYPASSRLS to neondb_owner, this test fails and
    // the comment above it needs rewriting.
    const rows = await ownerDb.select().from(students);
    assert.equal(rows.length, 9, "the owner sees every tenant, FORCE notwithstanding");

    const { rows: attr } = await owner.query(
      "select rolbypassrls from pg_roles where rolname = current_user",
    );
    assert.equal(attr[0].rolbypassrls, true);
  });

  test("the owner cannot drop its own BYPASSRLS, so this cannot be fixed in-database", async () => {
    // ALTER ROLE is transactional, so this probes the permission without changing anything.
    await owner.query("begin");
    await assert.rejects(
      owner.query("alter role neondb_owner nobypassrls"),
      (err) => err.code === "42501",
      "if this ever succeeds, the owner exemption can be closed and 0003 should be revisited",
    );
    await owner.query("rollback");
  });

  test("seeding REQUIRES the owner — the app role cannot write across tenants", async () => {
    // Pins the requirement that was previously incidental. If anyone moves seeding onto the
    // app role, it fails here rather than halfway through a fixture.
    await assert.rejects(
      withTenantTransaction(
        app,
        { accountId: alder.accountId, trainerId: alder.trainers[0].trainerId },
        () =>
          app.query(
            `insert into students (trainer_id, name, emergency_contact_name,
                                   emergency_contact_phone, age, experience_level)
             values ($1, 'Cross tenant', 'X', '555', 30, 'beginner')`,
            [birch.trainers[0].trainerId],
          ),
      ),
      (err) => err.code === "42501",
      "a cross-tenant write must fail under the app role; seeds therefore run as owner",
    );
  });
});
