// Slot finding and matching. A layer ABOVE the rules, not part of them.
//
// The distinction is worth holding onto: `rules.js` answers "may this booking exist?" and this
// file answers "what should we suggest?". Everything here calls into the rules; nothing in the
// rules calls back. A suggestion that turned out to be unbookable would be a bug here, never
// a relaxation there — so every candidate below is run through `validateBooking` before it is
// offered, rather than through a cheaper approximation of it.
//
// Extracted from prototype.jsx, with the same four corrections the original extraction existed
// to make, plus two more that only became possible later:
//
//   1. The clock is a parameter. The prototype read a module-level TODAY, which is why none of
//      "the next 30 days", the four-occurrence recurring check, or the rest-day forecast could
//      be tested at a boundary. Every function here takes `now`.
//   2. `holdsSlot(b)` replaces the eight inline `pending`/`confirmed` pairs.
//   3. The shared `overlaps()` replaces the hand-written interval arithmetic in findOpenSlots.
//   4. Arguments arrive as one object rather than nine positional parameters — the same bag
//      `validateBooking` takes, which is also what the repository's `engineInputsFor` returns.
//      `findIntroOptions(student, horses, lessonTypes, bookings, students, limit, availability,
//      timeOffBlocks, trainerConfig)` had two adjacent array arguments that were trivially
//      swappable with no error.
//   5. A booking's END is read from the booking, not reconstructed from its lesson type. The
//      prototype did `lessonTypes.find(...)?.durationMin || 60`, which silently guesses an hour
//      for any booking whose type it cannot see — and on a horse shared between two coaches it
//      cannot see the barn-mate's type at all. `bookings.end_time` is stored precisely so this
//      does not have to be inferred.
//
// The student shape here is richer than the one the rules use: matching also reads
// `targetTimes`, `potentialTimes`, `notificationPref`, `profileStatus` and `active`. Offering
// someone a time they never asked for is noise, and that is a judgment the rules deliberately
// do not make.
import { parseTime, minToStr, addDays, sameDay, overlaps } from "./time.js";
import { holdsSlot } from "./constants.js";
import { introLessonType } from "./derive.js";
import {
  getEligibleHorses,
  horseMinutesOnDate,
  forecastRestStatus,
  isDateInTimeOff,
  validateBooking,
} from "./rules.js";

// ---------------------------------------------------------------------------
// Lesson type selection
// ---------------------------------------------------------------------------

/**
 * Which types the coach has opted into offering as gap-fill. Group types can never qualify —
 * coordinating a fill across several riders and horses at once is more than a gap-fill offer
 * can carry — so the flag is forced off for them rather than left to the coach.
 */
export function potentialLessonTypes(lessonTypes) {
  return (lessonTypes || []).filter((l) => l.potentialEligible && !l.isGroup);
}

/** The type a recurring pattern defaults to: an ordinary private lesson if there is one. */
export function defaultLessonType(lessonTypes) {
  const types = lessonTypes || [];
  return (
    types.find((l) => !l.isIntro && !l.isGroup) || types.find((l) => !l.isIntro) || types[0] || null
  );
}

// ---------------------------------------------------------------------------
// The coach's day
// ---------------------------------------------------------------------------

/**
 * When a lesson ends, in minutes past midnight.
 *
 * Prefers the booking's own stored end. Falling back to the lesson type's duration is the
 * prototype's behaviour and is kept only for callers holding bookings that predate stored end
 * times; the fallback of last resort treats the lesson as a full hour, which is a guess, so it
 * is the last thing tried rather than the first.
 */
function endMinutesOf(booking, lessonTypes) {
  if (booking.end) return parseTime(booking.end);
  const lt = (lessonTypes || []).find((l) => l.id === booking.lessonTypeId);
  return parseTime(booking.start) + (lt ? lt.durationMin : 60);
}

/**
 * Coach-level (not horse-level) busy intervals for a date — used only to decide what times to
 * OFFER, never to block a booking outright. A group session counts as busy here: group types
 * are never offered as gap-fill, so there is nothing to join.
 */
export function coachBusyIntervals(date, bookings, lessonTypes) {
  return (bookings || [])
    .filter((b) => sameDay(b.date, date) && holdsSlot(b))
    .map((b) => ({ start: parseTime(b.start), end: endMinutesOf(b, lessonTypes) }))
    .sort((a, b) => a.start - b.start);
}

/**
 * Would offering this time respect how the coach likes their day arranged?
 *
 * The minimum buffer is always required around every existing lesson. The maximum buffer and
 * the back-to-back cap apply only when OFFERING, and only matter under a back-to-back
 * preference — a coach who schedules spaced is not trying to pack lessons tightly, so a
 * maximum has nothing to prevent.
 */
export function offerRespectsPreferences({
  date, startMin, durationMin, bookings, trainerBookings = bookings, lessonTypes, trainerConfig,
}) {
  if (!trainerConfig) return true;
  // The coach's own day, not the barn's. See validateBooking's `trainerBookings`.
  const busy = coachBusyIntervals(date, trainerBookings, lessonTypes);
  const endMin = startMin + durationMin;
  const minBuffer = trainerConfig.minBufferMin ?? 0;

  for (const b of busy) {
    const clearBefore = endMin + minBuffer <= b.start;
    const clearAfter = startMin - minBuffer >= b.end;
    if (!clearBefore && !clearAfter) return false;
  }

  if (trainerConfig.schedulingPreference === "back_to_back" && trainerConfig.maxBackToBack) {
    // Walk backwards through the lessons that end before this one starts, counting how long an
    // unbroken run this slot would join. A gap wider than maxBufferMin breaks the run.
    let streak = 0;
    let cursor = startMin;
    for (const b of [...busy].sort((x, y) => y.end - x.end)) {
      if (b.end > cursor) continue;
      if (cursor - b.end <= (trainerConfig.maxBufferMin ?? Infinity)) {
        streak++;
        cursor = b.start;
      } else {
        break;
      }
    }
    if (streak >= trainerConfig.maxBackToBack) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Open slots
// ---------------------------------------------------------------------------

/**
 * One entry per open WINDOW, carrying the gap-fill-eligible lesson types that fit it and, per
 * type, the horses that qualify.
 *
 * Deliberately not one entry per window x horse, and not one per window x type: an open-slot
 * count is a count of windows, and a coach reading "6 open" should not be seeing the same
 * 3pm three times because three horses are free.
 */
export function findOpenSlots({
  date, now, horses, lessonTypes, bookings, trainerBookings = bookings, students, availability,
  timeOffBlocks, trainerConfig,
}) {
  const dayIdx = date.getDay();
  const windows = (availability || []).filter((a) => a.day === dayIdx);
  if (!windows.length || isDateInTimeOff(date, timeOffBlocks)) return [];
  const types = potentialLessonTypes(lessonTypes);
  if (!types.length) return [];

  const out = [];
  for (const win of windows) {
    const windowEnd = parseTime(win.end);
    // Half-hour granularity: the coach's day is read in half hours, and offering 3:07pm would
    // be technically valid and useless.
    for (let t = parseTime(win.start); t < windowEnd; t += 30) {
      const options = [];
      for (const lt of types) {
        if (t + lt.durationMin > windowEnd) continue;
        if (!offerRespectsPreferences({
          date, startMin: t, durationMin: lt.durationMin, bookings, trainerBookings, lessonTypes,
          trainerConfig,
        })) continue;

        const horseIds = (horses || []).filter((h) => {
          if (!h.active) return false;
          const busy = (bookings || []).some(
            (b) =>
              b.horseId === h.id &&
              sameDay(b.date, date) &&
              holdsSlot(b) &&
              overlaps(parseTime(b.start), endMinutesOf(b, lessonTypes), t, t + lt.durationMin),
          );
          if (busy) return false;
          // A horse already over its rest-day window should not be offered even though a single
          // booking would still pass the rules — the forecast is the whole point of offering.
          if (forecastRestStatus(h, bookings, now) === "red") return false;
          return (
            horseMinutesOnDate(h.id, date, bookings, lessonTypes, false, students) + lt.rideTimeMin <=
            h.maxDailyOverall
          );
        }).map((h) => h.id);

        if (horseIds.length) options.push({ lessonTypeId: lt.id, horseIds });
      }
      if (options.length) {
        out.push({
          time: minToStr(t),
          options,
          horseIds: [...new Set(options.flatMap((o) => o.horseIds))],
        });
      }
    }
  }
  return out.sort((a, b) => parseTime(a.time) - parseTime(b.time));
}

// ---------------------------------------------------------------------------
// Who to offer a slot to
// ---------------------------------------------------------------------------

/** Does one of the student's own riding windows cover this date and time? */
export function windowCovers(w, date, time) {
  return (
    w.day === date.getDay() &&
    parseTime(time) >= parseTime(w.start) &&
    parseTime(time) < parseTime(w.end)
  );
}

/**
 * How often this student has taken a gap-fill lesson they were offered.
 *
 * Acceptance is derived — an offer with a matching booking — never stored, since Phase 1a has
 * no reply channel. Smoothed as (accepted + 1) / (offered + 2): a student with no history sits
 * at a neutral 0.5 rather than at zero, so newcomers are not buried beneath everyone who has
 * ever said yes, and one early yes or no does not read as a perfect record.
 */
export function offerStats(studentId, { offers, bookings }) {
  const mine = (offers || []).filter((o) => o.studentId === studentId);
  const accepted = mine.filter((o) =>
    (bookings || []).some(
      (b) =>
        b.studentId === o.studentId &&
        sameDay(b.date, o.date) &&
        b.start === o.start &&
        b.status !== "early_cancel",
    ),
  ).length;
  return { offered: mine.length, accepted, score: (accepted + 1) / (mine.length + 2) };
}

/**
 * Candidates for an open slot, best first.
 *
 * A student qualifies only if the slot falls inside one of their own target or potential
 * windows — offering a time nobody asked for is noise, and it is the fastest way to teach
 * riders to ignore the messages. Target matches rank above potential ones (a target offer is
 * full price; a potential one is the discount case), and within each, the students most likely
 * to say yes come first.
 */
export function eligibleStudentsForSlot({
  date, time, slot, horses, lessonTypes, bookings, trainerBookings = bookings, students,
  availability, timeOffBlocks, priceBands, trainerConfig, offers,
}) {
  const kindRank = { target: 0, potential: 1 };
  const rows = [];

  for (const s of students || []) {
    if (!s.active || s.profileStatus !== "approved") continue;
    // Already booked at this time — offering someone a slot they are standing in is noise of a
    // more embarrassing kind.
    if ((bookings || []).some(
      (b) => b.studentId === s.id && sameDay(b.date, date) && b.start === time && holdsSlot(b),
    )) continue;

    const kind = (s.targetTimes || []).some((w) => windowCovers(w, date, time))
      ? "target"
      : (s.potentialTimes || []).some((w) => windowCovers(w, date, time))
        ? "potential"
        : null;
    if (!kind) continue;
    if (kind === "potential" && s.notificationPref === "target_only") continue;

    // The first type-and-horse pairing that survives the full rules. Not a cheaper check:
    // anything offered here must be bookable when the student taps it.
    let match = null;
    for (const o of slot.options) {
      const lt = (lessonTypes || []).find((l) => l.id === o.lessonTypeId);
      if (!lt) continue;
      const pool = (horses || []).filter((h) => o.horseIds.includes(h.id));
      const passing = getEligibleHorses(s, lt, pool).filter(
        (h) =>
          validateBooking({
            student: s, horse: h, lessonType: lt, date, start: time,
            bookings, trainerBookings, students, lessonTypes, availability, timeOffBlocks,
            priceBands, trainerConfig,
          }).ok,
      );
      if (passing.length) {
        match = { lessonType: lt, horse: passing[0] };
        break;
      }
    }
    if (!match) continue;

    rows.push({
      student: s,
      horse: match.horse,
      lessonType: match.lessonType,
      kind,
      stats: offerStats(s.id, { offers, bookings }),
      alreadyOffered: (offers || []).some(
        (o) => o.studentId === s.id && sameDay(o.date, date) && o.start === time,
      ),
    });
  }

  return rows.sort(
    (a, b) =>
      kindRank[a.kind] - kindRank[b.kind] ||
      b.stats.score - a.stats.score ||
      a.student.name.localeCompare(b.student.name),
  );
}

// ---------------------------------------------------------------------------
// Times to offer one student
// ---------------------------------------------------------------------------

/**
 * Bookable intro-lesson times for a brand-new rider, drawn from their own stated windows.
 *
 * `horizonDays` and `limit` are both parameters because this is the screen a new rider sees
 * first: too few options reads as "nothing available", and scanning a month ahead for a coach
 * with no intro type configured is wasted work.
 */
export function findIntroOptions({
  student, now, limit = 10, horizonDays = 30,
  horses, lessonTypes, bookings, trainerBookings = bookings, students, availability,
  timeOffBlocks, trainerConfig,
}) {
  const lt = introLessonType(lessonTypes);
  if (!lt) return []; // a coach with no intro type simply has no intro lessons to offer
  const eligibleHorses = getEligibleHorses(student, lt, horses);
  if (!eligibleHorses.length) return [];

  const windows = [...(student.targetTimes || []), ...(student.potentialTimes || [])];
  const out = [];
  let d = new Date(now);
  for (let i = 0; i < horizonDays && out.length < limit; i++) {
    for (const w of windows) {
      if (out.length >= limit) break;
      if (d.getDay() !== w.day) continue;
      for (let t = parseTime(w.start); t + lt.durationMin <= parseTime(w.end) && out.length < limit; t += lt.durationMin) {
        const startStr = minToStr(t);
        for (const h of eligibleHorses) {
          if (out.length >= limit) break;
          const ok = validateBooking({
            student, horse: h, lessonType: lt, date: new Date(d), start: startStr,
            bookings, trainerBookings, students, lessonTypes, availability, timeOffBlocks,
            trainerConfig,
          }).ok;
          if (ok && offerRespectsPreferences({
            date: d, startMin: t, durationMin: lt.durationMin, bookings, trainerBookings,
            lessonTypes, trainerConfig,
          })) {
            out.push({ date: new Date(d), start: startStr, horseId: h.id });
          }
        }
      }
    }
    d = addDays(d, 1);
  }
  return out;
}

/**
 * Weekly patterns that would hold for the next several occurrences.
 *
 * Checking only the first occurrence would be the obvious implementation and the wrong one: a
 * weekly pattern that works once is not a pattern, and the rider finds out in three weeks.
 * Options are drawn from the student's own windows, target first so the times they actually
 * asked for are not crowded out of the limit by gap-fill windows, and each option carries its
 * kind forward because "why is this the list?" is otherwise unanswerable on the screen.
 */
export function findRecurringOptions({
  student, now, limit = 10, occurrences = 4,
  horses, lessonTypes, bookings, trainerBookings = bookings, students, availability,
  timeOffBlocks, trainerConfig,
}) {
  const lt = defaultLessonType(lessonTypes);
  if (!lt) return [];
  const eligibleHorses = getEligibleHorses(student, lt, horses);
  if (!eligibleHorses.length) return [];

  const windows = [
    ...(student.targetTimes || []).map((w) => ({ ...w, kind: "target" })),
    ...(student.potentialTimes || []).map((w) => ({ ...w, kind: "potential" })),
  ];

  const out = [];
  for (const w of windows) {
    for (let t = parseTime(w.start); t + lt.durationMin <= parseTime(w.end) && out.length < limit; t += 30) {
      const startStr = minToStr(t);
      for (const h of eligibleHorses) {
        if (out.length >= limit) break;
        // The first occurrence on or after `now` that falls on this weekday.
        let first = new Date(now);
        while (first.getDay() !== w.day) first = addDays(first, 1);

        let allPass = true;
        for (let occ = 0; occ < occurrences; occ++) {
          const occDate = addDays(first, occ * 7);
          const ok = validateBooking({
            student, horse: h, lessonType: lt, date: occDate, start: startStr,
            bookings, trainerBookings, students, lessonTypes, availability, timeOffBlocks,
            trainerConfig,
          }).ok;
          if (!ok || !offerRespectsPreferences({
            date: occDate, startMin: t, durationMin: lt.durationMin, bookings, trainerBookings,
            lessonTypes, trainerConfig,
          })) {
            allPass = false;
            break;
          }
        }
        if (allPass) out.push({ day: w.day, start: startStr, horseId: h.id, kind: w.kind });
      }
    }
  }
  return out;
}
