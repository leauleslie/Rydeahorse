// The HTTP layer, and deliberately the thinnest thing in the repo.
//
// It does three things: work out which tenant is asking, hand that to `withRequest`, and turn
// the result into JSON. No rule is evaluated here and no query is written here — if either
// appears in this file, it belongs in `engine/` or `db/repo/` instead.
//
// Every handler runs inside `withRequest`, which is the only shape under which the row-level
// security policies apply. A handler that reached for the pool directly would still work and
// would silently see nothing, which is why there is exactly one way in.
import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../db/request.js";
import { forTenant } from "../db/repo/index.js";
import { BookingRejected, SlotTaken, BookingBusy } from "../db/repo/writes.js";
import {
  issueLoginToken, redeemLoginToken, sessionFor, revokeSession, LINK_TTL_MINUTES,
} from "../db/auth.js";
import {
  toDate, toEngineRecurring, fromEngineStudentPatch, fromEngineAvailability,
  fromEngineHorse, fromEngineOffer,
} from "../db/repo/to-engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const envLocal = join(here, "..", ".env.local");
if (existsSync(envLocal)) process.loadEnvFile(envLocal);

// Required explicitly, with no fallback to DATABASE_URL.
//
// Not an oversight — the app and the tests must never be one careless variable away from each
// other, and production is not migrated to 0002/0003 yet, so it has neither the policies nor
// the app role this server depends on. Point APP_DATABASE_URL wherever you are developing
// against and say so out loud.
const connectionString = process.env.APP_DATABASE_URL;
if (!connectionString) {
  console.error(
    "APP_DATABASE_URL is not set.\n\n" +
      "This server will not fall back to DATABASE_URL: the app and the test suites must never\n" +
      "be one variable away from each other. For local development, set it to the branch you\n" +
      "want to work against — the test branch is fine, as long as you know `npm test` in db/\n" +
      "truncates it.\n\n" +
      "  APP_DATABASE_URL=\"$TEST_DATABASE_URL\" npm run dev\n",
  );
  process.exit(1);
}

const runtime = createRuntime({ connectionString });
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------
//
// Was a STUB that resolved the first trainer in the database and served every request as that
// coach. It is now a session, and this is the only part of the server that changed: everything
// downstream already took the tenant as an argument, which is what made the stub survivable in
// the first place and what makes replacing it this small.

const SESSION_COOKIE = "rydeahorse_session";

// Set once the app is served over TLS. Marking a cookie Secure on plain http means the browser
// simply never sends it back, so this follows deployment rather than leading it.
const SECURE_COOKIES = process.env.NODE_ENV === "production";

/** Read one cookie, without pulling in a parser for a header this simple. */
function cookieFrom(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, { days = 30 } = {}) {
  res.append("Set-Cookie", [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    // httpOnly: script on the page cannot read it, so an XSS cannot walk away with the session.
    "HttpOnly",
    // Lax, not Strict: the coach arrives by clicking a link in her email, which is a
    // cross-site navigation, and Strict would withhold the cookie on exactly that first request.
    "SameSite=Lax",
    `Max-Age=${days * 86400}`,
    ...(SECURE_COOKIES ? ["Secure"] : []),
  ].join("; "));
}

function clearSessionCookie(res) {
  res.append("Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` +
    (SECURE_COOKIES ? "; Secure" : ""));
}

const handler = (fn) => async (req, res) => {
  try {
    const tenant = await sessionFor(runtime.pool, { token: cookieFrom(req, SESSION_COOKIE) });
    if (!tenant) {
      // 401, not a redirect: every one of these is an API call made by a page that is already
      // loaded, and the page is what decides to show the sign-in screen.
      return res.status(401).json({ error: "not_signed_in" });
    }
    const result = await runtime.run(tenant, (repo) => fn({ repo, req, tenant }));
    res.json(result ?? { ok: true });
  } catch (err) {
    if (err instanceof BookingRejected) {
      // 422: understood, and refused for stated reasons.
      return res.status(422).json({ error: "booking_rejected", checks: err.checks, failed: err.failed });
    }
    if (err instanceof SlotTaken) {
      // 409: it was free when the engine looked, and taken by the time we wrote.
      return res.status(409).json({ error: "slot_taken", message: err.message });
    }
    if (err instanceof BookingBusy) {
      return res.status(503).json({ error: "busy", message: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
};

/**
 * Is the server up and can it reach the database?
 *
 * Unauthenticated on purpose, and it exists because `start.command` needs an honest readiness
 * check. It used to probe /api/bootstrap, which answered 200 while there was no sign-in — and
 * the moment there was one it answered 401 and the launcher waited forever for a server that
 * was already working. "Can I serve a request" and "are you allowed to see the barn" are two
 * different questions and now have two different endpoints.
 *
 * It reports nothing about who is signed in, and nothing about the data.
 */
app.get("/api/health", async (_req, res) => {
  try {
    const client = await runtime.pool.connect();
    try {
      await client.query("select 1");
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------
//
// These four are the only routes that do NOT go through `handler`: they are what produces the
// session `handler` requires, so wrapping them in it would be circular.

/**
 * Ask for a link.
 *
 * ALWAYS 202, whatever happened. Whether an address belongs to a coach is not something this
 * endpoint will confirm — telling "no such coach" apart from "a link is on its way" lets anyone
 * with the login form enumerate the barns on the platform. The rate limit hides behind the same
 * answer, for the same reason.
 */
app.post("/api/auth/request-link", async (req, res) => {
  try {
    const issued = await issueLoginToken(runtime.pool, { email: req.body?.email });
    if (issued) {
      const link = `${appOrigin(req)}/api/auth/callback?token=${encodeURIComponent(issued.token)}`;
      // No mail provider is configured yet, so the link goes to the server's own log and the
      // coach is told to look there. That is a development stand-in and it is deliberately
      // loud rather than silent — a login flow that appears to work while sending nothing is
      // worse than one that admits what it is.
      console.log(
        `\n  SIGN-IN LINK for ${issued.trainer.email} (valid ${LINK_TTL_MINUTES} minutes):\n` +
        `  ${link}\n`,
      );
    }
    res.status(202).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

/** Redeem a link. A browser arrives here by navigation, so this redirects rather than answering JSON. */
app.get("/api/auth/callback", async (req, res) => {
  try {
    const opened = await redeemLoginToken(runtime.pool, { token: req.query.token });
    if (!opened) return res.redirect("/?signin=expired");
    setSessionCookie(res, opened.sessionToken);
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.redirect("/?signin=error");
  }
});

/** Who am I — the one call the page makes before deciding whether to show the app. */
app.get("/api/auth/me", async (req, res) => {
  const tenant = await sessionFor(runtime.pool, { token: cookieFrom(req, SESSION_COOKIE) });
  if (!tenant) return res.status(401).json({ error: "not_signed_in" });
  res.json({ trainer: { id: tenant.trainerId, name: tenant.name, email: tenant.email } });
});

app.post("/api/auth/sign-out", async (req, res) => {
  await revokeSession(runtime.pool, { token: cookieFrom(req, SESSION_COOKIE) });
  clearSessionCookie(res);
  res.json({ ok: true });
});

/**
 * Where the link should point.
 *
 * Behind a proxy the request's own host is the proxy's, so the forwarded headers win when they
 * are present. APP_ORIGIN overrides both, which is what a deployment will set.
 */
function appOrigin(req) {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] ?? req.protocol ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Everything the app holds in state, in one round trip.
 *
 * One endpoint rather than a dozen because the client is a single React tree that keeps the
 * whole barn in memory — that is how the prototype was built, and splitting the fetch would
 * mean inventing a loading state per collection for no benefit at this scale. When a screen
 * eventually needs to page, it gets its own endpoint then.
 */
app.get("/api/bootstrap", handler(async ({ repo, req, tenant }) => {
  const isoDate = req.query.date ?? new Date().toISOString().slice(0, 10);
  const date = toDate(isoDate);
  // Sequentially, not in parallel. Every one of these runs on the request's single connection
  // — that is what `withRequest` hands out, and what `SET LOCAL` depends on — and a single
  // node-postgres client executes its queue in order no matter how many callers are waiting.
  // `Promise.all` therefore made this no faster while relying on overlapping queries on one
  // client, which pg@9 removes. See `inSeries` in db/repo/index.js for the same reasoning.
  //
  // Unlike the query builders there, `engineInputsFor` is an ordinary async call that starts
  // the moment it is invoked, so these have to be separate awaits rather than a list.
  const engine = await repo.engineInputsFor(date);
  const recurring = await repo.recurring.list();
  const alerts = await repo.alerts.list();
  const notes = await repo.notes.list();
  const offers = await repo.offers.listOn(isoDate);
  return {
    trainer: { id: tenant.trainerId, name: tenant.name, email: tenant.email },
    // The engine shapes ARE the client's shapes — that is what the mapping layer bought.
    horses: engine.horses,
    students: engine.students,
    lessonTypes: engine.lessonTypes,
    bookings: engine.bookings,
    trainerBookings: engine.trainerBookings,
    availability: engine.availability,
    timeOffBlocks: engine.timeOffBlocks,
    priceBands: engine.priceBands,
    trainerConfig: engine.trainerConfig,
    offers: engine.offers,
    recurring: recurring.map(toEngineRecurring),
    alerts,
    notes,
    serverDate: req.query.date ?? null,
  };
}));

// ---------------------------------------------------------------------------
// Writes. Each is one call into repo.write, which is already transactional.
// ---------------------------------------------------------------------------

app.post("/api/bookings", handler(({ repo, req }) =>
  repo.write.bookings.create({ ...req.body, date: toDate(req.body.date) })));

app.post("/api/bookings/:id/cancel", handler(({ repo, req }) =>
  repo.write.bookings.cancel({
    bookingId: req.params.id,
    now: req.body?.now ? new Date(req.body.now) : new Date(),
    actor: req.body?.actor ?? "trainer",
  })));

// Re-horsing one lesson. A PATCH on the booking rather than a new verb, because that is all
// it is: one column, no reprice, no change to the pattern it may belong to.
app.patch("/api/bookings/:id/horse", handler(({ repo, req }) =>
  repo.write.bookings.changeHorse({
    bookingId: req.params.id,
    horseId: req.body.horseId,
    actor: req.body?.actor ?? "trainer",
  })));

app.post("/api/bookings/:id/settle", handler(({ repo, req }) =>
  repo.write.bookings.settle({ bookingId: req.params.id, outcome: req.body.outcome })));

// The screens speak the engine's vocabulary in both directions, so what arrives here is
// translated the same way what leaves here is — through `to-engine.js` and nowhere else. These
// handlers took `req.body` straight through before, which meant a screen wanting to change a
// rider's profile had to know the column was `recurring_potential_unlocked`.
app.post("/api/students", handler(({ repo, req }) =>
  repo.write.students.create(fromEngineStudentPatch(req.body))));

app.patch("/api/students/:id", handler(({ repo, req }) =>
  repo.write.students.update({ studentId: req.params.id, ...fromEngineStudentPatch(req.body) })));

app.put("/api/availability", handler(({ repo, req }) =>
  repo.write.availability.replace(fromEngineAvailability(req.body.windows))));

// A standing weekly slot and the occurrences it generates, created or ended as one unit. The
// screens send `day` as a Date#getDay() index, which is what they hold; the repository maps it.
// Horses are ACCOUNT-scoped, so these take no trainer: a horse added by one coach belongs to
// the barn, and is immediately the other coach's too.
app.post("/api/horses", handler(({ repo, req }) =>
  repo.write.horses.create(fromEngineHorse(req.body))));

app.patch("/api/horses/:id", handler(({ repo, req }) =>
  repo.write.horses.update({ horseId: req.params.id, ...fromEngineHorse(req.body) })));

// A lesson type and a price band each span several tables — the type carries its band premiums
// and horse restrictions, the band carries its windows and the premiums other types charge for
// it. One call each, so a half-saved pricing setup is not a state any screen has to tolerate.
app.put("/api/lesson-types/:id", handler(({ repo, req }) =>
  repo.write.lessonTypes.save({ lessonTypeId: req.params.id === "new" ? null : req.params.id, ...req.body })));

app.delete("/api/lesson-types/:id", handler(({ repo, req }) =>
  repo.write.lessonTypes.remove({ lessonTypeId: req.params.id })));

app.put("/api/price-bands/:id", handler(({ repo, req }) =>
  repo.write.priceBands.save({ bandId: req.params.id === "new" ? null : req.params.id, ...req.body })));

app.delete("/api/price-bands/:id", handler(({ repo, req }) =>
  repo.write.priceBands.remove({ bandId: req.params.id })));

// Recording an offer, which is what later tells `offerStats` who tends to say yes.
app.post("/api/offers", handler(({ repo, req }) =>
  repo.write.offers.create(fromEngineOffer(req.body))));

app.post("/api/recurring", handler(({ repo, req }) =>
  repo.write.recurring.create(req.body)));

// Changing a standing slot is a PATCH on the pattern, not a write per occurrence: the
// repository decides which weeks that touches.
app.patch("/api/recurring/:id", handler(({ repo, req }) =>
  repo.write.recurring.update({
    recurringId: req.params.id,
    ...req.body,
    now: req.body?.now ? new Date(req.body.now) : new Date(),
  })));

app.post("/api/recurring/:id/end", handler(({ repo, req }) =>
  repo.write.recurring.end({
    recurringId: req.params.id,
    now: req.body?.now ? new Date(req.body.now) : new Date(),
  })));

const port = Number(process.env.PORT ?? 3001);
const server = app.listen(port, () => {
  console.log(`API on http://localhost:${port}`);
  console.log(`database: ${new URL(connectionString).hostname}`);
});

// Close the pool on the way out, so a restart does not leave connections parked on a database
// that caps them.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      await runtime.close();
      process.exit(0);
    });
  });
}
