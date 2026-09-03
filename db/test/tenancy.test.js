// Tenant isolation. The check that stops one coach seeing another coach's students — and,
// equally, the check that stops two coaches in one barn being hidden from each other's use of
// a shared horse.
//
// The schema has TWO scoping rules, not one, and they disagree about what a correct result
// looks like. Trainer-scoped reads must never cross trainers. Account-scoped reads must
// return IDENTICAL rows to two trainers in one account. A harness that only knows how to
// assert disjointness reports the second rule working as designed as a leak.
//
// db/test/tenant-queries.js is the registry; every entry declares which rule it obeys and
// gets the full battery from isolation-harness.js. Adding a read is one line there.
//
// The suite also tests the harness. Five negative controls register reads that are
// deliberately wrong — in both directions — and assert the harness reports them. Without
// those, "every read is isolated" rests on assertions nobody has ever seen fail.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { connectDrizzle, truncateAll, assertMarked, acquireSuiteLock, releaseSuiteLock } from "./db.js";
import { seedAccounts, manifestFor } from "./seed.js";
import { forTenant } from "../repo/index.js";
import { TENANT_READS } from "./tenant-queries.js";
import { checkEntry } from "./isolation-harness.js";
import { horses, students, trainers } from "../schema/index.js";

let client, db, ctx, seeded;

before(async () => {
  ({ client, db } = await connectDrizzle());
  await acquireSuiteLock(client);
  await assertMarked(client);
  await truncateAll(client);

  const { alder, birch } = await seedAccounts(client);
  seeded = { alder, birch };
  const bind = (account, trainer) => ({
    manifest: manifestFor(account, trainer),
    repo: forTenant(db, { accountId: account.accountId, trainerId: trainer.trainerId }),
  });
  ctx = {
    a1: bind(alder, alder.trainers[0]),
    a2: bind(alder, alder.trainers[1]), // same account as a1 — shares its horses
    b1: bind(birch, birch.trainers[0]), // different account entirely
  };
});

after(async () => {
  // Release before closing — see acquireSuiteLock.
  if (client) await releaseSuiteLock(client).catch(() => {});
  await client?.end();
});

describe("the fixture itself", () => {
  test("three trainers across two accounts, with a1 and a2 sharing an account", () => {
    assert.equal(ctx.a1.manifest.accountId, ctx.a2.manifest.accountId, "a1 and a2 share an account");
    assert.notEqual(ctx.a1.manifest.trainerId, ctx.a2.manifest.trainerId);
    assert.notEqual(ctx.a1.manifest.accountId, ctx.b1.manifest.accountId);
    // The shared-horse case only exists if they are literally the same rows.
    assert.deepEqual(
      ctx.a1.manifest.horses,
      ctx.a2.manifest.horses,
      "a1 and a2 must be entitled to the same horses",
    );
    for (const t of [ctx.a1, ctx.a2, ctx.b1]) {
      assert.equal(t.manifest.students.length, 3);
      assert.equal(t.manifest.bookings.length, 3);
    }
    assert.equal(ctx.a1.manifest.accountBookings.length, 6, "the account's own trainers' lessons");
  });

  test("the tenants collide on every value except ids, so only scoping can separate them", async () => {
    for (const [table, col] of [[horses, horses.name], [students, students.name]]) {
      const rows = await db.select({ name: col, n: sql`count(*)::int` }).from(table).groupBy(col);
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.ok(row.n >= 2, `"${row.name}" should exist for more than one tenant`);
      }
    }
  });
});

describe("every registered repository read obeys its scoping rule", () => {
  // One line per read in tenant-queries.js; this loop is the whole harness.
  for (const entry of TENANT_READS) {
    test(`[${entry.scope}] ${entry.name}`, async () => {
      const violations = await checkEntry(entry, ctx);
      assert.deepEqual(violations, [], `\n  - ${violations.join("\n  - ")}\n`);
    });
  }

  test("the registry covers every read the repository exposes", () => {
    // A read added next month that nobody registers fails HERE, rather than passing silently
    // by never being tested.
    const exposed = [];
    for (const [group, members] of Object.entries(ctx.a1.repo)) {
      if (group === "tenant") continue;
      // `engineInputsFor` is a top-level function, not a group of reads. It composes the reads
      // below it and returns engine-shaped objects rather than rows, so the row-identity checks
      // this harness performs do not apply to it — db/test/engine-inputs.test.js covers it.
      if (typeof members === "function") continue;
      for (const [name, fn] of Object.entries(members)) {
        if (typeof fn === "function") exposed.push(`${group}.${name}`);
      }
    }
    const registered = new Set(TENANT_READS.map((e) => e.name));
    const missing = exposed.filter((n) => !registered.has(n));
    assert.deepEqual(
      missing,
      [],
      `these repository reads are not in TENANT_READS — add one line each to db/test/tenant-queries.js:\n  ${missing.join("\n  ")}`,
    );
  });

  test("both rules are actually exercised — neither scope is empty", () => {
    const byScope = (s) => TENANT_READS.filter((e) => e.scope === s);
    assert.ok(byScope("trainer").length > 0, "no trainer-scoped reads registered");
    assert.ok(byScope("account").length > 0, "no account-scoped reads registered");
  });
});

// ---------------------------------------------------------------------------
// Negative controls: prove the harness fails when it should, for BOTH rules.
// ---------------------------------------------------------------------------
describe("the harness itself detects violations", () => {
  const control = (name, scope, owns, run, opts = {}) => ({
    name, scope, owns, run, id: opts.id ?? ((r) => r.id), probe: opts.probe,
  });

  test("an unscoped list leaks across accounts", async () => {
    const violations = await checkEntry(
      control("leaky.horses.listAll", "account", "horses", () => db.select().from(horses)),
      ctx,
    );
    assert.ok(
      violations.some((v) => v.includes("owned by another account")),
      `expected a cross-account leak, got:\n${violations.join("\n")}`,
    );
  });

  // The trainer rule's same-account direction — untestable before this fixture existed.
  test("a trainer-scoped table scoped by ACCOUNT leaks between trainers in one barn", async () => {
    const leaky = control("leaky.students.byAccount", "trainer", "students", (_r, own) =>
      db.select().from(students).where(
        inArray(
          students.trainerId,
          db.select({ id: trainers.id }).from(trainers).where(eq(trainers.accountId, own.accountId)),
        ),
      ),
    );
    const violations = await checkEntry(leaky, ctx);
    assert.ok(
      violations.some((v) => v.includes("two trainers in ONE account")),
      `expected the same-account bleed to be caught, got:\n${violations.join("\n")}`,
    );
  });

  // The account rule's direction — the bug the old harness would have *demanded*.
  test("an account-scoped read that hides one trainer's horses from the other is caught", async () => {
    const overScoped = control("overscoped.horses", "account", "horses", async (_r, own) => {
      const all = await db.select().from(horses).where(eq(horses.accountId, own.accountId));
      // Pretend horses were partitioned per trainer. Every other check still passes: the rows
      // are real, owned, non-empty and never cross accounts. Only the sharing rule catches it.
      return own.trainerId === ctx.a1.manifest.trainerId ? all.slice(0, 2) : all.slice(1);
    });
    const violations = await checkEntry(overScoped, ctx);
    assert.ok(
      violations.some((v) => v.includes("NOT SHARED")),
      `expected the sharing rule to fire, got:\n${violations.join("\n")}`,
    );
  });

  test("a byId with no tenant clause is caught only by the cross-tenant probes", async () => {
    const leaky = control(
      "leaky.students.byId",
      "trainer",
      "students",
      // Correct-looking: given your own id it returns exactly your row.
      (_r, own) => db.select().from(students).where(eq(students.id, own.students[0])),
      { probe: (_r, other) => db.select().from(students).where(eq(students.id, other.students[0])) },
    );
    const violations = await checkEntry(leaky, ctx);
    assert.ok(
      violations.some((v) => v.includes("another account")),
      "probe should catch the cross-account fetch",
    );
    assert.ok(
      violations.some((v) => v.includes("another trainer in the SAME account")),
      `probe should catch the same-account fetch, got:\n${violations.join("\n")}`,
    );
  });

  test("a read returning nothing is reported as vacuous, not as a pass", async () => {
    const violations = await checkEntry(
      control("empty.students.list", "trainer", "students", () =>
        db.select().from(students).where(sql`false`)),
      ctx,
    );
    assert.ok(
      violations.some((v) => v.includes("vacuous")),
      `an empty result must not pass, got:\n${violations.join("\n")}`,
    );
  });
});
