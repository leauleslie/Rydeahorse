# Rydeahorse — Equestrian Lesson Scheduler

A scheduling product for equestrian coaches. Every booking decision has to respect horse
welfare (rest days, saddle-time caps), safe horse–rider pairing, and a pricing model the coach
can state out loud. Two interfaces — a web app (Phase 1a) and SMS (Phase 1b) — over one shared
backend and one rules engine.

`product-foundations.md` is the specification. It is a living document, currently v5, and it
carries the reasoning behind every decision, not just the decision. Read the relevant section
before changing behavior — most things that look arbitrary are load-bearing and the doc says
why.

## Repo layout

```
product-foundations.md   The spec. Section 8 (sheet schema) and Section 10 (rules engine)
                         are the authoritative ones; Section 3 is a superseded v1 sketch
                         kept for provenance. Section 9 is the decisions log.
schema.md                The data layer's decision record: what changed when the data moved
                         off Google Sheets to Postgres, and why each table looks as it does.
                         `db/SCHEMA-NOTES.md` holds the judgment calls made while building it.
prototype.jsx            The clickable Phase 1a prototype — one React file, ~4,800 lines,
                         every coach and student screen. Carries its own pre-extraction
                         copy of the rules; see "Two copies of the rules" below.
engine/                  The rules and pricing engine. Pure JS, no dependencies.
  README.md              The engine's contract, what changed in the extraction, and what
                         was deliberately left out of it.
  index.js               Re-exports everything. The public surface.
  time.js                Time primitives. Deliberately holds no clock.
  clock.js               Why the clock is a parameter, and the helpers for passing one.
  constants.js           Shared vocabularies: riding styles, experience ranks, HOLDS_SLOT.
  derive.js              Occurrence type, horse assignment, status, ride tallies, cancellation.
  pricing.js             Bands, frequency tiers, the ratchet, priceFor.
  rules.js               Availability, pairing, usage caps, rest days, validateBooking.
  test/                  node --test. 41 tests, no framework, no dependencies.
db/                      Postgres schema, migrations, and the repository. Drizzle for schema
                         and migration generation; no ORM behaviour beyond query building.
  schema/                Tables as Drizzle declarations. No queries, no tenant ids — nothing
                         in here can leak, because nothing in here fetches.
  migrations/            0000 generated, 0001+ hand-written. drizzle-kit cannot express an
                         EXCLUDE constraint, a range type, a role or a policy, so it will
                         neither re-emit nor diff 0001-0003. Change one, write a new one.
  repo/index.js          forTenant(db, {accountId, trainerId}) — the one place a row can be
                         fetched for the wrong coach. Plus withTenantTransaction, the only
                         shape under which the RLS policies apply, and engineInputsFor(date).
  repo/to-engine.js      Row shapes -> engine shapes. The one translation layer.
  repo/writes.js         The mutations, reached as repo.write.*. Each one asserts it is inside
                         withTenantTransaction before touching anything.
  test/                  node --test against a real Postgres branch. Reads, writes, isolation,
                         RLS and the engine mapping — see db/test/README.md.
```

`npm test` from `engine/`. No install step — the suite is `node --test test/*.test.js`.

`npm test` from `db/` runs the database suites. They need `TEST_DATABASE_URL` pointing at a
branch that is not production and a one-time `npm run test:mark`; the setup refuses to run
otherwise, and refuses before opening a socket. `db/test/README.md` explains both layers of
that refusal and how to add a query to the tenant-isolation harness in one line.

The prototype is the working reference for Phase 1a and the doc is kept in sync with it
deliberately (Section 14 lists the known gaps between them). It is a browser artifact, not the
product: the simulated clock, the Coach/Student role switch, the returning-student shortcut and
the seeded history are prototype-only.

The data layer is no longer Google Sheets and no longer unbuilt: it is Postgres, and `schema.md`
is the decision record for that move. Section 8 remains the source of truth for what each table
*means* — every table in `db/schema/` is a translation of it — but where Section 8 describes a
spreadsheet and `schema.md` describes a database, the database wins. The real web app and the
backend that serves it are still specified in Sections 6, 11 and 13 and still do not exist.

## Two copies of the rules

`engine/` was extracted from `prototype.jsx`, and **the prototype was not migrated onto it**. It
imports only React and `lucide-react`, and still carries its own definitions of `validateBooking`,
`priceFor`, `earnedTier`, `cancelDisposition`, `getEligibleHorses`, `forecastRestStatus` and the
rest — lines 330–1063, under `// ---------- pricing ----------` and `// ---------- rules engine ----------`.

This is the one place the "one engine, never reimplemented" rule is currently broken, and the
two copies have **already diverged, in exactly the four ways the extraction existed to fix**:

| Extraction change | `engine/` | `prototype.jsx` |
|---|---|---|
| Clock is a parameter | every time-dependent fn takes `now` | module-level `TODAY` / `NOW_MIN` |
| Checks carry a stable `code` | `{ code, label, pass }` | `{ label, pass }` — downstream matches on UI text |
| `holdsSlot()` for the slot-holding statuses | one definition | 8 inline `pending`/`confirmed` pairs |
| One shared `overlaps()` | 4-arg, used by bands and bookings alike | a local closure inside `validateBooking` |

So: **the engine is the authority. Fix a rule there, and port it to the prototype — never the
reverse, and never only in the prototype.** Anything read out of the prototype's rules sections
is the older behavior, and a rule that appears to disagree with `engine/` is the prototype being
stale rather than a genuine ambiguity. Migrating the prototype to import from `engine/` would
end this, and is the highest-value cleanup available in this repo.

## The engine's contract

Two entry points matter:

```js
validateBooking({ student, horse, lessonType, date, start, bookings, students, lessonTypes,
                  availability, timeOffBlocks, priceBands, trainerConfig,
                  offerDiscount, manualAdjustment })
  -> { ok, checks: [{ code, label, pass }], quote }

priceFor({ student, lessonType, date, start, offerDiscount, manualAdjustment,
           priceBands, trainerConfig })
  -> { basePrice, bandAdjustment, frequencyDiscount, offerDiscount, manualAdjustment,
       price, raw, band, tier, flooredBy, cappedBy }
```

`validateBooking` runs all eight checks every time and reports them in specification order —
`trainer_available`, `horse_active`, `rest_day`, `usage_cap`, `pairing`, `horse_free`,
`trainer_free`, `price_in_range`. It
does **not** short-circuit — the order decides which reason gets reported, and a validation
checklist has to show the whole picture at once. `firstFailure(validation)` takes the reported
reason off the front — it takes the whole result, not its `checks` array.

`priceFor` never returns a bare number. Every screen that shows a price must be able to show
the reasoning behind it, so the components always come back with the total.

## Principles the code must follow

**Hard constraints are deterministic code; the LLM does language only.** Horse caps, no-ride
pairings, double-booking and pricing are enforced in the engine. The Claude API's job is
parsing loose free text into structured intents, asking clarifying questions, and drafting
outbound messages. Never move a constraint into the model's judgment.

**One engine, never reimplemented per interface.** Web and SMS are thin clients over the same
module. The same code runs on the server (authoritative) and in the browser (preview). If a
rule ends up expressed twice, that is the bug.

**The engine is pure.** No React, no DOM, no database, no network, no module-level clock. Every
function whose answer depends on the current moment takes `now` explicitly; callers build it
once per request and thread it down. This is what makes the two-month ratchet, the 24-hour
cancel boundary and the 7-day rest window testable at all. `clock.js` carries the full
reasoning — read it before reintroducing any ambient time.

**The tenant boundary is not in the engine.** It takes the horses, students, bookings and
config it is given and never asks where they came from — so it cannot leak across tenants,
because it cannot query. The moment the engine takes a `trainerId` and fetches something, every
rule in it becomes untestable without a database.

Scoping happens at the repository, and there are **two rules, not one**. Trainer-scoped tables
(students, bookings, alerts, notes, riding windows) must never cross trainers, *including two
trainers inside one account* — a rider taking lessons from two coaches is two rows. Account-scoped
tables (horses, and reads judged about a horse) must return **identical** rows to two trainers in
one account, because a horse is one physical animal and both coaches ride it. A check that only
knows how to assert disjointness reports the second rule working as designed as a leak.

Below the repository, Postgres enforces the same boundary with row-level security, for the same
reason `horse_not_double_booked` is a constraint: the repository can only be trusted while every
read goes through it, and the first query that does not is silent. The application connects as
`rydeahorse_app`, which owns nothing and has no `BYPASSRLS`, so a forgotten
`withTenantTransaction` returns **zero rows rather than every tenant's**. The owner credential
bypasses all of it and always will — that is a migration credential, never an application one.

**Derive, don't store.** Usage caps, rest-day counts, ride tallies, lesson end times, completion
status, offer conversion — all computed on read from `Bookings`. A stored counter drifts; a
computed one can't. There are exactly **two deliberate exceptions**, and both invert the
reasoning rather than bending it:

- *A price and its five components are stored.* A price is a historical fact about a
  transaction, and *recomputing* is what makes it drift — a lesson priced in March against
  March's bands must still read as $65 in September. Stamped once at creation, never recomputed.
- *Student alerts are an append-only event log.* An alert records who did what, and the actor is
  precisely what current state can't recover — a cancelled booking looks identical whichever
  side cancelled it.

Adding a third exception needs the same standard of argument. **One is currently pending that
argument** and is not taken: `bookings` would need `ride_time_min` and the rider's adult-ness
stamped on it, because horse welfare counts every lesson the animal did while lesson types and
students are trainer-scoped — so a barn-mate's lesson is unresolvable and silently contributes
zero. See `db/SCHEMA-NOTES.md` §15 and the gap listed at the end of this file.

**Pricing is three separate mechanisms, not one adjustable number.** A **band premium** attaches
to the slot (uniform, published in advance), a **frequency discount** attaches to the student (a
rate they hold, changing on a stated date), a **gap-fill discount** attaches to the offer
(one-time, coach-initiated, reason attached). They stay separate because kept separate they're
three sentences a coach can say out loud. Blended into one computed number they are the
"$60 last week, $65 this week" confusion the whole design exists to prevent.

Rules that follow from it:
- **Whole dollars, never percentages.** There is no rounding step anywhere in this product, so
  there is no rounding rule to get wrong. The no-cents requirement holds by construction.
- **The floor is announced, never applied quietly.** `flooredBy` / `cappedBy` come back on every
  quote and the UI is required to surface them.
- **Discounts stack; premiums don't compound.** One addition and two subtractions, in that order.
- **A gap-fill discount is unreachable by self-booking**, deliberately. A discount obtainable by
  waiting is a general price cut that teaches everyone to stop booking at full rate.
- **Automatic demand-responsive pricing is rejected**, because it's the one mechanism here that
  can't be made transparent. Reopens only if pilot coaches are found sending the same discount
  to the same students week after week.

**Welfare and safety checks never relax.** The horse half of the double-booking check never
relaxes — every rider needs their own horse. Only the trainer half relaxes, and only for a
genuine group session below capacity. Usage caps count **saddle time** (`rideTimeMin`), never
calendar time; scheduling and conflict checks use `durationMin`. Conflating them either
overbooks the coach's day or misjudges how much a horse has actually been ridden.

**Checks carry stable `code`s alongside human `label`s.** Never match on label text — across a
service boundary a UI string is not an identifier, and `Price floored at $55` interpolates a
number into the thing you'd be matching on.

**A role is a flag, never an id.** `isIntro` exists because eleven places once compared against
the literal string `"first-time"`, which works only while seed ids are fixed strings. A real
coach's types have generated ids, at which point every such comparison silently evaluates false
and nothing throws. Same reasoning for `isGroup`. Never reintroduce an id comparison to mean a
role.

**A group session is not a stored entity.** It *is* the set of bookings sharing lesson type +
date + start time where the type is a group type. No `group_id` — nothing to keep in sync, and
no way for a booking to claim membership in a session it doesn't share a slot with. Cancelling
is always per-student, never per-session.

**One source of truth per idea; one implementation per concept.** IDs, not names, are the
relationships. Multi-value fields are comma-separated IDs in one cell, not junction tabs. The
frequent-rider threshold has one definition shared by scheduling flex and pricing. `holdsSlot`
and `overlaps` exist because the same test was spelled out inline in six and three places
respectively. On the UI side, a lesson row, an alert card, a usage meter and a validation
checklist each have exactly one implementation — when four screens each drew their own, they
drifted and the coach had to relearn the same information on every screen.

**Explainability is a product constraint, not a nicety.** Anything a student or coach is shown
must be answerable a month later without reconstructing the config that produced it. This is
why the receipt is stored rather than regenerated, why tiers move once a month on a nameable
date, why calendar months beat a rolling 30-day window, and why bands cap at three: a pricing
rule that can't be recited isn't transparent no matter how visible it is.

**Every data-changing action is reversible for one step.** Undo restores the prior values of the
rows that action wrote — never a whole-state snapshot, since other people may be writing at the
same time — and lapses at the next action or the end of the session.

**Alerts are informational, never an approval gate.** The coach owns the schedule. A change
waiting on student acknowledgement would leave the barn's real state ambiguous. Alerts are
dated to the day the problem *lands on*, never to the day the check ran. Retention is 7 days
and expiry is a read filter, not a delete, so nothing breaks if a cleanup job hasn't run.

## Conventions

- ES modules, `"type": "module"`. No build step, no dependencies, no transpiler.
- Tests are `node --test` with hand-built fixtures. **Do not use the prototype's seed data as
  fixtures** — seed data is tuned to make screens look plausible, which makes it a poor
  instrument for pinning down a rule. Each fixture in `test/fixtures.js` exists to make one
  boundary reachable.
- Test names read as specification sentences and state the *why*, not just the what — e.g.
  "rest window counts distinct DATES, not bookings", "the floor is announced, not applied
  quietly". Match that style; the suite doubles as documentation.
- Database suites use a seeded fixture rather than hand-built objects, because what they pin
  down is a query's scope rather than a rule. The two tenants in `db/test/seed.js` deliberately
  collide on every value except their ids — same horse names, same lesson dates — so that only
  tenant scoping can separate them and an unscoped query cannot pass by accident.
- The engine uses camelCase (`rideTimeMin`, `lateCancelHours`); the schema is snake_case
  (`ride_time_min`, `late_cancel_hours`). The mapping lives in `db/repo/to-engine.js` and
  nowhere else — never inside the engine, whose input shape is the contract the prototype
  already speaks. It is more than renaming: `date` arrives as a string where the engine calls
  `.getDay()`, `day_of_week` is `'tue'` where the engine wants `2`, and `noRideHorses`,
  `restrictedHorseIds` and `bandAdjustments` are junction tables there and inline
  arrays/objects here. **Do not "simplify" it by renaming engine fields to match columns.**
- Comments in the engine explain *why a rule is the way it is*, especially where the obvious
  implementation would be wrong. Keep that density — it's the file's main defense against a
  future reader "simplifying" a deliberate choice.

## Decision discipline

Section 9 is a decisions log: what was decided, the reasoning that produced it, and — for the
ones that were rejected — what would reopen them. When you make a non-obvious call, add it
there in the same form, including what you considered and rejected. When you defer something,
record the **trigger that reopens it** rather than a vague "later".

Reversing a recorded decision is allowed and has happened (group sessions as potential lessons;
coach-authored profiles; versioned terms). Reverse it in the doc, with the reasoning that
overturned it, rather than only in code.

## Known gaps, left deliberately

- **Day-granular completion vs. minute-granular cancellation.** A lesson that ended at 6am today
  shows no cancel button (correct) but doesn't yet count as completed. The fix in `derive.js` is
  one line — `startOfDay(now)` becomes `now` — but it moves the coach's Day view and the ride
  tallies together, so it stays a deliberate decision, not a refactor side effect.
- **`notification_preference: "all"`** is selectable and specified but behaves as
  `target_and_potential`; both consumers drop a student whose windows don't cover the slot
  before the preference is read.
- **Frequency tiers ship switched off** — the thresholds start blank, which renders the whole
  mechanism invisible. They're computed from completed calendar months, and on day one there
  aren't any. Reopens after the pilot's first full month.
- **Horse welfare caps under-count on a horse shared between two trainers.**
  `horseMinutesOnDate` resolves a booking's saddle time by looking its lesson type up in the
  array it was handed. Bookings are loaded account-wide, as the welfare rules require; lesson
  types are trainer-scoped, as tenancy requires. A barn-mate's lesson is therefore unresolvable
  and contributes **zero** — a horse ridden 45 minutes by each of two coaches reports 45, not
  90 — and the `? :` that keeps it from throwing is what makes it silent. The adult cap has the
  same hole twice over, resolving riders through trainer-scoped `students`. The fix is not to
  widen scope, which trades a welfare bug for a tenancy breach; it is the pending third
  exception to derive-don't-store above. Two tests in `db/test/engine-inputs.test.js` assert the
  wrong numbers at their current values, so closing the gap fails them loudly. Bites for real on
  the first account with two trainers sharing a horse.
- **The write surface is partial.** `repo.write` covers booking creation, cancellation,
  settlement, students and availability. Still missing: horses, lesson types, price bands,
  recurring patterns, offers and substitutions. Undo is unimplemented — writes return the rows
  they wrote, which is what a one-step undo would need, but nothing stores them.
- **There is no pool and no request-scoped connection.** `withTenantTransaction` takes a single
  client. A web app needs to check one out per request, set identity, run the handler, release.
- **Coach authentication has no mechanism.** `trainers.email` is the identifier it will key on
  and nothing more (`db/SCHEMA-NOTES.md` §5). Screens need a stubbed trainer id until it exists,
  and it is what decides the shape of the request layer.
- **Not yet extracted from the prototype**, and the natural next module *on top of* the engine:
  slot finding and matching — `findOpenSlots`, `findIntroOptions`, `findRecurringOptions`,
  `eligibleStudentsForSlot`, `offerRespectsPreferences`. They're pure and rules-dependent, but
  they're a layer above: the engine answers "may this booking exist," matching answers "what
  should we suggest." Occurrence generation belongs with the scheduled job that calls it.
- Neither a horse nor a rider can be deleted today, only deactivated — which is what makes the
  many `horses.find(...)` / `students.find(...)` lookups in the render path safe. **Adding a
  deletion path requires migrating those lookups to null-safe helpers first**, not after; every
  unguarded lookup becomes a white screen on the same day.
