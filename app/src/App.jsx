import React, { useState, useMemo, useRef, useEffect } from "react";
import { AlertTriangle, Check, ChevronRight, X, Plus, ArrowLeft, Square, CheckSquare } from "lucide-react";
// The matching layer, imported rather than reimplemented.
//
// Every one of these took ONE booking list and used it for both halves of the question it asks —
// which horses are free, and whether the coach is. Those have different scopes: a horse is one
// animal the whole barn shares, while the coach's day is their own. Fed only this trainer's
// bookings they offered horses a barn-mate was already riding; fed only the barn's they would
// report a coach busy while their barn-mate teaches. The engine's versions take both lists,
// which is the entire reason `trainerBookings` exists alongside `bookings`.
//
// This is the whole of `engine/matching.js` — "what should we suggest?" — and it is now the one
// copy. The RULES below ("may this booking exist?") are still a second copy of `engine/rules.js`
// and `engine/derive.js`. See CLAUDE.md, "Two copies of the rules": one layer repaid, one left.
import {
  findOpenSlots, eligibleStudentsForSlot, findIntroOptions, findRecurringOptions,
  offerRespectsPreferences, potentialLessonTypes, defaultLessonType, coachBusyIntervals,
  windowCovers, offerStats,
} from "../../engine/matching.js";

// ---------- constants ----------
// The simulated clock. Prototype-only: the seeded fixture's lessons are dated around it, so
// moving it to the real today would empty every screen until real data exists. Named here, and
// passed to the API as ?date=, so there is exactly one thing to change when that stops being
// true.
const SIMULATED_TODAY_ISO = "2026-09-15";
const TODAY = new Date(2026, 8, 15); // Tue 15 Sep 2026, matching SIMULATED_TODAY_ISO
// The clock was date-only, which made "less than 24 hours out" impossible to express -- a
// lesson later today and a lesson tomorrow morning both read as "not yet". NOW_MIN adds a
// time of day, kept separate from TODAY so date comparisons elsewhere are untouched.
const NOW_MIN = 7 * 60; // 7:00 AM
// The same simulated moment as an instant, for the engine.
//
// Engine functions take `now` as a parameter rather than reading a module-level clock, which is
// what makes the rest-day window and the 24-hour cancel boundary testable at all (engine/clock.js
// has the full reasoning). This is the one place the prototype's two-part clock is assembled
// into the single value they expect, so the screens keep one simulated now, not two.
const NOW = new Date(2026, 8, 15, Math.floor(NOW_MIN / 60), NOW_MIN % 60);

// The screens' vocabulary translated into the matching layer's, in one place.
//
// Three renames, and only the first is cosmetic:
//   availability      the screens call this trainerAvailability
//   bookings          the BARN's, for questions about a horse — one animal, shared
//   trainerBookings   this coach's, for questions about their own day
//
// The two booking lists are the point. Every function in engine/matching.js takes both, and
// handing it one list twice is the bug this replaced: the Day view offered horses a barn-mate
// was already riding. Saying it once here is what keeps the seven call sites from each getting
// their own chance to get it wrong.
const matchingCtx = (props) => ({
  ...props,
  now: NOW,
  bookings: props.barnBookings,
  trainerBookings: props.bookings,
  availability: props.trainerAvailability,
});
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon-first display, matches how availability reads naturally
const RIDING_STYLES = ["English", "Western"];
const EXP_LEVELS = ["beginner", "intermediate", "advanced"];
const EXP_RANK = { beginner: 0, intermediate: 1, advanced: 2 };

function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function fmtDate(d) { return `${d.getMonth() + 1}/${d.getDate()}`; }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function relDay(d) { if (sameDay(d, TODAY)) return "Today"; if (sameDay(d, addDays(TODAY, 1))) return "Tomorrow"; return null; }
function timeStr(mins) { const h = Math.floor(mins / 60), m = mins % 60; const ap = h >= 12 ? "PM" : "AM"; const h12 = h % 12 === 0 ? 12 : h % 12; return `${h12}:${m.toString().padStart(2, "0")} ${ap}`; }
function parseTime(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function minToStr(m) { return `${Math.floor(m / 60).toString().padStart(2, "0")}:${(m % 60).toString().padStart(2, "0")}`; }
function uid(prefix) { return prefix + "-" + Math.random().toString(36).slice(2, 8); }
function fmtWindow(w) { return `${DAY_NAMES[w.day]} ${timeStr(parseTime(w.start))}–${timeStr(parseTime(w.end))}`; }
const TIME_OPTIONS = (() => { const o = []; for (let t = 6 * 60; t <= 21 * 60; t += 15) o.push(minToStr(t)); return o; })();

// ---------- seed data ----------
const SEED_HORSES = [
  { id: "duke", name: "Duke", minExp: "intermediate", adultOnly: false, styles: ["English"], maxWeight: 180, restDaysPerWeek: 1, maxDailyAdult: 120, maxDailyOverall: 180, active: true, notes: "Prefers a slow warmup." },
  { id: "poppy", name: "Poppy", minExp: "beginner", adultOnly: false, styles: ["English"], maxWeight: 150, restDaysPerWeek: 1, maxDailyAdult: 100, maxDailyOverall: 150, active: true, notes: "" },
  { id: "rocket", name: "Rocket", minExp: "advanced", adultOnly: false, styles: ["Western"], maxWeight: 200, restDaysPerWeek: 1, maxDailyAdult: 140, maxDailyOverall: 180, active: true, notes: "" },
  { id: "nutmeg", name: "Nutmeg", minExp: "advanced", adultOnly: false, styles: ["English", "Western"], maxWeight: 170, restDaysPerWeek: 1, maxDailyAdult: 130, maxDailyOverall: 180, active: true, notes: "" },
  { id: "willow", name: "Willow", minExp: "beginner", adultOnly: false, styles: ["English"], maxWeight: 200, restDaysPerWeek: 1, maxDailyAdult: 120, maxDailyOverall: 180, active: true, notes: "Steady in a group." },
  { id: "buttercup", name: "Buttercup", minExp: "beginner", adultOnly: false, styles: ["Western"], maxWeight: 150, restDaysPerWeek: 1, maxDailyAdult: 90, maxDailyOverall: 150, active: false, notes: "" },
];

// Price bands are windows only -- no amount lives here. What a band is worth is per lesson
// type, since a flat $10 after-school premium that suits a 60-min private is wrong for a
// 30-min intro. Capped at three, and no two may overlap: a time falls in exactly zero or one
// band, or a slot has two possible prices, which is the failure this whole model prevents.
const MAX_PRICE_BANDS = 3;
const SEED_PRICE_BANDS = [
  { id: "band-after-school", name: "After school", days: [1, 2, 3, 4, 5], start: "15:00", end: "17:00" },
  { id: "band-weekday-am", name: "Weekday mornings", days: [1, 2, 3, 4, 5], start: "08:00", end: "11:00" },
];

// basePrice is the anchor, not a target the price drifts around. bandAdjustments is signed and
// per band -- a band absent from the map contributes 0, so a coach who prices only one of their
// bands differently for this type writes one entry. freqDiscount1/2 and gapFillDiscount are
// blank-able: an intro lesson is deliberately not frequency-discounted and never gap-filled.
const SEED_LESSON_TYPES = [
  { id: "adult-private", name: "60-min adult private", durationMin: 60, rideTimeMin: 45, isGroup: false, basePrice: 65, minPrice: 55, maxPrice: 80, bandAdjustments: { "band-after-school": 10, "band-weekday-am": -5 }, freqDiscount1: 5, freqDiscount2: 10, gapFillDiscount: 10, restrictedHorseIds: [], ridingStyles: [], potentialEligible: true },
  { id: "child-private", name: "45-min child private", durationMin: 45, rideTimeMin: 30, isGroup: false, basePrice: 50, minPrice: 40, maxPrice: 60, bandAdjustments: { "band-after-school": 5 }, freqDiscount1: 5, freqDiscount2: 5, gapFillDiscount: 5, restrictedHorseIds: [], ridingStyles: [], potentialEligible: true },
  // Group: bands and frequency apply like any other type, but gapFillDiscount is meaningless
  // here -- group types are excluded from slot discovery entirely, so it's never offered.
  { id: "adult-group", name: "60-min adult group", durationMin: 60, rideTimeMin: 45, isGroup: true, maxGroupSize: 4, basePrice: 40, minPrice: 35, maxPrice: 50, bandAdjustments: { "band-after-school": 5 }, freqDiscount1: 0, freqDiscount2: 5, gapFillDiscount: null, restrictedHorseIds: [], ridingStyles: [], potentialEligible: false },
  // Coach has unchecked the intro type: a first lesson is for a brand-new student, not a gap
  // an existing student fills. Allowed by the rule, just not what this coach wants offered.
  // Flat-priced on purpose: no bands, no frequency discount, min == max == base.
  { id: "first-time", name: "First time student", isIntro: true, durationMin: 30, rideTimeMin: 20, isGroup: false, basePrice: 45, minPrice: 45, maxPrice: 45, bandAdjustments: {}, freqDiscount1: null, freqDiscount2: null, gapFillDiscount: null, restrictedHorseIds: ["duke", "poppy", "nutmeg"], ridingStyles: [], potentialEligible: false },
];

// Availability is a flat list of windows, not one row per day -- a day can have zero, one,
// or several windows (e.g. Mon 8-12 AND Mon 3-8), matching real split-shift schedules.
const SEED_TRAINER_AVAILABILITY = [
  { id: "avail-1", day: 1, start: "08:00", end: "17:00" },
  { id: "avail-2", day: 2, start: "08:00", end: "17:00" },
  { id: "avail-3", day: 3, start: "08:00", end: "17:00" },
  { id: "avail-4", day: 4, start: "08:00", end: "17:00" },
  { id: "avail-5", day: 5, start: "08:00", end: "17:00" },
  { id: "avail-6", day: 6, start: "08:00", end: "17:00" },
];

// One demo time-off block so the conflict/alert flow is visible immediately: Jordan's Friday
// recurring lesson and Casey's Saturday lesson both fall inside it.
const SEED_TIME_OFF = [
  { id: "off-1", startDate: addDays(TODAY, 3), endDate: addDays(TODAY, 4), reason: "Vacation" },
];

// lateCancelHours is the notice a student must give for a cancellation to be non-billable.
// Cancel with less warning than this and the lesson is still charged.
// freqTier1MinRides doubles as the prioritization rule's threshold -- one definition of
// "frequent rider" driving both scheduling flex and pricing, so the two can never disagree.
// At real launch both tier fields start blank, which switches frequency pricing off entirely
// (there's no completed month to compute a tier from on day one). Seeded populated here so
// the mechanism is exercisable; clearing either field is a supported state, not a broken one.
const SEED_TRAINER_CONFIG = { minBufferMin: 15, maxBufferMin: 30, maxBackToBack: 4, schedulingPreference: "back_to_back", lateCancelHours: 24, freqTier1MinRides: 8, freqTier2MinRides: 12 };

const SEED_STUDENTS = [
  { id: "maya", name: "Maya R.", phone: "5550001", age: 24, emergencyContactName: "Ruth R.", emergencyContactPhone: "5551001", experienceLevel: "intermediate", ridingStyles: ["English"], weight: 140, targetTimes: [{ day: 2, start: "09:00", end: "10:00" }, { day: 4, start: "09:00", end: "10:00" }, { day: 1, start: "09:00", end: "10:00" }], potentialTimes: [{ day: 2, start: "13:00", end: "16:00" }], notificationPref: "target_and_potential", noRideHorses: [], notes: "", profileStatus: "approved", recurringUnlocked: true, active: true, frequencyTier: 0, frequencyTierMonth: null },
  { id: "taylor", name: "Taylor B.", phone: "5550002", age: 16, guardianName: "Denise B.", guardianPhone: "5550002", guardianRelationship: "Parent", emergencyContactName: "Ray B.", emergencyContactPhone: "5551013", experienceLevel: "beginner", ridingStyles: ["Western"], weight: 110, targetTimes: [{ day: 2, start: "10:00", end: "11:00" }], potentialTimes: [], notificationPref: "target_only", noRideHorses: ["rocket"], notes: "", profileStatus: "approved", recurringUnlocked: true, active: true, frequencyTier: 0, frequencyTierMonth: null },
  { id: "jordan", name: "Jordan T.", phone: "5550003", age: 20, emergencyContactName: "Bea T.", emergencyContactPhone: "5551003", experienceLevel: "intermediate", ridingStyles: ["English"], weight: 150, targetTimes: [{ day: 5, start: "16:00", end: "17:00" }, { day: 2, start: "13:00", end: "14:00" }], potentialTimes: [], notificationPref: "target_only", noRideHorses: [], notes: "", profileStatus: "approved", recurringUnlocked: true, active: true, frequencyTier: 0, frequencyTierMonth: null },
  { id: "casey", name: "Casey L.", phone: "5550004", age: 27, emergencyContactName: "Sam L.", emergencyContactPhone: "5551004", experienceLevel: "beginner", ridingStyles: ["Western"], weight: 140, targetTimes: [{ day: 6, start: "10:00", end: "11:00" }], potentialTimes: [], notificationPref: "target_only", noRideHorses: [], notes: "", profileStatus: "approved", recurringUnlocked: true, active: true, frequencyTier: 0, frequencyTierMonth: null },
  { id: "alex", name: "Alex M.", phone: "5550005", age: 30, emergencyContactName: "Jo M.", emergencyContactPhone: "5551005", experienceLevel: "intermediate", ridingStyles: ["Western"], weight: 160, targetTimes: [{ day: 4, start: "14:00", end: "15:00" }], potentialTimes: [], notificationPref: "target_only", noRideHorses: [], notes: "", profileStatus: "approved", recurringUnlocked: true, active: true, frequencyTier: 0, frequencyTierMonth: null },
  { id: "riley", name: "Riley P.", phone: "5550006", age: 26, emergencyContactName: "Dev P.", emergencyContactPhone: "5551006", experienceLevel: "intermediate", ridingStyles: ["English"], weight: 145, targetTimes: [{ day: 0, start: "13:00", end: "14:00" }], potentialTimes: [{ day: 2, start: "13:00", end: "16:00" }], notificationPref: "target_and_potential", noRideHorses: [], notes: "", profileStatus: "approved", recurringUnlocked: false, active: true, frequencyTier: 0, frequencyTierMonth: null },
  { id: "jamie", name: "Jamie Lopez", phone: "5550007", age: 24, emergencyContactName: "Ana Lopez", emergencyContactPhone: "5551007", experienceLevel: "intermediate", ridingStyles: ["English"], weight: 135, targetTimes: [{ day: 3, start: "15:00", end: "17:00" }, { day: 6, start: "09:00", end: "11:00" }], potentialTimes: [{ day: 2, start: "15:00", end: "17:00" }], notificationPref: "target_and_potential", noRideHorses: [], notes: "", profileStatus: "approved", recurringUnlocked: true, active: true, frequencyTier: 0, frequencyTierMonth: null },
  { id: "emma", name: "Emma Chen", phone: "5559001", age: 10, guardianName: "Denise Chen", guardianPhone: "5559001", guardianRelationship: "Parent", emergencyContactName: "Wei Chen", emergencyContactPhone: "5551014", experienceLevel: "beginner", ridingStyles: ["Western"], weight: 70, targetTimes: [{ day: 6, start: "10:00", end: "12:00" }], potentialTimes: [], notificationPref: "target_only", noRideHorses: [], notes: "", profileStatus: "pending_review", recurringUnlocked: false, active: true, frequencyTier: 0, frequencyTierMonth: null },
  { id: "morgan", name: "Morgan T.", phone: "5559002", age: 22, emergencyContactName: "Kit T.", emergencyContactPhone: "5551008", experienceLevel: "intermediate", ridingStyles: ["Western"], weight: 150, targetTimes: [{ day: 4, start: "16:00", end: "18:00" }], potentialTimes: [], notificationPref: "target_only", noRideHorses: [], notes: "", profileStatus: "pending_review", recurringUnlocked: false, active: true, frequencyTier: 0, frequencyTierMonth: null },

  // ---- students seeded specifically to exercise the potential-lesson flow ----
  // All five carry wide target/potential windows, so a single open slot draws more candidates
  // than the notify screen auto-selects. Their offer histories differ deliberately, which is
  // what makes the acceptance-rate ordering visible rather than theoretical.
  { id: "nina", name: "Nina K.", phone: "5550008", age: 41, emergencyContactName: "Paul K.", emergencyContactPhone: "5551009", experienceLevel: "advanced", ridingStyles: ["Western"], weight: 155, targetTimes: [{ day: 2, start: "13:00", end: "18:00" }, { day: 3, start: "14:00", end: "17:00" }], potentialTimes: [{ day: 4, start: "09:00", end: "12:00" }, { day: 6, start: "13:00", end: "16:00" }], notificationPref: "target_and_potential", noRideHorses: [], notes: "Takes almost every gap offered.", profileStatus: "approved", recurringUnlocked: true, active: true, frequencyTier: 0, frequencyTierMonth: null },
  { id: "priya", name: "Priya N.", phone: "5550009", age: 29, emergencyContactName: "Ravi N.", emergencyContactPhone: "5551010", experienceLevel: "intermediate", ridingStyles: ["English"], weight: 138, targetTimes: [{ day: 2, start: "13:00", end: "17:00" }, { day: 4, start: "13:00", end: "17:00" }], potentialTimes: [{ day: 1, start: "09:00", end: "12:00" }, { day: 3, start: "09:00", end: "12:00" }, { day: 5, start: "13:00", end: "16:00" }], notificationPref: "target_and_potential", noRideHorses: [], notes: "", profileStatus: "approved", recurringUnlocked: true, active: true, frequencyTier: 0, frequencyTierMonth: null },
  // target_only: appears against her Tue/Fri target windows, and is correctly absent from any
  // slot that only matches a potential window.
  { id: "dana", name: "Dana W.", phone: "5550010", age: 52, emergencyContactName: "Ellis W.", emergencyContactPhone: "5551011", experienceLevel: "intermediate", ridingStyles: ["English"], weight: 148, targetTimes: [{ day: 2, start: "13:00", end: "16:00" }, { day: 5, start: "09:00", end: "12:00" }], potentialTimes: [{ day: 1, start: "13:00", end: "16:00" }, { day: 3, start: "13:00", end: "16:00" }, { day: 4, start: "13:00", end: "16:00" }, { day: 6, start: "09:00", end: "12:00" }], notificationPref: "target_only", noRideHorses: [], notes: "", profileStatus: "approved", recurringUnlocked: true, active: true, frequencyTier: 0, frequencyTierMonth: null },
  // Beginner at 160 lbs: Poppy is under his weight limit and Duke needs intermediate, so
  // Willow is his only eligible horse -- a candidate who drops out the moment Willow is busy.
  { id: "marcus", name: "Marcus D.", phone: "5550011", age: 34, emergencyContactName: "Lena D.", emergencyContactPhone: "5551012", experienceLevel: "beginner", ridingStyles: ["English"], weight: 160, targetTimes: [{ day: 2, start: "13:00", end: "16:00" }, { day: 6, start: "09:00", end: "12:00" }], potentialTimes: [{ day: 1, start: "15:00", end: "17:00" }, { day: 3, start: "15:00", end: "17:00" }, { day: 5, start: "15:00", end: "17:00" }], notificationPref: "target_and_potential", noRideHorses: [], notes: "Offered three gaps, took none.", profileStatus: "approved", recurringUnlocked: true, active: true, frequencyTier: 0, frequencyTierMonth: null },
  // 17, so the guardian operates the account -- and after-school windows only.
  { id: "oscar", name: "Oscar B.", phone: "5550012", age: 17, guardianName: "Renata B.", guardianPhone: "5550012", guardianRelationship: "Parent", emergencyContactName: "Tomas B.", emergencyContactPhone: "5551015", experienceLevel: "intermediate", ridingStyles: ["English"], weight: 125, targetTimes: [{ day: 2, start: "15:00", end: "17:00" }, { day: 4, start: "15:00", end: "17:00" }], potentialTimes: [{ day: 6, start: "09:00", end: "13:00" }], notificationPref: "target_and_potential", noRideHorses: [], notes: "", profileStatus: "approved", recurringUnlocked: true, active: true, frequencyTier: 0, frequencyTierMonth: null },
];

// The returning-student entry point drops straight into an established account instead of
// onboarding. Maya is the pick: three active recurring lessons, twelve booked occurrences in
// the rolling window, and four riding-time windows -- the densest existing schedule in the
// seed data, which is what makes the returning-student home worth designing against.
const DEMO_RETURNING_STUDENT_ID = "maya";

const SEED_RECURRING = [
  { id: "rec-maya-tue", studentId: "maya", horseId: "duke", lessonTypeId: "adult-private", day: 2, start: "09:00", status: "active", justCreated: false, historyWeeks: 40, historySubHorseIds: ["poppy"] },
  { id: "rec-maya-thu", studentId: "maya", horseId: "duke", lessonTypeId: "adult-private", day: 4, start: "09:00", status: "active", justCreated: false, historyWeeks: 30, historySubHorseIds: ["willow"] },
  { id: "rec-maya-mon", studentId: "maya", horseId: "duke", lessonTypeId: "adult-private", day: 1, start: "09:00", status: "active", justCreated: false, historyWeeks: 14, historySubHorseIds: [] },
  { id: "rec-taylor-tue", studentId: "taylor", horseId: "buttercup", lessonTypeId: "child-private", day: 2, start: "10:15", status: "active", justCreated: false, historyWeeks: 22, historySubHorseIds: ["poppy"] },
  { id: "rec-jordan-fri", studentId: "jordan", horseId: "duke", lessonTypeId: "adult-private", day: 5, start: "16:00", status: "active", justCreated: false, historyWeeks: 26, historySubHorseIds: [] },
  { id: "rec-casey-sat", studentId: "casey", horseId: "buttercup", lessonTypeId: "adult-private", day: 6, start: "10:00", status: "active", justCreated: false, historyWeeks: 11, historySubHorseIds: ["willow"] },
  { id: "rec-alex-thu", studentId: "alex", horseId: "buttercup", lessonTypeId: "adult-private", day: 4, start: "14:00", status: "active", justCreated: false, historyWeeks: 18, historySubHorseIds: ["rocket"] },
  { id: "rec-jamie-wed", studentId: "jamie", horseId: "poppy", lessonTypeId: "adult-private", day: 3, start: "15:00", status: "active", justCreated: true, historyWeeks: 0, historySubHorseIds: [] },
];

const SEED_INACTIVE_PERIODS = [
  { id: "ina-buttercup", horseId: "buttercup", startDate: addDays(TODAY, -1), estimatedEndDate: addDays(TODAY, 5), actualEndDate: null, status: "active", reason: "Lame" },
];
const SEED_SUB_ASSIGNMENTS = [
  { id: "sub-casey", periodId: "ina-buttercup", recurringId: "rec-casey-sat", bookingId: null, substituteHorseId: "duke", confirmed: true },
  { id: "sub-alex", periodId: "ina-buttercup", recurringId: "rec-alex-thu", bookingId: null, substituteHorseId: "rocket", confirmed: true },
];

// Past offers, with the bookings that resulted from the accepted ones. Acceptance isn't
// stored -- an offer counts as accepted when a Bookings row exists for that student at that
// date and time -- so the history has to include both sides. All well in the past, so it
// can't disturb the rolling rest-day and usage-cap windows.
const SEED_OFFERS = [
  { id: "ofr-1", studentId: "jamie", date: addDays(TODAY, -21), start: "14:00", horseId: "poppy", lessonTypeId: "adult-private", lessonId: null, kind: "potential", offerDiscount: 10, offerReason: "filling a gap", offeredAt: addDays(TODAY, -22), response: null, rank: 1 },
  { id: "ofr-2", studentId: "jamie", date: addDays(TODAY, -14), start: "14:00", horseId: "poppy", lessonTypeId: "adult-private", lessonId: null, kind: "potential", offerDiscount: 10, offerReason: "filling a gap", offeredAt: addDays(TODAY, -15), response: null, rank: 2 },
  { id: "ofr-3", studentId: "jamie", date: addDays(TODAY, -9), start: "11:00", horseId: "duke", lessonTypeId: "adult-private", lessonId: null, kind: "potential", offeredAt: addDays(TODAY, -10), response: null, rank: 3 },
  { id: "ofr-4", studentId: "maya", date: addDays(TODAY, -20), start: "13:00", horseId: "duke", lessonTypeId: "adult-private", lessonId: null, kind: "potential", offeredAt: addDays(TODAY, -21), response: null, rank: 1 },
  { id: "ofr-5", studentId: "maya", date: addDays(TODAY, -13), start: "13:00", horseId: "duke", lessonTypeId: "adult-private", lessonId: null, kind: "potential", offeredAt: addDays(TODAY, -14), response: null, rank: 2 },
  { id: "ofr-6", studentId: "riley", date: addDays(TODAY, -16), start: "13:00", horseId: "willow", lessonTypeId: "adult-private", lessonId: null, kind: "potential", offerDiscount: 10, offerReason: "filling a gap", offeredAt: addDays(TODAY, -17), response: null, rank: 1 },
  // Nina 2/2, Priya 3/4, Dana 1/1, Marcus 0/3, Oscar no history -- enough spread that the
  // ranked order on the notify screen is unmistakable.
  { id: "ofr-7", studentId: "nina", date: addDays(TODAY, -23), start: "11:00", horseId: "nutmeg", lessonTypeId: "adult-private", lessonId: null, kind: "target", offeredAt: addDays(TODAY, -24), response: null, rank: 1 },
  { id: "ofr-8", studentId: "nina", date: addDays(TODAY, -16), start: "11:00", horseId: "nutmeg", lessonTypeId: "adult-private", lessonId: null, kind: "potential", offerDiscount: 10, offerReason: "filling a gap", offeredAt: addDays(TODAY, -17), response: null, rank: 1 },
  { id: "ofr-9", studentId: "priya", date: addDays(TODAY, -25), start: "14:00", horseId: "duke", lessonTypeId: "adult-private", lessonId: null, kind: "target", offeredAt: addDays(TODAY, -26), response: null, rank: 2 },
  { id: "ofr-10", studentId: "priya", date: addDays(TODAY, -18), start: "14:00", horseId: "duke", lessonTypeId: "adult-private", lessonId: null, kind: "target", offeredAt: addDays(TODAY, -19), response: null, rank: 1 },
  { id: "ofr-11", studentId: "priya", date: addDays(TODAY, -11), start: "14:00", horseId: "duke", lessonTypeId: "adult-private", lessonId: null, kind: "potential", offerDiscount: 10, offerReason: "filling a gap", offeredAt: addDays(TODAY, -12), response: null, rank: 2 },
  { id: "ofr-12", studentId: "priya", date: addDays(TODAY, -8), start: "16:00", horseId: "willow", lessonTypeId: "adult-private", lessonId: null, kind: "potential", offeredAt: addDays(TODAY, -9), response: null, rank: 3 },
  { id: "ofr-13", studentId: "dana", date: addDays(TODAY, -20), start: "10:00", horseId: "willow", lessonTypeId: "adult-private", lessonId: null, kind: "target", offeredAt: addDays(TODAY, -21), response: null, rank: 1 },
  { id: "ofr-14", studentId: "marcus", date: addDays(TODAY, -24), start: "16:00", horseId: "willow", lessonTypeId: "adult-private", lessonId: null, kind: "potential", offeredAt: addDays(TODAY, -25), response: null, rank: 3 },
  { id: "ofr-15", studentId: "marcus", date: addDays(TODAY, -17), start: "16:00", horseId: "willow", lessonTypeId: "adult-private", lessonId: null, kind: "potential", offeredAt: addDays(TODAY, -18), response: null, rank: 4 },
  { id: "ofr-16", studentId: "marcus", date: addDays(TODAY, -10), start: "16:00", horseId: "willow", lessonTypeId: "adult-private", lessonId: null, kind: "target", offeredAt: addDays(TODAY, -11), response: null, rank: 2 },
];

// Declared here, above the seed that consumes it, rather than down in the disclosures section:
// a `const` is in its temporal dead zone until the line that declares it runs, so a seed built
// from it must come after. (Function declarations hoist, which is why the helpers can stay put.)
// One current set of terms, edited in place. There is deliberately no version history: the terms
// themselves reserve the coach's right to change them, and scheduling a lesson after a change is
// the rider's acceptance of it. That mechanic only works if there is a single set of terms in
// force at any moment -- a rider can't be "on v2" when the agreement they signed says the current
// terms apply. Simplicity here is load-bearing rather than a shortcut.
const STANDARD_DISCLOSURES = [
  {
    key: "risk",
    included: true,
    title: "Risk of injury around horses",
    body: "Horses are large, powerful animals and can behave unpredictably regardless of training or handling. Riding and being near horses carries an inherent risk of serious injury or death, including from falls, kicks, bites, and being stepped on or crushed. These risks cannot be eliminated by instruction, equipment, or supervision. I understand and accept these risks. I confirm I am physically able to participate, and that I will tell my coach about any medical condition, injury, or medication that could affect my safety.",
  },
  {
    key: "waiver",
    included: true,
    title: "Waiver of liability",
    body: "In exchange for being allowed to take lessons, I release my coach and the facility where lessons take place \u2014 along with their owners, employees, and volunteers \u2014 from liability for injury, death, or property loss arising from my participation, except where caused by their gross negligence or wilful misconduct. I agree not to bring a claim or lawsuit for such loss. If I am signing for a rider under 18, I am their parent or legal guardian and I sign on their behalf.",
  },
  {
    key: "refusal",
    included: true,
    title: "The coach may decline or end lessons",
    body: "My coach may decline to offer lessons, or stop offering them, at their sole discretion. Reasons include rider or horse safety, a mismatch between a rider's experience and what can be safely taught, unpaid balances, or conduct they judge unsafe or disrespectful. My coach may also end a lesson already in progress if they consider it unsafe to continue. A declined or ended lesson is not a judgement on me as a person.",
  },
  {
    key: "payment",
    included: true,
    title: "Payment and cancellation",
    body: "I agree to pay for lessons in full and on time, by whatever method my coach has arranged with me. Lessons cancelled with less than the required notice are still charged in full, as is failing to attend without cancelling. Cancelling with the required notice or more is not charged. My coach may pause or decline further lessons while a balance is outstanding.",
  },
  {
    key: "horse_care",
    included: true,
    title: "Treating the horses well",
    body: "I will treat every horse with patience and respect. I will follow my coach's instructions on handling, tack, and riding at all times, and use only the aids and equipment they approve. I will not strike a horse in anger, use force as punishment, feed any horse without permission, or handle a horse I have not been assigned. I will report anything that seems wrong with a horse \u2014 lameness, injury, distress, or a change in behaviour \u2014 as soon as I notice it.",
  },
  {
    key: "pricing",
    included: true,
    title: "How lesson pricing works",
    body: "Lesson prices are set by my coach and can vary between lessons for reasons that are always shown to me. Some times of day are priced differently from others. Riders who ride often may earn a standing discount, which is recalculated monthly and can go up or down. My coach may offer a one-time discount to fill an open slot; those offers apply to that lesson only and are not a change to my usual rate. Every price I am shown includes a breakdown of how it was reached, and the price of a booked lesson is fixed at the moment it is booked.",
  },
  // The section that makes editing-in-place work. It gets its own heading and its own tick rather
  // than a clause buried inside the waiver, because it is the term that governs all the others --
  // a rider agreeing to it should have to notice it.
  {
    key: "changes",
    included: true,
    title: "These terms can change",
    body: "My coach may change these terms, disclosures, and policies at any time, including after I have signed them. The current version is always the one that applies, and it is always available to me in this app under Agreements. My coach will notify me when the terms change. If I schedule, attend, or keep a lesson after a change has been made, that is my acceptance of the changed terms. If I do not accept them, my option is to stop scheduling lessons and to tell my coach.",
  },
];

// One current set of terms, plus when they last changed and what changed. Seeded as having been
// updated two days ago, so the "scheduled since the change" mechanic is live on load.
const SEED_DISCLOSURES = {
  sections: STANDARD_DISCLOSURES.map((d) =>
    d.key === "payment"
      ? { ...d, body: d.body + " I understand that repeated late payment may end my lessons entirely." }
      : { ...d }
  ),
  updatedAt: addDays(TODAY, -2),
  updateNote: "Added that repeated late payment may end lessons",
  firstPublishedAt: addDays(TODAY, -180),
};

// One signature per rider, given when they created their profile. There is nothing to re-sign:
// what keeps them current is continuing to book under the terms in force.
const SEED_DISCLOSURE_ACCEPTANCES = ["maya", "taylor", "jordan", "casey", "alex", "riley", "jamie", "nina", "dana", "marcus", "oscar", "priya"]
  .map((id, i) => ({ id: `dac-${id}`, studentId: id, acceptedAt: addDays(TODAY, -170 + i), signedName: null }));

const SEED_ADHOC_BOOKINGS = [
  // The three accepted offers above, as the bookings they became.
  { id: "bkg-jamie-acc1", recurringId: null, studentId: "jamie", horseId: "poppy", lessonTypeId: "adult-private", date: addDays(TODAY, -21), start: "14:00", status: "completed", price: 55, offerDiscount: 10, isBillable: true, isNewStudent: false, notes: "Gap-fill offer, discounted" },
  { id: "bkg-jamie-acc2", recurringId: null, studentId: "jamie", horseId: "poppy", lessonTypeId: "adult-private", date: addDays(TODAY, -14), start: "14:00", status: "completed", price: 55, offerDiscount: 10, isBillable: true, isNewStudent: false, notes: "Gap-fill offer, discounted" },
  { id: "bkg-riley-acc1", recurringId: null, studentId: "riley", horseId: "willow", lessonTypeId: "adult-private", date: addDays(TODAY, -16), start: "13:00", status: "completed", price: 55, offerDiscount: 10, isBillable: true, isNewStudent: false, notes: "Gap-fill offer, discounted" },
  { id: "bkg-nina-acc1", recurringId: null, studentId: "nina", horseId: "nutmeg", lessonTypeId: "adult-private", date: addDays(TODAY, -23), start: "11:00", status: "completed", price: 65, isBillable: true, isNewStudent: false, notes: "Took the offered gap" },
  { id: "bkg-nina-acc2", recurringId: null, studentId: "nina", horseId: "nutmeg", lessonTypeId: "adult-private", date: addDays(TODAY, -16), start: "11:00", status: "completed", price: 55, offerDiscount: 10, isBillable: true, isNewStudent: false, notes: "Took the offered gap, discounted" },
  { id: "bkg-priya-acc1", recurringId: null, studentId: "priya", horseId: "duke", lessonTypeId: "adult-private", date: addDays(TODAY, -25), start: "14:00", status: "completed", price: 65, isBillable: true, isNewStudent: false, notes: "Took the offered gap" },
  { id: "bkg-priya-acc2", recurringId: null, studentId: "priya", horseId: "duke", lessonTypeId: "adult-private", date: addDays(TODAY, -18), start: "14:00", status: "completed", price: 65, isBillable: true, isNewStudent: false, notes: "Took the offered gap" },
  { id: "bkg-priya-acc3", recurringId: null, studentId: "priya", horseId: "duke", lessonTypeId: "adult-private", date: addDays(TODAY, -11), start: "14:00", status: "completed", price: 55, offerDiscount: 10, isBillable: true, isNewStudent: false, notes: "Took the offered gap, discounted" },
  { id: "bkg-dana-acc1", recurringId: null, studentId: "dana", horseId: "willow", lessonTypeId: "adult-private", date: addDays(TODAY, -20), start: "10:00", status: "completed", price: 65, isBillable: true, isNewStudent: false, notes: "Took the offered gap" },
  { id: "bkg-riley-intro", recurringId: null, studentId: "riley", horseId: "duke", lessonTypeId: "first-time", date: addDays(TODAY, -10), start: "13:00", status: "completed", price: 45, isBillable: true, isNewStudent: true, notes: "" },
  { id: "bkg-riley-adhoc", recurringId: null, studentId: "riley", horseId: "duke", lessonTypeId: "adult-private", date: addDays(TODAY, 5), start: "13:00", status: "confirmed", price: 65, isBillable: true, isNewStudent: false, notes: "" },
  { id: "bkg-morgan-intro", recurringId: null, studentId: "morgan", horseId: "duke", lessonTypeId: "first-time", date: addDays(TODAY, 2), start: "16:00", status: "confirmed", price: 45, isBillable: true, isNewStudent: true, notes: "" },
  { id: "bkg-emma-intro", recurringId: null, studentId: "emma", horseId: "poppy", lessonTypeId: "first-time", date: addDays(TODAY, 4), start: "10:00", status: "confirmed", price: 45, isBillable: true, isNewStudent: true, notes: "" },
  // A group session with two of its four spots taken -- one coach slot, two Bookings rows,
  // two horses. Seeded so the collapsed group row and the "spots left" opening are visible.
  { id: "bkg-jamie-group", recurringId: null, studentId: "jamie", horseId: "poppy", lessonTypeId: "adult-group", date: addDays(TODAY, 1), start: "13:00", status: "confirmed", price: 40, isBillable: true, isNewStudent: false, notes: "" },
  { id: "bkg-riley-group", recurringId: null, studentId: "riley", horseId: "willow", lessonTypeId: "adult-group", date: addDays(TODAY, 1), start: "13:00", status: "confirmed", price: 40, isBillable: true, isNewStudent: false, notes: "" },
];

// ---------- disclosures ----------

// Include / don't-include is per section, so what riders actually sign is whatever subset the
// coach has switched on. A coach who wants no agreements at all switches them all off -- there is
// deliberately no separate master switch, because two controls that both mean "collect nothing"
// can disagree, and then the screen and the rider see different answers.
function includedSections(disclosures) {
  if (!disclosures || !disclosures.sections) return [];
  return disclosures.sections.filter((d) => d.included !== false);
}

// A student's standing, in one place. With no versions, the only question is whether they have
// ever signed -- everything after that is governed by the changes clause.
function disclosureStatus(student, disclosures, acceptances) {
  const sections = includedSections(disclosures);
  const enabled = sections.length > 0;
  const acceptance = student ? acceptances.find((a) => a.studentId === student.id) || null : null;
  return {
    enabled,
    sections,
    published: enabled,
    acceptance,
    hasSigned: !!acceptance,
    // The only gate left. A rider who has never signed at all still has to; a rider who signed
    // before a change does not, because their continued booking is what accepts it.
    outstanding: enabled && !acceptance,
  };
}

// Which of a rider's lessons were scheduled AFTER the terms last changed. This is what turns the
// changes clause from a sentence into something observable: the coach can see who has accepted
// the current terms by acting under them, and the rider can see the same thing about themselves.
// Without it, "scheduling is acceptance" would be an assertion nobody could check.
function bookingsSinceTermsChanged(studentId, bookings, disclosures) {
  if (!disclosures || !disclosures.updatedAt) return [];
  return bookings.filter((b) => b.studentId === studentId && b.createdAt && b.createdAt >= disclosures.updatedAt);
}

function hasAcceptedCurrentTerms(student, bookings, disclosures, acceptances) {
  const acceptance = acceptances.find((a) => a.studentId === student.id);
  if (!acceptance) return false;
  // Signing after the last change is acceptance in the ordinary way; so is booking after it.
  if (disclosures.updatedAt && acceptance.acceptedAt >= disclosures.updatedAt) return true;
  return bookingsSinceTermsChanged(student.id, bookings, disclosures).length > 0;
}

// The pricing disclosure describes the MECHANISM, which the coach writes. The live numbers are
// appended underneath and regenerate from config, so changing a band never leaves the disclosure
// stating a figure that is no longer true.
function pricingSummaryLines(lessonTypes, priceBands, trainerConfig) {
  const lines = [];
  lessonTypes.forEach((lt) => {
    const bits = [`Base $${lt.basePrice}`];
    Object.entries(lt.bandAdjustments || {}).filter(([, v]) => v).forEach(([id, v]) => {
      const band = priceBands.find((b) => b.id === id);
      bits.push(`${band ? band.name : "band"} ${v > 0 ? "+" : "\u2212"}$${Math.abs(v)}`);
    });
    if (lt.freqDiscount1) bits.push(`${trainerConfig.freqTier1MinRides}+ rides/month \u2212$${lt.freqDiscount1}`);
    if (lt.freqDiscount2 && trainerConfig.freqTier2MinRides) bits.push(`${trainerConfig.freqTier2MinRides}+ rides/month \u2212$${lt.freqDiscount2}`);
    bits.push(`never below $${lt.minPrice} or above $${lt.maxPrice}`);
    lines.push({ name: lt.name, detail: bits.join(" \u00b7 ") });
  });
  priceBands.forEach((b) => {
    lines.push({ name: b.name, detail: `${b.days.map((d) => DAY_NAMES[d]).join(" ")} ${timeStr(parseTime(b.start))}\u2013${timeStr(parseTime(b.end))}` });
  });
  return lines;
}

// ---------- pricing ----------
// Three adjustments, deliberately kept apart because they attach to different things and become
// knowable at different moments: a band premium belongs to the SLOT (uniform, published in
// advance), a frequency discount belongs to the STUDENT (a rate they hold, moving on a stated
// date), and a gap-fill discount belongs to the OFFER (one-time, coach-initiated, reason
// attached). Blended into one number they'd be the "$60 last week, $65 this week" confusion
// this model exists to prevent. Every amount is whole dollars, so the total is a whole number
// by construction -- there is no rounding step anywhere in this file.

const MONTH_KEY = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

// A band matches on START TIME alone, not on overlap. A 60-min lesson beginning at 2:45 against
// a 3-6pm band is a 2:45 lesson: pricing it as premium because it runs into the band would
// surprise whoever deliberately booked the earlier slot.
function bandForSlot(date, start, priceBands) {
  const dayIdx = date.getDay();
  const t = parseTime(start);
  return priceBands.find((b) => b.days.includes(dayIdx) && t >= parseTime(b.start) && t < parseTime(b.end)) || null;
}

function bandAmountFor(lessonType, band) {
  if (!band) return 0;
  return Number((lessonType.bandAdjustments || {})[band.id] || 0);
}

// Two bands may not overlap on any shared day. Checked at Setup rather than at booking time,
// because the fix belongs where the coach is already editing.
function bandOverlap(candidate, priceBands) {
  const cs = parseTime(candidate.start), ce = parseTime(candidate.end);
  return priceBands.find((b) => b.id !== candidate.id && b.days.some((d) => candidate.days.includes(d)) && parseTime(b.start) < ce && parseTime(b.end) > cs) || null;
}

function frequencyDiscountFor(lessonType, tier) {
  if (!tier) return 0;
  const v = tier === 2 ? lessonType.freqDiscount2 : lessonType.freqDiscount1;
  return Number(v || 0);
}

// Billable rides in a given calendar month. Billable rather than ridden, deliberately: a late
// cancel or no-show was paid for, and docking someone's rate for a lesson they were charged
// for is the kind of unfairness that gets noticed.
function billableRidesInMonth(studentId, bookings, year, month) {
  return bookings.filter((b) => b.studentId === studentId && b.date.getFullYear() === year && b.date.getMonth() === month && b.isBillable && effectiveStatus(b) !== "early_cancel" && b.date < TODAY).length;
}

function tierFromRides(rides, trainerConfig) {
  const t1 = trainerConfig.freqTier1MinRides, t2 = trainerConfig.freqTier2MinRides;
  if (!t1) return 0; // blank threshold switches frequency pricing off entirely
  if (t2 && rides >= t2) return 2;
  if (rides >= t1) return 1;
  return 0;
}

// The monthly recompute, as one function. The tier is the BETTER of the last two completed
// calendar months -- that single line is the whole ratchet: a good month raises the rate at
// once, a bad month can't lower it until it's been bad twice, so nobody opens the app to an
// unexplained price rise after a week off sick.
function earnedTier(studentId, bookings, trainerConfig, asOf) {
  const ref = asOf || TODAY;
  const months = [1, 2].map((back) => new Date(ref.getFullYear(), ref.getMonth() - back, 1));
  const tiers = months.map((m) => tierFromRides(billableRidesInMonth(studentId, bookings, m.getFullYear(), m.getMonth()), trainerConfig));
  return Math.max(...tiers);
}

// What the student needs for the next tier, for the progress line on their Profile. Measured
// against THIS month's count so far, so it reads as a target rather than a verdict.
function nextTierProgress(student, bookings, trainerConfig) {
  const tier = student.frequencyTier || 0;
  const t1 = trainerConfig.freqTier1MinRides, t2 = trainerConfig.freqTier2MinRides;
  if (!t1) return null;
  const target = tier === 0 ? t1 : tier === 1 ? t2 : null;
  if (!target) return null; // already at the top tier: say so and stop, don't invent a goal
  const soFar = billableRidesInMonth(student.id, bookings, TODAY.getFullYear(), TODAY.getMonth());
  return { soFar, target, remaining: Math.max(0, target - soFar), nextTier: tier + 1 };
}

// The single place a price is produced, on every path and both interfaces. Never returns a bare
// number: callers get the components too, because every screen that shows a price is required
// to be able to show the reasoning behind it.
function priceFor({ student, lessonType, date, start, offerDiscount = 0, manualAdjustment = 0, priceBands, trainerConfig }) {
  const band = bandForSlot(date, start, priceBands || []);
  const basePrice = Number(lessonType.basePrice);
  const bandAdjustment = bandAmountFor(lessonType, band);
  const tier = trainerConfig && trainerConfig.freqTier1MinRides ? (student ? student.frequencyTier || 0 : 0) : 0;
  const frequencyDiscount = frequencyDiscountFor(lessonType, tier);
  const offer = Number(offerDiscount || 0);
  const manual = Number(manualAdjustment || 0);
  const raw = basePrice + bandAdjustment - frequencyDiscount - offer + manual;
  const price = Math.min(Math.max(raw, lessonType.minPrice), lessonType.maxPrice);
  return {
    basePrice, bandAdjustment, frequencyDiscount, offerDiscount: offer, manualAdjustment: manual,
    price, raw, band, tier,
    // The clamp is surfaced, never silent: a coach who believes she gave $20 off and gave $15
    // finds out from a student otherwise, which costs more trust than the $5 was worth.
    flooredBy: raw < lessonType.minPrice ? lessonType.minPrice - raw : 0,
    cappedBy: raw > lessonType.maxPrice ? raw - lessonType.maxPrice : 0,
  };
}

// The five component columns, ready to spread onto a Bookings row. Stamped once at creation and
// never recomputed -- which is what lets a student ask in November why they were charged $60 in
// March and get an answer, after the bands and tiers underneath have long since moved.
function priceFieldsFor(args) {
  const q = priceFor(args);
  return { basePrice: q.basePrice, bandAdjustment: q.bandAdjustment, frequencyDiscount: q.frequencyDiscount, offerDiscount: q.offerDiscount, manualAdjustment: q.manualAdjustment, price: q.price };
}

// Read the STORED components back off a booking for display. Falls back to a bare base price for
// any row that predates the component columns, so a legacy row still renders rather than blanking.
function priceBreakdown(booking, ctx) {
  const lt = ctx.lessonTypes.find((l) => l.id === booking.lessonTypeId);
  const band = bandForSlot(booking.date, booking.start, ctx.priceBands || []);
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

// ---------- rules engine ----------
// ---- group lessons ----
// A group session isn't a stored entity: it *is* the set of bookings sharing lesson type +
// date + start time, where that lesson type is is_group. Nothing to keep in sync, and no way
// for a booking to claim membership in a session it doesn't actually share a slot with.
function isGroupType(lessonTypeId, lessonTypes) {
  const lt = lessonTypes.find((l) => l.id === lessonTypeId);
  return !!(lt && lt.isGroup);
}
function sameGroupSession(b, key) {
  return b.lessonTypeId === key.lessonTypeId && sameDay(b.date, key.date) && b.start === key.start;
}
function groupRoster(bookings, key) {
  return bookings.filter((b) => (b.status === "pending" || b.status === "confirmed") && sameGroupSession(b, key));
}
function groupKeyOf(booking) { return { lessonTypeId: booking.lessonTypeId, date: booking.date, start: booking.start }; }

function isTrainerAvailable(dayIdx, mins, availability) {
  return availability.some((a) => a.day === dayIdx && mins >= parseTime(a.start) && mins <= parseTime(a.end));
}
function isDateInTimeOff(date, timeOffBlocks) {
  return (timeOffBlocks || []).some((b) => date >= b.startDate && date <= b.endDate);
}

function generateOccurrences(rec, count) {
  const dates = [];
  let d = new Date(TODAY);
  while (dates.length < count) {
    if (d.getDay() === rec.day && d >= TODAY) dates.push(new Date(d));
    d = addDays(d, 1);
  }
  return dates;
}

// The pattern carries no price of its own, deliberately: base and band are fixed by the slot and
// stable across every occurrence, but the frequency discount moves with the student's tier. A
// stored pattern price would either freeze that discount on the one lesson the reward is for, or
// drift out of step with the rows it generated. Occurrences carry the components; the pattern
// carries none.
function bookingFromRecurring(rec, date, lessonTypes, horseId, ctx) {
  const lt = lessonTypes.find((l) => l.id === rec.lessonTypeId);
  const student = ctx && ctx.students ? ctx.students.find((s) => s.id === rec.studentId) : null;
  const priceFields = priceFieldsFor({ student, lessonType: lt, date, start: rec.start, priceBands: (ctx && ctx.priceBands) || SEED_PRICE_BANDS, trainerConfig: (ctx && ctx.trainerConfig) || SEED_TRAINER_CONFIG });
  return { id: uid("bkg"), createdAt: new Date(TODAY), recurringId: rec.id, studentId: rec.studentId, horseId: horseId || rec.horseId, lessonTypeId: rec.lessonTypeId, date, start: rec.start, status: "confirmed", ...priceFields, isBillable: true, isNewStudent: false, notes: "" };
}

// Past occurrences of a pattern, most recent first. Seed-only scaffolding: a returning student
// needs a plausible ride history behind them, and hand-writing thirty rows per pattern would
// bury the interesting seed data. historyWeeks can reach back past Jan 1 on purpose, so the
// calendar-year cutoff in completedRidesThisYear is exercised rather than assumed.
function pastOccurrences(rec, weeks) {
  const dates = [];
  let d = addDays(TODAY, -1);
  while (d.getDay() !== rec.day) d = addDays(d, -1);
  for (let i = 0; i < weeks; i++) { dates.push(new Date(d)); d = addDays(d, -7); }
  return dates;
}

// Seeded ad hoc rows are written with a price and (where relevant) a gap-fill discount; the
// remaining components are filled in here so every seeded row renders a complete receipt rather
// than a bare number, without hand-writing five fields per row above.
function withSeededComponents(b) {
  if (b.basePrice !== undefined) return b;
  b = { ...b, createdAt: b.createdAt || addDays(b.date, -14) };
  const lt = SEED_LESSON_TYPES.find((l) => l.id === b.lessonTypeId);
  const band = bandForSlot(b.date, b.start, SEED_PRICE_BANDS);
  const bandAdjustment = bandAmountFor(lt, band);
  const offerDiscount = b.offerDiscount || 0;
  const basePrice = lt.basePrice;
  // Whatever the seeded price doesn't account for lands on manualAdjustment, so the receipt adds
  // up exactly -- the same reconciling role it plays for a real coach override.
  const manualAdjustment = b.price - (basePrice + bandAdjustment - offerDiscount);
  return { ...b, basePrice, bandAdjustment, frequencyDiscount: 0, offerDiscount, manualAdjustment };
}

function buildInitialBookings() {
  let out = SEED_ADHOC_BOOKINGS.map(withSeededComponents);
  SEED_RECURRING.forEach((rec) => {
    // History: every fourth lesson rides a substitute, so the tally shows a real spread rather
    // than one horse at 100% -- which is what actually happens over a year of lessons.
    pastOccurrences(rec, rec.historyWeeks || 0).forEach((date, i) => {
      const subsPool = rec.historySubHorseIds || [];
      const nth = i + 1;
      const horseId = subsPool.length && nth % 4 === 0 ? subsPool[(Math.floor(nth / 4) - 1) % subsPool.length] : rec.horseId;
      out.push({ ...bookingFromRecurring(rec, date, SEED_LESSON_TYPES, horseId), status: "completed" });
    });
    generateOccurrences(rec, 4).forEach((date) => {
      const horse = SEED_HORSES.find((h) => h.id === rec.horseId);
      let horseId = rec.horseId;
      if (!horse.active) {
        const period = SEED_INACTIVE_PERIODS.find((p) => p.horseId === rec.horseId && p.status === "active");
        const assignment = period && SEED_SUB_ASSIGNMENTS.find((s) => s.recurringId === rec.id && s.confirmed);
        if (assignment) horseId = assignment.substituteHorseId;
        // else: leave the inactive horse in place -> flagged needsSubstitute downstream
      }
      out.push(bookingFromRecurring(rec, date, SEED_LESSON_TYPES, horseId));
    });
  });
  return out;
}

// Seed tiers are DERIVED by running the real recompute rule against the seeded history, rather
// than hand-written per student -- so the stored tier is exactly what the monthly job would have
// written on the 1st, and the ratchet is demonstrably in effect rather than asserted.
const SEED_INITIAL_BOOKINGS_RAW = buildInitialBookings();
const SEED_STUDENTS_PRICED = SEED_STUDENTS.map((s) => ({
  ...s,
  frequencyTier: earnedTier(s.id, SEED_INITIAL_BOOKINGS_RAW, SEED_TRAINER_CONFIG),
  frequencyTierMonth: MONTH_KEY(TODAY),
}));

// Pass two: history keeps the prices it was charged at (frequency pricing didn't exist then, and
// a past lesson's price is a fact, not a recalculation), while future occurrences are re-priced
// against the tier the student has now actually earned.
const SEED_INITIAL_BOOKINGS = SEED_INITIAL_BOOKINGS_RAW.map((b) => {
  const booked = addDays(b.date, -14);
  b = { ...b, createdAt: booked < addDays(TODAY, -3) ? booked : addDays(TODAY, -3) };
  if (b.date < TODAY || !b.recurringId) return b;
  const student = SEED_STUDENTS_PRICED.find((s) => s.id === b.studentId);
  const lt = SEED_LESSON_TYPES.find((l) => l.id === b.lessonTypeId);
  if (!student || !lt) return b;
  return { ...b, ...priceFieldsFor({ student, lessonType: lt, date: b.date, start: b.start, priceBands: SEED_PRICE_BANDS, trainerConfig: SEED_TRAINER_CONFIG }) };
});

// An occurrence that kept its old day/time when its pattern moved (because it had been
// individually changed, so the rewrite skipped it) no longer belongs to that pattern in any
// meaningful sense. It still carries the recurring_id, but day/time no longer match -- which
// is exactly what the derivation needs to read it as the ad hoc lesson it has become.
function isOrphanedOccurrence(booking, recurringBookings) {
  if (!booking.recurringId) return false;
  const rec = recurringBookings.find((r) => r.id === booking.recurringId);
  if (!rec) return false;
  return booking.date.getDay() !== rec.day || booking.start !== rec.start;
}

function occurrenceType(booking, recurringBookings, lessonTypes) {
  if (lessonTypes && isIntroBooking(booking, lessonTypes)) return "first-lesson";
  if (!booking.recurringId) return "adhoc";
  if (recurringBookings && isOrphanedOccurrence(booking, recurringBookings)) return "adhoc";
  return "recurring";
}

// A booking auto-completes once its date has passed, unless the coach explicitly cancelled or
// no-showed it. Never stored as "completed" -- always derived. Simplification: the simulated
// clock only tracks a date, so a lesson completes once its whole day has passed.
function effectiveStatus(booking) {
  if ((booking.status === "confirmed" || booking.status === "pending") && booking.date < TODAY) return "completed";
  return booking.status;
}

// Ride counts are derived from Bookings, never stored -- a stored tally would drift the first
// time a lesson is retroactively marked no-show or cancelled. Only lessons that actually
// happened count: no_show, late_cancel, and early_cancel all mean nobody rode. Calendar year
// to date, so the count resets on Jan 1 rather than rolling. One definition of "counts as a
// ride", used by both pivots, so the two views can never disagree.
function completedRidesThisYear(bookings, matches) {
  return bookings.filter((b) => matches(b) && effectiveStatus(b) === "completed" && b.date.getFullYear() === TODAY.getFullYear() && b.date <= TODAY);
}
function tallyRides(rides, keyOf) {
  const counts = {};
  rides.forEach((b) => { const k = keyOf(b); counts[k] = (counts[k] || 0) + 1; });
  // Anything with zero completed rides never enters the object, so the list is self-filtering.
  return Object.entries(counts).map(([key, n]) => ({ key, rides: n })).sort((a, b) => b.rides - a.rides);
}
// Which horses a student rode. Which students rode a horse. Same data, pivoted.
function ridesByHorse(studentId, bookings) {
  return tallyRides(completedRidesThisYear(bookings, (b) => b.studentId === studentId), (b) => b.horseId);
}
function ridesByStudent(horseId, bookings) {
  return tallyRides(completedRidesThisYear(bookings, (b) => b.horseId === horseId), (b) => b.studentId);
}

// Lead time to a lesson's start, in minutes. Negative once it has begun.
function minutesUntil(booking) {
  const days = Math.round((booking.date - TODAY) / 86400000);
  return days * 1440 + parseTime(booking.start) - NOW_MIN;
}

// Which cancellation a student is entitled to, decided by lead time rather than by choice --
// the student never picks between early and late. A lesson later today is still cancellable,
// just not for free. Returns null only once the lesson has actually started, at which point
// it's the coach's call whether it was a no-show or a late cancel.
function cancelDisposition(booking, trainerConfig) {
  const status = effectiveStatus(booking);
  if (status !== "confirmed" && status !== "pending") return null;
  const lead = minutesUntil(booking);
  if (lead <= 0) return null;
  const notice = trainerConfig.lateCancelHours;
  return lead > notice * 60
    ? { kind: "early_cancel", billable: false, label: "Cancel lesson", note: "More than " + notice + " hours away — no charge." }
    : { kind: "late_cancel", billable: true, label: "Cancel — still charged", note: `Less than ${notice} hours away, so this lesson is still billed.` };
}

// Every student-originated note lands in one list the coach works through. The label lives
// here rather than inline at the alert, so a new category can't silently inherit another's
// wording -- which is exactly what a two-branch ternary would have done.
const NOTE_CATEGORIES = {
  intro_lesson_no_fit: "no intro time worked",
  recurring_lesson_no_fit: "no recurring time worked",
  message: "sent a message",
};

// Student alerts are the one place in Phase 1a that "derive, don't store" doesn't apply.
// An alert is a record of *who did what, when* -- and the actor is exactly what current state
// can't recover. A cancelled booking looks identical whether the coach or the student cancelled
// it, and a student shouldn't be told about their own action. Append-only, never edited except
// to mark seen.
const STUDENT_ALERT_KINDS = {
  lesson_cancelled: { title: "Lesson cancelled", tone: "red" },
  no_show: { title: "Marked as a no-show", tone: "red" },
  recurring_ended: { title: "Weekly lesson ended", tone: "red" },
  lesson_moved: { title: "Lesson moved", tone: "amber" },
  substitute_horse: { title: "Different horse assigned", tone: "amber" },
  recurring_changed: { title: "Weekly lesson changed", tone: "amber" },
  no_ride_changed: { title: "No-ride list updated", tone: "amber" },
  booking_created: { title: "New lesson booked for you", tone: "green" },
  recurring_created: { title: "New weekly lesson set up", tone: "green" },
  offer: { title: "An opening you might want", tone: "blue" },
  price_changed: { title: "Lesson price adjusted", tone: "gray" },
  rate_changed: { title: "Your lesson rate changed", tone: "gray" },
  disclosures_updated: { title: "Your coach updated the agreements", tone: "amber" },
};

const STUDENT_ALERT_RETENTION_DAYS = 7;

// Nothing deletes an expired alert -- it simply stops being visible. In Sheets this becomes a
// nightly cleanup; here the filter is the whole implementation.
function visibleStudentAlerts(studentId, studentAlerts) {
  const cutoff = addDays(TODAY, -STUDENT_ALERT_RETENTION_DAYS);
  return studentAlerts
    .filter((a) => a.studentId === studentId && a.createdAt >= cutoff)
    .sort((a, b) => b.createdAt - a.createdAt);
}

const SEED_STUDENT_ALERTS = [
  { id: "sal-1", studentId: "maya", kind: "offer", detail: "Tue 8/18 1:00 PM with Duke · matches your potential time", createdAt: addDays(TODAY, -1), seen: false },
  { id: "sal-2", studentId: "maya", kind: "substitute_horse", detail: "Thu 8/13 9:00 AM · Willow instead of Duke", createdAt: addDays(TODAY, -3), seen: true },
  { id: "sal-3", studentId: "maya", kind: "price_changed", detail: "Mon 8/10 9:00 AM · $65 → $55", createdAt: addDays(TODAY, -6), seen: true },
  // Older than the retention window on purpose -- it should never appear on the screen.
  { id: "sal-4", studentId: "maya", kind: "lesson_moved", detail: "Thu 7/30 · moved to 10:00 AM", createdAt: addDays(TODAY, -9), seen: true },
];

function statusInfo(status) {
  const map = {
    pending: { label: "Pending", tone: "gray", muted: false },
    confirmed: { label: null, tone: null, muted: false },
    completed: { label: "Completed", tone: "gray", muted: true },
    no_show: { label: "No-show", tone: "red", muted: true },
    early_cancel: { label: "Early cancel", tone: "gray", muted: true },
    late_cancel: { label: "Late cancel", tone: "amber", muted: true },
  };
  return map[status] || { label: status, tone: "gray", muted: false };
}

// Recurring occurrences stay visible regardless of cancel type. Non-recurring occurrences are
// removed entirely on early_cancel, but stay visible (muted) on late_cancel, since a late
// cancel still has billing consequences worth seeing on the schedule.
function isHiddenFromSchedule(booking) {
  // Deliberately no lessonTypes: this only asks "is it recurring", and an intro lesson answering
  // "adhoc" instead of "first-lesson" reaches the same branch either way.
  return booking.status === "early_cancel" && occurrenceType(booking) !== "recurring";
}

function typeBadge(type) {
  const map = { recurring: ["gray", "Recurring"], adhoc: ["blue", "Ad hoc"], "first-lesson": ["blue", "First lesson"] };
  return map[type] || ["gray", type];
}

function horseAssignment(booking, recurringBookings, horses) {
  const horse = horses.find((h) => h.id === booking.horseId);
  if (!booking.recurringId) return { horse, isSubstitute: false, dominantHorse: null, needsSub: false };
  const rec = recurringBookings.find((r) => r.id === booking.recurringId);
  if (!rec) return { horse, isSubstitute: false, dominantHorse: null, needsSub: false };
  // An orphan has left its pattern behind, so dominant vs. substitute no longer applies to it.
  if (isOrphanedOccurrence(booking, recurringBookings)) return { horse, isSubstitute: false, dominantHorse: null, needsSub: false, isOrphan: true };
  const dominantHorse = horses.find((h) => h.id === rec.horseId);
  if (booking.horseId === rec.horseId) {
    return { horse, isSubstitute: false, dominantHorse: null, needsSub: !!(dominantHorse && !dominantHorse.active) };
  }
  return { horse, isSubstitute: true, dominantHorse, needsSub: false };
}

function needsSubstitute(booking, horses, recurringBookings) {
  return horseAssignment(booking, recurringBookings, horses).needsSub;
}

function getEligibleHorses(student, lessonType, horses) {
  return horses.filter((h) => {
    if (!h.active) return false;
    if (EXP_RANK[student.experienceLevel] < EXP_RANK[h.minExp]) return false;
    if (h.adultOnly && student.age < 18) return false;
    if (!h.styles.some((s) => student.ridingStyles.includes(s))) return false;
    if (student.weight > h.maxWeight) return false;
    if (student.noRideHorses.includes(h.id)) return false;
    if (lessonType.restrictedHorseIds.length > 0 && !lessonType.restrictedHorseIds.includes(h.id)) return false;
    if (lessonType.ridingStyles && lessonType.ridingStyles.length > 0) {
      if (!lessonType.ridingStyles.some((s) => h.styles.includes(s))) return false;
      if (!lessonType.ridingStyles.some((s) => student.ridingStyles.includes(s))) return false;
    }
    return true;
  });
}

function horseMinutesOnDate(horseId, date, bookings, lessonTypes, adultOnly, students) {
  return bookings.filter((b) => b.horseId === horseId && sameDay(b.date, date) && (b.status === "pending" || b.status === "confirmed")).reduce((sum, b) => {
    const lt = lessonTypes.find((l) => l.id === b.lessonTypeId);
    const st = students.find((s) => s.id === b.studentId);
    if (adultOnly && !(st && st.age >= 18)) return sum;
    return sum + (lt ? lt.rideTimeMin : 0);
  }, 0);
}

function ridDaysInWindow(horseId, endDate, bookings) {
  const days = new Set();
  for (let i = 0; i < 7; i++) {
    const d = addDays(endDate, -i);
    if (bookings.some((b) => b.horseId === horseId && sameDay(b.date, d) && (b.status === "pending" || b.status === "confirmed"))) days.add(fmtDate(d));
  }
  return days.size;
}

function validateBooking({ student, horse, lessonType, date, start, bookings, students, lessonTypes, availability, timeOffBlocks, priceBands, trainerConfig, offerDiscount, manualAdjustment }) {
  const checks = [];
  const dayIdx = date.getDay();
  const startMin = parseTime(start);
  checks.push({ label: "Trainer available", pass: isTrainerAvailable(dayIdx, startMin, availability) && !isDateInTimeOff(date, timeOffBlocks) });
  checks.push({ label: "Horse active", pass: horse.active });
  const alreadyRidDays = ridDaysInWindow(horse.id, date, bookings);
  const willBeNewDay = !bookings.some((b) => b.horseId === horse.id && sameDay(b.date, date));
  const projectedDays = alreadyRidDays + (willBeNewDay ? 1 : 0);
  checks.push({ label: "Rest day on track", pass: projectedDays <= (7 - horse.restDaysPerWeek) });
  const overallMin = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, false, students);
  const adultMin = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, true, students);
  const withinOverall = overallMin + lessonType.rideTimeMin <= horse.maxDailyOverall;
  const withinAdult = student.age >= 18 ? adultMin + lessonType.rideTimeMin <= horse.maxDailyAdult : true;
  checks.push({ label: "Within usage cap", pass: withinOverall && withinAdult });
  checks.push({ label: "Pairing eligible", pass: getEligibleHorses(student, lessonType, [horse]).length > 0 });
  const endMin = startMin + lessonType.durationMin;
  const overlaps = (b) => {
    const bLt = lessonTypes.find((l) => l.id === b.lessonTypeId);
    return sameDay(b.date, date) && (b.status === "pending" || b.status === "confirmed") && parseTime(b.start) < endMin && parseTime(b.start) + (bLt ? bLt.durationMin : 0) > startMin;
  };
  // Horse half of check #6 never relaxes: every rider needs their own horse.
  checks.push({ label: "Horse free", pass: !bookings.some((b) => b.horseId === horse.id && overlaps(b)) });
  // Trainer half relaxes only for a genuine group session below capacity.
  const key = { lessonTypeId: lessonType.id, date, start };
  const clashes = bookings.filter((b) => overlaps(b));
  const allSameGroup = clashes.length > 0 && lessonType.isGroup && clashes.every((b) => sameGroupSession(b, key));
  const roomInGroup = allSameGroup && clashes.length < (lessonType.maxGroupSize || 0);
  checks.push({ label: "Trainer free", pass: clashes.length === 0 || roomInGroup });
  // The price is computed, not typed and then validated. This is the one check that adjusts
  // rather than rejects -- a total below the floor becomes the floor and says so by name, where
  // a horse over its usage cap simply fails.
  const quote = priceFor({ student, lessonType, date, start, offerDiscount, manualAdjustment, priceBands: priceBands || [], trainerConfig: trainerConfig || {} });
  const priceLabel = quote.flooredBy ? `Price floored at $${lessonType.minPrice}` : quote.cappedBy ? `Price capped at $${lessonType.maxPrice}` : "Price in range";
  checks.push({ label: priceLabel, pass: Number.isInteger(quote.price) && quote.price >= lessonType.minPrice && quote.price <= lessonType.maxPrice, quote });
  return { ok: checks.every((c) => c.pass), checks, quote };
}

function firstFailure(validation) {
  const f = validation.checks.find((c) => !c.pass);
  return f ? f.label : null;
}

// Validate a candidate horse for an existing booking, ignoring that booking itself so a horse
// never conflicts with the very lesson it's being considered for.
function validateSwap(horse, booking, ctx) {
  const student = ctx.students.find((s) => s.id === booking.studentId);
  const lessonType = ctx.lessonTypes.find((l) => l.id === booking.lessonTypeId);
  return validateBooking({ student, horse, lessonType, date: booking.date, start: booking.start, bookings: ctx.bookings.filter((b) => b.id !== booking.id), students: ctx.students, lessonTypes: ctx.lessonTypes, availability: ctx.trainerAvailability, timeOffBlocks: ctx.timeOffBlocks, priceBands: ctx.priceBands, trainerConfig: ctx.trainerConfig, offerDiscount: booking.offerDiscount, manualAdjustment: booking.manualAdjustment });
}

// Which of the two daily caps is actually binding today. A horse carrying mostly adult riders
// reaches max_daily_minutes_adult long before the overall ceiling, so showing the overall bar
// would read as plenty of room left when there is none.
function bindingCap(horse, date, bookings, lessonTypes, students) {
  const overall = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, false, students);
  const adult = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, true, students);
  const adultShare = horse.maxDailyAdult ? adult / horse.maxDailyAdult : 0;
  const overallShare = horse.maxDailyOverall ? overall / horse.maxDailyOverall : 0;
  return adultShare >= overallShare
    ? { used: adult, max: horse.maxDailyAdult, label: "adult cap", other: `${overall}/${horse.maxDailyOverall} overall` }
    : { used: overall, max: horse.maxDailyOverall, label: "overall cap", other: `${adult}/${horse.maxDailyAdult} adult` };
}

function forecastRestStatus(horse, bookings) {
  const bookedDays = ridDaysInWindow(horse.id, addDays(TODAY, 6), bookings);
  const capacity = 7 - horse.restDaysPerWeek;
  if (bookedDays > capacity) return "red";
  if (bookedDays === capacity) return "yellow";
  return "green";
}

// The rest-day forecast tells you a window is over capacity; this says which day pushes it
// over. Alerts are dated to the day the problem lands, so "booked past a rest day" has to
// point at a specific date rather than at the abstract window.
function restTippingDate(horse, bookings) {
  const capacity = 7 - horse.restDaysPerWeek;
  let booked = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(TODAY, i);
    if (bookings.some((b) => b.horseId === horse.id && sameDay(b.date, d) && (b.status === "pending" || b.status === "confirmed"))) {
      booked++;
      if (booked > capacity) return d;
    }
  }
  return null;
}

function forecastUsageCapStatus(horse, date, bookings, lessonTypes, students) {
  const overall = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, false, students);
  const adult = horseMinutesOnDate(horse.id, date, bookings, lessonTypes, true, students);
  return overall > horse.maxDailyOverall || adult > horse.maxDailyAdult ? "red" : "green";
}

function findMatchesForStudent(student, horses, lessonTypes, bookings, students, availability, timeOffBlocks) {
  const types = potentialLessonTypes(lessonTypes);
  const out = [];
  const windows = student.notificationPref === "target_only" ? student.targetTimes : [...student.targetTimes, ...student.potentialTimes];
  for (let i = 0; i < 7 && out.length < 5; i++) {
    const d = addDays(TODAY, i);
    windows.forEach((w) => {
      if (w.day !== d.getDay() || out.length >= 5) return;
      const isTarget = student.targetTimes.includes(w);
      types.forEach((lt) => {
        if (out.length >= 5) return;
        getEligibleHorses(student, lt, horses).forEach((h) => {
          if (out.length >= 5) return;
          const v = validateBooking({ student, horse: h, lessonType: lt, date: d, start: w.start, bookings, students, lessonTypes, availability, timeOffBlocks });
          if (v.ok) out.push({ date: d, start: w.start, horseId: h.id, lessonTypeId: lt.id, kind: isTarget ? "target" : "potential" });
        });
      });
    });
  }
  return out;
}

// ---------- row-level change tracking (undo) ----------
// Undo reverses the rows an action wrote, restoring their prior values -- never a whole-state
// snapshot. A student can book from their own device between the action and the undo, and a
// state restore would silently erase them.
function rowEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function diffRows(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return rowEq(prev, next) ? [] : [{ id: "__single", before: prev, after: next }];
  const pm = new Map(prev.map((r) => [r.id, r]));
  const nm = new Map(next.map((r) => [r.id, r]));
  const out = [];
  pm.forEach((r, id) => {
    const n = nm.get(id);
    if (!n) out.push({ id, before: r, after: null });
    else if (!rowEq(r, n)) out.push({ id, before: r, after: n });
  });
  nm.forEach((r, id) => { if (!pm.has(id)) out.push({ id, before: null, after: r }); });
  return out;
}

// A lesson type's ROLE is a property of the type, not of its id. The prototype seeded ids like
// "first-time" and "adult-private" and then matched on those strings in eleven places -- which
// works only because the seed data is fixed. A real coach creates her own types with generated
// ids, and every one of those comparisons silently becomes false: no intro lesson is ever found,
// no unlock alert ever fires, the New Booking form defaults to nothing. The flag is the fix.
function introLessonType(lessonTypes) {
  return lessonTypes.find((l) => l.isIntro) || null;
}
function isIntroBooking(booking, lessonTypes) {
  const lt = lessonTypes.find((l) => l.id === booking.lessonTypeId);
  return !!(lt && lt.isIntro);
}

// Reference lookups that tolerate a missing row. Nothing can be deleted today except a lesson
// type, but production will need to remove a sold horse or a departed rider, and every unguarded
// `.find(...).name` becomes a white screen the day it does. A dash is a worse label than a name
// and a far better one than a crash.
function horseName(horses, id, fallback = "Horse to be assigned") {
  const h = horses.find((x) => x.id === id);
  return h ? h.name : fallback;
}
function lessonTypeName(lessonTypes, id, fallback = "Lesson (type removed)") {
  const lt = lessonTypes.find((x) => x.id === id);
  return lt ? lt.name : fallback;
}
function studentName(students, id, fallback = "Former rider") {
  const st = students.find((x) => x.id === id);
  return st ? st.name : fallback;
}

// ---------- shared row builders ----------
function makeRow(b, ctx) {
  return {
    booking: b,
    student: ctx.students.find((s) => s.id === b.studentId),
    lessonType: ctx.lessonTypes.find((l) => l.id === b.lessonTypeId),
    occType: occurrenceType(b, ctx.recurringBookings, ctx.lessonTypes),
    assignment: horseAssignment(b, ctx.recurringBookings, ctx.horses),
    timeOffConflict: (b.status === "confirmed" || b.status === "pending") && isDateInTimeOff(b.date, ctx.timeOffBlocks),
  };
}
function rowsWhere(ctx, filterFn) {
  return ctx.bookings.filter((b) => !isHiddenFromSchedule(b) && filterFn(b)).sort((a, b) => (a.date - b.date) || (parseTime(a.start) - parseTime(b.start))).map((b) => makeRow(b, ctx));
}
function rowsForDate(ctx, date) { return rowsWhere(ctx, (b) => sameDay(b.date, date)); }

// ---------- UI atoms ----------
function Badge({ children, tone = "gray" }) {
  const tones = { gray: "bg-gray-100 text-gray-700", red: "bg-red-50 text-red-700 border border-red-200", amber: "bg-amber-50 text-amber-700 border border-amber-200", green: "bg-green-50 text-green-700 border border-green-200", blue: "bg-blue-50 text-blue-700 border border-blue-200" };
  return <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${tones[tone]}`}>{children}</span>;
}

function Card({ children, className = "", tone }) {
  const border = tone === "red" ? "border-red-300" : tone === "amber" ? "border-amber-300" : tone === "green" ? "border-green-300" : tone === "blue" ? "border-blue-300" : tone === "dashed" ? "border-gray-300 border-dashed" : "border-gray-200";
  return <div className={`bg-white border ${border} rounded-lg p-3 ${className}`}>{children}</div>;
}

function TapCard({ children, tone, onClick, className = "" }) {
  return <button onClick={onClick} className="w-full text-left"><Card tone={tone} className={className}>{children}</Card></button>;
}

function Btn({ children, onClick, variant = "default", className = "", disabled, title }) {
  const variants = { default: "border border-gray-300 hover:bg-gray-50", primary: "bg-gray-900 text-white hover:bg-gray-800", danger: "border border-red-300 text-red-700 hover:bg-red-50", success: "bg-green-600 text-white hover:bg-green-700", ghost: "text-gray-600 hover:bg-gray-50" };
  return <button title={title} disabled={disabled} onClick={onClick} className={`text-sm px-3 py-2 rounded ${variants[variant]} ${disabled ? "opacity-40 cursor-not-allowed" : ""} ${className}`}>{children}</button>;
}

function BackHeader({ title, onBack, right }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3">
      <div className="flex items-center gap-2 min-w-0">
        {onBack && <button onClick={onBack} className="p-1 hover:bg-gray-100 rounded shrink-0"><ArrowLeft size={18} /></button>}
        <h2 className="text-lg font-medium truncate">{title}</h2>
      </div>
      {right}
    </div>
  );
}

function SectionTitle({ children, action, className = "" }) {
  return (
    <div className={`flex justify-between items-center mb-2 ${className}`}>
      <p className="text-xs font-medium text-gray-500">{children}</p>
      {action}
    </div>
  );
}

function Empty({ children }) { return <p className="text-xs text-gray-400">{children}</p>; }

function Field({ label, hint, children, className = "" }) {
  return (
    <div className={className}>
      <label className="text-xs text-gray-500">{label}{hint && <span className="text-gray-400"> {hint}</span>}</label>
      {children}
    </div>
  );
}

function Segmented({ options, value, onChange, cols = 3 }) {
  const gridCols = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" }[cols] || "grid-cols-3";
  return (
    <div className={`grid ${gridCols} gap-1`}>
      {options.map(([v, l]) => (
        <button key={String(v)} onClick={() => onChange(v)} className={`text-xs py-2 rounded border ${value === v ? "bg-gray-900 text-white border-gray-900" : "border-gray-300"}`}>{l}</button>
      ))}
    </div>
  );
}

function ChipGroup({ options, selected, onToggle }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button key={o.value} onClick={() => onToggle(o.value)} className={`text-xs px-2 py-1 rounded ${selected.includes(o.value) ? "bg-gray-900 text-white" : "border border-gray-300"}`}>{o.label}</button>
      ))}
    </div>
  );
}

function CheckRow({ label, sub, checked, onToggle }) {
  return (
    <button onClick={onToggle} className="w-full flex justify-between items-center px-3 py-2 rounded text-sm bg-gray-50 hover:bg-gray-100">
      <span className="text-left">{label}{sub && <span className="block text-xs text-gray-500">{sub}</span>}</span>
      {checked ? <CheckSquare size={18} className="text-gray-700" /> : <Square size={18} className="text-gray-400" />}
    </button>
  );
}

// A stacked list rather than a Segmented control wherever the option names can't carry their
// own meaning in one or two words. Segmented cells are roughly a third of a narrow screen,
// which forces abbreviations like "Both" -- readable only if you already know the answer.
function RadioList({ options, value, onChange }) {
  return (
    <div className="space-y-1 mt-1">
      {options.map(([v, label, sub]) => (
        <button key={String(v)} onClick={() => onChange(v)} className={`w-full flex justify-between items-start gap-2 px-3 py-2 rounded border text-sm text-left ${value === v ? "bg-blue-50 border-blue-300" : "bg-white border-gray-200 hover:border-gray-400"}`}>
          <span>
            {label}
            {sub && <span className="block text-xs text-gray-500">{sub}</span>}
          </span>
          <span className={`shrink-0 mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center ${value === v ? "border-blue-600" : "border-gray-300"}`}>
            {value === v && <span className="w-2 h-2 rounded-full bg-blue-600" />}
          </span>
        </button>
      ))}
    </div>
  );
}

function TimeSelect({ value, onChange, className = "" }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`text-xs ${className}`}>
      {TIME_OPTIONS.map((t) => <option key={t} value={t}>{timeStr(parseTime(t))}</option>)}
    </select>
  );
}

function RideTally({ rows, nameOf, unit, empty, onSelect }) {
  const total = rows.reduce((n, r) => n + r.rides, 0);
  const most = rows.length ? rows[0].rides : 0;
  if (!rows.length) return <div className="mb-4"><Empty>{empty}</Empty></div>;
  return (
    <Card className="mb-4">
      <div className="flex justify-between text-xs text-gray-500 mb-2">
        <span>Since Jan 1, {TODAY.getFullYear()}</span>
        <span>{total} {total === 1 ? "ride" : "rides"} · {rows.length} {rows.length === 1 ? unit[0] : unit[1]}</span>
      </div>
      <div className="space-y-2">
        {rows.map((r) => {
          const body = (
            <>
              <div className="flex justify-between items-baseline text-sm">
                <span>{nameOf(r.key) || "Unknown"}</span>
                <span className="text-gray-500 text-xs">{r.rides}</span>
              </div>
              <div className="mt-1 h-1.5 bg-gray-100 rounded overflow-hidden">
                <div className="h-full bg-gray-800" style={{ width: `${Math.round((r.rides / Math.max(most, 1)) * 100)}%` }} />
              </div>
            </>
          );
          return onSelect
            ? <button key={r.key} onClick={() => onSelect(r.key)} className="w-full text-left rounded hover:bg-gray-50">{body}</button>
            : <div key={r.key}>{body}</div>;
        })}
      </div>
    </Card>
  );
}

function Meter({ value, max }) {
  const pct = Math.min(100, Math.round((value / Math.max(max, 1)) * 100));
  const color = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-gray-800";
  return <div className="h-1.5 bg-gray-100 rounded overflow-hidden"><div className={`h-full ${color}`} style={{ width: `${pct}%` }} /></div>;
}

function RestBadge({ status }) {
  const map = { red: ["red", "Rest conflict"], yellow: ["amber", "Due for rest"], green: ["green", "Rest OK"] };
  const [tone, label] = map[status];
  return <Badge tone={tone}>{label}</Badge>;
}

function ValidationChecklist({ validation }) {
  return (
    <Card tone={validation.ok ? "green" : "red"}>
      {validation.checks.map((c, i) => <p key={i} className={`text-xs ${c.pass ? "text-green-700" : "text-red-700"}`}>{c.pass ? "✓" : "✗"} {c.label}</p>)}
    </Card>
  );
}

// One component for every price shown anywhere, on both sides. A price is never a bare number
// in this product: three adjustments that vary by slot, by student and by offer are only not
// confusing if the reason travels with the number wherever it appears. `collapsed` renders the
// total with a tap to expand, for dense lists; expanded shows every line.
function PriceReceipt({ breakdown, collapsed = false, note, className = "" }) {
  const [open, setOpen] = useState(!collapsed);
  const b = breakdown;
  const lines = [];
  lines.push(["Base price", b.basePrice, false]);
  if (b.bandAdjustment) lines.push([b.bandName || "Time adjustment", b.bandAdjustment, false]);
  if (b.frequencyDiscount) lines.push(["Frequent rider", -b.frequencyDiscount, true]);
  if (b.offerDiscount) lines.push(["Gap-fill offer", -b.offerDiscount, true]);
  if (b.manualAdjustment) lines.push([b.manualAdjustment < 0 ? "Adjusted by your coach" : "Adjustment", b.manualAdjustment, b.manualAdjustment < 0]);
  const money = (v) => `${v < 0 ? "−" : "+"}$${Math.abs(v)}`;
  return (
    <div className={className}>
      <button onClick={() => setOpen(!open)} className="flex items-baseline gap-2 text-left">
        <span className="text-sm font-medium">${b.price}</span>
        {lines.length > 1 && <span className="text-xs text-gray-400 underline">{open ? "hide" : "why?"}</span>}
      </button>
      {open && lines.length > 1 && (
        <div className="mt-1 border-l-2 border-gray-200 pl-2 space-y-0.5">
          {lines.map(([label, amount, good], i) => (
            <div key={i} className="flex justify-between text-xs">
              <span className="text-gray-500">{label}</span>
              <span className={good ? "text-green-700" : "text-gray-600"}>{i === 0 ? `$${amount}` : money(amount)}</span>
            </div>
          ))}
          <div className="flex justify-between text-xs font-medium pt-0.5 border-t border-gray-200">
            <span>Total</span><span>${b.price}</span>
          </div>
        </div>
      )}
      {note && <p className="text-xs text-gray-400 mt-1">{note}</p>}
    </div>
  );
}

// The live quote on a form, before any booking exists. Same lines as PriceReceipt plus the two
// things only a quote can report: that the floor or the ceiling actually bit. Surfacing the
// clamp matters -- a coach who thinks she gave $20 off and gave $15 hears about it from a
// student otherwise.
function PriceQuote({ quote, lessonType, className = "" }) {
  const breakdown = { ...quote, bandName: quote.band ? quote.band.name : null };
  return (
    <div className={className}>
      <PriceReceipt breakdown={breakdown} />
      {quote.flooredBy > 0 && (
        <p className="text-xs text-amber-700 mt-1">
          That would land at ${quote.raw}, below your ${lessonType.minPrice} floor for this type. Charging ${lessonType.minPrice}.
        </p>
      )}
      {quote.cappedBy > 0 && (
        <p className="text-xs text-amber-700 mt-1">
          That would land at ${quote.raw}, above your ${lessonType.maxPrice} ceiling for this type. Charging ${lessonType.maxPrice}.
        </p>
      )}
    </div>
  );
}

function HorseAssignmentLine({ assignment }) {
  const { horse, isSubstitute, dominantHorse, needsSub } = assignment;
  return (
    <div className="flex items-center gap-1 mt-1 text-xs flex-wrap">
      <span className="text-gray-600">{horse ? horse.name : "—"}</span>
      {isSubstitute && <Badge tone="amber">Sub for {dominantHorse ? dominantHorse.name : "?"}</Badge>}
      {needsSub && <Badge tone="red">Needs substitute</Badge>}
    </div>
  );
}

// The single lesson row used by Day view, Week ahead, Horse detail and Student profile, so a
// lesson looks and reads the same everywhere it appears.
function LessonRow({ row, onClick, showDate = false, showStudent = true }) {
  const { booking, student, occType, assignment, timeOffConflict } = row;
  const [tone, label] = typeBadge(occType);
  const status = statusInfo(effectiveStatus(booking));
  const border = timeOffConflict ? "border-red-400" : status.muted ? "border-gray-200" : assignment.needsSub ? "border-red-300" : assignment.isSubstitute ? "border-amber-300" : occType === "recurring" ? "border-gray-200" : "border-blue-300";
  const bg = timeOffConflict ? "bg-red-50" : "bg-white";
  return (
    <button onClick={onClick} className={`w-full text-left px-3 py-2 rounded border text-sm ${bg} ${border} ${status.muted ? "opacity-60" : ""}`}>
      <div className="flex justify-between items-start gap-2">
        <span className={status.muted ? "line-through" : ""}>
          {showDate && <span className="text-gray-500">{fmtDate(booking.date)} </span>}
          {timeStr(parseTime(booking.start))}{showStudent && student ? ` · ${student.name}` : ""}
        </span>
        <span className="flex gap-1 items-center shrink-0">
          <Badge tone={tone}>{label}</Badge>
          {status.label && <Badge tone={status.tone}>{status.label}</Badge>}
        </span>
      </div>
      <HorseAssignmentLine assignment={assignment} />
      {timeOffConflict && <p className="text-xs text-red-700 font-medium mt-1">Conflicts with your time off</p>}
    </button>
  );
}

// A group session draws as one row -- one time, the session, its riders and their horses.
// Four stacked rows at 10:00 is visually indistinguishable from four double-booked privates,
// which would undercut the whole point of the relaxed conflict check.
function groupDisplayItems(rows, lessonTypes) {
  const out = [], seen = new Map();
  rows.forEach((r) => {
    if (!isGroupType(r.booking.lessonTypeId, lessonTypes)) { out.push({ kind: "single", key: r.booking.id, row: r }); return; }
    const sig = `${fmtDate(r.booking.date)}|${r.booking.start}|${r.booking.lessonTypeId}`;
    if (seen.has(sig)) { seen.get(sig).rows.push(r); return; }
    const item = { kind: "group", key: sig, rows: [r], lessonType: lessonTypes.find((l) => l.id === r.booking.lessonTypeId) };
    seen.set(sig, item);
    out.push(item);
  });
  return out;
}

function GroupRow({ item, onOpenBooking, showDate = false }) {
  const { rows, lessonType } = item;
  const first = rows[0].booking;
  const spots = (lessonType.maxGroupSize || 0) - rows.filter((r) => ["confirmed", "pending"].includes(r.booking.status)).length;
  const conflict = rows.some((r) => r.timeOffConflict);
  return (
    <div className={`rounded border px-3 py-2 text-sm ${conflict ? "bg-red-50 border-red-400" : "bg-white border-gray-200"}`}>
      <div className="flex justify-between items-start gap-2">
        <span>{showDate && <span className="text-gray-500">{fmtDate(first.date)} </span>}{timeStr(parseTime(first.start))} · {lessonType.name}</span>
        <span className="flex gap-1 items-center shrink-0">
          <Badge tone="blue">Group</Badge>
          <Badge tone={spots > 0 ? "green" : "gray"}>{rows.length}/{lessonType.maxGroupSize}</Badge>
        </span>
      </div>
      <div className="mt-1 space-y-1">
        {rows.map((r) => {
          const status = statusInfo(effectiveStatus(r.booking));
          return (
            <button key={r.booking.id} onClick={() => onOpenBooking(r.booking.id)} className={`w-full flex justify-between items-center text-xs bg-gray-50 rounded px-2 py-1 ${status.muted ? "opacity-60" : ""}`}>
              <span className={status.muted ? "line-through" : ""}>{r.student ? r.student.name : ""} · {r.assignment.horse ? r.assignment.horse.name : "—"}</span>
              {status.label && <Badge tone={status.tone}>{status.label}</Badge>}
            </button>
          );
        })}
      </div>
      {spots > 0 && <p className="text-xs text-gray-500 mt-1">{spots} spot{spots === 1 ? "" : "s"} left</p>}
      {conflict && <p className="text-xs text-red-700 font-medium mt-1">Conflicts with your time off</p>}
    </div>
  );
}

function ScheduleList({ rows, lessonTypes, onOpenBooking, showDate = false, showStudent = true, empty }) {
  const items = groupDisplayItems(rows, lessonTypes);
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <>
      {items.map((item) => (item.kind === "group"
        ? <GroupRow key={item.key} item={item} onOpenBooking={onOpenBooking} showDate={showDate} />
        : <LessonRow key={item.key} row={item.row} showDate={showDate} showStudent={showStudent} onClick={() => onOpenBooking(item.row.booking.id)} />))}
    </>
  );
}

function AlertCard({ item }) {
  const text = item.tone === "red" ? "text-red-700" : item.tone === "amber" ? "text-amber-700" : item.tone === "green" ? "text-green-700" : "";
  return (
    <Card tone={item.tone}>
      <div className="flex justify-between items-center gap-2">
        <div className="min-w-0">
          <p className={`text-sm font-medium ${text}`}>{item.title}</p>
          {item.sub && <p className="text-xs text-gray-500">{item.sub}</p>}
        </div>
        <Btn onClick={item.onClick} variant={item.tone === "green" ? "success" : "default"} className="shrink-0">{item.action}</Btn>
      </div>
    </Card>
  );
}

function Sheet({ title, subtitle, onClose, closeLabel = "Close", children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-t-2xl p-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-9 h-1 bg-gray-300 rounded mx-auto mb-3" />
        <h3 className="font-medium mb-1">{title}</h3>
        {subtitle && <p className="text-xs text-gray-500 mb-3">{subtitle}</p>}
        {children}
        <Btn onClick={onClose} className="w-full mt-3">{closeLabel}</Btn>
      </div>
    </div>
  );
}

// Shared profile fields, used by the student's own create/edit form and the coach's review
// screen -- one definition of what a profile is. Emergency contact and, for a minor, guardian
// contact are required rather than optional: a barn can't put someone on a horse without a
// number to call, and a profile that's missing one is worse than a profile that doesn't exist,
// because it looks complete.
function StudentProfileFields({ value, onChange }) {
  const isMinor = value.age !== "" && Number(value.age) < 18;
  const req = <span className="text-red-600">*</span>;
  return (
    <div>
      <Field label="Age" className="mb-3">
        <input type="number" value={value.age} onChange={(e) => onChange({ age: e.target.value })} className="w-full" />
      </Field>
      {isMinor && (
        <div className="bg-blue-50 rounded p-3 mb-3">
          <p className="text-xs text-blue-700 mb-2">Under 18, so a responsible guardian is required. The guardian handles all scheduling, profile info, and payment on the student's behalf, and is who we contact — all messages go to the guardian's number, not the student's.</p>
          <input placeholder="Responsible guardian name *" value={value.guardianName} onChange={(e) => onChange({ guardianName: e.target.value })} className="w-full mb-2" />
          <select value={value.guardianRelationship} onChange={(e) => onChange({ guardianRelationship: e.target.value })} className="w-full mb-2">
            <option value="">Relationship... *</option>
            <option>Parent</option><option>Grandparent</option><option>Legal Guardian</option><option>Other</option>
          </select>
          <input placeholder="Guardian phone *" value={value.guardianPhone} onChange={(e) => onChange({ guardianPhone: e.target.value })} className="w-full" />
        </div>
      )}
      <Field label="Experience level" className="mb-3">
        <div className="mt-1"><Segmented options={EXP_LEVELS.map((l) => [l, l])} value={value.experienceLevel} onChange={(v) => onChange({ experienceLevel: v })} /></div>
      </Field>
      <Field label="Riding styles" className="mb-3">
        <div className="mt-1"><ChipGroup options={RIDING_STYLES.map((s) => ({ value: s, label: s }))} selected={value.ridingStyles} onToggle={(s) => onChange({ ridingStyles: value.ridingStyles.includes(s) ? value.ridingStyles.filter((x) => x !== s) : [...value.ridingStyles, s] })} /></div>
      </Field>
      <Field label="Weight (lbs)" className="mb-3">
        <input type="number" value={value.weight} onChange={(e) => onChange({ weight: e.target.value })} className="w-full" />
      </Field>
      <Field label={<>Emergency contact {req}</>} hint="· someone we can reach if something happens at the barn" className="mb-3">
        <input placeholder="Name" value={value.emergencyContactName} onChange={(e) => onChange({ emergencyContactName: e.target.value })} className="w-full mb-2 mt-1" />
        <input placeholder="Phone" value={value.emergencyContactPhone} onChange={(e) => onChange({ emergencyContactPhone: e.target.value })} className="w-full" />
      </Field>
    </div>
  );
}

// One rule for whether a profile is complete, so the student's form, the coach's review screen
// and anything downstream can't disagree about it.
function draftFromStudent(s) {
  return { name: s.name, phone: s.phone, age: String(s.age), experienceLevel: s.experienceLevel, ridingStyles: s.ridingStyles, weight: String(s.weight), targetTimes: s.targetTimes, potentialTimes: s.potentialTimes, notificationPref: s.notificationPref, guardianName: s.guardianName || "", guardianPhone: s.guardianPhone || "", guardianRelationship: s.guardianRelationship || "", emergencyContactName: s.emergencyContactName || "", emergencyContactPhone: s.emergencyContactPhone || "" };
}

function profileGaps(v) {
  const gaps = [];
  if (v.age === "" || v.age === null) gaps.push("age");
  if (!v.ridingStyles || v.ridingStyles.length === 0) gaps.push("riding style");
  if (v.weight === "" || v.weight === null) gaps.push("weight");
  if (!v.emergencyContactName || !v.emergencyContactPhone) gaps.push("emergency contact");
  if (v.age !== "" && Number(v.age) < 18) {
    if (!v.guardianName) gaps.push("guardian name");
    if (!v.guardianRelationship) gaps.push("guardian relationship");
    if (!v.guardianPhone) gaps.push("guardian phone");
  }
  return gaps;
}

// Real day + start/end picker, used for both target and potential riding times.
function TimeWindowEditor({ label, hint, windows, onChange }) {
  const [day, setDay] = useState(2);
  const [start, setStart] = useState("15:00");
  const [end, setEnd] = useState("17:00");
  return (
    <div className="mb-3">
      <Field label={label} hint={hint} />
      <div className="space-y-1 mt-1 mb-2">
        {windows.length === 0 && <Empty>None added yet.</Empty>}
        {windows.map((t, i) => (
          <div key={i} className="flex justify-between items-center text-sm bg-gray-50 px-2 py-1 rounded">
            <span>{DAY_NAMES[t.day]} {timeStr(parseTime(t.start))}–{timeStr(parseTime(t.end))}</span>
            <button onClick={() => onChange(windows.filter((_, j) => j !== i))}><X size={14} /></button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <select value={day} onChange={(e) => setDay(Number(e.target.value))} className="text-xs">
          {DAY_ORDER.map((d) => <option key={d} value={d}>{DAY_NAMES[d]}</option>)}
        </select>
        <TimeSelect value={start} onChange={setStart} />
        <span className="text-xs text-gray-400">to</span>
        <TimeSelect value={end} onChange={setEnd} />
        <Btn className="ml-auto" disabled={parseTime(end) <= parseTime(start)} onClick={() => onChange([...windows, { day, start, end }])}><Plus size={14} /></Btn>
      </div>
    </div>
  );
}

// ---------- main app ----------
// The screens, fed real rows. Everything below this line is the prototype as it was — the
// change is where `initial` comes from: Postgres, through the repository and the engine
// mapping, rather than from the SEED_ constants above.
//
// The SEED_ constants are deliberately still here. They are the fixture the screens were
// designed against, and they are what `App` falls back to when the API cannot be reached, so
// the UI stays developable with the server down.
function Screens({ initial }) {
  const [horses, _setHorses] = useState(initial.horses);
  const [students, _setStudents] = useState(initial.students);
  const [lessonTypes, _setLessonTypes] = useState(initial.lessonTypes);
  const [recurringBookings, _setRecurringBookings] = useState(initial.recurring ?? SEED_RECURRING);
  // This coach's own lessons — what every screen renders.
  //
  // The bug this fixes was visible on the Day view: it listed the barn-mate's 1:00 PM lessons
  // with a blank student name, because `initial.bookings` is the whole ACCOUNT (horse welfare
  // counts every lesson the animal did) while `students` is correctly just this coach's, so
  // the name lookup found nothing. Two scopes, and the screens want the narrow one.
  const [bookings, _setBookings] = useState(initial.trainerBookings ?? initial.bookings);

  // The barn's lessons, kept separately and NOT rendered. This is what the welfare rules need —
  // a horse ridden by both coaches is at the sum of both — and it is what gets passed to the
  // engine as `bookings` once the screens migrate onto it. Holding it now means that migration
  // does not also have to go and re-fetch it.
  const [barnBookings] = useState(initial.bookings ?? []);
  const [priceBands, _setPriceBands] = useState(initial.priceBands);
  const [inactivePeriods, _setInactivePeriods] = useState(initial.inactivePeriods ?? []);
  const [subAssignments, _setSubAssignments] = useState(initial.subAssignments ?? []);
  const [studentNotes, _setStudentNotes] = useState(initial.notes ?? []);
  const [studentAlerts, _setStudentAlerts] = useState(initial.alerts ?? []);
  const [trainerAvailability, _setTrainerAvailability] = useState(initial.availability);
  const [trainerConfig, _setTrainerConfig] = useState(initial.trainerConfig);
  const [timeOffBlocks, _setTimeOffBlocks] = useState(initial.timeOffBlocks ?? []);
  const [offers, _setOffers] = useState(initial.offers ?? []);
  const [disclosures, _setDisclosures] = useState(SEED_DISCLOSURES);
  const [disclosureAcceptances, _setDisclosureAcceptances] = useState(SEED_DISCLOSURE_ACCEPTANCES);
  const [notices, setNotices] = useState([]);
  const [showOpenSlots, setShowOpenSlots] = useState(true);

  // Undo records the rows each action wrote, grouped per action: several wrapped setters fired
  // from one handler land in one batch (flushed on the microtask after the handler), so a
  // multi-step action still undoes as a single step.
  const rawSetters = {
    horses: _setHorses, students: _setStudents, lessonTypes: _setLessonTypes, recurringBookings: _setRecurringBookings,
    bookings: _setBookings, inactivePeriods: _setInactivePeriods, subAssignments: _setSubAssignments, studentNotes: _setStudentNotes, studentAlerts: _setStudentAlerts,
    trainerAvailability: _setTrainerAvailability, trainerConfig: _setTrainerConfig, timeOffBlocks: _setTimeOffBlocks, offers: _setOffers, priceBands: _setPriceBands,
    disclosures: _setDisclosures, disclosureAcceptances: _setDisclosureAcceptances,
  };
  const [undoEntry, setUndoEntry] = useState(null);
  const batchRef = useRef(null);
  function recordDelta(slice, prev, next) {
    const changes = diffRows(prev, next);
    if (!changes.length) return;
    if (!batchRef.current) {
      batchRef.current = [];
      Promise.resolve().then(() => { const b = batchRef.current; batchRef.current = null; if (b && b.length) setUndoEntry({ deltas: b }); });
    }
    const batch = batchRef.current;
    changes.forEach((ch) => {
      const existing = batch.find((e) => e.slice === slice && e.id === ch.id);
      if (existing) existing.after = ch.after; // keep the original `before`, take the latest `after`
      else batch.push({ slice, ...ch });
    });
  }
  function wrap(slice) {
    return (updater) => rawSetters[slice]((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      recordDelta(slice, prev, next);
      return next;
    });
  }
  const setHorses = wrap("horses");
  const setStudents = wrap("students");
  const setLessonTypes = wrap("lessonTypes");
  const setRecurringBookings = wrap("recurringBookings");
  const setBookings = wrap("bookings");
  const setInactivePeriods = wrap("inactivePeriods");
  const setSubAssignments = wrap("subAssignments");
  const setStudentNotes = wrap("studentNotes");
  const setStudentAlerts = wrap("studentAlerts");
  const setTrainerAvailability = wrap("trainerAvailability");
  const setTrainerConfig = wrap("trainerConfig");
  const setTimeOffBlocks = wrap("timeOffBlocks");
  const setOffers = wrap("offers");
  const setPriceBands = wrap("priceBands");
  const setDisclosures = wrap("disclosures");
  const setDisclosureAcceptances = wrap("disclosureAcceptances");
  function handleUndo() {
    if (!undoEntry) return;
    const bySlice = {};
    undoEntry.deltas.forEach((d) => { (bySlice[d.slice] = bySlice[d.slice] || []).push(d); });
    Object.entries(bySlice).forEach(([slice, changes]) => {
      rawSetters[slice]((cur) => {
        if (!Array.isArray(cur)) { const single = changes.find((c) => c.id === "__single"); return single ? single.before : cur; }
        const out = [...cur];
        changes.forEach((ch) => {
          const idx = out.findIndex((r) => r.id === ch.id);
          if (ch.before === null) { if (idx >= 0) out.splice(idx, 1); }       // row was added -> remove it
          else if (idx >= 0) out[idx] = ch.before;                             // row was edited -> restore it
          else out.push(ch.before);                                            // row was deleted -> put it back
        });
        return out;
      });
    });
    setNotices([]);
    setUndoEntry(null);
  }

  const [role, setRole] = useState("coach");

  // coach navigation -- a real back stack, so every drill-in returns where it came from
  const [coachScreen, setCoachScreen] = useState("day");
  const [history, setHistory] = useState([]);
  const [coachDate, setCoachDate] = useState(new Date(TODAY));
  const [selectedHorseId, setSelectedHorseId] = useState(null);
  const [selectedStudentId, setSelectedStudentId] = useState(null);
  const [selectedBookingId, setSelectedBookingId] = useState(null);
  const [inactivateHorseId, setInactivateHorseId] = useState(null);
  const [horseFormId, setHorseFormId] = useState(null);
  const [studentFormId, setStudentFormId] = useState(null);
  const [sheet, setSheet] = useState(null); // { type, ctx }

  function navTo(screen) { setHistory((h) => [...h, coachScreen]); setCoachScreen(screen); }
  function goBack() {
    if (!history.length) return;
    setCoachScreen(history[history.length - 1]);
    setHistory(history.slice(0, -1));
  }
  function navRoot(screen) { setHistory([]); setCoachScreen(screen); }
  function fromAlert(screen) { setRole("coach"); setHistory(["alerts"]); setCoachScreen(screen); }

  // student navigation
  const [studentSession, setStudentSession] = useState(null);
  const [studentScreen, setStudentScreen] = useState("get-started");
  const [loginName, setLoginName] = useState("");
  const [loginPhone, setLoginPhone] = useState("");
  const [draftProfile, setDraftProfile] = useState(null);
  const [introOptions, setIntroOptions] = useState([]);
  const [recurringOptions, setRecurringOptions] = useState([]);
  const [selectedRecurringIdx, setSelectedRecurringIdx] = useState([]);
  const [selectedRecurringId, setSelectedRecurringId] = useState(null);

  // Two ways into the student app, both landing on real session state rather than a mock:
  // onboarding from scratch, or resuming an account that already has a schedule. The second
  // skips the credential check it would otherwise pass anyway -- nothing downstream can tell
  // the difference, so every screen behaves exactly as it would after a typed login.
  function startReturningSession(studentId) {
    setStudentSession(studentId || DEMO_RETURNING_STUDENT_ID);
    setStudentScreen("home");
    setDraftProfile(null);
    setSelectedRecurringId(null);
    setSelectedRecurringIdx([]);
  }
  function endStudentSession() {
    setStudentSession(null);
    setStudentScreen("get-started");
    setLoginName(""); setLoginPhone(""); setDraftProfile(null);
    setIntroOptions([]); setRecurringOptions([]);
    setSelectedRecurringId(null); setSelectedRecurringIdx([]);
  }

  function updateBooking(id, patch) { setBookings((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b))); }
  function updateStudent(id, patch) { setStudents((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s))); }
  function updateHorse(id, patch) { setHorses((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h))); }

  // Called from coach code paths only. Deliberately not folded into updateBooking: the same
  // booking edit made by a student shouldn't notify them about their own action, and the
  // call site is what carries that distinction.
  function notifyStudent(studentId, kind, detail) {
    if (!studentId) return;
    setStudentAlerts((prev) => [...prev, { id: uid("sal"), studentId, kind, detail, createdAt: new Date(TODAY), seen: false }]);
  }
  function markStudentAlertsSeen(studentId) {
    setStudentAlerts((prev) => prev.map((a) => (a.studentId === studentId && !a.seen ? { ...a, seen: true } : a)));
  }

  // The discount and its reason are captured at the moment the offer is made, and travel with it:
  // onto the Offers row now, and onto the Bookings row if the student takes it. A discount whose
  // reason isn't recorded when it's given gets reconstructed later, badly.
  function logOffer(studentId, date, time, horseId, kind, lessonTypeId, rank, offerDiscount, offerReason) {
    setOffers((prev) => [...prev, { id: uid("ofr"), studentId, date, start: time, horseId, lessonTypeId, lessonId: null, kind, offerDiscount: offerDiscount || 0, offerReason: offerReason || "", offeredAt: new Date(TODAY), response: null, rank: rank || null }]);
    const horse = horses.find((h) => h.id === horseId);
    const student = students.find((s) => s.id === studentId);
    const lt = lessonTypes.find((l) => l.id === lessonTypeId);
    // Both figures, always. A discounted price shown alone reads as the new price and sets the
    // expectation that next week is the same; the pair makes it legible as a one-off.
    let priceNote = "";
    if (lt && student) {
      const full = priceFor({ student, lessonType: lt, date, start: time, priceBands, trainerConfig });
      const offered = priceFor({ student, lessonType: lt, date, start: time, offerDiscount: offerDiscount || 0, priceBands, trainerConfig });
      priceNote = offered.price < full.price ? ` · $${offered.price} instead of the usual $${full.price}${offerReason ? `, ${offerReason}` : ""}` : ` · $${offered.price}`;
    }
    notifyStudent(studentId, "offer", `${DAY_NAMES[date.getDay()]} ${fmtDate(date)} ${timeStr(parseTime(time))}${horse ? ` with ${horse.name}` : ""}${priceNote}`);
  }
  function wasOffered(studentId, date, time) { return offers.some((o) => o.studentId === studentId && sameDay(o.date, date) && o.start === time); }

  // The terms are replaced in place -- there is no version to append to. Nobody is asked to sign
  // again: the changes clause they already agreed to says the current terms apply and that
  // continuing to book accepts them. The notification is still mandatory, because "we'll tell you
  // when they change" is itself one of the terms, and an unannounced change would break it.
  function updateDisclosures(sections, updateNote) {
    setDisclosures((prev) => ({
      ...prev,
      sections: sections.map((d) => ({ ...d })),
      updatedAt: new Date(TODAY),
      updateNote: updateNote || "Terms updated",
    }));
    students.filter((st) => st.profileStatus !== "rejected").forEach((st) => {
      notifyStudent(st.id, "disclosures_updated", `${updateNote || "Terms updated"} · booking your next lesson accepts the updated terms`);
    });
  }

  function acceptDisclosures(studentId, signedName) {
    setDisclosureAcceptances((prev) => [...prev, {
      id: uid("dac"), studentId, acceptedAt: new Date(TODAY), signedName: signedName || null,
    }]);
  }

  // The monthly recompute. In Sheets this runs on the 1st from a scheduled trigger; there's no
  // clock in a browser, so the reachable trigger here is the coach changing the thresholds --
  // which genuinely has to reprice everyone anyway, so this is real behaviour rather than
  // prototype scaffolding. Both directions are announced: a rise is the reward working and
  // should be seen, a drop is the case that would otherwise be discovered at the till.
  function recomputeFrequencyTiers(config) {
    const cfg = config || trainerConfig;
    setStudents((prev) => prev.map((st) => {
      const tier = earnedTier(st.id, bookings, cfg);
      if (tier === (st.frequencyTier || 0)) return st;
      return { ...st, frequencyTier: tier, frequencyTierMonth: MONTH_KEY(TODAY) };
    }));
    students.forEach((st) => {
      const tier = earnedTier(st.id, bookings, cfg);
      const was = st.frequencyTier || 0;
      if (tier === was) return;
      notifyStudent(st.id, "rate_changed", tier > was
        ? `You're now a frequent rider${tier === 2 ? " (top tier)" : ""} — your lessons cost less from here`
        : "Your frequent-rider discount has ended, so lessons are back to the standard rate");
    });
  }

  // Marking a horse inactive opens a real inactive period and drops the coach into coverage
  // planning. Marking it active again closes the period and hands back only the occurrences
  // that still clear the rules engine against the returning horse -- the schedule may have
  // moved while it was out. Whatever moves back is announced, since the coach may have told
  // those students otherwise in person.
  function setHorseActive(horseId, active) {
    if (!active) {
      updateHorse(horseId, { active: false });
      setInactivePeriods((prev) => [...prev, { id: uid("ina"), horseId, startDate: new Date(TODAY), estimatedEndDate: addDays(TODAY, 7), actualEndDate: null, status: "active", reason: "" }]);
      setInactivateHorseId(horseId);
      navTo("substitution");
      return;
    }
    const period = inactivePeriods.find((p) => p.horseId === horseId && p.status === "active");
    updateHorse(horseId, { active: true });
    if (!period) return;
    const returning = { ...horses.find((h) => h.id === horseId), active: true };
    const assigns = subAssignments.filter((a) => a.periodId === period.id);
    const moved = [], stayed = [];
    bookings.forEach((b) => {
      if (b.date < TODAY) return;
      const a = assigns.find((x) => (x.recurringId && x.recurringId === b.recurringId) || x.bookingId === b.id);
      if (!a || b.horseId !== a.substituteHorseId) return;
      const student = students.find((s) => s.id === b.studentId);
      const lessonType = lessonTypes.find((l) => l.id === b.lessonTypeId);
      const v = validateBooking({ student, horse: returning, lessonType, date: b.date, start: b.start, bookings: bookings.filter((x) => x.id !== b.id), students, lessonTypes, availability: trainerAvailability, timeOffBlocks, priceBands, trainerConfig });
      (v.ok ? moved : stayed).push(b);
    });
    const movedIds = moved.map((b) => b.id);
    setInactivePeriods((prev) => prev.map((p) => (p.id === period.id ? { ...p, status: "ended", actualEndDate: new Date(TODAY) } : p)));
    setBookings((prev) => prev.map((b) => (movedIds.includes(b.id) ? { ...b, horseId } : b)));
    // Assignments covering something that couldn't move back stay -- that lesson is still on
    // its substitute, so the record of why has to survive too.
    const keptIds = new Set(stayed.map((b) => assigns.find((x) => (x.recurringId && x.recurringId === b.recurringId) || x.bookingId === b.id)).filter(Boolean).map((a) => a.id));
    setSubAssignments((prev) => prev.filter((a) => a.periodId !== period.id || keptIds.has(a.id)));
    if (moved.length || stayed.length) {
      setNotices((prev) => [...prev, {
        id: uid("note"), kind: "horse-returned", horseId,
        moved: moved.map((b) => ({ studentId: b.studentId, date: b.date, start: b.start })),
        stayedCount: stayed.length,
      }]);
    }
  }

  // A pattern edit only rewrites occurrences that still match the old pattern. Anything
  // individually changed -- substituted horse, adjusted price, cancelled -- was a deliberate
  // act and isn't undone by a later pattern-level one. Skipped occurrences keep their old day
  // and time, which is precisely what makes them read as ad hoc from here on.
  // "Unmodified price" means unmodified *relative to its siblings*, not equal to the lesson
  // type's target: a series can legitimately be created at a tailored price (F2), and every
  // occurrence of it would otherwise read as individually modified. The baseline is the price
  // most of the pattern's occurrences share.
  // The comparison is on the PATTERN-LEVEL price -- base plus band -- not the final price. A
  // frequency tier moving mid-series legitimately reprices every occurrence generated after it,
  // and comparing final prices would read all of them as individually edited and strand them
  // behind the next pattern edit. frequencyDiscount varies legitimately across a series and
  // offerDiscount can't appear in one at all; only a manual adjustment marks a deliberate touch.
  function patternPriceOf(b) { return (b.basePrice || 0) + (b.bandAdjustment || 0); }
  function baselinePriceFor(recId, list) {
    const prices = list.filter((b) => b.recurringId === recId).map(patternPriceOf);
    if (!prices.length) return null;
    const counts = {};
    prices.forEach((p) => { counts[p] = (counts[p] || 0) + 1; });
    return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  }
  function matchesPattern(b, rec, baseline) {
    return b.horseId === rec.horseId && b.start === rec.start && b.date.getDay() === rec.day && b.status === "confirmed" && !b.manualAdjustment && (baseline === null || patternPriceOf(b) === baseline);
  }
  function applyRecurringChange(recId, patch) {
    const existing = recurringBookings.find((r) => r.id === recId);
    if (!existing) return;
    const rec = { ...existing, ...patch };
    const baseline = baselinePriceFor(recId, bookings);
    setRecurringBookings((prev) => prev.map((r) => (r.id === recId ? rec : r)));
    setBookings((prev) => {
      const kept = prev.filter((b) => b.recurringId !== recId || b.date < TODAY || !matchesPattern(b, existing, baseline));
      // Fresh occurrences are re-priced from scratch rather than inheriting the old baseline:
      // the pattern may have moved into or out of a price band, and carrying the previous
      // amount forward would show an after-school premium on a lesson no longer after school.
      const fresh = generateOccurrences(rec, 4).map((date) => bookingFromRecurring(rec, date, lessonTypes, null, { students, priceBands, trainerConfig }));
      return [...kept, ...fresh];
    });
  }

  function endRecurringSeries(recId) {
    setRecurringBookings((prev) => prev.map((r) => (r.id === recId ? { ...r, status: "ended" } : r)));
    setBookings((prev) => prev.filter((b) => b.recurringId !== recId || b.date < TODAY));
  }

  const shared = {
    horses, students, lessonTypes, recurringBookings, bookings, barnBookings, inactivePeriods, subAssignments, studentNotes, studentAlerts, trainerAvailability, trainerConfig, timeOffBlocks, offers, notices, priceBands, disclosures, disclosureAcceptances,
    setHorses, setStudents, setLessonTypes, setRecurringBookings, setBookings, setInactivePeriods, setSubAssignments, setStudentNotes, setStudentAlerts, setTrainerAvailability, setTrainerConfig, setTimeOffBlocks, setOffers, setNotices, setPriceBands, setDisclosures, setDisclosureAcceptances,
    updateBooking, updateStudent, updateHorse, setHorseActive, applyRecurringChange, endRecurringSeries, logOffer, wasOffered, notifyStudent, markStudentAlertsSeen, recomputeFrequencyTiers,
    updateDisclosures, acceptDisclosures,
    sheet, setSheet, showOpenSlots, setShowOpenSlots, role, setRole,
  };

  const coachNav = {
    coachScreen, setCoachScreen, navTo, navRoot, goBack, history,
    coachDate, setCoachDate, selectedHorseId, setSelectedHorseId, selectedStudentId, setSelectedStudentId,
    selectedBookingId, setSelectedBookingId, inactivateHorseId, setInactivateHorseId, horseFormId, setHorseFormId, studentFormId, setStudentFormId,
  };

  const studentNav = {
    studentSession, setStudentSession, studentScreen, setStudentScreen, loginName, setLoginName, loginPhone, setLoginPhone,
    draftProfile, setDraftProfile, introOptions, setIntroOptions, recurringOptions, setRecurringOptions,
    selectedRecurringIdx, setSelectedRecurringIdx, selectedRecurringId, setSelectedRecurringId,
    startReturningSession, endStudentSession,
  };

  const alerts = useMemo(() => {
    const today = [], tomorrow = [], week = [];
    function bucket(date) { if (sameDay(date, TODAY)) return today; if (sameDay(date, addDays(TODAY, 1))) return tomorrow; return week; }
    bookings.forEach((b) => {
      if (isHiddenFromSchedule(b) || !(b.status === "confirmed" || b.status === "pending")) return;
      if (isOrphanedOccurrence(b, recurringBookings)) {
        const st = students.find((s) => s.id === b.studentId);
        const rec = recurringBookings.find((r) => r.id === b.recurringId);
        bucket(b.date).push({ id: "orphan-" + b.id, tone: "amber", title: `${st.name}'s ${fmtDate(b.date)} lesson stayed put when the weekly slot moved`, sub: `Now ${DAY_NAMES[b.date.getDay()]} ${timeStr(parseTime(b.start))} · pattern is ${DAY_NAMES[rec.day]}s ${timeStr(parseTime(rec.start))} · reads as ad hoc`, action: "View", onClick: () => { setSelectedBookingId(b.id); fromAlert("booking-detail"); } });
      }
      if (needsSubstitute(b, horses, recurringBookings)) {
        const st = students.find((s) => s.id === b.studentId);
        bucket(b.date).push({ id: "sub-" + b.id, tone: "red", title: `${st.name} needs a substitute`, sub: `${fmtDate(b.date)} ${timeStr(parseTime(b.start))} · ${horses.find((h) => h.id === b.horseId).name} inactive`, action: "Resolve", onClick: () => { setInactivateHorseId(b.horseId); fromAlert("substitution"); } });
      }
      if (isDateInTimeOff(b.date, timeOffBlocks)) {
        const st = students.find((s) => s.id === b.studentId);
        bucket(b.date).push({ id: "off-" + b.id, tone: "red", title: `${st.name}'s lesson falls in your time off`, sub: `${fmtDate(b.date)} ${timeStr(parseTime(b.start))} · needs rescheduling`, action: "Resolve", onClick: () => { setSelectedBookingId(b.id); fromAlert("booking-detail"); } });
      }
    });
    // Horse welfare, forecast across the whole rolling window rather than only today: a cap
    // breach four days out is worth knowing about while there's still time to move a lesson,
    // which is the entire point of forecasting against booked schedule instead of actuals.
    horses.filter((h) => h.active).forEach((h) => {
      const tipping = forecastRestStatus(h, bookings) === "red" ? restTippingDate(h, bookings) : null;
      if (tipping) {
        bucket(tipping).push({ id: "rest-" + h.id, tone: "red", title: `${h.name} is booked past a rest day`, sub: `${fmtDate(tipping)} is the ${8 - h.restDaysPerWeek}th riding day in a row — the rest rule allows ${7 - h.restDaysPerWeek} in any 7`, action: "View horse", onClick: () => { setSelectedHorseId(h.id); fromAlert("horse-detail"); } });
      }
      for (let i = 0; i < 7; i++) {
        const d = addDays(TODAY, i);
        if (forecastUsageCapStatus(h, d, bookings, lessonTypes, students) !== "red") continue;
        const overall = horseMinutesOnDate(h.id, d, bookings, lessonTypes, false, students);
        const adult = horseMinutesOnDate(h.id, d, bookings, lessonTypes, true, students);
        const over = adult > h.maxDailyAdult ? `${adult} min of adult riding against a ${h.maxDailyAdult} min cap` : `${overall} min booked against a ${h.maxDailyOverall} min cap`;
        bucket(d).push({ id: `cap-${h.id}-${fmtDate(d)}`, tone: "red", title: `${h.name} is over the daily usage cap on ${fmtDate(d)}`, sub: over, action: "Review", onClick: () => { setSelectedHorseId(h.id); fromAlert("horse-detail"); } });
      }
    });
    recurringBookings.filter((r) => r.justCreated && r.status === "active").forEach((r) => {
      const st = students.find((s) => s.id === r.studentId);
      const h = horses.find((hh) => hh.id === r.horseId);
      today.push({ id: "new-rec-" + r.id, tone: "blue", title: `${st.name} scheduled a new recurring lesson`, sub: `${DAY_NAMES[r.day]}s, ${timeStr(parseTime(r.start))} · ${h.name}`, action: "View", onClick: () => { setRecurringBookings((prev) => prev.map((x) => (x.id === r.id ? { ...x, justCreated: false } : x))); setSelectedStudentId(r.studentId); fromAlert("student-profile"); } });
    });
    notices.filter((n) => n.kind === "horse-returned").forEach((n) => {
      const h = horses.find((x) => x.id === n.horseId);
      const names = n.moved.map((m) => `${students.find((s) => s.id === m.studentId).name} ${fmtDate(m.date)}`).join(", ");
      today.push({
        id: "returned-" + n.id, tone: "blue",
        title: `${h.name} is back — ${n.moved.length} lesson${n.moved.length === 1 ? "" : "s"} moved back`,
        sub: `${names || "None could move back"}${n.stayedCount ? ` · ${n.stayedCount} stayed on a substitute` : ""}`,
        action: "Got it", onClick: () => setNotices((prev) => prev.filter((x) => x.id !== n.id)),
      });
    });
    students.filter((s) => s.profileStatus === "pending_review").forEach((s) => {
      today.push({ id: "review-" + s.id, tone: "amber", title: `${s.name} — new profile`, sub: "Awaiting review", action: "Review", onClick: () => { setSelectedStudentId(s.id); fromAlert("review-profile"); } });
    });
    // One rolled-up alert rather than one per rider. After a material change every student is
    // outstanding at once, and twelve identical rows would bury the day's actual scheduling
    // problems -- which is the job this screen exists to do.
    {
      const unsigned = students.filter((s) => disclosureStatus(s, disclosures, disclosureAcceptances).outstanding);
      if (unsigned.length) {
        today.push({
          id: "disclosures-outstanding", tone: "amber",
          title: `${unsigned.length} rider${unsigned.length === 1 ? "" : "s"} ${unsigned.length === 1 ? "hasn't" : "haven't"} signed the current agreements`,
          sub: `${unsigned.map((s) => s.name.split(" ")[0]).join(", ")} · booked lessons unaffected, but they can't book anything new`,
          action: "View", onClick: () => fromAlert("disclosures"),
        });
      }
    }
    bookings.filter((b) => isIntroBooking(b, lessonTypes) && effectiveStatus(b) === "completed").forEach((b) => {
      const st = students.find((s) => s.id === b.studentId);
      if (st && !st.recurringUnlocked) today.push({ id: "unlock-" + b.id, tone: "green", title: `${st.name}'s intro lesson is complete`, sub: "Ready to open recurring & potential lessons?", action: "Unlock", onClick: () => updateStudent(st.id, { recurringUnlocked: true }) });
    });
    studentNotes.filter((n) => n.status === "open").forEach((n) => {
      const st = students.find((s) => s.id === n.studentId);
      today.push({ id: "note-" + n.id, tone: "amber", title: `${st.name} — ${NOTE_CATEGORIES[n.category] || n.category}`, sub: n.note, action: "View", onClick: () => { setSelectedStudentId(st.id); fromAlert("student-profile"); } });
    });
    if (showOpenSlots) {
      // `bookings` is the barn's, `trainerBookings` this coach's — the engine asks two different
      // questions of them and a single list answers one of them wrongly.
      const args = {
        now: NOW, horses, lessonTypes, bookings: barnBookings, trainerBookings: bookings,
        students, availability: trainerAvailability, timeOffBlocks, trainerConfig,
      };
      const openToday = findOpenSlots({ ...args, date: TODAY }).length;
      const openTomorrow = findOpenSlots({ ...args, date: addDays(TODAY, 1) }).length;
      let openWeek = 0; for (let i = 2; i < 7; i++) openWeek += findOpenSlots({ ...args, date: addDays(TODAY, i) }).length;
      if (openToday) today.push({ id: "open-today", tone: "dashed", title: `${openToday} open slots today`, action: "View day", onClick: () => { setCoachDate(new Date(TODAY)); fromAlert("day"); } });
      if (openTomorrow) tomorrow.push({ id: "open-tom", tone: "dashed", title: `${openTomorrow} open slots tomorrow`, action: "View day", onClick: () => { setCoachDate(addDays(TODAY, 1)); fromAlert("day"); } });
      if (openWeek) week.push({ id: "open-week", tone: "dashed", title: `${openWeek} open slots later this week`, action: "View week", onClick: () => fromAlert("week") });
    }
    return { today, tomorrow, week };
  }, [bookings, barnBookings, horses, students, recurringBookings, studentNotes, notices, showOpenSlots, lessonTypes, trainerAvailability, timeOffBlocks, trainerConfig, disclosures, disclosureAcceptances]);

  const attentionCount = [...alerts.today, ...alerts.tomorrow, ...alerts.week].filter((a) => a.tone !== "dashed").length;

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-900">
      <div className="max-w-md mx-auto">
        <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-3 py-2 flex items-center justify-between">
          <div className="flex gap-1 items-center">
            <button onClick={() => setRole("coach")} className={`text-xs px-3 py-1.5 rounded ${role === "coach" ? "bg-gray-900 text-white" : "bg-gray-100"}`}>Coach</button>
            <button onClick={() => setRole("student")} className={`text-xs px-3 py-1.5 rounded ${role === "student" ? "bg-gray-900 text-white" : "bg-gray-100"}`}>Student</button>
            <button onClick={handleUndo} disabled={!undoEntry} className={`text-xs px-3 py-1.5 rounded border ${undoEntry ? "border-gray-400 text-gray-700 hover:bg-gray-50" : "border-gray-200 text-gray-300 cursor-not-allowed"}`}>Undo</button>
          </div>
          <span className="text-xs text-gray-400">Sim. now: {DAY_NAMES[TODAY.getDay()]} {fmtDate(TODAY)}, {timeStr(NOW_MIN)}</span>
        </div>

        <div className="p-3">
          {role === "coach"
            ? <CoachApp {...shared} {...coachNav} alerts={alerts} attentionCount={attentionCount} />
            : <StudentApp {...shared} {...studentNav} />}
        </div>
      </div>
      {sheet && <SheetRouter {...shared} {...coachNav} {...studentNav} />}
    </div>
  );
}

// ---------- COACH ----------
const COACH_TABS = [["day", "Day"], ["week", "Week"], ["horses", "Horses"], ["students", "Students"], ["new-booking", "New booking"], ["alerts", "Alerts"], ["lessons", "Lessons"], ["schedule", "Schedule"], ["disclosures", "Info & disclosures"]];

function CoachApp(props) {
  const { coachScreen, navRoot, attentionCount } = props;
  const screens = {
    day: DayView, week: WeekAhead, horses: HorsesList, "horse-detail": HorseDetail, "horse-form": HorseForm,
    substitution: SubstitutionPlanning, lessons: LessonsScreen, schedule: ScheduleScreen, disclosures: InfoDisclosures, students: StudentsList, "student-profile": StudentProfileCoach,
    "student-form": StudentFormCoach, "booking-detail": BookingDetail, "new-booking": NewBooking, alerts: AlertsScreen, "review-profile": ReviewProfile,
  };
  const Screen = screens[coachScreen] || DayView;
  return (
    <div>
      <nav className="flex flex-wrap gap-1 mb-3">
        {COACH_TABS.map(([k, l]) => (
          <button key={k} onClick={() => navRoot(k)} className={`text-xs px-2 py-1 rounded ${coachScreen === k ? "bg-gray-900 text-white" : "bg-gray-100"}`}>
            {l}{k === "alerts" && attentionCount > 0 ? ` (${attentionCount})` : ""}
          </button>
        ))}
      </nav>
      <Screen key={`${coachScreen}:${props.horseFormId}:${props.studentFormId}:${props.selectedStudentId}:${props.selectedHorseId}`} {...props} />
    </div>
  );
}

function backProps(props) { return { onBack: props.history && props.history.length ? props.goBack : undefined }; }

// ---------- sheets ----------
function SheetRouter(props) {
  const { sheet, setSheet, horses, students, bookings, recurringBookings, lessonTypes, updateBooking, updateStudent, setBookings, setRecurringBookings, applyRecurringChange, endRecurringSeries, logOffer, trainerAvailability, timeOffBlocks, trainerConfig, priceBands, notifyStudent, role } = props;
  const close = () => setSheet(null);

  if (sheet.type === "substitute-horse" || sheet.type === "dominant-horse") {
    const booking = bookings.find((b) => b.id === sheet.ctx.bookingId);
    if (!booking) return null;
    const isDominant = sheet.type === "dominant-horse";
    const rec = recurringBookings.find((r) => r.id === booking.recurringId);
    const currentId = isDominant ? (rec ? rec.horseId : null) : booking.horseId;
    const scored = horses.map((h) => ({ horse: h, validation: validateSwap(h, booking, props) }));
    const ok = scored.filter((s) => s.validation.ok);
    const blocked = scored.filter((s) => !s.validation.ok && s.horse.id !== currentId);
    return (
      <Sheet
        title={isDominant ? "Change dominant horse" : occurrenceType(booking, recurringBookings, lessonTypes) === "recurring" ? "Substitute horse" : "Change horse"}
        subtitle={isDominant ? "Updates the standing pattern going forward. Occurrences already substituted to another horse are left alone." : `${fmtDate(booking.date)} ${timeStr(parseTime(booking.start))} · this occurrence only`}
        onClose={close}
      >
        <div className="space-y-2">
          {ok.length === 0 && <Empty>No horse clears every check for this slot. Move the lesson, or adjust the horse's caps in Horses.</Empty>}
          {ok.map(({ horse: h }) => (
            <button key={h.id} onClick={() => {
              if (isDominant && rec) {
                const oldId = rec.horseId;
                setRecurringBookings((prev) => prev.map((r) => (r.id === rec.id ? { ...r, horseId: h.id } : r)));
                setBookings((prev) => prev.map((bk) => (bk.recurringId === rec.id && bk.date >= TODAY && bk.horseId === oldId ? { ...bk, horseId: h.id } : bk)));
                if (role === "coach") notifyStudent(booking.studentId, "recurring_changed", `${DAY_NAMES[rec.day]}s ${timeStr(parseTime(rec.start))} · now with ${h.name}`);
              } else {
                updateBooking(booking.id, { horseId: h.id });
                if (role === "coach") notifyStudent(booking.studentId, "substitute_horse", `${DAY_NAMES[booking.date.getDay()]} ${fmtDate(booking.date)} ${timeStr(parseTime(booking.start))} · ${h.name} instead`);
              }
              close();
            }} className={`w-full flex justify-between items-center px-3 py-2 rounded text-sm ${h.id === currentId ? "bg-blue-50 border border-blue-300" : "bg-gray-50 hover:bg-gray-100"}`}>
              <span>{h.name}{h.id === currentId && <span className="text-gray-500"> · current</span>}</span>
              {h.id === currentId && <Check size={16} className="text-blue-600" />}
            </button>
          ))}
          {blocked.length > 0 && (
            <div className="pt-2">
              <p className="text-xs font-medium text-gray-500 mb-1">Not available for this slot</p>
              {blocked.map(({ horse: h, validation }) => (
                <div key={h.id} className="flex justify-between px-3 py-2 text-sm text-gray-400">
                  <span>{h.name}</span><span className="text-xs">{firstFailure(validation)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Sheet>
    );
  }

  if (sheet.type === "price") {
    const booking = bookings.find((b) => b.id === sheet.ctx.bookingId);
    if (!booking) return null;
    return <PriceSheet booking={booking} lessonTypes={lessonTypes} priceBands={priceBands} isRecurring={!!booking.recurringId} onSave={(fields, note) => { updateBooking(booking.id, { ...fields, notes: note ? [booking.notes, note].filter(Boolean).join(" · ") : booking.notes }); if (fields.price !== booking.price) notifyStudent(booking.studentId, "price_changed", `${DAY_NAMES[booking.date.getDay()]} ${fmtDate(booking.date)} ${timeStr(parseTime(booking.start))} · $${booking.price} → $${fields.price}`); close(); }} onClose={close} />;
  }

  if (sheet.type === "reschedule") {
    const booking = bookings.find((b) => b.id === sheet.ctx.bookingId);
    if (!booking) return null;
    const student = students.find((s) => s.id === booking.studentId);
    const lt = lessonTypes.find((l) => l.id === booking.lessonTypeId);
    const horse = horses.find((h) => h.id === booking.horseId);
    const options = [];
    for (let i = 0; i < 14 && options.length < 12; i++) {
      const d = addDays(TODAY, i);
      trainerAvailability.filter((a) => a.day === d.getDay()).forEach((win) => {
        for (let t = parseTime(win.start); t + lt.durationMin <= parseTime(win.end) && options.length < 12; t += 30) {
          if (sameDay(d, booking.date) && minToStr(t) === booking.start) continue;
          const v = validateBooking({ student, horse, lessonType: lt, date: d, start: minToStr(t), bookings: bookings.filter((b) => b.id !== booking.id), students, lessonTypes, availability: trainerAvailability, timeOffBlocks, priceBands, trainerConfig });
          // The lesson being moved must not block its own new time, so it comes out of the
          // coach's day here exactly as it comes out of `bookings` on the line above.
          if (v.ok && offerRespectsPreferences({ date: d, startMin: t, durationMin: lt.durationMin, trainerBookings: bookings.filter((b) => b.id !== booking.id), lessonTypes, trainerConfig })) options.push({ date: d, start: minToStr(t) });
        }
      });
    }
    return (
      <Sheet title="Move this lesson" subtitle={`Keeping ${student.name} on ${horse ? horse.name : "?"} · showing times that clear every check`} onClose={close}>
        <div className="space-y-2">
          {options.length === 0 && <Empty>No open times in the next two weeks for this pairing. Try changing the horse first.</Empty>}
          {options.map((o, i) => (
            <button key={i} onClick={() => { updateBooking(booking.id, { date: o.date, start: o.start }); notifyStudent(booking.studentId, "lesson_moved", `${DAY_NAMES[booking.date.getDay()]} ${fmtDate(booking.date)} ${timeStr(parseTime(booking.start))} → ${DAY_NAMES[o.date.getDay()]} ${fmtDate(o.date)} ${timeStr(parseTime(o.start))}`); close(); }} className="w-full flex justify-between items-center px-3 py-2 rounded text-sm bg-gray-50 hover:bg-gray-100">
              <span>{fmtDate(o.date)} {DAY_NAMES[o.date.getDay()]}</span>
              <span className="text-gray-600">{timeStr(parseTime(o.start))}</span>
            </button>
          ))}
        </div>
      </Sheet>
    );
  }

  if (sheet.type === "end-series") {
    const rec = recurringBookings.find((r) => r.id === sheet.ctx.recurringId);
    if (!rec) return null;
    const st = students.find((s) => s.id === rec.studentId);
    const futureCount = bookings.filter((b) => b.recurringId === rec.id && b.date >= TODAY).length;
    return (
      <Sheet title="End this recurring series?" subtitle={`${st.name} · ${DAY_NAMES[rec.day]}s, ${timeStr(parseTime(rec.start))}`} onClose={close} closeLabel="Keep the series">
        <p className="text-xs text-gray-500 mb-3">This removes {futureCount} upcoming occurrence{futureCount === 1 ? "" : "s"} and stops new ones being generated. Past lessons stay on the record.</p>
        <Btn variant="danger" className="w-full" onClick={() => { endRecurringSeries(rec.id); if (role === "coach") notifyStudent(rec.studentId, "recurring_ended", `${DAY_NAMES[rec.day]}s ${timeStr(parseTime(rec.start))} · ${futureCount} upcoming lesson${futureCount === 1 ? "" : "s"} removed`); close(); if (props.setCoachScreen) props.setCoachScreen("day"); }}>End series</Btn>
      </Sheet>
    );
  }

  if (sheet.type === "no-ride") {
    const student = students.find((s) => s.id === sheet.ctx.studentId);
    return (
      <Sheet title={`No-ride horses · ${student.name}`} subtitle="Set by the coach. Blocks this pairing everywhere, on both sides of the app." onClose={close}>
        <div className="space-y-2">
          {horses.map((h) => (
            <CheckRow key={h.id} label={h.name} checked={student.noRideHorses.includes(h.id)} onToggle={() => {
              const added = !student.noRideHorses.includes(h.id);
              const next = added ? [...student.noRideHorses, h.id] : student.noRideHorses.filter((x) => x !== h.id);
              updateStudent(student.id, { noRideHorses: next });
              notifyStudent(student.id, "no_ride_changed", `${h.name} ${added ? "added to" : "removed from"} your no-ride list`);
            }} />
          ))}
        </div>
      </Sheet>
    );
  }

  if (sheet.type === "no-ride-horse") {
    const horse = horses.find((h) => h.id === sheet.ctx.horseId);
    return (
      <Sheet title={`Students excluded from ${horse.name}`} subtitle="Same field as the student-side list -- one source of truth, edited from whichever side is convenient." onClose={close}>
        <div className="space-y-2">
          {students.map((s) => (
            <CheckRow key={s.id} label={s.name} checked={s.noRideHorses.includes(horse.id)} onToggle={() => {
              const added = !s.noRideHorses.includes(horse.id);
              const next = added ? [...s.noRideHorses, horse.id] : s.noRideHorses.filter((x) => x !== horse.id);
              updateStudent(s.id, { noRideHorses: next });
              notifyStudent(s.id, "no_ride_changed", `${horse.name} ${added ? "added to" : "removed from"} your no-ride list`);
            }} />
          ))}
        </div>
      </Sheet>
    );
  }

  if (sheet.type === "notify") {
    const { date, time, slot } = sheet.ctx;
    return <NotifySheet date={date} time={time} priceBands={priceBands} trainerConfig={trainerConfig} candidates={eligibleStudentsForSlot({ ...matchingCtx(props), date, time, slot })} onSend={(picked, discount, reason) => { picked.forEach((c, i) => logOffer(c.student.id, date, time, c.horse.id, c.kind, c.lessonType.id, i + 1, c.kind === "potential" ? discount : 0, c.kind === "potential" ? reason : "")); close(); }} onClose={close} />;
  }

  if (sheet.type === "recurring-slot") {
    const rec = recurringBookings.find((r) => r.id === sheet.ctx.recurringId);
    if (!rec) return null;
    const student = students.find((s) => s.id === rec.studentId);
    // A series being rescheduled must not block itself, so its own lessons come out of BOTH
    // lists — out of the barn's or the horse still reads as busy at the time it is moving away
    // from, and out of the coach's or every slot it currently occupies stays unofferable.
    const ctx = matchingCtx(props);
    const withoutSeries = (list) => (list || []).filter((b) => b.recurringId !== rec.id);
    const options = findRecurringOptions({
      ...ctx, student, limit: 10,
      bookings: withoutSeries(ctx.bookings), trainerBookings: withoutSeries(ctx.trainerBookings),
    });
    const horseOnly = sheet.ctx.mode === "horse";
    const shown = horseOnly ? options.filter((o) => o.day === rec.day && o.start === rec.start) : options;
    return (
      <Sheet title={horseOnly ? "Change horse" : "Change day / time"} subtitle="Every option here holds up for the next four occurrences." onClose={close}>
        <div className="space-y-2">
          {shown.length === 0 && <Empty>{horseOnly ? "No other horse clears every check at this day and time." : "No other weekly slot clears every check right now."}</Empty>}
          {shown.map((o, i) => (
            <button key={i} onClick={() => { applyRecurringChange(rec.id, { day: o.day, start: o.start, horseId: o.horseId }); if (role === "coach") notifyStudent(rec.studentId, "recurring_changed", `Now ${DAY_NAMES[o.day]}s ${timeStr(parseTime(o.start))} with ${horses.find((h) => h.id === o.horseId).name}`); close(); }} className="w-full flex justify-between items-center px-3 py-2 rounded text-sm bg-gray-50 hover:bg-gray-100">
              <span>{DAY_NAMES[o.day]}s, {timeStr(parseTime(o.start))}</span>
              <span className="text-gray-600">{horses.find((h) => h.id === o.horseId).name}</span>
            </button>
          ))}
        </div>
      </Sheet>
    );
  }

  return null;
}

// The list is already ranked: target matches above potential ones, and within each, the
// students most likely to accept. The top five are pre-selected because that's the batch the
// coach would almost always send; everything below is one tap away, and any pre-selection can
// be removed. Students already offered this exact slot are listed but never auto-selected.
function NotifySheet({ date, time, candidates, priceBands, trainerConfig, onSend, onClose }) {
  const autoPick = candidates.filter((c) => !c.alreadyOffered).slice(0, 5).map((c) => c.student.id);
  const [picked, setPicked] = useState(autoPick);
  const groups = [["target", "Matches their target times"], ["potential", "Matches their potential times · discount candidates"]];
  const chosen = candidates.filter((c) => picked.includes(c.student.id));

  // The potential group is the gap-fill case, so the discount control lives above it and nowhere
  // else. A target offer going out at full price is exactly what makes it the group tried first.
  const potentials = candidates.filter((c) => c.kind === "potential");
  const potentialType = potentials.length ? potentials[0].lessonType : null;
  const preset = potentialType ? Number(potentialType.gapFillDiscount || 0) : 0;
  const [discount, setDiscount] = useState(preset);
  const [reason, setReason] = useState("filling a gap");
  const chosenPotentials = chosen.filter((c) => c.kind === "potential");
  const needsReason = chosenPotentials.length > 0 && discount > 0 && !reason.trim();

  // One amount for the whole batch: it's one slot, and offering the same window to five students
  // at five different prices is indefensible the moment two of them compare notes.
  const sampleQuote = potentialType && chosenPotentials.length
    ? priceFor({ student: chosenPotentials[0].student, lessonType: potentialType, date, start: time, offerDiscount: discount, priceBands, trainerConfig })
    : null;
  const sampleFull = potentialType && chosenPotentials.length
    ? priceFor({ student: chosenPotentials[0].student, lessonType: potentialType, date, start: time, priceBands, trainerConfig })
    : null;
  return (
    <Sheet title={`Offer ${fmtDate(date)} ${DAY_NAMES[date.getDay()]}, ${timeStr(parseTime(time))}`} subtitle="Nothing is booked or held by offering — first to book takes it." onClose={onClose} closeLabel="Cancel">
      {candidates.length === 0 && <Empty>No matching student availability for this slot.</Empty>}
      {groups.map(([kind, label]) => {
        const rows = candidates.filter((c) => c.kind === kind);
        if (!rows.length) return null;
        return (
          <div key={kind} className="mb-3">
            <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
            {kind === "potential" && (
              <div className="bg-gray-50 border border-gray-200 rounded p-2 mb-2">
                <p className="text-xs font-medium mb-1">Discount for this offer</p>
                <div className="flex gap-1 mb-2">
                  {[preset, 5, 0].filter((v, i, a) => a.indexOf(v) === i).map((v) => (
                    <Btn key={v} onClick={() => setDiscount(v)} className={discount === v ? "border-gray-900" : ""}>{v === 0 ? "None" : `−$${v}`}</Btn>
                  ))}
                  <input type="number" value={discount} onChange={(e) => setDiscount(Math.max(0, Number(e.target.value)))} className="w-16 text-xs" />
                </div>
                {discount > 0 && (
                  <Field label="Why" hint="· goes in the message and on the booking" className="mb-1">
                    <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. filling a gap" className="w-full" />
                  </Field>
                )}
                {sampleQuote && sampleFull && (
                  <p className="text-xs text-gray-600 mt-1">
                    {sampleQuote.price < sampleFull.price
                      ? <>They'll see <span className="font-medium">${sampleQuote.price}</span> instead of the usual ${sampleFull.price}.</>
                      : <>They'll see <span className="font-medium">${sampleQuote.price}</span> — full price.</>}
                  </p>
                )}
                {sampleQuote && sampleQuote.flooredBy > 0 && (
                  <p className="text-xs text-amber-700 mt-1">That would land at ${sampleQuote.raw}, below your ${potentialType.minPrice} floor. Charging ${potentialType.minPrice}.</p>
                )}
                <p className="text-xs text-gray-400 mt-1">One amount for everyone here — it's one slot, and five prices for it is one comparison away from a problem. Nobody who books this slot on their own gets the discount.</p>
              </div>
            )}
            <div className="space-y-1">
              {rows.map((c) => {
                const on = picked.includes(c.student.id);
                const rate = c.stats.offered ? `${c.stats.accepted}/${c.stats.offered} offers taken` : "No offer history yet";
                return (
                  <button key={c.student.id} onClick={() => setPicked(on ? picked.filter((id) => id !== c.student.id) : [...picked, c.student.id])} className={`w-full flex justify-between items-center px-3 py-2 rounded border text-sm ${on ? "bg-blue-50 border-blue-300" : "bg-white border-gray-200"}`}>
                    <span className="text-left">
                      {c.student.name}
                      {c.alreadyOffered && <Badge tone="gray"> Already offered</Badge>}
                      <span className="block text-xs text-gray-500">{c.lessonType.name} · {c.horse.name} · {rate}</span>
                    </span>
                    {on ? <CheckSquare size={18} className="text-blue-600" /> : <Square size={18} className="text-gray-400" />}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {candidates.length > 0 && (
        <>
          {needsReason && <p className="text-xs text-red-700 mb-2">A discount needs a reason — it's what makes it read as a one-off rather than a price cut.</p>}
          <Btn variant="primary" className="w-full" disabled={chosen.length === 0 || needsReason} onClick={() => onSend(chosen, discount, reason)}>
            Notify {chosen.length} student{chosen.length === 1 ? "" : "s"}
          </Btn>
        </>
      )}
    </Sheet>
  );
}

// Opens on the RECEIPT before offering any control. The coach's first question when a student
// queries a price is what produced it, and reconstructing that from memory at the barn is how a
// wrong answer gets given. The control below writes manualAdjustment rather than overwriting
// price, so the receipt keeps adding up and an override is visibly an override.
function PriceSheet({ booking, lessonTypes, priceBands, isRecurring, onSave, onClose }) {
  const lt = lessonTypes.find((l) => l.id === booking.lessonTypeId);
  const base = (booking.basePrice || 0) + (booking.bandAdjustment || 0) - (booking.frequencyDiscount || 0) - (booking.offerDiscount || 0);
  const [price, setPrice] = useState(booking.price);
  const [note, setNote] = useState("");
  const inRange = price >= lt.minPrice && price <= lt.maxPrice && Number.isInteger(Number(price));
  const computed = Math.min(Math.max(base, lt.minPrice), lt.maxPrice);
  const quick = [computed, Math.max(lt.minPrice, computed - 5), lt.minPrice].filter((v, i, a) => a.indexOf(v) === i);
  const breakdown = { ...priceBreakdown(booking, { lessonTypes, priceBands }), manualAdjustment: price - base, price: Number(price) };
  return (
    <Sheet title="Adjust price" subtitle={`${lt.name} · floor $${lt.minPrice}, ceiling $${lt.maxPrice}`} onClose={onClose}>
      <p className="text-xs font-medium text-gray-500 mb-1">What produced this price</p>
      <PriceReceipt breakdown={breakdown} className="mb-3" />
      <div className="flex gap-1 mb-3">
        {quick.map((v) => <Btn key={v} onClick={() => setPrice(v)} className={price === v ? "border-gray-900" : ""}>${v}</Btn>)}
      </div>
      <Field label="Price" className="mb-3"><input type="number" value={price} onChange={(e) => setPrice(Number(e.target.value))} className="w-full" /></Field>
      <Field label="Why" hint="(saved to the lesson's notes)" className="mb-2"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. moved to fill a gap" className="w-full" /></Field>
      {isRecurring && <p className="text-xs text-gray-400 mb-2">This changes one occurrence, not the weekly pattern — every other week stays as it is.</p>}
      {!inRange && <p className="text-xs text-red-700 mb-2">Outside this lesson type's floor and ceiling, or not a whole number.</p>}
      <Btn variant="primary" className="w-full" disabled={!inRange} onClick={() => onSave({ price: Number(price), manualAdjustment: Number(price) - base }, note)}>Save price</Btn>
    </Sheet>
  );
}

// ---------- coach screens ----------
function DayView(props) {
  const { coachDate, setCoachDate, horses, showOpenSlots, setSelectedBookingId, navTo, setInactivateHorseId, timeOffBlocks, trainerAvailability, trainerConfig, lessonTypes, bookings, barnBookings, students, offers, setSheet } = props;
  const [showAllSlots, setShowAllSlots] = useState(false);
  const [onlyMatched, setOnlyMatched] = useState(false);
  const rows = rowsForDate(props, coachDate);
  const inactiveHorses = horses.filter((h) => !h.active);
  const offBlock = timeOffBlocks.find((b) => coachDate >= b.startDate && coachDate <= b.endDate);
  const openSlots = showOpenSlots ? findOpenSlots({ date: coachDate, now: NOW, horses, lessonTypes, bookings: barnBookings, trainerBookings: bookings, students, availability: trainerAvailability, timeOffBlocks, trainerConfig }) : [];
  // Most open windows have nobody who asked for that time. Filtering to the ones that do is
  // the difference between scrolling a day's worth of empty slots and seeing the two worth acting on.
  const matchedSlots = onlyMatched ? openSlots.filter((slot) => eligibleStudentsForSlot({ ...matchingCtx(props), date: coachDate, time: slot.time, slot }).length > 0) : openSlots;
  const visibleSlots = showAllSlots ? matchedSlots : matchedSlots.slice(0, 4);
  const offersFor = (time) => offers.filter((o) => sameDay(o.date, coachDate) && o.start === time);
  const slotsWithOffers = openSlots.filter((slot) => offersFor(slot.time).length > 0).length;
  const rel = relDay(coachDate);
  return (
    <div>
      <BackHeader
        title={`${fmtDate(coachDate)} ${DAY_NAMES[coachDate.getDay()]}${rel ? ` · ${rel}` : ""}`}
        {...backProps(props)}
        right={
          <div className="flex gap-1 shrink-0">
            {!rel && <Btn onClick={() => setCoachDate(new Date(TODAY))}>Today</Btn>}
            <Btn onClick={() => setCoachDate(addDays(coachDate, -1))}>{"<"}</Btn>
            <Btn onClick={() => setCoachDate(addDays(coachDate, 1))}>{">"}</Btn>
          </div>
        }
      />
      {offBlock && (
        <Card tone="red" className="mb-3">
          <p className="text-sm font-medium text-red-700">You're off this day{offBlock.reason ? ` · ${offBlock.reason}` : ""}</p>
          <p className="text-xs text-gray-500">Anything still booked below needs rescheduling or cancelling.</p>
        </Card>
      )}
      {inactiveHorses.map((h) => (
        <Card key={h.id} tone="amber" className="mb-3 flex gap-2 items-start">
          <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-700">{h.name} is marked inactive</p>
            <button className="text-xs text-amber-700 underline" onClick={() => { setInactivateHorseId(h.id); navTo("substitution"); }}>Plan coverage for the affected lessons</button>
          </div>
        </Card>
      ))}
      <div className="space-y-2 mb-4">
        <ScheduleList rows={rows} lessonTypes={lessonTypes} empty="No lessons scheduled. Open slots below, or add one from New booking." onOpenBooking={(id) => { setSelectedBookingId(id); navTo("booking-detail"); }} />
      </div>
      {showOpenSlots && openSlots.length > 0 && (
        <div>
          <SectionTitle action={matchedSlots.length > 4 ? <button className="text-xs text-gray-600 underline" onClick={() => setShowAllSlots(!showAllSlots)}>{showAllSlots ? "Show fewer" : `Show all ${matchedSlots.length}`}</button> : null}>
            Potential lessons · {openSlots.length} open{slotsWithOffers ? ` · ${slotsWithOffers} awaiting a reply` : ""}
          </SectionTitle>
          <label className="text-xs text-gray-500 flex items-center gap-1 mb-2">
            <input type="checkbox" checked={onlyMatched} onChange={(e) => { setOnlyMatched(e.target.checked); setShowAllSlots(false); }} />
            Only slots a student could take
          </label>
          {onlyMatched && matchedSlots.length === 0 && <Empty>No open slot today matches anyone's riding times.</Empty>}
          <div className="space-y-2">
            {visibleSlots.map((s, i) => {
              const matches = eligibleStudentsForSlot({ ...matchingCtx(props), date: coachDate, time: s.time, slot: s });
              const sent = offersFor(s.time);
              const notYetAsked = matches.filter((m) => !m.alreadyOffered);
              // Once offers are out, the slot stops reading as an untouched gap. It's still
              // open -- an offer holds nothing -- but the coach's next question changes from
              // "who could take this?" to "has anyone come back to me?"
              const names = sent.map((o) => students.find((st) => st.id === o.studentId)).filter(Boolean).map((st) => st.name);
              return (
                <Card key={i} tone={sent.length ? "blue" : "dashed"}>
                  <div className="flex justify-between items-start">
                    <p className="text-sm font-medium">{timeStr(parseTime(s.time))}</p>
                    {sent.length > 0
                      ? <Badge tone="blue">Offered to {sent.length}</Badge>
                      : matches.length > 0 && <Badge tone="gray">{matches.length} could take it</Badge>}
                  </div>
                  <p className="text-xs text-gray-500 mb-2">{s.options.map((o) => lessonTypes.find((l) => l.id === o.lessonTypeId).name).join(" or ")}</p>
                  {sent.length > 0 ? (
                    <>
                      <p className="text-xs text-blue-700 mb-1">Sent to {names.slice(0, 3).join(", ")}{names.length > 3 ? ` +${names.length - 3} more` : ""}</p>
                      <p className="text-xs text-gray-500 mb-2">Still open — an offer doesn't hold the slot, so it stays here until someone books it.</p>
                      {notYetAsked.length > 0
                        ? <Btn className="w-full" onClick={() => setSheet({ type: "notify", ctx: { date: coachDate, time: s.time, slot: s } })}>Notify {notYetAsked.length} more</Btn>
                        : <p className="text-xs text-gray-400">Everyone whose riding times match has been offered this slot</p>}
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-gray-500 mb-2">{s.horseIds.map((id) => horses.find((h) => h.id === id).name).join(", ")} available</p>
                      {matches.length === 0
                        ? <p className="text-xs text-gray-400">No matching student availability</p>
                        : <Btn className="w-full" onClick={() => setSheet({ type: "notify", ctx: { date: coachDate, time: s.time, slot: s } })}>Notify eligible students</Btn>}
                    </>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function WeekAhead(props) {
  const { horses, lessonTypes, bookings, barnBookings, students, setCoachDate, navTo, setSelectedBookingId, trainerAvailability, timeOffBlocks, trainerConfig, showOpenSlots } = props;
  const days = Array.from({ length: 7 }, (_, i) => addDays(TODAY, i));
  return (
    <div>
      <BackHeader title="Week ahead" {...backProps(props)} />
      <div className="space-y-4">
        {days.map((d) => {
          const rows = rowsForDate(props, d);
          const open = showOpenSlots ? findOpenSlots({ date: d, now: NOW, horses, lessonTypes, bookings: barnBookings, trainerBookings: bookings, students, availability: trainerAvailability, timeOffBlocks, trainerConfig }).length : 0;
          const off = isDateInTimeOff(d, timeOffBlocks);
          return (
            <div key={fmtDate(d)}>
              <button onClick={() => { setCoachDate(d); navTo("day"); }} className="w-full flex justify-between items-center border-b border-gray-200 pb-1 mb-2">
                <span className="text-sm font-medium">
                  {fmtDate(d)} {DAY_NAMES[d.getDay()]}
                  {relDay(d) && <span className="text-blue-600"> · {relDay(d)}</span>}
                  {off && <span className="text-red-600"> · Time off</span>}
                </span>
                <span className="text-xs text-gray-500 flex items-center gap-1">{rows.length} lessons{showOpenSlots ? ` · ${open} open` : ""} <ChevronRight size={14} /></span>
              </button>
              <div className="space-y-1">
                <ScheduleList rows={rows} lessonTypes={lessonTypes} empty="Nothing booked." onOpenBooking={(id) => { setSelectedBookingId(id); navTo("booking-detail"); }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HorsesList(props) {
  const { horses, bookings, students, lessonTypes, setSelectedHorseId, navTo, setHorseFormId } = props;
  return (
    <div>
      <BackHeader title="Horses" {...backProps(props)} right={<Btn onClick={() => { setHorseFormId("new"); navTo("horse-form"); }}>Add horse</Btn>} />
      <div className="space-y-2">
        {horses.map((h) => {
          const rest = forecastRestStatus(h, bookings);
          const cap = bindingCap(h, TODAY, bookings, lessonTypes, students);
          return (
            <TapCard key={h.id} tone={!h.active ? "red" : rest === "red" ? "red" : rest === "yellow" ? "amber" : undefined} onClick={() => { setSelectedHorseId(h.id); navTo("horse-detail"); }}>
              <div className="flex justify-between items-center mb-1">
                <p className="text-sm font-medium">{h.name}</p>
                <span className="flex gap-1">
                  <Badge tone={h.active ? "green" : "red"}>{h.active ? "Active" : "Inactive"}</Badge>
                  {h.active && <RestBadge status={rest} />}
                </span>
              </div>
              <p className="text-xs text-gray-500 mb-1">{h.minExp}+ · {h.styles.join(", ")} · max {h.maxWeight} lbs</p>
              <Meter value={cap.used} max={cap.max} />
              <p className="text-xs text-gray-500 mt-1">Today: {cap.used}/{cap.max} min · {cap.label}</p>
            </TapCard>
          );
        })}
      </div>
    </div>
  );
}

function HorseDetail(props) {
  const { selectedHorseId, horses, bookings, students, recurringBookings, lessonTypes, inactivePeriods, navTo, setHorseFormId, setHorseActive, setSheet, setSelectedBookingId, setSelectedStudentId } = props;
  const h = horses.find((x) => x.id === selectedHorseId);
  if (!h) return <BackHeader title="Pick a horse" {...backProps(props)} />;
  const rows = rowsWhere(props, (b) => b.horseId === h.id && b.date >= TODAY && b.date <= addDays(TODAY, 6));
  const regulars = {};
  recurringBookings.filter((r) => r.horseId === h.id && r.status === "active").forEach((r) => {
    const st = students.find((s) => s.id === r.studentId);
    regulars[st.id] = { name: st.name, count: (regulars[st.id] ? regulars[st.id].count : 0) + 1 };
  });
  const noRideStudents = students.filter((s) => s.noRideHorses.includes(h.id));
  const detailCap = bindingCap(h, TODAY, bookings, lessonTypes, students);
  const rest = forecastRestStatus(h, bookings);
  const period = inactivePeriods.find((p) => p.horseId === h.id && p.status === "active");
  return (
    <div>
      <BackHeader title={h.name} {...backProps(props)} right={<Btn onClick={() => { setHorseFormId(h.id); navTo("horse-form"); }}>Edit</Btn>} />
      <div className="flex justify-between items-center mb-3">
        <span className="flex gap-1">
          <Badge tone={h.active ? "green" : "red"}>{h.active ? "Active" : "Inactive"}</Badge>
          {h.active && <RestBadge status={rest} />}
        </span>
        <Btn onClick={() => setHorseActive(h.id, !h.active)}>{h.active ? "Mark inactive" : "Mark active"}</Btn>
      </div>
      {!h.active && period && (
        <Card tone="amber" className="mb-3">
          <p className="text-sm font-medium text-amber-700">Out since {fmtDate(period.startDate)}{period.reason ? ` · ${period.reason}` : ""}</p>
          <p className="text-xs text-gray-500 mb-2">Expected back {period.estimatedEndDate ? fmtDate(period.estimatedEndDate) : "unknown"}</p>
          <Btn className="w-full" onClick={() => { props.setInactivateHorseId(h.id); navTo("substitution"); }}>Plan coverage</Btn>
        </Card>
      )}
      <p className="text-xs text-gray-500 mb-1">{h.minExp}+ · {h.styles.join(", ")} · max {h.maxWeight} lbs · {h.restDaysPerWeek} rest day/wk</p>
      <Meter value={detailCap.used} max={detailCap.max} />
      <p className="text-xs text-gray-500 mt-1 mb-4">Today: {detailCap.used}/{detailCap.max} min · {detailCap.label} · {detailCap.other}</p>
      {h.notes && <Card className="mb-4"><p className="text-xs text-gray-500">Notes</p><p className="text-sm">{h.notes}</p></Card>}

      <SectionTitle>Next 7 days</SectionTitle>
      <div className="space-y-1 mb-4">
        <ScheduleList rows={rows} lessonTypes={lessonTypes} showDate empty="Nothing booked this week." onOpenBooking={(id) => { setSelectedBookingId(id); navTo("booking-detail"); }} />
      </div>

      <SectionTitle>Regular riders</SectionTitle>
      <div className="space-y-1 mb-4">
        {Object.keys(regulars).length === 0 && <Empty>No standing lessons on this horse.</Empty>}
        {Object.entries(regulars).map(([id, r]) => (
          <button key={id} onClick={() => { setSelectedStudentId(id); navTo("student-profile"); }} className="w-full flex justify-between text-sm px-3 py-2 bg-white rounded border border-gray-200">
            <span>{r.name}</span><span className="text-gray-500">{r.count}x/week</span>
          </button>
        ))}
      </div>

      <SectionTitle>Riders this year</SectionTitle>
      <RideTally
        rows={ridesByStudent(h.id, bookings)}
        nameOf={(id) => students.find((s) => s.id === id)?.name}
        unit={["rider", "riders"]}
        empty="No completed lessons on this horse this year."
        onSelect={(id) => { setSelectedStudentId(id); navTo("student-profile"); }}
      />

      <SectionTitle action={<Btn onClick={() => setSheet({ type: "no-ride-horse", ctx: { horseId: h.id } })}>Edit</Btn>}>Excluded students</SectionTitle>
      <div className="space-y-1">
        {noRideStudents.length === 0 && <Empty>None.</Empty>}
        {noRideStudents.map((s) => <div key={s.id} className="text-sm px-3 py-2 bg-white rounded border border-gray-200">{s.name}</div>)}
      </div>
    </div>
  );
}

function HorseForm(props) {
  const { horseFormId, horses, setHorses, goBack, setSelectedHorseId, setCoachScreen } = props;
  const existing = horses.find((h) => h.id === horseFormId);
  const [form, setForm] = useState(existing || { name: "", minExp: "beginner", adultOnly: false, styles: [], maxWeight: 180, restDaysPerWeek: 1, maxDailyAdult: 120, maxDailyOverall: 180, active: true, notes: "" });
  const patch = (p) => setForm({ ...form, ...p });
  const valid = form.name && form.styles.length > 0 && form.maxDailyAdult <= form.maxDailyOverall;
  return (
    <div>
      <BackHeader title={existing ? `Edit ${existing.name}` : "Add horse"} onBack={goBack} />
      <Field label="Name" className="mb-3"><input value={form.name} onChange={(e) => patch({ name: e.target.value })} className="w-full" /></Field>
      <Field label="Minimum rider experience" className="mb-3">
        <div className="mt-1"><Segmented options={EXP_LEVELS.map((l) => [l, l])} value={form.minExp} onChange={(v) => patch({ minExp: v })} /></div>
      </Field>
      <label className="text-xs text-gray-500 flex items-center gap-2 mb-3">
        <input type="checkbox" checked={form.adultOnly} onChange={(e) => patch({ adultOnly: e.target.checked })} style={{ width: "auto" }} /> Adult riders only (18+)
      </label>
      <Field label="Riding styles" className="mb-3">
        <div className="mt-1"><ChipGroup options={RIDING_STYLES.map((s) => ({ value: s, label: s }))} selected={form.styles} onToggle={(s) => patch({ styles: form.styles.includes(s) ? form.styles.filter((x) => x !== s) : [...form.styles, s] })} /></div>
      </Field>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <Field label="Max rider weight (lbs)"><input type="number" value={form.maxWeight} onChange={(e) => patch({ maxWeight: Number(e.target.value) })} className="w-full" /></Field>
        <Field label="Rest days per week"><input type="number" value={form.restDaysPerWeek} onChange={(e) => patch({ restDaysPerWeek: Number(e.target.value) })} className="w-full" /></Field>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <Field label="Daily cap · adult (min)"><input type="number" value={form.maxDailyAdult} onChange={(e) => patch({ maxDailyAdult: Number(e.target.value) })} className="w-full" /></Field>
        <Field label="Daily cap · overall (min)"><input type="number" value={form.maxDailyOverall} onChange={(e) => patch({ maxDailyOverall: Number(e.target.value) })} className="w-full" /></Field>
      </div>
      {form.maxDailyAdult > form.maxDailyOverall && <p className="text-xs text-red-700 mb-2">The adult cap can't be higher than the overall cap.</p>}
      <Field label="Notes" className="mb-4"><textarea value={form.notes} onChange={(e) => patch({ notes: e.target.value })} className="w-full" rows={2} /></Field>
      <Btn variant="primary" className="w-full" disabled={!valid} onClick={() => {
        if (existing) { setHorses((prev) => prev.map((h) => (h.id === existing.id ? { ...h, ...form } : h))); goBack(); }
        else { const id = uid("hor"); setHorses((prev) => [...prev, { ...form, id }]); setSelectedHorseId(id); setCoachScreen("horse-detail"); }
      }}>{existing ? "Save horse" : "Add horse"}</Btn>
    </div>
  );
}

const DURATION_PRESETS = [["3 days", 3], ["1 week", 7], ["2 weeks", 14], ["1 month", 30]];

function SubstitutionPlanning(props) {
  const { inactivateHorseId, horses, students, recurringBookings, bookings, lessonTypes, subAssignments, setSubAssignments, setBookings, inactivePeriods, setInactivePeriods, navTo, goBack, setSelectedBookingId } = props;
  const horse = horses.find((h) => h.id === inactivateHorseId);
  if (!horse) return <BackHeader title="Pick a horse to plan coverage for" {...backProps(props)} />;
  const period = inactivePeriods.find((p) => p.horseId === horse.id && p.status === "active");
  if (!period) {
    return (
      <div>
        <BackHeader title={`${horse.name} coverage`} {...backProps(props)} />
        <Card tone="amber"><p className="text-sm">{horse.name} isn't currently marked inactive, so there's nothing to cover.</p></Card>
        <Btn className="w-full mt-3" onClick={goBack}>Back</Btn>
      </div>
    );
  }
  const endDate = period.estimatedEndDate || addDays(TODAY, 30);
  const inWindow = (d) => d >= TODAY && d <= endDate;

  // Affected work: one item per recurring pattern in the window (one confirm covers all its
  // occurrences), plus one item per non-recurring booking (each decided on its own).
  // Matched on the *pattern's* horse, not the occurrence's, so a lesson already moved onto a
  // substitute still shows here as covered rather than vanishing from the list.
  const recItems = recurringBookings.filter((r) => r.horseId === horse.id && r.status === "active")
    .map((r) => ({ kind: "recurring", key: r.id, rec: r, occurrences: bookings.filter((b) => b.recurringId === r.id && inWindow(b.date) && !isHiddenFromSchedule(b)) }))
    .filter((i) => i.occurrences.length > 0);
  const adhocItems = bookings.filter((b) => !b.recurringId && inWindow(b.date) && !isHiddenFromSchedule(b) && (b.horseId === horse.id || subAssignments.some((a) => a.bookingId === b.id)))
    .map((b) => ({ kind: "adhoc", key: b.id, booking: b }));
  const items = [...recItems, ...adhocItems];
  const unresolved = items.filter((i) => !subAssignments.find((a) => (i.kind === "recurring" ? a.recurringId === i.key : a.bookingId === i.key))).length;

  function confirmSub(item, subHorse) {
    const targets = item.kind === "recurring" ? item.occurrences.map((b) => b.id) : [item.booking.id];
    setSubAssignments((prev) => [...prev, { id: uid("sub"), periodId: period.id, recurringId: item.kind === "recurring" ? item.key : null, bookingId: item.kind === "adhoc" ? item.key : null, substituteHorseId: subHorse.id, confirmed: true }]);
    setBookings((prev) => prev.map((b) => (targets.includes(b.id) ? { ...b, horseId: subHorse.id } : b)));
    const sample = item.kind === "recurring" ? item.occurrences[0] : item.booking;
    const studentId = item.kind === "recurring" ? item.rec.studentId : item.booking.studentId;
    const span = item.kind === "recurring" && item.occurrences.length > 1
      ? `${item.occurrences.length} lessons from ${fmtDate(item.occurrences[0].date)}`
      : sample ? `${DAY_NAMES[sample.date.getDay()]} ${fmtDate(sample.date)} ${timeStr(parseTime(sample.start))}` : "upcoming lessons";
    props.notifyStudent(studentId, "substitute_horse", `${span} · ${subHorse.name} while ${horse.name} is out`);
  }
  function undoSub(item, assignment) {
    setSubAssignments((prev) => prev.filter((a) => a.id !== assignment.id));
    setBookings((prev) => prev.map((b) => {
      const mine = item.kind === "recurring" ? b.recurringId === item.key : b.id === item.key;
      return mine && inWindow(b.date) && b.horseId === assignment.substituteHorseId ? { ...b, horseId: horse.id } : b;
    }));
  }

  return (
    <div>
      <BackHeader title={`${horse.name} is inactive`} {...backProps(props)} />
      <Card className="mb-3">
        <p className="text-xs text-gray-500 mb-2">Expected back {fmtDate(endDate)} · change the estimate and the affected list updates.</p>
        <Segmented cols={4} options={DURATION_PRESETS.map(([l, n]) => [n, l])} value={Math.round((endDate - TODAY) / 86400000)} onChange={(n) => setInactivePeriods((prev) => prev.map((p) => (p.id === period.id ? { ...p, estimatedEndDate: addDays(TODAY, n) } : p)))} />
      </Card>
      <p className="text-xs text-gray-500 mb-3">{items.length} lesson{items.length === 1 ? "" : "s"} affected · {unresolved} still to decide.</p>
      <div className="space-y-3">
        {items.length === 0 && <Empty>Nothing booked on {horse.name} in this window.</Empty>}
        {items.map((item) => {
          const sampleBooking = item.kind === "recurring" ? item.occurrences[0] : item.booking;
          const st = students.find((s) => s.id === sampleBooking.studentId);
          const lt = lessonTypes.find((l) => l.id === sampleBooking.lessonTypeId);
          const candidates = getEligibleHorses(st, lt, horses.filter((x) => x.id !== horse.id))
            .map((cand) => ({ cand, v: validateSwap(cand, sampleBooking, props) }));
          const clear = candidates.filter((c) => c.v.ok).map((c) => c.cand);
          const assignment = subAssignments.find((a) => (item.kind === "recurring" ? a.recurringId === item.key : a.bookingId === item.key));
          return (
            <Card key={item.key} tone={assignment ? "green" : clear.length === 0 ? "red" : undefined}>
              <div className="flex justify-between items-start mb-1 gap-2">
                <button className="text-left" onClick={() => { setSelectedBookingId(sampleBooking.id); navTo("booking-detail"); }}>
                  <p className="text-sm font-medium">
                    {item.kind === "recurring" ? `${DAY_NAMES[item.rec.day]}s ${timeStr(parseTime(item.rec.start))}` : `${fmtDate(sampleBooking.date)} ${timeStr(parseTime(sampleBooking.start))}`} · {st.name}
                  </p>
                  <p className="text-xs text-gray-500">{item.kind === "recurring" ? `${item.occurrences.length} occurrence${item.occurrences.length === 1 ? "" : "s"} in this window` : lt.name}</p>
                </button>
                <Badge tone={item.kind === "recurring" ? "gray" : "blue"}>{item.kind === "recurring" ? "Recurring" : "Ad hoc"}</Badge>
              </div>
              {assignment ? (
                <div className="flex justify-between items-center bg-green-50 p-2 rounded">
                  <p className="text-xs text-green-700">Covered by {horses.find((x) => x.id === assignment.substituteHorseId).name}</p>
                  <Btn onClick={() => undoSub(item, assignment)}>Undo</Btn>
                </div>
              ) : clear.length === 0 ? (
                <div className="bg-red-50 p-2 rounded">
                  <p className="text-xs text-red-700 font-medium">No eligible horse for this lesson</p>
                  <p className="text-xs text-gray-500">{candidates.length === 0 ? "No horse matches this student's pairing rules." : `Closest: ${candidates[0].cand.name} — ${firstFailure(candidates[0].v)}`}</p>
                </div>
              ) : (
                <div className="bg-green-50 p-2 rounded">
                  <div className="flex justify-between items-center mb-1">
                    <div>
                      <p className="text-sm font-medium text-green-700">{clear[0].name} recommended</p>
                      <p className="text-xs text-gray-500">Clears pairing, rest day and usage cap</p>
                    </div>
                    <Btn variant="success" onClick={() => confirmSub(item, clear[0])}>Confirm</Btn>
                  </div>
                  {clear.length > 1 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {clear.slice(1).map((c) => <button key={c.id} onClick={() => confirmSub(item, c)} className="text-xs px-2 py-1 rounded border border-gray-300 bg-white">Use {c.name}</button>)}
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
      <Btn variant="primary" className="w-full mt-4" onClick={() => navTo("horses")}>Done</Btn>
    </div>
  );
}

// A coach can enter four numbers that individually look sensible and together produce a $30
// spread she never intended. This is how she finds out at Setup rather than at the first booking:
// the cheapest and dearest realistic prices this type can produce, with the reasoning spelled out.
function PricingExample({ form, priceBands, trainerConfig }) {
  const adj = form.bandAdjustments || {};
  const bandVals = priceBands.map((b) => ({ name: b.name, amount: Number(adj[b.id] || 0) }));
  const topBand = bandVals.reduce((a, b) => (b.amount > (a ? a.amount : -Infinity) ? b : a), null);
  const lowBand = bandVals.reduce((a, b) => (b.amount < (a ? a.amount : Infinity) ? b : a), null);
  const bestDiscount = Math.max(Number(form.freqDiscount2 || 0), Number(form.freqDiscount1 || 0), 0);
  const gap = Number(form.gapFillDiscount || 0);

  const dearRaw = form.basePrice + Math.max(topBand ? topBand.amount : 0, 0);
  const cheapRaw = form.basePrice + Math.min(lowBand ? lowBand.amount : 0, 0) - bestDiscount - gap;
  const dear = Math.min(dearRaw, form.maxPrice);
  const cheap = Math.max(cheapRaw, form.minPrice);

  const dearParts = [`base $${form.basePrice}`];
  if (topBand && topBand.amount > 0) dearParts.push(`${topBand.name.toLowerCase()} +$${topBand.amount}`);
  const cheapParts = [`base $${form.basePrice}`];
  if (lowBand && lowBand.amount < 0) cheapParts.push(`${lowBand.name.toLowerCase()} −$${Math.abs(lowBand.amount)}`);
  if (bestDiscount) cheapParts.push(`frequent rider −$${bestDiscount}`);
  if (gap) cheapParts.push(`gap-fill −$${gap}`);

  const ceilingBreached = dearRaw > form.maxPrice;
  const floorRoutine = cheapRaw < form.minPrice;
  return (
    <div className="bg-gray-50 border border-gray-200 rounded p-3 mb-4">
      <p className="text-xs font-medium mb-1">What this actually charges</p>
      <p className="text-xs text-gray-600">Cheapest <span className="font-medium">${cheap}</span> <span className="text-gray-400">({cheapParts.join(", ")})</span></p>
      <p className="text-xs text-gray-600">Dearest <span className="font-medium">${dear}</span> <span className="text-gray-400">({dearParts.join(", ")})</span></p>
      {dear !== cheap && <p className="text-xs text-gray-400 mt-1">A ${dear - cheap} spread between two students in the same week.</p>}
      {ceilingBreached && <p className="text-xs text-red-700 mt-1">Your band adjustment pushes this past the ${form.maxPrice} ceiling. Raise the ceiling or lower the band — a band clamped at booking time reads as the system overruling a setting you entered on purpose.</p>}
      {floorRoutine && <p className="text-xs text-amber-700 mt-1">Discounts routinely hit the ${form.minPrice} floor, so some of what you think you're giving away won't reach the student.</p>}
    </div>
  );
}

function LessonsScreen(props) {
  const { lessonTypes, setLessonTypes, horses, trainerConfig, setTrainerConfig, bookings, recurringBookings, priceBands, setPriceBands, recomputeFrequencyTiers } = props;
  // Changing a threshold changes who qualifies, so every student is re-tiered against the new
  // rule in the same action -- and anyone who moves is told. Leaving the old tiers standing
  // would mean the rule on screen and the rates being charged quietly disagreed.
  function setThreshold(patch) {
    const next = { ...trainerConfig, ...patch };
    setTrainerConfig(next);
    recomputeFrequencyTiers(next);
  }
  const [bandForm, setBandForm] = useState(null);
  const [editingId, setEditingId] = useState(null); // null | "new" | id
  const [form, setForm] = useState(null);

  function startEdit(lt) { setEditingId(lt.id); setForm({ ...lt }); }
  function startNew() { setEditingId("new"); setForm({ name: "", isIntro: false, durationMin: 60, rideTimeMin: 45, isGroup: false, maxGroupSize: 4, basePrice: 65, minPrice: 55, maxPrice: 80, bandAdjustments: {}, freqDiscount1: null, freqDiscount2: null, gapFillDiscount: null, restrictedHorseIds: [], ridingStyles: [], potentialEligible: true }); }

  // Band edit/remove. Removing a band any lesson type prices is blocked: silently zeroing an
  // adjustment across three lesson types is not something a coach should do by tapping one X.
  function bandInUse(bandId) { return lessonTypes.some((lt) => (lt.bandAdjustments || {})[bandId]); }

  // The band editor doubles as a second way in to `Lesson_Types.band_adjustments` -- the same
  // field the lesson type form writes, not a copy of it. Both surfaces exist because the coach
  // approaches the number from two directions: "what does this lesson cost?" when setting up a
  // type, and "what is after-school worth?" when defining the band. Forcing the second question
  // through four separate lesson type forms is how a coach ends up with a premium on three of
  // them and a blank on the fourth without noticing.
  function amountsFor(bandId) {
    const out = {};
    lessonTypes.forEach((lt) => { out[lt.id] = bandId ? Number((lt.bandAdjustments || {})[bandId] || 0) : 0; });
    return out;
  }

  function saveBand() {
    const clash = bandOverlap(bandForm, priceBands);
    if (clash || !bandForm.name || !bandForm.days.length) return;
    // A new band has no id until it's saved, so the amounts draft is keyed by lesson type and
    // the band id is stitched in here -- otherwise the amounts would have nowhere to land.
    const bandId = bandForm.id || uid("band");
    const { amounts, ...bandRow } = bandForm;
    if (bandForm.id) setPriceBands((prev) => prev.map((b) => (b.id === bandId ? bandRow : b)));
    else setPriceBands((prev) => [...prev, { ...bandRow, id: bandId }]);
    setLessonTypes((prev) => prev.map((lt) => {
      const v = Number((amounts || {})[lt.id] || 0);
      const next = { ...(lt.bandAdjustments || {}) };
      // A zero is stored as absent rather than as 0, so "not priced for this band" and "priced
      // at nothing" stay the same state however the coach arrived at it.
      if (v) next[bandId] = v; else delete next[bandId];
      return { ...lt, bandAdjustments: next };
    }));
    setBandForm(null);
  }
  function save() {
    // Uniqueness is enforced on save rather than blocked in the form: the coach's last choice is
    // the one she meant, and refusing it would make her go and unset the other one first.
    const clearOthers = (list, keepId) => (form.isIntro ? list.map((l) => (l.id === keepId ? l : { ...l, isIntro: false })) : list);
    if (editingId === "new") {
      const id = uid("lt");
      setLessonTypes((prev) => clearOthers([...prev, { ...form, id }], id));
    } else {
      setLessonTypes((prev) => clearOthers(prev.map((l) => (l.id === editingId ? { ...form } : l)), editingId));
    }
    setEditingId(null); setForm(null);
  }


  if (editingId) {
    // Any booking, past or future -- plus any recurring pattern. Checking only upcoming lessons
    // let a coach clear next week, delete the type, and leave every past lesson pointing at a
    // definition that no longer exists: the rider's history then can't say what they rode or why
    // it cost what it did. A type that has ever been used is part of the record.
    const upcomingUse = bookings.some((b) => b.lessonTypeId === editingId && b.date >= TODAY);
    const historicUse = bookings.some((b) => b.lessonTypeId === editingId && b.date < TODAY);
    const patternUse = recurringBookings.some((r) => r.lessonTypeId === editingId && r.status === "active");
    const inUse = editingId !== "new" && (upcomingUse || historicUse || patternUse);
    return (
      <div>
        <BackHeader title={editingId === "new" ? "New lesson type" : "Edit lesson type"} onBack={() => { setEditingId(null); setForm(null); }} />
        <Field label="Name" className="mb-3"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full" /></Field>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <Field label="Duration (min)" hint="· calendar time"><input type="number" value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: Number(e.target.value) })} className="w-full" /></Field>
          <Field label="Ride time (min)" hint="· saddle time"><input type="number" value={form.rideTimeMin} onChange={(e) => setForm({ ...form, rideTimeMin: Number(e.target.value) })} className="w-full" /></Field>
        </div>
        <label className="text-xs text-gray-500 flex items-center gap-2 mb-3">
          <input type="checkbox" checked={form.isGroup} onChange={(e) => setForm({ ...form, isGroup: e.target.checked, potentialEligible: e.target.checked ? false : form.potentialEligible })} style={{ width: "auto" }} /> Group lesson
        </label>
        {form.isGroup && <Field label="Max group size" className="mb-3"><input type="number" value={form.maxGroupSize} onChange={(e) => setForm({ ...form, maxGroupSize: Number(e.target.value) })} className="w-full" /></Field>}
        <label className={`text-xs flex items-center gap-2 mb-1 ${form.isGroup ? "text-gray-400" : "text-gray-500"}`}>
          <input type="checkbox" disabled={form.isGroup} checked={form.potentialEligible && !form.isGroup} onChange={(e) => setForm({ ...form, potentialEligible: e.target.checked })} style={{ width: "auto" }} /> Offer this type to fill open slots
        </label>
        <p className="text-xs text-gray-400 mb-3">
          {form.isGroup
            ? "Group lessons are never offered as potential lessons — filling a gap means coordinating several riders and horses at once, which is more than a single offer can carry."
            : "When on, open windows that fit this type show up as potential lessons on your Day view, and matching students can be notified about them."}
        </p>
        {/* Exactly one type can be the intro lesson: it's what a brand-new rider is offered
            before anything else is unlocked, and two of them would make "their first lesson"
            ambiguous. Setting it here clears it everywhere else rather than erroring. */}
        <Field label="Use this as the first-lesson type" className="mb-1">
          <div className="mt-1">
            <Segmented
              cols={2}
              options={[["yes", "Yes"], ["no", "No"]]}
              value={form.isIntro ? "yes" : "no"}
              onChange={(v) => setForm({ ...form, isIntro: v === "yes" })}
            />
          </div>
        </Field>
        <p className="text-xs text-gray-400 mb-3">
          {form.isIntro
            ? "New riders are offered this type for their first lesson, before recurring and open lessons are unlocked."
            : (() => {
                const other = lessonTypes.find((l) => l.isIntro && l.id !== editingId);
                return other
                  ? `“${other.name}” is currently your first-lesson type. Switching this on moves it here.`
                  : "No type is set as the first lesson, so new riders have nothing to book. Set one here.";
              })()}
        </p>

        {/* Pricing lives inside the lesson type form rather than on a screen of its own: this is
            where the coach is already deciding what the lesson IS, and what it costs is part of
            that answer. A separate Pricing screen would mean setting a type up and then having to
            remember to go price it, with a half-configured type in between. */}
        <SectionTitle>Pricing</SectionTitle>
        <div className="grid grid-cols-3 gap-2 mb-1">
          <Field label="Base price"><input type="number" value={form.basePrice} onChange={(e) => setForm({ ...form, basePrice: Number(e.target.value) })} className="w-full" /></Field>
          <Field label="Floor"><input type="number" value={form.minPrice} onChange={(e) => setForm({ ...form, minPrice: Number(e.target.value) })} className="w-full" /></Field>
          <Field label="Ceiling"><input type="number" value={form.maxPrice} onChange={(e) => setForm({ ...form, maxPrice: Number(e.target.value) })} className="w-full" /></Field>
        </div>
        <p className="text-xs text-gray-400 mb-3">Every adjustment below is applied to the base price. The floor is the point no stack of discounts can go under — it's the field that quietly does the most work.</p>

        {/* No bands defined: this block doesn't render at all rather than showing an empty state.
            A coach who hasn't opted into time-based pricing shouldn't scroll past it every time. */}
        {priceBands.length > 0 && (
          <>
            <Field label="Price band adjustments" hint="· whole dollars, + or −" className="mb-3">
              <div className="space-y-1 mt-1">
                {priceBands.map((band) => (
                  <div key={band.id} className="flex items-center gap-2">
                    <div className="flex-1">
                      <p className="text-xs font-medium">{band.name}</p>
                      <p className="text-xs text-gray-400">{band.days.map((d) => DAY_NAMES[d]).join(" ")} · {timeStr(parseTime(band.start))}–{timeStr(parseTime(band.end))}</p>
                    </div>
                    <input type="number" value={(form.bandAdjustments || {})[band.id] || 0} onChange={(e) => setForm({ ...form, bandAdjustments: { ...(form.bandAdjustments || {}), [band.id]: Number(e.target.value) } })} className="w-20 text-xs" />
                  </div>
                ))}
              </div>
            </Field>
          </>
        )}

        {/* Labelled with the actual threshold rather than "Tier 1", so the form reads as the
            sentence the coach would say to a student. */}
        {trainerConfig.freqTier1MinRides ? (
          <div className="grid grid-cols-2 gap-2 mb-1">
            <Field label={`${trainerConfig.freqTier1MinRides}+ rides/month`} hint="· $ off">
              <input type="number" value={form.freqDiscount1 === null || form.freqDiscount1 === undefined ? "" : form.freqDiscount1} onChange={(e) => setForm({ ...form, freqDiscount1: e.target.value === "" ? null : Number(e.target.value) })} className="w-full" />
            </Field>
            {trainerConfig.freqTier2MinRides ? (
              <Field label={`${trainerConfig.freqTier2MinRides}+ rides/month`} hint="· $ off">
                <input type="number" value={form.freqDiscount2 === null || form.freqDiscount2 === undefined ? "" : form.freqDiscount2} onChange={(e) => setForm({ ...form, freqDiscount2: e.target.value === "" ? null : Number(e.target.value) })} className="w-full" />
              </Field>
            ) : null}
          </div>
        ) : null}
        {trainerConfig.freqTier1MinRides ? <p className="text-xs text-gray-400 mb-3">Leave blank if this type isn't discounted by how often someone rides — the right answer for an intro lesson.</p> : null}

        {!form.isGroup && (
          <Field label="Gap-fill discount" hint="· one-tap preset when offering an open slot" className="mb-1">
            <input type="number" value={form.gapFillDiscount === null || form.gapFillDiscount === undefined ? "" : form.gapFillDiscount} onChange={(e) => setForm({ ...form, gapFillDiscount: e.target.value === "" ? null : Number(e.target.value) })} className="w-full" />
          </Field>
        )}
        {!form.isGroup && <p className="text-xs text-gray-400 mb-3">A suggestion, not a limit — you can still enter any amount when you send an offer. Only ever applied to an offer you send: a student who finds the same slot and books it themselves pays full price.</p>}
        {form.isGroup && <p className="text-xs text-gray-400 mb-3">Group lessons are never offered to fill gaps, so there's no gap-fill discount to set. Bands and frequency discounts apply as normal.</p>}

        <PricingExample form={form} priceBands={priceBands} trainerConfig={trainerConfig} />
        <Field label="Riding styles" hint="(none selected = any style)" className="mb-3">
          <div className="mt-1"><ChipGroup options={RIDING_STYLES.map((s) => ({ value: s, label: s }))} selected={form.ridingStyles} onToggle={(s) => setForm({ ...form, ridingStyles: form.ridingStyles.includes(s) ? form.ridingStyles.filter((x) => x !== s) : [...form.ridingStyles, s] })} /></div>
        </Field>
        <Field label="Restricted to specific horses" hint="(none selected = any pairing-eligible horse)" className="mb-4">
          <div className="mt-1"><ChipGroup options={horses.map((h) => ({ value: h.id, label: h.name }))} selected={form.restrictedHorseIds} onToggle={(id) => setForm({ ...form, restrictedHorseIds: form.restrictedHorseIds.includes(id) ? form.restrictedHorseIds.filter((x) => x !== id) : [...form.restrictedHorseIds, id] })} /></div>
        </Field>
        {(() => {
          // Mirrors the band editor's gate: the same rule has to bite from whichever direction
          // the coach reaches the number, or one screen quietly permits what the other rejects.
          const overCeiling = Object.values(form.bandAdjustments || {}).some((v) => form.basePrice + Number(v || 0) > form.maxPrice);
          const badRange = form.minPrice > form.maxPrice;
          const blocked = !form.name || form.rideTimeMin > form.durationMin || overCeiling || badRange;
          return (
            <>
              <Btn variant="primary" className="w-full mb-2" disabled={blocked} onClick={save}>Save lesson type</Btn>
              {form.rideTimeMin > form.durationMin && <p className="text-xs text-red-700 mb-2">Ride time can't exceed the lesson's calendar duration.</p>}
              {badRange && <p className="text-xs text-red-700 mb-2">The floor can't sit above the ceiling.</p>}
              {overCeiling && <p className="text-xs text-red-700 mb-2">A band adjustment pushes this type past its ${form.maxPrice} ceiling. Raise the ceiling or lower the band.</p>}
            </>
          );
        })()}
        {editingId !== "new" && (
          // Fragment added: these two siblings sat directly inside the `&&` with nothing
          // wrapping them, which is a syntax error, not a style problem. prototype.jsx has
          // never parsed because of it.
          <>
            <Btn variant="danger" className="w-full" disabled={inUse} title={inUse ? "Lessons still reference this type" : ""} onClick={() => { setLessonTypes((prev) => prev.filter((l) => l.id !== editingId)); setEditingId(null); setForm(null); }}>
              {!inUse ? "Delete lesson type" : upcomingUse || patternUse ? "In use by upcoming lessons" : "Used by past lessons"}
            </Btn>
            {inUse && !upcomingUse && !patternUse && (
              <p className="text-xs text-gray-500 mt-1">Nothing upcoming uses this, but past lessons still do — deleting it would leave those lessons unable to say what they were. Stop offering it by removing it from your availability instead.</p>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      <BackHeader title="Lessons" {...backProps(props)} />
      <p className="text-xs text-gray-400 mb-3">What you teach and what it costs. When your <em>hours</em> are is on the Schedule tab.</p>
      <SectionTitle>Lesson types</SectionTitle>
      {!lessonTypes.some((l) => l.isIntro) && (
        <Card tone="amber" className="mb-2">
          <p className="text-xs text-amber-700">No type is marked as your first-lesson type, so a new rider finishing their profile has nothing to book. Open a type and set it.</p>
        </Card>
      )}
      <div className="space-y-2 mb-3">
        {lessonTypes.map((lt) => (
          <Card key={lt.id}>
            <div className="flex justify-between items-start gap-2">
              <div>
                <p className="text-sm font-medium">{lt.name}</p>
                {lt.isIntro && <Badge tone="blue">First lesson</Badge>}
                <p className="text-xs text-gray-500">{lt.durationMin} min calendar · {lt.rideTimeMin} min ride{lt.isGroup ? ` · group up to ${lt.maxGroupSize}` : ""}</p>
                <p className="text-xs text-gray-500">Base ${lt.basePrice} · floor ${lt.minPrice} · ceiling ${lt.maxPrice}</p>
                {Object.entries(lt.bandAdjustments || {}).filter(([, v]) => v).length > 0 && (
                  <p className="text-xs text-gray-500">{Object.entries(lt.bandAdjustments).filter(([, v]) => v).map(([id, v]) => `${(priceBands.find((b) => b.id === id) || {}).name || "band"} ${v > 0 ? "+" : "−"}$${Math.abs(v)}`).join(" · ")}</p>
                )}
                {(lt.freqDiscount1 || lt.freqDiscount2) ? <p className="text-xs text-gray-500">Frequent rider −${lt.freqDiscount1 || 0}/−${lt.freqDiscount2 || 0}</p> : null}
                {lt.gapFillDiscount ? <p className="text-xs text-gray-500">Gap-fill −${lt.gapFillDiscount}</p> : null}
                <p className="text-xs text-gray-500 mt-1">{lt.isGroup ? "Never offered as a potential lesson" : lt.potentialEligible ? "Offered to fill open slots" : "Not offered to fill open slots"}</p>
                {lt.ridingStyles.length > 0 && <p className="text-xs text-gray-500 mt-1">Styles: {lt.ridingStyles.join(", ")}</p>}
                {lt.restrictedHorseIds.length > 0 && <p className="text-xs text-gray-500 mt-1">Restricted to: {lt.restrictedHorseIds.map((id) => horses.find((h) => h.id === id)?.name).join(", ")}</p>}
              </div>
              <Btn onClick={() => startEdit(lt)}>Edit</Btn>
            </div>
          </Card>
        ))}
      </div>
      <Btn className="w-full mb-6" onClick={startNew}>+ Add lesson type</Btn>

      {/* Sits directly under lesson types because every one of them reads it, and above
          availability because it's about pricing rather than about the calendar. */}
      <SectionTitle>Price bands</SectionTitle>
      <p className="text-xs text-gray-400 mb-2">Times you charge differently. Windows only — what each band is <em>worth</em> is set per lesson type, since a $10 after-school premium that suits a 60-minute private is wrong for a 30-minute one. Up to {MAX_PRICE_BANDS}, and no two may overlap.</p>
      <div className="space-y-2 mb-2">
        {priceBands.length === 0 && <Empty>No bands — every lesson is priced at its type's base price.</Empty>}
        {priceBands.map((band) => {
          const used = bandInUse(band.id);
          const pricedBy = lessonTypes.filter((lt) => (lt.bandAdjustments || {})[band.id]);
          return (
            <Card key={band.id}>
              <div className="flex justify-between items-start gap-2">
                <div>
                  <p className="text-sm font-medium">{band.name}</p>
                  <p className="text-xs text-gray-500">{band.days.map((d) => DAY_NAMES[d]).join(" ")} · {timeStr(parseTime(band.start))}–{timeStr(parseTime(band.end))}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {pricedBy.length === 0 ? "No lesson type prices this band yet" : pricedBy.map((lt) => `${lt.name} ${(lt.bandAdjustments[band.id] > 0 ? "+" : "−")}$${Math.abs(lt.bandAdjustments[band.id])}`).join(" · ")}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <Btn onClick={() => setBandForm({ ...band, amounts: amountsFor(band.id) })}>Edit</Btn>
                  <Btn variant="danger" disabled={used} title={used ? "Set its amounts to 0 in Edit first" : ""} onClick={() => setPriceBands((prev) => prev.filter((b) => b.id !== band.id))}>Remove</Btn>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
      {bandForm ? (
        <div className="bg-white border border-gray-200 rounded px-3 py-2 mb-6">
          <Field label="Band name" hint="· students see this word on their receipt" className="mb-2">
            <input value={bandForm.name} onChange={(e) => setBandForm({ ...bandForm, name: e.target.value })} placeholder="e.g. After school" className="w-full" />
          </Field>
          <Field label="Days" className="mb-2">
            <div className="mt-1"><ChipGroup options={DAY_ORDER.map((d) => ({ value: d, label: DAY_NAMES[d] }))} selected={bandForm.days} onToggle={(d) => setBandForm({ ...bandForm, days: bandForm.days.includes(d) ? bandForm.days.filter((x) => x !== d) : [...bandForm.days, d] })} /></div>
          </Field>
          <div className="flex items-center gap-2 mb-3">
            <TimeSelect value={bandForm.start} onChange={(v) => setBandForm({ ...bandForm, start: v })} />
            <span className="text-xs text-gray-400">to</span>
            <TimeSelect value={bandForm.end} onChange={(v) => setBandForm({ ...bandForm, end: v })} />
          </div>

          <Field label="What this band is worth" hint="· per lesson type, whole dollars, + or −" className="mb-2">
            <div className="space-y-1 mt-1">
              {lessonTypes.map((lt) => {
                const v = Number((bandForm.amounts || {})[lt.id] || 0);
                // Same ceiling rule as the lesson type form: a band that would push a type past
                // its own max is caught here, where the coach can fix it, rather than clamped
                // silently at booking time.
                const overCeiling = lt.basePrice + v > lt.maxPrice;
                return (
                  <div key={lt.id}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <p className="text-xs font-medium">{lt.name}</p>
                        <p className="text-xs text-gray-400">base ${lt.basePrice} → <span className={overCeiling ? "text-red-700" : ""}>${Math.min(lt.basePrice + v, lt.maxPrice)}</span> in this band</p>
                      </div>
                      <input type="number" value={v} onChange={(e) => setBandForm({ ...bandForm, amounts: { ...(bandForm.amounts || {}), [lt.id]: Number(e.target.value) } })} className="w-20 text-xs" />
                    </div>
                    {overCeiling && <p className="text-xs text-red-700">Past this type's ${lt.maxPrice} ceiling — raise the ceiling on the lesson type or lower this amount.</p>}
                  </div>
                );
              })}
            </div>
          </Field>
          <p className="text-xs text-gray-400 mb-2">These are the same amounts you'd set inside each lesson type — this is just the other way round. Leave one at 0 and that type isn't priced differently in this band.</p>
          {(() => {
            const clash = bandOverlap(bandForm, priceBands);
            const badTimes = parseTime(bandForm.end) <= parseTime(bandForm.start);
            // Blocked, not merely warned. A band the coach can save above a type's ceiling would
            // be clamped at booking time, which reads as the system quietly overruling a number
            // she entered on purpose — the failure the ceiling rule exists to avoid.
            const breaches = lessonTypes.filter((lt) => lt.basePrice + Number((bandForm.amounts || {})[lt.id] || 0) > lt.maxPrice);
            return (
              <>
                {clash && <p className="text-xs text-red-700 mb-2">Overlaps “{clash.name}”. A time has to fall in exactly one band, or a slot has two possible prices.</p>}
                {badTimes && <p className="text-xs text-red-700 mb-2">The end time has to come after the start.</p>}
                <div className="flex gap-2">
                  <Btn variant="primary" className="flex-1" disabled={!!clash || badTimes || breaches.length > 0 || !bandForm.name || !bandForm.days.length} title={breaches.length ? `Over the ceiling on ${breaches.map((l) => l.name).join(", ")}` : ""} onClick={saveBand}>
                    {breaches.length ? "Over a lesson type's ceiling" : "Save band"}
                  </Btn>
                  <Btn className="flex-1" onClick={() => setBandForm(null)}>Cancel</Btn>
                </div>
              </>
            );
          })()}
        </div>
      ) : (
        <Btn className="w-full mb-6" disabled={priceBands.length >= MAX_PRICE_BANDS} title={priceBands.length >= MAX_PRICE_BANDS ? `${MAX_PRICE_BANDS} is the maximum` : ""} onClick={() => setBandForm({ id: null, name: "", days: [1, 2, 3, 4, 5], start: "15:00", end: "17:00", amounts: amountsFor(null) })}>
          {priceBands.length >= MAX_PRICE_BANDS ? `${MAX_PRICE_BANDS} bands is the maximum` : "+ Add price band"}
        </Btn>
      )}

      {/* Lives on Lessons because what it's worth is set per lesson type — but tier 1's
          threshold is also the number that decides who gets scheduling flexibility, so the
          Schedule tab points back here rather than carrying a second copy of it. One definition
          of "frequent rider": a coach explaining why a student is one but not the other has no
          good answer available. */}
      <SectionTitle>Frequent riders</SectionTitle>
      <p className="text-xs text-gray-400 mb-2">One threshold, two jobs: it decides who you flex the schedule for <em>and</em> who earns a discount. What the discount is worth is set per lesson type below. Leave blank to switch frequency discounts off entirely.</p>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <Field label="Tier 1 (rides/month)">
          <input type="number" value={trainerConfig.freqTier1MinRides || ""} onChange={(e) => setThreshold({ freqTier1MinRides: e.target.value === "" ? null : Number(e.target.value) })} className="w-full" />
        </Field>
        <Field label="Tier 2 (rides/month)">
          <input type="number" value={trainerConfig.freqTier2MinRides || ""} onChange={(e) => setThreshold({ freqTier2MinRides: e.target.value === "" ? null : Number(e.target.value) })} className="w-full" />
        </Field>
      </div>
      <p className="text-xs text-gray-400 mb-3">Counted on lessons a student was <em>billed</em> for, so a late cancel they paid for still counts. Recalculated on the 1st and held steady for the month — and a rider keeps the better rate for a month after a quieter one, so nobody's price goes up because they had flu.</p>


      <SectionTitle>Cancellation policy</SectionTitle>
      <Field label="Notice required (hours)" hint="· cancel with less notice and the lesson is still billed" className="mb-2">
        <input type="number" min={0} value={trainerConfig.lateCancelHours} onChange={(e) => setTrainerConfig({ ...trainerConfig, lateCancelHours: Number(e.target.value) })} className="w-full" />
      </Field>
      <p className="text-xs text-gray-400 mb-3">Students see one cancel button, and which one they get is decided by this number — they never choose between an early and a late cancel. Once a lesson's start time passes the button disappears, since marking it a no-show or a late cancel is your call. You can still override either on any booking.</p>

    </div>
  );
}

function ScheduleScreen(props) {
  const { trainerAvailability, setTrainerAvailability, trainerConfig, setTrainerConfig, timeOffBlocks, setTimeOffBlocks, bookings, navRoot } = props;
  const [newOff, setNewOff] = useState({ startDate: "", endDate: "", reason: "" });

  function addWindow(day) { setTrainerAvailability((prev) => [...prev, { id: uid("avail"), day, start: "08:00", end: "12:00" }]); }
  function removeWindow(id) { setTrainerAvailability((prev) => prev.filter((a) => a.id !== id)); }
  function updateWindow(id, field, value) { setTrainerAvailability((prev) => prev.map((a) => (a.id === id ? { ...a, [field]: value } : a))); }
  function addTimeOff() {
    if (!newOff.startDate || !newOff.endDate) return;
    setTimeOffBlocks((prev) => [...prev, { id: uid("off"), startDate: new Date(newOff.startDate + "T00:00:00"), endDate: new Date(newOff.endDate + "T00:00:00"), reason: newOff.reason }]);
    setNewOff({ startDate: "", endDate: "", reason: "" });
  }

  return (
    <div>
      <BackHeader title="Schedule" {...backProps(props)} />
      <p className="text-xs text-gray-400 mb-3">When you're available and how your day gets packed. What you teach and what it costs is on the Lessons tab.</p>
      <SectionTitle>Recurring weekly availability</SectionTitle>
      <p className="text-xs text-gray-400 mb-2">A day can have more than one window — e.g. 8am–12pm and 3pm–8pm the same day.</p>
      <div className="space-y-3 mb-6">
        {DAY_ORDER.map((day) => {
          const windows = trainerAvailability.filter((a) => a.day === day);
          return (
            <div key={day} className="bg-white border border-gray-200 rounded px-3 py-2">
              <p className="text-xs font-medium mb-1">{DAY_NAMES[day]}</p>
              {windows.length === 0 && <p className="text-xs text-gray-400 mb-1">Closed</p>}
              {windows.map((w) => (
                <div key={w.id} className="flex items-center gap-2 mb-1">
                  <TimeSelect value={w.start} onChange={(v) => updateWindow(w.id, "start", v)} />
                  <span className="text-xs text-gray-400">to</span>
                  <TimeSelect value={w.end} onChange={(v) => updateWindow(w.id, "end", v)} />
                  <button onClick={() => removeWindow(w.id)} className="text-xs text-red-600 ml-auto">Remove</button>
                </div>
              ))}
              <button onClick={() => addWindow(day)} className="text-xs text-gray-600 underline">+ Add window</button>
            </div>
          );
        })}
      </div>

      <SectionTitle>Time off</SectionTitle>
      <p className="text-xs text-gray-400 mb-2">Sits on top of your recurring availability. Any lesson caught inside a block is flagged on Alerts and highlighted on Day and Week until you resolve it.</p>
      <div className="space-y-2 mb-2">
        {timeOffBlocks.length === 0 && <Empty>None scheduled.</Empty>}
        {timeOffBlocks.map((b) => {
          const affected = bookings.filter((bk) => (bk.status === "confirmed" || bk.status === "pending") && bk.date >= b.startDate && bk.date <= b.endDate).length;
          return (
            <div key={b.id} className="flex justify-between items-center bg-white border border-gray-200 rounded px-3 py-2">
              <div>
                <p className="text-sm">{fmtDate(b.startDate)}–{fmtDate(b.endDate)}</p>
                {b.reason && <p className="text-xs text-gray-500">{b.reason}</p>}
                {affected > 0 && <p className="text-xs text-red-700">{affected} lesson{affected === 1 ? "" : "s"} still booked inside</p>}
              </div>
              <button onClick={() => setTimeOffBlocks((prev) => prev.filter((x) => x.id !== b.id))} className="text-xs text-red-600">Remove</button>
            </div>
          );
        })}
      </div>
      <div className="bg-white border border-gray-200 rounded px-3 py-2 mb-6">
        <div className="grid grid-cols-2 gap-2 mb-2">
          <Field label="Start date"><input type="date" value={newOff.startDate} onChange={(e) => setNewOff({ ...newOff, startDate: e.target.value })} className="w-full text-xs" /></Field>
          <Field label="End date"><input type="date" value={newOff.endDate} onChange={(e) => setNewOff({ ...newOff, endDate: e.target.value })} className="w-full text-xs" /></Field>
        </div>
        <input placeholder="Reason (optional)" value={newOff.reason} onChange={(e) => setNewOff({ ...newOff, reason: e.target.value })} className="w-full mb-2 text-xs" />
        <Btn className="w-full" disabled={!newOff.startDate || !newOff.endDate} onClick={addTimeOff}>+ Add time off</Btn>
      </div>

      <SectionTitle>Scheduling preference</SectionTitle>
      <p className="text-xs text-gray-400 mb-2">How tightly your day gets packed when the system suggests times.</p>
      <div className="mb-3"><Segmented cols={2} options={[["back_to_back", "Back-to-back"], ["spaced", "Spaced out"]]} value={trainerConfig.schedulingPreference} onChange={(v) => setTrainerConfig({ ...trainerConfig, schedulingPreference: v })} /></div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <Field label="Minimum buffer (min)"><input type="number" value={trainerConfig.minBufferMin} onChange={(e) => setTrainerConfig({ ...trainerConfig, minBufferMin: Number(e.target.value) })} className="w-full" /></Field>
        <Field label="Maximum buffer (min)"><input type="number" value={trainerConfig.maxBufferMin} onChange={(e) => setTrainerConfig({ ...trainerConfig, maxBufferMin: Number(e.target.value) })} className="w-full" /></Field>
      </div>
      <Field label="Max back-to-back lessons" className="mb-3"><input type="number" value={trainerConfig.maxBackToBack} onChange={(e) => setTrainerConfig({ ...trainerConfig, maxBackToBack: Number(e.target.value) })} className="w-full" /></Field>


      <div className="bg-blue-50 rounded p-3">
        <p className="text-xs text-blue-700 mb-2">Minimum buffer is always kept between lessons, whatever your preference. Maximum buffer and the back-to-back cap only affect what times get <em>offered</em> to students, and only when your preference is Back-to-back: they cap how tightly a suggested day gets packed before a longer break is required. On Spaced out, neither applies — spaced scheduling isn't packing lessons tightly in the first place.</p>
        <p className="text-xs text-blue-700">
          Which riders you flex the schedule for is decided by the frequent-rider threshold, which lives on <button onClick={() => navRoot("lessons")} className="underline">Lessons</button> — it's the same number that earns them a discount, kept in one place so the two can't drift apart.
        </p>
      </div>
    </div>
  );
}


// Renders a published version's text, read-only. Shared by the coach's preview, the student's
// signing step and the student's Agreements tab, so all three are literally the same words --
// three renderers would eventually drift, and a waiver that displays differently to the person
// signing it than to the person relying on it is worse than none.
function DisclosureText({ sections, lessonTypes, priceBands, trainerConfig, checks, onToggle }) {
  return (
    <div className="space-y-2">
      {sections.map((d) => (
        <Card key={d.key}>
          <p className="text-sm font-medium mb-1">{d.title}</p>
          <p className="text-xs text-gray-600 whitespace-pre-wrap">{d.body}</p>
          {d.key === "pricing" && lessonTypes && (
            <div className="mt-2 pt-2 border-t border-gray-100">
              <p className="text-xs font-medium text-gray-500 mb-1">Current prices</p>
              {pricingSummaryLines(lessonTypes, priceBands, trainerConfig).map((l, i) => (
                <p key={i} className="text-xs text-gray-500">{l.name} — {l.detail}</p>
              ))}
              <p className="text-xs text-gray-400 mt-1">These figures are current as of today and can change; the paragraph above is the part you're agreeing to.</p>
            </div>
          )}
          {onToggle && (
            <label className="flex items-start gap-2 mt-2 pt-2 border-t border-gray-100 cursor-pointer">
              <input type="checkbox" checked={!!checks[d.key]} onChange={() => onToggle(d.key)} style={{ width: "auto", marginTop: 2 }} />
              <span className="text-xs text-gray-600">I have read and agree to “{d.title}”</span>
            </label>
          )}
        </Card>
      ))}
    </div>
  );
}

function InfoDisclosures(props) {
  const { lessonTypes, priceBands, trainerConfig, setTrainerConfig, students, bookings, disclosures, disclosureAcceptances, updateDisclosures } = props;
  const [draft, setDraft] = useState(() => disclosures.sections.map((d) => ({ ...d })));
  const [updateNote, setUpdateNote] = useState("");
  const [openKey, setOpenKey] = useState(null);

  const includedCount = draft.filter((d) => d.included !== false).length;
  const changesSection = draft.find((d) => d.key === "changes");
  const changesIncluded = !!changesSection && changesSection.included !== false;

  const changedKeys = draft.filter((d) => {
    const was = disclosures.sections.find((x) => x.key === d.key);
    // An include/exclude flip is a change to the terms like any other -- it alters what a rider
    // is agreeing to, so it needs the same note and the same notification.
    return !was || was.body !== d.body || was.title !== d.title || (was.included !== false) !== (d.included !== false);
  }).map((d) => d.key);
  const dirty = changedKeys.length > 0;

  const unsigned = students.filter((st) => disclosureStatus(st, disclosures, disclosureAcceptances).outstanding);
  // "Accepted the current terms" means signed since the last change, or booked since it -- the
  // changes clause makes those equivalent, so the screen counts them the same way.
  const current = students.filter((st) => hasAcceptedCurrentTerms(st, bookings, disclosures, disclosureAcceptances));
  const notYet = students.filter((st) => !unsigned.includes(st) && !current.includes(st));

  function patch(key, field, value) { setDraft((prev) => prev.map((d) => (d.key === key ? { ...d, [field]: value } : d))); }
  function resetOne(key) {
    const std = STANDARD_DISCLOSURES.find((x) => x.key === key);
    // Resets the wording only. Whether a section is included is a separate decision from how it's
    // worded, and silently switching one back on while restoring the other would be a surprise.
    if (std) setDraft((prev) => prev.map((d) => (d.key === key ? { ...std, included: d.included } : d)));
  }

  return (
    <div>
      <BackHeader title="Info & disclosures" {...backProps(props)} />
      <p className="text-xs text-gray-400 mb-3">The agreements a rider signs before their first lesson. Standard wording is provided — edit any of it to match how you actually run things.</p>

      <Card className="mb-4" tone={includedCount === 0 ? "dashed" : undefined}>
        {includedCount === 0 ? (
          <>
            <p className="text-sm mb-1">Riders aren't asked to sign anything.</p>
            <p className="text-xs text-gray-500">Every section below is set to “Don't include”. Switch any of them on and new riders will read and sign it while creating their profile. Anything already signed stays on record — switching sections off doesn't erase a signature that was given.</p>
          </>
        ) : (
          <>
            <p className="text-sm mb-1">Riders sign {includedCount} of {draft.length} sections.</p>
            <p className="text-xs text-gray-500">
              Each section below is included or not, on its own. Riders read and sign the included ones while creating their profile, and you can change the wording whenever you like — see below for how that reaches riders who already signed.
            </p>
            {!changesIncluded && (
              <p className="text-xs text-red-700 mt-2">
                “{changesSection ? changesSection.title : "These terms can change"}” isn't included, so riders never agree that you can change the terms after they sign. Edits you make from here on may not bind anyone who signed before them — this is the section that makes everything else on this screen safe to edit.
              </p>
            )}
          </>
        )}
      </Card>

      {includedCount > 0 && (
        <>
          <SectionTitle>Where riders stand</SectionTitle>
          <Card className="mb-2" tone={unsigned.length ? "amber" : "green"}>
            <p className="text-sm mb-1">{students.length - unsigned.length} of {students.length} riders have signed.</p>
            {unsigned.length > 0
              ? <p className="text-xs text-amber-700">Not signed: {unsigned.map((st) => st.name.split(" ")[0]).join(", ")} — they keep booked lessons but can't book anything new.</p>
              : <p className="text-xs text-green-700">Everyone has signed.</p>}
          </Card>
          {/* The changes clause is only meaningful if the coach can see it operating. This is that
              view: who has actually acted under the current terms, and who simply hasn't been back
              since they changed. The second group isn't in breach of anything -- they've just not
              booked yet -- so it's stated neutrally rather than as a problem to chase. */}
          {disclosures.updatedAt && (
            <Card className="mb-4">
              <p className="text-xs font-medium mb-1">Since you last changed the terms on {fmtDate(disclosures.updatedAt)}</p>
              <p className="text-xs text-gray-600">{current.length} {current.length === 1 ? "rider has" : "riders have"} booked a lesson since then, which accepts the current terms.</p>
              {notYet.length > 0 && (
                <p className="text-xs text-gray-500 mt-1">{notYet.map((st) => st.name.split(" ")[0]).join(", ")} {notYet.length === 1 ? "hasn't" : "haven't"} booked since. Nothing to chase — their next booking accepts the terms, and they were notified when you published.</p>
              )}
            </Card>
          )}
        </>
      )}

      <SectionTitle>Sections</SectionTitle>
      <div className="space-y-2 mb-3">
        {draft.map((d) => {
          const open = openKey === d.key;
          const std = STANDARD_DISCLOSURES.find((x) => x.key === d.key);
          const edited = std && (std.body !== d.body || std.title !== d.title);
          return (
            <Card key={d.key} tone={changedKeys.includes(d.key) ? "blue" : undefined}>
              <div className="flex justify-between items-start gap-2">
                <div className="flex-1">
                  <p className={`text-sm font-medium ${d.included === false ? "text-gray-400" : ""}`}>{d.title}</p>
                  {!open && <p className="text-xs text-gray-500">{d.body.slice(0, 110)}…</p>}
                  <span className="flex gap-1 mt-1">
                    {d.included === false && <Badge tone="gray">Not included</Badge>}
                    {changedKeys.includes(d.key) && <Badge tone="blue">Unsaved edit</Badge>}
                    {edited && !changedKeys.includes(d.key) && <Badge tone="gray">Customised</Badge>}
                  </span>
                </div>
                <Btn onClick={() => setOpenKey(open ? null : d.key)}>{open ? "Done" : "Edit"}</Btn>
              </div>
              <div className="mt-2">
                <Segmented
                  cols={2}
                  options={[["include", "Include"], ["exclude", "Don't include"]]}
                  value={d.included === false ? "exclude" : "include"}
                  onChange={(v) => patch(d.key, "included", v === "include")}
                />
              </div>
              {/* Excluding the changes section is the one exclusion that costs the coach something
                  she can't see: it's what lets her edit any of the others afterwards. Warned at the
                  moment of the tap rather than only in a summary further up the screen. */}
              {d.key === "changes" && d.included === false && (
                <p className="text-xs text-red-700 mt-2">Without this, a change you make later may not bind riders who already signed. Almost every coach should include it.</p>
              )}
              {open && (
                <div className="mt-2 pt-2 border-t border-gray-100">
                  <Field label="Heading" className="mb-2"><input value={d.title} onChange={(e) => patch(d.key, "title", e.target.value)} className="w-full" /></Field>
                  <Field label="Wording" className="mb-2"><textarea value={d.body} onChange={(e) => patch(d.key, "body", e.target.value)} rows={8} className="w-full text-xs" /></Field>
                  {d.key === "pricing" && (
                    <p className="text-xs text-gray-400 mb-2">Your actual prices are listed under this section automatically and stay current on their own — describe how pricing <em>works</em> here, not what it costs today.</p>
                  )}
                  {d.key === "changes" && (
                    <p className="text-xs text-amber-700 mb-2">This is the section that lets you edit any of the others after riders have signed. Weakening or removing it means a change you make later may not bind anyone who signed before it.</p>
                  )}
                  {edited && <button onClick={() => resetOne(d.key)} className="text-xs text-gray-500 underline">Reset to the standard wording</button>}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {dirty ? (
        <Card tone="blue" className="mb-4">
          <p className="text-sm font-medium mb-1">Save {changedKeys.length === 1 ? "1 change" : `${changedKeys.length} changes`}</p>
          <p className="text-xs text-gray-500 mb-2">Changing: {changedKeys.map((k) => draft.find((d) => d.key === k).title).join(", ")}</p>
          <Field label="What changed" hint="· riders see this line" className="mb-2">
            <input value={updateNote} onChange={(e) => setUpdateNote(e.target.value)} placeholder="e.g. added a note about unpaid balances" className="w-full" />
          </Field>
          <p className="text-xs text-gray-500 mb-2">
            These replace the current terms straight away and apply to every rider, including the ones who signed the old wording. Nobody is asked to sign again — the agreement they signed says the current terms apply and that booking a lesson accepts them. Everyone is notified.
          </p>
          {changedKeys.some((k) => {
            const was = disclosures.sections.find((x) => x.key === k);
            const now = draft.find((d) => d.key === k);
            return was && (was.included !== false) !== (now.included !== false);
          }) && (
            <p className="text-xs text-gray-500 mb-2">This includes turning a section on or off, which changes what riders are agreeing to just as much as rewording it does.</p>
          )}
          <Btn variant="primary" className="w-full" disabled={!updateNote.trim()} onClick={() => { updateDisclosures(draft, updateNote.trim()); setUpdateNote(""); setOpenKey(null); }}>
            Save and notify {students.length} {students.length === 1 ? "rider" : "riders"}
          </Btn>
          {!updateNote.trim() && <p className="text-xs text-gray-500 mt-1">A short note is required — telling riders what changed is one of the terms you're holding them to.</p>}
        </Card>
      ) : (
        <p className="text-xs text-gray-400 mb-4">No unsaved changes.{disclosures.updatedAt ? ` Last updated ${fmtDate(disclosures.updatedAt)} — ${disclosures.updateNote}.` : ""}</p>
      )}

      <SectionTitle>What riders see</SectionTitle>
      <p className="text-xs text-gray-400 mb-2">
        {includedSections(disclosures).length === 0
          ? "Nothing — no sections are included."
          : `The ${includedSections(disclosures).length} included sections, exactly as they appear to riders. Excluded sections don't appear at all.`}
      </p>
      {includedSections(disclosures).length === 0
        ? <Empty>Riders see no agreements.</Empty>
        : <DisclosureText sections={includedSections(disclosures)} lessonTypes={lessonTypes} priceBands={priceBands} trainerConfig={trainerConfig} />}
      <p className="text-xs text-gray-400 mt-3">Riders tick each section and their saved profile stands as their signature. Nothing here is legal advice — have a lawyer read it before you rely on it, particularly the section on changing terms.</p>
    </div>
  );
}


function StudentsList(props) {
  const { students, bookings, horses, recurringBookings, setSelectedStudentId, navTo, trainerConfig, disclosures, disclosureAcceptances } = props;
  const [filter, setFilter] = useState("all");
  const shown = students.filter((s) => (filter === "pending" ? s.profileStatus === "pending_review" : true));
  const pendingCount = students.filter((s) => s.profileStatus === "pending_review").length;
  return (
    <div>
      <BackHeader title="Students" {...backProps(props)} />
      <div className="mb-3"><Segmented cols={2} options={[["all", `All (${students.length})`], ["pending", `Pending review (${pendingCount})`]]} value={filter} onChange={setFilter} /></div>
      <div className="space-y-2">
        {shown.length === 0 && <Empty>No students here.</Empty>}
        {shown.map((s) => {
          const next = bookings.filter((b) => b.studentId === s.id && b.date >= TODAY && !isHiddenFromSchedule(b)).sort((a, b) => a.date - b.date)[0];
          const assignment = next && horseAssignment(next, recurringBookings, horses);
          const subNote = assignment && assignment.isSubstitute ? ` (sub for ${assignment.dominantHorse ? assignment.dominantHorse.name : "?"})` : "";
          return (
            <TapCard key={s.id} tone={assignment && assignment.needsSub ? "red" : undefined} onClick={() => { setSelectedStudentId(s.id); navTo(s.profileStatus === "pending_review" ? "review-profile" : "student-profile"); }}>
              <div className="flex justify-between items-center">
                <p className="text-sm font-medium">{s.name}</p>
                {s.profileStatus === "pending_review" && <Badge tone="amber">Pending review</Badge>}
              </div>
              <p className={`text-xs ${assignment && assignment.needsSub ? "text-red-600 font-medium" : "text-gray-500"}`}>
                {next ? `Next: ${fmtDate(next.date)} ${timeStr(parseTime(next.start))} · ${assignment.horse ? assignment.horse.name : ""}${subNote}${assignment.needsSub ? " · needs substitute" : ""}` : "No upcoming lessons"}
              </p>
            </TapCard>
          );
        })}
      </div>
    </div>
  );
}

function StudentProfileCoach(props) {
  const { selectedStudentId, students, horses, lessonTypes, bookings, recurringBookings, navTo, setSheet, setSelectedBookingId, setStudentFormId, trainerAvailability, timeOffBlocks, trainerConfig, priceBands, logOffer, wasOffered, studentNotes, setStudentNotes, disclosures, disclosureAcceptances } = props;
  const s = students.find((x) => x.id === selectedStudentId);
  if (!s) return <BackHeader title="Pick a student" {...backProps(props)} />;
  const upcoming = rowsWhere(props, (b) => b.studentId === s.id && b.date >= TODAY);
  const myNotes = studentNotes.filter((n) => n.studentId === s.id).slice().reverse();
  const myRecurring = recurringBookings.filter((r) => r.studentId === s.id && r.status === "active");
  const matches = findMatchesForStudent(s, horses, lessonTypes, bookings, students, trainerAvailability, timeOffBlocks);
  return (
    <div>
      <BackHeader title={s.name} {...backProps(props)} right={<Btn onClick={() => { setStudentFormId(s.id); navTo("student-form"); }}>Edit</Btn>} />
      <Card className="mb-4">
        <p className="text-sm mb-1">Age {s.age} · {s.experienceLevel} · {s.ridingStyles.join(", ")} · {s.weight} lbs</p>
        <p className="text-xs text-gray-500">{s.phone}{s.guardianName ? ` · guardian: ${s.guardianName} (${s.guardianRelationship || "guardian"}) ${s.guardianPhone || ""}` : ""}</p>
        <p className="text-xs text-gray-500">Emergency: {s.emergencyContactName ? `${s.emergencyContactName} · ${s.emergencyContactPhone}` : <span className="text-red-600">missing</span>}</p>
        <p className="text-xs text-gray-500 mt-1">Target: {s.targetTimes.map((t) => `${DAY_NAMES[t.day]} ${timeStr(parseTime(t.start))}–${timeStr(parseTime(t.end))}`).join(", ") || "None"}</p>
        <p className="text-xs text-gray-500">Potential: {s.potentialTimes.map((t) => `${DAY_NAMES[t.day]} ${timeStr(parseTime(t.start))}–${timeStr(parseTime(t.end))}`).join(", ") || "None"}</p>
        {trainerConfig.freqTier1MinRides ? (
          <p className="text-xs text-gray-500 mt-1">
            Rate: {s.frequencyTier ? `frequent rider tier ${s.frequencyTier}` : "standard"}
            {s.frequencyTierMonth ? ` · set ${s.frequencyTierMonth}` : ""}
            {" · "}{billableRidesInMonth(s.id, bookings, new Date(TODAY.getFullYear(), TODAY.getMonth() - 1, 1).getFullYear(), (TODAY.getMonth() + 11) % 12)} billable rides last month
          </p>
        ) : null}
        {(() => {
          const d = disclosureStatus(s, disclosures, disclosureAcceptances);
          if (!d.enabled) return null;
          if (d.outstanding) return <p className="text-xs text-amber-700 mt-1">Agreements: not signed — can't book new lessons</p>;
          const currentTerms = hasAcceptedCurrentTerms(s, bookings, disclosures, disclosureAcceptances);
          return (
            <p className="text-xs text-gray-500 mt-1">
              Agreements: signed {fmtDate(d.acceptance.acceptedAt)}
              {disclosures.updatedAt && disclosures.updatedAt > d.acceptance.acceptedAt
                ? currentTerms ? " · has booked since the terms changed" : " · hasn't booked since the terms changed"
                : ""}
            </p>
          );
        })()}
        {!s.recurringUnlocked && <p className="text-xs text-amber-700 mt-1">Recurring & potential lessons not yet unlocked</p>}
      </Card>

      <SectionTitle>Messages from {s.name.split(" ")[0]}</SectionTitle>
      <div className="space-y-1 mb-4">
        {myNotes.length === 0 && <Empty>Nothing sent.</Empty>}
        {myNotes.map((n) => (
          <div key={n.id} className="bg-white border border-gray-200 rounded px-3 py-2">
            <div className="flex justify-between items-start gap-2 mb-1">
              <p className="text-xs text-gray-400">{n.createdAt ? fmtDate(n.createdAt) : "Earlier"} · {NOTE_CATEGORIES[n.category] || n.category}</p>
              {n.status === "open"
                ? <Btn onClick={() => setStudentNotes((prev) => prev.map((x) => (x.id === n.id ? { ...x, status: "resolved" } : x)))}>Mark handled</Btn>
                : <Badge tone="green">Handled</Badge>}
            </div>
            <p className="text-sm">{n.note}</p>
          </div>
        ))}
      </div>

      <SectionTitle>Recurring lessons</SectionTitle>
      <div className="space-y-1 mb-4">
        {myRecurring.length === 0 && <Empty>No standing weekly pattern.</Empty>}
        {myRecurring.map((r) => (
          <div key={r.id} className="flex justify-between text-sm bg-white border border-gray-200 rounded px-3 py-2">
            <span>{DAY_NAMES[r.day]}s, {timeStr(parseTime(r.start))}</span>
            <span className="text-gray-500">{horses.find((h) => h.id === r.horseId).name}</span>
          </div>
        ))}
      </div>

      <SectionTitle>Upcoming lessons</SectionTitle>
      <div className="space-y-1 mb-4">
        {upcoming.length === 0 && <Empty>Nothing booked.</Empty>}
        {upcoming.map((r) => <LessonRow key={r.booking.id} row={r} showDate showStudent={false} onClick={() => { setSelectedBookingId(r.booking.id); navTo("booking-detail"); }} />)}
      </div>

      <SectionTitle>Matched openings · next 7 days</SectionTitle>
      <div className="space-y-2 mb-4">
        {matches.length === 0 && <Empty>Nothing open that fits their windows right now.</Empty>}
        {matches.map((m, i) => {
          const done = wasOffered(s.id, m.date, m.start);
          return (
            <Card key={i} tone="dashed">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-sm font-medium">{fmtDate(m.date)} {timeStr(parseTime(m.start))}</p>
                  <p className="text-xs text-gray-500">{horses.find((h) => h.id === m.horseId).name} · {m.kind === "target" ? "target time" : "potential time · discount candidate"}</p>
                  {(() => {
                    // Same rule as the batch notify sheet: a target match goes out at full price,
                    // a potential one carries the type's gap-fill preset. Offering from here and
                    // from Day view has to price identically, or the two screens tell different
                    // stories about the same slot.
                    const mlt = lessonTypes.find((l) => l.id === m.lessonTypeId);
                    const disc = m.kind === "potential" ? Number(mlt.gapFillDiscount || 0) : 0;
                    const full = priceFor({ student: s, lessonType: mlt, date: m.date, start: m.start, priceBands, trainerConfig });
                    const q = priceFor({ student: s, lessonType: mlt, date: m.date, start: m.start, offerDiscount: disc, priceBands, trainerConfig });
                    return <p className="text-xs text-gray-500">{q.price < full.price ? `$${q.price} instead of the usual $${full.price}` : `$${q.price}`}</p>;
                  })()}
                </div>
                {done ? <Badge tone="green">Offered</Badge> : <Btn onClick={() => {
                  const mlt = lessonTypes.find((l) => l.id === m.lessonTypeId);
                  const disc = m.kind === "potential" ? Number(mlt.gapFillDiscount || 0) : 0;
                  logOffer(s.id, m.date, m.start, m.horseId, m.kind, m.lessonTypeId, null, disc, disc ? "filling a gap" : "");
                }}>Notify</Btn>}
              </div>
            </Card>
          );
        })}
      </div>

      <SectionTitle action={<Btn onClick={() => setSheet({ type: "no-ride", ctx: { studentId: s.id } })}>Edit</Btn>}>No-ride horses</SectionTitle>
      <p className="text-sm mb-4">{s.noRideHorses.length ? s.noRideHorses.map((id) => horses.find((h) => h.id === id).name).join(", ") : "None"}</p>

      <SectionTitle>Rides this year</SectionTitle>
      <RideTally
        rows={ridesByHorse(s.id, bookings)}
        nameOf={(id) => horses.find((h) => h.id === id)?.name}
        unit={["horse", "horses"]}
        empty="No completed lessons yet this year."
        onSelect={(id) => { props.setSelectedHorseId(id); navTo("horse-detail"); }}
      />

      {s.notes && <><SectionTitle>Coach notes</SectionTitle><p className="text-sm">{s.notes}</p></>}
    </div>
  );
}

// Edit only. The coach can correct anything on a profile but can't author one -- see the
// decision in Section 9: the person responsible for the guardian and emergency details is the
// one who has to enter them.
function StudentFormCoach(props) {
  const { studentFormId, students, setStudents, goBack } = props;
  const existing = students.find((s) => s.id === studentFormId);
  const [form, setForm] = useState(existing
    ? { ...existing, age: String(existing.age), weight: String(existing.weight), guardianName: existing.guardianName || "", guardianPhone: existing.guardianPhone || "", guardianRelationship: existing.guardianRelationship || "", emergencyContactName: existing.emergencyContactName || "", emergencyContactPhone: existing.emergencyContactPhone || "" }
    : null);
  const patch = (p) => setForm({ ...form, ...p });
  if (!existing || !form) return <BackHeader title="Pick a student to edit" onBack={goBack} />;
  const gaps = profileGaps(form);
  const valid = form.name && form.phone && gaps.length === 0;
  const isMinor = form.age !== "" && Number(form.age) < 18;
  return (
    <div>
      <BackHeader title={`Edit ${existing.name}`} onBack={goBack} />
      <Field label="Full name" className="mb-3"><input value={form.name} onChange={(e) => patch({ name: e.target.value })} className="w-full" /></Field>
      <Field label="Phone" hint={isMinor ? "· the guardian's number" : ""} className="mb-3"><input value={form.phone} onChange={(e) => patch({ phone: e.target.value })} className="w-full" /></Field>
      <StudentProfileFields value={form} onChange={patch} />
      <TimeWindowEditor label="Target riding times" hint="· full-price openings" windows={form.targetTimes} onChange={(w) => patch({ targetTimes: w })} />
      <TimeWindowEditor label="Potential riding times" hint="· gap-fill / discount candidates" windows={form.potentialTimes} onChange={(w) => patch({ potentialTimes: w })} />
      <Field label="Opportunity notifications" hint="· which openings they hear about" className="mb-4">
        <RadioList
          options={[
            ["target_only", "Target times only", "Full-price openings only"],
            ["target_and_potential", "Target and potential times", "Also gap-fill and discount offers"],
            ["all", "Any open time", "Ignores the windows above"],
          ]}
          value={form.notificationPref}
          onChange={(v) => patch({ notificationPref: v })}
        />
      </Field>
      {gaps.length > 0 && <p className="text-xs text-gray-500 mb-2">Still needed: {gaps.join(", ")}</p>}
      <Btn variant="primary" className="w-full" disabled={!valid} onClick={() => {
        setStudents((prev) => prev.map((s) => (s.id === existing.id ? { ...s, ...form, age: Number(form.age), weight: Number(form.weight) } : s)));
        goBack();
      }}>Save student</Btn>
    </div>
  );
}

function BookingDetail(props) {
  const { selectedBookingId, bookings, students, horses, lessonTypes, recurringBookings, updateBooking, goBack, setSheet, navTo, setSelectedStudentId, setSelectedHorseId, timeOffBlocks, priceBands, notifyStudent } = props;
  const b = bookings.find((x) => x.id === selectedBookingId);
  if (!b) return <BackHeader title="Pick a lesson" {...backProps(props)} />;
  const st = students.find((s) => s.id === b.studentId);
  const horse = horses.find((h) => h.id === b.horseId);
  const lt = lessonTypes.find((l) => l.id === b.lessonTypeId);
  const occType = occurrenceType(b, recurringBookings, lessonTypes);
  const assignment = horseAssignment(b, recurringBookings, horses);
  const [tone, label] = typeBadge(occType);
  const eff = effectiveStatus(b);
  const status = statusInfo(eff);
  const started = minutesUntil(b) <= 0; // no-show only becomes meaningful once the lesson's start time has passed
  const inTimeOff = isDateInTimeOff(b.date, timeOffBlocks) && (b.status === "confirmed" || b.status === "pending");
  return (
    <div>
      <BackHeader title={st.name} {...backProps(props)} right={<Btn onClick={() => { setSelectedStudentId(st.id); navTo("student-profile"); }}>Profile</Btn>} />
      <div className="flex justify-between items-center mb-3">
        <Badge tone={eff === "confirmed" || eff === "pending" ? "green" : status.tone || "gray"}>{status.label || "Confirmed"}</Badge>
        <span className="text-xs text-gray-500 flex items-center gap-1">{fmtDate(b.date)} {DAY_NAMES[b.date.getDay()]} · {timeStr(parseTime(b.start))} <Badge tone={tone}>{label}</Badge></span>
      </div>
      {inTimeOff && <Card tone="red" className="mb-2"><p className="text-sm font-medium text-red-700">This falls inside your time off</p><p className="text-xs text-gray-500">Move it or cancel it — there's no substitute-coach concept.</p></Card>}
      <p className="text-xs text-gray-500 mb-2">{lt.name} · {lt.durationMin} min calendar · {lt.rideTimeMin} min saddle</p>
      {lt.isGroup && (() => {
        const roster = groupRoster(bookings, groupKeyOf(b));
        const spots = (lt.maxGroupSize || 0) - roster.length;
        return (
          <Card tone="blue" className="mb-2">
            <p className="text-sm font-medium text-blue-700">Part of a group session · {roster.length}/{lt.maxGroupSize} riders{spots > 0 ? ` · ${spots} spot${spots === 1 ? "" : "s"} left` : ""}</p>
            <p className="text-xs text-gray-500">{roster.map((r) => students.find((s) => s.id === r.studentId).name).join(", ")} — cancelling here affects only {st.name}, not the session.</p>
          </Card>
        );
      })()}

      <div className="flex justify-between items-start bg-white border border-gray-200 rounded p-2 mb-2 gap-2">
        <button className="text-left" onClick={() => { if (horse) { setSelectedHorseId(horse.id); navTo("horse-detail"); } }}>
          <p className="text-xs text-gray-500">Horse</p>
          <p className="text-sm font-medium">{horse ? horse.name : "?"}</p>
          {assignment.isSubstitute && <Badge tone="amber">Sub for {assignment.dominantHorse ? assignment.dominantHorse.name : "?"}</Badge>}
          {assignment.needsSub && <Badge tone="red">Needs substitute</Badge>}
        </button>
        <div className="flex flex-col gap-1 shrink-0">
          {occType === "recurring" && <Btn onClick={() => setSheet({ type: "dominant-horse", ctx: { bookingId: b.id } })}>Change dominant horse</Btn>}
          <Btn onClick={() => setSheet({ type: "substitute-horse", ctx: { bookingId: b.id } })}>{occType === "recurring" ? "Substitute horse" : "Change horse"}</Btn>
        </div>
      </div>

      <div className="flex justify-between items-center bg-white border border-gray-200 rounded p-2 mb-2">
        <div><p className="text-xs text-gray-500">Time</p><p className="text-sm font-medium">{fmtDate(b.date)} {timeStr(parseTime(b.start))}</p></div>
        <Btn onClick={() => setSheet({ type: "reschedule", ctx: { bookingId: b.id } })}>Move lesson</Btn>
      </div>

      <div className="flex justify-between items-start bg-white border border-gray-200 rounded p-2 mb-2">
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Price <span className="text-gray-400">{b.isBillable ? "· billable" : "· not billable"}</span></p>
          <PriceReceipt breakdown={priceBreakdown(b, { lessonTypes, priceBands })} />
        </div>
        <Btn onClick={() => setSheet({ type: "price", ctx: { bookingId: b.id } })}>Adjust</Btn>
      </div>
      {b.notes && <p className="text-xs text-gray-500 mb-2">Notes: {b.notes}</p>}

      <div className="space-y-2 mt-4">
        <Btn variant="danger" className="w-full" disabled={b.status === "early_cancel"} onClick={() => { updateBooking(b.id, { status: "early_cancel", isBillable: false }); notifyStudent(b.studentId, "lesson_cancelled", `${DAY_NAMES[b.date.getDay()]} ${fmtDate(b.date)} ${timeStr(parseTime(b.start))} · cancelled by your coach, not charged`); }}>Mark early cancel</Btn>
        <Btn variant="danger" className="w-full" disabled={b.status === "late_cancel"} onClick={() => { updateBooking(b.id, { status: "late_cancel", isBillable: true }); notifyStudent(b.studentId, "lesson_cancelled", `${DAY_NAMES[b.date.getDay()]} ${fmtDate(b.date)} ${timeStr(parseTime(b.start))} · cancelled, still charged $${b.price}`); }}>Mark late cancel</Btn>
        <Btn className="w-full" disabled={!started || ["no_show", "early_cancel", "late_cancel"].includes(b.status)} title={!started ? "Available once the lesson's start time has passed" : ""} onClick={() => { updateBooking(b.id, { status: "no_show", isBillable: true }); notifyStudent(b.studentId, "no_show", `${DAY_NAMES[b.date.getDay()]} ${fmtDate(b.date)} ${timeStr(parseTime(b.start))} · charged $${b.price}`); }}>
          Mark no-show{!started ? " · after start time" : ""}
        </Btn>
        <Btn className="w-full" disabled={!["early_cancel", "late_cancel", "no_show"].includes(b.status)} onClick={() => updateBooking(b.id, { status: "confirmed", isBillable: true })}>Reset occurrence (un-cancel)</Btn>
        {b.recurringId && <Btn variant="danger" className="w-full" onClick={() => setSheet({ type: "end-series", ctx: { recurringId: b.recurringId } })}>End recurring series</Btn>}
      </div>
      <p className="text-xs text-gray-400 mt-3">Completion is automatic — a lesson reads as completed once its day has passed, unless it was cancelled or no-showed first.</p>
    </div>
  );
}

function NewBooking(props) {
  const { students, horses, lessonTypes, bookings, setBookings, setRecurringBookings, setCoachScreen, trainerAvailability, timeOffBlocks, trainerConfig, priceBands } = props;
  const [mode, setMode] = useState("one_time");
  const [studentId, setStudentId] = useState(students[0].id);
  const [lessonTypeId, setLessonTypeId] = useState(() => { const d = defaultLessonType(props.lessonTypes); return d ? d.id : ""; });
  const [horseId, setHorseId] = useState(null);
  const [dayOffset, setDayOffset] = useState(0);
  const [day, setDay] = useState(2);
  const [time, setTime] = useState("09:00");
  // An override, not a price field. Adjusting a price is one deliberate act with a reason
  // attached, never a number that can be typed over absently on the way past.
  const [manualAdj, setManualAdj] = useState(0);
  const [overriding, setOverriding] = useState(false);
  const [overrideNote, setOverrideNote] = useState("");

  const student = students.find((s) => s.id === studentId);
  const lt = lessonTypes.find((l) => l.id === lessonTypeId);
  const eligible = getEligibleHorses(student, lt, horses);
  const chosenHorse = eligible.find((h) => h.id === horseId) || eligible[0]; // never keep a horse that stopped being eligible

  let firstDate;
  if (mode === "one_time") firstDate = addDays(TODAY, dayOffset);
  else { firstDate = new Date(TODAY); while (firstDate.getDay() !== day) firstDate = addDays(firstDate, 1); }

  const validation = chosenHorse ? validateBooking({ student, horse: chosenHorse, lessonType: lt, date: firstDate, start: time, bookings, students, lessonTypes, priceBands, trainerConfig, manualAdjustment: manualAdj, availability: trainerAvailability, timeOffBlocks }) : null;
  let recurringConflict = null;
  if (mode === "recurring" && chosenHorse) {
    for (let occ = 1; occ < 4; occ++) {
      const d = addDays(firstDate, occ * 7);
      const v = validateBooking({ student, horse: chosenHorse, lessonType: lt, date: d, start: time, bookings, students, lessonTypes, priceBands, trainerConfig, manualAdjustment: manualAdj, availability: trainerAvailability, timeOffBlocks });
      if (!v.ok) { recurringConflict = `${fmtDate(d)}: ${firstFailure(v)}`; break; }
    }
  }
  // Recomputed live as student, type and time change -- all three are inputs to it, and a band
  // premium appearing the moment the coach picks 4pm is exactly the transparency this is for.
  const quote = priceFor({ student, lessonType: lt, date: firstDate, start: time, manualAdjustment: manualAdj, priceBands, trainerConfig });
  const priceFields = priceFieldsFor({ student, lessonType: lt, date: firstDate, start: time, manualAdjustment: manualAdj, priceBands, trainerConfig });
  const canSubmit = validation && validation.ok && !recurringConflict;

  return (
    <div>
      <BackHeader title="New booking" {...backProps(props)} />
      <div className="mb-3"><Segmented cols={2} options={[["one_time", "One-time"], ["recurring", "Recurring"]]} value={mode} onChange={setMode} /></div>

      <Field label="Student" className="mb-3">
        <select value={studentId} onChange={(e) => { setStudentId(e.target.value); setHorseId(null); }} className="w-full">
          {students.map((s) => <option key={s.id} value={s.id}>{s.name}{s.profileStatus === "pending_review" ? " (pending review)" : ""}</option>)}
        </select>
      </Field>
      <p className="text-xs text-gray-400 mb-3">Only students listed here can be booked. A new student creates their own profile from the student app — send them the link.</p>

      <Field label="Lesson type" className="mb-3">
        <select value={lessonTypeId} onChange={(e) => { setLessonTypeId(e.target.value); setHorseId(null); setPrice(null); }} className="w-full">
          {lessonTypes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>

      <Field label="Horse" hint="· pairing-eligible only" className="mb-3">
        <select value={chosenHorse ? chosenHorse.id : ""} onChange={(e) => setHorseId(e.target.value)} className="w-full">
          {eligible.length === 0 && <option value="">No eligible horse for this student</option>}
          {eligible.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-2 mb-3">
        {mode === "one_time" ? (
          <Field label="Date">
            <select value={dayOffset} onChange={(e) => setDayOffset(Number(e.target.value))} className="w-full">
              {Array.from({ length: 21 }, (_, i) => i).map((i) => {
                const d = addDays(TODAY, i);
                return <option key={i} value={i}>{fmtDate(d)} {DAY_NAMES[d.getDay()]}{relDay(d) ? ` · ${relDay(d)}` : ""}</option>;
              })}
            </select>
          </Field>
        ) : (
          <Field label="Day of week">
            <select value={day} onChange={(e) => setDay(Number(e.target.value))} className="w-full">
              {DAY_ORDER.map((i) => <option key={i} value={i}>{DAY_NAMES[i]}s</option>)}
            </select>
          </Field>
        )}
        <Field label="Start time"><TimeSelect value={time} onChange={setTime} className="w-full" /></Field>
      </div>

      <div className="bg-white border border-gray-200 rounded p-2 mb-3">
        <p className="text-xs text-gray-500 mb-1">Price</p>
        <PriceQuote quote={quote} lessonType={lt} />
        {mode === "recurring" && (
          <p className="text-xs text-gray-400 mt-1">The frequent-rider discount is stamped on each occurrence as it's generated, so this rate follows {student.name.split(" ")[0]}'s tier as it moves — it isn't fixed forever.</p>
        )}
        {!overriding ? (
          <button onClick={() => setOverriding(true)} className="text-xs text-gray-500 underline mt-2">Override this price</button>
        ) : (
          <div className="mt-2">
            <Field label="Charge instead" className="mb-2">
              <input type="number" value={quote.price} onChange={(e) => setManualAdj(manualAdj + (Number(e.target.value) - quote.price))} className="w-full" />
            </Field>
            <Field label="Why" hint="· saved to the lesson's notes" className="mb-2">
              <input value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} placeholder="e.g. moved to make room for a new student" className="w-full" />
            </Field>
            <button onClick={() => { setManualAdj(0); setOverriding(false); setOverrideNote(""); }} className="text-xs text-gray-500 underline">Back to the computed price</button>
          </div>
        )}
      </div>

      {validation ? <div className="mb-3"><ValidationChecklist validation={validation} /></div> : <Card tone="red" className="mb-3"><p className="text-xs text-red-700">No horse is pairing-eligible for this student and lesson type.</p></Card>}
      {mode === "recurring" && chosenHorse && (
        <p className={`text-xs mb-3 ${recurringConflict ? "text-red-700" : "text-green-700"}`}>
          {recurringConflict ? `Next 4 occurrences blocked — ${recurringConflict}` : "Next 4 occurrences all clear"}
        </p>
      )}

      <Btn variant="primary" disabled={!canSubmit} className="w-full" onClick={() => {
        if (mode === "one_time") {
          setBookings((prev) => [...prev, { id: uid("bkg"), createdAt: new Date(TODAY), recurringId: null, studentId, horseId: chosenHorse.id, lessonTypeId, date: firstDate, start: time, status: "confirmed", ...priceFields, isBillable: true, isNewStudent: !bookings.some((b) => b.studentId === studentId), notes: overrideNote }]);
          props.notifyStudent(studentId, "booking_created", `${DAY_NAMES[firstDate.getDay()]} ${fmtDate(firstDate)} ${timeStr(parseTime(time))} with ${chosenHorse.name} · $${priceFields.price}`);
          props.setCoachDate(firstDate);
          setCoachScreen("day");
        } else {
          const rec = { id: uid("rec"), studentId, horseId: chosenHorse.id, lessonTypeId, day, start: time, status: "active", justCreated: false };
          setRecurringBookings((prev) => [...prev, rec]);
          setBookings((prev) => [...prev, ...generateOccurrences(rec, 4).map((date) => {
            const b = bookingFromRecurring(rec, date, lessonTypes, null, { students, priceBands, trainerConfig });
            // A manual override on setup applies to every occurrence generated now, and is
            // carried as manualAdjustment so each row's receipt still adds up.
            return manualAdj ? { ...b, manualAdjustment: manualAdj, price: Math.min(Math.max(b.price + manualAdj, lt.minPrice), lt.maxPrice), notes: overrideNote } : b;
          })]);
          props.notifyStudent(studentId, "recurring_created", `${DAY_NAMES[day]}s ${timeStr(parseTime(time))} with ${chosenHorse.name} · $${priceFields.price} a lesson`);
          props.setSelectedStudentId(studentId);
          setCoachScreen("student-profile");
        }
      }}>{mode === "one_time" ? "Create booking" : "Create recurring lesson"}</Btn>
    </div>
  );
}

function AlertsScreen(props) {
  const { alerts, showOpenSlots, setShowOpenSlots } = props;
  return (
    <div>
      <BackHeader
        title="Alerts"
        {...backProps(props)}
        right={<label className="text-xs text-gray-500 flex items-center gap-1"><input type="checkbox" checked={showOpenSlots} onChange={(e) => setShowOpenSlots(e.target.checked)} />Open slots</label>}
      />
      {[["Today", alerts.today], ["Tomorrow", alerts.tomorrow], ["Week ahead", alerts.week]].map(([label, items]) => (
        <div key={label} className="mb-4">
          <SectionTitle>{label}</SectionTitle>
          <div className="space-y-2">
            {items.length === 0 && <Empty>Nothing needs you here.</Empty>}
            {items.map((a) => <AlertCard key={a.id} item={a} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReviewProfile(props) {
  const { selectedStudentId, students, horses, updateStudent, setSheet, navTo, setSelectedBookingId, bookings } = props;
  const s = students.find((x) => x.id === selectedStudentId);
  // Hooks run before any early return, so the screen can't break when no student is selected.
  const [form, setForm] = useState(s
    ? { age: String(s.age), guardianName: s.guardianName || "", guardianPhone: s.guardianPhone || "", guardianRelationship: s.guardianRelationship || "", emergencyContactName: s.emergencyContactName || "", emergencyContactPhone: s.emergencyContactPhone || "", experienceLevel: s.experienceLevel, ridingStyles: s.ridingStyles, weight: String(s.weight) }
    : { age: "", guardianName: "", guardianPhone: "", guardianRelationship: "", emergencyContactName: "", emergencyContactPhone: "", experienceLevel: "beginner", ridingStyles: [], weight: "" });
  const [notes, setNotes] = useState(s ? s.notes || "" : "");
  if (!s) return <BackHeader title="Pick a student" {...backProps(props)} />;
  const intro = bookings.find((b) => b.studentId === s.id && isIntroBooking(b, lessonTypes));
  const patch = (p) => setForm({ ...form, ...p });
  return (
    <div>
      <BackHeader title={`Review ${s.name}`} {...backProps(props)} right={<Badge tone="amber">Pending review</Badge>} />
      {intro && (
        <div className="flex justify-between items-center bg-blue-50 rounded p-2 mb-3">
          <div>
            <p className="text-xs text-blue-700">Intro lesson</p>
            <p className="text-sm font-medium">{fmtDate(intro.date)} {timeStr(parseTime(intro.start))} · {horses.find((h) => h.id === intro.horseId)?.name}</p>
          </div>
          <Btn onClick={() => { setSelectedBookingId(intro.id); navTo("booking-detail"); }}>View booking</Btn>
        </div>
      )}
      <p className="text-xs text-gray-500 mb-3">{s.phone} · anything they entered can be corrected here before you approve.</p>
      <StudentProfileFields value={form} onChange={patch} />
      <SectionTitle action={<Btn onClick={() => setSheet({ type: "no-ride", ctx: { studentId: s.id } })}>Edit</Btn>}>No-ride horses</SectionTitle>
      <p className="text-sm mb-4">{s.noRideHorses.length ? s.noRideHorses.map((id) => horses.find((h) => h.id === id).name).join(", ") : "None"}</p>
      <Field label="Coach notes" className="mb-3"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full" rows={3} /></Field>
      {profileGaps(form).length > 0 && <p className="text-xs text-gray-500 mb-2">Can't approve yet — still needed: {profileGaps(form).join(", ")}</p>}
      <Btn variant="primary" className="w-full" disabled={profileGaps(form).length > 0} onClick={() => {
        updateStudent(s.id, { ...form, age: Number(form.age), weight: Number(form.weight), notes, profileStatus: "approved" });
        navTo("students");
      }}>Approve profile</Btn>
    </div>
  );
}

// ---------- STUDENT ----------
function weekStart(d) { const r = new Date(d); r.setDate(r.getDate() - ((r.getDay() + 6) % 7)); return r; }

// Twelve lessons in one undifferentiated list is unreadable. Grouping by week gives the
// student the two things they actually scan for -- what's next, and roughly how far out the
// rest sit -- without paginating.
function groupUpcomingByWeek(rows) {
  const thisWeek = weekStart(TODAY);
  const groups = [];
  rows.forEach((b) => {
    const ws = weekStart(b.date);
    const weeksOut = Math.round((ws - thisWeek) / (7 * 86400000));
    const label = weeksOut === 0 ? "This week" : weeksOut === 1 ? "Next week" : `Week of ${fmtDate(ws)}`;
    const existing = groups.find((g) => g.label === label);
    if (existing) existing.rows.push(b);
    else groups.push({ label, rows: [b] });
  });
  return groups;
}

function StudentLessonRow({ booking, horses, lessonTypes, recurringBookings, trainerConfig, priceBands, onCancel }) {
  const status = statusInfo(effectiveStatus(booking));
  const horse = horses.find((h) => h.id === booking.horseId);
  const ltName = lessonTypeName(lessonTypes, booking.lessonTypeId);
  const disposition = cancelDisposition(booking, trainerConfig);
  const rel = relDay(booking.date);
  const [tone, typeLabel] = typeBadge(occurrenceType(booking, recurringBookings, lessonTypes));
  return (
    <div className={`bg-white border border-gray-200 rounded px-3 py-2 ${status.muted ? "opacity-60" : ""}`}>
      <div className="flex justify-between items-start gap-2">
        <div className={status.muted ? "line-through" : ""}>
          <p className="text-sm font-medium">{rel || `${DAY_NAMES[booking.date.getDay()]} ${fmtDate(booking.date)}`} · {timeStr(parseTime(booking.start))}</p>
          <p className="text-xs text-gray-500">{ltName} · {horse ? horse.name : "Horse to be assigned"}</p>
        </div>
        {/* Reads the components stored on the row, not a fresh calculation -- a lesson booked in
            August is quoted at August's rate even if the student's tier moves before they ride
            it, which is the promise the stamped-at-creation rule makes. Collapsed by default so
            a week of lessons still scans as a list; the reasoning is one tap away. A cancelled
            lesson shows whether it's still being charged, which is the thing a student most
            wants to know at exactly that moment. */}
        <span className="flex flex-col items-end gap-1 shrink-0">
          {status.label && <Badge tone={status.tone}>{status.label}</Badge>}
          {booking.isBillable
            ? <PriceReceipt breakdown={priceBreakdown(booking, { lessonTypes, priceBands })} collapsed className="text-right" />
            : <span className="text-xs text-gray-400">Not charged</span>}
          <Badge tone={tone}>{typeLabel}</Badge>
        </span>
      </div>
      {disposition && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <Btn variant={disposition.kind === "late_cancel" ? "danger" : "default"} className="w-full" onClick={() => onCancel(booking, disposition)}>{disposition.label}</Btn>
        </div>
      )}
      {!disposition && !status.muted && <p className="text-xs text-gray-400 mt-2 pt-2 border-t border-gray-100">Too late to cancel here — message your coach.</p>}
    </div>
  );
}

// Owns the cancel confirmation itself, so any tab showing lessons gets the whole interaction
// by rendering one component rather than duplicating the sheet.
function CancellableLessonList({ groups, showGroupLabels = true, horses, lessonTypes, recurringBookings, trainerConfig, priceBands, updateBooking, empty }) {
  const [pendingCancel, setPendingCancel] = useState(null);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (!total) return <div className="mb-4"><Empty>{empty}</Empty></div>;
  return (
    <div className="mb-4">
      {groups.map((g) => (
        <div key={g.label} className="mb-3">
          {showGroupLabels && (
            <div className="flex justify-between items-baseline mb-1">
              <p className="text-xs font-medium text-gray-500">{g.label}</p>
              <p className="text-xs text-gray-400">{g.rows.length} {g.rows.length === 1 ? "lesson" : "lessons"}</p>
            </div>
          )}
          <div className="space-y-1">
            {g.rows.map((b) => (
              <StudentLessonRow
                key={b.id}
                booking={b}
                horses={horses}
                lessonTypes={lessonTypes}
                recurringBookings={recurringBookings}
                trainerConfig={trainerConfig}
                priceBands={priceBands}
                onCancel={(booking, disposition) => setPendingCancel({ booking, disposition })}
              />
            ))}
          </div>
        </div>
      ))}
      {pendingCancel && (() => {
        const { booking, disposition } = pendingCancel;
        const horse = horses.find((h) => h.id === booking.horseId);
        const isRecurring = occurrenceType(booking, recurringBookings, lessonTypes) === "recurring";
        return (
          <Sheet
            title={`Cancel ${DAY_NAMES[booking.date.getDay()]} ${fmtDate(booking.date)}, ${timeStr(parseTime(booking.start))}?`}
            subtitle={`${horse ? horse.name : "Horse to be assigned"} · ${disposition.note}`}
            onClose={() => setPendingCancel(null)}
            closeLabel="Keep this lesson"
          >
            {disposition.billable && (
              <Card tone="amber" className="mb-2">
                <p className="text-sm text-amber-700 mb-1">You'll still be charged ${booking.price} for this lesson.</p>
                {/* The breakdown belongs here more than anywhere: a student about to be charged
                    for a lesson they aren't riding is the likeliest moment for "why that
                    amount?", and answering it before they ask is cheaper than a text. */}
                <PriceReceipt breakdown={priceBreakdown(booking, { lessonTypes, priceBands })} collapsed />
              </Card>
            )}
            {isRecurring && <p className="text-xs text-gray-500 mb-2">This cancels one week only. Your weekly lesson stays in place.</p>}
            <Btn variant="danger" className="w-full" onClick={() => {
              updateBooking(booking.id, { status: disposition.kind, isBillable: disposition.billable });
              setPendingCancel(null);
            }}>{disposition.label}</Btn>
          </Sheet>
        );
      })()}
    </div>
  );
}

function MessageCoach(props) {
  const { studentSession, students, studentNotes, setStudentNotes, setStudentScreen } = props;
  const s = students.find((x) => x.id === studentSession);
  const [note, setNote] = useState("");
  const mine = studentNotes.filter((n) => n.studentId === studentSession).slice().reverse();
  if (!s) return null;
  return (
    <div>
      <BackHeader title="Message your coach" onBack={() => setStudentScreen("home")} />
      <p className="text-xs text-gray-500 mb-3">Anything you send lands on your coach's alerts. It isn't a chat — expect a reply by text or at your next lesson.</p>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={5} className="w-full mb-2" placeholder="Running late Thursday, or asking about a different horse — anything at all." />
      <Btn variant="primary" className="w-full mb-4" disabled={!note.trim()} onClick={() => {
        setStudentNotes((prev) => [...prev, { id: uid("note"), studentId: s.id, category: "message", note: note.trim(), status: "open", createdAt: new Date(TODAY) }]);
        setNote("");
        setStudentScreen("home");
      }}>Send to coach</Btn>

      <SectionTitle>Sent</SectionTitle>
      <div className="space-y-1">
        {mine.length === 0 && <Empty>Nothing sent yet.</Empty>}
        {mine.map((n) => (
          <div key={n.id} className="bg-white border border-gray-200 rounded px-3 py-2">
            <div className="flex justify-between items-start gap-2 mb-1">
              <p className="text-xs text-gray-400">{n.createdAt ? fmtDate(n.createdAt) : "Earlier"} · {NOTE_CATEGORIES[n.category] || n.category}</p>
              <Badge tone={n.status === "open" ? "amber" : "green"}>{n.status === "open" ? "Awaiting coach" : "Handled"}</Badge>
            </div>
            <p className="text-sm">{n.note}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// Past lessons, newest first, grouped by month. Everything that already happened shows up
// here regardless of how it ended -- a no-show and a late cancel are part of the record the
// student is billed against, so hiding them would make the log disagree with their invoice.
function LessonHistory(props) {
  const { studentSession, students, bookings, horses, lessonTypes, recurringBookings, priceBands } = props;
  const [showAll, setShowAll] = useState(false);
  const s = students.find((x) => x.id === studentSession);
  if (!s) return null;
  const past = bookings.filter((b) => b.studentId === s.id && b.date < TODAY).sort((a, b) => b.date - a.date);
  const groups = [];
  past.forEach((b) => {
    const label = `${MONTH_NAMES[b.date.getMonth()]} ${b.date.getFullYear()}`;
    const existing = groups.find((g) => g.label === label);
    if (existing) existing.rows.push(b);
    else groups.push({ label, rows: [b] });
  });
  const ridden = past.filter((b) => effectiveStatus(b) === "completed").length;
  const billed = past.filter((b) => b.isBillable && effectiveStatus(b) !== "completed").length;
  // A year of weekly lessons is 80+ rows. The recent months are what anyone actually opens
  // this for; the rest is reference and can stay one tap away.
  const shown = showAll ? groups : groups.slice(0, 2);
  const hidden = past.length - shown.reduce((n, g) => n + g.rows.length, 0);
  return (
    <div>
      <h2 className="text-lg font-medium mb-3">Past lessons</h2>
      {past.length === 0 ? <Empty>No lessons yet.</Empty> : (
        <>
          <Card className="mb-4">
            <div className="flex justify-between text-sm">
              <span>{ridden} {ridden === 1 ? "lesson ridden" : "lessons ridden"}</span>
              <span className="text-gray-500">{past.length} total</span>
            </div>
            {billed > 0 && <p className="text-xs text-gray-500 mt-1">{billed} charged without riding — no-shows and late cancels.</p>}
          </Card>
          {shown.map((g) => (
            <div key={g.label} className="mb-3">
              <div className="flex justify-between items-baseline mb-1">
                <p className="text-xs font-medium text-gray-500">{g.label}</p>
                <p className="text-xs text-gray-400">{g.rows.length}</p>
              </div>
              <div className="space-y-1">
                {g.rows.map((b) => {
                  const status = statusInfo(effectiveStatus(b));
                  const horse = horses.find((h) => h.id === b.horseId);
                  const lt = lessonTypes.find((l) => l.id === b.lessonTypeId);
                  const [tone, typeLabel] = typeBadge(occurrenceType(b, recurringBookings, lessonTypes));
                  return (
                    <div key={b.id} className="flex justify-between items-start gap-2 bg-white border border-gray-200 rounded px-3 py-2">
                      <div>
                        <p className="text-sm">{DAY_NAMES[b.date.getDay()]} {fmtDate(b.date)} · {timeStr(parseTime(b.start))}</p>
                        <p className="text-xs text-gray-500">{lt.name} · {horse ? horse.name : "No horse recorded"}</p>
                      </div>
                      {/* Reads the STORED components, so a lesson from March explains itself in
                          March's terms however the bands have been re-cut since. */}
                      <span className="flex flex-col items-end gap-1 shrink-0">
                        <Badge tone={effectiveStatus(b) === "completed" ? "green" : status.tone}>{status.label || "Booked"}</Badge>
                        {b.isBillable
                          ? <PriceReceipt breakdown={priceBreakdown(b, { lessonTypes, priceBands })} collapsed className="text-right" />
                          : <span className="text-xs text-gray-400">Not charged</span>}
                        <Badge tone={tone}>{typeLabel}</Badge>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {hidden > 0 && <Btn className="w-full" onClick={() => setShowAll(true)}>Show {hidden} earlier {hidden === 1 ? "lesson" : "lessons"}</Btn>}
        </>
      )}
    </div>
  );
}

const STUDENT_TABS = [["home", "Home"], ["alerts", "Alerts"], ["future", "Future"], ["past", "Past"], ["agreements", "Agreements"], ["profile", "Profile"]];
// Onboarding runs without tabs -- there is nothing to navigate between until an account
// exists, and a tab bar over a signup form invites people to skip required fields.
const STUDENT_ONBOARDING = ["get-started", "create-profile", "profile-saved", "intro-options"];

function StudentAlerts(props) {
  const { studentSession, studentAlerts, markStudentAlertsSeen } = props;
  const rows = visibleStudentAlerts(studentSession, studentAlerts);
  const unseenIds = rows.filter((a) => !a.seen).map((a) => a.id).join(",");
  // Snapshot which were unseen on arrival, so the highlight survives the render that clears
  // the badge -- otherwise opening the tab would blank the very thing it's meant to show.
  const [highlight] = useState(() => new Set(rows.filter((a) => !a.seen).map((a) => a.id)));
  useEffect(() => { if (unseenIds) markStudentAlertsSeen(studentSession); }, [unseenIds, studentSession]);
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <h2 className="text-lg font-medium">Alerts</h2>
        <span className="text-xs text-gray-400">last {STUDENT_ALERT_RETENTION_DAYS} days</span>
      </div>
      <p className="text-xs text-gray-500 mb-3">Changes your coach made. Nothing here needs a reply — it's here so you're not surprised.</p>
      {rows.length === 0 ? <Empty>Nothing new.</Empty> : (
        <div className="space-y-1">
          {rows.map((a) => {
            const kind = STUDENT_ALERT_KINDS[a.kind] || { title: a.kind, tone: "gray" };
            const isNew = highlight.has(a.id);
            return (
              <Card key={a.id} tone={isNew ? kind.tone : undefined} className={isNew ? "" : "opacity-80"}>
                <div className="flex justify-between items-start gap-2 mb-1">
                  <span className="flex items-center gap-2">
                    {isNew && <span className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />}
                    <Badge tone={kind.tone}>{kind.title}</Badge>
                  </span>
                  <span className="text-xs text-gray-400 shrink-0">{relDay(a.createdAt) || fmtDate(a.createdAt)}</span>
                </div>
                <p className="text-sm">{a.detail}</p>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StudentApp(props) {
  const { studentScreen, studentSession, students, endStudentSession, setStudentScreen, studentAlerts } = props;
  const screens = {
    "get-started": GetStarted, "create-profile": CreateProfile, "profile-saved": ProfileSaved, "intro-options": IntroOptions,
    home: StudentHome, alerts: StudentAlerts, future: StudentFuture, past: LessonHistory, agreements: StudentAgreements, profile: StudentProfileView,
    "add-recurring": AddRecurring, "manage-recurring": ManageRecurring, "message-coach": MessageCoach,
  };
  const Screen = screens[studentScreen] || GetStarted;
  const me = students.find((x) => x.id === studentSession);
  const showTabs = me && !STUDENT_ONBOARDING.includes(studentScreen);
  const unseen = me ? visibleStudentAlerts(me.id, studentAlerts).filter((a) => !a.seen).length : 0;
  return (
    <div>
      {me && (
        <div className="flex justify-between items-center text-xs text-gray-400 border-b border-gray-100 pb-2 mb-3">
          <span>Signed in as {me.name}</span>
          <button onClick={endStudentSession} className="underline hover:text-gray-600">Sign out</button>
        </div>
      )}
      {showTabs && (
        <nav className="grid grid-cols-5 gap-1 mb-3">
          {STUDENT_TABS.map(([k, l]) => (
            <button key={k} onClick={() => setStudentScreen(k)} className={`relative text-xs px-2 py-1.5 rounded ${studentScreen === k ? "bg-gray-900 text-white" : k === "alerts" && unseen > 0 ? "bg-blue-100 text-blue-800 font-medium" : "bg-gray-100"}`}>
              {l}{k === "alerts" && unseen > 0 ? ` ${unseen}` : ""}
            </button>
          ))}
        </nav>
      )}
      <Screen {...props} />
    </div>
  );
}

function GetStarted(props) {
  const { loginName, setLoginName, loginPhone, setLoginPhone, students, setStudentSession, setStudentScreen, setDraftProfile, startReturningSession, recurringBookings, bookings } = props;
  const demo = students.find((s) => s.id === DEMO_RETURNING_STUDENT_ID);
  const recCount = recurringBookings.filter((r) => r.studentId === DEMO_RETURNING_STUDENT_ID && r.status === "active").length;
  const upcomingCount = bookings.filter((b) => b.studentId === DEMO_RETURNING_STUDENT_ID && b.date >= TODAY && !isHiddenFromSchedule(b)).length;
  const demoSummary = `${recCount} weekly lesson${recCount === 1 ? "" : "s"} · ${upcomingCount} booked ahead · lands on their home screen`;
  function submit() {
    const match = students.find((s) => s.name.toLowerCase() === loginName.trim().toLowerCase() && s.phone === loginPhone.trim());
    if (match) {
      setStudentSession(match.id);
      setStudentScreen(match.profileStatus === "pending_review" ? "profile-saved" : "home");
    } else {
      setDraftProfile({ name: loginName, phone: loginPhone, age: "", experienceLevel: "beginner", ridingStyles: [], weight: "", targetTimes: [], potentialTimes: [], notificationPref: "target_only", guardianName: "", guardianPhone: loginPhone, guardianRelationship: "", emergencyContactName: "", emergencyContactPhone: "" });
      setStudentScreen("create-profile");
    }
  }
  return (
    <div className="text-center">
      <h2 className="text-lg font-medium mb-1">Welcome</h2>
      <p className="text-xs text-gray-500 mb-4">Enter your name and phone to get started</p>
      <input placeholder="Full name" value={loginName} onChange={(e) => setLoginName(e.target.value)} className="w-full mb-3" />
      <input placeholder="Phone number" value={loginPhone} onChange={(e) => setLoginPhone(e.target.value)} className="w-full mb-4" />
      <Btn variant="primary" className="w-full" disabled={!loginName.trim() || !loginPhone.trim()} onClick={submit}>Continue</Btn>
      <p className="text-xs text-gray-400 mt-3">Any name and phone that doesn't match an account starts the sign-up flow.</p>

      {demo && <div className="border-t border-gray-200 mt-5 pt-4 text-left">
        <p className="text-xs text-gray-400 mb-2">Prototype shortcuts — skip the credential check</p>
        <div className="space-y-2">
          <button onClick={() => startReturningSession(DEMO_RETURNING_STUDENT_ID)} className="w-full text-left bg-white border border-gray-200 rounded px-3 py-2 hover:border-gray-400">
            <p className="text-sm font-medium">{demo.name} · returning student</p>
            <p className="text-xs text-gray-500">{demoSummary}</p>
          </button>
          <button onClick={() => { setLoginName(demo.name); setLoginPhone(demo.phone); }} className="w-full text-left bg-white border border-gray-200 rounded px-3 py-2 hover:border-gray-400">
            <p className="text-sm font-medium">Fill the form instead</p>
            <p className="text-xs text-gray-500">Same account, entered as {demo.name} would · {demo.phone}</p>
          </button>
        </div>
      </div>}
    </div>
  );
}

function CreateProfile(props) {
  const { draftProfile: dp, setDraftProfile, students, setStudents, setStudentSession, setStudentScreen, studentSession, bookings, horses, lessonTypes, priceBands, trainerConfig, disclosures, disclosureAcceptances, acceptDisclosures } = props;
  const [checks, setChecks] = useState({});
  if (!dp) return null;
  const gaps = profileGaps(dp);
  const editing = students.find((s) => s.id === studentSession && s.name === dp.name);
  const patch = (p) => setDraftProfile({ ...dp, ...p });

  // Only shown to a rider creating a profile, and only when the coach collects them. An existing
  // rider editing their details is not re-signing anything -- re-signature has its own screen,
  // reached from Home, so a routine profile edit never turns into a legal step by accident.
  const status = disclosureStatus(editing || null, disclosures, disclosureAcceptances);
  const signing = !editing && status.enabled;
  const sections = signing ? status.sections : [];
  const allChecked = sections.every((d) => checks[d.key]);

  function submit() {
    const payload = { name: dp.name, phone: dp.phone, age: Number(dp.age), guardianName: dp.guardianName, guardianPhone: dp.guardianPhone, guardianRelationship: dp.guardianRelationship, emergencyContactName: dp.emergencyContactName, emergencyContactPhone: dp.emergencyContactPhone, experienceLevel: dp.experienceLevel, ridingStyles: dp.ridingStyles, weight: Number(dp.weight), targetTimes: dp.targetTimes, potentialTimes: dp.potentialTimes, notificationPref: dp.notificationPref };
    if (editing) { setStudents((prev) => prev.map((s) => (s.id === editing.id ? { ...s, ...payload } : s))); setStudentScreen("profile"); return; }
    const id = uid("stu");
    setStudents((prev) => [...prev, { ...payload, id, noRideHorses: [], notes: "", profileStatus: "pending_review", recurringUnlocked: false, active: true, frequencyTier: 0, frequencyTierMonth: null }]);
    // The acceptance is written in the same action as the profile, so the signature and the
    // thing it's attached to can't come apart -- and it records the VERSION, not the text, so it
    // still resolves to the right words after the coach has published three more.
    if (signing) acceptDisclosures(id, dp.name);
    setStudentSession(id);
    setStudentScreen("profile-saved");
  }
  return (
    <div>
      <BackHeader title={editing ? "Edit your profile" : "Create your profile"} onBack={editing ? () => setStudentScreen("profile") : undefined} />
      <p className="text-xs text-gray-500 mb-3">{dp.name} · {dp.phone}</p>
      <StudentProfileFields value={dp} onChange={patch} />
      <TimeWindowEditor label="Target riding times" hint="· when you'd most like to ride" windows={dp.targetTimes} onChange={(w) => patch({ targetTimes: w })} />
      <TimeWindowEditor label="Potential riding times" hint="· times you'd take to fill a gap" windows={dp.potentialTimes} onChange={(w) => patch({ potentialTimes: w })} />
      <Field label="Tell me about potential lesson openings during" className="mb-4">
        <RadioList
          options={[
            ["target_only", "My target times only", "Just the times I'd most like to ride"],
            ["target_and_potential", "My target and potential times", "Including the potential times I listed above"],
            // Not yet wired: both consumers drop a student whose windows don't cover the slot,
            // so this currently behaves the same as target_and_potential.
            ["all", "Any open time", "Even times outside both lists"],
          ]}
          value={dp.notificationPref}
          onChange={(v) => patch({ notificationPref: v })}
        />
      </Field>

      {editing && editing.noRideHorses.length > 0 && (
        <p className="text-xs text-gray-400 mb-4">{editing.noRideHorses.map((id) => horses.find((h) => h.id === id).name).join(", ")} {editing.noRideHorses.length === 1 ? "is" : "are"} on your no-ride list, set by your coach.</p>
      )}

      {signing && (
        <>
          <SectionTitle>Before you ride</SectionTitle>
          <p className="text-xs text-gray-500 mb-2">
            Your coach asks every rider to read and agree to {sections.length === 1 ? "this" : "these"}. Tick each one.
          </p>
          <DisclosureText
            sections={sections}
            lessonTypes={lessonTypes}
            priceBands={priceBands}
            trainerConfig={trainerConfig}
            checks={checks}
            onToggle={(k) => setChecks((prev) => ({ ...prev, [k]: !prev[k] }))}
          />
          <Card tone={allChecked ? "green" : "dashed"} className="mt-2 mb-3">
            <p className="text-xs text-gray-600">
              Saving this profile is your signature. By tapping <em>Create profile</em> you're agreeing to {sections.length === 1 ? "the section" : `all ${sections.length} sections`} above as written today, and the date is kept on record. You can read them again any time on your Agreements tab.
            </p>
            {Number(dp.age) > 0 && Number(dp.age) < 18 && (
              <p className="text-xs text-amber-700 mt-2">This rider is under 18, so a parent or guardian must be the one completing this — the signature is theirs, not the rider's.</p>
            )}
          </Card>
        </>
      )}

      {gaps.length > 0 && <p className="text-xs text-gray-500 mb-2">Still needed: {gaps.join(", ")}</p>}
      {signing && !allChecked && <p className="text-xs text-gray-500 mb-2">Tick {sections.length === 1 ? "the agreement" : `all ${sections.length} agreements`} to continue — {sections.filter((d) => !checks[d.key]).length} left.</p>}
      <Btn variant="primary" className="w-full" disabled={!dp.name || !dp.phone || gaps.length > 0 || (signing && !allChecked)} onClick={submit}>
        {editing ? "Save profile" : "Create profile"}
      </Btn>
    </div>
  );
}

function ProfileSaved(props) {
  const { studentSession, students, setStudentScreen, setIntroOptions, horses, lessonTypes, bookings, trainerAvailability, timeOffBlocks, trainerConfig } = props;
  const s = students.find((x) => x.id === studentSession);
  if (!s) return null;
  return (
    <div className="text-center">
      <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-3"><Check className="text-green-600" /></div>
      <h2 className="text-lg font-medium mb-1">You're all set, {s.name.split(" ")[0]}!</h2>
      <p className="text-xs text-gray-500 mb-4">Your profile is saved. Next time, just come back and enter your name and phone number.</p>
      <Btn variant="primary" className="w-full" onClick={() => { setIntroOptions(findIntroOptions({ ...matchingCtx(props), student: s, limit: 10 })); setStudentScreen("intro-options"); }}>See intro lesson times</Btn>
    </div>
  );
}

function IntroOptions(props) {
  const { introOptions, studentSession, students, horses, lessonTypes, setBookings, setStudentScreen, setStudentNotes } = props;
  const s = students.find((x) => x.id === studentSession);
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const lt = introLessonType(lessonTypes);
  if (showNote) {
    return (
      <div>
        <BackHeader title="None of these work?" onBack={() => setShowNote(false)} />
        <p className="text-xs text-gray-500 mb-3">Tell your coach what would work better, and they'll follow up.</p>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} className="w-full mb-3" rows={4} />
        <Btn variant="primary" className="w-full" disabled={!note.trim()} onClick={() => { setStudentNotes((prev) => [...prev, { id: uid("note"), studentId: s.id, category: "intro_lesson_no_fit", note, status: "open", createdAt: new Date(TODAY) }]); setStudentScreen("home"); }}>Send to coach</Btn>
      </div>
    );
  }
  return (
    <div>
      <BackHeader title="Pick your intro lesson" />
      <p className="text-xs text-gray-500 mb-3">{lt.durationMin} minutes · pick whichever works best</p>
      <div className="space-y-2 mb-3">
        {introOptions.length === 0 && <Empty>No matching times in the windows you gave. Use the button below and your coach will sort it out.</Empty>}
        {introOptions.map((o, i) => (
          <div key={i} className="flex justify-between items-center bg-white border border-gray-200 rounded p-2">
            <div>
              <p className="text-sm font-medium">{fmtDate(o.date)} {DAY_NAMES[o.date.getDay()]}, {timeStr(parseTime(o.start))}</p>
              <p className="text-xs text-gray-500">with {horses.find((h) => h.id === o.horseId).name}</p>
            </div>
            <Btn variant="primary" onClick={() => { setBookings((prev) => [...prev, { id: uid("bkg"), createdAt: new Date(TODAY), recurringId: null, studentId: s.id, horseId: o.horseId, lessonTypeId: lt.id, date: o.date, start: o.start, status: "confirmed", ...priceFieldsFor({ student: s, lessonType: lt, date: o.date, start: o.start, priceBands, trainerConfig }), isBillable: true, isNewStudent: true, notes: "" }]); setStudentScreen("home"); }}>Confirm</Btn>
          </div>
        ))}
      </div>
      <Btn className="w-full" onClick={() => setShowNote(true)}>None of these work for me</Btn>
    </div>
  );
}

function StudentHome(props) {
  const { studentSession, students, bookings, horses, lessonTypes, recurringBookings, setStudentScreen, trainerAvailability, timeOffBlocks, trainerConfig, priceBands, setBookings, updateBooking, studentNotes, studentAlerts, disclosures, disclosureAcceptances } = props;
  const s = students.find((x) => x.id === studentSession);
  if (!s) return null;
  const signing = disclosureStatus(s, disclosures, disclosureAcceptances);
  const openMessages = studentNotes.filter((n) => n.studentId === s.id && n.status === "open").length;
  const unseenAlerts = visibleStudentAlerts(s.id, studentAlerts).filter((a) => !a.seen).length;
  // This calendar week only. Everything past Sunday lives on the Future tab -- the point of
  // the split is that Home answers "what am I doing now", not "what does my autumn look like".
  const thisWeek = bookings
    .filter((b) => b.studentId === s.id && b.date >= TODAY && !isHiddenFromSchedule(b) && sameDay(weekStart(b.date), weekStart(TODAY)))
    .sort((a, b) => a.date - b.date);
  const laterCount = bookings.filter((b) => b.studentId === s.id && b.date >= TODAY && !isHiddenFromSchedule(b) && !sameDay(weekStart(b.date), weekStart(TODAY))).length;
  const matches = s.recurringUnlocked ? findMatchesForStudent(s, horses, lessonTypes, bookings, students, trainerAvailability, timeOffBlocks) : [];
  return (
    <div>
      <h2 className="text-lg font-medium mb-3">Hi {s.name.split(" ")[0]}!</h2>

      {/* Persistent and undismissable while outstanding, but never a lock screen: the rider can
          still see their lessons, cancel one, and message their coach. Stranding someone who
          can't reach a lesson they've already paid for would be a worse outcome than a late
          signature, and it's the coach's interest in new bookings that actually needs the gate. */}
      {/* Only ever shown to a rider who has NEVER signed. A change to the terms no longer produces
          a banner here: the rider is notified through Alerts, and their next booking is what
          accepts it, so there is nothing for them to action on Home. */}
      {signing.outstanding && (
        <Card tone="amber" className="mb-3">
          <p className="text-sm text-amber-700 mb-1">Please sign your agreements</p>
          <p className="text-xs text-gray-600 mb-2">Your coach asks every rider to read and agree to these. Your booked lessons are unaffected — you just can't book anything new until this is done.</p>
          <Btn className="w-full" onClick={() => setStudentScreen("agreements")}>Read and sign</Btn>
        </Card>
      )}

      <Btn variant="primary" className="w-full mb-2" onClick={() => setStudentScreen("message-coach")}>Message your coach</Btn>
      {unseenAlerts > 0 && (
        <Card tone="blue" className="mb-3">
          <div className="flex justify-between items-center gap-2">
            <p className="text-sm text-blue-700">{unseenAlerts === 1 ? "1 change from your coach" : `${unseenAlerts} changes from your coach`}</p>
            <Btn onClick={() => setStudentScreen("alerts")}>View</Btn>
          </div>
        </Card>
      )}
      {openMessages > 0 && (
        <Card tone="amber" className="mb-3">
          <p className="text-sm text-amber-700">{openMessages === 1 ? "Your coach has a message from you" : `Your coach has ${openMessages} messages from you`}</p>
          <p className="text-xs text-gray-500">Waiting on them — they'll follow up by text or at your next lesson.</p>
        </Card>
      )}
      {openMessages === 0 && <div className="mb-4" />}

      <SectionTitle>This week</SectionTitle>
      <CancellableLessonList
        groups={[{ label: "This week", rows: thisWeek }]}
        showGroupLabels={false}
        horses={horses}
        lessonTypes={lessonTypes}
        recurringBookings={recurringBookings}
        trainerConfig={trainerConfig}
        priceBands={priceBands}
        updateBooking={updateBooking}
        empty="Nothing left this week."
      />
      {laterCount > 0 && (
        <Btn className="w-full mb-4" onClick={() => setStudentScreen("future")}>
          {laterCount} more {laterCount === 1 ? "lesson" : "lessons"} coming up
        </Btn>
      )}

      {!s.recurringUnlocked ? (
        <Card tone="dashed" className="mb-4"><p className="text-xs text-gray-500">Open lessons and recurring scheduling unlock once your intro lesson is done and your coach opens them up.</p></Card>
      ) : (
        <>
          <SectionTitle>Open lessons that match you · next 7 days</SectionTitle>
          {signing.outstanding && matches.length > 0 && (
            <p className="text-xs text-amber-700 mb-2">Sign your agreements above to book any of these.</p>
          )}
          {matches.length === 0 ? <p className="text-xs text-gray-400 mb-4">Nothing matching right now.</p> : (
            <div className="space-y-2 mb-4">
              {matches.map((m, i) => (
                <Card tone="dashed" key={i}>
                  <p className="text-sm font-medium">{fmtDate(m.date)}, {timeStr(parseTime(m.start))}</p>
                  <p className="text-xs text-gray-500 mb-1">{horses.find((h) => h.id === m.horseId).name} available · matches your {m.kind} time</p>
                  {(() => {
                    const mlt = lessonTypes.find((l) => l.id === m.lessonTypeId);
                    const q = priceFor({ student: s, lessonType: mlt, date: m.date, start: m.start, priceBands, trainerConfig });
                    return <PriceQuote quote={q} lessonType={mlt} className="mb-2" />;
                  })()}
                  {/* Self-booking never carries a gap-fill discount, deliberately: a discount you
                      can get by waiting isn't an incentive to fill a gap, it's a price cut that
                      teaches everyone to stop booking at full rate. The coach choosing to offer
                      it is the thing being paid for. */}
                  <Btn variant="primary" className="w-full" disabled={signing.outstanding} title={signing.outstanding ? "Sign your agreements first" : ""} onClick={() => setBookings((prev) => [...prev, { id: uid("bkg"), createdAt: new Date(TODAY), recurringId: null, studentId: s.id, horseId: m.horseId, lessonTypeId: m.lessonTypeId, date: m.date, start: m.start, status: "confirmed", ...priceFieldsFor({ student: s, lessonType: lessonTypes.find((l) => l.id === m.lessonTypeId), date: m.date, start: m.start, priceBands, trainerConfig }), isBillable: true, isNewStudent: false, notes: "" }])}>{signing.outstanding ? "Sign first" : "Schedule"}</Btn>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Rolling four weeks rather than four calendar weeks: a student looking ahead on a Saturday
// should still see a month of lessons, not the six days left in the current week plus three.
function StudentFuture(props) {
  const { studentSession, students, bookings, horses, lessonTypes, recurringBookings, setStudentScreen, setRecurringOptions, setSelectedRecurringId, trainerAvailability, timeOffBlocks, trainerConfig, priceBands, updateBooking, disclosures, disclosureAcceptances } = props;
  const s = students.find((x) => x.id === studentSession);
  if (!s) return null;
  const signing = disclosureStatus(s, disclosures, disclosureAcceptances);
  const horizon = addDays(TODAY, 27);
  const upcoming = bookings
    .filter((b) => b.studentId === s.id && b.date >= TODAY && b.date <= horizon && !isHiddenFromSchedule(b))
    .sort((a, b) => a.date - b.date);
  const beyond = bookings.filter((b) => b.studentId === s.id && b.date > horizon && !isHiddenFromSchedule(b)).length;
  const myRecurring = recurringBookings.filter((r) => r.studentId === s.id && r.status === "active");
  return (
    <div>
      <div className="flex justify-between items-baseline mb-3">
        <h2 className="text-lg font-medium">Future lessons</h2>
        <span className="text-xs text-gray-400">through {fmtDate(horizon)}</span>
      </div>
      <CancellableLessonList
        groups={groupUpcomingByWeek(upcoming)}
        horses={horses}
        lessonTypes={lessonTypes}
        recurringBookings={recurringBookings}
        trainerConfig={trainerConfig}
        priceBands={priceBands}
        updateBooking={updateBooking}
        empty="Nothing booked in the next four weeks."
      />
      {beyond > 0 && <p className="text-xs text-gray-400 mb-4">{beyond} more scheduled beyond {fmtDate(horizon)}.</p>}

      {s.recurringUnlocked && (
        <>
          <SectionTitle>Recurring schedule</SectionTitle>
          <p className="text-xs text-gray-500 mb-2">Your standing weekly times. Changing one here affects every future week, not a single lesson.</p>
          <div className="space-y-1 mb-2">
            {myRecurring.length === 0 && <Empty>No weekly lesson yet.</Empty>}
            {myRecurring.map((r) => {
              // A pattern has no price of its own by design, so the rate quoted is the next
              // occurrence it generated. That's the honest answer -- and the one that moves
              // correctly when a tier changes, since each occurrence is stamped as it's created.
              const next = bookings
                .filter((b) => b.recurringId === r.id && b.date >= TODAY && !isHiddenFromSchedule(b))
                .sort((a, b) => a.date - b.date)[0];
              return (
                <div key={r.id} className="flex justify-between items-start gap-2 bg-white border border-gray-200 rounded px-3 py-2 text-sm">
                  <div>
                    <p>{DAY_NAMES[r.day]}s, {timeStr(parseTime(r.start))} · {horses.find((h) => h.id === r.horseId).name}</p>
                    {next && <PriceReceipt breakdown={priceBreakdown(next, { lessonTypes, priceBands })} collapsed note="per lesson" />}
                  </div>
                  <Btn onClick={() => { setSelectedRecurringId(r.id); setStudentScreen("manage-recurring"); }}>Change</Btn>
                </div>
              );
            })}
          </div>
          <Btn className="w-full mb-4" disabled={signing.outstanding} title={signing.outstanding ? "Sign your agreements first" : ""} onClick={() => { setRecurringOptions(findRecurringOptions({ ...matchingCtx(props), student: s, limit: 10 })); setStudentScreen("add-recurring"); }}>
            {signing.outstanding ? "Sign your agreements to add lessons" : "+ Add recurring lesson"}
          </Btn>
        </>
      )}
    </div>
  );
}

// The student-facing half of frequency pricing, and it does two jobs. It states the standing
// discount with its cause and its date, and it states what the NEXT tier needs -- the second
// sentence is the entire reason frequency pricing exists. A discount a student can't see
// themselves approaching rewards volume without encouraging it, which is half the coach's goal
// thrown away for exactly the same money.
function RateBlock({ student, bookings, lessonTypes, trainerConfig }) {
  if (!trainerConfig.freqTier1MinRides) return null; // not configured: the block doesn't exist
  const tier = student.frequencyTier || 0;
  const progress = nextTierProgress(student, bookings, trainerConfig);

  // Quote the discount against the type they actually ride most, not an arbitrary one.
  const mine = bookings.filter((b) => b.studentId === student.id);
  const counts = {};
  mine.forEach((b) => { counts[b.lessonTypeId] = (counts[b.lessonTypeId] || 0) + 1; });
  const topTypeId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const lt = (topTypeId && lessonTypes.find((l) => l.id === topTypeId[0])) || defaultLessonType(lessonTypes);
  if (!lt) return null;
  const current = frequencyDiscountFor(lt, tier);
  const next = progress ? frequencyDiscountFor(lt, progress.nextTier) : 0;

  const monthName = student.frequencyTierMonth
    ? MONTH_NAMES[Number(student.frequencyTierMonth.split("-")[1]) - 1]
    : null;
  const lastMonth = new Date(TODAY.getFullYear(), TODAY.getMonth() - 1, 1);
  const lastMonthRides = billableRidesInMonth(student.id, bookings, lastMonth.getFullYear(), lastMonth.getMonth());

  return (
    <>
      <SectionTitle>Your rate</SectionTitle>
      <Card className="mb-3" tone={current ? "green" : undefined}>
        {current > 0 ? (
          <p className="text-sm mb-1">
            <span className="font-medium">${current} off every lesson</span>
            {monthName ? ` since ${monthName} 1` : ""} — you rode {lastMonthRides} time{lastMonthRides === 1 ? "" : "s"} in {MONTH_NAMES[lastMonth.getMonth()]}.
          </p>
        ) : (
          <p className="text-sm mb-1">You're on the standard rate right now.</p>
        )}

        {progress ? (
          progress.remaining > 0 ? (
            <p className="text-xs text-gray-600">
              {progress.remaining} more ride{progress.remaining === 1 ? "" : "s"} this month and it's ${next} off — you're at {progress.soFar} of {progress.target}.
            </p>
          ) : (
            <p className="text-xs text-green-700">
              You've hit {progress.soFar} rides this month, so ${next} off starts on the 1st.
            </p>
          )
        ) : (
          <p className="text-xs text-gray-600">That's the best rate on offer — there's nothing further to reach for.</p>
        )}

        {/* The reassurance is worth more than the rule is complicated. Without it, a student who
            knows their discount is usage-based reads any light month as a coming price rise. */}
        <p className="text-xs text-gray-400 mt-2">Worked out on the 1st of each month from lessons you were billed for, and held for the whole month. A quiet month won't drop your rate — you keep it for a month either way.</p>
      </Card>
    </>
  );
}

// Read-only, and deliberately shows the version the rider ACTUALLY SIGNED rather than whatever
// is current. That's the whole reason versions are immutable: "what did I agree to" has to be
// answerable in the rider's own terms, not the coach's latest ones. When a newer binding version
// exists, both are reachable and the difference is the point of the screen.
// Read-only, and always shows the CURRENT terms -- there is no "what you signed" archive, because
// the terms the rider agreed to say the current ones apply. What the screen owes them instead is
// honesty about that: when they signed, when the terms last moved, and what their own booking
// since then has already accepted.
function StudentAgreements(props) {
  const { studentSession, students, bookings, lessonTypes, priceBands, trainerConfig, disclosures, disclosureAcceptances, acceptDisclosures } = props;
  const s = students.find((x) => x.id === studentSession);
  const [checks, setChecks] = useState({});
  if (!s) return null;

  const status = disclosureStatus(s, disclosures, disclosureAcceptances);
  const changedSinceSigning = status.acceptance && disclosures.updatedAt && disclosures.updatedAt > status.acceptance.acceptedAt;
  const since = bookingsSinceTermsChanged(s.id, bookings, disclosures);
  // Only the included sections exist as far as a rider is concerned -- an excluded one isn't
  // hidden from them, it isn't part of the terms at all.
  const allChecked = status.sections.every((d) => checks[d.key]);

  if (!status.enabled) {
    return (
      <div>
        <h2 className="text-lg font-medium mb-3">Agreements</h2>
        {status.acceptance
          ? <Card><p className="text-xs text-gray-600">Your coach no longer collects agreements. Your signature from {fmtDate(status.acceptance.acceptedAt)} is kept on record.</p></Card>
          : <Empty>Your coach doesn't collect signed agreements.</Empty>}
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-medium mb-3">Agreements</h2>

      {status.outstanding ? (
        <Card tone="amber" className="mb-3">
          <p className="text-sm text-amber-700 mb-1">Please read and agree to these.</p>
          <p className="text-xs text-gray-600">Your coach asks every rider to sign before booking lessons.</p>
        </Card>
      ) : (
        <Card tone="green" className="mb-3">
          <p className="text-sm text-green-700 mb-1">Signed {fmtDate(status.acceptance.acceptedAt)}</p>
          {changedSinceSigning ? (
            <>
              <p className="text-xs text-gray-600 mb-1">Your coach has updated the terms since then — on {fmtDate(disclosures.updatedAt)}: {disclosures.updateNote}. The current wording is below, and it's the wording that applies.</p>
              {/* States plainly what the rider's own actions have already done, rather than
                  leaving the acceptance mechanic buried in a paragraph they ticked months ago. */}
              <p className="text-xs text-gray-600">
                {since.length > 0
                  ? `You've booked ${since.length === 1 ? "a lesson" : `${since.length} lessons`} since then, which accepts the updated terms.`
                  : "Booking your next lesson will accept the updated terms. If you'd rather not, don't book — and talk to your coach."}
              </p>
            </>
          ) : (
            <p className="text-xs text-gray-500">Nothing has changed since you signed.</p>
          )}
        </Card>
      )}

      <p className="text-xs text-gray-400 mb-2">
        {disclosures.updatedAt ? `Current terms · last updated ${fmtDate(disclosures.updatedAt)}.` : "Current terms."} These can change; your coach will let you know when they do.
      </p>

      <DisclosureText
        sections={status.sections}
        lessonTypes={lessonTypes}
        priceBands={priceBands}
        trainerConfig={trainerConfig}
        checks={status.outstanding ? checks : undefined}
        onToggle={status.outstanding ? ((k) => setChecks((prev) => ({ ...prev, [k]: !prev[k] }))) : undefined}
      />

      {status.outstanding && (
        <>
          <Card tone={allChecked ? "green" : "dashed"} className="mt-2 mb-2">
            <p className="text-xs text-gray-600">Tapping <em>Agree</em> records your signature, dated today.</p>
          </Card>
          {!allChecked && <p className="text-xs text-gray-500 mb-2">{status.sections.filter((d) => !checks[d.key]).length} still to tick.</p>}
          <Btn variant="primary" className="w-full" disabled={!allChecked} onClick={() => { acceptDisclosures(s.id, s.name); setChecks({}); }}>Agree</Btn>
        </>
      )}
    </div>
  );
}


function StudentProfileView(props) {
  const { studentSession, students, bookings, horses, lessonTypes, trainerConfig, setStudentScreen, setDraftProfile } = props;
  const s = students.find((x) => x.id === studentSession);
  if (!s) return null;
  return (
    <div>
      <h2 className="text-lg font-medium mb-3">{s.name}</h2>

      <RateBlock student={s} bookings={bookings} lessonTypes={lessonTypes} trainerConfig={trainerConfig} />

      <SectionTitle>Rides this year</SectionTitle>
      <RideTally
        rows={ridesByHorse(s.id, bookings)}
        nameOf={(id) => horses.find((h) => h.id === id)?.name}
        unit={["horse", "horses"]}
        empty="No completed lessons yet this year."
      />

      <SectionTitle>Your details</SectionTitle>
      <Card className="mb-3">
        <p className="text-sm mb-1">Age {s.age} · {s.experienceLevel}</p>
        <p className="text-sm text-gray-500 mb-1">{s.ridingStyles.join(", ")}</p>
        <p className="text-sm mb-1">Target: <span className="text-gray-500">{s.targetTimes.map(fmtWindow).join(" · ") || "None"}</span></p>
        <p className="text-sm mb-2">Potential: <span className="text-gray-500">{s.potentialTimes.map(fmtWindow).join(" · ") || "None"}</span></p>
        <p className="text-xs text-gray-500">No-ride horses</p>
        <p className="text-sm text-gray-400">{s.noRideHorses.length ? s.noRideHorses.map((id) => horses.find((h) => h.id === id).name).join(", ") : "None"} · set by your coach</p>
      </Card>
      <Btn className="w-full" onClick={() => { setDraftProfile(draftFromStudent(s)); setStudentScreen("create-profile"); }}>Edit profile</Btn>
    </div>
  );
}

function AddRecurring(props) {
  const { priceBands, trainerConfig } = props;
  const { recurringOptions, studentSession, students, horses, setRecurringBookings, setBookings, lessonTypes, setStudentNotes, setStudentScreen, selectedRecurringIdx, setSelectedRecurringIdx, setDraftProfile } = props;
  const s = students.find((x) => x.id === studentSession);
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState("");
  function toggle(i) { setSelectedRecurringIdx((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : prev.length < 2 ? [...prev, i] : prev)); }
  if (showNote) {
    return (
      <div>
        <BackHeader title="None of these work?" onBack={() => setShowNote(false)} />
        <p className="text-xs text-gray-500 mb-3">Tell your coach what would work better, and they'll follow up.</p>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} className="w-full mb-3" rows={4} />
        <Btn variant="primary" className="w-full" disabled={!note.trim()} onClick={() => { setStudentNotes((prev) => [...prev, { id: uid("note"), studentId: s.id, category: "recurring_lesson_no_fit", note, status: "open", createdAt: new Date(TODAY) }]); setStudentScreen("future"); }}>Send to coach</Btn>
      </div>
    );
  }
  return (
    <div>
      <BackHeader title="Add recurring lesson" onBack={() => setStudentScreen("future")} />

      <Card className="mb-3">
        <p className="text-sm font-medium mb-1">Filtered to your riding times</p>
        <p className="text-xs text-gray-500 mb-2">These are the only times below. Nothing outside them is shown, even if your coach has the slot open.</p>
        <div className="space-y-1 mb-2">
          <div className="flex gap-2 items-start">
            <span className="shrink-0"><Badge tone="blue">Target</Badge></span>
            <span className="text-xs text-gray-600">{s.targetTimes.length ? s.targetTimes.map(fmtWindow).join(" · ") : "None set"}</span>
          </div>
          <div className="flex gap-2 items-start">
            <span className="shrink-0"><Badge tone="gray">Potential</Badge></span>
            <span className="text-xs text-gray-600">{s.potentialTimes.length ? s.potentialTimes.map(fmtWindow).join(" · ") : "None set"}</span>
          </div>
        </div>
        <p className="text-xs text-gray-400 mb-2">A time only appears if it's free every week for the next four weeks.</p>
        <Btn onClick={() => { setDraftProfile(draftFromStudent(s)); setStudentScreen("create-profile"); }}>Edit my riding times</Btn>
      </Card>

      <p className="text-xs text-gray-500 mb-1">Pick 1 or 2 weekly times that work for you</p>
      <p className="text-xs text-blue-600 font-medium mb-3">Selected: {selectedRecurringIdx.length} of 2</p>
      <div className="space-y-2 mb-3">
        {recurringOptions.length === 0 && (
          <Card tone="dashed">
            <p className="text-sm mb-1">Nothing open in your riding times</p>
            <p className="text-xs text-gray-500">No slot inside those windows is free all four of the next four weeks. Widening your riding times, or the button below, are both ways forward.</p>
          </Card>
        )}
        {recurringOptions.map((o, i) => (
          <button key={i} onClick={() => toggle(i)} className={`w-full flex justify-between items-center px-3 py-2 rounded border text-sm ${selectedRecurringIdx.includes(i) ? "bg-blue-50 border-blue-300" : "bg-white border-gray-200"}`}>
            <div className="text-left">
              <div className="flex items-center gap-2">
                <p className="font-medium">{DAY_NAMES[o.day]}s, {timeStr(parseTime(o.start))}</p>
                <Badge tone={o.kind === "target" ? "blue" : "gray"}>{o.kind === "target" ? "Target" : "Potential"}</Badge>
              </div>
              <p className="text-xs text-gray-500">with {horses.find((h) => h.id === o.horseId).name}</p>
              {(() => {
                const lt = defaultLessonType(lessonTypes);
                const firstDate = (() => { let d = new Date(TODAY); while (d.getDay() !== o.day) d = addDays(d, 1); return d; })();
                const q = priceFor({ student: s, lessonType: lt, date: firstDate, start: o.start, priceBands, trainerConfig });
                const parts = [];
                if (q.bandAdjustment) parts.push(`${q.band.name.toLowerCase()} ${q.bandAdjustment > 0 ? "+" : "−"}$${Math.abs(q.bandAdjustment)}`);
                if (q.frequencyDiscount) parts.push(`frequent rider −$${q.frequencyDiscount}`);
                return <p className="text-xs text-gray-500">${q.price} a lesson{parts.length ? ` · ${parts.join(", ")}` : ""}</p>;
              })()}
            </div>
            {selectedRecurringIdx.includes(i) ? <CheckSquare size={18} className="text-blue-600" /> : <Square size={18} className="text-gray-400" />}
          </button>
        ))}
      </div>
      <Btn variant="primary" className="w-full mb-2" disabled={selectedRecurringIdx.length === 0} onClick={() => {
        selectedRecurringIdx.forEach((i) => {
          const o = recurringOptions[i];
          const rec = { id: uid("rec"), studentId: s.id, horseId: o.horseId, lessonTypeId: (defaultLessonType(lessonTypes) || {}).id, day: o.day, start: o.start, status: "active", justCreated: true };
          setRecurringBookings((prev) => [...prev, rec]);
          setBookings((prev) => [...prev, ...generateOccurrences(rec, 4).map((date) => bookingFromRecurring(rec, date, lessonTypes, null, { students, priceBands, trainerConfig }))]);
        });
        setSelectedRecurringIdx([]); setStudentScreen("future");
      }}>Confirm selected</Btn>
      <Btn className="w-full" onClick={() => setShowNote(true)}>None of these work for me</Btn>
    </div>
  );
}

function ManageRecurring(props) {
  const { recurringBookings, horses, students, endRecurringSeries, setStudentScreen, studentSession, selectedRecurringId, setSheet } = props;
  const s = students.find((x) => x.id === studentSession);
  const r = recurringBookings.find((x) => x.id === selectedRecurringId && x.status === "active") || recurringBookings.find((x) => x.studentId === s.id && x.status === "active");
  if (!r) return <BackHeader title="No recurring lesson" onBack={() => setStudentScreen("future")} />;
  return (
    <div>
      <BackHeader title={`${DAY_NAMES[r.day]}s, ${timeStr(parseTime(r.start))}`} onBack={() => setStudentScreen("future")} />
      <p className="text-xs text-gray-500 mb-4">with {horses.find((h) => h.id === r.horseId).name}</p>
      <div className="space-y-2">
        <Btn className="w-full" onClick={() => setSheet({ type: "recurring-slot", ctx: { recurringId: r.id, mode: "horse" } })}>Change horse</Btn>
        <Btn className="w-full" onClick={() => setSheet({ type: "recurring-slot", ctx: { recurringId: r.id, mode: "slot" } })}>Change day / time</Btn>
        <Btn variant="danger" className="w-full" onClick={() => { endRecurringSeries(r.id); setStudentScreen("future"); }}>End this recurring lesson</Btn>
      </div>
    </div>
  );
}


// ---------- the app root ----------

/**
 * Turn the date strings JSON gave us back into Dates.
 *
 * `db/repo/to-engine.js` already does this once, converting a `date` column into a Date at
 * local midnight because the engine calls `.getDay()` on it. JSON then undoes that work —
 * it has no date type, so every Date is serialised to an ISO string and arrives as one. The
 * engine's `sameDay()` calls `a.getFullYear()`, which on a string throws rather than returning
 * something wrong, which is the one mercy here.
 *
 * Parsed from the Y-M-D parts rather than with `new Date(string)`: the server sends
 * "2026-09-15T07:00:00.000Z" for a lesson that is on the 15th LOCALLY, and letting the browser
 * parse that in a timezone west of the server would land it on the 14th. Taking the date parts
 * out of the ISO string and rebuilding at local midnight keeps the day the coach sees the day
 * the coach booked.
 */
const reviveDate = (value) => {
  if (value == null || value instanceof Date) return value ?? null;
  const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
};

const reviveEach = (rows, ...fields) =>
  (rows ?? []).map((row) => {
    const out = { ...row };
    for (const f of fields) if (f in out) out[f] = reviveDate(out[f]);
    return out;
  });

function reviveBarn(data) {
  return {
    ...data,
    bookings: reviveEach(data.bookings, "date"),
    trainerBookings: reviveEach(data.trainerBookings, "date"),
    offers: reviveEach(data.offers, "date"),
    timeOffBlocks: reviveEach(data.timeOffBlocks, "startDate", "endDate"),
    recurring: reviveEach(data.recurring, "startDate", "endDate"),
    // Alerts and notes are an append-only log, and the screens sort and expire them by when
    // they were written — so createdAt has to be a Date here too, not the ISO string JSON left.
    alerts: reviveEach(data.alerts, "createdAt"),
    notes: reviveEach(data.notes, "createdAt"),
  };
}


// Loads the barn once, then hands it to the screens.
//
// One fetch rather than one per collection: the screens keep the whole barn in memory, which is
// how they were built, and splitting the load would mean inventing a loading state per
// collection for no benefit at this scale.
//
// `?date=` is what the server builds engine inputs around. It is the simulated clock the
// prototype used, kept for now so the seeded fixture's dates line up — a real deployment passes
// today. That is the last piece of prototype-only behaviour left in the data path, and it is
// here rather than buried in a component so it is obvious what to delete.
export default function App() {
  const [state, setState] = React.useState({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/bootstrap?date=${SIMULATED_TODAY_ISO}`);
        if (!res.ok) throw new Error(`the API answered ${res.status}`);
        const data = reviveBarn(await res.json());
        if (!cancelled) setState({ status: "ready", data });
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (state.status === "loading") {
    return <div className="p-6 text-sm text-gray-500">Loading the barn…</div>;
  }

  if (state.status === "error") {
    return (
      <div className="p-6 space-y-3">
        <p className="text-sm font-medium text-red-700">Could not reach the API.</p>
        <p className="text-xs text-gray-600">{state.message}</p>
        <p className="text-xs text-gray-500">
          The server needs <code>APP_DATABASE_URL</code> set. From <code>server/</code>:
          <br />
          <code>APP_DATABASE_URL="$TEST_DATABASE_URL" npm run dev</code>
        </p>
      </div>
    );
  }

  return <Screens initial={state.data} />;
}
