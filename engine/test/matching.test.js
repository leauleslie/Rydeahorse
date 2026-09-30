// Slot finding and matching. These answer "what should we suggest?", so the failures that
// matter are not crashes — they are suggestions that turn out to be unbookable, times nobody
// asked for, and patterns that work once and then stop.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  potentialLessonTypes, defaultLessonType, coachBusyIntervals, offerRespectsPreferences,
  findOpenSlots, eligibleStudentsForSlot, windowCovers, offerStats,
  findIntroOptions, findRecurringOptions,
} from "../matching.js";
import { validateBooking } from "../rules.js";
import {
  NOW, d, horses, students, lessonTypes, introType, priceBands, trainerConfig,
  availability, timeOffBlocks, booking,
} from "./fixtures.js";

// Tue 18 Aug 2026 at 07:00. d(18) is that Tuesday; d(19) the Wednesday.
const TUE = d(18);
const WED = d(19);
const ctx = { horses, lessonTypes, students, availability, timeOffBlocks, priceBands, trainerConfig };
const spaced = { ...trainerConfig, schedulingPreference: "spaced" };

describe("which lesson types can be offered", () => {
  test("a group type is never gap-fill, even with the flag set", () => {
    // The fixture sets potentialEligible on the group type deliberately, so this asserts the
    // rule rather than the fixture.
    const types = potentialLessonTypes(lessonTypes);
    assert.deepEqual(types.map((t) => t.id), ["private60"]);
  });

  test("the default recurring type is an ordinary private lesson", () => {
    assert.equal(defaultLessonType([introType, ...lessonTypes]).id, "private60");
    assert.equal(defaultLessonType([introType]).id, "intro45", "falls back rather than returning null");
    assert.equal(defaultLessonType([]), null);
  });
});

describe("the coach's busy day", () => {
  test("a lesson's end is read from the booking, not reconstructed from its type", () => {
    // The prototype did `lessonTypes.find(...)?.durationMin || 60`, which guesses an hour for
    // any booking whose type it cannot see — and on a horse shared between two coaches, it
    // cannot see the barn-mate's type at all.
    const withEnd = booking({ date: TUE, start: "10:00", end: "11:30", lessonTypeId: "unknown-to-us" });
    const [interval] = coachBusyIntervals(TUE, [withEnd], lessonTypes);
    assert.equal(interval.end, 11 * 60 + 30, "90 minutes, as the booking says");
  });

  test("a cancelled lesson is not busy", () => {
    const cancelled = booking({ date: TUE, start: "10:00", status: "early_cancel" });
    assert.deepEqual(coachBusyIntervals(TUE, [cancelled], lessonTypes), []);
  });
});

describe("offering respects how the coach arranges a day", () => {
  const existing = [booking({ date: TUE, start: "10:00" })]; // 10:00-11:00

  test("the minimum buffer is required on both sides", () => {
    const at = (start, durationMin = 60) =>
      offerRespectsPreferences({ date: TUE, startMin: start, durationMin, bookings: existing, lessonTypes, trainerConfig: spaced });
    // minBufferMin is 15 in the fixture.
    assert.equal(at(9 * 60 + 30), false, "ends 10:30, overlapping");
    assert.equal(at(8 * 60 + 45), true, "ends 09:45, a clear 15 minutes before");
    assert.equal(at(11 * 60), false, "starts the moment the lesson ends — no buffer");
    assert.equal(at(11 * 60 + 15), true, "starts 15 minutes after");
  });

  test("the back-to-back cap only binds under a back-to-back preference", () => {
    // Three consecutive lessons already; maxBackToBack is 4 in the fixture.
    const run = [
      booking({ date: TUE, start: "08:00" }),
      booking({ date: TUE, start: "09:00" }),
      booking({ date: TUE, start: "10:00" }),
    ];
    // minBufferMin is zeroed for this test on purpose. The fixture's 15-minute buffer rejects
    // an 11:00 start outright — it butts against a lesson ending at 11:00 — so with it left in
    // place every variant below would return false and the assertions would agree for a reason
    // that has nothing to do with the streak cap.
    const packed = { ...trainerConfig, minBufferMin: 0, maxBufferMin: 30 };
    const ask = (cfg) =>
      offerRespectsPreferences({ date: TUE, startMin: 11 * 60, durationMin: 60, bookings: run, lessonTypes, trainerConfig: cfg });

    assert.equal(ask({ ...packed, maxBackToBack: 3 }), false, "a fourth would exceed the cap");
    assert.equal(ask({ ...packed, maxBackToBack: 9 }), true, "well under the cap");
    // Spaced scheduling is not trying to pack lessons, so the maximum has nothing to prevent.
    assert.equal(ask({ ...packed, schedulingPreference: "spaced", maxBackToBack: 3 }), true,
      "the cap does not apply when spaced");
  });
});

describe("finding open slots", () => {
  const open = (over = {}) =>
    findOpenSlots({ date: TUE, now: NOW, bookings: [], ...ctx, trainerConfig: spaced, ...over });

  test("a day with no availability yields nothing", () => {
    assert.deepEqual(open({ date: d(23) }), [], "Sunday is not in the fixture's availability");
  });

  test("time off closes the day even when availability says otherwise", () => {
    const off = [{ startDate: d(17), endDate: d(19) }];
    assert.deepEqual(open({ timeOffBlocks: off }), []);
  });

  test("a slot is one WINDOW, not one per horse", () => {
    // Two horses qualify at 09:00, and that must still be a single entry — a coach reading
    // "6 open" should not be seeing the same 9am three times.
    const slots = open();
    const nine = slots.filter((s) => s.time === "09:00");
    assert.equal(nine.length, 1);
    assert.ok(nine[0].horseIds.length >= 1);
    assert.ok(nine[0].options.every((o) => o.lessonTypeId === "private60"),
      "only gap-fill-eligible types are offered");
  });

  test("a horse already booked across the slot is excluded", () => {
    const busy = [booking({ date: TUE, start: "09:00", horseId: "buttercup" })];
    const nine = open({ bookings: busy }).find((s) => s.time === "09:00");
    assert.ok(!nine || !nine.horseIds.includes("buttercup"), "buttercup is mid-lesson at 09:00");
  });

  test("an inactive horse is never offered", () => {
    for (const slot of open()) {
      assert.ok(!slot.horseIds.includes("retired"), "the retired horse must not appear");
    }
  });

  test("slots come back in time order", () => {
    const times = open().map((s) => s.time);
    assert.deepEqual([...times].sort(), times);
  });

  // The two lists are the whole reason this function takes two lists, and until these existed
  // nothing in the suite told them apart — every other test here leaves `trainerBookings`
  // defaulting to `bookings`, which is precisely the case that cannot detect a confusion
  // between them. The screens shipped the bug these pin: one list fed to both halves.
  test("a horse the barn-mate is riding is not offered, though this coach's day is free", () => {
    // Another trainer in the same account has buttercup at 09:00. It never appears in THIS
    // coach's bookings, and a horse is one animal however many coaches share it.
    const barn = [booking({ date: TUE, start: "09:00", horseId: "buttercup" })];
    const nine = open({ bookings: barn, trainerBookings: [] }).find((s) => s.time === "09:00");
    assert.ok(!nine || !nine.horseIds.includes("buttercup"),
      "buttercup is mid-lesson at 09:00, for someone else");
  });

  test("the barn-mate's lesson does not make this coach look busy", () => {
    // The converse, and the reason the fix is not simply passing the barn's list to both: the
    // coach's own day is their own. Another trainer teaching at 09:00 must not close this
    // coach's 09:00 for every OTHER horse, or one barn's bookings would black out the other's.
    const barn = [booking({ date: TUE, start: "09:00", horseId: "buttercup" })];
    const nine = open({ bookings: barn, trainerBookings: [] }).find((s) => s.time === "09:00");
    assert.ok(nine, "09:00 is still an open window — this coach is not the one teaching");
    assert.ok(nine.horseIds.length >= 1, "the horses nobody is riding are still offerable");
  });
});

describe("who to offer a slot to", () => {
  const slot = { time: "09:00", options: [{ lessonTypeId: "private60", horseIds: ["buttercup"] }], horseIds: ["buttercup"] };
  const ask = (over = {}) =>
    eligibleStudentsForSlot({
      date: TUE, time: "09:00", slot, bookings: [], offers: [], ...ctx, trainerConfig: spaced, ...over,
    });

  test("a student whose windows do not cover the time is not offered it", () => {
    // Offering a time nobody asked for is the fastest way to teach riders to ignore the
    // messages. Wednesday 09:00 is inside nobody's Tuesday window.
    const rows = eligibleStudentsForSlot({
      date: WED, time: "09:00", slot, bookings: [], offers: [], ...ctx, trainerConfig: spaced,
    });
    assert.deepEqual(rows.map((r) => r.student.id), []);
  });

  test("everything offered is actually bookable, not merely plausible", () => {
    for (const row of ask()) {
      const v = validateBooking({
        student: row.student, horse: row.horse, lessonType: row.lessonType,
        date: TUE, start: "09:00", bookings: [], ...ctx, trainerConfig: spaced,
      });
      assert.equal(v.ok, true, `${row.student.name} was offered a slot that does not validate`);
    }
  });

  test("a student already booked at that time is skipped", () => {
    const rows = ask({ bookings: [booking({ date: TUE, start: "09:00", studentId: "maya" })] });
    assert.ok(!rows.some((r) => r.student.id === "maya"));
  });

  test("target matches rank above potential ones", () => {
    // Maya's Tuesday 09:00 is a target window; Jordan's covers it too. Ranking is what decides
    // who gets the full-price offer first.
    const rows = ask();
    const kinds = rows.map((r) => r.kind);
    assert.deepEqual([...kinds].sort(), kinds, "target ('potential' sorts after) comes first");
  });

  test("target_only suppresses a potential-window match", () => {
    // Jordan is target_only and their POTENTIAL window covers Tuesday 13:00.
    const rows = ask({ time: "13:00", slot: { ...slot, time: "13:00" } });
    assert.ok(!rows.some((r) => r.student.id === "jordan"),
      "a target_only student must not be offered a potential-window slot");
  });

  test("an inactive or unapproved profile is never a candidate", () => {
    const shadow = students.map((s) => ({ ...s, profileStatus: "pending_review" }));
    assert.deepEqual(ask({ students: shadow }), []);
  });

  test("nobody is offered a slot whose only horse the barn-mate is riding", () => {
    // The same two-list confusion as findOpenSlots, one layer up and quieter: the slot names
    // buttercup, another trainer has buttercup, and this coach's own list cannot see it. The
    // candidate rows would each be a real offer sent to a real rider for a horse that is busy.
    const barn = [booking({ date: TUE, start: "09:00", horseId: "buttercup" })];
    const rows = ask({ bookings: barn, trainerBookings: [] });
    assert.deepEqual(rows, [], "buttercup is mid-lesson at 09:00, for someone else");
  });

  test("a previous offer for the same slot is flagged, not hidden", () => {
    // The coach decides whether to ask twice; the list just has to say so.
    const offers = [{ studentId: "maya", date: TUE, start: "09:00" }];
    const row = ask({ offers }).find((r) => r.student.id === "maya");
    assert.ok(row, "still a candidate");
    assert.equal(row.alreadyOffered, true);
  });
});

describe("offer statistics", () => {
  test("a student with no history sits at a neutral 0.5, not at zero", () => {
    // Otherwise newcomers are buried beneath everyone who has ever said yes.
    assert.equal(offerStats("nobody", { offers: [], bookings: [] }).score, 0.5);
  });

  test("an accepted offer is derived from a matching booking, never stored", () => {
    const offers = [{ studentId: "maya", date: TUE, start: "09:00" }];
    const taken = [booking({ date: TUE, start: "09:00", studentId: "maya" })];
    assert.equal(offerStats("maya", { offers, bookings: taken }).accepted, 1);
    assert.equal(offerStats("maya", { offers, bookings: [] }).accepted, 0);
  });

  test("a cancelled booking does not count as an acceptance", () => {
    const offers = [{ studentId: "maya", date: TUE, start: "09:00" }];
    const cancelled = [booking({ date: TUE, start: "09:00", studentId: "maya", status: "early_cancel" })];
    assert.equal(offerStats("maya", { offers, bookings: cancelled }).accepted, 0);
  });
});

describe("intro options for a new rider", () => {
  const intro = (over = {}) =>
    findIntroOptions({
      student: students[0], now: NOW, bookings: [], ...ctx,
      lessonTypes: [introType, ...lessonTypes], trainerConfig: spaced, ...over,
    });

  test("a coach with no intro type simply has none to offer", () => {
    assert.deepEqual(intro({ lessonTypes }), []);
  });

  test("options are bookable and honour the limit", () => {
    const out = intro({ limit: 3 });
    assert.equal(out.length, 3);
    for (const o of out) assert.ok(o.date instanceof Date && o.start && o.horseId);
  });

  test("the clock is a parameter — nothing is offered before `now`", () => {
    // The prototype read a module-level TODAY, which is why this boundary could not be tested
    // at all.
    const later = new Date(2026, 8, 1); // 1 Sep 2026
    for (const o of intro({ now: later, limit: 5 })) {
      assert.ok(o.date >= later, `${o.date.toDateString()} is before the clock it was given`);
    }
  });

  test("the horizon is a parameter, so a fruitless search is bounded", () => {
    const none = intro({ horizonDays: 0 });
    assert.deepEqual(none, []);
  });

  test("a horse the barn-mate is riding is not offered to a new rider either", () => {
    // A first lesson is the worst one to have to take back, so the barn's list matters most
    // here. Every option the unblocked search returns is re-offered from the barn's side with
    // that exact horse, date and time already taken by the OTHER coach — this coach's own day
    // stays empty throughout, so only the barn list can rule it out.
    const clean = intro({ limit: 5 });
    assert.ok(clean.length, "the fixture must offer something for this test to mean anything");

    for (const o of clean) {
      const barn = [booking({ date: o.date, start: o.start, horseId: o.horseId })];
      const out = intro({ bookings: barn, trainerBookings: [], limit: 20 });
      const stillOffered = out.some(
        (x) => x.horseId === o.horseId && x.start === o.start &&
               x.date.toDateString() === o.date.toDateString(),
      );
      assert.ok(!stillOffered,
        `${o.horseId} at ${o.start} on ${o.date.toDateString()} is the barn-mate's, yet was offered`);
    }
  });
});

describe("recurring options", () => {
  const recurring = (over = {}) =>
    findRecurringOptions({
      student: students[0], now: NOW, bookings: [], ...ctx, trainerConfig: spaced, ...over,
    });

  test("every option carries the window kind it came from", () => {
    for (const o of recurring({ limit: 5 })) {
      assert.ok(["target", "potential"].includes(o.kind));
      assert.equal(typeof o.day, "number");
    }
  });

  test("a pattern blocked in a LATER week is not offered", () => {
    // The whole point. Checking only the first occurrence is the obvious implementation and
    // the wrong one: a weekly pattern that works once is not a pattern, and the rider finds
    // out three weeks later.
    const open = recurring({ limit: 20 });
    assert.ok(open.length > 0, "there is something to block");
    const target = open[0];

    // Block the THIRD occurrence of that exact slot by booking every horse's time with the
    // coach — a trainer conflict two weeks out.
    const third = new Date(NOW);
    while (third.getDay() !== target.day) third.setDate(third.getDate() + 1);
    third.setDate(third.getDate() + 14);

    const blocked = recurring({
      limit: 20,
      bookings: [booking({ date: third, start: target.start, horseId: target.horseId, studentId: "jordan" })],
    });
    assert.ok(
      !blocked.some((o) => o.day === target.day && o.start === target.start && o.horseId === target.horseId),
      "a pattern whose third week is unbookable must not be offered",
    );
  });

  test("a week the barn-mate has the horse breaks the pattern too", () => {
    // The test above blocks an occurrence through this coach's own list. This one blocks the
    // same occurrence through the BARN's, with the coach's day left empty — a weekly pattern
    // is no more bookable because the conflict belongs to someone else's roster, and offering
    // it commits a rider to a horse that is taken every third week.
    const open = recurring({ limit: 20 });
    assert.ok(open.length > 0, "there is something to block");
    const target = open[0];

    const third = new Date(NOW);
    while (third.getDay() !== target.day) third.setDate(third.getDate() + 1);
    third.setDate(third.getDate() + 14);

    const blocked = recurring({
      limit: 20,
      bookings: [booking({ date: third, start: target.start, horseId: target.horseId, studentId: "jordan" })],
      trainerBookings: [],
    });
    assert.ok(
      !blocked.some((o) => o.day === target.day && o.start === target.start && o.horseId === target.horseId),
      "the horse is the barn's, so the barn's bookings decide whether the pattern holds",
    );
  });

  test("occurrences is a parameter, so the depth of the check is stated not assumed", () => {
    const shallow = recurring({ limit: 20, occurrences: 1 });
    const deep = recurring({ limit: 20, occurrences: 12 });
    assert.ok(deep.length <= shallow.length, "checking further ahead can only narrow the list");
  });
});
