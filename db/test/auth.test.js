// Coach sign-in, against a real database.
//
// What these pin is not "does a token round-trip" — it is the handful of properties that make a
// magic link safe rather than merely convenient: that the stored form cannot be replayed, that a
// link works once, that an expired one is dead, that the login form will not tell you whether an
// address belongs to a coach, and that the session it opens produces the RIGHT tenant rather
// than merely A tenant.
//
// The last one is the point of the whole feature. Until this existed the server resolved "the
// first trainer in the database" and every request was that coach.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { connectDrizzle, truncateAll, assertMarked, acquireSuiteLock, releaseSuiteLock } from "./db.js";
import { seedAccounts } from "./seed.js";
import { forTenant, withTenantTransaction } from "../repo/index.js";
import {
  issueLoginToken, redeemLoginToken, sessionFor, revokeSession, hashToken,
  LINK_TTL_MINUTES, MAX_LINKS_PER_HOUR,
} from "../auth.js";

let client, pool, db, alder, birch, a1, a2, b1;

before(async () => {
  // connectDrizzle, not a bare drizzle(client): the handle it builds carries this project's
  // snake_case mapping, and one built by hand queries for a column named "trainerId".
  ({ client, db } = await connectDrizzle());
  await acquireSuiteLock(client);
  await assertMarked(client);
  // The auth functions take a POOL, because in the server they run before any request connection
  // exists. The suite is serial, so one client standing in for a pool is enough — handed back
  // AS ITSELF with a no-op release rather than wrapped, since a pg client keeps state that a
  // prototype-chained copy does not carry and the copy simply hung.
  client.release = () => {};
  pool = { connect: async () => client };
});

after(async () => {
  if (client) await releaseSuiteLock(client).catch(() => {});
  await client?.end();
});

beforeEach(async () => {
  await truncateAll(client);
  ({ alder, birch } = await seedAccounts(client));
  [a1, a2] = alder.trainers;
  [b1] = birch.trainers;
});

const emailOf = async (trainerId) =>
  (await client.query("select email from trainers where id = $1", [trainerId])).rows[0].email;

describe("asking for a link", () => {
  test("an address that belongs to a coach gets one", async () => {
    const issued = await issueLoginToken(pool, { email: await emailOf(a1.trainerId) });
    assert.ok(issued?.token, "a token comes back for the caller to put in a link");
    assert.equal(issued.trainer.id, a1.trainerId);
  });

  test("the address is matched case-insensitively, because email is", async () => {
    const email = await emailOf(a1.trainerId);
    assert.ok(await issueLoginToken(pool, { email: email.toUpperCase() }));
    assert.ok(await issueLoginToken(pool, { email: `  ${email}  ` }), "and trimmed");
  });

  test("an address that belongs to nobody gets nothing, and says nothing", async () => {
    // null covers "no such coach" AND "asked too often" — the caller answers 202 either way, so
    // the login form cannot be used to enumerate the barns on the platform one address at a time.
    assert.equal(await issueLoginToken(pool, { email: "stranger@example.test" }), null);
    assert.equal(await issueLoginToken(pool, { email: "" }), null);
  });

  test("the RAW token is never stored — only something that cannot be replayed", async () => {
    const { token } = await issueLoginToken(pool, { email: await emailOf(a1.trainerId) });
    const { rows } = await client.query("select token_hash from trainer_login_tokens");
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, token, "a dump must not contain anything usable");
    assert.equal(rows[0].token_hash, hashToken(token));
  });

  test("a coach cannot have her inbox filled from the login form", async () => {
    const email = await emailOf(a1.trainerId);
    for (let i = 0; i < MAX_LINKS_PER_HOUR; i++) {
      assert.ok(await issueLoginToken(pool, { email }), `request ${i + 1} should be allowed`);
    }
    assert.equal(await issueLoginToken(pool, { email }), null, "and the next one is not");
    // The limit is per coach: it must not lock out the barn next door.
    assert.ok(await issueLoginToken(pool, { email: await emailOf(b1.trainerId) }));
  });
});

describe("redeeming a link", () => {
  const linkFor = async (trainerId) =>
    (await issueLoginToken(pool, { email: await emailOf(trainerId) })).token;

  test("a good link opens a session for the coach it was issued to", async () => {
    const token = await linkFor(a1.trainerId);
    const opened = await redeemLoginToken(pool, { token });
    assert.ok(opened?.sessionToken);
    assert.equal(opened.trainer.id, a1.trainerId);
  });

  test("a link works ONCE", async () => {
    // A magic link is a URL, and URLs get fetched twice as a matter of routine — by mail
    // scanners, by link previews, by a coach who taps back. The second fetch must not open a
    // second session, and the consume is part of the same statement as the check so that two
    // racing requests cannot both win.
    const token = await linkFor(a1.trainerId);
    assert.ok(await redeemLoginToken(pool, { token }));
    assert.equal(await redeemLoginToken(pool, { token }), null);
  });

  test("an expired link is dead", async () => {
    const token = await linkFor(a1.trainerId);
    const later = new Date(Date.now() + (LINK_TTL_MINUTES + 1) * 60 * 1000);
    assert.equal(await redeemLoginToken(pool, { token, now: later }), null);
  });

  test("a token nobody issued is refused", async () => {
    assert.equal(await redeemLoginToken(pool, { token: "not-a-real-token" }), null);
    assert.equal(await redeemLoginToken(pool, { token: null }), null);
  });

  test("the session token is stored hashed too", async () => {
    const opened = await redeemLoginToken(pool, { token: await linkFor(a1.trainerId) });
    const { rows } = await client.query("select token_hash from trainer_sessions");
    assert.notEqual(rows[0].token_hash, opened.sessionToken);
    assert.equal(rows[0].token_hash, hashToken(opened.sessionToken));
  });
});

describe("the session, and the tenant it produces", () => {
  const sessionFrom = async (trainerId) => {
    const token = (await issueLoginToken(pool, { email: await emailOf(trainerId) })).token;
    return (await redeemLoginToken(pool, { token })).sessionToken;
  };

  test("a session resolves to the coach who signed in — not to the first one in the table", async () => {
    // The whole point. The server used to answer `select … from trainers order by created_at
    // limit 1`, so every request was coach number one whoever was holding the laptop.
    const second = await sessionFor(pool, { token: await sessionFrom(a2.trainerId) });
    assert.equal(second.trainerId, a2.trainerId);
    assert.equal(second.accountId, alder.accountId);

    const other = await sessionFor(pool, { token: await sessionFrom(b1.trainerId) });
    assert.equal(other.trainerId, b1.trainerId);
    assert.notEqual(other.accountId, alder.accountId);
  });

  test("the tenant it produces scopes the repository", async () => {
    // End to end, through the thing the session exists to feed: sign in as one coach and the
    // roster is hers. Two trainers in ONE account still see different riders, which is the
    // scoping rule a session could most easily get wrong by handing back the account alone.
    const asCoach = async (trainerId) => {
      const tenant = await sessionFor(pool, { token: await sessionFrom(trainerId) });
      const repo = forTenant(db, { ...tenant, client });
      return withTenantTransaction(client, tenant, () => repo.students.list());
    };
    const mine = (await asCoach(a1.trainerId)).map((s) => s.id).sort();
    const theirs = (await asCoach(a2.trainerId)).map((s) => s.id).sort();

    assert.ok(mine.length > 0 && theirs.length > 0, "both have riders, or this proves nothing");
    assert.deepEqual(
      mine.filter((id) => theirs.includes(id)), [],
      "two coaches in one barn share horses, never riders",
    );
  });

  test("an unknown session token is nobody", async () => {
    assert.equal(await sessionFor(pool, { token: "made-up" }), null);
    assert.equal(await sessionFor(pool, { token: null }), null);
  });

  test("signing out ends it", async () => {
    const token = await sessionFrom(a1.trainerId);
    assert.ok(await sessionFor(pool, { token }));
    assert.equal(await revokeSession(pool, { token }), true);
    assert.equal(await sessionFor(pool, { token }), null);
    // Revoked rather than deleted, so "this session ended" stays distinguishable from "this
    // session never existed" when something has to be explained.
    const { rows } = await client.query("select revoked_at from trainer_sessions");
    assert.ok(rows[0].revoked_at);
  });

  test("a session that has lapsed is nobody, even unrevoked", async () => {
    const token = await sessionFrom(a1.trainerId);
    await client.query("update trainer_sessions set expires_at = now() - interval '1 day'");
    assert.equal(await sessionFor(pool, { token }), null);
  });

  test("using a session slides its expiry forward", async () => {
    // So a coach who opens the app most days is never signed out on the thirtieth for a reason
    // she cannot see.
    const token = await sessionFrom(a1.trainerId);
    const before = (await client.query("select expires_at from trainer_sessions")).rows[0].expires_at;
    await sessionFor(pool, { token, now: new Date(Date.now() + 60_000) });
    const after = (await client.query("select expires_at from trainer_sessions")).rows[0].expires_at;
    assert.ok(after > before, "the window moves with use");
  });
});
