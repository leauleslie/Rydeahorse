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
  trainerTimeOff,
  lessonTypeBandAdjustments,
  lessonTypeRestrictedHorses,
} from "../schema/index.js";
import {
  toEngineHorse,
  toEngineStudent,
  toEngineLessonType,
  toEngineBooking,
  toEngineAvailability,
  toEngineTimeOff,
  toEnginePriceBands,
  toEngineTrainerConfig,
  toEngineOffer,
  toEngineRidingWindows,
} from "./to-engine.js";
import { trainers } from "../schema/index.js";
import { writesFor } from "./writes.js";

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
/**
 * Bind a repository to one tenant.
 *
 * `client` is optional and only writes need it — they take an advisory lock and check that they
 * are inside a tenant transaction, neither of which drizzle exposes. Reads work without it, so
 * the many read-only call sites are unchanged. Ask for `repo.write` without a client and you
 * get a message saying so rather than a TypeError three frames down.
 */
export function forTenant(db, { accountId, trainerId, client = null }) {
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

  const ownLessonTypeIds = db
    .select({ id: lessonTypes.id })
    .from(lessonTypes)
    .where(eq(lessonTypes.trainerId, trainerId));

  const repo = {
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
      // The two junctions the engine needs as inline fields on a lesson type.
      bandAdjustments: () =>
        db
          .select()
          .from(lessonTypeBandAdjustments)
          .where(eq(lessonTypeBandAdjustments.trainerId, trainerId)),
      // No trainer_id of its own; scoped through the lesson type that owns it.
      restrictedHorses: () =>
        db
          .select()
          .from(lessonTypeRestrictedHorses)
          .where(inArray(lessonTypeRestrictedHorses.lessonTypeId, ownLessonTypeIds)),
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

    timeOff: {
      list: () => db.select().from(trainerTimeOff).where(eq(trainerTimeOff.trainerId, trainerId)),
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

    /**
     * Everything `validateBooking` and `priceFor` need for one date, in the engine's own
     * shapes. This is the seam: above it, screens speak the engine's vocabulary and never see
     * a column name; below it, nothing knows what a rule is.
     *
     * Returns the engine's argument bag minus the three choices a screen is making — the
     * student, the horse and the lesson type — which callers spread in:
     *
     *   const ctx = await repo.engineInputsFor(date);
     *   validateBooking({ ...ctx, student, horse, lessonType, date, start });
     *
     * `bookings` is loaded ACCOUNT-wide rather than for this trainer, deliberately. The rest-day
     * and saddle-time checks count every lesson the animal did regardless of who booked it, and
     * handing the engine only this coach's bookings would let a shared horse pass a welfare
     * check it should fail. This is the same reason the RLS policy on `bookings` is
     * account-scoped.
     */
    engineInputsFor: async (date) => {
      const [
        horseRows, studentRows, lessonTypeRows, bookingRows,
        availabilityRows, timeOffRows, bandRows, windowRows,
        noRideRows, adjustmentRows, restrictedRows, trainerRows,
        ridingWindowRows, offerRows,
      ] = await Promise.all([
        db.select().from(horses).where(eq(horses.accountId, accountId)),
        db.select().from(students).where(eq(students.trainerId, trainerId)),
        db.select().from(lessonTypes).where(eq(lessonTypes.trainerId, trainerId)),
        // Account-wide — see above.
        db.select().from(bookings).where(inArray(bookings.horseId, ownHorseIds)),
        db.select().from(trainerAvailability).where(eq(trainerAvailability.trainerId, trainerId)),
        db.select().from(trainerTimeOff).where(eq(trainerTimeOff.trainerId, trainerId)),
        db.select().from(priceBands).where(eq(priceBands.trainerId, trainerId)),
        db.select().from(priceBandWindows).where(eq(priceBandWindows.trainerId, trainerId)),
        db.select().from(studentNoRideHorses).where(inArray(studentNoRideHorses.studentId, ownStudentIds)),
        db.select().from(lessonTypeBandAdjustments).where(eq(lessonTypeBandAdjustments.trainerId, trainerId)),
        db.select().from(lessonTypeRestrictedHorses).where(inArray(lessonTypeRestrictedHorses.lessonTypeId, ownLessonTypeIds)),
        db.select().from(trainers).where(eq(trainers.id, trainerId)),
        // Matching needs both: a student's own windows decide whether a slot is worth offering
        // them at all, and past offers decide the order.
        db.select().from(studentRidingWindows).where(inArray(studentRidingWindows.studentId, ownStudentIds)),
        db.select().from(offers).where(eq(offers.trainerId, trainerId)),
      ]);

      // Group the junctions once, rather than filtering inside each map — a lesson type with
      // no adjustments must still come back with `{}` and not `undefined`, because the engine
      // indexes into it.
      const windowsByStudent = new Map();
      for (const r of ridingWindowRows) {
        if (!windowsByStudent.has(r.studentId)) windowsByStudent.set(r.studentId, []);
        windowsByStudent.get(r.studentId).push(r);
      }
      const noRideByStudent = new Map();
      for (const r of noRideRows) {
        if (!noRideByStudent.has(r.studentId)) noRideByStudent.set(r.studentId, []);
        noRideByStudent.get(r.studentId).push(r.horseId);
      }
      const adjustmentsByType = new Map();
      for (const r of adjustmentRows) {
        if (!adjustmentsByType.has(r.lessonTypeId)) adjustmentsByType.set(r.lessonTypeId, {});
        adjustmentsByType.get(r.lessonTypeId)[r.bandId] = r.amount;
      }
      const restrictedByType = new Map();
      for (const r of restrictedRows) {
        if (!restrictedByType.has(r.lessonTypeId)) restrictedByType.set(r.lessonTypeId, []);
        restrictedByType.get(r.lessonTypeId).push(r.horseId);
      }

      if (!trainerRows.length) {
        // Only reachable if the tenant id is wrong or RLS hid the row — either way the engine
        // would otherwise fail deep inside pricing on a null config.
        throw new Error(`no trainer row visible for ${trainerId}; cannot build engine inputs`);
      }

      return {
        date,
        horses: horseRows.map(toEngineHorse),
        students: studentRows.map((r) =>
          toEngineStudent(r, {
            noRideHorseIds: noRideByStudent.get(r.id) ?? [],
            ridingWindows: toEngineRidingWindows(windowsByStudent.get(r.id) ?? []),
          })),
        lessonTypes: lessonTypeRows.map((r) =>
          toEngineLessonType(r, {
            bandAdjustments: adjustmentsByType.get(r.id) ?? {},
            restrictedHorseIds: restrictedByType.get(r.id) ?? [],
          })),
        // Two scopes, because two rules need different ones. `bookings` is the whole account —
        // horse welfare and the horse half of double-booking count every lesson the animal did,
        // whoever booked it. `trainerBookings` is this coach alone, because reporting a coach as
        // busy while their barn-mate teaches refuses a slot that is genuinely free.
        bookings: bookingRows.map(toEngineBooking),
        trainerBookings: bookingRows.filter((b) => b.trainerId === trainerId).map(toEngineBooking),
        availability: toEngineAvailability(availabilityRows),
        timeOffBlocks: toEngineTimeOff(timeOffRows),
        priceBands: toEnginePriceBands(bandRows, windowRows),
        trainerConfig: toEngineTrainerConfig(trainerRows[0]),
        offers: offerRows.map(toEngineOffer),
      };
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

  // Mutations live under their own namespace so that every call site says, in the expression
  // itself, that it is changing something — `repo.write.bookings.create(...)`. It also keeps the
  // isolation harness honest: that harness enumerates reads and asserts row scoping, which is
  // not a question that means anything about an INSERT.
  Object.defineProperty(repo, "write", {
    enumerable: false,
    get() {
      if (!client) {
        throw new Error(
          "repo.write needs a client: forTenant(db, { accountId, trainerId, client }).\n" +
            "Writes take an advisory lock and verify they are inside withTenantTransaction, " +
            "and neither is reachable through drizzle alone.",
        );
      }
      return writesFor({
        db, client, accountId, trainerId,
        engineInputsFor: repo.engineInputsFor,
      });
    },
  });

  return repo;
}
