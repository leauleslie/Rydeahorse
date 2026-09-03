// THE REGISTRY.
//
// This is the file that grows. Adding a repository read means adding ONE line here; the
// harness picks it up and applies the whole battery without anyone writing a test. This is
// the check that stops one coach seeing another coach's students, and a check people have to
// remember to write is a check that stops being complete the first busy week.
//
//   q(name, scope, entitySet, run [, options])
//
//     name       what shows up in the test output
//     scope      "trainer" or "account" — WHICH RULE THIS READ OBEYS. Required, and
//                deliberately not defaulted: the two rules disagree about what a correct
//                result looks like, so the author has to decide rather than inherit.
//
//                  "trainer"  never crosses trainers, not even within one account
//                  "account"  IDENTICAL for two trainers in one account (they share the
//                             horse), disjoint across accounts
//
//     entitySet  which key of the seed manifest these rows come from — how the harness knows
//                which ids are legitimately the caller's. Account-level sets (`horses`,
//                `accountBookings`) resolve to the same array for both trainers of an
//                account, which is what makes the sharing assertion meaningful.
//     run        (repo, ownManifest) => rows.  `repo` is ALREADY bound to a tenant.
//     options.id     row => comparable scalar. Defaults to `row.id`; override for composite
//                    keys.
//     options.probe  (repo, otherManifest) => rows, expected empty. Add to any read taking a
//                    caller-supplied identifier — without it, a `byId` that never filters by
//                    tenant passes every other check, because it behaves perfectly right up
//                    until someone passes a foreign id.
import { SHARED_DATE } from "./seed.js";

const q = (name, scope, owns, run, opts = {}) => ({
  name,
  scope,
  owns,
  run,
  id: opts.id ?? ((row) => row.id),
  probe: opts.probe,
});

export const TENANT_READS = [
  // --- account-scoped: two trainers in one barn share these ---
  q("horses.list", "account", "horses", (r) => r.horses.list()),
  q("horses.listActive", "account", "horses", (r) => r.horses.listActive()),
  q("horses.byId", "account", "horses", (r, own) => r.horses.byId(own.horses[0]), {
    probe: (r, other) => r.horses.byId(other.horses[0]),
  }),
  // Horse welfare counts every lesson the animal did that day, whoever booked it — so this
  // one read of a trainer-scoped table answers to the account rule.
  q("bookings.listForHorsesOn", "account", "accountBookings", (r) =>
    r.bookings.listForHorsesOn(SHARED_DATE)),

  // --- trainer-scoped ---
  q("students.list", "trainer", "students", (r) => r.students.list()),
  q("students.byId", "trainer", "students", (r, own) => r.students.byId(own.students[0]), {
    probe: (r, other) => r.students.byId(other.students[0]),
  }),
  q("lessonTypes.list", "trainer", "lessonTypes", (r) => r.lessonTypes.list()),
  q("priceBands.list", "trainer", "priceBands", (r) => r.priceBands.list()),
  q("priceBands.windows", "trainer", "priceBandWindows", (r) => r.priceBands.windows()),
  q("availability.list", "trainer", "availability", (r) => r.availability.list()),
  q("timeOff.list", "trainer", "timeOff", (r) => r.timeOff.list()),
  q("lessonTypes.bandAdjustments", "trainer", "bandAdjustments", (r) => r.lessonTypes.bandAdjustments(), {
    id: (row) => `${row.lessonTypeId}:${row.bandId}`,
  }),
  q("lessonTypes.restrictedHorses", "trainer", "restrictedHorses", (r) => r.lessonTypes.restrictedHorses(), {
    id: (row) => `${row.lessonTypeId}:${row.horseId}`,
  }),
  q("recurring.list", "trainer", "recurring", (r) => r.recurring.list()),
  q("offers.listOn", "trainer", "offers", (r) => r.offers.listOn(SHARED_DATE)),
  // Same table and same date as bookings.listForHorsesOn above, opposite rule: the coach's
  // day view is hers alone.
  q("bookings.listOn", "trainer", "bookings", (r) => r.bookings.listOn(SHARED_DATE)),
  q("bookings.listForStudent", "trainer", "bookings", (r, own) =>
    r.bookings.listForStudent(own.students[0]), {
    probe: (r, other) => r.bookings.listForStudent(other.students[0]),
  }),

  // --- no tenant column of their own; scoped by joining back through students ---
  q("alerts.list", "trainer", "alerts", (r) => r.alerts.list()),
  q("notes.list", "trainer", "notes", (r) => r.notes.list()),
  q("ridingWindows.list", "trainer", "ridingWindows", (r) => r.ridingWindows.list()),
  q("noRideHorses.list", "trainer", "noRideHorses", (r) => r.noRideHorses.list(), {
    id: (row) => `${row.studentId}:${row.horseId}`,
  }),
];
