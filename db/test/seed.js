// Two complete, deliberately indistinguishable tenants.
//
// The important property here is not that the fixture is realistic — it is that the two
// tenants COLLIDE on every value except their ids and foreign keys. Same lesson dates, same
// start times, same day-of-week, same horse names, same student names, same lesson type
// names.
//
// That is what makes the isolation harness able to fail. If tenant A's lessons were on
// Monday and tenant B's on Thursday, then `listBookingsOn('monday')` returns only A's rows
// whether or not it filters by trainer — and the harness would report a pass for a query with
// no tenant scoping in it at all. Every dimension a query might filter on has to be shared,
// so that `trainer_id` / `account_id` is the ONLY thing that can separate them.
//
// The same reasoning drives `expectDistinct` in the harness: A and B must return different
// rows, not merely rows that each look plausible.

// A Tuesday. Both tenants teach on it, at the same hours.
export const SHARED_DATE = "2026-09-15";
export const SHARED_DOW = "tue";

async function one(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0].id;
}

async function seedTenant(client, label) {
  const accountId = await one(
    client,
    `insert into accounts (name) values ($1) returning id`,
    [`${label} Stables`],
  );

  const trainerId = await one(
    client,
    `insert into trainers (account_id, name, email, timezone, late_cancel_hours)
     values ($1, $2, $3, $4, 24) returning id`,
    [accountId, "Sam Rider", `coach+${label.toLowerCase()}@example.test`, "America/Los_Angeles"],
  );

  // Same three names in both accounts. A horse query that forgets `account_id` returns six.
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

  // Jamie is 15, so guardian name and phone are not optional — `students_minor_has_guardian`
  // enforces Section 8's rule. A minor is kept in the fixture deliberately: the roster the
  // isolation harness protects is exactly the one where a leak is most sensitive.
  const students = [];
  for (const [name, age, level] of [
    ["Alex Morgan", 34, "intermediate"],
    ["Jamie Lee", 15, "beginner"],
    ["Robin Fox", 41, "advanced"],
  ]) {
    const minor = age < 18;
    students.push(
      await one(
        client,
        `insert into students (trainer_id, name, emergency_contact_name,
                               emergency_contact_phone, age, experience_level,
                               guardian_name, guardian_phone)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [trainerId, name, "Pat Kin", "555-0100", age, level,
         minor ? "Dana Lee" : null, minor ? "555-0111" : null],
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
    await one(client, `insert into price_bands (trainer_id, name) values ($1, $2) returning id`, [
      trainerId,
      "Peak",
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

  // Same date, same clock times as the other tenant. Distinct horses, so the exclusion
  // constraint is untouched — these two barns simply both teach Tuesday mornings.
  const bookings = [];
  const slots = [
    [students[0], horses[0], "09:00", "10:00", "confirmed"],
    [students[1], horses[1], "10:00", "11:00", "pending"],
    [students[2], horses[0], "11:00", "12:00", "completed"],
  ];
  for (const [studentId, horseId, start, end, status] of slots) {
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
       values ($1, $2, $3, $4, $5, '09:00', $6) returning id`,
      [trainerId, students[0], horses[0], lessonTypes[1], SHARED_DOW, SHARED_DATE],
    ),
  ];

  // Reached only through students — these tables have no trainer_id at all, so a query that
  // forgets to join back through `students` leaks every other coach's roster detail.
  const alerts = [];
  for (const [studentId, kind, detail] of [
    [students[0], "lesson_cancelled", "Tuesday 9am cancelled"],
    [students[1], "no_show", "Missed Tuesday 10am"],
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
       values ($1, $2, $3, '14:00', $4, $5, 'target') returning id`,
      [trainerId, students[2], SHARED_DATE, horses[1], lessonTypes[1]],
    ),
  ];

  // Composite primary key (student_id, horse_id) — no surrogate id — so the harness compares
  // the pair. Kept as a string so every entity set is a set of comparable scalars.
  await client.query(
    `insert into student_no_ride_horses (student_id, horse_id) values ($1, $2)`,
    [students[0], horses[2]],
  );
  const noRideHorses = [`${students[0]}:${horses[2]}`];

  return {
    label,
    accountId,
    trainerId,
    horses,
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
  };
}

/**
 * Seed both tenants and return the manifest the harness checks against.
 * Tenant "A" is the requesting tenant in every assertion; "B" is the one that must never
 * appear in a result.
 */
export async function seedTwoTenants(client) {
  const a = await seedTenant(client, "Alder");
  const b = await seedTenant(client, "Birch");
  return { a, b };
}
