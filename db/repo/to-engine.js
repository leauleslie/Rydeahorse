// The mapping layer. Database rows in, engine inputs out.
//
// `engine/` uses camelCase and its own vocabulary; the Sheets-derived schema uses snake_case
// and Section 8's. CLAUDE.md puts the translation in the repository and nowhere else, and this
// is that translation. Deliberately pure — it takes rows and returns plain objects, so it can
// be tested without a database and so the engine stays unable to query.
//
// Do NOT "simplify" this by renaming engine fields to match columns. The engine's input shape
// is the contract the prototype already speaks, and keeping it is what lets the same functions
// run unchanged in the browser, where there is no database to match.
//
// The gaps this closes are not only naming. Four of them would each be a runtime failure:
//
//   1. `date` arrives from drizzle as the STRING "2026-09-15". The engine calls
//      `date.getDay()` and compares dates with `>=`, so it needs a real Date. A string
//      silently produces NaN from getDay() rather than throwing.
//   2. `time` arrives as "09:00:00". The engine's fixtures are "HH:MM", and while parseTime
//      tolerates the seconds, string equality elsewhere would not.
//   3. `day_of_week` is the enum 'tue'. The engine matches it against `date.getDay()`, which
//      is 0=Sunday..6=Saturday. Nothing converts between them.
//   4. `noRideHorses`, `restrictedHorseIds` and `bandAdjustments` are junction TABLES here and
//      inline arrays/objects there. The engine reads `student.noRideHorses.includes(...)`,
//      which throws on undefined rather than quietly passing.

// Postgres day_of_week enum -> the index Date#getDay() returns.
const DOW_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * A `date` column -> a Date at LOCAL midnight.
 *
 * Local, not UTC, and deliberately: no column in this schema is stored in UTC. A lesson
 * belongs to exactly one trainer, so its local date is unambiguous, and the engine's
 * `date.getDay()` and `sameDay()` both read local components. Building this with
 * `new Date("2026-09-15")` instead would parse as UTC midnight and land on the PREVIOUS day
 * for every timezone west of Greenwich — the kind of bug that only shows up in production, and
 * only for evening lessons.
 */
export function toDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const [y, m, d] = String(value).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** A `time` column ("09:00:00") -> "09:00". */
export function toHHMM(value) {
  if (value == null) return null;
  const [h, m] = String(value).split(":");
  return `${h}:${m}`;
}

export function toEngineHorse(row) {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    minExp: row.minExperienceLevel,
    adultOnly: row.adultOnly,
    styles: row.ridingStyles ?? [],
    // Null means "this horse carries no stated weight limit", and the engine compares
    // `student.weight > h.maxWeight` — which is false for Infinity, i.e. no limit. Mapping
    // null to 0 here would silently ban every rider from an unrestricted horse.
    maxWeight: row.maxRiderWeightLbs ?? Infinity,
    restDaysPerWeek: row.restDaysPerWeek,
    // Same reasoning: null is "no cap of that kind", not "a cap of zero minutes".
    maxDailyAdult: row.maxDailyMinutesAdult ?? Infinity,
    maxDailyOverall: row.maxDailyMinutesOverall ?? Infinity,
  };
}

/** @param noRideHorseIds ids from `student_no_ride_horses` for THIS student */
export function toEngineStudent(
  row,
  { noRideHorseIds = [], ridingWindows = { target: [], potential: [] } } = {},
) {
  return {
    id: row.id,
    name: row.name,
    age: row.age,
    experienceLevel: row.experienceLevel,
    ridingStyles: row.ridingStyles ?? [],
    // The engine compares `student.weight > h.maxWeight`. Null weight against a horse with no
    // limit must pass, so an unstated weight is 0 rather than Infinity — the reverse of the
    // horse's cap, because the comparison points the other way.
    weight: row.weight ?? 0,
    noRideHorses: noRideHorseIds,
    frequencyTier: row.frequencyTier ?? 0,

    // ---- the profile the coach reviews ----
    //
    // The rules never read any of these; the REVIEW SCREEN does, and without them it cannot be
    // satisfied. `profileGaps` refuses to enable "Approve profile" until an emergency contact
    // is present and, for a minor, a guardian — so leaving them out of this mapping made every
    // profile permanently unapprovable, including the ones that had the fields filled in all
    // along. Not a rules gap, which is why it survived a rules-shaped reading of this file.
    phone: row.phone,
    email: row.email,
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    guardianName: row.guardianName,
    guardianPhone: row.guardianPhone,
    guardianRelationship: row.guardianRelationship,
    notes: row.notes,
    // The screens' shorter name for `recurring_potential_unlocked`; `fromEngineStudentPatch`
    // maps it back on the way in.
    recurringUnlocked: row.recurringPotentialUnlocked ?? false,

    // ---- read by matching only; the rules ignore all of these ----
    // Offering a time nobody asked for is noise, so matching needs to know what they asked for.
    active: row.active,
    profileStatus: row.profileStatus,
    // `notification_preference` -> `notificationPref`. The value `all` is specified but behaves
    // as `target_and_potential` today, and this mapping does not paper over that — both
    // consumers drop a student whose windows miss the slot before the preference is read.
    notificationPref: row.notificationPreference,
    targetTimes: ridingWindows.target,
    potentialTimes: ridingWindows.potential,
  };
}

/**
 * @param bandAdjustments   { [bandId]: amount } from `lesson_type_band_adjustments`
 * @param restrictedHorseIds ids from `lesson_type_restricted_horses`
 */
export function toEngineLessonType(row, { bandAdjustments = {}, restrictedHorseIds = [] } = {}) {
  return {
    id: row.id,
    name: row.name,
    durationMin: row.durationMin,
    rideTimeMin: row.rideTimeMin,
    basePrice: row.basePrice,
    minPrice: row.minPrice,
    maxPrice: row.maxPrice,
    bandAdjustments,
    // Two columns, two engine fields — the engine picks by tier (`freqDiscount2` for tier 2).
    // Null is no discount configured, which is 0, not "skip the subtraction".
    freqDiscount1: row.frequencyDiscount1 ?? 0,
    freqDiscount2: row.frequencyDiscount2 ?? 0,
    restrictedHorseIds,
    ridingStyles: row.ridingStyles ?? [],
    isGroup: row.isGroup,
    maxGroupSize: row.maxGroupSize,
    // Whether the coach offers this type as gap-fill. A group type can never qualify, and the
    // schema forces the flag off for one — so matching's own check is belt and braces.
    potentialEligible: row.potentialLessonEligible,
    // A role is a flag, never an id. Carried through so nothing downstream is tempted to
    // compare against a generated uuid to decide what an intro lesson is.
    isIntro: row.isIntro,
  };
}

export function toEngineBooking(row) {
  return {
    id: row.id,
    // The series this lesson belongs to, or null if it was booked on its own.
    //
    // Not cosmetic, and not only a label: `derive.js` reads it for `occurrenceType` (absent
    // means "adhoc"), for `isRecurringOccurrence`, and for resolving which horse a standing
    // slot should use. Dropping it here made every lesson in the database read as ad hoc and
    // every recurring-series screen read as empty, with nothing anywhere throwing.
    //
    // It went unnoticed because no booking in `db/test/seed.js` has a `recurring_id` — the
    // tenancy fixture has no reason to — so the only value this mapping was ever exercised
    // with was the one that cannot tell a dropped field from a null one.
    recurringId: row.recurringId ?? null,
    studentId: row.studentId,
    horseId: row.horseId,
    lessonTypeId: row.lessonTypeId,
    date: toDate(row.date),
    start: toHHMM(row.startTime),
    // The stored end, not a duration to be re-derived. Matching reads this to decide whether a
    // horse or a coach is busy across a candidate slot, and on a horse shared between two
    // trainers the barn-mate's lesson type is not readable — so reconstructing the end from it
    // would guess. `bookings.end_time` exists precisely so it does not have to.
    end: toHHMM(row.endTime),
    status: row.status,
    isBillable: row.isBillable,

    // The stored receipt, carried whole.
    //
    // A price is the one thing in this schema that is deliberately NOT derived: a lesson priced
    // in March against March's bands must still read as $65 in September, so the five components
    // and the total are stamped at creation and never recomputed. Sending only the total — or,
    // as this did until now, none of it — leaves every screen that shows a price unable to show
    // the reasoning behind it, which CLAUDE.md makes a product constraint rather than a nicety.
    // The coach saw a bare "$" where the receipt should be.
    //
    // Zero is a real value here and `?? 0` is right: the columns are NOT NULL with a 0 default,
    // so an absent adjustment means no adjustment, not an unknown one.
    basePrice: row.basePrice,
    bandAdjustment: row.bandAdjustment ?? 0,
    frequencyDiscount: row.frequencyDiscount ?? 0,
    offerDiscount: row.offerDiscount ?? 0,
    manualAdjustment: row.manualAdjustment ?? 0,
    price: row.price,
  };
}

/** Offers, as `offerStats` and `eligibleStudentsForSlot` read them. */
export function toEngineOffer(row) {
  return {
    id: row.id,
    studentId: row.studentId,
    date: toDate(row.date),
    start: toHHMM(row.startTime),
    kind: row.kind,
    offerDiscount: row.offerDiscount,
  };
}

/**
 * A recurring pattern, in the shape the screens speak: a weekday INDEX and an "HH:MM", not the
 * `'tue'` / `'09:00:00'` the column holds. Same translation the availability mapping does, for
 * the same reason — `day` is compared against `Date#getDay()`.
 */
export function toEngineRecurring(row) {
  return {
    id: row.id,
    studentId: row.studentId,
    horseId: row.horseId,
    lessonTypeId: row.lessonTypeId,
    day: DOW_INDEX[row.dayOfWeek],
    start: toHHMM(row.startTime),
    status: row.status,
    startDate: toDate(row.startDate),
    endDate: toDate(row.endDate),
    notes: row.notes,
  };
}

/** `student_riding_windows` rows -> the engine's `{ day, start, end }`, split by kind. */
export function toEngineRidingWindows(rows) {
  const target = [];
  const potential = [];
  for (const r of rows) {
    const w = { day: DOW_INDEX[r.dayOfWeek], start: toHHMM(r.startTime), end: toHHMM(r.endTime) };
    (r.kind === "target" ? target : potential).push(w);
  }
  return { target, potential };
}

export function toEngineAvailability(rows) {
  return rows.map((r) => ({
    day: DOW_INDEX[r.dayOfWeek],
    start: toHHMM(r.startTime),
    end: toHHMM(r.endTime),
  }));
}

export function toEngineTimeOff(rows) {
  return rows.map((r) => ({
    startDate: toDate(r.startDate),
    endDate: toDate(r.endDate),
    reason: r.reason,
  }));
}

/**
 * `price_bands` + `price_band_windows` -> the engine's flat band list.
 *
 * The engine's band is `{ id, name, days: [...], start, end }` — ONE time range covering
 * several days. The schema allows a band whose windows differ in time from day to day, which
 * that shape cannot express. So windows are grouped by (band, start, end) and a band with two
 * distinct time ranges becomes two entries SHARING ITS ID.
 *
 * Sharing the id is correct rather than a workaround: `bandAdjustments` is keyed by band id,
 * so both entries resolve to the same premium, which is what "one named band" means. The
 * alternative — collapsing to one entry and picking a time — would silently misprice every day
 * whose window was discarded.
 */
export function toEnginePriceBands(bands, windows) {
  const byId = new Map(bands.map((b) => [b.id, b]));
  const groups = new Map();
  for (const w of windows) {
    const band = byId.get(w.bandId);
    if (!band) continue; // a window whose band is gone prices nothing
    const start = toHHMM(w.startTime);
    const end = toHHMM(w.endTime);
    const key = `${w.bandId}|${start}|${end}`;
    if (!groups.has(key)) {
      groups.set(key, { id: band.id, name: band.name, days: [], start, end });
    }
    groups.get(key).days.push(DOW_INDEX[w.dayOfWeek]);
  }
  return [...groups.values()];
}

export function toEngineTrainerConfig(row) {
  return {
    minBufferMin: row.minBufferMin,
    maxBufferMin: row.maxBufferMin,
    maxBackToBack: row.maxBackToBack,
    schedulingPreference: row.schedulingPreference,
    lateCancelHours: row.lateCancelHours,
    // Blank switches frequency pricing off entirely, which is how it ships — the tiers are
    // computed from completed calendar months and on day one there aren't any. Null must stay
    // null here; mapping it to 0 would turn "off" into "everyone qualifies for tier 1".
    freqTier1MinRides: row.frequencyTier1MinRides,
    freqTier2MinRides: row.frequencyTier2MinRides,
  };
}

// ---------------------------------------------------------------------------
// The other direction: what the screens send back
// ---------------------------------------------------------------------------
//
// Writes need the inverse of everything above, and it belongs here for the same reason the
// forward mapping does — one translation layer, not two. The alternative is column names
// leaking into `app/src/App.jsx`, where `recurring_potential_unlocked` would be spelled out in
// a click handler and go stale the first time the column is renamed.
//
// Both are WHITELISTS, not spreads. A patch that forwarded whatever arrived would let a caller
// set `trainer_id` and move a rider to another coach — a tenancy hole with a friendly
// signature. `writes.js` deletes `trainerId` defensively for the same reason; this is the
// outer of the two fences.

// Date#getDay() index -> the day_of_week enum. The inverse of DOW_INDEX.
const DOW_NAME = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Engine field name -> column name, for the fields a screen is allowed to change. */
const STUDENT_PATCH_FIELDS = {
  name: "name",
  phone: "phone",
  email: "email",
  age: "age",
  weight: "weight",
  experienceLevel: "experienceLevel",
  ridingStyles: "ridingStyles",
  notes: "notes",
  active: "active",
  profileStatus: "profileStatus",
  guardianName: "guardianName",
  guardianPhone: "guardianPhone",
  guardianRelationship: "guardianRelationship",
  emergencyContactName: "emergencyContactName",
  emergencyContactPhone: "emergencyContactPhone",
  // The screens' shorter name for it. This single rename is most of why this function exists.
  recurringUnlocked: "recurringPotentialUnlocked",
  notificationPref: "notificationPreference",
};

/**
 * A student patch from the screens -> the columns it is allowed to touch.
 *
 * Silently drops anything not on the list, which is the point: the screens carry derived and
 * display-only fields on the same object (`targetTimes`, `noRideHorses`, `frequencyTier`), and
 * those are either junction tables or things only a job may set.
 */
export function fromEngineStudentPatch(patch) {
  const out = {};
  for (const [from, column] of Object.entries(STUDENT_PATCH_FIELDS)) {
    if (patch[from] !== undefined) out[column] = patch[from];
  }
  return out;
}

/**
 * Availability windows from the screens -> rows for `availability.replace`.
 *
 * `day` is a Date#getDay() index on the way in and a `day_of_week` enum on the way out, which
 * is the same translation `toEngineAvailability` does in reverse — and the one that silently
 * produces a Sunday lesson on a Monday if it is skipped.
 */
export function fromEngineAvailability(windows) {
  return (windows ?? []).map((w) => ({
    dayOfWeek: typeof w.day === "number" ? DOW_NAME[w.day] : w.day,
    startTime: w.start ?? w.startTime,
    endTime: w.end ?? w.endTime,
  }));
}

export const _internals = { DOW_INDEX, DOW_NAME };
