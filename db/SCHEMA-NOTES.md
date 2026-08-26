# Schema notes — what was ambiguous, and what was decided

Written while implementing `schema.md` in `db/`. Everything here is either a place the
document under-specifies, a place two of its statements can't both hold, or a place I chose
something it doesn't mention. Ordered by how much a reviewer should care.

**None of this SQL has been run.** No database was created or connected to. `drizzle-kit
generate` and `drizzle-kit check` both work offline, and both pass; execution against a real
Postgres is unverified.

---

## 1. `timerange` is not a Postgres type — Section 3's SQL cannot run as written

Section 3 gives constraint #1 as:

```sql
timerange(start_time, end_time) WITH &&
```

Postgres ships `int4range`, `int8range`, `numrange`, `tsrange`, `tstzrange` and `daterange`.
None has `time` as its subtype, and there is no `timerange`.

**Decided:** create it, in `0001_exclusion_constraints.sql`, before either constraint:

```sql
CREATE TYPE timerange AS RANGE (subtype = time);
```

This keeps the rest of Section 3's SQL literally correct, and a `time` subtype is the right
one here regardless: no column in this schema is stored in UTC, `date` and `start_time` are
separate columns in the coach's local time, and both constraints already pin the day with `=`,
so overlap is only ever asked within a single day where a bare time is unambiguous.

**The alternative** was a `tsrange` built from `date + start_time`, which needs no new type but
puts a composite expression in the index and drops the readable `date WITH =` term.

**Assumed, unverified without a server:** that `range_ops` covers a user-defined range type for
GiST (it is polymorphic over `anyrange`, so it should), that the auto-generated 3-argument
constructor is `IMMUTABLE` enough for an index expression, and that `btree_gist` covers enum
types — which constraint #4 needs for `day_of_week`. Its documentation says "all enum types."

---

## 2. A price band is one row per day, or one named band with several day windows — not both

This is the largest structural call, and the two readings produce different tables.

**Section 8 says** `day_of_week | Mon–Sun. Flat list like Trainer_Availability, not one row per
day — an "After school" band spanning Mon–Fri is five rows sharing a name.` That is one row per
band per day, each with its own `band_id`.

**Three other statements contradict it:**

1. *Three bands maximum* — "past three, neither the coach nor the student can hold the pricing
   in their head." A Mon–Fri after-school band is already five under the flat reading, so the
   stated maximum is unreachable for the document's own example.
2. `lesson_type_band_adjustments (lesson_type_id, band_id, amount)`, with "a coach who only
   prices one of their bands differently for this type writes one pair." Under the flat
   reading, pricing "After school" on a lesson type is five rows, and a coach who edits four of
   them has a Wednesday that silently differs — which is the opposite of a band premium being
   "uniform, published in advance."
3. The band's `name` is "the word that appears on the student's receipt line." A receipt line
   should point at one row, not at whichever of five happened to match.

**Decided:** split the name from its windows.

```
price_bands         (id, trainer_id, name)
price_band_windows  (id, band_id, trainer_id, day_of_week, start_time, end_time)
```

All three rules above then hold literally: three bands is three rows in `price_bands`, an
adjustment is one row per band, and the receipt names one band. Constraint #4 stays exactly as
specified — per trainer, per day of week — just on the windows table.

`price_band_windows.trainer_id` is denormalised from the band, purely so constraint #4 can be
written without a join. A composite foreign key `(band_id, trainer_id) → price_bands(id,
trainer_id)` keeps it from ever disagreeing with the band's own trainer.

**If you meant the flat reading**, the fix is small: drop `price_band_windows`, move
`day_of_week`/`start_time`/`end_time` onto `price_bands`, and move constraint #4 back. But the
three-band maximum then needs restating as "three names," and the band-adjustment rule as
"one pair per band per day."

---

## 3. `students.age` is a stored integer, and it drifts

Section 8 specifies `age`, and I implemented `age integer NOT NULL`.

It is the wrong shape for what it's used for, and the document half-notices: it says SMS
routing is "computed at send-time from `age`, not stored separately — so it stays correct
automatically as a student ages past 18." That's true of the *routing*, which derives rather
than stores. It is not true of `age`, which is stale the day after a birthday unless somebody
edits the row.

The same number gates three things:

- `adult_only` pairing (check #5) — **a safety rule**
- the adult daily saddle-time cap (check #4) — **a welfare rule**
- SMS routing to guardian vs. rider — **a privacy rule about a minor**

All three fail in the direction of treating an adult as a minor, which is the safe direction,
but they fail silently and stay wrong indefinitely.

**Recommendation:** `date_of_birth date`, with `age` derived. It's the same fact in the form
that can't go stale, and it makes "18+" a comparison against the lesson date rather than
against whenever the row was last edited. Changing it later means a migration plus a
backfill from data nobody has.

**Implemented as specified** rather than silently substituted.

---

## 4. `bookings.price` cannot always equal the sum of its parts

Two statements in Section 8:

- `price` is "**the sum of the five columns above**, clamped to the lesson type's
  `min_price`/`max_price`."
- `manual_adjustment` is "the reconciling term that keeps `price` equal to the sum of its
  parts."

When the floor binds — which is the case the floor exists for, and which Section 10 requires be
announced by name — `price` is deliberately *not* the sum.

**Decided:** no `CHECK` asserting the sum. A constraint here would fire on exactly the
scenario the pricing design is proudest of handling. The relationship is the engine's, and
`flooredBy` / `cappedBy` come back on every quote so the UI can say what happened.

Integer columns throughout do carry the whole-dollars rule structurally, which is the part
that *is* enforceable.

---

## 5. Coach authentication has no table

Section 4 gives the rider side in full — `auth_identities`, `auth_codes`, hashed, single-use,
short-lived, rate-limited — and says only that "**coaches authenticate separately**, by email,
since a coach's account controls pricing and student records and should not share a mechanism
with the rider side."

**Decided:** `trainers.email`, unique. Nothing else invented. There is no password column, no
coach-side code table, and no session table, because choosing between a magic link and a
password is a product decision, not a schema translation.

**Open, and blocking a coach login flow:**
- magic link (could reuse `auth_codes` if it were keyed on a generic identifier rather than
  `phone`) vs. password (needs a hash column and a reset flow) vs. an external IdP;
- whether a coach's email is unique globally or per account — implemented globally.

---

## 6. `disclosure_sections` is keyed on `trainer_id`, not on a disclosure

Section 2's table names the columns as `disclosure_sections (trainer_id, key, title, body,
included)` — but Section 8 also gives `Disclosures` its own fields (`updated_at`,
`update_note`, `first_published_at`), which makes it a table, and sections would ordinarily
point at it.

**Decided:** honour both. `disclosures` carries a `UNIQUE (trainer_id)` — which is Section 8's
"a single current record, edited in place" made structural anyway — and
`disclosure_sections.trainer_id` is a foreign key onto that unique column. The column list
matches `schema.md` exactly, and referential integrity still runs through the disclosure.

**Added, not specified:** `disclosure_sections.position`. The seven sections have an order a
rider reads them in, and the alternative is hard-coding that order in the app — which puts it
somewhere the coach's editor can't reach.

---

## 7. `riding_styles` is an enum array, not `text[]`

Section 2 specifies `text[]`, calling it "the exception. A fixed two-value vocabulary with no
table to point at. An array is honest here; a junction table would be ceremony."

**Decided:** keep the array, make it `riding_style[]` — a Postgres enum array.

The reasoning for the array is untouched. What changes is that the "fixed vocabulary" is
enforced where the values are stored rather than only in the engine, which matters because
Section 8's stated reason for one shared list is that pairing does "exact matching rather than
fuzzy string comparison" — and `'english'` in a `text[]` fails that check silently.

**The cost:** adding a third style becomes `ALTER TYPE ... ADD VALUE`, i.e. a migration. Given
that the list was deliberately *revised down* from six to two, that reads as a feature. Say so
if you disagree — the change back is one word in three files.

---

## 8. `day_of_week` is an enum of names, not 0–6

Not specified either way; Section 8 says "Mon–Sun". Chose `('mon'…'sun')` so a row is readable
and constraint #4 reads as the rule it enforces. This is only safe because `btree_gist`
supports enum types — with an integer it would have been unambiguous.

The engine uses numeric day indices (`a.day === dayIdx`), so this is one more entry on the
repository's mapping list, alongside snake_case → camelCase.

---

## 9. Range bounds in both exclusion constraints are `[)`, which nothing specifies

Not mentioned anywhere, and it changes behaviour in both places:

- **Bookings:** a lesson ending at 10:00 and one starting at 10:00 must not conflict. Any
  buffer the coach wants between them is `min_buffer_min`, a scheduling preference enforced in
  the engine — not a welfare constraint, and not something a database constraint should be
  quietly imposing.
- **Price bands:** two touching bands (ending 15:00, starting 15:00) must be legal, since
  Section 8 matches a band on the lesson's *start time alone*. Closed bounds would reject every
  pair of adjacent bands, which is the normal way a coach would carve up an afternoon.

---

## 10. The slot-holding status list is now written in two places

`HOLDS_SLOT` in `engine/constants.js` is one definition, deliberately — it exists because the
`pending`/`confirmed` pair had been spelled out inline in six places.

Constraint #1's predicate spells it out a seventh time:

```sql
WHERE (status IN ('pending', 'confirmed'))
```

A constraint predicate cannot import a constant, so this is unavoidable rather than a slip. It
is worth knowing that **adding a status that holds a slot is now a migration**, not just an
edit to `constants.js` — and that forgetting the migration produces a horse that can be
double-booked in exactly the status you just added.

---

## 11. Tenant columns where `schema.md` says only "everything else"

Section 1's trainer-level list names availability, time off, config, lesson types, price bands,
disclosures, students, bookings, recurring patterns, offers, notes and alerts. Several tables
in Section 8 aren't on it.

**Given an explicit `trainer_id`,** even though it is reachable through the student —
`bookings`, `offers`, `recurring_bookings`, `message_log`. The coach's Day view is the hottest
query in the product and it is "this trainer, this date"; going through `students` to answer it
is a join on the read path for every screen.

**Left unscoped, reachable only through parents** — `substitution_assignments` (via its period,
recurring pattern or booking), the two `lesson_type_*` junctions, `student_riding_windows`,
`student_no_ride_horses`, `disclosure_acceptances`. `substitution_assignments` is the awkward
one: its period is account-level and its target is trainer-level, so it has no single natural
home. If the repository turns out to want to list a trainer's pending substitutions directly,
it wants a `trainer_id`.

**Given `account_id`** — `horses` and `horse_inactive_periods`, exactly as specified.

**Not enforced structurally:** that a booking's horse belongs to the booking trainer's account.
Horses are account-level and bookings trainer-level, so a composite foreign key would need
`account_id` denormalised onto `bookings`. Section 1 says scoping is "one `trainer_id` filter
at the repository, once", so this is left to that layer — noted because it is the one
cross-level relationship the database does not police. `lesson_type_band_adjustments` *does*
get composite foreign keys, because both sides are trainer-level and the failure there is a
silently wrong price.

---

## 12. `auth_codes` is keyed on a phone string, not on an identity

Section 4 lists `auth_codes (phone, code_hash, expires_at, consumed_at)` and separately says
"attempts are rate-limited per phone."

**Decided:** keep `phone` as text with no foreign key — the first code a number ever receives
is necessarily sent before any `auth_identities` row exists for it. Added an `attempts` counter
on the code row.

**Worth revisiting:** a counter on the code row is cleared by issuing a new code, so an
attacker who can trigger sends can reset their own attempt budget. A rate limit that survives
that belongs in its own table keyed by phone (or in Redis). Section 4 asserts the requirement
without saying where the state lives; this is the weaker of the two readings and is marked as
such rather than presented as done.

---

## 13. Row-Level Security scopes `bookings` to the ACCOUNT, not the trainer

Migration `0002` puts tenant isolation in the database rather than leaving it to the
repository, on the same argument that made `horse_not_double_booked` a constraint: the
repository can only be trusted while every read goes through it, and the first query that does
not is silent. Most policies follow the tenant columns exactly — account-scoped tables match on
`account_id`, trainer-scoped tables on `trainer_id`, and the four student-derived tables
(`student_alerts`, `student_notes`, `student_riding_windows`, `student_no_ride_horses`) join
back through `students`.

**`bookings` is the exception, and it is deliberate.** The table carries `trainer_id`, so the
obvious policy is `trainer_id = app_current_trainer()`. That policy is wrong here. Horse
welfare — rest days, and the daily saddle-time caps — counts every lesson the animal did that
day regardless of which coach booked it. Under a trainer-scoped policy the welfare rules would
be structurally unable to see half their input in a two-coach barn, which is the exact failure
that made coach-level tenancy untenable in the first place (a horse ridden 90 minutes by each
is at 180 and no rule knows).

RLS cannot distinguish "reading for the welfare check" from "reading for the coach's day
view" — it sees one table and one caller. So the policy is scoped to the account, and the
trainer narrowing for the day view stays in the repository, where it already was. What RLS
adds is the guarantee the repository could never make: no query, scoped or not, reaches
**another account's** lessons.

The cost is stated plainly: a coach can read her barn-mate's lesson rows, including
`student_id`. Within one account that is already true of the horses they share, and both
coaches are on the same account by choice. Across accounts nothing is visible.

**What would reopen this:** an account whose trainers are not mutually trusted — a facility
renting stalls to independent coaches rather than employing them. That is a different tenancy
model, and the fix is not a different policy but a `SECURITY DEFINER` function for the welfare
reads, so the caps can see the whole barn while ordinary reads cannot.

Two related calls recorded with it:

- **The app runs as `rydeahorse_app`, not as the connection owner.** RLS does not apply to a
  table's owner, and on Neon `neondb_owner` additionally carries `BYPASSRLS` — so every policy
  is dead code for the role that runs migrations. Enforcement requires a role that is neither.
  The role is `NOLOGIN`; callers `SET LOCAL ROLE` into it for the duration of a transaction.
  A deployment preferring a real login role can add `LOGIN` without touching a policy.
- **`auth_identities` and `auth_codes` are deliberately left out.** They legitimately span
  tenants — one phone number holds profiles under several trainers, and "one code surfaces
  every profile attached to a number" is the specified behaviour. Scoping them to a trainer
  breaks that lookup; scoping them to an account misdescribes what they hold. They contain a
  phone number and a verification state, no roster data. Authorisation for them belongs in the
  auth flow, which is not built.

## 14. Smaller calls, listed for completeness

- **`Message_Log.timestamp` → `message_log.sent_at`.** `timestamp` collides with the type name
  in every statement that touches it.
- **`trainers.timezone` has no default.** Not specified. Forced explicit rather than
  defaulting to a zone that would be silently wrong for two thirds of the country.
- **`late_cancel_hours` defaults to 24**, which is a default and not a rule — Section 8 is
  explicit that "the threshold is the coach's setting, not a fixed 24 hours."
- **Both frequency-tier thresholds are nullable and ship null**, matching the known gap:
  they're computed from completed calendar months and on day one there aren't any.
- **`bookings.is_billable` defaults false** alongside `status` defaulting to `pending`, which
  Section 8 calls "pending outcome."
- **`students.frequency_tier_effective_month` is a `date` pinned to the 1st** (with a `CHECK`),
  not the `2026-08` string Section 8 shows, so month arithmetic is date arithmetic.
- **No `invoices`, `payments`, barn roles, shared-rider tables or soft deletes** — all deferred
  in Section 7, none created. `message_log` *is* created and ships empty, as specified.
- **Every foreign key to `horses` and `students` is `RESTRICT`** from the tables that would
  orphan history, and `CASCADE` only from junctions. Neither can be deleted today, only
  deactivated, and that is what makes the `horses.find(...)` lookups in the render path safe.

### CHECK constraints added beyond what `schema.md` asks for

Most encode a rule the documents already state in prose — tier 2 must exceed tier 1; a minor
must have a guardian name and phone; `ride_time_min` can't exceed `duration_min`; a group type
has a capacity and a private one doesn't; `potential_lesson_eligible` is forced off for a group
type; exactly one of `recurring_id`/`booking_id` is set on a substitution; an ended pattern or
inactive period has an end date.

**One is an inference, not a stated rule, and is the one to challenge:**
`lesson_types_intro_not_group`. Nothing forbids a group intro type — but slot discovery ignores
group sessions unconditionally, so `find_intro_lesson_options` would return nothing for one,
and a brand-new rider would see an empty screen with no explanation. Making it impossible
seemed better than making it silently useless. If group intro lessons are wanted, drop this one
check; nothing else depends on it.

`horses_adult_cap_within_overall` is also mine: the adult subset of a day's saddle time can't
exceed the overall ceiling it is a subset of.
