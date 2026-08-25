# Database Schema — Design Decisions

Postgres, migrated with Drizzle. This document is the decision record; the migration files are
generated from it. Where this document and the migrations disagree, that is a bug in the
migrations.

Companion to `product-foundations.md`, which remains the source of truth for product behaviour.
This one covers only what changes when the data moves off Google Sheets and starts serving more
than one coach.

---

## 1. Tenancy

**Two levels, not one: an `account` owns horses, a `trainer` owns everything else.**

The original question was whether a tenant is a coach or a barn, and it looked like a fork
because a barn-level tenant is more machinery than three pilot coaches need, while a coach-level
tenant breaks horse welfare the moment two coaches teach at the same facility — each would hold
her own record for the same physical horse, and neither one's daily usage cap or rest-day window
could see the other's bookings. A horse ridden 90 minutes by each is at 180 minutes and no rule
in the system knows.

Introducing `accounts` dissolves the fork rather than deciding it. An account with one trainer
behaves exactly like coach-level tenancy — same screens, same rules, nothing extra to configure.
An account with two trainers shares horses correctly, and the welfare checks work across both
without a single query changing, because they were always scoped to the account rather than the
coach. The cost is one table and one extra foreign key.

**What sits at which level, and why:**

| Level | Tables | Reason |
|---|---|---|
| `account_id` | `horses`, `horse_inactive_periods` | A horse is a physical animal at a facility. Its rest days and daily saddle-time cap are facts about the animal, not about who booked it. |
| `trainer_id` | everything else — availability, time off, config, lesson types, price bands, disclosures, students, bookings, recurring patterns, offers, notes, alerts | These are all one coach's business terms. Two coaches sharing a barn still set their own prices, their own cancellation notice, and their own agreements. |

**Students are scoped to a trainer, not an account.** A rider taking lessons from two coaches is
two rows. This is the simpler model and it's honest about what it loses: no shared ride history,
no shared no-ride list, and each coach reviews the profile she was given. The alternative — one
person, many coach relationships — is a materially larger schema for a case that may never occur
in a three-coach pilot. **Trigger to revisit:** the first time a rider actually books with two
coaches on the platform and one of them complains about re-entering a profile.

**Every query is scoped at the repository layer, once.** The engine never receives a tenant ID
and never queries, so it cannot leak across tenants. Keep it that way.

---

## 2. What changes from the Sheets schema

Structure only. No product behaviour changes here except where noted, and each exception is
called out with its reason.

### IDs

`STU-001` and friends become UUIDs. The prefixed IDs were readable because a human might open
the spreadsheet; nobody opens Postgres. The principle they served — IDs are the relationships,
names are not — is unchanged.

### Times and dates

`date` stays `date` and `start_time` stays `time`, both in the coach's local time, exactly as she
enters them. `trainers.timezone` holds an IANA zone (`America/Los_Angeles`).

No UTC conversion anywhere in the schema. Every lesson belongs to exactly one trainer, so a
lesson's local time is unambiguous without a zone attached to the row. Conversion happens in one
place only: the outbound-message job, which needs a real instant to schedule a send against.
Daylight saving is therefore not a concern the schema has to hold — a 9:00 AM lesson is 9:00 AM
on both sides of the transition, which is also what the coach means.

### Multi-value cells

Every comma-separated cell becomes real rows, with one exception.

| Sheets | Postgres | Why |
|---|---|---|
| `Students.no_ride_horse_ids` | `student_no_ride_horses` junction | Foreign keys need referential integrity — a deleted horse must not leave a dangling ID in a text field. |
| `Lesson_Types.restricted_horse_ids` | `lesson_type_restricted_horses` junction | Same. |
| `Lesson_Types.band_adjustments` | `lesson_type_band_adjustments (lesson_type_id, band_id, amount)` | `BAND-001:10` was a key-value pair encoded in a string. It's a row. |
| `Students.target_riding_times` / `potential_riding_times` | `student_riding_windows (student_id, kind, day_of_week, start_time, end_time)` | Section 13 already required these to be structured — they feed opportunity matching directly. |
| `Disclosures.sections` | `disclosure_sections (trainer_id, key, title, body, included)` | Seven rows with stable keys, which is what the keys were always for. |
| `riding_styles` (horses and students) | `text[]` | The exception. A fixed two-value vocabulary with no table to point at. An array is honest here; a junction table would be ceremony. |

### `bookings` stores its end time

**This is the one behavioural change in this document.**

`product-foundations.md` derives a lesson's end from `Lesson_Types.duration_min` rather than
storing it, on the same reasoning as computed usage caps: a stored copy drifts when the lesson
type is edited.

That has to change, because a database cannot enforce "these two lessons don't overlap" without
knowing where each one ends. But it should change anyway, and the argument is one you already
made about prices: the slot a lesson occupies is a historical fact about a commitment. Editing a
lesson type's duration in November should no more resize October's lessons than editing its base
price should reprice them. Storing `end_time` puts the calendar under the same rule as the
receipt.

`bookings` therefore carries `date`, `start_time` and `end_time`. `duration_min` on the lesson
type remains the default that populates `end_time` at creation.

### Config that was one row

`Trainer_Config` was a single-row tab. Its fields become columns on `trainers` — buffers,
`max_back_to_back`, `scheduling_preference`, `late_cancel_hours`, `frequency_tier_1_min_rides`,
`frequency_tier_2_min_rides`, `prioritization_rule`. A one-row table pretending to be a
singleton is a table that eventually gets two rows.

---

## 3. What the database enforces that the engine cannot

The engine is correct and it is not sufficient. It validates against the bookings it was handed,
which means two people clicking at the same moment can each pass validation against a world that
no longer exists by the time either one commits. Sheets had no answer to this. Postgres does.

**1. A horse cannot hold two overlapping lessons.** An exclusion constraint on `bookings`, over
`horse_id` and the `[start_time, end_time)` range on a given date, restricted to rows in a
slot-holding status:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings ADD CONSTRAINT horse_not_double_booked
  EXCLUDE USING gist (
    horse_id WITH =,
    date WITH =,
    timerange(start_time, end_time) WITH &&
  ) WHERE (status IN ('pending', 'confirmed'));
```

This is the reliability promise in Section 5 — *never double-book a horse* — made structurally
true rather than conditionally true. It cannot be bypassed by a race, by a bug in the engine, by
a background job, or by someone editing rows by hand.

**2. A student cannot be offered the same slot twice.** A unique index on
`offers (student_id, date, start_time)`, which is the exact query Section 8 names as the reason
the table exists — so the same 9am Thursday can't be pushed at the same rider three days running.

**3. Exactly one lesson type per trainer is the intro type.** A partial unique index on
`lesson_types (trainer_id) WHERE is_intro`. The foundations doc says setting it on one type
clears it from the others; the index makes that a guarantee instead of a convention.

**4. Two price bands cannot overlap on a shared day.** An exclusion constraint per trainer and
day of week. Section 8 calls overlapping bands the exact failure the pricing model exists to
prevent, and calls it worse than having no bands at all because it looks deliberate.

**What stays in the engine, deliberately:** the trainer-conflict half of check #6. It relaxes for
a group session below capacity, and that condition depends on the lesson type's `is_group` flag
and current roster size — too conditional to express as a constraint. It runs inside the same
transaction as the insert, with the trainer's bookings for that date locked, so the check and the
commit see the same world.

---

## 4. Identity

**Login is a phone number and a six-digit code, then a name.**

Name-plus-phone was a deliberate simplicity choice for one coach's roster and a defensible one.
It stops being defensible when the platform is custodian of several barns' minor-rider data,
guardian contacts and signed agreements, because a signature is worth exactly what the identity
behind it is worth.

The replacement preserves the property that made the original good. A code goes to the phone;
the screen then lists everyone attached to that number and the rider picks. A family sharing one
phone still works, with no extra design — and a rider who takes lessons from two coaches on the
platform sees both, which the original could not have handled at all.

**Coaches authenticate separately**, by email, since a coach's account controls pricing and
student records and should not share a mechanism with the rider side.

Tables: `auth_identities (phone, verified_at)`, `auth_codes (phone, code_hash, expires_at,
consumed_at)`, and a link from `students` to the identity. Codes are hashed, single-use, and
short-lived; attempts are rate-limited per phone.

---

## 5. The engine boundary

The engine takes plain objects in camelCase (`rideTimeMin`, `maxDailyOverall`, `frequencyTier`).
The database is snake_case. One mapping layer sits between them, in the repository, and nowhere
else.

Do not reshape the engine to match the database. Its input shape is the contract the prototype
already speaks, and keeping it means the same functions run unchanged in the browser, where
there is no database to match.

---

## 6. Connecting: the driver, and three connection strings

Until now `db/` held schema definitions and generated SQL and nothing else — no client, no pool,
no driver. Running the first migration against a real database ended that, and the choices it
forced are recorded here rather than in `product-foundations.md` Section 9. Section 9 is a log of
*product* decisions; which Postgres driver a Node process loads is not one, and putting it there
would dilute the thing that makes that log worth reading.

**`pg` is a dependency of `db/`, not a devDependency.** `drizzle-kit migrate` refuses to run
without a driver — it accepts `pg`, `postgres`, `@neondatabase/serverless` or `@vercel/postgres`.
`pg` is the reference implementation, it is what `drizzle-orm/node-postgres` expects, and it
speaks the ordinary wire protocol, so nothing about it is Neon-specific: moving off Neon is a
connection-string change and not a code change. `@neondatabase/serverless` would have been faster
from a serverless runtime and would have coupled this layer to one host to get there. It is a
`dependency` rather than a `devDependency` because migrations are only its first consumer — the
repository layer that will live here needs it at runtime too, and moving it later is a change
that only ever goes one way.

**Three connection strings, because two of them cannot do each other's job.**

| Variable | Endpoint | Used by |
|---|---|---|
| `DATABASE_URL` | pooled (`-pooler` host) | the app at runtime |
| `DIRECT_DATABASE_URL` | unpooled | migrations — `drizzle.config.js` reads this one |
| `TEST_DATABASE_URL` | a separate Neon branch | tests, exclusively |

The split between the first two is not a preference. Neon's pooled endpoint is PgBouncer in
transaction mode, which returns the underlying connection to the pool between statements. That is
exactly right for the app — many short-lived connections, no session state worth keeping — and
exactly wrong for a migration, which needs one stable session for its advisory lock and its
multi-statement transaction. `0001` alone runs `CREATE EXTENSION`, `CREATE TYPE ... AS RANGE` and
two `ALTER TABLE ... ADD CONSTRAINT`s, and a pooler is free to interleave another client between
any two of them. Migrations run unpooled; the app does not.

The third is a blast-radius decision. Tests truncate and rewrite tables, so a test suite pointed
at the main branch destroys real data on its first green run. A Neon branch is copy-on-write, so
the isolation is real rather than conventional — a table created on the test branch is not
visible on main — and branching from main *after* a migration means the branch inherits both the
schema and `drizzle.__drizzle_migrations`, arriving already in sync. When it drifts, migrate it
by pointing the migration's own variable at it for one run:
`DIRECT_DATABASE_URL="$TEST_DATABASE_URL" npm run migrate`. A shell value wins over `.env.local`,
which is why `drizzle.config.js` reads the environment rather than hard-coding a target.

The obvious mistake this arrangement invites is a fourth string, or a `NODE_ENV` switch choosing
between them. Both reintroduce the failure the naming exists to prevent: at the moment a
migration runs, *which database* must be readable off the command that runs it.

---

## 7. Deferred, with triggers

| Deferred | Revisit when |
|---|---|
| Riders shared across trainers | A rider books with two coaches and objects to re-entering a profile. |
| Barn-level roles and permissions | An account has more than one trainer and they need different access. |
| Payments (`invoices`, `payments`) | Money starts moving through the platform. Until then, monthly statements are derived from `bookings.price` and `is_billable`. |
| `Message_Log` | Phase 1b. The table ships empty rather than being added later. |
| Soft deletes / audit trail | A coach asks what changed and when, beyond what `student_alerts` already records. |
