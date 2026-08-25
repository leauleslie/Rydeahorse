# Rules & Pricing Engine

Extracted from `prototype.jsx`. Pure JavaScript — no React, no DOM, no database, no ambient
clock, no network. It runs unchanged on the server, where it is authoritative, and in the
browser, where it previews. Neither side reimplements it.

```
npm test    # node --test, no dependencies
```

## The contract

Two entry points matter:

```js
validateBooking({ student, horse, lessonType, date, start, bookings, students,
                  lessonTypes, availability, timeOffBlocks, priceBands,
                  trainerConfig, offerDiscount, manualAdjustment })
  -> { ok, checks: [{ code, label, pass }], quote }

priceFor({ student, lessonType, date, start, offerDiscount, manualAdjustment,
           priceBands, trainerConfig })
  -> { basePrice, bandAdjustment, frequencyDiscount, offerDiscount,
       manualAdjustment, price, raw, band, tier, flooredBy, cappedBy }
```

`validateBooking` evaluates all seven checks every time and reports them in specification
order. It does not short-circuit: a validation checklist has to show the whole picture at once,
and `firstFailure()` picks the reported reason off the front of the list.

`priceFor` never returns a bare number. Every screen that shows a price must be able to show the
reasoning behind it, so the components come back with the total, always.

## What changed in the extraction

**1. The clock is a parameter.** `TODAY` and `NOW_MIN` were module-level constants that eight
functions read directly. Every time-dependent function now takes `now` as an explicit argument.
This is the change that makes the engine servable: a long-running process cannot hold a "today"
evaluated at boot, coaches are in different timezones, and the two-month tier ratchet and the
24-hour cancel boundary cannot be tested if time cannot be set. `clock.js` has the reasoning.

**2. Checks carry a stable `code` alongside the human `label`.** The prototype matched on label
text, which is fine when one file owns both. Across an HTTP boundary a UI string is not an
identifier, and `Price floored at $55` interpolates a number into the thing you'd be matching on.

**3. `holdsSlot` replaces the inline `pending`/`confirmed` pair.** The same two-status test was
spelled out in six places. A status added later that should block a booking now gets added once.

**4. Interval overlap is one shared function.** Bands, bookings and coach-busy intervals were
each doing their own `<` / `>` comparison. Same rule, three copies, three chances to write it
backwards.

Behaviour is otherwise unchanged, deliberately — including the known day-granular completion
vs. minute-granular cancellation inconsistency, which is now a one-line change in `derive.js`
but stays a decision rather than a side effect of this refactor.

## Not in here

Deliberately left behind, because they aren't rules:

- **Seed data** — the fixtures in `test/fixtures.js` are hand-built to make specific boundaries
  reachable. Seed data is tuned to make screens look plausible, which makes it a bad instrument
  for pinning down a rule.
- **Display formatting** — `statusInfo`, `typeBadge`, tone names, `Badge`. Presentation.
- **Slot finding and matching** — `findOpenSlots`, `eligibleStudentsForSlot`,
  `findIntroOptions`, `findRecurringOptions`, `offerRespectsPreferences`. These are pure and
  rules-dependent, and they should be extracted next, as their own module sitting on top of
  this one. They're a layer above the engine, not part of it: the engine answers "may this
  booking exist," matching answers "what should we suggest."
- **Occurrence generation** — `generateOccurrences` produces the rolling horizon. It belongs
  with the scheduled job that will call it.

## Where the tenant boundary goes

Not in here. The engine takes the horses, students, bookings and config it is given and never
asks where they came from — which means it cannot leak across tenants, because it cannot query.
Scoping is the data layer's job: one `trainer_id` filter at the repository, applied once.

Keep it that way. The moment the engine takes a `trainerId` and fetches something, every rule
in it becomes untestable without a database.
