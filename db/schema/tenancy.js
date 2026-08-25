// Two levels of tenancy (schema.md Section 1): an `account` owns horses, a `trainer` owns
// everything else. An account with one trainer behaves exactly like coach-level tenancy; an
// account with two shares horses correctly, and the welfare checks work across both without a
// query changing, because they were always scoped to the account.
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { schedulingPreference } from "./enums.js";

export const accounts = pgTable("accounts", {
  id: uuid().primaryKey().defaultRandom(),
  // The facility. A barn name, or a solo coach's own name — an account with one trainer needs
  // nothing configured to behave like the single-coach case.
  name: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const trainers = pgTable(
  "trainers",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    name: text().notNull(),
    // Coaches authenticate by email, separately from the rider side (schema.md Section 4).
    // The credential mechanism itself is unspecified, so no password or magic-link table is
    // invented here — this column is the identifier that mechanism will key on.
    email: text().notNull(),
    phone: text(),
    // IANA zone, e.g. `America/Los_Angeles`. The only place a zone appears in the schema: no
    // column is stored in UTC, because every lesson belongs to exactly one trainer, so a
    // lesson's local time is unambiguous without a zone attached to the row. This is what the
    // outbound-message job converts against when it needs a real instant.
    timezone: text().notNull(),

    // ---- what was `Trainer_Config`, a single-row tab ----
    // Columns on `trainers` rather than a table of its own: a one-row table pretending to be
    // a singleton is a table that eventually gets two rows.
    schedulingPreference: schedulingPreference().notNull().default("spaced"),
    // Always enforced between any two lessons, whatever the preference.
    minBufferMin: integer().notNull().default(0),
    // Only affects what times get *offered*, and only when back_to_back. Null is the honest
    // value under `spaced` — spaced scheduling isn't packing lessons tightly, so there is
    // nothing for a maximum to prevent.
    maxBufferMin: integer(),
    // Independent of the buffers: a hard ceiling on consecutive lessons. Null means none.
    maxBackToBack: integer(),
    // Hours, not days: the boundary that matters is "later today" vs. "tomorrow morning", and
    // a day-granular value can't tell those apart.
    lateCancelHours: integer().notNull().default(24),
    prioritizationRule: text(),
    // Blank switches frequency pricing off entirely — which is how it ships, since the tiers
    // are computed from completed calendar months and on day one there aren't any.
    // `prioritization_rule` shares tier 1's threshold rather than carrying its own number:
    // "frequent rider" has one definition across scheduling flex and pricing.
    frequencyTier1MinRides: integer(),
    frequencyTier2MinRides: integer(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("trainers_email_key").on(t.email),
    // Section 8: tier 2 "must exceed tier 1". Only checkable when both are set; either being
    // blank is a valid state (blank tier 1 switches the mechanism off, blank tier 2 means one
    // tier only).
    check(
      "trainers_tier_2_above_tier_1",
      sql`${t.frequencyTier1MinRides} is null
          or ${t.frequencyTier2MinRides} is null
          or ${t.frequencyTier2MinRides} > ${t.frequencyTier1MinRides}`,
    ),
    check(
      "trainers_buffers_non_negative",
      sql`${t.minBufferMin} >= 0
          and (${t.maxBufferMin} is null or ${t.maxBufferMin} >= ${t.minBufferMin})`,
    ),
    check("trainers_late_cancel_hours_positive", sql`${t.lateCancelHours} > 0`),
  ],
);
