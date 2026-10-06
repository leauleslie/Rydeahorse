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
  toDate, toEngineRecurring, fromEngineStudentPatch, fromEngineAvailability,
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

/**
 * Who is asking.
 *
 * Coach authentication has no mechanism yet (`db/SCHEMA-NOTES.md` §5 — a magic link is the
 * chosen direction, unbuilt), so this resolves the first trainer in the database and every
 * request is that coach. It is a STUB, and the one place in the server that will change when
 * auth lands: everything downstream already takes the tenant as an argument.
 */
let cachedTenant = null;
async function resolveTenant() {
  if (cachedTenant) return cachedTenant;
  const client = await runtime.pool.connect();
  try {
    const { rows } = await client.query(
      "select id as trainer_id, account_id, name, email from trainers order by created_at limit 1",
    );
    if (!rows.length) {
      throw new Error(
        "no trainers in the database — this server has no one to be until a coach row exists",
      );
    }
    cachedTenant = {
      trainerId: rows[0].trainer_id,
      accountId: rows[0].account_id,
      name: rows[0].name,
      email: rows[0].email,
    };
    return cachedTenant;
  } finally {
    client.release();
  }
}

/**
 * Wrap a handler so it runs inside one tenant transaction and its failures become HTTP.
 *
 * The error translation is the interesting part. The engine's refusal is not a 500 — it is the
 * expected answer to "may I book this?", and the screen needs all eight checks to render its
 * checklist. Flattening that into a message would throw away the only thing the coach wants
 * to see.
 */
const handler = (fn) => async (req, res) => {
  try {
    let tenant = await resolveTenant();
    let result;
    try {
      result = await runtime.run(tenant, (repo) => fn({ repo, req, tenant }));
    } catch (err) {
      // The cached tenant can outlive the row it names. Re-seeding the development database
      // deletes every trainer and writes new ones, and the cache then points at an id that no
      // longer resolves — so every request 500s until someone restarts a server that is not
      // actually broken. Drop the cache and try once more; the second attempt resolves the
      // coach who exists now.
      //
      // This is a property of the STUB above, not of the request layer: once a request carries
      // its own authenticated identity there is nothing process-wide left to go stale.
      if (!/no trainer row visible|no trainers in the database/.test(err.message ?? "")) throw err;
      cachedTenant = null;
      tenant = await resolveTenant();
      result = await runtime.run(tenant, (repo) => fn({ repo, req, tenant }));
    }
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
