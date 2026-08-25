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
