import { sameDay, startOfDay, parseTime } from "./time.js";

// ---- occurrence type ----
// "Why does this lesson exist" — derived from recurringId + lessonTypeId alone. Deliberately
// separate from "which horse ended up on it" (see horseAssignment below): conflating the two
// broke down the moment a recurring lesson's dominant horse went inactive.

export function introLessonType(lessonTypes) {
  return lessonTypes.find((l) => l.isIntro) || null;
}

export function isIntroBooking(booking, lessonTypes) {
  const intro = introLessonType(lessonTypes);
  return !!(intro && booking.lessonTypeId === intro.id);
}

// An occurrence that has been moved off its pattern's day/time has left the pattern behind.
export function isOrphanedOccurrence(booking, recurringBookings) {
  if (!booking.recurringId) return false;
  const rec = (recurringBookings || []).find((r) => r.id === booking.recurringId);
  if (!rec) return false;
  return booking.date.getDay() !== rec.day || booking.start !== rec.start;
}

export function occurrenceType(booking, recurringBookings, lessonTypes) {
  if (lessonTypes && isIntroBooking(booking, lessonTypes)) return "first-lesson";
  if (!booking.recurringId) return "adhoc";
  if (recurringBookings && isOrphanedOccurrence(booking, recurringBookings)) return "adhoc";
  return "recurring";
}

// ---- horse assignment ----
// Independent of occurrence type. Dominant vs. substitute is decided by comparing the
// booking's horse against its pattern's horse; needs-substitute is a third, independent flag.
export function horseAssignment(booking, recurringBookings, horses) {
  const horse = horses.find((h) => h.id === booking.horseId);
  const none = { horse, isSubstitute: false, dominantHorse: null, needsSub: false };
  if (!booking.recurringId) return none;

  const rec = (recurringBookings || []).find((r) => r.id === booking.recurringId);
  if (!rec) return none;

  // An orphan has left its pattern behind, so dominant vs. substitute no longer applies.
  if (isOrphanedOccurrence(booking, recurringBookings)) return { ...none, isOrphan: true };

  const dominantHorse = horses.find((h) => h.id === rec.horseId);
  if (booking.horseId === rec.horseId) {
    return {
      horse,
      isSubstitute: false,
      dominantHorse: null,
      needsSub: !!(dominantHorse && !dominantHorse.active),
    };
  }
  return { horse, isSubstitute: true, dominantHorse, needsSub: false };
}

export function needsSubstitute(booking, horses, recurringBookings) {
  return horseAssignment(booking, recurringBookings, horses).needsSub;
}

// ---- status ----
// A booking auto-completes once its date has passed, unless the coach explicitly cancelled or
// no-showed it. Never stored as "completed" — always derived.
//
// NOTE (carried forward deliberately): completion is still day-granular while
// cancelDisposition below is minute-granular, so a lesson that ended at 6am today shows no
// cancel button (correct) but does not yet count as completed. Moving completion onto the
// clock is now a one-line change — `startOfDay(now)` becomes `now` — but it shifts the coach's
// Day view and the ride tallies together, so it stays a deliberate decision, not a side
// effect of this extraction.
export function effectiveStatus(booking, now) {
  const today = startOfDay(now);
  if ((booking.status === "confirmed" || booking.status === "pending") && booking.date < today) {
    return "completed";
  }
  return booking.status;
}

// ---- ride tallies ----
// Derived from bookings, never stored — a stored tally drifts the first time a lesson is
// retroactively marked no-show. Only lessons that actually happened count. Calendar year to
// date, so the count resets on Jan 1 rather than rolling.
export function completedRidesThisYear(bookings, matches, now) {
  const today = startOfDay(now);
  return bookings.filter(
    (b) =>
      matches(b) &&
      effectiveStatus(b, now) === "completed" &&
      b.date.getFullYear() === now.getFullYear() &&
      b.date <= today
  );
}

export function tallyRides(rides, keyOf) {
  const counts = {};
  rides.forEach((b) => {
    const k = keyOf(b);
    counts[k] = (counts[k] || 0) + 1;
  });
  // Anything with zero completed rides never enters the object, so the list self-filters.
  return Object.entries(counts)
    .map(([key, n]) => ({ key, rides: n }))
    .sort((a, b) => b.rides - a.rides);
}

// Which horses a student rode. Which students rode a horse. Same data, pivoted.
export function ridesByHorse(studentId, bookings, now) {
  return tallyRides(
    completedRidesThisYear(bookings, (b) => b.studentId === studentId, now),
    (b) => b.horseId
  );
}

export function ridesByStudent(horseId, bookings, now) {
  return tallyRides(
    completedRidesThisYear(bookings, (b) => b.horseId === horseId, now),
    (b) => b.studentId
  );
}

// ---- cancellation ----
// Lead time to a lesson's start, in minutes. Negative once it has begun.
export function minutesUntil(booking, now) {
  const days = Math.round((startOfDay(booking.date) - startOfDay(now)) / 86400000);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return days * 1440 + parseTime(booking.start) - nowMin;
}

// Which cancellation a student is entitled to, decided by lead time rather than by choice —
// the student never picks between early and late. A lesson later today is still cancellable,
// just not for free. Returns null once the lesson has started, at which point it's the coach's
// call whether it was a no-show or a late cancel.
export function cancelDisposition(booking, trainerConfig, now) {
  const status = effectiveStatus(booking, now);
  if (status !== "confirmed" && status !== "pending") return null;
  const lead = minutesUntil(booking, now);
  if (lead <= 0) return null;
  const notice = trainerConfig.lateCancelHours;
  return lead > notice * 60
    ? {
        kind: "early_cancel",
        billable: false,
        label: "Cancel lesson",
        note: `More than ${notice} hours away — no charge.`,
      }
    : {
        kind: "late_cancel",
        billable: true,
        label: "Cancel — still charged",
        note: `Less than ${notice} hours away, so this lesson is still billed.`,
      };
}

