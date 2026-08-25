// THE REGISTRY.
//
// This is the file that grows. Adding a repository read means adding ONE line here; the
// harness in tenancy.test.js picks it up and applies all seven isolation checks to it without
// anyone writing a test. That is the point — this is the check that stops one coach seeing
// another coach's students, and a check people have to remember to write is a check that
// stops being complete the first busy week.
//
//   q(name, entitySet, run [, options])
//
//     name       what shows up in the test output
//     entitySet  which key of the seed manifest these rows come from — that is how the
//                harness knows which ids are legitimately the caller's
//     run        (repo, ownManifest) => rows.  `repo` is ALREADY bound to a tenant.
//     options.id     row => comparable scalar. Defaults to `row.id`; override for composite
//                    keys.
//     options.probe  (repo, otherManifest) => rows, expected empty. Add this to any read
//                    that takes a caller-supplied identifier — without it, a `byId` that
//                    never filters by tenant passes every other check.
//
// If a new read has no manifest key, add the entity set to seed.js and return its ids.
// Resist the urge to skip a read because "it obviously filters" — `students.byId` obviously
// filtered too, right up until it was written without the tenant clause.
import { SHARED_DATE } from "./seed.js";

const q = (name, owns, run, opts = {}) => ({
  name,
  owns,
  run,
  id: opts.id ?? ((row) => row.id),
  probe: opts.probe,
});

export const TENANT_READS = [
  // --- account-scoped ---
  q("horses.list", "horses", (r) => r.horses.list()),
  q("horses.listActive", "horses", (r) => r.horses.listActive()),
  q("horses.byId", "horses", (r, own) => r.horses.byId(own.horses[0]), {
    probe: (r, other) => r.horses.byId(other.horses[0]),
  }),

  // --- trainer-scoped ---
  q("students.list", "students", (r) => r.students.list()),
  q("students.byId", "students", (r, own) => r.students.byId(own.students[0]), {
    probe: (r, other) => r.students.byId(other.students[0]),
  }),
  q("lessonTypes.list", "lessonTypes", (r) => r.lessonTypes.list()),
  q("priceBands.list", "priceBands", (r) => r.priceBands.list()),
  q("priceBands.windows", "priceBandWindows", (r) => r.priceBands.windows()),
  q("availability.list", "availability", (r) => r.availability.list()),
  q("recurring.list", "recurring", (r) => r.recurring.list()),
  q("offers.listOn", "offers", (r) => r.offers.listOn(SHARED_DATE)),

  // --- bookings ---
  q("bookings.listOn", "bookings", (r) => r.bookings.listOn(SHARED_DATE)),
  q("bookings.listForStudent", "bookings", (r, own) => r.bookings.listForStudent(own.students[0]), {
    probe: (r, other) => r.bookings.listForStudent(other.students[0]),
  }),
  // Account-scoped on purpose: horse welfare counts every coach's lessons on that animal.
  q("bookings.listForHorsesOn", "bookings", (r) => r.bookings.listForHorsesOn(SHARED_DATE)),

  // --- the four with no tenant column of their own; scoped by joining back through students ---
  q("alerts.list", "alerts", (r) => r.alerts.list()),
  q("notes.list", "notes", (r) => r.notes.list()),
  q("ridingWindows.list", "ridingWindows", (r) => r.ridingWindows.list()),
  q("noRideHorses.list", "noRideHorses", (r) => r.noRideHorses.list(), {
    id: (row) => `${row.studentId}:${row.horseId}`,
  }),
];
