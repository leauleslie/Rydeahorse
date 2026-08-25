// Account-level, not trainer-level. A horse is a physical animal at a facility: its rest days
// and its daily saddle-time cap are facts about the animal, not about who booked it. Two
// coaches sharing a barn share the horse — and therefore share its usage, which is the whole
// reason `accounts` exists (schema.md Section 1).
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  date,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./tenancy.js";
import { experienceLevel, ridingStyle, inactivePeriodStatus } from "./enums.js";

export const horses = pgTable(
  "horses",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    name: text().notNull(),

    // ---- pairing (check #5) ----
    // The student's own level must be at or above this.
    minExperienceLevel: experienceLevel().notNull().default("beginner"),
    // Matched against student `age` >= 18 — the same cutoff SMS routing uses, so "adult" has
    // one definition across the system.
    adultOnly: boolean().notNull().default(false),
    // The one multi-value field that stays an array rather than becoming a junction table: a
    // fixed two-value vocabulary with no table to point at. An enum array rather than text[]
    // so the vocabulary is enforced where it is stored.
    ridingStyles: ridingStyle().array().notNull().default(sql`'{}'`),
    // A hard safety cap, matched against the student's `weight`. Null means this horse
    // carries no stated weight limit — the check then has nothing to fail against.
    maxRiderWeightLbs: integer(),

    // ---- welfare ----
    // Feeds check #3: the rolling 7-day window allows at most `7 - rest_days_per_week`
    // distinct ridden dates.
    restDaysPerWeek: integer().notNull().default(1),
    // Saddle time (`ride_time_min`), never calendar time. Null means no cap of that kind.
    maxDailyMinutesAdult: integer(),
    maxDailyMinutesOverall: integer(),

    // Takes the horse fully offline (e.g. lame) without deleting history. There is no delete
    // path for a horse, deliberately — every `horses.find(...)` in the render path depends on
    // the row still being there.
    active: boolean().notNull().default(true),
    notes: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("horses_account_idx").on(t.accountId),
    check(
      "horses_rest_days_in_range",
      sql`${t.restDaysPerWeek} >= 0 and ${t.restDaysPerWeek} <= 7`,
    ),
    // The adult subset can never exceed the overall ceiling it is a subset of.
    check(
      "horses_adult_cap_within_overall",
      sql`${t.maxDailyMinutesAdult} is null
          or ${t.maxDailyMinutesOverall} is null
          or ${t.maxDailyMinutesAdult} <= ${t.maxDailyMinutesOverall}`,
    ),
  ],
);

// Separate from the `active` flag: this tracks the *period*, with an estimate the coach can
// adjust, so the substitution screen has a window to plan coverage against.
export const horseInactivePeriods = pgTable(
  "horse_inactive_periods",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Account-level alongside `horses`, so a period is visible to every trainer who books the
    // animal — a horse that is lame is lame for both coaches.
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    horseId: uuid()
      .notNull()
      .references(() => horses.id, { onDelete: "cascade" }),
    startDate: date().notNull(),
    // Nullable if genuinely unknown; editable as the situation changes.
    estimatedEndDate: date(),
    // Set automatically when the coach marks the horse active again.
    actualEndDate: date(),
    status: inactivePeriodStatus().notNull().default("active"),
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("horse_inactive_periods_horse_idx").on(t.horseId, t.startDate),
    check(
      "horse_inactive_periods_end_after_start",
      sql`${t.actualEndDate} is null or ${t.actualEndDate} >= ${t.startDate}`,
    ),
    // `ended` and an actual end date arrive together — a period that is over has a date it
    // ended on, and one that is still running does not.
    check(
      "horse_inactive_periods_ended_has_actual_end",
      sql`(${t.status} = 'ended') = (${t.actualEndDate} is not null)`,
    ),
  ],
);
