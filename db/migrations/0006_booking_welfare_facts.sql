-- Stamp each booking with its own saddle time and whether its rider was an adult.
--
-- The third and last exception to derive-don't-store, argued in Section 9 of
-- product-foundations.md and in SCHEMA-NOTES §15. The short version:
--
-- Welfare counts every lesson the animal did, whoever booked it, so `bookings` is read
-- ACCOUNT-wide. But `horse_minutes_on_date` resolved each lesson's duration by looking its type
-- up in `lesson_types`, and lesson types are TRAINER-scoped — by design, and by policy. A
-- barn-mate's lesson therefore had a type the reader could not see, resolved to nothing, and
-- contributed ZERO minutes. A horse ridden 45 minutes by each of two coaches reported 45. The
-- adult cap had the same hole twice over, resolving the rider through trainer-scoped `students`.
--
-- What makes recomputation wrong here is not drift, which is what rules out stored counters
-- generally. It is PERMISSION: the reader is not allowed to see the table the answer lives in,
-- and never will be. And unlike a counter these cannot go stale, because the lesson they
-- describe is over.
--
-- Note what the backfill demonstrates. It runs as the OWNER, which can see every lesson type and
-- every student — the credential the application is forbidden. That the repair is trivial here
-- and impossible in the app is the whole shape of the problem.

--> statement-breakpoint
-- Nullable first: there are existing rows, and a NOT NULL column with no default cannot be added
-- to a non-empty table. Tightened at the end, once every row has a value.
ALTER TABLE "bookings" ADD COLUMN "ride_time_min" integer;

--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "rider_was_adult" boolean;

--> statement-breakpoint
-- Saddle time, not calendar time: `ride_time_min`, never `duration_min`. Conflating them is the
-- mistake the engine's comments warn about in two places — one overbooks the coach's day, the
-- other misjudges how hard the horse worked.
UPDATE "bookings" b
   SET "ride_time_min" = lt."ride_time_min"
  FROM "lesson_types" lt
 WHERE lt."id" = b."lesson_type_id"
   AND b."ride_time_min" IS NULL;

--> statement-breakpoint
-- 18 is the same cutoff `adult_only` pairing and SMS routing use, so "adult" has one definition
-- across the system rather than three that happen to agree.
UPDATE "bookings" b
   SET "rider_was_adult" = (s."age" >= 18)
  FROM "students" s
 WHERE s."id" = b."student_id"
   AND b."rider_was_adult" IS NULL;

--> statement-breakpoint
-- Both foreign keys are NOT NULL and both referenced rows are RESTRICT-protected, so every
-- booking resolves and nothing is left behind. If that were ever untrue these statements would
-- fail here rather than leaving a NULL to be discovered later as another silent zero.
ALTER TABLE "bookings" ALTER COLUMN "ride_time_min" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "rider_was_adult" SET NOT NULL;

--> statement-breakpoint
-- A lesson cannot be ridden for a negative number of minutes, and zero would silently reproduce
-- the very bug this migration closes.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_ride_time_positive"
  CHECK ("ride_time_min" > 0);

--> statement-breakpoint
COMMENT ON COLUMN "bookings"."ride_time_min" IS
  'Stamped at creation, never recomputed. Welfare reads bookings account-wide and cannot see another trainer''s lesson types.';

--> statement-breakpoint
COMMENT ON COLUMN "bookings"."rider_was_adult" IS
  'Stamped at creation. Same reason: the adult cap cannot resolve another trainer''s students.';
