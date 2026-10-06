// The write side. Everything here goes through `repo.write`, inside `withTenantTransaction`.
//
// Three properties are worth more than the rest, and each has a test that fails loudly if it
// stops holding:
//
//   The engine decides, the repository persists.  A write never re-derives a rule. If a booking
//   is refused, it is refused with the engine's own eight checks attached.
//
//   The receipt is stamped, not recomputed.       A lesson priced in March must still read as
//   March's price in September, even after the lesson type's base price changes.
//
//   Concurrency is handled at the layer that can  The horse half is the exclusion constraint;
//   actually handle it.                           the trainer half is an advisory lock around
//                                                 the engine's check. Both are raced here.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { connectDrizzle, connect, truncateAll, assertMarked, acquireSuiteLock, releaseSuiteLock } from "./db.js";
import { seedAccounts, SHARED_DATE } from "./seed.js";
import { forTenant, withTenantTransaction } from "../repo/index.js";
import { BookingRejected, SlotTaken } from "../repo/writes.js";
import { toDate } from "../repo/to-engine.js";

let client, db, alder, birch, a1, a2, repo, tenantA1;
const DATE = toDate(SHARED_DATE); // Tuesday 15 Sep 2026
const FREE = "11:00"; // free for horse and trainer alike in the fixture

before(async () => {
  ({ client, db } = await connectDrizzle());
  await acquireSuiteLock(client);
  await assertMarked(client);
});

after(async () => {
  if (client) await releaseSuiteLock(client).catch(() => {});
  await client?.end();
});

// Each test starts from the same fixture: writes mutate, so sharing one seed across them would
// make the suite order-dependent in exactly the way that hides bugs.
beforeEach(async () => {
  await truncateAll(client);
  ({ alder, birch } = await seedAccounts(client));
  [a1, a2] = alder.trainers;
  tenantA1 = { accountId: alder.accountId, trainerId: a1.trainerId };
  repo = forTenant(db, { ...tenantA1, client });
});

const asA1 = (fn) => withTenantTransaction(client, tenantA1, fn);
const countBookings = async () =>
  (await client.query("select count(*)::int n from bookings")).rows[0].n;
// The seed makes nine: six across Alder's two trainers, three for Birch.
const SEEDED_BOOKINGS = 9;
const alertCount = async (studentId, kind) =>
  (await client.query(
    "select count(*)::int n from student_alerts where student_id = $1 and kind = $2",
    [studentId, kind])).rows[0].n;

describe("the precondition", () => {
  test("a write outside withTenantTransaction fails with a message naming the cause", async () => {
    // Without the check this still fails — RLS rejects it — but as a bare 42501, which sends
    // the reader hunting for a policy bug instead of a missing wrapper.
    await assert.rejects(
      repo.write.students.create({
        name: "Unwrapped", emergencyContactName: "X", emergencyContactPhone: "555",
        age: 30, experienceLevel: "beginner",
      }),
      /outside withTenantTransaction|outside an explicit transaction/,
    );
  });

  test("repo.write without a client explains itself rather than throwing a TypeError", () => {
    const readOnly = forTenant(db, tenantA1); // no client
    assert.throws(() => readOnly.write, /repo\.write needs a client/);
  });
});

describe("creating a booking", () => {
  test("validates with the engine, stamps the receipt, and stores the end time", async () => {
    const { booking, quote, checks } = await asA1(() =>
      repo.write.bookings.create({
        studentId: a1.students[0], horseId: alder.horses[1], // Willow, free at 11:00
        lessonTypeId: a1.lessonTypes[1], date: DATE, start: FREE,
      }));

    assert.equal(checks.length, 8, "all eight checks ran");
    assert.equal(booking.startTime, "11:00:00");
    assert.equal(booking.endTime, "12:00:00", "60-minute lesson type, end time stored not derived");
    assert.equal(booking.status, "pending");
    assert.equal(booking.isBillable, false, "a pending lesson is not billable yet");

    // The five components and the total, all written.
    assert.equal(booking.basePrice, 60);
    assert.equal(booking.bandAdjustment, 0, "11:00 is outside the 16:00-19:00 band");
    assert.equal(booking.frequencyDiscount, 0);
    assert.equal(booking.price, 60);
    assert.equal(booking.price, quote.price, "the stored price is the quoted price");
  });

  test("a slot inside the price band stores the premium it was quoted", async () => {
    const { booking } = await asA1(() =>
      repo.write.bookings.create({
        studentId: a1.students[0], horseId: alder.horses[1],
        lessonTypeId: a1.lessonTypes[1], date: DATE, start: "16:00",
      }));
    assert.equal(booking.bandAdjustment, 10);
    assert.equal(booking.price, 70);
  });

  test("the receipt is never recomputed — repricing the lesson type does not reprice the lesson", async () => {
    // The whole reason a price is stored. A lesson priced in March against March's bands must
    // still read as March's price in September.
    const { booking } = await asA1(() =>
      repo.write.bookings.create({
        studentId: a1.students[0], horseId: alder.horses[1],
        lessonTypeId: a1.lessonTypes[1], date: DATE, start: FREE,
      }));
    assert.equal(booking.price, 60);

    await client.query("update lesson_types set base_price = 85 where id = $1", [a1.lessonTypes[1]]);

    const { rows } = await client.query("select base_price, price from bookings where id = $1", [booking.id]);
    assert.equal(rows[0].price, 60, "the stored price must not move");
    assert.equal(rows[0].base_price, 60, "nor the component it was built from");
  });

  test("the engine's refusal comes back with all eight checks, not just a message", async () => {
    await assert.rejects(
      asA1(() => repo.write.bookings.create({
        studentId: a1.students[0],
        horseId: alder.horses[2], // Dusty: inactive AND on this student's no-ride list
        lessonTypeId: a1.lessonTypes[1], date: DATE, start: FREE,
      })),
      (err) => {
        assert.ok(err instanceof BookingRejected);
        assert.equal(err.checks.length, 8, "a screen must be able to show the whole checklist");
        assert.ok(err.failed.includes("pairing"));
        assert.ok(err.failed.includes("horse_active"));
        return true;
      },
    );
    assert.equal(await countBookings(), SEEDED_BOOKINGS, "nothing was written");
  });

  test("a booking for another tenant's student is refused before it reaches the database", async () => {
    await assert.rejects(
      asA1(() => repo.write.bookings.create({
        studentId: birch.trainers[0].students[0], // another account entirely
        horseId: alder.horses[1], lessonTypeId: a1.lessonTypes[1], date: DATE, start: FREE,
      })),
      /no student .* visible to this trainer/,
    );
  });
});

describe("cancelling", () => {
  test("more than the notice period away: no charge, slot freed, price preserved", async () => {
    const target = a1.bookings[0]; // 09:00 confirmed
    const { booking, disposition } = await asA1(() =>
      repo.write.bookings.cancel({ bookingId: target, now: new Date(2026, 8, 13, 9, 0) }));

    assert.equal(disposition.kind, "early_cancel");
    assert.equal(booking.status, "early_cancel");
    assert.equal(booking.isBillable, false);
    assert.equal(booking.price, 60, "the price is never zeroed — what it would have cost survives");
  });

  test("inside the notice period: still billed", async () => {
    const { booking, disposition } = await asA1(() =>
      repo.write.bookings.cancel({
        bookingId: a1.bookings[0],
        now: new Date(2026, 8, 15, 8, 0), // one hour before a 09:00 lesson
      }));
    assert.equal(disposition.kind, "late_cancel");
    assert.equal(booking.isBillable, true, "a late cancel is still charged");
  });

  test("cancelling appends an alert — informational, never an approval gate", async () => {
    // The fixture already carries a lesson_cancelled alert for this rider, so the assertion is
    // on the DELTA. Alerts are an append-only log; asserting a total would quietly depend on
    // the seed never gaining another one.
    const before = await alertCount(a1.students[0], "lesson_cancelled");
    await asA1(() => repo.write.bookings.cancel({
      bookingId: a1.bookings[0], now: new Date(2026, 8, 13, 9, 0),
    }));
    const after = await alertCount(a1.students[0], "lesson_cancelled");
    assert.equal(after, before + 1, "exactly one alert appended, nothing rewritten");

    const { rows } = await client.query(
      "select detail from student_alerts where student_id = $1 and detail like '%Coach cancelled%'",
      [a1.students[0]],
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].detail, /no charge/, "the alert carries the disposition's reasoning");
  });

  test("a cancelled slot can be booked again — the constraint's WHERE clause only holds two statuses", async () => {
    // Booked and cancelled on a slot the fixture leaves free. Reusing one of the seeded 09:00
    // lessons would not work and would not mean anything: this coach teaches a SECOND lesson at
    // 09:00 on another horse, so a rebooking there fails trainer_free for a reason that has
    // nothing to do with whether cancelling freed the horse.
    const { booking: first } = await asA1(() => repo.write.bookings.create({
      studentId: a1.students[0], horseId: alder.horses[1],
      lessonTypeId: a1.lessonTypes[1], date: DATE, start: FREE,
    }));
    await asA1(() => repo.write.bookings.cancel({
      bookingId: first.id, now: new Date(2026, 8, 13, 9, 0),
    }));

    const { booking: second } = await asA1(() => repo.write.bookings.create({
      studentId: a1.students[1], horseId: alder.horses[1], // same horse, same slot, now free
      lessonTypeId: a1.lessonTypes[1], date: DATE, start: FREE,
    }));
    assert.ok(second.id);
    assert.notEqual(second.id, first.id);

    // Both rows survive — cancelling frees the slot without erasing what happened.
    // Sorted in JS, not by the query. `order by status` on a Postgres enum sorts in DECLARATION
    // order — pending, confirmed, completed, no_show, late_cancel, early_cancel — which
    // enums.js calls out deliberately so that `>=` comparisons agree with the engine. It is not
    // alphabetical, and assuming it was is what made this assertion fail.
    const { rows } = await client.query(
      "select status from bookings where horse_id = $1 and date = $2 and start_time = '11:00'",
      [alder.horses[1], SHARED_DATE]);
    assert.deepEqual(rows.map((r) => r.status).sort(), ["early_cancel", "pending"]);
  });

  test("a lesson that is already over cannot be cancelled", async () => {
    await assert.rejects(
      asA1(() => repo.write.bookings.cancel({
        bookingId: a1.bookings[0], now: new Date(2026, 9, 1, 9, 0), // weeks later
      })),
      /cannot be cancelled/,
    );
  });

  test("another tenant's booking is invisible, so cancelling it fails", async () => {
    await assert.rejects(
      asA1(() => repo.write.bookings.cancel({
        bookingId: birch.trainers[0].bookings[0], now: new Date(2026, 8, 13, 9, 0),
      })),
      /no booking .* visible to this trainer/,
    );
  });
});

describe("settling a lesson", () => {
  test("completed is billable and holds no slot", async () => {
    const row = await asA1(() =>
      repo.write.bookings.settle({ bookingId: a1.bookings[0], outcome: "completed" }));
    assert.equal(row.status, "completed");
    assert.equal(row.isBillable, true);
  });

  test("a no-show is billable and raises an alert", async () => {
    await asA1(() => repo.write.bookings.settle({ bookingId: a1.bookings[0], outcome: "no_show" }));
    const { rows } = await client.query(
      "select 1 from student_alerts where student_id = $1 and kind = 'no_show'", [a1.students[0]]);
    assert.equal(rows.length, 1);
  });

  test("an arbitrary status is refused", async () => {
    await assert.rejects(
      asA1(() => repo.write.bookings.settle({ bookingId: a1.bookings[0], outcome: "confirmed" })),
      /expects 'completed' or 'no_show'/,
    );
  });
});

describe("students and availability", () => {
  test("a new rider lands on the calling coach's roster", async () => {
    const row = await asA1(() => repo.write.students.create({
      name: "New Rider", emergencyContactName: "Kin", emergencyContactPhone: "555-0199",
      age: 28, experienceLevel: "beginner", ridingStyles: ["English"],
    }));
    assert.equal(row.trainerId, a1.trainerId);
  });

  test("a caller cannot plant a rider on another coach's roster", async () => {
    // trainerId is taken from the binding, never from the caller — a tenancy hole with a
    // friendly signature is still a tenancy hole.
    const row = await asA1(() => repo.write.students.create({
      trainerId: a2.trainerId,
      name: "Smuggled", emergencyContactName: "Kin", emergencyContactPhone: "555",
      age: 28, experienceLevel: "beginner",
    }));
    assert.equal(row.trainerId, a1.trainerId, "the binding wins over the argument");
  });

  test("updating cannot move a rider between coaches", async () => {
    const row = await asA1(() => repo.write.students.update({
      studentId: a1.students[0], trainerId: a2.trainerId, name: "Renamed",
    }));
    assert.equal(row.name, "Renamed");
    assert.equal(row.trainerId, a1.trainerId, "moving a rider between coaches is not an edit");
  });

  test("availability is replaced wholesale, and no one sees the empty middle", async () => {
    const out = await asA1(() => repo.write.availability.replace([
      { dayOfWeek: "mon", startTime: "08:00", endTime: "12:00" },
      { dayOfWeek: "wed", startTime: "13:00", endTime: "18:00" },
    ]));
    assert.equal(out.length, 2);
    const rows = await repo.availability.list();
    assert.equal(rows.length, 2, "the old Tuesday window is gone");
    assert.deepEqual(rows.map((r) => r.dayOfWeek).sort(), ["mon", "wed"]);
  });
});

// ---------------------------------------------------------------------------
// Races. Both halves of double-booking, each at the layer that can actually stop it.
// ---------------------------------------------------------------------------
describe("concurrency", () => {
  test("two coaches in one barn racing for the same horse: the constraint stops the loser", async () => {
    // Different trainers, so the advisory lock below does NOT serialize them — their keys
    // differ. Both engines validate against a world where Comet is free at 11:00, and both try
    // to insert. This is the race the exclusion constraint exists for, reached through the
    // write path rather than through hand-written SQL.
    const c1 = await connect();
    const c2 = await connect();
    try {
      const db1 = drizzle(c1, { casing: "snake_case" });
      const db2 = drizzle(c2, { casing: "snake_case" });
      const t1 = { accountId: alder.accountId, trainerId: a1.trainerId };
      const t2 = { accountId: alder.accountId, trainerId: a2.trainerId };
      const r1 = forTenant(db1, { ...t1, client: c1 });
      const r2 = forTenant(db2, { ...t2, client: c2 });

      const results = await Promise.allSettled([
        withTenantTransaction(c1, t1, () => r1.write.bookings.create({
          studentId: a1.students[0], horseId: alder.horses[0],
          lessonTypeId: a1.lessonTypes[1], date: DATE, start: FREE,
        })),
        withTenantTransaction(c2, t2, () => r2.write.bookings.create({
          studentId: a2.students[0], horseId: alder.horses[0],
          lessonTypeId: a2.lessonTypes[1], date: DATE, start: FREE,
        })),
      ]);

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      assert.equal(won.length, 1, "exactly one may hold the horse");
      assert.equal(lost.length, 1);
      // Either the database caught it at insert (SlotTaken) or the loser's engine saw the
      // committed row first and refused (horse_free). Both are correct; what must never happen
      // is two bookings.
      const err = lost[0].reason;
      assert.ok(
        err instanceof SlotTaken ||
          (err instanceof BookingRejected && err.failed.includes("horse_free")),
        `unexpected failure: ${err.name}: ${err.message}`,
      );

      const { rows } = await client.query(
        `select count(*)::int n from bookings
          where horse_id = $1 and date = $2 and start_time = '11:00'
            and status in ('pending','confirmed')`,
        [alder.horses[0], SHARED_DATE]);
      assert.equal(rows[0].n, 1, "exactly one booking survives");
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  test("one coach racing themselves onto two horses at the same time: the advisory lock stops it", async () => {
    // Same trainer, same date, DIFFERENT horses. The exclusion constraint does not apply — the
    // horses genuinely are free — and the trainer half of check #6 lives in the engine, which
    // cannot see a row another transaction has not committed. Without the lock both validate
    // and both commit, and the coach is double-booked.
    const c1 = await connect();
    const c2 = await connect();
    try {
      const db1 = drizzle(c1, { casing: "snake_case" });
      const db2 = drizzle(c2, { casing: "snake_case" });
      const r1 = forTenant(db1, { ...tenantA1, client: c1 });
      const r2 = forTenant(db2, { ...tenantA1, client: c2 });

      const results = await Promise.allSettled([
        withTenantTransaction(c1, tenantA1, () => r1.write.bookings.create({
          studentId: a1.students[0], horseId: alder.horses[0],
          lessonTypeId: a1.lessonTypes[1], date: DATE, start: FREE,
        })),
        withTenantTransaction(c2, tenantA1, () => r2.write.bookings.create({
          studentId: a1.students[1], horseId: alder.horses[1],
          lessonTypeId: a1.lessonTypes[1], date: DATE, start: FREE,
        })),
      ]);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1,
        "a coach cannot teach two lessons at once");
      const err = results.find((r) => r.status === "rejected").reason;
      assert.ok(err instanceof BookingRejected, `expected an engine refusal, got ${err.name}`);
      assert.ok(err.failed.includes("trainer_free"),
        `expected trainer_free to fail, got ${err.failed.join(", ")}`);
    } finally {
      await c1.end();
      await c2.end();
    }
  });
});

describe("standing weekly slots", () => {
  // The fixture's trainer A1 teaches Tuesdays 09:00–17:00, and 11:00 is free for both the horse
  // and the coach — so a Tuesday pattern at 11:00 is the one that should succeed, and anything
  // that fails around it is failing for a stated reason rather than for want of a free slot.
  const TUESDAY = DATE.getDay();

  const create = (over = {}) =>
    asA1(() => repo.write.recurring.create({
      studentId: a1.students[0], horseId: alder.horses[0], lessonTypeId: a1.lessonTypes[1],
      day: TUESDAY, start: FREE, startDate: SHARED_DATE, occurrences: 4, ...over,
    }));

  test("a pattern writes one row per week, each with its own stamped receipt", async () => {
    const { recurring, bookings: rows } = await create();
    assert.equal(recurring.status, "active");
    assert.equal(rows.length, 4, "four weeks asked for, four weeks written");

    const dates = rows.map((r) => r.date).sort();
    assert.equal(new Set(dates).size, 4, "no two occurrences land on the same day");
    for (let i = 1; i < dates.length; i++) {
      const gap = (toDate(dates[i]) - toDate(dates[i - 1])) / 86400000;
      assert.equal(gap, 7, "a weekly pattern is seven days apart, every time");
    }
    for (const r of rows) {
      assert.equal(r.recurringId, recurring.id, "every occurrence points back at its pattern");
      assert.ok(r.price > 0, "each week carries its own price rather than inheriting one");
    }
  });

  test("one unbookable week refuses the whole series, and says which", async () => {
    // Take the third occurrence's slot with the same horse first. Nothing is wrong with weeks
    // one, two or four — which is the point: a pattern that works three times out of four is
    // not a pattern, and finding out in three weeks is the failure this prevents.
    const third = new Date(DATE);
    third.setDate(third.getDate() + 14);
    await asA1(() => repo.write.bookings.create({
      studentId: a1.students[1], horseId: alder.horses[0], lessonTypeId: a1.lessonTypes[1],
      date: third, start: FREE,
    }));

    const before = await countBookings();
    await assert.rejects(create(), (err) => {
      assert.ok(err instanceof BookingRejected);
      assert.ok(err.failed.includes("horse_free"), `expected horse_free, got ${err.failed}`);
      assert.ok(err.context.date, "the refusal must name the week that broke");
      return true;
    });
    assert.equal(await countBookings(), before, "a refused series writes NOTHING, not three weeks");
  });

  test("ending a series drops what is still to come and keeps what already happened", async () => {
    const { recurring, bookings: rows } = await create();
    const first = rows.map((r) => r.date).sort()[0];

    // End it from a week after the first occurrence: that one is in the past now, the rest
    // are not.
    const now = toDate(first);
    now.setDate(now.getDate() + 1);

    const { recurring: ended, removed } = await asA1(() =>
      repo.write.recurring.end({ recurringId: recurring.id, now }));

    assert.equal(ended.status, "ended");
    assert.equal(removed, 3, "the three weeks that had not happened yet are gone");

    const { rows: left } = await client.query(
      "select date from bookings where recurring_id = $1", [recurring.id]);
    assert.equal(left.length, 1, "the lesson that already happened is untouched");
    // Compared as a date STRING on both sides. This query goes through the raw driver, which
    // parses a `date` column into a Date at local midnight, while drizzle hands the same column
    // back as "2026-09-15" — so the two representations are never === each other, and asserting
    // on them directly fails on a row that is perfectly correct.
    const kept = left[0].date;
    const keptString = kept instanceof Date
      ? `${kept.getFullYear()}-${String(kept.getMonth() + 1).padStart(2, "0")}-${String(kept.getDate()).padStart(2, "0")}`
      : String(kept);
    assert.equal(keptString, first, "and it is the first week, the one that already ran");
  });

  test("a series ended before it begins closes on the day it would have started", async () => {
    // `recurring_bookings_end_after_start` refuses a span that closes before it opens, and a
    // pattern created for next week and cancelled today is exactly that. It ran for no lessons;
    // it did not run for minus two days.
    const { recurring } = await create({ startDate: SHARED_DATE });
    const beforeStart = toDate(SHARED_DATE);
    beforeStart.setDate(beforeStart.getDate() - 2);

    const { recurring: ended } = await asA1(() =>
      repo.write.recurring.end({ recurringId: recurring.id, now: beforeStart }));
    assert.equal(ended.endDate, recurring.startDate);
  });

  test("changing a series moves what is to come and leaves what already ran", async () => {
    const { recurring, bookings: rows } = await create();
    const dates = rows.map((r) => r.date).sort();

    // Stand a week into the series, so the first occurrence is history and three are not.
    const now = toDate(dates[0]);
    now.setDate(now.getDate() + 1);

    const { recurring: moved, replaced } = await asA1(() => repo.write.recurring.update({
      recurringId: recurring.id, horseId: alder.horses[1], now,
    }));

    assert.equal(moved.horseId, alder.horses[1], "the pattern itself follows the change");
    assert.equal(replaced, 3, "the three weeks still to come were re-planned");

    const { rows: after } = await client.query(
      "select date, horse_id from bookings where recurring_id = $1 order by date", [recurring.id]);
    // One week has already run and stays; the series is then booked four weeks AHEAD again, so
    // five rows rather than four. A change leaves the coach with the same horizon she had
    // before it — not with a series that quietly got shorter because she edited it.
    assert.equal(after.length, 5, "the past week kept, and four booked ahead of the change");
    assert.equal(
      after[0].horse_id, alder.horses[0],
      "the lesson that already happened keeps the horse it actually ran with",
    );
    for (const r of after.slice(1)) {
      assert.equal(r.horse_id, alder.horses[1], "every future week is on the new horse");
    }
  });

  test("a week already moved to another horse by hand survives a change to the pattern", async () => {
    const { recurring, bookings: rows } = await create();
    const future = rows.map((r) => r.date).sort().slice(1);

    // The coach substituted one week onto a third horse — "Duke is lame that Tuesday".
    await client.query(
      "update bookings set horse_id = $1 where recurring_id = $2 and date = $3",
      [alder.horses[2], recurring.id, future[1]]);

    const now = toDate(rows.map((r) => r.date).sort()[0]);
    now.setDate(now.getDate() + 1);
    const { keptSubstitutions } = await asA1(() => repo.write.recurring.update({
      recurringId: recurring.id, horseId: alder.horses[1], now,
    }));

    assert.equal(keptSubstitutions, 1, "the hand-made exception is recognised as one");
    const { rows: kept } = await client.query(
      "select horse_id from bookings where recurring_id = $1 and date = $2",
      [recurring.id, future[1]]);
    assert.equal(
      kept[0].horse_id, alder.horses[2],
      "changing the standing horse must not quietly undo a deliberate one-off",
    );
  });

  test("a change that cannot be booked every week changes nothing at all", async () => {
    const { recurring, bookings: rows } = await create();
    const dates = rows.map((r) => r.date).sort();
    const now = toDate(dates[0]);
    now.setDate(now.getDate() + 1);

    // The BARN-MATE takes the target horse on the third week, at this time. It has to be the
    // other trainer: this coach is already teaching that slot — it is her own series — so she
    // cannot be the one to occupy it, and trying makes the SETUP fail on trainer_free rather
    // than the update failing on horse_free. Horses are account-scoped precisely so that one
    // coach's booking takes the animal out of the other's reach.
    const tenantA2 = { accountId: alder.accountId, trainerId: a2.trainerId };
    const repoA2 = forTenant(db, { ...tenantA2, client });
    await withTenantTransaction(client, tenantA2, () => repoA2.write.bookings.create({
      studentId: a2.students[0], horseId: alder.horses[1], lessonTypeId: a2.lessonTypes[1],
      date: toDate(dates[2]), start: FREE,
    }));

    await assert.rejects(
      asA1(() => repo.write.recurring.update({
        recurringId: recurring.id, horseId: alder.horses[1], now,
      })),
      (err) => err instanceof BookingRejected,
    );

    // The deletion and the re-plan are in one transaction, so a refusal leaves the series
    // exactly as it was rather than half-moved or missing its upcoming weeks.
    const { rows: after } = await client.query(
      "select horse_id from bookings where recurring_id = $1", [recurring.id]);
    assert.equal(after.length, 4, "nothing was dropped");
    for (const r of after) {
      assert.equal(r.horse_id, alder.horses[0], "and nothing was moved");
    }
  });

  test("an ended series cannot be changed", async () => {
    const { recurring } = await create();
    await asA1(() => repo.write.recurring.end({ recurringId: recurring.id, now: DATE }));
    await assert.rejects(
      asA1(() => repo.write.recurring.update({
        recurringId: recurring.id, horseId: alder.horses[1], now: DATE,
      })),
      /has ended and cannot be changed/,
    );
  });

  test("another trainer's series cannot be ended", async () => {
    const { recurring } = await create();
    const tenantA2 = { accountId: alder.accountId, trainerId: a2.trainerId };
    const repoA2 = forTenant(db, { ...tenantA2, client });
    await assert.rejects(
      withTenantTransaction(client, tenantA2, () =>
        repoA2.write.recurring.end({ recurringId: recurring.id, now: DATE })),
      /no recurring pattern .* visible to this trainer/,
      "a pattern belongs to the coach who created it, even inside one account",
    );
  });
});
