import { parseTime, startOfDay, overlaps } from "./time.js";
import { effectiveStatus } from "./derive.js";

// A band matches on START TIME alone, not on overlap. A 60-min lesson beginning at 2:45
// against a 3-6pm band is a 2:45 lesson: pricing it as premium because it runs into the band
// would surprise whoever deliberately booked the earlier slot.
export function bandForSlot(date, start, priceBands) {
  const dayIdx = date.getDay();
  const t = parseTime(start);
  return (
    (priceBands || []).find(
      (b) => b.days.includes(dayIdx) && t >= parseTime(b.start) && t < parseTime(b.end)
    ) || null
  );
}

export function bandAmountFor(lessonType, band) {
  if (!band) return 0;
  return Number((lessonType.bandAdjustments || {})[band.id] || 0);
}

// Two bands may not overlap on any shared day. Checked where the coach edits bands, not at
// booking time, because the fix belongs where she is already working.
export function bandOverlap(candidate, priceBands) {
  const cs = parseTime(candidate.start);
  const ce = parseTime(candidate.end);
  return (
    (priceBands || []).find(
      (b) =>
        b.id !== candidate.id &&
        b.days.some((d) => candidate.days.includes(d)) &&
        overlaps(parseTime(b.start), parseTime(b.end), cs, ce)
    ) || null
  );
}

export function frequencyDiscountFor(lessonType, tier) {
  if (!tier) return 0;
  const v = tier === 2 ? lessonType.freqDiscount2 : lessonType.freqDiscount1;
  return Number(v || 0);
}

// Billable rides in a calendar month. Billable rather than ridden, deliberately: a late cancel
// or no-show was paid for, and docking someone's rate for a lesson they were charged for is
// the kind of unfairness that gets noticed.
export function billableRidesInMonth(studentId, bookings, year, month, now) {
  const today = startOfDay(now);
  return bookings.filter(
    (b) =>
      b.studentId === studentId &&
      b.date.getFullYear() === year &&
      b.date.getMonth() === month &&
      b.isBillable &&
      effectiveStatus(b, now) !== "early_cancel" &&
      b.date < today
  ).length;
}

export function tierFromRides(rides, trainerConfig) {
  const t1 = trainerConfig.freqTier1MinRides;
  const t2 = trainerConfig.freqTier2MinRides;
  if (!t1) return 0; // a blank threshold switches frequency pricing off entirely
  if (t2 && rides >= t2) return 2;
  if (rides >= t1) return 1;
  return 0;
}

// The monthly recompute, as one function. The tier is the BETTER of the last two completed
// calendar months — that single line is the whole ratchet: a good month raises the rate at
// once, a bad month can't lower it until it's been bad twice, so nobody opens the app to an
// unexplained price rise after a week off sick.
export function earnedTier(studentId, bookings, trainerConfig, now) {
  const months = [1, 2].map((back) => new Date(now.getFullYear(), now.getMonth() - back, 1));
  const tiers = months.map((m) =>
    tierFromRides(
      billableRidesInMonth(studentId, bookings, m.getFullYear(), m.getMonth(), now),
      trainerConfig
    )
  );
  return Math.max(...tiers);
}

// What the student needs for the next tier. Measured against THIS month's count so far, so it
// reads as a target rather than a verdict.
export function nextTierProgress(student, bookings, trainerConfig, now) {
  const tier = student.frequencyTier || 0;
  const t1 = trainerConfig.freqTier1MinRides;
  const t2 = trainerConfig.freqTier2MinRides;
  if (!t1) return null;
  const target = tier === 0 ? t1 : tier === 1 ? t2 : null;
  if (!target) return null; // already at the top: say so, don't invent a goal
  const soFar = billableRidesInMonth(
    student.id,
    bookings,
    now.getFullYear(),
    now.getMonth(),
    now
  );
  return { soFar, target, remaining: Math.max(0, target - soFar), nextTier: tier + 1 };
}

// The single place a price is produced, on every path and every interface. Never returns a
// bare number: callers get the components too, because every screen that shows a price is
// required to be able to show the reasoning behind it.
export function priceFor({
  student,
  lessonType,
  date,
  start,
  offerDiscount = 0,
  manualAdjustment = 0,
  priceBands,
  trainerConfig,
}) {
  const band = bandForSlot(date, start, priceBands || []);
  const basePrice = Number(lessonType.basePrice);
  const bandAdjustment = bandAmountFor(lessonType, band);
  const tier =
    trainerConfig && trainerConfig.freqTier1MinRides
      ? student
        ? student.frequencyTier || 0
        : 0
      : 0;
  const frequencyDiscount = frequencyDiscountFor(lessonType, tier);
  const offer = Number(offerDiscount || 0);
  const manual = Number(manualAdjustment || 0);

  // One addition and two subtractions, in that order. Discounts stack; premiums don't compound.
  const raw = basePrice + bandAdjustment - frequencyDiscount - offer + manual;
  const price = Math.min(Math.max(raw, lessonType.minPrice), lessonType.maxPrice);

  return {
    basePrice,
    bandAdjustment,
    frequencyDiscount,
    offerDiscount: offer,
    manualAdjustment: manual,
    price,
    raw,
    band,
    tier,
    // The clamp is surfaced, never silent: a coach who believes she gave $20 off and gave $15
    // finds out from a student otherwise, which costs more trust than the $5 was worth.
    flooredBy: raw < lessonType.minPrice ? lessonType.minPrice - raw : 0,
    cappedBy: raw > lessonType.maxPrice ? raw - lessonType.maxPrice : 0,
  };
}

// The five component columns, ready to write onto a booking row. Stamped once at creation and
// never recomputed — which is what lets a student ask in November why they were charged $60 in
// March and get an answer, after the bands and tiers underneath have long since moved.
export function priceFieldsFor(args) {
  const q = priceFor(args);
  return {
    basePrice: q.basePrice,
    bandAdjustment: q.bandAdjustment,
    frequencyDiscount: q.frequencyDiscount,
    offerDiscount: q.offerDiscount,
    manualAdjustment: q.manualAdjustment,
    price: q.price,
  };
}

// Read the STORED components back off a booking for display. Falls back to a bare base price
// for any row that predates the component columns, so a legacy row renders rather than blanks.
export function priceBreakdown(booking, { lessonTypes, priceBands }) {
  const lt = lessonTypes.find((l) => l.id === booking.lessonTypeId);
  const band = bandForSlot(booking.date, booking.start, priceBands || []);
  const basePrice = booking.basePrice !== undefined ? booking.basePrice : booking.price;
  return {
    basePrice,
    bandAdjustment: booking.bandAdjustment || 0,
    frequencyDiscount: booking.frequencyDiscount || 0,
    offerDiscount: booking.offerDiscount || 0,
    manualAdjustment: booking.manualAdjustment || 0,
    price: booking.price,
    bandName: band ? band.name : null,
    lessonTypeName: lt ? lt.name : "",
  };
}

