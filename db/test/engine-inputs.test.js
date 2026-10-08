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

  test("the two booking scopes are both supplied, and they differ", () => {
    // The distinction this exists for: one list is the barn, the other is the coach. If they
    // were ever the same array, one of the two rules that read them would be wrong.
    assert.equal(ctx.bookings.length, alder.accountBookings.length, "the barn");
    assert.equal(ctx.trainerBookings.length, a1.bookings.length, "this coach alone");
    assert.ok(ctx.trainerBookings.length < ctx.bookings.length, "and the barn is bigger");
    const mine = new Set(a1.bookings);
    assert.ok(ctx.trainerBookings.every((b) => mine.has(b.id)));
  });

  test("a barn-mate's lesson blocks the HORSE but not the COACH", () => {
    // Two bugs used to cancel here. A barn-mate's lesson type is unreadable to this coach, and
    // the conflict check gave an unreadable type zero duration — so the horse read as free. Fix
    // that alone and the coach then reads as busy, because bookings are loaded account-wide.
    // Only the two scopes together give both answers correctly.
    const willow = horseNamed("Willow");
    const barnMateSlot = "13:00"; // the other coach teaches Willow here; a1 teaches nothing
    const v = validateBooking({
      ...ctx,
      student: studentNamed("Alex Morgan"),
      horse: willow,
      lessonType: typeNamed("Private Lesson"),
      date: DATE,
      start: barnMateSlot,
    });
    const byCode = Object.fromEntries(v.checks.map((c) => [c.code, c.pass]));
    assert.equal(byCode.horse_free, false, "the horse IS taken, by the barn-mate");
    assert.equal(byCode.trainer_free, true, "but this coach is free — it is not her lesson");
  });

  test("none of another ACCOUNT's lessons are in scope", () => {
    const foreign = new Set(birch.accountBookings);
    assert.ok(ctx.bookings.every((b) => !foreign.has(b.id)),
      "engineInputsFor must stay inside the account");
  });

  // -------------------------------------------------------------------------
  // The defect those two tests recorded, now closed. They asserted 45 — the wrong number — so
  // that closing the gap would fail them loudly. It did, and this is what replaced them.
  // -------------------------------------------------------------------------
  test("a shared horse's saddle time counts BOTH coaches' lessons", () => {
    // Comet is ridden by both coaches on this date — 09:00 by a1 and 13:00 by a2, both
    // slot-holding, both 45-minute types. The honest total is 90, and it used to read 45.
    //
    // The barn-mate's lesson type is still unreadable to this coach, and always will be: that
    // is tenancy working, not a gap. What changed is that the booking now carries its own
    // `ride_time_min`, so the number no longer has to be looked up in a table the reader is
    // not allowed to see. Section 9 — the third exception to derive-don't-store.
    const comet = horseNamed("Comet").id;
    const overall = horseMinutesOnDate(comet, DATE, ctx.bookings, ctx.lessonTypes, false, ctx.students);

    const unresolvable = ctx.bookings.filter(
      (b) => b.horseId === comet && !ctx.lessonTypes.some((l) => l.id === b.lessonTypeId));
    assert.ok(
      unresolvable.length > 0,
      "the fixture must still contain a lesson whose TYPE this coach cannot read, or this " +
        "proves nothing — the point is that the total is right anyway",
    );
    assert.equal(overall, 90, "both coaches' lessons count toward the animal's day");
  });

  test("the stamped ride time is what makes it count, not a widened scope", () => {
    // The fix had to be the stamp and not "let this coach see the other's lesson types", which
    // would trade a welfare bug for a tenancy breach. So: the lesson that used to vanish still
    // has an unreadable type, and still contributes its minutes.
    const comet = horseNamed("Comet").id;
    const barnMate = ctx.bookings.find(
      (b) => b.horseId === comet && !ctx.lessonTypes.some((l) => l.id === b.lessonTypeId));
    assert.ok(barnMate, "a lesson of the barn-mate's, on the shared horse");
    assert.equal(
      ctx.lessonTypes.some((l) => l.id === barnMate.lessonTypeId), false,
      "its type is STILL invisible to this coach — tenancy is intact",
    );
    assert.ok(barnMate.rideTimeMin > 0, "and the row carries its own saddle time regardless");
  });

  test("the adult cap counts the barn-mate's adult rider too", () => {
    // The second half of the same hole: the cap also resolved the rider through `students` to
    // test `age >= 18`, and students are trainer-scoped for the same reason lesson types are.
    // `rider_was_adult` is stamped alongside the ride time, so both halves close together.
    const comet = horseNamed("Comet").id;
    const adult = horseMinutesOnDate(comet, DATE, ctx.bookings, ctx.lessonTypes, true, ctx.students);

    const barnMate = ctx.bookings.find(
      (b) => b.horseId === comet && !ctx.students.some((s) => s.id === b.studentId));
    assert.ok(barnMate, "a lesson whose RIDER this coach cannot read");
    assert.equal(typeof barnMate.riderWasAdult, "boolean", "answered on the row, not looked up");
    assert.equal(adult, 90, "both adult riders count toward the adult cap");
  });

  test("a minor's lesson stays out of the adult cap, and in the overall one", () => {
    // The direction `||` would have got wrong: a stamped `false` has to beat the lookup rather
    // than falling through to a roster this reader cannot see and coming back undefined.
    const horse = horseNamed("Willow").id;
    const minorLesson = { ...ctx.bookings[0], horseId: horse, riderWasAdult: false, rideTimeMin: 45 };
    const withMinor = [...ctx.bookings.filter((b) => b.horseId !== horse), minorLesson];

    const overall = horseMinutesOnDate(horse, DATE, withMinor, ctx.lessonTypes, false, ctx.students);
    const adult = horseMinutesOnDate(horse, DATE, withMinor, ctx.lessonTypes, true, ctx.students);
    assert.equal(overall, 45, "the animal still did the work");
    assert.equal(adult, 0, "but it was not an adult doing it");
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
