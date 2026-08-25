// A single current record per trainer, edited in place. One row, not a history.
import {
  pgTable,
  uuid,
  text,
  boolean,
  smallint,
  timestamp,
  unique,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { trainers } from "./tenancy.js";
import { students } from "./students.js";

export const disclosures = pgTable(
  "disclosures",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "cascade" }),
    // Load-bearing rather than decorative: it's the line every "since the terms changed"
    // comparison is drawn against, and what `bookings.created_at` is compared to.
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Coach-authored, required on every save. Riders see it, and telling them what changed is
    // itself one of the terms, so the save is blocked without it. NOT NULL is that rule.
    updateNote: text().notNull(),
    firstPublishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // One row per trainer — "a single current record, edited in place". This unique is also
    // what `disclosure_sections.trainer_id` points at.
    unique("disclosures_trainer_key").on(t.trainerId),
  ],
);

// Seven rows with stable keys, which is what the keys were always for: a coach who puts "Risk
// of injury" into her own voice hasn't created a different section.
//
// schema.md names this table's columns as (trainer_id, key, title, body, included), so
// trainer_id is the link rather than a disclosure_id — which works precisely because
// `disclosures` is unique per trainer, and the FK below targets that unique.
export const disclosureSections = pgTable(
  "disclosure_sections",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid().notNull(),
    // Stable across rewrites. The seventh key, "these terms can change", is the one that
    // governs all the others; the coach's editor carries a warning against weakening it.
    key: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    // Include / don't-include is per section, not global. There is no master
    // `require_disclosures` switch — it existed briefly and was removed when inclusion moved
    // to the section, because two controls that both mean "collect nothing" can disagree.
    // "Collect nothing" is now simply the state where no section is included.
    included: boolean().notNull().default(true),
    // Display order. Not in the spec, but the seven sections have an order a rider reads them
    // in, and the alternative is hard-coding that order in the app — which puts the sequence
    // somewhere the coach's editor can't reach.
    position: smallint().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.trainerId],
      foreignColumns: [disclosures.trainerId],
      name: "disclosure_sections_trainer_fk",
    }).onDelete("cascade"),
    unique("disclosure_sections_key_per_trainer").on(t.trainerId, t.key),
  ],
);

// One row per rider, written when they create their profile. There is nothing to re-sign —
// no version to point at, and no re-acceptance flow. What keeps a rider current is continuing
// to book under the terms in force.
export const disclosureAcceptances = pgTable(
  "disclosure_acceptances",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid()
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    acceptedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // The name as entered on the profile at the moment of signing, since a rider can rename
    // themselves later and the signature should read as given.
    signedName: text().notNull(),
  },
  (t) => [
    // "One row per rider" made structural. Switching sections off never erases a signature
    // already given — the Agreements tab still shows a rider when they signed.
    unique("disclosure_acceptances_student_key").on(t.studentId),
    index("disclosure_acceptances_accepted_idx").on(t.acceptedAt),
  ],
);
