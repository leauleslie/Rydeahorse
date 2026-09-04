// The request boundary. What matters here is not that a query works — every other suite covers
// that — but that the CONNECTION behaves: released on every path, reused rather than
// re-established, and never carrying one tenant's identity into the next request.
//
// That last one is the reason this file exists. A pool reuses physical connections, so if
// identity outlived a transaction, request N+1 would silently inherit request N's tenant. The
// pooler suite proved SET LOCAL is reverted; this proves the pool does not reintroduce the
// problem at a different layer.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { connect, truncateAll, assertMarked, acquireSuiteLock, releaseSuiteLock } from "./db.js";
import { seedAccounts, SHARED_DATE } from "./seed.js";
import { resolveTestDatabaseUrl } from "./guard.js";
import { createPool, poolProvider, clientProvider, withRequest, createRuntime } from "../request.js";
import { toDate } from "../repo/to-engine.js";

let setup, alder, birch, a1, b1, tenantA1, tenantB1;

before(async () => {
  setup = await connect();
  await acquireSuiteLock(setup);
  await assertMarked(setup);
  await truncateAll(setup);
  ({ alder, birch } = await seedAccounts(setup));
  [a1] = alder.trainers;
  [b1] = birch.trainers;
  tenantA1 = { accountId: alder.accountId, trainerId: a1.trainerId };
  tenantB1 = { accountId: birch.accountId, trainerId: b1.trainerId };
});

after(async () => {
  if (setup) await releaseSuiteLock(setup).catch(() => {});
  await setup?.end();
});

// Every pool here goes through the same guard the rest of the suite uses, so a stray test can
// never point one at production.
const testPool = (overrides) =>
  createPool({ connectionString: resolveTestDatabaseUrl(), ...overrides });

describe("a request gets a working, tenant-scoped repository", () => {
  test("reads and writes both work inside one request", async () => {
    const pool = testPool();
    try {
      const provider = poolProvider(pool);
      const result = await withRequest(provider, tenantA1, async (repo) => {
        const lessons = await repo.bookings.listOn(SHARED_DATE);
        const created = await repo.write.bookings.create({
          studentId: a1.students[0], horseId: alder.horses[1],
          lessonTypeId: a1.lessonTypes[1], date: toDate(SHARED_DATE), start: "11:00",
        });
        return { count: lessons.length, id: created.booking.id };
      });
      assert.equal(result.count, 3, "the coach's own three lessons");
      assert.ok(result.id, "and a write in the same transaction");
    } finally {
      await pool.end();
    }
  });

  test("a request sees only its own tenant, with no WHERE clause of its own", async () => {
    const pool = testPool();
    try {
      const provider = poolProvider(pool);
      const forA = await withRequest(provider, tenantA1, (repo) => repo.students.list());
      const forB = await withRequest(provider, tenantB1, (repo) => repo.students.list());
      assert.deepEqual(new Set(forA.map((s) => s.id)), new Set(a1.students));
      assert.deepEqual(new Set(forB.map((s) => s.id)), new Set(b1.students));
    } finally {
      await pool.end();
    }
  });
});

describe("the connection is released on every path", () => {
  test("after a successful request", async () => {
    const pool = testPool({ max: 1 });
    try {
      await withRequest(poolProvider(pool), tenantA1, (repo) => repo.students.list());
      assert.equal(pool.idleCount, 1, "the connection went back to the pool");
      assert.equal(pool.totalCount, 1);
    } finally {
      await pool.end();
    }
  });

  test("after the handler throws — and the pool is still usable afterwards", async () => {
    // The failure mode being ruled out: one unreleased connection per failed request drains
    // the pool, and the symptom appears much later as checkout timeouts on unrelated requests.
    const pool = testPool({ max: 1, connectionTimeoutMillis: 2000 });
    try {
      const provider = poolProvider(pool);
      await assert.rejects(
        withRequest(provider, tenantA1, async () => {
          throw new Error("handler blew up");
        }),
        /handler blew up/,
      );

      // max is 1, so if the first request had leaked its connection this would time out.
      const rows = await withRequest(provider, tenantA1, (repo) => repo.students.list());
      assert.equal(rows.length, 3, "the pool still works after a failed request");
    } finally {
      await pool.end();
    }
  });

  test("after a write is rejected deep inside the transaction", async () => {
    const pool = testPool({ max: 1, connectionTimeoutMillis: 2000 });
    try {
      const provider = poolProvider(pool);
      await assert.rejects(
        withRequest(provider, tenantA1, (repo) =>
          repo.write.bookings.create({
            studentId: a1.students[0],
            horseId: alder.horses[2], // inactive and on the no-ride list
            lessonTypeId: a1.lessonTypes[1], date: toDate(SHARED_DATE), start: "11:00",
          })),
      );
      // Asserted on the rejected row rather than on a total. An earlier test in this file
      // commits a booking, so a count here would be order-dependent — and a test that only
      // passes when it runs first is worse than no test.
      const rows = await withRequest(provider, tenantA1, (repo) => repo.bookings.listOn(SHARED_DATE));
      assert.ok(rows.length > 0, "the pool still serves requests after a rejected write");
      assert.ok(
        rows.every((b) => b.horseId !== alder.horses[2]),
        "the rejected booking was not written",
      );
    } finally {
      await pool.end();
    }
  });
});

describe("connections are reused, and carry nothing between requests", () => {
  test("many requests share one physical connection", async () => {
    const pool = testPool({ max: 1 });
    try {
      const provider = poolProvider(pool);
      for (let i = 0; i < 5; i++) {
        await withRequest(provider, tenantA1, (repo) => repo.students.list());
      }
      // If this were not reuse, the assertions below about leakage would be testing nothing.
      assert.equal(pool.totalCount, 1, "one connection served all five requests");
    } finally {
      await pool.end();
    }
  });

  test("one tenant's identity never reaches the next request on the same connection", async () => {
    // max: 1 forces every request onto the SAME backend, which is the adversarial case rather
    // than the lucky one.
    const pool = testPool({ max: 1 });
    try {
      const provider = poolProvider(pool);
      const seen = [];
      for (const [tenant, own] of [
        [tenantA1, a1.students], [tenantB1, b1.students],
        [tenantA1, a1.students], [tenantB1, b1.students],
      ]) {
        const rows = await withRequest(provider, tenant, (repo) => repo.students.list());
        assert.deepEqual(new Set(rows.map((s) => s.id)), new Set(own),
          "each request must see exactly its own tenant");
        seen.push(rows.length);
      }
      assert.deepEqual(seen, [3, 3, 3, 3]);
      assert.equal(pool.totalCount, 1, "all four ran on one connection");
    } finally {
      await pool.end();
    }
  });

  test("identity is gone between requests, so an unwrapped query on a pooled connection sees nothing", async () => {
    const pool = testPool({ max: 1 });
    try {
      await withRequest(poolProvider(pool), tenantA1, (repo) => repo.students.list());
      // Straight off the pool, outside any tenant transaction — the state the NEXT request
      // would inherit if SET LOCAL had not been reverted.
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role rydeahorse_app");
        const { rows } = await client.query("select * from students");
        await client.query("commit");
        assert.deepEqual(rows, [], "no identity survived the previous request");
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});

describe("the pool fails fast rather than hanging", () => {
  test("checkout is bounded when the pool is exhausted", async () => {
    // An unbounded pool turns one slow query into a queue of hung requests with no error to
    // show anyone. This asserts the ceiling exists.
    const pool = testPool({ max: 1, connectionTimeoutMillis: 400 });
    try {
      const provider = poolProvider(pool);
      let releaseHeld;
      const held = new Promise((resolve) => { releaseHeld = resolve; });

      const holding = withRequest(provider, tenantA1, async (repo) => {
        await repo.students.list();
        await held; // keep the only connection checked out
      });

      await assert.rejects(
        withRequest(provider, tenantA1, (repo) => repo.students.list()),
        /timeout exceeded when trying to connect/i,
        "the second request must time out, not wait forever",
      );

      releaseHeld();
      await holding;
    } finally {
      await pool.end();
    }
  });
});

describe("the provider abstraction", () => {
  test("clientProvider works and does NOT close the client it was given", async () => {
    // The serverless / script shape: the caller already owns a connection and expects to keep
    // owning it. Closing it here would break the next call in the same invocation.
    const client = await connect();
    try {
      const rows = await withRequest(clientProvider(client), tenantA1, (repo) => repo.students.list());
      assert.equal(rows.length, 3);
      const { rows: alive } = await client.query("select 1 as ok");
      assert.equal(alive[0].ok, 1, "the caller's client is still open");
    } finally {
      await client.end();
    }
  });

  test("createRuntime bundles the pool and closes cleanly", async () => {
    const rt = createRuntime({ connectionString: resolveTestDatabaseUrl(), max: 2 });
    try {
      const rows = await rt.run(tenantA1, (repo) => repo.students.list());
      assert.equal(rows.length, 3);
    } finally {
      await rt.close();
    }
    assert.equal(rt.pool.totalCount, 0, "close() drained the pool");
  });
});
