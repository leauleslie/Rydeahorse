// The mapping layer, tested without a database.
//
// These are the conversions that would otherwise fail silently. Every case below is one where
// the wrong answer produces no error at all — a NaN, an empty result, or a price that is
// merely different — which is why they are pinned individually rather than left to the
// end-to-end test to catch in aggregate.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  toDate, toHHMM, toEngineHorse, toEngineStudent, toEngineLessonType,
  toEngineBooking, toEngineAvailability, toEngineTimeOff, toEnginePriceBands,
  toEngineTrainerConfig,
} from "../repo/to-engine.js";

describe("dates", () => {
  test("a date column becomes LOCAL midnight, not UTC midnight", () => {
    // The bug this prevents: `new Date("2026-09-15")` parses as UTC and, anywhere west of
    // Greenwich, is the 14th locally. getDay() then returns Monday for a Tuesday lesson, the
    // availability check fails, and nothing throws.
    const d = toDate("2026-09-15");
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 8, "September is month 8");
    assert.equal(d.getDate(), 15);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getDay(), 2, "2026-09-15 is a Tuesday");
  });

  test("a Date is passed through untouched, so double-mapping is safe", () => {
    const d = new Date(2026, 8, 15);
    assert.equal(toDate(d), d);
  });

  test("null stays null rather than becoming the epoch", () => {
    assert.equal(toDate(null), null);
  });
});

describe("times", () => {
  test("a time column loses its seconds", () => {
    assert.equal(toHHMM("09:00:00"), "09:00");
    assert.equal(toHHMM("16:30:00"), "16:30");
  });
  test("an already-trimmed time is unchanged", () => {
    assert.equal(toHHMM("09:00"), "09:00");
  });
});

describe("horses", () => {
  const row = {
    id: "h1", name: "Comet", active: true, minExperienceLevel: "beginner", adultOnly: false,
    ridingStyles: ["English"], maxRiderWeightLbs: 180, restDaysPerWeek: 1,
    maxDailyMinutesAdult: 120, maxDailyMinutesOverall: 180,
  };

  test("every renamed field lands where the engine looks for it", () => {
    const h = toEngineHorse(row);
    assert.equal(h.minExp, "beginner");
    assert.deepEqual(h.styles, ["English"]);
    assert.equal(h.maxWeight, 180);
    assert.equal(h.maxDailyAdult, 120);
    assert.equal(h.maxDailyOverall, 180);
  });

  test("an absent cap is Infinity, NOT zero", () => {
    // Null means "this horse carries no stated limit". Mapping it to 0 would make the engine
    // reject every rider and every lesson on that horse — a total outage expressed as a
    // perfectly ordinary failed check.
    const h = toEngineHorse({ ...row, maxRiderWeightLbs: null, maxDailyMinutesAdult: null, maxDailyMinutesOverall: null });
    assert.equal(h.maxWeight, Infinity);
    assert.equal(h.maxDailyAdult, Infinity);
    assert.equal(h.maxDailyOverall, Infinity);
    assert.ok(!(200 > h.maxWeight), "a heavy rider must still pass an unlimited horse");
  });
});

describe("students", () => {
  const row = { id: "s1", name: "Alex", age: 34, experienceLevel: "intermediate", ridingStyles: ["English"], weight: 140, frequencyTier: 1 };

  test("the no-ride list arrives as an array the engine can call .includes on", () => {
    const s = toEngineStudent(row, { noRideHorseIds: ["h9"] });
    assert.deepEqual(s.noRideHorses, ["h9"]);
    // Undefined here would throw inside getEligibleHorses rather than fail a check.
    assert.deepEqual(toEngineStudent(row).noRideHorses, []);
  });

  test("an unstated weight is 0, the opposite default from a horse's cap", () => {
    // The comparison is `student.weight > horse.maxWeight`, so the permissive value for a
    // student is the low end and for a horse the high end. Same idea, opposite direction.
    assert.equal(toEngineStudent({ ...row, weight: null }).weight, 0);
  });

  test("a null tier is 0, so pricing treats it as no tier rather than crashing", () => {
    assert.equal(toEngineStudent({ ...row, frequencyTier: null }).frequencyTier, 0);
  });
});

describe("lesson types", () => {
  const row = {
    id: "lt1", name: "Private", durationMin: 60, rideTimeMin: 45, basePrice: 60,
    minPrice: 55, maxPrice: 90, frequencyDiscount1: 5, frequencyDiscount2: 10,
    ridingStyles: [], isGroup: false, maxGroupSize: null, isIntro: false,
  };

  test("the two junctions become the inline fields pricing and pairing index into", () => {
    const lt = toEngineLessonType(row, { bandAdjustments: { peak: 10 }, restrictedHorseIds: ["h1"] });
    assert.deepEqual(lt.bandAdjustments, { peak: 10 });
    assert.deepEqual(lt.restrictedHorseIds, ["h1"]);
    assert.equal(lt.freqDiscount1, 5);
    assert.equal(lt.freqDiscount2, 10);
  });

  test("absent junctions are {} and [], never undefined", () => {
    const lt = toEngineLessonType(row);
    assert.deepEqual(lt.bandAdjustments, {}, "pricing indexes into this");
    assert.deepEqual(lt.restrictedHorseIds, []);
  });

  test("isIntro is carried as a flag, so nothing downstream compares against an id", () => {
    assert.equal(toEngineLessonType({ ...row, isIntro: true }).isIntro, true);
  });
});

describe("availability and time off", () => {
  test("day_of_week enums become the indices Date#getDay() returns", () => {
    const rows = [
      { dayOfWeek: "sun", startTime: "09:00:00", endTime: "17:00:00" },
      { dayOfWeek: "tue", startTime: "09:00:00", endTime: "17:00:00" },
      { dayOfWeek: "sat", startTime: "09:00:00", endTime: "17:00:00" },
    ];
    assert.deepEqual(toEngineAvailability(rows).map((a) => a.day), [0, 2, 6]);
    // The mapping is only correct if it agrees with the thing the engine compares against.
    assert.equal(new Date(2026, 8, 15).getDay(), toEngineAvailability([rows[1]])[0].day);
  });

  test("time off dates become Dates, since the engine compares them with >=", () => {
    const [t] = toEngineTimeOff([{ startDate: "2026-12-24", endDate: "2026-12-26", reason: "Holiday" }]);
    assert.ok(t.startDate instanceof Date);
    assert.ok(new Date(2026, 11, 25) >= t.startDate && new Date(2026, 11, 25) <= t.endDate);
  });
});

describe("price bands", () => {
  const bands = [{ id: "peak", name: "Peak" }];

  test("windows sharing a time collapse into one band with several days", () => {
    const out = toEnginePriceBands(bands, [
      { bandId: "peak", dayOfWeek: "mon", startTime: "16:00:00", endTime: "19:00:00" },
      { bandId: "peak", dayOfWeek: "tue", startTime: "16:00:00", endTime: "19:00:00" },
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { id: "peak", name: "Peak", days: [1, 2], start: "16:00", end: "19:00" });
  });

  test("a band whose windows differ by day becomes several entries SHARING its id", () => {
    // The engine's band shape has one start/end, so a band with two time ranges cannot be one
    // entry. Splitting keeps both ranges; the shared id keeps both resolving to the same
    // premium, because `bandAdjustments` is keyed by band id. Collapsing to one entry would
    // silently misprice every day whose window was discarded.
    const out = toEnginePriceBands(bands, [
      { bandId: "peak", dayOfWeek: "mon", startTime: "16:00:00", endTime: "19:00:00" },
      { bandId: "peak", dayOfWeek: "sat", startTime: "08:00:00", endTime: "12:00:00" },
    ]);
    assert.equal(out.length, 2);
    assert.ok(out.every((b) => b.id === "peak"), "both must keep the band's id");
    assert.deepEqual(out.map((b) => b.start).sort(), ["08:00", "16:00"]);
  });

  test("a window whose band is missing is dropped rather than producing a nameless band", () => {
    const out = toEnginePriceBands([], [{ bandId: "gone", dayOfWeek: "mon", startTime: "16:00:00", endTime: "19:00:00" }]);
    assert.deepEqual(out, []);
  });
});

describe("trainer config", () => {
  test("blank frequency tiers stay null, which is how the mechanism ships switched off", () => {
    // 0 would mean "every rider qualifies for tier 1" — turning a disabled feature into a
    // universal discount.
    const c = toEngineTrainerConfig({ frequencyTier1MinRides: null, frequencyTier2MinRides: null, minBufferMin: 0, lateCancelHours: 24 });
    assert.equal(c.freqTier1MinRides, null);
    assert.equal(c.freqTier2MinRides, null);
  });

  test("configured tiers are renamed to what pricing reads", () => {
    const c = toEngineTrainerConfig({ frequencyTier1MinRides: 8, frequencyTier2MinRides: 12, minBufferMin: 15, lateCancelHours: 24 });
    assert.equal(c.freqTier1MinRides, 8);
    assert.equal(c.freqTier2MinRides, 12);
  });
});

describe("bookings", () => {
  test("a booking row becomes what the engine's own booking fixture looks like", () => {
    const b = toEngineBooking({
      id: "b1", studentId: "s1", horseId: "h1", lessonTypeId: "lt1",
      date: "2026-09-15", startTime: "09:00:00", status: "confirmed", isBillable: true,
    });
    assert.equal(b.start, "09:00", "the engine's field is `start`, not `startTime`");
    assert.ok(b.date instanceof Date);
    assert.equal(b.date.getDay(), 2);
  });

  test("the series a lesson belongs to survives the mapping", () => {
    // `derive.js` answers "why does this lesson exist" from `recurringId` alone, so a mapping
    // that drops it reports every lesson in the database as ad hoc and every recurring screen
    // as empty — silently, because absent and null are the same answer to `if (!recurringId)`.
    const row = {
      id: "b1", studentId: "s1", horseId: "h1", lessonTypeId: "lt1",
      date: "2026-09-15", startTime: "09:00:00", status: "confirmed", isBillable: true,
    };
    assert.equal(
      toEngineBooking({ ...row, recurringId: "rec1" }).recurringId, "rec1",
      "a lesson in a standing series must arrive carrying the series id",
    );
    // And the other direction, which is what made the bug invisible: a one-off really does
    // have no series, so `null` here has to mean "booked on its own" rather than "not mapped".
    assert.equal(toEngineBooking({ ...row, recurringId: null }).recurringId, null);
  });
});
