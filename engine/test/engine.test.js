import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateBooking,
  firstFailure,
  ridDaysInWindow,
  horseMinutesOnDate,
  getEligibleHorses,
  groupRoster,
  priceFor,
  earnedTier,
  tierFromRides,
  billableRidesInMonth,
  effectiveStatus,
  cancelDisposition,
  minutesUntil,
  occurrenceType,
  horseAssignment,
  bandOverlap,
  clockAt,
} from "../index.js";

import * as F from "./fixtures.js";
const { NOW, d, horses, students, lessonTypes, trainerConfig, priceBands } = F;

const fails = (v, code) => {
  const c = v.checks.find((x) => x.code === code);
  assert.ok(c, `no check with code ${code}`);
  return !c.pass;
};

// ---------------------------------------------------------------- check 1: availability
test("rejects a time outside the trainer's window", () => {
  const v = validateBooking(F.request({ start: "20:00" }));
  assert.ok(fails(v, "trainer_available"));
  assert.equal(firstFailure(v).code, "trainer_available");
});

test("rejects a date inside a time-off block", () => {
  const v = validateBooking(
    F.request({ timeOffBlocks: [{ startDate: d(17), endDate: d(21), reason: "away" }] })
  );
  assert.ok(fails(v, "trainer_available"));
});

test("a day may have more than one availability window", () => {
  const split = [
    { day: 3, start: "08:00", end: "12:00" },
    { day: 3, start: "15:00", end: "20:00" },
  ];
  const morning = validateBooking(F.request({ date: d(19), start: "09:00", availability: split }));
  const evening = validateBooking(F.request({ date: d(19), start: "16:00", availability: split }));
  const gap = validateBooking(F.request({ date: d(19), start: "13:00", availability: split }));
  assert.ok(!fails(morning, "trainer_available"));
  assert.ok(!fails(evening, "trainer_available"));
  assert.ok(fails(gap, "trainer_available"));
});

// ---------------------------------------------------------------- check 2: horse active
test("rejects an inactive horse", () => {
  const v = validateBooking(F.request({ horse: horses[2] }));
  assert.ok(fails(v, "horse_active"));
});

// ---------------------------------------------------------------- check 3: rest days
test("rest window counts distinct DATES, not bookings", () => {
  const twoOnOneDay = [
    F.booking({ date: d(17), start: "09:00" }),
    F.booking({ date: d(17), start: "11:00" }),
  ];
  assert.equal(ridDaysInWindow("buttercup", d(19), twoOnOneDay), 1);
});

test("rest window includes the date being requested", () => {
  // restDaysPerWeek 1 => capacity 6. Six distinct prior days + the new one = 7 > 6.
  const bookings = [13, 14, 15, 16, 17, 18].map((n) => F.booking({ date: d(n) }));
  const v = validateBooking(F.request({ date: d(19), bookings }));
  assert.ok(fails(v, "rest_day"));
});

test("a second lesson on an already-booked day does not consume another rest day", () => {
  const bookings = [14, 15, 16, 17, 18, 19].map((n) => F.booking({ date: d(n) }));
  // d(19) is already booked, so the new booking adds no new day: 6 <= 6.
  const v = validateBooking(F.request({ date: d(19), start: "13:00", bookings }));
  assert.ok(!fails(v, "rest_day"));
});

// ---------------------------------------------------------------- check 4: usage caps
test("usage cap sums saddle time, not calendar time", () => {
  const bookings = [F.booking({ date: d(19), start: "08:00" })]; // 60 min calendar, 50 saddle
  assert.equal(horseMinutesOnDate("buttercup", d(19), bookings, lessonTypes, false, students), 50);
});

test("the adult cap only counts adult riders", () => {
  const bookings = [F.booking({ studentId: "jordan", date: d(19), start: "08:00" })];
  assert.equal(horseMinutesOnDate("buttercup", d(19), bookings, lessonTypes, true, students), 0);
  assert.equal(horseMinutesOnDate("buttercup", d(19), bookings, lessonTypes, false, students), 50);
});

test("a minor's booking can exceed the adult cap but not the overall cap", () => {
  // Atlas: adult cap 60, overall 120. Jordan is 12 — but Atlas is adultOnly, so use Buttercup.
  // Buttercup: adult 120, overall 180. Three 50-min minor rides = 150 <= 180, and adult stays 0.
  const bookings = [
    F.booking({ studentId: "jordan", date: d(19), start: "08:00" }),
    F.booking({ studentId: "jordan", date: d(19), start: "09:30" }),
  ];
  const v = validateBooking(
    F.request({ student: students[1], date: d(19), start: "11:00", bookings })
  );
  assert.ok(!fails(v, "usage_cap"), "100 + 50 <= 180 overall, adult total still 0");
});

test("the overall cap binds regardless of rider age", () => {
  const bookings = [
    F.booking({ studentId: "jordan", date: d(19), start: "08:00" }),
    F.booking({ studentId: "jordan", date: d(19), start: "09:30" }),
    F.booking({ studentId: "jordan", date: d(19), start: "11:00" }),
  ];
  const v = validateBooking(
    F.request({ student: students[1], date: d(19), start: "13:00", bookings })
  );
  assert.ok(fails(v, "usage_cap"), "150 + 50 = 200 > 180 overall");
});

// ---------------------------------------------------------------- check 5: pairing
test("pairing rejects on experience, age, style, weight and no-ride list", () => {
  const lt = lessonTypes[0];
  const underExperienced = { ...students[0], experienceLevel: "beginner" };
  assert.equal(getEligibleHorses(underExperienced, lt, [horses[1]]).length, 0);

  const minor = { ...students[0], age: 15 };
  assert.equal(getEligibleHorses(minor, lt, [horses[1]]).length, 0, "adultOnly");

  const western = { ...students[0], experienceLevel: "advanced", ridingStyles: ["Western"] };
  assert.equal(getEligibleHorses(western, lt, [horses[1]]).length, 0, "no style overlap");

  const heavy = { ...students[0], weight: 190 };
  assert.equal(getEligibleHorses(heavy, lt, [horses[0]]).length, 0, "over max rider weight");

  const excluded = { ...students[0], noRideHorses: ["buttercup"] };
  assert.equal(getEligibleHorses(excluded, lt, [horses[0]]).length, 0, "no-ride list");
});

test("a student at exactly the horse's minimum experience is eligible", () => {
  const exact = { ...students[0], experienceLevel: "advanced" };
  assert.equal(getEligibleHorses(exact, lessonTypes[0], [horses[1]]).length, 1);
});

// ---------------------------------------------------------------- check 6: double-booking
test("overlap is by interval, not by identical start time", () => {
  const bookings = [F.booking({ date: d(19), start: "09:30" })]; // 09:30-10:30
  const v = validateBooking(F.request({ date: d(19), start: "10:00", bookings }));
  assert.ok(fails(v, "horse_free"));
});

test("back-to-back lessons on the same horse do not conflict", () => {
  const bookings = [F.booking({ date: d(19), start: "09:00" })]; // 09:00-10:00
  const v = validateBooking(F.request({ date: d(19), start: "10:00", bookings }));
  assert.ok(!fails(v, "horse_free"));
  assert.ok(!fails(v, "trainer_free"));
});

test("a cancelled booking releases its slot", () => {
  const bookings = [F.booking({ date: d(19), start: "10:00", status: "early_cancel" })];
  const v = validateBooking(F.request({ date: d(19), start: "10:00", bookings }));
  assert.ok(!fails(v, "horse_free"));
});

test("group session: trainer conflict relaxes, horse conflict does not", () => {
  const group = lessonTypes[1];
  const existing = [
    F.booking({
      lessonTypeId: "group90",
      horseId: "atlas",
      date: d(19),
      start: "10:00",
      studentId: "jordan",
    }),
  ];
  const joining = validateBooking(
    F.request({
      lessonType: group,
      horse: horses[0],
      date: d(19),
      start: "10:00",
      bookings: existing,
    })
  );
  assert.ok(!fails(joining, "trainer_free"), "room in the group");
  assert.ok(!fails(joining, "horse_free"), "different horse");

  const sameHorse = validateBooking(
    F.request({
      lessonType: group,
      horse: horses[1],
      student: { ...students[0], experienceLevel: "advanced" },
      date: d(19),
      start: "10:00",
      bookings: existing,
    })
  );
  assert.ok(fails(sameHorse, "horse_free"), "every rider needs their own horse");
});

test("a full group stops accepting riders", () => {
  const existing = [1, 2, 3].map((i) =>
    F.booking({ lessonTypeId: "group90", horseId: "h" + i, date: d(19), start: "10:00" })
  );
  const v = validateBooking(
    F.request({ lessonType: lessonTypes[1], date: d(19), start: "10:00", bookings: existing })
  );
  assert.ok(fails(v, "trainer_free"), "maxGroupSize is 3");
});

test("a group session is exactly type + date + start", () => {
  const key = { lessonTypeId: "group90", date: d(19), start: "10:00" };
  const rows = [
    F.booking({ lessonTypeId: "group90", date: d(19), start: "10:00" }),
    F.booking({ lessonTypeId: "group90", date: d(19), start: "11:00" }), // different slot
    F.booking({ lessonTypeId: "private60", date: d(19), start: "10:00" }), // different type
  ];
  assert.equal(groupRoster(rows, key).length, 1);
});

// ---------------------------------------------------------------- check 7: pricing
test("price is base + band - frequency - offer + manual", () => {
  const q = priceFor({
    student: { ...students[0], frequencyTier: 1 },
    lessonType: lessonTypes[0],
    date: d(19),
    start: "16:00", // evening band, +10
    offerDiscount: 0,
    manualAdjustment: 0,
    priceBands,
    trainerConfig,
  });
  assert.equal(q.basePrice, 60);
  assert.equal(q.bandAdjustment, 10);
  assert.equal(q.frequencyDiscount, 5);
  assert.equal(q.price, 65);
});

test("a band matches on start time alone, not on overlap", () => {
  // 14:30 + 60 min runs into the 15:00 band but starts outside it.
  const q = priceFor({
    student: students[0],
    lessonType: lessonTypes[0],
    date: d(19),
    start: "14:30",
    priceBands,
    trainerConfig,
  });
  assert.equal(q.bandAdjustment, 0);
});

test("the floor is announced, not applied quietly", () => {
  const q = priceFor({
    student: { ...students[0], frequencyTier: 2 },
    lessonType: lessonTypes[0],
    date: d(19),
    start: "10:00",
    offerDiscount: 15,
    priceBands,
    trainerConfig,
  });
  assert.equal(q.raw, 35, "60 - 10 - 15");
  assert.equal(q.price, 55, "clamped to minPrice");
  assert.equal(q.flooredBy, 20, "and the amount is reported");
});

test("discounts stack against a premium base; premiums do not compound", () => {
  const q = priceFor({
    student: { ...students[0], frequencyTier: 1 },
    lessonType: lessonTypes[0],
    date: d(19),
    start: "16:00",
    offerDiscount: 5,
    priceBands,
    trainerConfig,
  });
  assert.equal(q.raw, 60);
  assert.equal(q.price, 60);
});

test("every produced price is a whole number", () => {
  for (const tier of [0, 1, 2]) {
    for (const start of ["09:00", "16:00"]) {
      const q = priceFor({
        student: { ...students[0], frequencyTier: tier },
        lessonType: lessonTypes[0],
        date: d(19),
        start,
        priceBands,
        trainerConfig,
      });
      assert.ok(Number.isInteger(q.price), `${tier}/${start} produced ${q.price}`);
    }
  }
});

test("blank tier thresholds switch frequency pricing off entirely", () => {
  const q = priceFor({
    student: { ...students[0], frequencyTier: 2 },
    lessonType: lessonTypes[0],
    date: d(19),
    start: "10:00",
    priceBands,
    trainerConfig: { ...trainerConfig, freqTier1MinRides: null },
  });
  assert.equal(q.frequencyDiscount, 0);
  assert.equal(q.price, 60);
});

test("bands may not overlap on a shared day", () => {
  const clash = { id: "new", days: [2], start: "16:00", end: "18:00" };
  assert.ok(bandOverlap(clash, priceBands));
  const noClash = { id: "new", days: [0, 6], start: "16:00", end: "18:00" };
  assert.equal(bandOverlap(noClash, priceBands), null);
});

// ---------------------------------------------------------------- ordering and commit
test("checks report in specification order", () => {
  const v = validateBooking(F.request());
  assert.deepEqual(
    v.checks.map((c) => c.code),
    [
      "trainer_available",
      "horse_active",
      "rest_day",
      "usage_cap",
      "pairing",
      "horse_free",
      "trainer_free",
      "price_in_range",
    ]
  );
});

test("every check is evaluated even when an early one fails", () => {
  const v = validateBooking(F.request({ horse: horses[2], start: "20:00" }));
  assert.equal(v.checks.length, 8, "no short-circuiting — the checklist shows everything");
  assert.equal(firstFailure(v).code, "trainer_available");
});

test("a clean request passes", () => {
  const v = validateBooking(F.request());
  assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.pass)));
  assert.equal(firstFailure(v), null);
});

// ---------------------------------------------------------------- frequency tiers
test("tier is the better of the two prior completed months — the ratchet", () => {
  const ride = (month, day) =>
    F.booking({ date: new Date(2026, month, day), status: "completed", isBillable: true });
  // June (month 5): 12 rides. July (month 6): 2 rides.
  const bookings = [
    ...Array.from({ length: 12 }, (_, i) => ride(5, i + 1)),
    ...Array.from({ length: 2 }, (_, i) => ride(6, i + 1)),
  ];
  assert.equal(earnedTier("maya", bookings, trainerConfig, NOW), 2, "a bad month can't drop it");
});

test("a good month raises the tier at once", () => {
  const bookings = Array.from({ length: 8 }, (_, i) =>
    F.booking({ date: new Date(2026, 6, i + 1), status: "completed" })
  );
  assert.equal(earnedTier("maya", bookings, trainerConfig, NOW), 1);
});

test("late cancels count toward the tier; early cancels do not", () => {
  const late = Array.from({ length: 8 }, (_, i) =>
    F.booking({ date: new Date(2026, 6, i + 1), status: "late_cancel", isBillable: true })
  );
  assert.equal(billableRidesInMonth("maya", late, 2026, 6, NOW), 8);

  const early = late.map((b) => ({ ...b, status: "early_cancel", isBillable: false }));
  assert.equal(billableRidesInMonth("maya", early, 2026, 6, NOW), 0);
});

test("a blank tier-1 threshold means no tier at any ride count", () => {
  assert.equal(tierFromRides(99, { ...trainerConfig, freqTier1MinRides: null }), 0);
});

// ---------------------------------------------------------------- time-dependent behaviour
test("effectiveStatus derives completion from a passed date", () => {
  assert.equal(effectiveStatus(F.booking({ date: d(17) }), NOW), "completed");
  assert.equal(effectiveStatus(F.booking({ date: d(19) }), NOW), "confirmed");
  assert.equal(
    effectiveStatus(F.booking({ date: d(17), status: "no_show" }), NOW),
    "no_show",
    "an explicit outcome is never overwritten"
  );
});

test("cancel disposition turns on the 24-hour boundary, to the minute", () => {
  // NOW is Tue 18th 07:00. Notice is 24h, so the boundary is Wed 19th 07:00.
  const justOutside = F.booking({ date: d(19), start: "07:30" });
  const justInside = F.booking({ date: d(19), start: "06:30" });
  assert.equal(cancelDisposition(justOutside, trainerConfig, NOW).kind, "early_cancel");
  assert.equal(cancelDisposition(justInside, trainerConfig, NOW).kind, "late_cancel");
  assert.equal(cancelDisposition(justInside, trainerConfig, NOW).billable, true);
});

test("a lesson later today is still cancellable, just not for free", () => {
  const later = F.booking({ date: d(18), start: "16:00" });
  assert.equal(cancelDisposition(later, trainerConfig, NOW).kind, "late_cancel");
});

test("a started lesson offers no cancellation", () => {
  const started = F.booking({ date: d(18), start: "06:00" });
  assert.equal(minutesUntil(started, NOW), -60);
  assert.equal(cancelDisposition(started, trainerConfig, NOW), null);
});

test("the engine has no ambient clock — moving now moves the answer", () => {
  const b = F.booking({ date: d(19), start: "10:00" });
  const monday = clockAt(d(17), 7 * 60);
  const wednesday = clockAt(d(19), 12 * 60);
  assert.equal(cancelDisposition(b, trainerConfig, monday).kind, "early_cancel");
  assert.equal(cancelDisposition(b, trainerConfig, wednesday), null);
});

// ---------------------------------------------------------------- derivations
test("occurrence type and horse assignment are independent", () => {
  const recurring = [{ id: "r1", day: 3, start: "10:00", horseId: "buttercup" }];
  const onSubstitute = F.booking({ recurringId: "r1", date: d(19), start: "10:00", horseId: "atlas" });

  assert.equal(occurrenceType(onSubstitute, recurring, lessonTypes), "recurring");
  const a = horseAssignment(onSubstitute, recurring, horses);
  assert.equal(a.isSubstitute, true);
  assert.equal(a.dominantHorse.id, "buttercup", "the dominant horse is still shown");
});

test("needs-substitute is a third flag, not a fourth type", () => {
  const recurring = [{ id: "r1", day: 3, start: "10:00", horseId: "retired" }];
  const b = F.booking({ recurringId: "r1", date: d(19), start: "10:00", horseId: "retired" });
  assert.equal(occurrenceType(b, recurring, lessonTypes), "recurring");
  const a = horseAssignment(b, recurring, horses);
  assert.equal(a.needsSub, true);
  assert.equal(a.isSubstitute, false);
});

test("an occurrence moved off its pattern reads as ad hoc", () => {
  const recurring = [{ id: "r1", day: 3, start: "10:00", horseId: "buttercup" }];
  const moved = F.booking({ recurringId: "r1", date: d(20), start: "10:00" }); // Thursday
  assert.equal(occurrenceType(moved, recurring, lessonTypes), "adhoc");
  assert.equal(horseAssignment(moved, recurring, horses).isOrphan, true);
});

// ---------------------------------------------------------------------------
// Added after a shared-horse defect: an unmeasurable lesson must never read as free.
// ---------------------------------------------------------------------------

test("a booking's STORED end wins over its lesson type's duration", () => {
  // The booking is the fact; the lesson type is a reconstruction of it. Editing a type's
  // duration in November must not resize October's lessons, and this is where that bites.
  const long = F.booking({ date: d(19), start: "10:00", end: "12:00", lessonTypeId: "private60" });
  const v = validateBooking(F.request({ date: d(19), start: "11:00", bookings: [long] }));
  assert.ok(fails(v, "horse_free"), "11:00 is inside the stored 10:00-12:00, not the type's hour");
});

test("an unreadable lesson type counts as a CONFLICT, never as zero minutes", () => {
  // The hole this closes: `bStart + (bLt ? bLt.durationMin : 0)` gave an unresolvable type zero
  // duration, so it overlapped nothing and the horse read as FREE. Lesson types are
  // trainer-scoped, so this is the ordinary case on a horse two coaches share.
  const barnMate = F.booking({ date: d(19), start: "10:00", lessonTypeId: "another-coaches-type" });
  delete barnMate.end;
  const v = validateBooking(F.request({ date: d(19), start: "10:00", bookings: [barnMate] }));
  assert.ok(fails(v, "horse_free"),
    "an unmeasurable lesson must not read as free — a refusal is recoverable, a double-booking is not");
});

test("failing safe does not mean failing always: a cancelled unreadable lesson frees its slot", () => {
  const cancelled = F.booking({
    date: d(19), start: "10:00", lessonTypeId: "another-coaches-type", status: "early_cancel",
  });
  delete cancelled.end;
  const v = validateBooking(F.request({ date: d(19), start: "10:00", bookings: [cancelled] }));
  assert.ok(!fails(v, "horse_free"));
});
