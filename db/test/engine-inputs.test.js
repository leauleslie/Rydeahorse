// Database -> mapping -> engine, end to end.
//
// Until this file existed, the two halves of the product had never met. `engine/` was tested
// against hand-built fixtures and `db/` was tested on row identity, so every naming and shape
// mismatch between them sat undetected: five of a horse's ten fields are named differently,
// `date` arrives as a string where the engine calls `.getDay()`, and three of the engine's
// inputs are junction tables here. None of those would have thrown — they produce NaN, empty
// results, and prices that are merely wrong.
//
// So these tests take real rows out of Postgres, run them through db/repo/to-engine.js, and
// hand the result to the actual `validateBooking` and `priceFor`. Nothing is hand-built.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { connectDrizzle, truncateAll, assertMarked, acquireSuiteLock, releaseSuiteLock } from "./db.js";
import { seedAccounts, SHARED_DATE } from "./seed.js";
import { forTenant } from "../repo/index.js";
import { toDate } from "../repo/to-engine.js";
import { validateBooking, priceFor, horseMinutesOnDate, firstFailure } from "../../engine/index.js";

let client, db, alder, birch, repo, a1, ctx;
const DATE = toDate(SHARED_DATE); // Tuesday 15 Sep 2026

before(async () => {
  ({ client, db } = await connectDrizzle());
  await acquireSuiteLock(client);
  await assertMarked(client);
  await truncateAll(client);
  ({ alder, birch } = await seedAccounts(client));
  [a1] = alder.trainers;
  repo = forTenant(db, { accountId: alder.accountId, trainerId: a1.trainerId });
  ctx = await repo.engineInputsFor(DATE);
});

after(async () => {
  if (client) await releaseSuiteLock(client).catch(() => {});
  await client?.end();
});

const horseNamed = (n) => ctx.horses.find((h) => h.name === n);
const studentNamed = (n) => ctx.students.find((s) => s.name === n);
const typeNamed = (n) => ctx.lessonTypes.find((l) => l.name === n);

describe("the inputs are the shape the engine actually expects", () => {
  test("every key the engine's own fixture provides is present", () => {
    // Mirrors engine/test/fixtures.js `request()`, minus the three choices a screen makes.
    for (const key of ["horses", "students", "lessonTypes", "bookings", "availability",
                       "timeOffBlocks", "priceBands", "trainerConfig"]) {
      assert.ok(key in ctx, `engineInputsFor must supply ${key}`);
      assert.notEqual(ctx[key], undefined, `${key} must not be undefined`);
    }
  });

  test("dates are Dates and times are HH:MM, because the engine calls .getDay() and parseTime", () => {
    for (const b of ctx.bookings) {
      assert.ok(b.date instanceof Date, "a booking date must be a Date, not the string from pg");
      assert.match(b.start, /^\d{2}:\d{2}$/, `start should be HH:MM, got ${b.start}`);
      assert.ok(!Number.isNaN(b.date.getDay()), "getDay() on a string silently yields NaN");
    }
    assert.equal(DATE.getDay(), 2, "the fixture date is a Tuesday");
    assert.ok(ctx.availability.every((a) => Number.isInteger(a.day)),
      "availability days must be indices, not 'tue'");
    assert.ok(ctx.availability.some((a) => a.day === 2), "Tuesday availability must be reachable");
  });

  test("the fields the engine indexes into are never undefined", () => {
    // Each of these would throw inside the engine rather than fail a check.
    for (const s of ctx.students) assert.ok(Array.isArray(s.noRideHorses), `${s.name}.noRideHorses`);
    for (const h of ctx.horses) assert.ok(Array.isArray(h.styles), `${h.name}.styles`);
    for (const lt of ctx.lessonTypes) {
      assert.equal(typeof lt.bandAdjustments, "object");
      assert.ok(Array.isArray(lt.restrictedHorseIds));
      assert.ok(Number.isFinite(lt.durationMin) && Number.isFinite(lt.rideTimeMin));
    }
  });

  test("the junction rows actually arrived — the empty case would pass vacuously", () => {
    const priv = typeNamed("Private Lesson");
    assert.deepEqual(Object.values(priv.bandAdjustments), [10], "the seeded band premium");
    const intro = typeNamed("Intro Lesson");
    assert.equal(intro.restrictedHorseIds.length, 1, "the seeded horse restriction");
    const alex = studentNamed("Alex Morgan");
    assert.equal(alex.noRideHorses.length, 1, "the seeded no-ride entry");
  });
});

describe("validateBooking runs on real rows", () => {
  test("a genuinely free, well-paired slot passes every check", () => {
    // Willow is ridden 09:00 (this coach) and 13:00 (the other coach in the barn); 11:00 is
    // free for horse and trainer alike.
    const result = validateBooking({
      ...ctx,
      student: studentNamed("Alex Morgan"),
      horse: horseNamed("Willow"),
      lessonType: typeNamed("Private Lesson"),
      date: DATE,
      start: "11:00",
    });
    assert.equal(result.ok, true,
      `expected a pass, failed on: ${result.checks.filter((c) => !c.pass).map((c) => c.code).join(", ")}`);
    // Eight, not the seven CLAUDE.md claims: trainer_available, horse_active, rest_day,
    // usage_cap, pairing, horse_free, trainer_free, price_in_range.
    assert.equal(result.checks.length, 8, "every check reports every time; none short-circuits");
    assert.ok(result.quote, "a quote comes back with the validation");
  });

  test("a horse on the student's no-ride list fails the pairing check", () => {
    const result = validateBooking({
      ...ctx,
      student: studentNamed("Alex Morgan"),
      horse: horseNamed("Dusty"), // seeded inactive AND on Alex's no-ride list
      lessonType: typeNamed("Private Lesson"),
      date: DATE,
      start: "11:00",
    });
    assert.equal(result.ok, false);
    const byCode = Object.fromEntries(result.checks.map((c) => [c.code, c.pass]));
    assert.equal(byCode.pairing, false, "the no-ride list must be honoured from the database");
    assert.equal(byCode.horse_active, false, "Dusty is also inactive");
    // Order decides which reason is reported, and the engine does not short-circuit.
    // firstFailure takes the whole validation, not its checks array.
    assert.equal(firstFailure(result).code, "horse_active", "the first failure in spec order");
  });

  test("a slot the horse already holds fails horse_free", () => {
    const result = validateBooking({
      ...ctx,
      student: studentNamed("Robin Fox"),
      horse: horseNamed("Willow"),
      lessonType: typeNamed("Private Lesson"),
      date: DATE,
      start: "09:00", // Willow is already booked here
    });
    const byCode = Object.fromEntries(result.checks.map((c) => [c.code, c.pass]));
    assert.equal(byCode.horse_free, false);
  });

  test("a slot outside the trainer's availability fails trainer_available", () => {
    const result = validateBooking({
      ...ctx,
      student: studentNamed("Alex Morgan"),
      horse: horseNamed("Willow"),
      lessonType: typeNamed("Private Lesson"),
      date: DATE,
      start: "06:00", // availability is 09:00-17:00
    });
    const byCode = Object.fromEntries(result.checks.map((c) => [c.code, c.pass]));
    assert.equal(byCode.trainer_available, false);
  });
});

describe("welfare and the shared horse", () => {
  test("bookings are loaded account-wide, so the barn-mate's lessons are present", () => {
    const mine = new Set(a1.bookings);
    const barnMate = alder.trainers[1].bookings;
    assert.ok(barnMate.some((id) => ctx.bookings.some((b) => b.id === id)),
      "engineInputsFor must load the whole account's lessons, not just this coach's");
    assert.equal(ctx.bookings.length, alder.accountBookings.length);
    assert.ok(ctx.bookings.some((b) => !mine.has(b.id)));
  });

  test("none of another ACCOUNT's lessons are in scope", () => {
    const foreign = new Set(birch.accountBookings);
    assert.ok(ctx.bookings.every((b) => !foreign.has(b.id)),
      "engineInputsFor must stay inside the account");
  });

  // -------------------------------------------------------------------------
  // A DEFECT this exercise surfaced. Asserted at its real value so it is recorded rather
  // than remembered, and so closing it makes this test fail loudly.
  // -------------------------------------------------------------------------
  test("DEFECT: a shared horse's saddle time under-counts the barn-mate's lessons entirely", () => {
    // Comet is ridden by both coaches on this date — 09:00 by a1 and 13:00 by a2, both
    // slot-holding, both 45-minute lesson types. The honest total is 90.
    //
    // It reads 45. horseMinutesOnDate resolves each booking's duration by looking its lesson
    // type up in the `lessonTypes` array it was handed:
    //
    //     const lt = lessonTypes.find((l) => l.id === b.lessonTypeId);
    //     return sum + (lt ? lt.rideTimeMin : 0);
    //
    // Bookings are account-wide, but lesson types are TRAINER-scoped — by design, and enforced
    // by RLS, so a1 genuinely cannot read a2's. The barn-mate's lesson type is therefore not
    // in the array, `lt` is undefined, and the lesson silently contributes ZERO rather than
    // failing. The `? :` that makes it safe is exactly what makes it silent.
    //
    // This is not the mapping's doing — passing account-wide bookings is correct and required.
    // It is a hole in the schema: the welfare rules promise to count every lesson the animal
    // did, and the number they need to do that is not reachable from the data a single trainer
    // is allowed to see.
    //
    // The fix is not to widen the lesson-type scope, which would break tenant isolation. It is
    // to stamp `ride_time_min` onto the booking row at creation — the same argument that
    // already justifies the stored price receipt: a booking's saddle time is a historical fact
    // about that lesson, and recomputing it from a table the reader may not be allowed to see
    // is what makes it wrong. That is a third exception to derive-don't-store and needs
    // recording in Section 9 before it is taken.
    const comet = horseNamed("Comet").id;
    const overall = horseMinutesOnDate(comet, DATE, ctx.bookings, ctx.lessonTypes, false, ctx.students);
    const resolvable = ctx.bookings.filter(
      (b) => b.horseId === comet && ctx.lessonTypes.some((l) => l.id === b.lessonTypeId));
    const unresolvable = ctx.bookings.filter(
      (b) => b.horseId === comet && !ctx.lessonTypes.some((l) => l.id === b.lessonTypeId));

    assert.ok(unresolvable.length > 0, "the fixture must contain a barn-mate lesson to under-count");
    assert.equal(overall, 45, "only this coach's slot-holding lesson is counted");
    assert.notEqual(overall, 90, "90 is the honest total; if this ever passes, the defect is fixed");
    assert.ok(resolvable.length < resolvable.length + unresolvable.length);
  });

  test("the same hole makes the adult cap under-count too, for a second reason", () => {
    // horseMinutesOnDate also resolves the rider via `students.find(...)` to test `age >= 18`,
    // and students are trainer-scoped for the same reason lesson types are. So even once the
    // duration is stamped on the booking, the adult cap still cannot tell whether a barn-mate's
    // rider was an adult. Whatever carries ride time onto the booking has to carry that too.
    const comet = horseNamed("Comet").id;
    const adult = horseMinutesOnDate(comet, DATE, ctx.bookings, ctx.lessonTypes, true, ctx.students);
    assert.equal(adult, 45, "only this coach's adult rider is resolvable");
  });
});

describe("priceFor runs on real rows", () => {
  const quote = (start) => priceFor({
    student: studentNamed("Alex Morgan"),
    lessonType: typeNamed("Private Lesson"),
    date: DATE,
    start,
    priceBands: ctx.priceBands,
    trainerConfig: ctx.trainerConfig,
  });

  test("a slot inside the seeded band picks up its premium", () => {
    // The band is Tuesday 16:00-19:00 with a +10 adjustment on this lesson type. Getting here
    // requires price_bands, price_band_windows AND lesson_type_band_adjustments to have been
    // mapped correctly — three tables, two of them junctions, and the band's id has to survive
    // the window grouping or the adjustment lookup silently returns 0.
    const q = quote("16:00");
    assert.equal(q.bandAdjustment, 10, "the band premium must reach the quote");
    assert.equal(q.basePrice, 60);
    assert.equal(q.price, 70);
    assert.equal(q.band?.name, "Peak");
  });

  test("a slot outside the band carries no premium", () => {
    const q = quote("11:00");
    assert.equal(q.bandAdjustment, 0);
    assert.equal(q.price, 60);
    assert.equal(q.band, null);
  });

  test("frequency pricing is off, because the thresholds ship blank", () => {
    // null, not 0 — 0 would mean every rider qualifies for tier 1.
    assert.equal(ctx.trainerConfig.freqTier1MinRides, null);
    assert.equal(quote("11:00").frequencyDiscount, 0);
  });

  test("the quote always carries its components, never a bare number", () => {
    const q = quote("16:00");
    for (const k of ["basePrice", "bandAdjustment", "frequencyDiscount", "offerDiscount",
                     "manualAdjustment", "price", "raw"]) {
      assert.ok(k in q, `a quote must be able to explain itself: missing ${k}`);
    }
  });
});
