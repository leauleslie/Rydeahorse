# `db/test/` — suites that run against a real Postgres

```bash
npm run test:mark      # once per branch: designate it as safe to truncate
npm run test:migrate   # apply migrations to the test branch, through the same guard
npm test               # guard + concurrency + tenancy + rls
```

Four suites. `guard.test.js` is offline; the other three need a database and TRUNCATE it.

## The refusal

Everything here reads `TEST_DATABASE_URL`. Nothing reads `DATABASE_URL`, and there is no
fallback to it — the fallback is the accident being prevented. Two independent layers, in
`guard.js` and `db.js`:

1. **Deny, before connecting.** Whatever `DATABASE_URL` / `DIRECT_DATABASE_URL` point at is
   production by definition, and the test URL may not resolve to the same host+port+database.
   Neon's `-pooler` and direct hostnames are normalised to the same identity first, because
   they *are* the same database and a raw string compare would miss it. Also refuses an unset
   URL, `NODE_ENV=production`, and hosts or database names containing `prod`/`production`/
   `live`/`prd` as whole tokens.
2. **Allow, after connecting.** The database must carry `public._rydeahorse_test_marker`,
   which only `npm run test:mark` creates — and marking refuses unless the database is
   **empty**. Production has rows, so production cannot be marked.

Layer 1 alone fails in CI, where `DATABASE_URL` is usually absent and a deny list with no
entries denies nothing. Layer 2 alone can be defeated by copying a database. Neither is
bypassable by a flag, deliberately.

Note the shape of the problem here: all three Neon URLs use the same database name
(`neondb`) and the same user (`neondb_owner`). Only the host differs. A guard asserting
`database === 'test'` would wave production straight through.

## Row-Level Security

`rls.test.js` covers the isolation that `tenancy.test.js` cannot. The harness proves the reads
in `db/repo/` filter correctly; it can say nothing about the read written next month by someone
who did not know `forTenant` existed. Migration `0002` puts the boundary in the database, so
**every query in `rls.test.js` deliberately bypasses the repository** — there are no WHERE
clauses on its assertions. If a row does not come back, only the database decided that.

Three things about how it must be called, all of them load-bearing:

- **`SET LOCAL`, always inside an explicit `BEGIN`/`COMMIT`.** Neon's `DATABASE_URL` is
  PgBouncer in transaction mode, which hands the backend to a *different client* between
  transactions. A session-level `SET app.trainer_id` outlives the request that set it, and the
  next tenant inherits the previous tenant's identity. `SET LOCAL` is reverted at
  COMMIT/ROLLBACK — the same unit the pooler recycles. The suite proves the difference rather
  than asserting it.
- **`SET LOCAL ROLE rydeahorse_app`.** RLS does not apply to a table's owner, and on Neon
  `neondb_owner` additionally carries `BYPASSRLS`, so every policy is dead code for the role
  that runs migrations. There is a test asserting the owner *does* still see everything, so
  that caveat cannot quietly stop being true.
- **Identity is set with `set_config(name, value, true)`**, because a value cannot be
  interpolated into `SET LOCAL`.

Both failure modes fail closed, and both are asserted: an unset GUC matches no rows (policies
read `current_setting(…, true)`, which yields NULL), and a `SET LOCAL` issued without a
surrounding `BEGIN` is discarded before the next statement — so a caller who forgets the
transaction gets **zero rows, never another tenant's**.

`bookings` is scoped to the *account* rather than the trainer, deliberately; the reasoning and
what would reopen it are in `../SCHEMA-NOTES.md` §13.

## Adding a query to the isolation harness

One line in `tenant-queries.js`:

```js
q("bookings.listOn", "bookings", (r) => r.bookings.listOn(SHARED_DATE)),
```

`q(name, entitySet, run, opts)` — `entitySet` names the key in the seed manifest that
legitimately owns those rows; `run` receives a repository already bound to a tenant. For any
read taking a caller-supplied id, add `opts.probe` so the harness asks for the *other*
tenant's row:

```js
q("students.byId", "students", (r, own) => r.students.byId(own.students[0]), {
  probe: (r, other) => r.students.byId(other.students[0]),
}),
```

Without a probe, a `byId` that never filters by tenant passes every other check — it behaves
perfectly until someone passes a foreign id. That is the leak this harness exists for.

`tenancy.test.js` fails if a repository read is missing from the registry, so forgetting is
caught rather than silently untested.

## Why the fixture looks the way it does

Both tenants seed the *same* horse names, student names, lesson dates and start times. Only
ids and foreign keys differ. If tenant A taught on Monday and B on Thursday, an unscoped
`listBookingsOn('monday')` would return "the right rows" by accident and the harness would
report a pass for a query containing no tenant filter at all.

## What keeps these tests honest

Each suite contains checks whose only job is to make a false pass impossible:

- The concurrency test proves the two transactions genuinely overlapped, by asking Postgres
  (`pg_blocking_pids`) whether tx2 is parked on tx1 — and asserting tx2's insert has not
  returned at that moment. Serialized writes fail the exclusion constraint *too*, with the
  identical SQLSTATE, so without this the test would pass while proving nothing.
- The isolation harness rejects any read that returns zero rows. It also knows the schema has
  TWO rules — trainer-scoped reads must be disjoint, account-scoped reads must be identical
  within one account — so "A and B differ" is evidence of correctness for one and a bug for
  the other. `tenancy.test.js` registers five deliberately broken reads, covering both
  directions, and asserts the harness catches each.
- The "must not reject" concurrency cases assert their insert completes *while the other
  transaction is still open*, rather than merely succeeding eventually. Without that they
  would pass even if adjacency caused blocking.
- `rls.test.js` was checked by disabling RLS on one table: nine of its tests fail.

Both suites truncate the whole database, so they cannot run at the same time. `npm test`
pins `--test-concurrency=1`, and `acquireSuiteLock` takes a Postgres advisory lock so it
holds even when someone runs `node --test` directly.
