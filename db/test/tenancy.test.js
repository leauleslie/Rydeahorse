// Tenant isolation. The check that stops one coach seeing another coach's students.
//
// Structure: db/test/tenant-queries.js is a registry, and every entry in it gets the full
// battery from isolation-harness.js. Adding a repository read is one line there and no new
// test here.
//
// The suite also tests the harness. Three negative controls below register reads that are
// deliberately broken, and assert the harness REPORTS them. Without those, "18 reads are
// isolated" is a claim resting on assertions nobody has ever seen fail — which is the same
// evidentiary value as no test at all.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { connectDrizzle, truncateAll, assertMarked, acquireSuiteLock } from "./db.js";
import { seedTwoTenants } from "./seed.js";
import { forTenant } from "../repo/index.js";
import { TENANT_READS } from "./tenant-queries.js";
import { checkEntry } from "./isolation-harness.js";
import { horses, students } from "../schema/index.js";

let client, db, ctx;

before(async () => {
  ({ client, db } = await connectDrizzle());
  await acquireSuiteLock(client);
  await assertMarked(client);
  await truncateAll(client);
  const { a, b } = await seedTwoTenants(client);
  ctx = {
    a: { manifest: a, repo: forTenant(db, { accountId: a.accountId, trainerId: a.trainerId }) },
    b: { manifest: b, repo: forTenant(db, { accountId: b.accountId, trainerId: b.trainerId }) },
  };
});

after(async () => {
  await client?.end();
});

describe("the fixture itself", () => {
  test("both tenants exist, fully populated, and are separate", () => {
    for (const t of [ctx.a, ctx.b]) {
      assert.ok(t.manifest.accountId, "account seeded");
      assert.ok(t.manifest.trainerId, "trainer seeded");
      assert.equal(t.manifest.horses.length, 3);
      assert.equal(t.manifest.students.length, 3);
      assert.equal(t.manifest.bookings.length, 3);
    }
    assert.notEqual(ctx.a.manifest.accountId, ctx.b.manifest.accountId);
    assert.notEqual(ctx.a.manifest.trainerId, ctx.b.manifest.trainerId);
  });

  // If the two tenants differed on the values queries filter by, an unscoped query could
  // return "the right rows" by accident and the whole harness would be theatre.
  test("the two tenants collide on every value except ids, so only tenant scoping can separate them", async () => {
    const names = await db
      .select({ name: horses.name, n: sql`count(*)::int` })
      .from(horses)
      .groupBy(horses.name);
    assert.ok(names.length > 0);
    for (const row of names) {
      assert.equal(row.n, 2, `horse name "${row.name}" should exist in BOTH accounts`);
    }
    const studentNames = await db
      .select({ name: students.name, n: sql`count(*)::int` })
      .from(students)
      .groupBy(students.name);
    for (const row of studentNames) {
      assert.equal(row.n, 2, `student name "${row.name}" should exist under BOTH trainers`);
    }
  });
});

describe("every registered repository read is tenant-isolated", () => {
  // One line per read in tenant-queries.js; this loop is the whole harness.
  for (const entry of TENANT_READS) {
    test(entry.name, async () => {
      const violations = await checkEntry(entry, ctx);
      assert.deepEqual(violations, [], `\n  - ${violations.join("\n  - ")}\n`);
    });
  }

  test("the registry covers every read the repository exposes", () => {
    // Forces the registry to keep up with the repository. A read added next month that nobody
    // registers fails HERE, rather than passing silently by never being tested.
    const repo = ctx.a.repo;
    const exposed = [];
    for (const [group, members] of Object.entries(repo)) {
      if (group === "tenant") continue;
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
});

// ---------------------------------------------------------------------------
// Negative controls: prove the harness fails when it should.
// ---------------------------------------------------------------------------
describe("the harness itself detects leaks", () => {
  test("an unscoped list is caught (returns the same rows to both tenants)", async () => {
    const leaky = {
      name: "leaky.horses.listAll",
      owns: "horses",
      id: (r) => r.id,
      run: () => db.select().from(horses), // no account filter at all
    };
    const violations = await checkEntry(leaky, ctx);
    assert.ok(violations.length > 0, "harness must reject an unscoped read");
    assert.ok(
      violations.some((v) => v.includes("belonging to tenant B")),
      `expected a cross-tenant leak to be named, got:\n${violations.join("\n")}`,
    );
    assert.ok(
      violations.some((v) => v.includes("identical row(s) to both tenants")),
      "expected the both-tenants-agree check to fire",
    );
  });

  test("a byId with no tenant clause is caught only by the cross-tenant probe", async () => {
    const leaky = {
      name: "leaky.students.byId",
      owns: "students",
      id: (r) => r.id,
      // Correct-looking: given your own id it returns exactly your row.
      run: (_repo, own) =>
        db.select().from(students).where(sql`${students.id} = ${own.students[0]}`),
      // ...and given someone else's id it returns theirs.
      probe: (_repo, other) =>
        db.select().from(students).where(sql`${students.id} = ${other.students[0]}`),
    };
    const violations = await checkEntry(leaky, ctx);
    assert.ok(
      violations.some((v) => v.includes("while bound to tenant A")),
      `the probe should be the thing that catches this, got:\n${violations.join("\n")}`,
    );
  });

  test("a read returning nothing is reported as vacuous, not as a pass", async () => {
    const empty = {
      name: "empty.students.list",
      owns: "students",
      id: (r) => r.id,
      run: () => db.select().from(students).where(sql`false`),
    };
    const violations = await checkEntry(empty, ctx);
    assert.ok(
      violations.some((v) => v.includes("vacuous")),
      `an empty result must not pass, got:\n${violations.join("\n")}`,
    );
  });
});
