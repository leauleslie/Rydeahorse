// Coach authentication: issuing a magic link, redeeming it, and the session it opens.
//
// THIS FILE DELIBERATELY DOES NOT GO THROUGH `withTenantTransaction`, and that is the single
// most important thing about it. Every policy from migration 0002 reads `app.trainer_id` to
// decide what a caller may see — and this is the code that works out what `app.trainer_id`
// should be. A lookup that already required a tenant could never run.
//
// So these queries run as `rydeahorse_app` with no tenant set, against two tables that carry no
// RLS policy (see migration 0004 for why that is safe: a hash, an expiry and a foreign key, and
// the hash cannot be replayed). They do NOT use the owner credential — "the owner is a migration
// credential, never an application one" holds here as everywhere else.
//
// Everything downstream of `sessionFor` is unchanged: it hands back a tenant, and the repository
// takes it from there exactly as it did when the tenant was a stub.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Fifteen minutes. Long enough to walk to a laptop, short enough that a link sitting in an
// archive is almost always already dead — and it is single-use regardless.
export const LINK_TTL_MINUTES = 15;

// Thirty days, refreshed on use. A coach's barn is a thing she opens most days; making her
// re-request a link every week would train her to keep one in her inbox, which is the habit this
// mechanism most wants to avoid.
export const SESSION_TTL_DAYS = 30;

// Per coach, per hour. Someone who knows a coach's address should not be able to fill her inbox,
// and the limit is on ISSUING rather than on redeeming because that is the side an attacker
// controls without reading her mail.
export const MAX_LINKS_PER_HOUR = 5;

/**
 * A token the caller sends, and the hash we keep.
 *
 * 32 bytes from the CSPRNG — not a uuid. A uuid v4 carries 122 bits and announces its own shape;
 * this is 256 bits of nothing, and base64url so it survives a URL without escaping.
 */
export function newToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

/**
 * Compare two hashes without leaking, through timing, how far along they first differed.
 *
 * Both are hex SHA-256, so they are the same length whenever the input was a real token — and
 * `timingSafeEqual` throws rather than returning false on a length mismatch, which is why the
 * length is checked first rather than left to it.
 */
export function hashesMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Open a connection, run as the app role, and release it whatever happens.
 *
 * The same discipline as `withRequest` — one connection, released on every path — minus the
 * tenant, which does not exist yet. `SET LOCAL ROLE` still applies: the app must never query as
 * the owner, and "there is no tenant yet" is not a reason to make an exception.
 */
async function withAuthConnection(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await client.query("set local role rydeahorse_app");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Issue a login link for an email address.
 *
 * Returns `{ token, trainer }` when one was issued and `null` when it was not — and the CALLER
 * MUST RESPOND IDENTICALLY EITHER WAY. Whether an address belongs to a coach is not something
 * this endpoint should be willing to confirm: an attacker who can tell "no such coach" from "a
 * link is on its way" can enumerate the barns on the platform from the login form.
 *
 * `null` therefore covers both "no such coach" and "that coach has asked five times this hour",
 * which are different facts the outside world is told nothing about.
 */
export async function issueLoginToken(pool, { email, now = new Date() }) {
  const normalised = String(email ?? "").trim().toLowerCase();
  if (!normalised) return null;

  return withAuthConnection(pool, async (client) => {
    // Through the function, not the table. `trainers` is tenant-scoped and there is no tenant
    // yet — a direct SELECT here matched zero rows and made every sign-in fail silently while
    // the endpoint went on answering "check your email". See migration 0005.
    const { rows: found } = await client.query(
      "select * from auth_trainer_by_email($1)",
      [normalised],
    );
    if (!found.length) return null;
    const trainer = found[0];

    const { rows: recent } = await client.query(
      `select count(*)::int as n from trainer_login_tokens
        where trainer_id = $1 and created_at > $2`,
      [trainer.id, new Date(now.getTime() - 60 * 60 * 1000)],
    );
    if (recent[0].n >= MAX_LINKS_PER_HOUR) return null;

    const { token, hash } = newToken();
    await client.query(
      `insert into trainer_login_tokens (trainer_id, token_hash, expires_at)
       values ($1, $2, $3)`,
      [trainer.id, hash, new Date(now.getTime() + LINK_TTL_MINUTES * 60 * 1000)],
    );
    return { token, trainer };
  });
}

/**
 * Redeem a link and open a session.
 *
 * The token is consumed in the SAME statement that checks it is still valid — `update … where
 * consumed_at is null … returning` — so two requests racing on one link cannot both win. Doing
 * it as a select and then an update leaves exactly that gap, and a magic link is a URL, which
 * means it gets fetched twice by mail scanners and preview bots as a matter of routine.
 */
export async function redeemLoginToken(pool, { token, now = new Date() }) {
  if (!token) return null;
  const hash = hashToken(token);

  return withAuthConnection(pool, async (client) => {
    const { rows: consumed } = await client.query(
      `update trainer_login_tokens
          set consumed_at = $2
        where token_hash = $1 and consumed_at is null and expires_at > $2
        returning trainer_id`,
      [hash, now],
    );
    if (!consumed.length) return null;

    const { rows: who } = await client.query(
      "select * from auth_trainer_by_id($1)", [consumed[0].trainer_id]);
    if (!who.length) return null;

    const session = newToken();
    await client.query(
      `insert into trainer_sessions (trainer_id, token_hash, expires_at) values ($1, $2, $3)`,
      [who[0].id, session.hash, new Date(now.getTime() + SESSION_TTL_DAYS * 86400000)],
    );
    return { sessionToken: session.token, trainer: who[0] };
  });
}

/**
 * Who is holding this session, or null.
 *
 * Also refreshes `last_seen_at` and slides the expiry forward, so a coach using the app daily is
 * not signed out on the thirtieth day for no reason she can see. One statement again, so the
 * read and the refresh cannot disagree.
 */
export async function sessionFor(pool, { token, now = new Date() }) {
  if (!token) return null;
  const hash = hashToken(token);

  return withAuthConnection(pool, async (client) => {
    const { rows } = await client.query(
      `update trainer_sessions
          set last_seen_at = $2, expires_at = $3
        where token_hash = $1 and revoked_at is null and expires_at > $2
        returning trainer_id`,
      [hash, now, new Date(now.getTime() + SESSION_TTL_DAYS * 86400000)],
    );
    if (!rows.length) return null;

    const { rows: who } = await client.query(
      "select * from auth_trainer_by_id($1)", [rows[0].trainer_id]);
    if (!who.length) return null;
    return {
      trainerId: who[0].id,
      accountId: who[0].account_id,
      name: who[0].name,
      email: who[0].email,
    };
  });
}

/** Sign out. Revoking rather than deleting keeps "ended" distinguishable from "never existed". */
export async function revokeSession(pool, { token, now = new Date() }) {
  if (!token) return false;
  const hash = hashToken(token);
  return withAuthConnection(pool, async (client) => {
    const { rowCount } = await client.query(
      "update trainer_sessions set revoked_at = $2 where token_hash = $1 and revoked_at is null",
      [hash, now],
    );
    return rowCount > 0;
  });
}
