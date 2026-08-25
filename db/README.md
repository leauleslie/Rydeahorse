# `db/` — Postgres schema and migrations

Drizzle over Postgres. `schema.md` is the decision record for this layer; where this code and
that document disagree, the bug is here. `product-foundations.md` remains the source of truth
for product behaviour, and Section 8 is what every table below is a translation of.

There is still no client, no pool and no repository here — only the schema definitions, the SQL
generated from them, and the migration runner that applies it. `npm run migrate` connects; it is
the only thing in this directory that does. `schema.md` Section 6 records the driver choice and
why the three connection strings are not interchangeable.

```
drizzle.config.js              drizzle-kit's input. `generate` never opens a connection.
schema/
  enums.js                     Controlled vocabularies as Postgres enums.
  tenancy.js                   accounts, trainers (incl. the old Trainer_Config columns).
  horses.js                    horses, horse_inactive_periods — the account-level tables.
  trainerSchedule.js           trainer_availability, trainer_time_off.
  pricing.js                   price_bands (+ windows), lesson_types, the two junctions.
  identity.js                  auth_identities, auth_codes.
  students.js                  students, riding windows, no-ride list, notes, alerts.
  disclosures.js               disclosures, sections, acceptances.
  bookings.js                  recurring_bookings, bookings, substitutions, offers.
  messages.js                  message_log — ships empty until Phase 1b.
  index.js                     Re-exports everything. The public surface.
migrations/
  0000_initial_schema.sql      Generated. 26 tables, 16 enums, constraints #2 and #3.
  0001_exclusion_constraints.sql   Hand-written. btree_gist, timerange, constraints #1 and #4.
```

```bash
npm run generate
```

`npm run generate` writes a new migration from the schema files and `npm run check` validates the
migration set; both are offline and neither opens a connection.

```bash
npm run migrate
```

`npm run migrate` applies any unapplied migrations and is the one command here that needs a
database. It reads `DIRECT_DATABASE_URL` from the repo-root `.env.local` — the **unpooled**
endpoint, because Neon's pooled one is PgBouncer in transaction mode and cannot hold a session
across `CREATE EXTENSION`, `CREATE TYPE` or drizzle's advisory lock. Already-applied migrations
are matched by hash in `drizzle.__drizzle_migrations` and skipped, so re-running is a no-op.

To migrate the test branch, override the variable for one run:

```bash
DIRECT_DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
```

## The four constraints, and where each one lives

`schema.md` Section 3 names four things the database enforces that the engine cannot, because
the engine validates against the bookings it was handed and two people clicking at the same
moment each pass against a world that no longer exists by the time either commits.

| # | Constraint | Where |
|---|---|---|
| 1 | A horse cannot hold two overlapping lessons | `0001` — `EXCLUDE USING gist` on `bookings` |
| 2 | A student cannot be offered the same slot twice | `0000` — `UNIQUE (student_id, date, start_time)` on `offers` |
| 3 | Exactly one lesson type per trainer is the intro type | `0000` — partial unique index on `lesson_types` |
| 4 | Two price bands cannot overlap on a shared day | `0001` — `EXCLUDE USING gist` on `price_band_windows` |

The split is not editorial. drizzle-kit has no representation for `CREATE EXTENSION`, a custom
range type, or an `EXCLUDE` constraint, so #1 and #4 are hand-written and drizzle-kit will
neither re-emit nor diff them. **Changing either one means writing a new migration by hand.**
#2 and #3 are ordinary Drizzle declarations and live in `schema/`, where a future `generate`
will keep them honest.

`0001` also creates `timerange`. Postgres ships int4range, int8range, numrange, tsrange,
tstzrange and daterange — none with `time` as its subtype — so the SQL in Section 3 does not
run until the type exists.

## What stays in the engine, deliberately

The trainer half of check #6. It relaxes for a group session below capacity, and that
condition depends on the lesson type's `is_group` flag and the current roster size — too
conditional to express as a constraint. It runs inside the same transaction as the insert,
with the trainer's bookings for that date locked, so the check and the commit see the same
world.

The horse half never relaxes, which is exactly why it could become constraint #1.

Also still in the engine, and not expressible here:

- **Three price bands maximum.** A count across rows needs a trigger or a statement-level
  check. `MAX_PRICE_BANDS` in `engine/constants.js` holds it.
- **The `min_price` floor and `max_price` ceiling.** `bookings.price` is the sum of its five
  components *clamped* to the lesson type's range, so a `CHECK` asserting the sum would fire
  on precisely the case the floor exists for. The floor is announced by the quote, and
  `flooredBy` / `cappedBy` come back on every one.
- **Every derived value.** Usage caps, rest-day counts, ride tallies, completion status, offer
  conversion. No column here stores any of them.

## The boundary this layer holds

The engine takes plain objects in camelCase (`rideTimeMin`, `maxDailyOverall`,
`frequencyTier`); these columns are snake_case. One mapping layer sits between them, in the
repository, and nowhere else. Do not reshape the engine to match these tables — its input
shape is the contract the prototype already speaks, and keeping it is what lets the same
functions run unchanged in the browser, where there is no database to match.

Nothing in `schema/` takes a tenant id, because nothing in `schema/` queries. Scoping is one
`trainer_id` (or `account_id`) filter at the repository, once.

## Two levels of tenancy

An `account` owns horses; a `trainer` owns everything else. An account with one trainer
behaves exactly like coach-level tenancy — same screens, same rules, nothing to configure. An
account with two shares horses correctly, and the welfare checks work across both without a
query changing.

This is visible in constraint #1: it excludes on `horse_id` with no tenant column at all, so
two coaches sharing a barn cannot double-book the same animal. That is the specific failure
that made coach-level tenancy untenable — a horse ridden 90 minutes by each is at 180 minutes
and no rule in the system knows.

Students are trainer-scoped. A rider taking lessons from two coaches is two rows.

## Judgment calls made here

Recorded in full, with reasoning, in `SCHEMA-NOTES.md`. The load-bearing ones:

- **A price band is a named row with one or more day windows** (`price_bands` +
  `price_band_windows`), not one row per day. The literal Section 8 reading — "five rows
  sharing a name" — cannot satisfy the two rules stated around it.
- **`bookings.end_time` is stored**, which is `schema.md`'s one deliberate behavioural change,
  and what makes constraint #1 possible at all.
- **`students.age` is an integer**, per Section 8, and it drifts. A birth date is the
  non-drifting form of the same fact; see the notes.
