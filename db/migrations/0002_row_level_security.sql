-- Row-Level Security. Tenant isolation moved from application convention into the database,
-- for the same reason `horse_not_double_booked` is a constraint rather than an engine check:
-- the repository can only be trusted while every read goes through it, and the first query
-- that does not is silent. A policy holds whatever the caller does.
--
-- Hand-written, like 0001 — drizzle-kit has no representation for roles, policies or
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY, so `drizzle-kit generate` will neither re-emit
-- nor diff any of this. Changing a policy means writing a new migration by hand.

--> statement-breakpoint
-- The tenant identity, read from transaction-local settings.
--
-- `current_setting(..., true)` returns NULL rather than raising when the setting is absent,
-- and NULL = anything is NULL, not true — so a caller who never identified themselves matches
-- no rows. This is the fail-closed property the whole design rests on: forgetting to set the
-- tenant returns NOTHING, never everything.
--
-- STABLE, not IMMUTABLE: the value is fixed within a statement but changes between
-- transactions, and marking it IMMUTABLE would let the planner cache it across them.
CREATE OR REPLACE FUNCTION app_current_account() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.account_id', true), '')::uuid $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_trainer() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.trainer_id', true), '')::uuid $$;

--> statement-breakpoint
-- The role the application runs as.
--
-- It exists because RLS does not apply to a table's OWNER, and on Neon the owner
-- (`neondb_owner`) additionally carries BYPASSRLS. Policies are therefore completely inert for
-- the role that runs migrations — every policy below would be dead code if the app kept using
-- it. Enforcement requires a role that is neither the owner nor BYPASSRLS.
--
-- NOLOGIN: nothing connects as this role directly here. Callers connect as usual and then
-- `SET LOCAL ROLE rydeahorse_app` inside their transaction, which switches the effective user
-- for exactly that transaction and is reverted on COMMIT or ROLLBACK — the same pooler-safe
-- lifetime as the settings above. A deployment that prefers a real login role can add LOGIN
-- and a password without changing a single policy.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rydeahorse_app') THEN
    CREATE ROLE rydeahorse_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO rydeahorse_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rydeahorse_app;
--> statement-breakpoint
-- So a table added by a later migration is not silently unreachable by the app.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rydeahorse_app;

--> statement-breakpoint
-- Whoever runs this migration must be able to SET ROLE to it.
DO $$
BEGIN
  EXECUTE format('GRANT rydeahorse_app TO %I', current_user);
END $$;

--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- ACCOUNT-SCOPED. A horse is a physical animal at a facility; two coaches sharing a barn
-- share it, and share its usage. These policies must NOT narrow to the trainer, or the
-- welfare rules would run on half of a horse's saddle time — the failure that made
-- coach-level tenancy untenable.
-- ---------------------------------------------------------------------------
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "accounts_tenant" ON "accounts" FOR ALL
  USING ("id" = app_current_account()) WITH CHECK ("id" = app_current_account());

--> statement-breakpoint
ALTER TABLE "trainers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trainers_tenant" ON "trainers" FOR ALL
  USING ("account_id" = app_current_account()) WITH CHECK ("account_id" = app_current_account());

--> statement-breakpoint
ALTER TABLE "horses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "horses_tenant" ON "horses" FOR ALL
  USING ("account_id" = app_current_account()) WITH CHECK ("account_id" = app_current_account());

--> statement-breakpoint
ALTER TABLE "horse_inactive_periods" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "horse_inactive_periods_tenant" ON "horse_inactive_periods" FOR ALL
  USING ("account_id" = app_current_account()) WITH CHECK ("account_id" = app_current_account());

--> statement-breakpoint
-- `bookings` is account-scoped here even though the table carries `trainer_id`, and that is a
-- deliberate judgment rather than an oversight. Horse welfare — rest days, daily saddle-time
-- caps — counts every lesson the animal did that day regardless of which coach booked it, so
-- a trainer-scoped policy would make the welfare rules structurally unable to see half their
-- input. RLS cannot tell "reading for the welfare check" from "reading for the day view".
-- The day view's trainer narrowing therefore stays in the repository, where it always was;
-- what RLS adds is that no query can reach ANOTHER ACCOUNT'S lessons.
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "bookings_tenant" ON "bookings" FOR ALL
  USING ("trainer_id" IN (SELECT "id" FROM "trainers" WHERE "account_id" = app_current_account()))
  WITH CHECK ("trainer_id" IN (SELECT "id" FROM "trainers" WHERE "account_id" = app_current_account()));

--> statement-breakpoint
ALTER TABLE "substitution_assignments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "substitution_assignments_tenant" ON "substitution_assignments" FOR ALL
  USING ("substitute_horse_id" IN (SELECT "id" FROM "horses" WHERE "account_id" = app_current_account()))
  WITH CHECK ("substitute_horse_id" IN (SELECT "id" FROM "horses" WHERE "account_id" = app_current_account()));

--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- TRAINER-SCOPED, by a direct trainer_id. Students are trainer-scoped, not account-scoped: a
-- rider taking lessons from two coaches is two rows, and each coach reviews the profile she
-- was given. Sharing a barn does not mean sharing a roster.
-- ---------------------------------------------------------------------------
ALTER TABLE "students" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "students_tenant" ON "students" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
ALTER TABLE "lesson_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "lesson_types_tenant" ON "lesson_types" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
ALTER TABLE "lesson_type_band_adjustments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "lesson_type_band_adjustments_tenant" ON "lesson_type_band_adjustments" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
ALTER TABLE "price_bands" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "price_bands_tenant" ON "price_bands" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
ALTER TABLE "price_band_windows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "price_band_windows_tenant" ON "price_band_windows" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
ALTER TABLE "trainer_availability" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trainer_availability_tenant" ON "trainer_availability" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
ALTER TABLE "trainer_time_off" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trainer_time_off_tenant" ON "trainer_time_off" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
ALTER TABLE "recurring_bookings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "recurring_bookings_tenant" ON "recurring_bookings" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "offers_tenant" ON "offers" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
ALTER TABLE "message_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "message_log_tenant" ON "message_log" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
ALTER TABLE "disclosures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "disclosures_tenant" ON "disclosures" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
ALTER TABLE "disclosure_sections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "disclosure_sections_tenant" ON "disclosure_sections" FOR ALL
  USING ("trainer_id" = app_current_trainer()) WITH CHECK ("trainer_id" = app_current_trainer());

--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- TRAINER-SCOPED, reached only through `students`. These four tables carry no tenant column
-- at all, which makes them the easiest to scope wrongly in application code and the most
-- damaging when it happens — they are a rider's alerts, notes, availability and safety list.
-- ---------------------------------------------------------------------------
ALTER TABLE "student_alerts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "student_alerts_tenant" ON "student_alerts" FOR ALL
  USING ("student_id" IN (SELECT "id" FROM "students" WHERE "trainer_id" = app_current_trainer()))
  WITH CHECK ("student_id" IN (SELECT "id" FROM "students" WHERE "trainer_id" = app_current_trainer()));

--> statement-breakpoint
ALTER TABLE "student_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "student_notes_tenant" ON "student_notes" FOR ALL
  USING ("student_id" IN (SELECT "id" FROM "students" WHERE "trainer_id" = app_current_trainer()))
  WITH CHECK ("student_id" IN (SELECT "id" FROM "students" WHERE "trainer_id" = app_current_trainer()));

--> statement-breakpoint
ALTER TABLE "student_riding_windows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "student_riding_windows_tenant" ON "student_riding_windows" FOR ALL
  USING ("student_id" IN (SELECT "id" FROM "students" WHERE "trainer_id" = app_current_trainer()))
  WITH CHECK ("student_id" IN (SELECT "id" FROM "students" WHERE "trainer_id" = app_current_trainer()));

--> statement-breakpoint
ALTER TABLE "student_no_ride_horses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "student_no_ride_horses_tenant" ON "student_no_ride_horses" FOR ALL
  USING ("student_id" IN (SELECT "id" FROM "students" WHERE "trainer_id" = app_current_trainer()))
  WITH CHECK ("student_id" IN (SELECT "id" FROM "students" WHERE "trainer_id" = app_current_trainer()));

--> statement-breakpoint
ALTER TABLE "disclosure_acceptances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "disclosure_acceptances_tenant" ON "disclosure_acceptances" FOR ALL
  USING ("student_id" IN (SELECT "id" FROM "students" WHERE "trainer_id" = app_current_trainer()))
  WITH CHECK ("student_id" IN (SELECT "id" FROM "students" WHERE "trainer_id" = app_current_trainer()));

--> statement-breakpoint
ALTER TABLE "lesson_type_restricted_horses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "lesson_type_restricted_horses_tenant" ON "lesson_type_restricted_horses" FOR ALL
  USING ("lesson_type_id" IN (SELECT "id" FROM "lesson_types" WHERE "trainer_id" = app_current_trainer()))
  WITH CHECK ("lesson_type_id" IN (SELECT "id" FROM "lesson_types" WHERE "trainer_id" = app_current_trainer()));

-- ---------------------------------------------------------------------------
-- DELIBERATELY NOT under RLS: `auth_identities` and `auth_codes`.
--
-- They carry no tenant column because they legitimately span tenants — one phone number can
-- hold profiles under several trainers, and "one code surfaces every profile attached to a
-- number" is the behaviour Section 11 specifies. Scoping them to a trainer would break that
-- lookup, and scoping them to an account would be a lie about what they contain. They hold no
-- roster data: an identity row is a phone number and a verification state. Authorisation for
-- them belongs in the auth flow, which is not built yet.
-- ---------------------------------------------------------------------------
