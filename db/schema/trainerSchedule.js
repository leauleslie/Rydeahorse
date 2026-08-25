// The coach's recurring availability pattern, and the overlay that interrupts it.
import {
  pgTable,
  uuid,
  text,
  time,
  date,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { trainers } from "./tenancy.js";
import { dayOfWeek } from "./enums.js";

// A flat list of windows, not one row per day: a day can have zero, one, or several — Mon
// 8am–12pm and Mon 3pm–8pm is a split shift, not a contradiction.
export const trainerAvailability = pgTable(
  "trainer_availability",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "cascade" }),
    dayOfWeek: dayOfWeek().notNull(),
    // Local time, exactly as the coach entered it. No zone: the trainer carries it.
    startTime: time().notNull(),
    endTime: time().notNull(),
  },
  (t) => [
    index("trainer_availability_lookup_idx").on(t.trainerId, t.dayOfWeek),
    check("trainer_availability_end_after_start", sql`${t.endTime} > ${t.startTime}`),
    // Availability windows may overlap without producing a wrong answer — check #1 asks
    // whether a time falls within *any* window, so two overlapping windows are just a union.
    // No exclusion constraint here, unlike price bands, where overlap means two prices.
  ],
);

// An overlay on top of the recurring pattern — a two-day vacation — rather than an edit to
// the pattern itself. Bookings inside an active block are flagged `needs_rescheduling`;
// there's no substitute-coach concept, so resolution is always manual.
export const trainerTimeOff = pgTable(
  "trainer_time_off",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "cascade" }),
    startDate: date().notNull(),
    // Inclusive, matching the engine's `date >= startDate && date <= endDate`. A one-day
    // block has start_date = end_date.
    endDate: date().notNull(),
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trainer_time_off_lookup_idx").on(t.trainerId, t.startDate, t.endDate),
    check("trainer_time_off_end_after_start", sql`${t.endDate} >= ${t.startDate}`),
  ],
);
