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

// A Tuesday. Every trainer teaches on it.
export const SHARED_DATE = "2026-09-15";
export const SHARED_DOW = "tue";

async function one(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0].id;
}

// Each trainer books the account's shared horses at their own hours. The times must not
// collide across trainers: the horses are shared, and `horse_not_double_booked` does not care
// which coach is asking — which is precisely the property concurrency.test.js proves.
const SLOT_HOURS = [
  ["09:00", "10:00", "11:00"], // trainer 1 of an account
  ["13:00", "14:00", "15:00"], // trainer 2
];

async function seedTrainer(client, { accountId, horses, label, index }) {
  const trainerId = await one(
    client,
    `insert into trainers (account_id, name, email, timezone, late_cancel_hours)
     values ($1, $2, $3, $4, 24) returning id`,
    [accountId, "Sam Rider", `coach+${label}${index + 1}@example.test`, "America/Los_Angeles"],
  );

  // Jamie is 15, so guardian name and phone are not optional — `students_minor_has_guardian`
  // enforces Section 8's rule. A minor stays in the fixture deliberately: the roster this
  // harness protects is the one where a leak is most sensitive.
  // riding_styles and weight are set deliberately. They default to '{}' and NULL, and with an
  // empty style list the engine's pairing check can never pass — `horse.styles.some(s =>
  // student.ridingStyles.includes(s))` is false for every horse. A fixture that leaves them at
  // their defaults makes every engine test fail for a reason that has nothing to do with what
  // it is testing.
  const students = [];
  for (const [name, age, level, weight] of [
    ["Alex Morgan", 34, "intermediate", 140],
    ["Jamie Lee", 15, "beginner", 90],
    ["Robin Fox", 41, "advanced", 165],
  ]) {
    const minor = age < 18;
    students.push(
      await one(
        client,
        `insert into students (trainer_id, name, emergency_contact_name,
                               emergency_contact_phone, age, experience_level,
                               guardian_name, guardian_phone, riding_styles, weight)
         values ($1, $2, $3, $4, $5, $6, $7, $8, '{English}', $9) returning id`,
        [trainerId, name, "Pat Kin", "555-0100", age, level,
         minor ? "Dana Lee" : null, minor ? "555-0111" : null, weight],
      ),
    );
  }

  // Exactly one intro type per trainer — a partial unique index enforces it.
  const lessonTypes = [];
  for (const [name, isIntro, dur, ride] of [
    ["Intro Lesson", true, 45, 30],
    ["Private Lesson", false, 60, 45],
  ]) {
    lessonTypes.push(
      await one(
        client,
        `insert into lesson_types (trainer_id, name, duration_min, ride_time_min, is_intro,
                                   base_price, min_price, max_price)
         values ($1, $2, $3, $4, $5, 60, 55, 90) returning id`,
        [trainerId, name, dur, ride, isIntro],
      ),
    );
  }

  const priceBands = [
    await one(client, `insert into price_bands (trainer_id, name) values ($1, 'Peak') returning id`, [
      trainerId,
    ]),
  ];
  const priceBandWindows = [
    await one(
      client,
      `insert into price_band_windows (band_id, trainer_id, day_of_week, start_time, end_time)
       values ($1, $2, $3, '16:00', '19:00') returning id`,
      [priceBands[0], trainerId, SHARED_DOW],
    ),
  ];

  const availability = [
    await one(
      client,
      `insert into trainer_availability (trainer_id, day_of_week, start_time, end_time)
       values ($1, $2, '09:00', '17:00') returning id`,
      [trainerId, SHARED_DOW],
    ),
  ];

  // All on SHARED_DATE, on the ACCOUNT's horses. That makes one table answer to both rules at
  // once: `bookings.listOn` is trainer-scoped and must split A1 from A2, while
  // `bookings.listForHorsesOn` is account-scoped for horse welfare and must return the union
  // to both. Same table, same date, two different correct answers.
  const [h0, h1, h2] = SLOT_HOURS[index];
  const bookings = [];
  for (const [studentId, horseId, start, end, status] of [
    [students[0], horses[0], h0, h1, "confirmed"],
    [students[1], horses[1], h0, h1, "pending"],
    [students[2], horses[0], h1, h2, "completed"],
  ]) {
    bookings.push(
      await one(
        client,
        `insert into bookings (trainer_id, student_id, horse_id, lesson_type_id, date,
                               start_time, end_time, status, base_price, price)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 60, 60) returning id`,
        [trainerId, studentId, horseId, lessonTypes[1], SHARED_DATE, start, end, status],
      ),
    );
  }

  const recurring = [
    await one(
      client,
      `insert into recurring_bookings (trainer_id, student_id, horse_id, lesson_type_id,
                                       day_of_week, start_time, start_date)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [trainerId, students[0], horses[0], lessonTypes[1], SHARED_DOW, h0, SHARED_DATE],
    ),
  ];

  // These four carry NEITHER trainer_id nor account_id. They hang off `students`, so their
  // scoping is a join back through it — the easiest to get wrong and the most damaging.
  const alerts = [];
  for (const [studentId, kind, detail] of [
    [students[0], "lesson_cancelled", "Tuesday lesson cancelled"],
    [students[1], "no_show", "Missed Tuesday lesson"],
  ]) {
    alerts.push(
      await one(
        client,
        `insert into student_alerts (student_id, kind, detail) values ($1, $2, $3) returning id`,
        [studentId, kind, detail],
      ),
    );
  }

  const notes = [
    await one(
      client,
      `insert into student_notes (student_id, category, note) values ($1, 'message', $2) returning id`,
      [students[0], "Prefers morning lessons"],
    ),
  ];

  const ridingWindows = [];
  for (const [studentId, kind] of [
    [students[0], "target"],
    [students[1], "potential"],
  ]) {
    ridingWindows.push(
      await one(
        client,
        `insert into student_riding_windows (student_id, kind, day_of_week, start_time, end_time)
         values ($1, $2, $3, '09:00', '12:00') returning id`,
        [studentId, kind, SHARED_DOW],
      ),
    );
  }

  const offers = [
    await one(
      client,
      `insert into offers (trainer_id, student_id, date, start_time, horse_id, lesson_type_id, kind)
       values ($1, $2, $3, $4, $5, $6, 'target') returning id`,
      [trainerId, students[2], SHARED_DATE, h2, horses[1], lessonTypes[1]],
    ),
  ];

  // Deliberately far from SHARED_DATE: time off that overlapped the fixture's lesson dates
  // would fail the availability check in every engine test built on this seed.
  const timeOff = [
    await one(
      client,
      `insert into trainer_time_off (trainer_id, start_date, end_date, reason)
       values ($1, '2026-12-24', '2026-12-26', 'Holiday') returning id`,
      [trainerId],
    ),
  ];

  // The two junctions the engine expects as inline fields. Both exist in the fixture so the
  // mapping is exercised with real rows rather than with the empty case, which is the one that
  // accidentally passes.
  await client.query(
    `insert into lesson_type_band_adjustments (lesson_type_id, band_id, trainer_id, amount)
     values ($1, $2, $3, 10)`,
    [lessonTypes[1], priceBands[0], trainerId],
  );
  const bandAdjustments = [`${lessonTypes[1]}:${priceBands[0]}`];

  await client.query(
    `insert into lesson_type_restricted_horses (lesson_type_id, horse_id) values ($1, $2)`,
    [lessonTypes[0], horses[0]],
  );
  const restrictedHorses = [`${lessonTypes[0]}:${horses[0]}`];

  // Composite primary key (student_id, horse_id) — no surrogate id — so the harness compares
  // the pair, kept as a string so every entity set is a set of comparable scalars.
  await client.query(
    `insert into student_no_ride_horses (student_id, horse_id) values ($1, $2)`,
    [students[0], horses[2]],
  );
  const noRideHorses = [`${students[0]}:${horses[2]}`];

  return {
    label: `${label}${index + 1}`,
    accountId,
    trainerId,
    students,
    lessonTypes,
    priceBands,
    priceBandWindows,
    availability,
    bookings,
    recurring,
    alerts,
    notes,
    ridingWindows,
    offers,
    noRideHorses,
    timeOff,
    bandAdjustments,
    restrictedHorses,
  };
}

async function seedAccount(client, label, trainerCount) {
  const accountId = await one(client, `insert into accounts (name) values ($1) returning id`, [
    `${label[0].toUpperCase() + label.slice(1)} Stables`,
  ]);

  // Same three names in both accounts. A horse read that forgets `account_id` returns six.
  const horses = [];
  for (const [name, active] of [["Comet", true], ["Willow", true], ["Dusty", false]]) {
    horses.push(
      await one(
        client,
        `insert into horses (account_id, name, active, rest_days_per_week, riding_styles,
                             max_daily_minutes_overall)
         values ($1, $2, $3, 1, '{English}', 180) returning id`,
        [accountId, name, active],
      ),
    );
  }

  const trainers = [];
  for (let index = 0; index < trainerCount; index++) {
    trainers.push(await seedTrainer(client, { accountId, horses, label, index }));
  }

  return {
    label,
    accountId,
    horses,
    trainers,
    // The union across the account's trainers. This is what an account-scoped read of a
    // trainer-scoped table (horse welfare over `bookings`) is expected to return.
    accountBookings: trainers.flatMap((t) => t.bookings),
  };
}

/**
 * Two accounts: Alder with two trainers who share horses, Birch with one.
 * @returns { alder, birch }
 */
export async function seedAccounts(client) {
  const alder = await seedAccount(client, "alder", 2);
  const birch = await seedAccount(client, "birch", 1);
  return { alder, birch };
}

/**
 * The id sets one trainer may legitimately see, flattened into a single manifest so the
 * harness can look up any entity set by name. Account-level sets are merged in, which is what
 * lets `horses` resolve to the SAME array for two trainers of one account — the fact the
 * account rule is asserted against.
 */
export function manifestFor(account, trainer) {
  return { ...trainer, horses: account.horses, accountBookings: account.accountBookings };
}
