// Constraint #1 — a horse cannot hold two overlapping lessons — proved against a real race.
//
// The engine validates a booking against the bookings it was HANDED. Two coaches clicking at
// the same moment each pass validation against a world that no longer exists by the time
// either commits. That gap is why the constraint exists, so a test that does not reproduce
// the gap does not test it.
//
// Everything here goes through raw SQL on separate connections. The engine is never called,
// so an insert that fails can only have been rejected by Postgres. That is deliberate: the
// claim being made is about the database, and routing through application code would leave
// it ambiguous which layer said no.
//
// THE THING THIS TEST IS MOST LIKELY TO GET WRONG is passing trivially. If transaction 2's
// insert runs after transaction 1 has already committed, it fails with the same error, the
// same SQLSTATE and the same constraint name — and proves nothing at all, because that is
// just a uniqueness check on settled data. So the overlapping case below does not merely
// assert the failure; it first proves the two transactions were genuinely in flight at once,
// by asking Postgres itself:
//
//   pg_blocking_pids(pid2) contains pid1
//
// which can only be true while transaction 1 is uncommitted and transaction 2 is parked
// waiting on its transaction id. Combined with `settled === false` at that instant, the
// serialized ordering is ruled out rather than assumed.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { connect, truncateAll, assertMarked, acquireSuiteLock } from "./db.js";
import { seedAccounts } from "./seed.js";

// A date with no seeded lessons on it, so these tests never collide with the fixture.
const DATE = "2026-10-06";

let setup, observer, fixture;

before(async () => {
  setup = await connect();
  await acquireSuiteLock(setup);
  await assertMarked(setup);
  await truncateAll(setup);
  // Alder now seeds two trainers sharing one set of horses, so the "two coaches in one barn"
  // race below needs no hand-rolled fixture — it is the account shape the schema describes.
  const { alder } = await seedAccounts(setup);
  const [first, second] = alder.trainers;

  fixture = {
    accountId: alder.accountId,
    trainerId: first.trainerId,
    studentA: first.students[0],
    studentB: first.students[1],
    horseId: alder.horses[0],
    otherHorseId: alder.horses[1],
    lessonTypeId: first.lessonTypes[1],
    second: {
      trainerId: second.trainerId,
      lessonTypeId: second.lessonTypes[1],
      studentId: second.students[0],
    },
  };

  observer = await connect();
});

after(async () => {
  await setup?.end();
  await observer?.end();
});

const insertBooking = (client, { trainerId, studentId, horseId, lessonTypeId }, start, end, status = "pending") =>
  client.query(
    `insert into bookings (trainer_id, student_id, horse_id, lesson_type_id, date, start_time,
                           end_time, status, base_price, price)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 60, 60) returning id`,
    [trainerId, studentId, horseId, lessonTypeId, DATE, start, end, status],
  );

const pidOf = async (client) => (await client.query("select pg_backend_pid() as pid")).rows[0].pid;

/**
 * Block until Postgres reports `waiterPid` waiting on `blockerPid`, or give up.
 * Returning true is the evidence that the two transactions overlapped in time; there is no
 * way for this to be true of a serialized pair.
 */
async function waitUntilBlockedBy(obs, waiterPid, blockerPid, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await obs.query("select pg_blocking_pids($1) as pids", [waiterPid]);
    if (rows[0].pids.map(Number).includes(Number(blockerPid))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** How many slot-holding rows exist for a horse on DATE. */
async function heldRows(client, horseId) {
  const { rows } = await client.query(
    `select count(*)::int n from bookings
      where horse_id = $1 and date = $2 and status in ('pending','confirmed')`,
    [horseId, DATE],
  );
  return rows[0].n;
}

async function clearDate() {
  await setup.query("delete from bookings where date = $1", [DATE]);
}

describe("constraint #1 — horse_not_double_booked, under genuine concurrency", () => {
  test("two simultaneous transactions booking one horse for overlapping times: exactly one commits, the other is rejected BY THE DATABASE", async () => {
    await clearDate();
    const tx1 = await connect();
    const tx2 = await connect();
    try {
      const [pid1, pid2] = [await pidOf(tx1), await pidOf(tx2)];
      assert.notEqual(pid1, pid2, "the two transactions must be on different backends");

      await tx1.query("begin");
      await tx2.query("begin");

      // Both transactions are now open. Neither has written.
      const bothOpen = await observer.query(
        `select count(*)::int n from pg_stat_activity
          where pid = any($1) and state in ('idle in transaction','active')`,
        [[pid1, pid2]],
      );
      assert.equal(bothOpen.rows[0].n, 2, "both backends should be inside a live transaction");

      // Transaction 1 takes the slot, and does NOT commit.
      await insertBooking(tx1, { ...fixture, studentId: fixture.studentA }, "10:00", "11:00");

      // Transaction 2 reaches for an overlapping slot on the same horse and same date.
      // Not awaited: it is expected to park on transaction 1's xid rather than return.
      let settled = false;
      const attempt = insertBooking(
        tx2,
        { ...fixture, studentId: fixture.studentB },
        "10:30",
        "11:30",
      ).then(
        (res) => ((settled = true), { ok: true, res }),
        (err) => ((settled = true), { ok: false, err }),
      );

      // THE ANTI-TRIVIALITY ASSERTION. Postgres reports tx2 waiting on tx1, which is only
      // possible while tx1 is still uncommitted — so these two writes genuinely overlapped.
      const blocked = await waitUntilBlockedBy(observer, pid2, pid1);
      assert.ok(
        blocked,
        "tx2 never blocked on tx1 — the two writes did not overlap, so this test would prove nothing",
      );
      assert.equal(
        settled,
        false,
        "tx2's insert had already returned while tx1 was uncommitted — the writes serialized",
      );

      // Only now does tx1 commit. Releasing the xid lets tx2's parked insert resolve.
      await tx1.query("commit");
      const outcome = await attempt;

      assert.equal(outcome.ok, false, "the second transaction must not have been allowed to insert");
      // 23P01 is exclusion_violation. Only Postgres produces it — no application-level check
      // in this repository can, and the engine was never called.
      assert.equal(outcome.err.code, "23P01", `expected exclusion_violation, got ${outcome.err.code}`);
      assert.equal(
        outcome.err.constraint,
        "horse_not_double_booked",
        "must fail on the horse exclusion constraint specifically, not some other constraint",
      );

      await tx2.query("rollback");

      assert.equal(await heldRows(setup, fixture.horseId), 1, "exactly one booking should survive");
    } finally {
      await tx1.end();
      await tx2.end();
    }
  });

  test("the same race on two DIFFERENT horses lets both commit — the constraint is about the horse, not about concurrent inserts", async () => {
    await clearDate();
    const tx1 = await connect();
    const tx2 = await connect();
    try {
      await tx1.query("begin");
      await tx2.query("begin");
      await insertBooking(tx1, { ...fixture, studentId: fixture.studentA }, "10:00", "11:00");
      // Identical times, different animal. If this blocked or failed, the passing test above
      // would be evidence of over-broad locking rather than of the rule.
      await insertBooking(
        tx2,
        { ...fixture, studentId: fixture.studentB, horseId: fixture.otherHorseId },
        "10:00",
        "11:00",
      );
      await tx1.query("commit");
      await tx2.query("commit");
      assert.equal(await heldRows(setup, fixture.horseId), 1);
      assert.equal(await heldRows(setup, fixture.otherHorseId), 1);
    } finally {
      await tx1.end();
      await tx2.end();
    }
  });

  test("two coaches in one barn race for the same horse — the constraint has no tenant column, so it still rejects", async () => {
    await clearDate();
    const tx1 = await connect();
    const tx2 = await connect();
    try {
      const [pid1, pid2] = [await pidOf(tx1), await pidOf(tx2)];
      await tx1.query("begin");
      await tx2.query("begin");
      await insertBooking(tx1, { ...fixture, studentId: fixture.studentA }, "14:00", "15:00");

      let settled = false;
      const attempt = insertBooking(
        tx2,
        {
          trainerId: fixture.second.trainerId,
          studentId: fixture.second.studentId,
          lessonTypeId: fixture.second.lessonTypeId,
          horseId: fixture.horseId, // the other coach's booking, same animal
        },
        "14:30",
        "15:30",
      ).then(
        (res) => ((settled = true), { ok: true, res }),
        (err) => ((settled = true), { ok: false, err }),
      );

      assert.ok(
        await waitUntilBlockedBy(observer, pid2, pid1),
        "the second coach's insert never contended with the first",
      );
      assert.equal(settled, false);
      await tx1.query("commit");
      const outcome = await attempt;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.err.constraint, "horse_not_double_booked");
      await tx2.query("rollback");
      assert.equal(await heldRows(setup, fixture.horseId), 1);
    } finally {
      await tx1.end();
      await tx2.end();
    }
  });
});

describe("what the constraint must NOT reject", () => {
  test("adjacent lessons both succeed — 10:00-11:00 and 11:00-12:00 do not overlap under '[)' bounds", async () => {
    await clearDate();
    const tx1 = await connect();
    const tx2 = await connect();
    try {
      await tx1.query("begin");
      await tx2.query("begin");
      await insertBooking(tx1, { ...fixture, studentId: fixture.studentA }, "10:00", "11:00");
      // Touching the first lesson's end exactly. Half-open bounds are what make back-to-back
      // scheduling expressible at all; a closed upper bound would reject every adjacent pair.
      await insertBooking(tx2, { ...fixture, studentId: fixture.studentB }, "11:00", "12:00");
      await tx1.query("commit");
      await tx2.query("commit");
      assert.equal(await heldRows(setup, fixture.horseId), 2, "both adjacent lessons should stand");
    } finally {
      await tx1.end();
      await tx2.end();
    }
  });

  test("adjacent lessons still both succeed when inserted in the reverse order", async () => {
    await clearDate();
    await insertBooking(setup, { ...fixture, studentId: fixture.studentB }, "11:00", "12:00");
    await insertBooking(setup, { ...fixture, studentId: fixture.studentA }, "10:00", "11:00");
    assert.equal(await heldRows(setup, fixture.horseId), 2);
  });

  test("a cancelled booking frees its slot — the constraint's WHERE clause only holds pending and confirmed", async () => {
    await clearDate();
    const { rows } = await insertBooking(
      setup,
      { ...fixture, studentId: fixture.studentA },
      "13:00",
      "14:00",
      "confirmed",
    );
    const first = rows[0].id;

    // While it stands, the slot is taken.
    await assert.rejects(
      insertBooking(setup, { ...fixture, studentId: fixture.studentB }, "13:00", "14:00"),
      (err) => err.code === "23P01" && err.constraint === "horse_not_double_booked",
      "an occupied slot must be rejected before the cancellation",
    );

    await setup.query("update bookings set status = 'early_cancel' where id = $1", [first]);

    // Same slot, same horse, now free.
    const { rows: replacement } = await insertBooking(
      setup,
      { ...fixture, studentId: fixture.studentB },
      "13:00",
      "14:00",
      "confirmed",
    );
    assert.ok(replacement[0].id, "the freed slot should be bookable");

    // The cancelled row is still there — cancelling frees the slot without erasing history,
    // which is what keeps the stored receipt answerable a month later.
    const { rows: both } = await setup.query(
      "select status from bookings where horse_id = $1 and date = $2 order by status",
      [fixture.horseId, DATE],
    );
    assert.equal(both.length, 2);
    assert.equal(await heldRows(setup, fixture.horseId), 1, "only the replacement holds the slot");
  });

  test("a late cancel frees the slot too, and reinstating the cancelled lesson is then refused", async () => {
    await clearDate();
    const { rows } = await insertBooking(
      setup,
      { ...fixture, studentId: fixture.studentA },
      "15:00",
      "16:00",
      "confirmed",
    );
    const first = rows[0].id;
    await setup.query("update bookings set status = 'late_cancel' where id = $1", [first]);
    await insertBooking(setup, { ...fixture, studentId: fixture.studentB }, "15:00", "16:00", "confirmed");

    // The slot is now genuinely someone else's: un-cancelling has to fail, or the constraint
    // would be enforced on INSERT only and a plain UPDATE could double-book the horse.
    await assert.rejects(
      setup.query("update bookings set status = 'confirmed' where id = $1", [first]),
      (err) => err.code === "23P01" && err.constraint === "horse_not_double_booked",
      "restoring a cancelled lesson into an occupied slot must be rejected",
    );
  });
});
