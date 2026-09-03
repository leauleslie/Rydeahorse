// Fixtures for the isolation harness. The shape encodes the two scoping rules the schema
// actually has, which is what the previous single-trainer-per-account fixture could not do:
//
//   TRAINER-SCOPED  students, bookings, lesson types, alerts, notes, riding windows…
//                   Two trainers must never see each other's rows, even inside one account.
//                   A rider taking lessons from two coaches is two rows, and each coach
//                   reviews the profile she was given.
//
//   ACCOUNT-SCOPED  horses, and any read judged about a horse. A horse is a physical animal
//                   at a facility. Two coaches sharing a barn share it — and share its usage,
//                   which is the whole reason `accounts` exists. Here identical rows for two
//                   trainers is CORRECT, and a harness that demands disjointness is wrong.
//
// So the fixture is three trainers across two accounts:
//
//   Alder Stables ──┬── trainer A1 ─┐
//                   └── trainer A2 ─┴─ share 3 horses
//   Birch Stables ───── trainer B1 ─── 3 horses of its own
//
// A1 vs A2 tests the same-account pair: trainer-scoped reads must be disjoint, account-scoped
// reads must be IDENTICAL. A1 vs B1 tests the cross-account pair: everything disjoint.
// Without A2, neither direction of the account rule is reachable.
//
// As before, the tenants collide on every value except ids: same horse names, same student
// names, same lesson dates. If A1 taught on Monday and B1 on Thursday, an unscoped
// `listBookingsOn('monday')` would return "the right rows" by accident, and the harness would
// report a pass for a query with no tenant filter in it at all.

import { randomUUID } from "node:crypto";

// A Tuesday. Every trainer teaches on it.
export const SHARED_DATE = "2026-09-15";
export const SHARED_DOW = "tue";

// Each trainer books the account's shared horses at their own hours. The times must not collide
// across trainers: the horses are shared, and `horse_not_double_booked` does not care which
// coach is asking — which is precisely the property concurrency.test.js proves.
const SLOT_HOURS = [
  ["09:00", "10:00", "11:00"], // trainer 1 of an account
  ["13:00", "14:00", "15:00"], // trainer 2
];

// Ids are generated here rather than by `default gen_random_uuid()` and read back with
// RETURNING. That is what lets every table be written in ONE statement: nothing downstream has
// to wait for an id the database has not produced yet.
//
// This matters more than it looks. The seed was ~70 sequential round trips, and writes.test.js
// re-seeds before every test to keep the tests isolated. Against a hosted database that put
// that one suite between 138s and 447s depending on how Neon was feeling — the variance was
// latency, not work. One statement per table removes most of both.
const id = () => randomUUID();

/**
 * One multi-row INSERT for a whole table.
 * @param columns snake_case column names
 * @param rows    arrays of values, in the same order as `columns`
 */
async function bulk(client, table, columns, rows) {
  if (!rows.length) return;
  const params = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  await client.query(
    `insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Build every row in memory first, then write each table once.
// ---------------------------------------------------------------------------

function planTrainer({ accountId, horses, label, index }) {
  const trainerId = id();
  const hours = SLOT_HOURS[index];
  const [h0, h1, h2] = hours;

  // Jamie is 15, so guardian name and phone are not optional — `students_minor_has_guardian`
  // enforces Section 8's rule. A minor stays in the fixture deliberately: the roster this
  // harness protects is the one where a leak is most sensitive.
  //
  // riding_styles and weight are set deliberately too. They default to '{}' and NULL, and with
  // an empty style list the engine's pairing check can never pass — so a fixture that left them
  // at their defaults would make every engine test fail for a reason unrelated to what it tests.
  const students = [
    { id: id(), name: "Alex Morgan", age: 34, level: "intermediate", weight: 140 },
    { id: id(), name: "Jamie Lee", age: 15, level: "beginner", weight: 90 },
    { id: id(), name: "Robin Fox", age: 41, level: "advanced", weight: 165 },
  ];

  // Exactly one intro type per trainer — a partial unique index enforces it.
  const lessonTypes = [
    { id: id(), name: "Intro Lesson", isIntro: true, durationMin: 45, rideTimeMin: 30 },
    { id: id(), name: "Private Lesson", isIntro: false, durationMin: 60, rideTimeMin: 45 },
  ];

  const priceBandId = id();
  const priceBandWindowId = id();
  const availabilityId = id();
  const timeOffId = id();
  const recurringId = id();
  const noteId = id();
  const offerId = id();

  // All on SHARED_DATE, on the ACCOUNT's horses. That makes one table answer to both scoping
  // rules at once: `bookings.listOn` is trainer-scoped and must split A1 from A2, while
  // `bookings.listForHorsesOn` is account-scoped for horse welfare and must return the union.
  const bookings = [
    { id: id(), studentId: students[0].id, horseId: horses[0], start: h0, end: h1, status: "confirmed" },
    { id: id(), studentId: students[1].id, horseId: horses[1], start: h0, end: h1, status: "pending" },
    { id: id(), studentId: students[2].id, horseId: horses[0], start: h1, end: h2, status: "completed" },
  ];

  // These carry NEITHER trainer_id nor account_id. They hang off `students`, so their scoping is
  // a join back through it — the easiest to get wrong and the most damaging.
  const alerts = [
    { id: id(), studentId: students[0].id, kind: "lesson_cancelled", detail: "Tuesday lesson cancelled" },
    { id: id(), studentId: students[1].id, kind: "no_show", detail: "Missed Tuesday lesson" },
  ];
  const ridingWindows = [
    { id: id(), studentId: students[0].id, kind: "target" },
    { id: id(), studentId: students[1].id, kind: "potential" },
  ];

  return {
    label: `${label}${index + 1}`,
    accountId,
    trainerId,
    email: `coach+${label}${index + 1}@example.test`,
    hours,
    students,
    lessonTypes,
    priceBandId,
    priceBandWindowId,
    availabilityId,
    timeOffId,
    recurringId,
    noteId,
    offerId,
    bookings,
    alerts,
    ridingWindows,
    horses,
  };
}

/** The id sets the isolation harness compares against. */
function manifestOf(t) {
  return {
    label: t.label,
    accountId: t.accountId,
    trainerId: t.trainerId,
    students: t.students.map((s) => s.id),
    lessonTypes: t.lessonTypes.map((l) => l.id),
    priceBands: [t.priceBandId],
    priceBandWindows: [t.priceBandWindowId],
    availability: [t.availabilityId],
    timeOff: [t.timeOffId],
    bookings: t.bookings.map((b) => b.id),
    recurring: [t.recurringId],
    alerts: t.alerts.map((a) => a.id),
    notes: [t.noteId],
    ridingWindows: t.ridingWindows.map((w) => w.id),
    offers: [t.offerId],
    // Composite primary keys — no surrogate id — so the harness compares the pair, kept as a
    // string so every entity set is a set of comparable scalars.
    noRideHorses: [`${t.students[0].id}:${t.horses[2]}`],
    bandAdjustments: [`${t.lessonTypes[1].id}:${t.priceBandId}`],
    restrictedHorses: [`${t.lessonTypes[0].id}:${t.horses[0]}`],
  };
}

/**
 * Two accounts: Alder with two trainers who share horses, Birch with one.
 * Written as one statement per table, in foreign-key order.
 * @returns { alder, birch }
 */
export async function seedAccounts(client) {
  const accounts = [
    { label: "alder", id: id(), name: "Alder Stables", trainerCount: 2 },
    { label: "birch", id: id(), name: "Birch Stables", trainerCount: 1 },
  ];

  // Same three names in both accounts. A horse read that forgets `account_id` returns six.
  const HORSE_NAMES = [["Comet", true], ["Willow", true], ["Dusty", false]];
  for (const a of accounts) {
    a.horses = HORSE_NAMES.map(() => id());
    a.trainers = Array.from({ length: a.trainerCount }, (_, index) =>
      planTrainer({ accountId: a.id, horses: a.horses, label: a.label, index }));
  }
  const trainers = accounts.flatMap((a) => a.trainers);

  await bulk(client, "accounts", ["id", "name"], accounts.map((a) => [a.id, a.name]));

  await bulk(client, "trainers",
    ["id", "account_id", "name", "email", "timezone", "late_cancel_hours"],
    trainers.map((t) => [t.trainerId, t.accountId, "Sam Rider", t.email, "America/Los_Angeles", 24]));

  await bulk(client, "horses",
    ["id", "account_id", "name", "active", "rest_days_per_week", "riding_styles",
     "max_daily_minutes_overall"],
    accounts.flatMap((a) =>
      a.horses.map((horseId, i) => [horseId, a.id, HORSE_NAMES[i][0], HORSE_NAMES[i][1], 1, "{English}", 180])));

  await bulk(client, "students",
    ["id", "trainer_id", "name", "emergency_contact_name", "emergency_contact_phone", "age",
     "experience_level", "guardian_name", "guardian_phone", "riding_styles", "weight"],
    trainers.flatMap((t) =>
      t.students.map((s) => [
        s.id, t.trainerId, s.name, "Pat Kin", "555-0100", s.age, s.level,
        s.age < 18 ? "Dana Lee" : null, s.age < 18 ? "555-0111" : null, "{English}", s.weight,
      ])));

  await bulk(client, "lesson_types",
    ["id", "trainer_id", "name", "duration_min", "ride_time_min", "is_intro", "base_price",
     "min_price", "max_price"],
    trainers.flatMap((t) =>
      t.lessonTypes.map((l) => [
        l.id, t.trainerId, l.name, l.durationMin, l.rideTimeMin, l.isIntro, 60, 55, 90,
      ])));

  await bulk(client, "price_bands", ["id", "trainer_id", "name"],
    trainers.map((t) => [t.priceBandId, t.trainerId, "Peak"]));

  await bulk(client, "price_band_windows",
    ["id", "band_id", "trainer_id", "day_of_week", "start_time", "end_time"],
    trainers.map((t) => [t.priceBandWindowId, t.priceBandId, t.trainerId, SHARED_DOW, "16:00", "19:00"]));

  await bulk(client, "trainer_availability",
    ["id", "trainer_id", "day_of_week", "start_time", "end_time"],
    trainers.map((t) => [t.availabilityId, t.trainerId, SHARED_DOW, "09:00", "17:00"]));

  // Deliberately far from SHARED_DATE: time off overlapping the fixture's lesson dates would
  // fail the availability check in every engine test built on this seed.
  await bulk(client, "trainer_time_off",
    ["id", "trainer_id", "start_date", "end_date", "reason"],
    trainers.map((t) => [t.timeOffId, t.trainerId, "2026-12-24", "2026-12-26", "Holiday"]));

  await bulk(client, "bookings",
    ["id", "trainer_id", "student_id", "horse_id", "lesson_type_id", "date", "start_time",
     "end_time", "status", "base_price", "price"],
    trainers.flatMap((t) =>
      t.bookings.map((b) => [
        b.id, t.trainerId, b.studentId, b.horseId, t.lessonTypes[1].id, SHARED_DATE,
        b.start, b.end, b.status, 60, 60,
      ])));

  await bulk(client, "recurring_bookings",
    ["id", "trainer_id", "student_id", "horse_id", "lesson_type_id", "day_of_week", "start_time",
     "start_date"],
    trainers.map((t) => [
      t.recurringId, t.trainerId, t.students[0].id, t.horses[0], t.lessonTypes[1].id,
      SHARED_DOW, t.hours[0], SHARED_DATE,
    ]));

  await bulk(client, "student_alerts", ["id", "student_id", "kind", "detail"],
    trainers.flatMap((t) => t.alerts.map((a) => [a.id, a.studentId, a.kind, a.detail])));

  await bulk(client, "student_notes", ["id", "student_id", "category", "note"],
    trainers.map((t) => [t.noteId, t.students[0].id, "message", "Prefers morning lessons"]));

  await bulk(client, "student_riding_windows",
    ["id", "student_id", "kind", "day_of_week", "start_time", "end_time"],
    trainers.flatMap((t) =>
      t.ridingWindows.map((w) => [w.id, w.studentId, w.kind, SHARED_DOW, "09:00", "12:00"])));

  await bulk(client, "offers",
    ["id", "trainer_id", "student_id", "date", "start_time", "horse_id", "lesson_type_id", "kind"],
    trainers.map((t) => [
      t.offerId, t.trainerId, t.students[2].id, SHARED_DATE, t.hours[2], t.horses[1],
      t.lessonTypes[1].id, "target",
    ]));

  await bulk(client, "student_no_ride_horses", ["student_id", "horse_id"],
    trainers.map((t) => [t.students[0].id, t.horses[2]]));

  // Both junctions exist in the fixture so the engine mapping is exercised with real rows
  // rather than with the empty case, which is the one that accidentally passes.
  await bulk(client, "lesson_type_band_adjustments",
    ["lesson_type_id", "band_id", "trainer_id", "amount"],
    trainers.map((t) => [t.lessonTypes[1].id, t.priceBandId, t.trainerId, 10]));

  await bulk(client, "lesson_type_restricted_horses", ["lesson_type_id", "horse_id"],
    trainers.map((t) => [t.lessonTypes[0].id, t.horses[0]]));

  const shape = (a) => {
    const manifests = a.trainers.map(manifestOf);
    return {
      label: a.label,
      accountId: a.id,
      horses: a.horses,
      trainers: manifests,
      // The union across the account's trainers — what an account-scoped read of a
      // trainer-scoped table (horse welfare over `bookings`) is expected to return.
      accountBookings: manifests.flatMap((t) => t.bookings),
    };
  };
  return { alder: shape(accounts[0]), birch: shape(accounts[1]) };
}

/**
 * The id sets one trainer may legitimately see, flattened so the harness can look up any entity
 * set by name. Account-level sets are merged in, which is what lets `horses` resolve to the SAME
 * array for two trainers of one account — the fact the account rule is asserted against.
 */
export function manifestFor(account, trainer) {
  return { ...trainer, horses: account.horses, accountBookings: account.accountBookings };
}
