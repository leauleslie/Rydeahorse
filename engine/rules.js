import { sameDay, addDays, parseTime, fmtDate, overlaps } from "./time.js";
import { EXP_RANK, holdsSlot } from "./constants.js";
import { priceFor } from "./pricing.js";

// ---- group sessions ----
// A group session isn't a stored entity: it *is* the set of bookings sharing lesson type +
// date + start time, where that lesson type is a group type. Nothing to keep in sync, and no
// way for a booking to claim membership in a session it doesn't actually share a slot with.
export function isGroupType(lessonTypeId, lessonTypes) {
  const lt = lessonTypes.find((l) => l.id === lessonTypeId);
  return !!(lt && lt.isGroup);
}

export function groupKeyOf(booking) {
  return { lessonTypeId: booking.lessonTypeId, date: booking.date, start: booking.start };
}

export function sameGroupSession(b, key) {
  return (
    b.lessonTypeId === key.lessonTypeId && sameDay(b.date, key.date) && b.start === key.start
  );
}

export function groupRoster(bookings, key) {
  return bookings.filter((b) => holdsSlot(b) && sameGroupSession(b, key));
}

// ---- trainer availability ----
export function isTrainerAvailable(dayIdx, mins, availability) {
  return (availability || []).some(
    (a) => a.day === dayIdx && mins >= parseTime(a.start) && mins <= parseTime(a.end)
  );
}

export function isDateInTimeOff(date, timeOffBlocks) {
  return (timeOffBlocks || []).some((b) => date >= b.startDate && date <= b.endDate);
}

// ---- pairing / suitability (check #5) ----
export function getEligibleHorses(student, lessonType, horses) {
  return horses.filter((h) => {
    if (!h.active) return false;
    if (EXP_RANK[student.experienceLevel] < EXP_RANK[h.minExp]) return false;
    if (h.adultOnly && student.age < 18) return false;
    if (!h.styles.some((s) => student.ridingStyles.includes(s))) return false;
    if (student.weight > h.maxWeight) return false;
    if (student.noRideHorses.includes(h.id)) return false;
    if (
      lessonType.restrictedHorseIds &&
      lessonType.restrictedHorseIds.length > 0 &&
      !lessonType.restrictedHorseIds.includes(h.id)
    ) {
      return false;
    }
    if (lessonType.ridingStyles && lessonType.ridingStyles.length > 0) {
      if (!lessonType.ridingStyles.some((s) => h.styles.includes(s))) return false;
      if (!lessonType.ridingStyles.some((s) => student.ridingStyles.includes(s))) return false;
    }
    return true;
  });
}

// ---- usage caps (check #4) ----
// Computed on demand from bookings, never stored — a stored counter drifts, a computed value
// can't. Saddle time (rideTimeMin), not calendar time.
export function horseMinutesOnDate(horseId, date, bookings, lessonTypes, adultOnly, students) {
  return bookings
    .filter((b) => b.horseId === horseId && sameDay(b.date, date) && holdsSlot(b))
    .reduce((sum, b) => {
      const lt = lessonTypes.find((l) => l.id === b.lessonTypeId);
      const st = students.find((s) => s.id === b.studentId);
      if (adultOnly && !(st && st.age >= 18)) return sum;
      return sum + (lt ? lt.rideTimeMin : 0);
    }, 0);
}

// Which of the two daily caps is actually binding. A horse carrying mostly adult riders
// reaches the adult cap long before the overall ceiling.
export function bindingCap(horse, date, bookings, lessonTypes, students) {
  const overall = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, false, students);
  const adult = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, true, students);
  const adultShare = horse.maxDailyAdult ? adult / horse.maxDailyAdult : 0;
  const overallShare = horse.maxDailyOverall ? overall / horse.maxDailyOverall : 0;
  return adultShare >= overallShare
    ? {
        used: adult,
        max: horse.maxDailyAdult,
        label: "adult cap",
        other: `${overall}/${horse.maxDailyOverall} overall`,
      }
    : {
        used: overall,
        max: horse.maxDailyOverall,
        label: "overall cap",
        other: `${adult}/${horse.maxDailyAdult} adult`,
      };
}

// ---- rest days (check #3) ----
// Rolling 7-day window ending on the requested date, inclusive: count distinct dates the horse
// is booked. No new field — computed, same as the usage cap.
export function ridDaysInWindow(horseId, endDate, bookings) {
  const days = new Set();
  for (let i = 0; i < 7; i++) {
    const d = addDays(endDate, -i);
    if (bookings.some((b) => b.horseId === horseId && sameDay(b.date, d) && holdsSlot(b))) {
      days.add(fmtDate(d));
    }
  }
  return days.size;
}

export function forecastRestStatus(horse, bookings, now) {
  const bookedDays = ridDaysInWindow(horse.id, addDays(now, 6), bookings);
  const capacity = 7 - horse.restDaysPerWeek;
  if (bookedDays > capacity) return "red";
  if (bookedDays === capacity) return "yellow";
  return "green";
}

// The forecast says a window is over capacity; this says which day pushes it over. Alerts are
// dated to the day the problem lands, so it has to point at a specific date.
export function restTippingDate(horse, bookings, now) {
  const capacity = 7 - horse.restDaysPerWeek;
  let booked = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(now, i);
    if (bookings.some((b) => b.horseId === horse.id && sameDay(b.date, d) && holdsSlot(b))) {
      booked++;
      if (booked > capacity) return d;
    }
  }
  return null;
}

export function forecastUsageCapStatus(horse, date, bookings, lessonTypes, students) {
  const overall = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, false, students);
  const adult = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, true, students);
  return overall > horse.maxDailyOverall || adult > horse.maxDailyAdult ? "red" : "green";
}

// ---- the entry point ----
// Every booking request, from every interface, runs through here. Checks run IN ORDER, and the
// order is about which reason gets reported — not about short-circuiting. Every check is
// evaluated so a validation checklist can show the whole picture at once.
//
// Each check carries a stable `code` as well as a human `label`. The prototype matched on
// label text, which is fine when one file owns both; across a server boundary a UI string is
// not an identifier.
export function validateBooking({
  student,
  horse,
  lessonType,
  date,
  start,
  bookings,
  // The coach's OWN lessons. Defaults to `bookings`, which is right whenever every booking in
  // play belongs to one trainer — the single-coach case, and what the prototype assumes.
  //
  // It stops being right in a barn with two coaches. Horse welfare and the horse half of
  // double-booking have to count every lesson the animal did, whoever booked it, so `bookings`
  // is loaded account-wide. Feeding that same list to the TRAINER half then reports a coach as
  // busy while it is their barn-mate teaching — a slot that is genuinely free, refused.
  //
  // Two lists rather than a trainer id on the booking, deliberately: the engine still cannot
  // ask who anything belongs to. It is handed two sets with stated meanings and never learns
  // that tenancy exists.
  trainerBookings = bookings,
  students,
  lessonTypes,
  availability,
  timeOffBlocks,
  priceBands,
  trainerConfig,
  offerDiscount,
  manualAdjustment,
}) {
  const checks = [];
  const dayIdx = date.getDay();
  const startMin = parseTime(start);
  const endMin = startMin + lessonType.durationMin;

  // 1. Trainer availability
  checks.push({
    code: "trainer_available",
    label: "Trainer available",
    pass: isTrainerAvailable(dayIdx, startMin, availability) && !isDateInTimeOff(date, timeOffBlocks),
  });

  // 2. Horse active
  checks.push({ code: "horse_active", label: "Horse active", pass: !!horse.active });

  // 3. Horse rest day
  const alreadyRidDays = ridDaysInWindow(horse.id, date, bookings);
  const willBeNewDay = !bookings.some((b) => b.horseId === horse.id && sameDay(b.date, date));
  const projectedDays = alreadyRidDays + (willBeNewDay ? 1 : 0);
  checks.push({
    code: "rest_day",
    label: "Rest day on track",
    pass: projectedDays <= 7 - horse.restDaysPerWeek,
  });

  // 4. Horse usage cap
  const overallMin = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, false, students);
  const adultMin = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, true, students);
  const withinOverall = overallMin + lessonType.rideTimeMin <= horse.maxDailyOverall;
  const withinAdult =
    student.age >= 18 ? adultMin + lessonType.rideTimeMin <= horse.maxDailyAdult : true;
  checks.push({
    code: "usage_cap",
    label: "Within usage cap",
    pass: withinOverall && withinAdult,
  });

  // 5. Pairing / suitability
  checks.push({
    code: "pairing",
    label: "Pairing eligible",
    pass: getEligibleHorses(student, lessonType, [horse]).length > 0,
  });

  // 6. No double-booking — two separately reported halves, since they fail for different
  //    reasons and only one of them can ever relax.
  const conflictsWith = (b) => {
    if (!sameDay(b.date, date) || !holdsSlot(b)) return false;
    const bStart = parseTime(b.start);

    // When a lesson ends, in order of how much the answer can be trusted.
    //
    // This used to be `bStart + (bLt ? bLt.durationMin : 0)`, and the `: 0` was a silent
    // double-booking hole. A booking whose lesson type is not in the array given to this
    // function got ZERO duration, overlapped nothing, and the horse read as FREE — which is
    // exactly what happens on a horse shared between two coaches, because lesson types are
    // trainer-scoped and the barn-mate's is unreadable. The database's exclusion constraint
    // still refused the insert, so no horse was ever actually double-booked, but the coach was
    // offered a slot that could not be taken.
    //
    // A booking's own stored end is the fact; the lesson type's duration is a reconstruction of
    // it. Prefer the fact.
    if (b.end) return overlaps(bStart, parseTime(b.end), startMin, endMin);

    const bLt = lessonTypes.find((l) => l.id === b.lessonTypeId);
    if (bLt) return overlaps(bStart, bStart + bLt.durationMin, startMin, endMin);

    // Neither available: this lesson is real and occupies an unknown span. Welfare and safety
    // checks never relax, so an unmeasurable lesson counts as a conflict rather than as
    // nothing. A refusal is recoverable; a double-booked horse is not.
    return true;
  };

  // The horse half never relaxes: every rider needs their own horse.
  checks.push({
    code: "horse_free",
    label: "Horse free",
    pass: !bookings.some((b) => b.horseId === horse.id && conflictsWith(b)),
  });

  // The trainer half relaxes only for a genuine group session below capacity — and it asks
  // only about THIS coach's lessons.
  const key = { lessonTypeId: lessonType.id, date, start };
  const clashes = (trainerBookings || []).filter(conflictsWith);
  const allSameGroup =
    clashes.length > 0 && lessonType.isGroup && clashes.every((b) => sameGroupSession(b, key));
  const roomInGroup = allSameGroup && clashes.length < (lessonType.maxGroupSize || 0);
  checks.push({
    code: "trainer_free",
    label: "Trainer free",
    pass: clashes.length === 0 || roomInGroup,
  });

  // 7. Pricing — computed, not typed and then validated. The one check that adjusts rather
  //    than rejects: a total below the floor becomes the floor and says so by name.
  const quote = priceFor({
    student,
    lessonType,
    date,
    start,
    offerDiscount,
    manualAdjustment,
    priceBands: priceBands || [],
    trainerConfig: trainerConfig || {},
  });
  const priceLabel = quote.flooredBy
    ? `Price floored at $${lessonType.minPrice}`
    : quote.cappedBy
    ? `Price capped at $${lessonType.maxPrice}`
    : "Price in range";
  checks.push({
    code: "price_in_range",
    label: priceLabel,
    pass:
      Number.isInteger(quote.price) &&
      quote.price >= lessonType.minPrice &&
      quote.price <= lessonType.maxPrice,
    quote,
  });

  return { ok: checks.every((c) => c.pass), checks, quote };
}

// The first failing check, by report order — the specific reason that feeds a clarifying
// question. "Buttercup's already at her daily riding limit" is useful; "booking failed" is not.
export function firstFailure(validation) {
  const f = validation.checks.find((c) => !c.pass);
  return f ? { code: f.code, label: f.label } : null;
}

// Validate a candidate horse for an EXISTING booking, ignoring that booking itself so a horse
// never conflicts with the very lesson it's being considered for.
export function validateSwap(horse, booking, ctx) {
  const student = ctx.students.find((s) => s.id === booking.studentId);
  const lessonType = ctx.lessonTypes.find((l) => l.id === booking.lessonTypeId);
  return validateBooking({
    student,
    horse,
    lessonType,
    date: booking.date,
    start: booking.start,
    bookings: ctx.bookings.filter((b) => b.id !== booking.id),
    students: ctx.students,
    lessonTypes: ctx.lessonTypes,
    availability: ctx.trainerAvailability,
    timeOffBlocks: ctx.timeOffBlocks,
    priceBands: ctx.priceBands,
    trainerConfig: ctx.trainerConfig,
    offerDiscount: booking.offerDiscount,
    manualAdjustment: booking.manualAdjustment,
  });
}
