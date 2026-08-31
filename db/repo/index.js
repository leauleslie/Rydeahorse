// The repository. The one layer that knows which tenant is asking.
//
// `schema/` declares tables and takes no tenant id, because it does not query. The engine
// takes plain objects and takes no tenant id, because it cannot query. That leaves exactly
// one place where a row can be fetched for the wrong coach: here. Every function below is
// reached through `forTenant`, which closes over the ids, so no call site is able to forget
// to pass one — the only way to read is to have already said who you are.
//
// Two scoping levels, because there are two levels of tenancy (schema.md Section 1):
//
//   accountId  — horses, and anything judged about a horse. A horse is a physical animal at
//                a facility; two coaches sharing a barn share it, and share its usage.
//                Scoping horse reads by trainer would hide half a horse's saddle time from
//                the welfare rules, which is the failure that made account-level tenancy
//                necessary in the first place.
//   trainerId  — everything else. Students are trainer-scoped; a rider taking lessons from
//                two coaches is two rows.
//
// Some tables (student_alerts, student_notes, student_riding_windows,
// student_no_ride_horses) carry NEITHER id. They hang off `students`, and their scoping is a
// join back through it. Those are the easiest ones to get wrong and the most damaging to get
// wrong, which is why they are in the isolation harness by name.
import { and, eq, inArray } from "drizzle-orm";
import {
  horses,
  students,
  bookings,
  recurringBookings,
  lessonTypes,
  priceBands,
  priceBandWindows,
  trainerAvailability,
  studentAlerts,
  studentNotes,
  studentRidingWindows,
  studentNoRideHorses,
  offers,
} from "../schema/index.js";

/**
 * Open a tenant-scoped transaction and run `fn` inside it.
 *
 * This is the sanctioned way to touch the database, and the only shape under which the
 * row-level security policies from migration 0002 actually apply. Three things happen here,
 * and each of them is load-bearing:
 *
 *   BEGIN               An EXPLICIT transaction. `SET LOCAL` outside one applies to the
 *                       implicit single-statement transaction and is discarded before the next
 *                       statement — so a caller without this gets zero rows rather than
 *                       another tenant's, but gets nothing useful either.
 *
 *   SET LOCAL ROLE      RLS does not apply to a table's owner, and on Neon the owner also
 *                       carries BYPASSRLS. Running as the connecting role would leave every
 *                       policy inert. `rydeahorse_app` is NOLOGIN and exists only to be
 *                       switched into.
 *
 *   set_config(…, true) The tenant identity, transaction-local. `true` is the `is_local`
 *                       argument, and it is the whole difference between safe and unsafe under
 *                       a transaction-mode pooler: Neon's pooled endpoint hands the backend to
 *                       a DIFFERENT client between transactions, so a session-level setting
 *                       becomes the next request's identity. A value cannot be interpolated
 *                       into `SET LOCAL`, which is why this is set_config rather than SQL.
 *
 * All three are reverted at COMMIT or ROLLBACK, which is exactly the unit the pooler recycles.
 *
 * @param client  a node-postgres Client (or a pool client already checked out — it must be ONE
 *                connection for the duration, or SET LOCAL lands on a different backend than
 *                the queries)
 * @param tenant  { accountId, trainerId }
 * @param fn      receives nothing; run queries on the same client/drizzle handle
 */
export async function withTenantTransaction(client, { accountId, trainerId }, fn) {
  if (!accountId || !trainerId) {
    throw new Error("withTenantTransaction requires both accountId and trainerId");
  }
  await client.query("begin");
  try {
    await client.query("set local role rydeahorse_app");
    await client.query("select set_config('app.account_id', $1, true)", [accountId]);
    await client.query("select set_config('app.trainer_id', $1, true)", [trainerId]);
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

/**
 * Bind a repository to one tenant.
 * @param db        drizzle handle
 * @param tenant    { accountId, trainerId }
 */
export function forTenant(db, { accountId, trainerId }) {
  if (!accountId || !trainerId) {
    throw new Error("forTenant requires both accountId and trainerId");
  }

  // Reused by every read on a table that hangs off `students`. A subquery rather than a join
  // so the projection stays the table's own columns.
  const ownStudentIds = db
    .select({ id: students.id })
    .from(students)
    .where(eq(students.trainerId, trainerId));

  const ownHorseIds = db
    .select({ id: horses.id })
    .from(horses)
    .where(eq(horses.accountId, accountId));

  return {
    tenant: { accountId, trainerId },

    horses: {
      list: () => db.select().from(horses).where(eq(horses.accountId, accountId)),
      listActive: () =>
        db
          .select()
          .from(horses)
          .where(and(eq(horses.accountId, accountId), eq(horses.active, true))),
      byId: (id) =>
        db
          .select()
          .from(horses)
          .where(and(eq(horses.accountId, accountId), eq(horses.id, id))),
    },

    students: {
      list: () => db.select().from(students).where(eq(students.trainerId, trainerId)),
      byId: (id) =>
        db
          .select()
          .from(students)
          .where(and(eq(students.trainerId, trainerId), eq(students.id, id))),
    },

    lessonTypes: {
      list: () => db.select().from(lessonTypes).where(eq(lessonTypes.trainerId, trainerId)),
    },

    priceBands: {
      list: () => db.select().from(priceBands).where(eq(priceBands.trainerId, trainerId)),
      windows: () =>
        db
          .select()
          .from(priceBandWindows)
          .where(eq(priceBandWindows.trainerId, trainerId)),
    },

    availability: {
      list: () =>
        db
          .select()
          .from(trainerAvailability)
          .where(eq(trainerAvailability.trainerId, trainerId)),
    },

    bookings: {
      listOn: (date) =>
        db
          .select()
          .from(bookings)
          .where(and(eq(bookings.trainerId, trainerId), eq(bookings.date, date))),
      listForStudent: (studentId) =>
        db
          .select()
          .from(bookings)
          .where(and(eq(bookings.trainerId, trainerId), eq(bookings.studentId, studentId))),
      // Account-scoped, NOT trainer-scoped, and deliberately so: this read feeds the horse
      // welfare rules (rest days, daily saddle-time caps), which count every lesson the
      // animal did that day regardless of which coach booked it.
      listForHorsesOn: (date) =>
        db
          .select()
          .from(bookings)
          .where(and(inArray(bookings.horseId, ownHorseIds), eq(bookings.date, date))),
    },

    recurring: {
      list: () =>
        db
          .select()
          .from(recurringBookings)
          .where(eq(recurringBookings.trainerId, trainerId)),
    },

    offers: {
      listOn: (date) =>
        db
          .select()
          .from(offers)
          .where(and(eq(offers.trainerId, trainerId), eq(offers.date, date))),
    },

    // ---- the four that carry no tenant column of their own ----
    alerts: {
      list: () => db.select().from(studentAlerts).where(inArray(studentAlerts.studentId, ownStudentIds)),
    },
    notes: {
      list: () => db.select().from(studentNotes).where(inArray(studentNotes.studentId, ownStudentIds)),
    },
    ridingWindows: {
      list: () =>
        db
          .select()
          .from(studentRidingWindows)
          .where(inArray(studentRidingWindows.studentId, ownStudentIds)),
    },
    noRideHorses: {
      list: () =>
        db
          .select()
          .from(studentNoRideHorses)
          .where(inArray(studentNoRideHorses.studentId, ownStudentIds)),
    },
  };
}
