// Recurring patterns, the occurrences they generate, the substitutions that cover them, and
// the offers that produce some of them.
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  date,
  time,
  timestamp,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { trainers } from "./tenancy.js";
import { horses, horseInactivePeriods } from "./horses.js";
import { students } from "./students.js";
import { lessonTypes } from "./pricing.js";
import {
  dayOfWeek,
  bookingStatus,
  recurringStatus,
  ridingWindowKind,
  offerResponse,
} from "./enums.js";

// Source of truth for a student's standing weekly pattern with a horse. Individual bookings
// are generated from this on a rolling horizon; cancelling one occurrence touches only that
// booking, while ending the whole series happens here via `status`.
export const recurringBookings = pgTable(
  "recurring_bookings",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "cascade" }),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    // The pattern's *dominant* horse. A generated occurrence riding a different horse is a
    // substitute, derived by comparing the two — not a stored flag and not a fourth
    // occurrence type.
    horseId: uuid()
      .notNull()
      .references(() => horses.id, { onDelete: "restrict" }),
    lessonTypeId: uuid()
      .notNull()
      .references(() => lessonTypes.id, { onDelete: "restrict" }),
    dayOfWeek: dayOfWeek().notNull(),
    startTime: time().notNull(),
    status: recurringStatus().notNull().default("active"),
    startDate: date().notNull(),
    endDate: date(),
    notes: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

    // No price column, deliberately. A pattern's price isn't one number: base and band
    // adjustment are fixed by the slot, but the frequency discount moves with the student's
    // tier. Storing one would mean either freezing the discount — so a student who earns tier
    // 2 keeps paying tier-1 rates on the one lesson the reward was meant for — or letting a
    // stored value silently disagree with the rows it generated. Occurrences carry the
    // components; the pattern carries none.
  },
  (t) => [
    index("recurring_bookings_trainer_idx").on(t.trainerId, t.status),
    index("recurring_bookings_student_idx").on(t.studentId, t.status),
    index("recurring_bookings_horse_idx").on(t.horseId, t.status),
    check(
      "recurring_bookings_end_after_start",
      sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`,
    ),
    check(
      "recurring_bookings_ended_has_end_date",
      sql`${t.status} = 'active' or ${t.endDate} is not null`,
    ),
  ],
);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "restrict" }),
    // Set only if this row was generated from a standing pattern. Ad hoc bookings leave it
    // null — which is also how occurrence type is derived: no recurring_id + intro type =>
    // first_lesson, no recurring_id otherwise => adhoc, has one => recurring.
    recurringId: uuid().references(() => recurringBookings.id, { onDelete: "set null" }),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    horseId: uuid()
      .notNull()
      .references(() => horses.id, { onDelete: "restrict" }),
    lessonTypeId: uuid()
      .notNull()
      .references(() => lessonTypes.id, { onDelete: "restrict" }),

    date: date().notNull(),
    startTime: time().notNull(),
    // The one behavioural change in schema.md. The foundations doc derives the end from
    // `lesson_types.duration_min`; a database cannot enforce "these two lessons don't
    // overlap" without knowing where each one ends. It should change anyway, on the argument
    // already made about prices: the slot a lesson occupies is a historical fact about a
    // commitment. Editing a lesson type's duration in November should no more resize
    // October's lessons than editing its base price should reprice them. `duration_min`
    // remains the default that populates this at creation.
    endTime: time().notNull(),

    status: bookingStatus().notNull().default("pending"),

    // ---- the stored receipt ----
    // The deliberate exception to derive-don't-store. A price is a historical fact about a
    // transaction, and *recomputing* is what makes it drift: a lesson priced in March against
    // March's bands must still read as $65 in September. Stamped once at creation, never
    // recomputed. The components are what make the number explainable a month later without
    // reconstructing the config that produced it.
    basePrice: integer().notNull(),
    // Signed; 0 when the start time falls in no band. Which band it came from is recoverable
    // from the date and time, so the band name isn't duplicated here.
    bandAdjustment: integer().notNull().default(0),
    // Stamped from the student's tier at creation, never re-read. An August occurrence
    // carries August's tier even if it's ridden after a September recompute.
    frequencyDiscount: integer().notNull().default(0),
    // Non-zero *only* when this booking came from an accepted coach-initiated offer carrying
    // a discount. A student who finds the same open slot and books it themselves gets 0 here,
    // by design — a discount obtainable by waiting is a general price cut with extra steps.
    offerDiscount: integer().notNull().default(0),
    // The coach's override, and the reconciling term that keeps `price` equal to the sum of
    // its parts. Without it an override would produce a receipt that doesn't add up.
    manualAdjustment: integer().notNull().default(0),
    // base + band − frequency − offer + manual, then clamped to the type's min/max. There is
    // deliberately no CHECK asserting the sum: when the floor or ceiling binds, `price` is
    // *supposed* to differ from it, and the clamp is announced by the quote rather than
    // hidden. Always the lesson's normal price regardless of status.
    price: integer().notNull(),

    // Derived from status when the row is written (completed / no_show / late_cancel => true,
    // early_cancel => false), but stored explicitly so the charge decision is never lost even
    // if the status rules change later. This is why `price` is never zeroed on a cancel: the
    // record of what the lesson would have cost survives for reporting.
    isBillable: boolean().notNull().default(false),
    isNewStudent: boolean().notNull().default(false),

    // When the row was made, as distinct from `date`, when the lesson happens. This is what
    // makes "scheduled after the terms changed" answerable — a lesson booked last month for
    // next week accepts last month's terms.
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    notes: text(),
  },
  (t) => [
    // The coach's Day and Week views.
    index("bookings_trainer_date_idx").on(t.trainerId, t.date),
    // Rest-day windows and usage caps both scan by horse and date. Account-wide, not
    // trainer-scoped, because the welfare rules are.
    index("bookings_horse_date_idx").on(t.horseId, t.date),
    index("bookings_student_date_idx").on(t.studentId, t.date),
    index("bookings_recurring_idx").on(t.recurringId, t.date),
    // "Have we already offered this student this slot" reads offers; "did the offer convert"
    // reads this, since conversion is derived rather than stored.
    index("bookings_conversion_idx").on(t.studentId, t.date, t.startTime),

    check("bookings_end_after_start", sql`${t.endTime} > ${t.startTime}`),
    // Whole dollars throughout — there is no rounding step anywhere in this product, so the
    // no-cents rule holds by construction (integer columns are that rule).
    check(
      "bookings_discounts_non_negative",
      sql`${t.frequencyDiscount} >= 0 and ${t.offerDiscount} >= 0`,
    ),
    check("bookings_price_non_negative", sql`${t.price} >= 0`),
    // The trainer half of check #6 stays in the engine (it relaxes for a below-capacity
    // group). The horse half never relaxes, and is constraint #1 — an EXCLUDE ... USING gist
    // in migrations/0001_constraints.sql, which drizzle-kit cannot express.
  ],
);

// The coach's confirmed (or system-recommended, pending) substitute choice. For a recurring
// lesson, one row covers every occurrence for the rest of the inactive period — set on the
// pattern, not per date. For an ad hoc lesson caught in the window, it's a one-off decision
// set on the booking instead.
export const substitutionAssignments = pgTable(
  "substitution_assignments",
  {
    id: uuid().primaryKey().defaultRandom(),
    periodId: uuid()
      .notNull()
      .references(() => horseInactivePeriods.id, { onDelete: "cascade" }),
    recurringId: uuid().references(() => recurringBookings.id, { onDelete: "cascade" }),
    bookingId: uuid().references(() => bookings.id, { onDelete: "cascade" }),
    substituteHorseId: uuid()
      .notNull()
      .references(() => horses.id, { onDelete: "restrict" }),
    // System recommendations start false and become true when the coach taps confirm. Booking
    // generation only honours a confirmed match; an unconfirmed one leaves the occurrence
    // unresolved and on the coach's screen.
    confirmed: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("substitution_assignments_period_idx").on(t.periodId),
    index("substitution_assignments_recurring_idx").on(t.recurringId),
    // "Exactly one of the two is set per row" — stated in Section 8, made structural. A row
    // covering both would be a pattern-wide decision claiming to be a one-off at the same
    // time.
    check(
      "substitution_assignments_exactly_one_target",
      sql`num_nonnulls(${t.recurringId}, ${t.bookingId}) = 1`,
    ),
  ],
);

// One row per time a slot was offered to a student — whether the coach sent it by hand from
// Day view (Phase 1a) or an automated fill-a-cancellation batch generated it (Phase 2).
// One table, not two: the cases differ only in what's being offered and in whether a reply
// can come back.
export const offers = pgTable(
  "offers",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "cascade" }),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    // Populated in every case, including the freed-lesson one, so the table is queryable by
    // time without joining out to bookings.
    date: date().notNull(),
    startTime: time().notNull(),
    // The horse that made this student eligible for the slot.
    horseId: uuid()
      .notNull()
      .references(() => horses.id, { onDelete: "restrict" }),
    // A window can fit more than one type, so the offer names the one this student matched on.
    lessonTypeId: uuid()
      .notNull()
      .references(() => lessonTypes.id, { onDelete: "restrict" }),
    // Set only when the offer is a specific freed lesson. Null for a Phase 1a gap-fill offer,
    // since no booking exists for an open window.
    lessonId: uuid().references(() => bookings.id, { onDelete: "set null" }),

    // Which of the student's windows the slot matched *at the moment of the offer*. Not
    // derivable later — the student can edit their windows — and a `potential` match is
    // precisely the discount case.
    kind: ridingWindowKind().notNull(),
    // The discount the coach attached, or null for a full-price offer. This is what makes
    // `kind` load-bearing rather than analytical: the amount agreed at the moment of the offer
    // is what has to land on the booking if the student takes it. Without it the discount
    // lives only in the sent message and the booking prices itself at full rate.
    offerDiscount: integer(),
    // The coach's own words, carried into the outbound message and onto the booking's notes on
    // acceptance. A discount whose reason isn't captured when it's given gets reconstructed
    // later, badly.
    offerReason: text(),
    offeredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Empty in Phase 1a: there's no reply channel yet. Whether the offer converted is derived
    // — a booking for that student at that date and time means it did.
    response: offerResponse(),
    // The student's position in the ranked list when the batch was sent; 1 is the strongest
    // match. Null for a one-at-a-time offer made from a Student profile.
    rank: integer(),
  },
  (t) => [
    // Constraint #2: a student cannot be offered the same slot twice — the exact query
    // Section 8 names as the reason this table exists, so the same 9am Thursday can't be
    // pushed at the same rider three days running.
    unique("offers_one_per_student_slot").on(t.studentId, t.date, t.startTime),
    index("offers_trainer_date_idx").on(t.trainerId, t.date),
    check(
      "offers_discount_non_negative",
      sql`${t.offerDiscount} is null or ${t.offerDiscount} >= 0`,
    ),
    check("offers_rank_positive", sql`${t.rank} is null or ${t.rank} >= 1`),
  ],
);
