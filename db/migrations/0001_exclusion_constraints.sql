-- Hand-written. drizzle-kit has no representation for EXCLUDE constraints, custom range types
-- or extensions, so constraints #1 and #4 from schema.md Section 3 live here rather than in
-- schema/*.js. `drizzle-kit generate` will not re-emit or diff anything in this file — if a
-- constraint below changes, change it here and add a new migration.
--
-- Constraints #2 (offers_one_per_student_slot) and #3 (lesson_types_one_intro_per_trainer)
-- ARE expressible in Drizzle and were generated into 0000_initial_schema.sql.

--> statement-breakpoint
-- Lets a GiST index mix scalar equality (uuid, date, enum) with range overlap in one index,
-- which is what both constraints below need. btree_gist covers uuid, date and all enum types.
CREATE EXTENSION IF NOT EXISTS btree_gist;

--> statement-breakpoint
-- `timerange` is not a built-in Postgres range type — the built-ins are int4range, int8range,
-- numrange, tsrange, tstzrange and daterange, and none of them has `time` as its subtype.
-- schema.md's Section 3 SQL calls timerange(start_time, end_time), so the type has to be
-- created for that SQL to run. Range types get the polymorphic `range_ops` GiST operator
-- class for free, so nothing further is needed to index it.
--
-- A time subtype is the right one here rather than a timestamp: no column in this schema is
-- stored in UTC, `date` and `start_time` are separate columns in the coach's own local time,
-- and both constraints already pin `date` (or day_of_week) with `=`. Overlap is therefore
-- only ever asked within a single day, where a bare time is unambiguous.
CREATE TYPE timerange AS RANGE (subtype = time);

--> statement-breakpoint
-- Constraint #1 — A horse cannot hold two overlapping lessons.
--
-- The reliability promise in Section 5 (*never double-book a horse*) made structurally true
-- rather than conditionally true. The engine validates against the bookings it was handed,
-- which means two people clicking at the same moment can each pass validation against a world
-- that no longer exists by the time either commits. This cannot be bypassed by a race, by a
-- bug in the engine, by a background job, or by someone editing rows by hand.
--
-- The horse half of check #6 never relaxes — every rider needs their own horse, so this is a
-- genuine conflict whether or not the lesson is a group session. The *trainer* half does
-- relax for a below-capacity group and stays in the engine, deliberately.
--
-- Note the scope: `horse_id` alone, with no tenant column. Horses are account-level, so this
-- holds across two trainers sharing a barn — which is the specific failure that made
-- coach-level tenancy untenable (a horse ridden 90 minutes by each is at 180 and no rule
-- knows).
--
-- '[)' bounds: a lesson ending at 10:00 and one starting at 10:00 do not overlap. Any buffer
-- the coach requires between them is a scheduling preference, enforced in the engine, not a
-- welfare constraint.
ALTER TABLE "bookings" ADD CONSTRAINT "horse_not_double_booked"
  EXCLUDE USING gist (
    "horse_id" WITH =,
    "date" WITH =,
    timerange("start_time", "end_time", '[)') WITH &&
  ) WHERE ("status" IN ('pending', 'confirmed'));

--> statement-breakpoint
-- Constraint #4 — Two price bands cannot overlap on a shared day.
--
-- A time falls in exactly zero or one band. Overlapping bands mean two possible prices for one
-- slot, which Section 8 calls the exact failure the pricing model exists to prevent — and
-- worse than having no bands at all, because it looks deliberate.
--
-- Scoped per trainer and per day of week, as specified. It sits on `price_band_windows` rather
-- than `price_bands` because a band is a named thing with one or more day windows here; the
-- denormalised `trainer_id` on the window row exists for exactly this constraint and is held
-- to the band's own trainer by a composite foreign key.
--
-- '[)' again: a band ending at 15:00 and one starting at 15:00 are adjacent, not overlapping,
-- and a 15:00 lesson falls in the second. Section 8 matches a band on the lesson's start time
-- alone, so adjacency has to be expressible or every pair of touching bands would be rejected.
ALTER TABLE "price_band_windows" ADD CONSTRAINT "price_bands_no_overlap"
  EXCLUDE USING gist (
    "trainer_id" WITH =,
    "day_of_week" WITH =,
    timerange("start_time", "end_time", '[)') WITH &&
  );
