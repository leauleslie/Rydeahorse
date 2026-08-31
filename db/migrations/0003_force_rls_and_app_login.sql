-- Close the opt-in gap: make tenant isolation the default rather than something a caller
-- chooses. 0002 put the policies in place; they applied only to callers who deliberately
-- switched into `rydeahorse_app`. A connection that simply queried as the connecting role saw
-- everything, which meant RLS protected the code that already knew about it — the code least
-- likely to need protecting.
--
-- Two changes, and they are NOT equally important. Read the second one.

--> statement-breakpoint
-- 1. FORCE, on exactly the tables 0002 enabled RLS on.
--
-- Derived from the catalogue rather than listed, so this cannot drift from 0002 and so a table
-- added by a later migration is covered when that migration enables RLS on it.
--
-- What this buys: RLS normally does not apply to a table's OWNER. FORCE removes that
-- exemption, so a role that owns these tables is still subject to their policies.
--
-- What this does NOT buy, and the thing to be clear about: `BYPASSRLS` is a separate role
-- attribute that outranks FORCE entirely. On Neon, `neondb_owner` carries it, and cannot drop
-- it (that requires superuser, which Neon does not grant). Applying FORCE therefore changes
-- NOTHING for the migrating role — verified directly: with FORCE on `students`, the owner
-- still saw every trainer's rows.
--
-- So FORCE is defense in depth here, not the fix. It matters if the application role ever
-- comes to own a table, and it makes the ownership exemption unavailable to any future
-- non-bypassing owner. The actual fix is below.
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

--> statement-breakpoint
-- 2. The application connects as its own role. THIS is what closes the gap.
--
-- Isolation cannot be enforced against a caller holding credentials that are allowed to
-- bypass it — no policy, and no amount of FORCE, changes that. It is enforced by not giving
-- the application those credentials. `rydeahorse_app` owns nothing and has no BYPASSRLS, so a
-- query issued on its connection is subject to policy whether or not the author knew RLS
-- existed. A developer who forgets `withTenantTransaction` now gets ZERO ROWS rather than
-- every tenant's.
--
-- The consequence, stated plainly because it will otherwise be discovered at 3am: work that
-- legitimately spans tenants — generating occurrences for every trainer, retention sweeps over
-- alerts, reporting — returns NOTHING under this role. Such jobs must either run on a
-- deliberately separate owner connection, or iterate per tenant and set identity each time.
-- Migrations and seed scripts keep running as the owner and are unaffected.
--
-- No password is set here, deliberately: a credential committed to a migration is a credential
-- in git forever. Set one out of band and put it in the app's DATABASE_URL:
--
--   ALTER ROLE rydeahorse_app WITH PASSWORD '...';
--
-- The test suites never need this. They rotate the password to a random value in memory, as
-- the owner, at setup time — see db/test/app-role.js — so no application credential is ever
-- written to disk in this repository.
ALTER ROLE rydeahorse_app WITH LOGIN;
