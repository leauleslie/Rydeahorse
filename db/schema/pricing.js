// Price bands and lesson types — the two halves of the pricing model.
//
// The split is the point: a band's *windows* are facts about the calendar and are shared, but
// every *amount* a band implies is a column (or a row) hanging off the lesson type, because
// what a busy Thursday hour is worth genuinely differs between a 30-minute lesson and a
// 90-minute one. This is why there is no pricing screen.
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  time,
  timestamp,
  index,
  unique,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { trainers } from "./tenancy.js";
import { horses } from "./horses.js";
import { dayOfWeek, ridingStyle } from "./enums.js";

// A band is a *named* thing with one or more day windows, not one row per day.
//
// Section 8 describes the Sheets version as "five rows sharing a name" for a Mon–Fri "After
// school" band. That reading doesn't survive the two rules stated around it: three bands
// maximum (a Mon–Fri band would already be five), and one `band_id:amount` pair per band on a
// lesson type (a Mon–Fri band would need five). Splitting the name from its windows keeps
// both rules literally true, keeps the receipt line ("After school") pointing at one row, and
// leaves the Section 3 exclusion constraint exactly where it was specified — per trainer, per
// day of week — just on the windows table.
export const priceBands = pgTable(
  "price_bands",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "cascade" }),
    // Coach-authored and student-visible. This is the word that appears on the student's
    // receipt line, so it has to read as a reason rather than a code.
    name: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("price_bands_trainer_idx").on(t.trainerId),
    // The target of the composite foreign key on `price_band_windows` and
    // `lesson_type_band_adjustments`: a band can only be joined to rows of its own trainer.
    unique("price_bands_id_trainer_key").on(t.id, t.trainerId),
    // Three bands maximum is NOT enforced here. It is a count across rows, which needs a
    // trigger or a statement-level check; the engine and the band editor hold it
    // (`MAX_PRICE_BANDS` in engine/constants.js).
  ],
);

export const priceBandWindows = pgTable(
  "price_band_windows",
  {
    id: uuid().primaryKey().defaultRandom(),
    bandId: uuid().notNull(),
    // Denormalised from the band so Section 3's constraint #4 can be expressed as written —
    // "per trainer and day of week" — without a join. The composite FK below is what keeps
    // it honest: this column cannot disagree with the band's own trainer.
    trainerId: uuid().notNull(),
    dayOfWeek: dayOfWeek().notNull(),
    startTime: time().notNull(),
    endTime: time().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.bandId, t.trainerId],
      foreignColumns: [priceBands.id, priceBands.trainerId],
      name: "price_band_windows_band_fk",
    }).onDelete("cascade"),
    index("price_band_windows_lookup_idx").on(t.trainerId, t.dayOfWeek),
    check("price_band_windows_end_after_start", sql`${t.endTime} > ${t.startTime}`),
    // Constraint #4 (bands may not overlap) is an EXCLUDE ... USING gist, which drizzle-kit
    // cannot express. It lives in migrations/0001_constraints.sql.
  ],
);

export const lessonTypes = pgTable(
  "lesson_types",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "cascade" }),
    name: text().notNull(),
    // Total slot length — what blocks the coach's calendar. Includes prep and put-away.
    // Scheduling and conflict checks use this.
    durationMin: integer().notNull(),
    // Actual time under saddle. This, not `duration_min`, is what counts against a horse's
    // daily cap — otherwise prep time would silently eat the horse's ride-time budget.
    rideTimeMin: integer().notNull(),

    isGroup: boolean().notNull().default(false),
    maxGroupSize: integer(),
    // A *role*, not an id. Eleven places once compared against the literal string
    // "first-time", which works only while seed ids are fixed strings; a real coach's types
    // have generated ids and every such comparison silently evaluates false. Exactly one type
    // per trainer carries it — constraint #3, the partial unique index below.
    isIntro: boolean().notNull().default(false),

    // ---- amounts, all whole dollars ----
    // Renamed from `target_price`: the anchor every adjustment applies to, not a middle the
    // system aims for.
    basePrice: integer().notNull(),
    // A hard floor, applied after every adjustment stacks — and surfaced, never silent.
    minPrice: integer().notNull(),
    // A ceiling on manual overrides. A band adjustment that would breach it is rejected on
    // the Lessons screen, where the coach can fix it, rather than clamped at booking time,
    // where it would read as the system quietly disagreeing with a setting she entered.
    maxPrice: integer().notNull(),
    // What a tier-1 / tier-2 student saves *on this type*. Null means this type isn't
    // discounted by frequency at all — a real case: a coach may reward volume on regular
    // lessons and not on an intro.
    frequencyDiscount1: integer(),
    frequencyDiscount2: integer(),
    // The preset the notify sheet offers with one tap. Not a cap — the sheet allows a custom
    // amount, still floored by `min_price`. Null means no preset and a typed amount.
    gapFillDiscount: integer(),

    // Whether open windows that fit this type surface as potential lessons. Forced false for
    // a group type: filling a gap by adding a rider to a live group isn't one offer, it's a
    // coordination problem.
    potentialLessonEligible: boolean().notNull().default(true),
    // If set, both the assigned horse *and* the student must support at least one listed
    // style. Empty means no restriction.
    ridingStyles: ridingStyle().array().notNull().default(sql`'{}'`),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lesson_types_trainer_idx").on(t.trainerId),
    unique("lesson_types_id_trainer_key").on(t.id, t.trainerId),

    // Constraint #3: exactly one lesson type per trainer is the intro type. The foundations
    // doc says setting it on one type clears it from the others on save; this index makes
    // that a guarantee rather than a convention. It permits *zero* intro types, which is a
    // real state — with none set, new riders have nothing to book and the Lessons screen says
    // so at the top.
    uniqueIndex("lesson_types_one_intro_per_trainer")
      .on(t.trainerId)
      .where(sql`${t.isIntro}`),

    // Saddle time is a part of the slot, never longer than it.
    check(
      "lesson_types_ride_time_within_duration",
      sql`${t.rideTimeMin} > 0 and ${t.rideTimeMin} <= ${t.durationMin}`,
    ),
    check("lesson_types_price_floor_below_ceiling", sql`${t.minPrice} <= ${t.maxPrice}`),
    check("lesson_types_prices_non_negative", sql`${t.basePrice} >= 0 and ${t.minPrice} >= 0`),
    check(
      "lesson_types_discounts_non_negative",
      sql`(${t.frequencyDiscount1} is null or ${t.frequencyDiscount1} >= 0)
          and (${t.frequencyDiscount2} is null or ${t.frequencyDiscount2} >= 0)
          and (${t.gapFillDiscount} is null or ${t.gapFillDiscount} >= 0)`,
    ),
    // A group type has a capacity; a private one does not.
    check(
      "lesson_types_group_has_capacity",
      sql`(${t.isGroup} and ${t.maxGroupSize} is not null and ${t.maxGroupSize} > 1)
          or (not ${t.isGroup} and ${t.maxGroupSize} is null)`,
    ),
    // "Forced N and not editable when is_group" — stated as UI behaviour in Section 8, made
    // structural here, since slot discovery ignores group sessions entirely and a stray true
    // would be read by the matching layer.
    check(
      "lesson_types_group_never_potential",
      sql`not (${t.isGroup} and ${t.potentialLessonEligible})`,
    ),
    // An intro lesson is for a brand-new student, not a slot an existing student fills; and a
    // group type can't be the intro type given the rule above.
    check("lesson_types_intro_not_group", sql`not (${t.isIntro} and ${t.isGroup})`),
  ],
);

// `BAND-001:10` was a key-value pair encoded in a string. It's a row.
// A band absent from this table contributes 0, so a coach who prices only one of her bands
// differently for this type writes one row.
export const lessonTypeBandAdjustments = pgTable(
  "lesson_type_band_adjustments",
  {
    lessonTypeId: uuid().notNull(),
    bandId: uuid().notNull(),
    // Carried so both foreign keys can be composite: an adjustment cannot pair one trainer's
    // lesson type with another trainer's band.
    trainerId: uuid().notNull(),
    // Signed whole dollars — a band can discount as easily as it can premium.
    amount: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.lessonTypeId, t.bandId] }),
    foreignKey({
      columns: [t.lessonTypeId, t.trainerId],
      foreignColumns: [lessonTypes.id, lessonTypes.trainerId],
      name: "lesson_type_band_adjustments_lesson_type_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.bandId, t.trainerId],
      foreignColumns: [priceBands.id, priceBands.trainerId],
      name: "lesson_type_band_adjustments_band_fk",
    }).onDelete("cascade"),
  ],
);

// If set, only these horses are eligible for this lesson type — still subject to the normal
// pairing checks. Empty means no restriction beyond pairing.
export const lessonTypeRestrictedHorses = pgTable(
  "lesson_type_restricted_horses",
  {
    lessonTypeId: uuid()
      .notNull()
      .references(() => lessonTypes.id, { onDelete: "cascade" }),
    // A junction rather than a comma-separated cell, so a deleted horse cannot leave a
    // dangling id in a text field. (No horse delete path exists today; the constraint is what
    // makes adding one safe rather than a white screen.)
    horseId: uuid()
      .notNull()
      .references(() => horses.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.lessonTypeId, t.horseId] })],
);
