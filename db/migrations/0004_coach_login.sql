-- Coach authentication: a magic link, and the session it opens.
--
-- SCHEMA-NOTES §5 left this open between a magic link, a password and an external IdP, and
-- blocking on it. Taking the magic link, for three reasons:
--
--   1. There is no secret for the coach to remember, reuse from another site, or be phished out
--      of in a form. The thing she types is her own email address.
--   2. No password column means no hash to choose, no reset flow to build, and nothing in a
--      database dump that is worth stealing — a stolen hash is a standing offer; a stolen
--      fifteen-minute token that has already been used is nothing.
--   3. `trainers.email` is already the identifier and is already unique. Nothing is invented.
--
-- What it costs, stated plainly: the coach's email account becomes the thing that protects her
-- barn, and she cannot sign in without reaching her mail. That is the trade a password avoids by
-- adding a secret, and the one an IdP avoids by adding a dependency.
--
-- Hand-written rather than generated, as 0001-0003 were: drizzle-kit has no representation for
-- the comments below, and re-emitting this file is not something a later `generate` should do.

--> statement-breakpoint
-- A link that has been issued. One row per request, hashed, short-lived, single use.
CREATE TABLE "trainer_login_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trainer_id" uuid NOT NULL REFERENCES "trainers"("id") ON DELETE CASCADE,
  -- The SHA-256 of the token, never the token. The raw value exists in the link that was sent
  -- and nowhere else, so a dump, a log line or a backup carries nothing that can be replayed.
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  -- Single use. A link that has been redeemed is spent even though the mail it arrived in is
  -- still sitting in an archive, forwarded, or quoted in a reply.
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trainer_login_tokens_hash_key" UNIQUE ("token_hash")
);

--> statement-breakpoint
-- Indexed on (trainer, created_at) because the rate limit counts recent requests for one coach,
-- which is the only question asked of this table other than "redeem this hash".
CREATE INDEX "trainer_login_tokens_trainer_idx"
  ON "trainer_login_tokens" ("trainer_id", "created_at");

--> statement-breakpoint
-- A session a redeemed link opened.
CREATE TABLE "trainer_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trainer_id" uuid NOT NULL REFERENCES "trainers"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  -- Signing out sets this rather than deleting the row, so "this session ended" stays
  -- distinguishable from "this session never existed" when something has to be explained.
  "revoked_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trainer_sessions_hash_key" UNIQUE ("token_hash")
);

--> statement-breakpoint
CREATE INDEX "trainer_sessions_trainer_idx"
  ON "trainer_sessions" ("trainer_id", "expires_at");

--> statement-breakpoint
-- NO ROW-LEVEL SECURITY ON EITHER TABLE, and that is deliberate rather than forgotten.
--
-- Every policy from 0002 reads `app.trainer_id` to decide what a caller may see. These two
-- tables are what ESTABLISHES that value, so a policy depending on it could never be satisfied:
-- the session lookup runs before any tenant exists, and would match zero rows forever.
--
-- That is safe here only because of what they hold. Neither carries tenant data — a hash, an
-- expiry and a foreign key — and the hash cannot be replayed. The row a caller could read
-- without permission tells them that a session exists, not whose it is or how to use it.
--
-- They are still reachable only by `rydeahorse_app`: the grant comes from the ALTER DEFAULT
-- PRIVILEGES in 0002, which is exactly why that statement was written rather than a one-off
-- grant over the tables that existed at the time.
COMMENT ON TABLE "trainer_login_tokens" IS
  'Magic-link tokens, hashed. Not tenant-scoped: resolving identity is what produces the tenant.';

--> statement-breakpoint
COMMENT ON TABLE "trainer_sessions" IS
  'Coach sessions, hashed. Not tenant-scoped: looked up before any tenant is known.';
