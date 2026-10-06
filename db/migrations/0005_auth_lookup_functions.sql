-- The hole that signing in requires, cut as narrowly as it can be cut.
--
-- 0004 added the two auth tables and said, correctly, that they carry no RLS because resolving
-- identity is what PRODUCES the tenant. It missed the other half: resolving identity also has to
-- read `trainers`, and `trainers` IS tenant-scoped. Its policy reads `app.trainer_id`, which at
-- login time is not set — so the lookup matched zero rows and every sign-in silently failed with
-- the server cheerfully answering "check your email". Found by trying to sign in.
--
-- Three ways out, and why this one:
--
--   Query as the OWNER. Works immediately, and breaks the rule that matters most here — the
--   owner carries BYPASSRLS and is a migration credential, never an application one. A login
--   path holding it is a login path that can read every barn on the platform.
--
--   Loosen the policy on `trainers` so the app role can read it untenanted. That opens the whole
--   table to every request, not just to the login path, and `trainers` is where emails live.
--
--   A SECURITY DEFINER function, which is this. It runs with the DEFINER's privileges rather
--   than the caller's, so it alone may see across tenants; it returns four columns and no more;
--   and `rydeahorse_app` is granted EXECUTE on it and nothing else. The hole is one function
--   wide, its shape is visible in its signature, and the application role still cannot SELECT
--   from `trainers` untenanted.
--
-- `SET search_path` on both is not decoration. A SECURITY DEFINER function without it resolves
-- unqualified names using the CALLER's search_path, so a caller who can create objects can put
-- their own `trainers` in front of the real one and have it read with the definer's rights.

--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_trainer_by_email(p_email text)
RETURNS TABLE (id uuid, account_id uuid, name text, email text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.account_id, t.name, t.email
    FROM trainers t
   WHERE lower(t.email) = lower(p_email)
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_trainer_by_id(p_id uuid)
RETURNS TABLE (id uuid, account_id uuid, name text, email text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.account_id, t.name, t.email
    FROM trainers t
   WHERE t.id = p_id
$$;

--> statement-breakpoint
-- EXECUTE is granted deliberately rather than inherited. PUBLIC gets execute on new functions by
-- default, which for a SECURITY DEFINER function means anyone who can connect can call it — so
-- the revoke is the load-bearing statement here and the grant is the narrow re-admission.
REVOKE ALL ON FUNCTION auth_trainer_by_email(text) FROM PUBLIC;

--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_trainer_by_id(uuid) FROM PUBLIC;

--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_trainer_by_email(text) TO rydeahorse_app;

--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_trainer_by_id(uuid) TO rydeahorse_app;

--> statement-breakpoint
COMMENT ON FUNCTION auth_trainer_by_email(text) IS
  'Login only. SECURITY DEFINER so it can see across tenants: identity is what produces the tenant, so this runs before one exists.';

--> statement-breakpoint
COMMENT ON FUNCTION auth_trainer_by_id(uuid) IS
  'Session resolution. SECURITY DEFINER for the same reason as auth_trainer_by_email.';
