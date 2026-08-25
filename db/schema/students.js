// Students are scoped to a trainer, not an account. A rider taking lessons from two coaches
// is two rows — the simpler model, honest about what it loses: no shared ride history, no
// shared no-ride list, and each coach reviews the profile she was given.
import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  boolean,
  date,
  time,
  timestamp,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { trainers } from "./tenancy.js";
import { horses } from "./horses.js";
import { authIdentities } from "./identity.js";
import {
  dayOfWeek,
  ridingStyle,
  experienceLevel,
  profileStatus,
  notificationPreference,
  ridingWindowKind,
  noteCategory,
  noteStatus,
  alertKind,
} from "./enums.js";

export const students = pgTable(
  "students",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "restrict" }),
    // Nullable: a profile the coach creates herself (Section 11) exists before the rider has
    // ever verified a phone. The link is what lets one code surface every profile attached to
    // a number.
    authIdentityId: uuid().references(() => authIdentities.id, { onDelete: "set null" }),

    // For a minor, this is still the student's own name — that's who the coach's roster is
    // about — while the phone is the guardian's.
    name: text().notNull(),
    phone: text(),
    email: text(),
    guardianName: text(),
    guardianPhone: text(),
    // Not collected yet; the column exists so adding the field isn't a migration.
    guardianEmail: text(),
    // Parent / Grandparent / Legal Guardian / Other. Free text rather than an enum: "Other"
    // in the UI means the vocabulary was never meant to be closed.
    guardianRelationship: text(),
    // Required on every profile, whatever the age — a profile can't be created or approved
    // without one.
    emergencyContactName: text().notNull(),
    emergencyContactPhone: text().notNull(),

    // Drives the adult_only pairing rule and SMS routing, both at the same 18 cutoff.
    // Stored as a number because Section 8 specifies `age`; see db/README.md — a date of
    // birth would be the non-drifting form of the same fact.
    age: integer().notNull(),
    experienceLevel: experienceLevel().notNull(),
    ridingStyles: ridingStyle().array().notNull().default(sql`'{}'`),
    // Matched against a horse's `max_rider_weight_lbs` as a hard safety cap. Nullable: an
    // unstated weight means the cap has nothing to compare against, not that it passes zero.
    weight: integer(),

    notificationPreference: notificationPreference()
      .notNull()
      .default("target_and_potential"),

    // Stored, not derived — the whole point of the mechanism. A tier recomputed on every read
    // would move mid-month as the count wobbled, which is precisely the "$60 last week, $65
    // this week" confusion the design exists to prevent. Held steady for a month at a time,
    // changed by one job, on a date the student can name.
    frequencyTier: smallint().notNull().default(0),
    // The month the current tier took effect. A `date` pinned to the 1st rather than a
    // "2026-08" string, so month arithmetic is date arithmetic. Lets the student's screens say
    // *when* their rate changed, and lets the monthly job tell "already run" from "not yet
    // run" without a separate flag.
    frequencyTierEffectiveMonth: date(),

    // A self-created profile starts pending_review; one the coach creates starts approved —
    // she's the reviewer, so her own entry doesn't route into her own queue. Distinct from
    // `active`, which is about currently taking lessons.
    profileStatus: profileStatus().notNull().default("pending_review"),
    // Gates the potential-lessons section and recurring management on the student's own
    // profile page. Deliberately not auto-set when the intro lesson completes — the trainer
    // takes an explicit action to open it.
    recurringPotentialUnlocked: boolean().notNull().default(false),

    notes: text(),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("students_trainer_idx").on(t.trainerId),
    index("students_identity_idx").on(t.authIdentityId),

    check("students_age_non_negative", sql`${t.age} >= 0`),
    check("students_weight_positive", sql`${t.weight} is null or ${t.weight} > 0`),
    check("students_frequency_tier_range", sql`${t.frequencyTier} between 0 and 2`),
    // Two fixed tiers, so a tier is only ever 0, 1 or 2 — and a non-zero tier has a month it
    // took effect, since that date is what the student is told.
    check(
      "students_tier_has_effective_month",
      sql`${t.frequencyTier} = 0 or ${t.frequencyTierEffectiveMonth} is not null`,
    ),
    check(
      "students_effective_month_is_first_of_month",
      sql`${t.frequencyTierEffectiveMonth} is null
          or extract(day from ${t.frequencyTierEffectiveMonth}) = 1`,
    ),
    // Guardian name and phone are required when age < 18 (Section 8). Email is not.
    check(
      "students_minor_has_guardian",
      sql`${t.age} >= 18
          or (${t.guardianName} is not null and ${t.guardianPhone} is not null)`,
    ),
  ],
);

// `target_riding_times` / `potential_riding_times`, structured. Section 13 already required
// these to be structured — they feed opportunity matching directly, and a comma-separated
// "Mon 4-6pm" string can't be joined against an open window.
export const studentRidingWindows = pgTable(
  "student_riding_windows",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    // target: matched at full price. potential: the discount case — a time the student
    // wouldn't otherwise book but would take to help fill a gap.
    kind: ridingWindowKind().notNull(),
    dayOfWeek: dayOfWeek().notNull(),
    startTime: time().notNull(),
    endTime: time().notNull(),
  },
  (t) => [
    index("student_riding_windows_lookup_idx").on(t.studentId, t.kind, t.dayOfWeek),
    check("student_riding_windows_end_after_start", sql`${t.endTime} > ${t.startTime}`),
    // No cap on how many, and no overlap constraint: more target times means more
    // opportunities matched at full price. Overlapping windows are a union, not a conflict.
  ],
);

// Editable by student *and* trainer. A junction rather than a comma-separated cell, so a
// removed horse can't leave a dangling id behind.
export const studentNoRideHorses = pgTable(
  "student_no_ride_horses",
  {
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    horseId: uuid()
      .notNull()
      .references(() => horses.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.studentId, t.horseId] })],
);

// General-purpose escalation from student/parent to coach. `category` keeps it extensible
// beyond the intro-lesson case rather than needing a new table per scenario — and that
// extensibility is load-bearing, since the free-form "Message your coach" writes here too, so
// one queue holds everything a student has raised.
export const studentNotes = pgTable(
  "student_notes",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    category: noteCategory().notNull(),
    note: text().notNull(),
    // The coach clears a note from her own queue on Student profile; nothing else writes
    // `resolved`.
    status: noteStatus().notNull().default("open"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("student_notes_open_idx").on(t.studentId, t.status, t.createdAt)],
);

// The second deliberate exception to derive-don't-store, and worth being explicit about why:
// an alert records who did what, when, and the actor is precisely what current state can't
// recover. A booking with status `late_cancel` looks identical whether the coach or the
// student cancelled it — and a student must not be alerted about their own action.
//
// Append-only. Nothing here is ever edited except `seen`.
export const studentAlerts = pgTable(
  "student_alerts",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    // Determines the heading and the colour; the row itself carries no styling.
    kind: alertKind().notNull(),
    // The specific change in the student's terms — date, time, horse and amount as
    // applicable.
    detail: text().notNull(),
    // Drives both ordering (newest first) and expiry. Retention is 7 days and expiry is a
    // read filter, not a delete — an alert older than the window simply stops being visible,
    // so nothing breaks if a cleanup job hasn't run.
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Set when the student opens the Alerts tab. Drives the unread count and the new-item
    // highlight, nothing else. Never set back to false.
    seen: boolean().notNull().default(false),
  },
  (t) => [index("student_alerts_feed_idx").on(t.studentId, t.createdAt)],
);
