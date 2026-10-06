// The write side of the repository.
//
// Every function here MUST run inside `withTenantTransaction`. That is not a style preference:
// the RLS policies only apply to a transaction that has switched into `rydeahorse_app` and set
// its identity, and outside one an INSERT is rejected by the policy rather than by anything
// that explains itself. Each write asserts the precondition first so the failure names the
// cause instead of surfacing a bare 42501.
//
// Three principles from CLAUDE.md decide almost every line below:
//
//   The engine is authoritative.   A write never re-derives a rule. `bookings.create` calls
//                                  `validateBooking` and refuses if it fails; `bookings.cancel`
//                                  calls `cancelDisposition` and persists what it decides. If a
//                                  rule appears here, that is the bug.
//
//   The receipt is stamped, never  A price is a historical fact about a transaction. The five
//   recomputed.                    components come off the quote at creation and are written
//                                  once. Nothing here ever recomputes a stored price.
//
//   Alerts are informational.      A cancellation appends an alert; it never waits on one. The
//                                  coach owns the schedule.
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  bookings, students, studentAlerts, trainerAvailability, recurringBookings, horses, offers,
  // Aliased: `lessonTypes` and `priceBands` are also the names the ENGINE's input bag uses, and
  // a bare import would sit one typo away from writing to a table where a context field was
  // meant. The suffix makes the two impossible to confuse at a glance.
  lessonTypes as lessonTypesTable,
  lessonTypeBandAdjustments as bandAdjustmentsTable,
  lessonTypeRestrictedHorses as restrictedHorsesTable,
  priceBands as priceBandsTable,
  priceBandWindows as bandWindowsTable,
} from "../schema/index.js";
import { validateBooking, priceFor, cancelDisposition, parseTime, minToStr } from "../../engine/index.js";
import { toEngineBooking, toDate, toHHMM, DOW_NAME } from "./to-engine.js";

// The day_of_week enum -> what a rider reads in an alert. The enum is storage, not prose.
const DOW_LABEL = {
  sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday",
  thu: "Thursday", fri: "Friday", sat: "Saturday",
};

/**
 * The driver-level error behind whatever drizzle threw.
 *
 * drizzle wraps query failures, so the Postgres SQLSTATE lives on `.cause` rather than on the
 * error itself. Walking the chain rather than reaching for `.cause` once keeps this correct if
 * another layer wraps it again.
 */
export function pgErrorOf(err) {
  for (let e = err; e; e = e.cause) {
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e;
  }
  return null;
}

/**
 * Raised when the engine refuses a booking. Carries the checks so a screen can show all eight.
 *
 * `context.date` is set when the refusal came from one occurrence of a recurring pattern. A
 * series is refused as a whole, so without it the coach is told the pattern failed and left to
 * work out which of four weeks did it.
 */
export class BookingRejected extends Error {
  constructor(checks, context = {}) {
    const failed = checks.filter((c) => !c.pass).map((c) => c.code);
    super(
      `booking rejected: ${failed.join(", ")}` +
        (context.date ? ` (on ${context.date})` : ""),
    );
    this.name = "BookingRejected";
    this.checks = checks;
    this.failed = failed;
    this.context = context;
  }
}

/** Raised when another booking for the same coach and day is still in flight. */
export class BookingBusy extends Error {
  constructor(seconds) {
    super(
      `another booking for this coach and date did not settle within ${seconds}s. Nothing was ` +
        `written; retry. A request path must not wait on a lock indefinitely.`,
    );
    this.name = "BookingBusy";
  }
}

/** Raised when the database rejects a booking that the engine had passed. */
export class SlotTaken extends Error {
  constructor(constraint) {
    super(
      `the slot was taken by a concurrent booking (${constraint}). The engine validated against ` +
        `a world that changed before this transaction committed — which is exactly why the ` +
        `constraint exists.`,
    );
    this.name = "SlotTaken";
    this.constraint = constraint;
  }
}

/**
 * Refuse early and legibly if the caller forgot `withTenantTransaction`.
 *
 * Without this the write still fails — RLS sees no identity and the policy rejects it — but it
 * fails as a bare "new row violates row-level security policy", which sends the reader looking
 * for a policy bug instead of a missing wrapper.
 */
async function assertInTenantTransaction(client, { trainerId }) {
  const { rows } = await client.query(
    `select coalesce(current_setting('app.trainer_id', true), '') as tenant,
            current_user as who,
            pg_current_xact_id_if_assigned() is not null or
              transaction_timestamp() <> statement_timestamp() as in_tx`,
  );
  const { tenant, who, in_tx } = rows[0];
  if (!tenant) {
    throw new Error(
      "write attempted outside withTenantTransaction: no app.trainer_id is set, so row-level " +
        "security will reject this. Wrap the call in withTenantTransaction(client, tenant, fn).",
    );
  }
  if (tenant !== trainerId) {
    throw new Error(
      `write attempted under the wrong identity: the transaction is ${tenant} but the ` +
        `repository is bound to ${trainerId}.`,
    );
  }
  if (!in_tx) {
    throw new Error(
      "write attempted outside an explicit transaction. SET LOCAL is discarded at the end of " +
        "the implicit single-statement transaction, so identity would not survive to the write.",
    );
  }
  return { who };
}

/**
 * Serialize the trainer-availability half of check #6 for one coach and date.
 *
 * The HORSE half of double-booking is constraint #1 and needs no help — the database rejects
 * the race whatever the caller does. The TRAINER half stays in the engine, because it relaxes
 * for a below-capacity group session, and an engine check cannot see a row another transaction
 * has not committed yet. Two coaches' screens booking the same coach at the same time on
 * DIFFERENT horses would therefore both validate and both commit.
 *
 * Locking the existing rows with FOR UPDATE does not fix that: the conflicting row does not
 * exist yet, so there is nothing to lock — the classic phantom. A transaction-scoped advisory
 * lock keyed on (trainer, date) has no such gap, costs one integer, and is released at COMMIT
 * or ROLLBACK with no cleanup path to forget.
 */
const LOCK_TIMEOUT_SECONDS = 10;

async function lockTrainerDay(client, trainerId, date) {
  // Bounded, deliberately. An unbounded wait is fine in a script and wrong in a request path —
  // it turns a stuck transaction somewhere else into a hung page here, with no error to show.
  // The timeout also bounds the wait on the horse exclusion constraint later in this
  // transaction, which is the other place this insert can block.
  await client.query(`set local lock_timeout = '${LOCK_TIMEOUT_SECONDS}s'`);
  try {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `rydeahorse:trainer-day:${trainerId}:${date}`,
    ]);
  } catch (err) {
    // 55P03 is lock_not_available.
    if (pgErrorOf(err)?.code === "55P03") throw new BookingBusy(LOCK_TIMEOUT_SECONDS);
    throw err;
  }
}

const asDateString = (d) =>
  d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    : String(d);

export function writesFor({ db, client, accountId, trainerId, engineInputsFor }) {
  const tenant = { accountId, trainerId };

  /**
   * Work out a series' occurrences, prove every one of them bookable, and price each.
   *
   * Shared by create and update so the two cannot drift. The expensive property here is
   * ALL-OR-NOTHING: this writes nothing and throws on the first week that fails, so a caller
   * that has already deleted the occurrences it is replacing is safe — the transaction rolls
   * the deletion back with it.
   *
   * Each week is judged against a world that already contains the weeks planned before it.
   * Occurrences are seven days apart and the rest-day window is seven days wide, so consecutive
   * weeks sit exactly on that boundary: validating each in isolation would pass a pattern that
   * its own second week breaks.
   */
  async function planSeries({
    studentId, horseId, lessonTypeId, day, start, from,
    occurrences, manualAdjustment = 0, status = "confirmed", skip = new Set(),
  }) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new Error(`a recurring pattern needs a weekday index 0-6, got ${day}`);
    }
    if (occurrences < 1) throw new Error("a recurring pattern needs at least one occurrence");

    // The first date on or after `from` that falls on this weekday, then weekly.
    let first = new Date(toDate(from));
    while (first.getDay() !== day) first.setDate(first.getDate() + 1);
    const dates = Array.from({ length: occurrences }, (_, i) => {
      const d = new Date(first);
      d.setDate(d.getDate() + i * 7);
      return d;
    // `skip` holds the dates a caller is keeping as they are — a week the coach deliberately
    // put on a different horse. Planning one anyway would collide with the row being kept and
    // fail `trainer_free` against a lesson that is supposed to stay.
    }).filter((d) => !skip.has(asDateString(d)));

    // Locked in date order, every day up front. Two coaches whose patterns overlap could
    // otherwise take each other's days in opposite orders and deadlock.
    for (const d of dates) await lockTrainerDay(client, trainerId, asDateString(d));

    const planned = [];
    for (const date of dates) {
      const ctx = await engineInputsFor(date);
      const student = ctx.students.find((s) => s.id === studentId);
      const horse = ctx.horses.find((h) => h.id === horseId);
      const lessonType = ctx.lessonTypes.find((l) => l.id === lessonTypeId);
      if (!student) throw new Error(`no student ${studentId} visible to this trainer`);
      if (!horse) throw new Error(`no horse ${horseId} visible to this account`);
      if (!lessonType) throw new Error(`no lesson type ${lessonTypeId} visible to this trainer`);

      const validation = validateBooking({
        ...ctx,
        bookings: [...ctx.bookings, ...planned.map((p) => p.engineShape)],
        trainerBookings: [...ctx.trainerBookings, ...planned.map((p) => p.engineShape)],
        student, horse, lessonType, date, start, manualAdjustment,
      });
      if (!validation.ok) {
        // Which week broke travels with the refusal: "it fails on 6 October" is actionable,
        // "the pattern was rejected" sends the coach checking all four by hand.
        throw new BookingRejected(validation.checks, { date: asDateString(date) });
      }

      const q = validation.quote ?? priceFor({
        student, lessonType, date, start, manualAdjustment,
        priceBands: ctx.priceBands, trainerConfig: ctx.trainerConfig,
      });
      const endTime = minToStr(parseTime(start) + lessonType.durationMin);
      planned.push({
        date, endTime, quote: q,
        engineShape: {
          id: `planned-${asDateString(date)}`, studentId, horseId, lessonTypeId,
          date, start, end: endTime, status, isBillable: false,
        },
      });
    }
    return planned;
  }

  return {
    bookings: {
      /**
       * Create a booking: validate with the engine, stamp the receipt, insert.
       *
       * `now` is a parameter for the same reason it is one throughout the engine — the
       * late-cancel boundary and the ratchet are only testable if the clock is passed in.
       */
      async create({
        studentId, horseId, lessonTypeId, date, start,
        offerDiscount = 0, manualAdjustment = 0, notes = null, status = "pending",
        isNewStudent = false,
      }) {
        await assertInTenantTransaction(client, tenant);
        const day = toDate(date);
        const dayString = asDateString(day);
        await lockTrainerDay(client, trainerId, dayString);

        // Loaded INSIDE the lock and inside the transaction, so the world the engine validates
        // against is the world that commits.
        const ctx = await engineInputsFor(day);
        const student = ctx.students.find((s) => s.id === studentId);
        const horse = ctx.horses.find((h) => h.id === horseId);
        const lessonType = ctx.lessonTypes.find((l) => l.id === lessonTypeId);
        if (!student) throw new Error(`no student ${studentId} visible to this trainer`);
        if (!horse) throw new Error(`no horse ${horseId} visible to this account`);
        if (!lessonType) throw new Error(`no lesson type ${lessonTypeId} visible to this trainer`);

        const validation = validateBooking({
          ...ctx, student, horse, lessonType, date: day, start,
          offerDiscount, manualAdjustment,
        });
        if (!validation.ok) throw new BookingRejected(validation.checks);

        // The quote the engine produced for THIS booking, written once and never recomputed.
        const q = validation.quote ?? priceFor({
          student, lessonType, date: day, start, offerDiscount, manualAdjustment,
          priceBands: ctx.priceBands, trainerConfig: ctx.trainerConfig,
        });

        // Stored rather than derived from duration_min, so editing a lesson type in November
        // does not resize October's lessons. See schema.md — it is the one behavioural change.
        const endTime = minToStr(parseTime(start) + lessonType.durationMin);

        try {
          const [row] = await db.insert(bookings).values({
            trainerId, studentId, horseId, lessonTypeId,
            date: dayString, startTime: start, endTime, status,
            basePrice: q.basePrice,
            bandAdjustment: q.bandAdjustment,
            frequencyDiscount: q.frequencyDiscount,
            offerDiscount: q.offerDiscount,
            manualAdjustment: q.manualAdjustment,
            price: q.price,
            // pending and confirmed are not billable yet; the charge decision is made on
            // completion or on a late cancel.
            isBillable: false,
            isNewStudent,
            notes,
          }).returning();
          return { booking: row, quote: q, checks: validation.checks };
        } catch (err) {
          // 23P01 is the horse exclusion constraint. Reaching it means another transaction
          // committed between the engine's read and this insert — the race the constraint
          // exists for, not a bug in the validation above.
          //
          // The unwrapping is not defensive padding: drizzle wraps driver errors in a
          // DrizzleQueryError whose own `code` is undefined, so testing `err.code` alone
          // silently never matches and every lost race would surface as a raw SQL error
          // instead of SlotTaken. Found by racing it.
          const pg = pgErrorOf(err);
          if (pg?.code === "23P01") throw new SlotTaken(pg.constraint);
          // The insert waits on any conflicting uncommitted row, so the lock_timeout set above
          // applies here too.
          if (pg?.code === "55P03") throw new BookingBusy(LOCK_TIMEOUT_SECONDS);
          throw err;
        }
      },

      /**
       * Cancel one occurrence. Always per-student, never per-session: a group session is not a
       * stored entity, so there is nothing else to cancel.
       *
       * The engine decides early vs. late and whether it is still billable; this only persists
       * that decision and records who it landed on.
       */
      async cancel({ bookingId, now, actor = "trainer" }) {
        await assertInTenantTransaction(client, tenant);
        const [row] = await db.select().from(bookings)
          .where(and(eq(bookings.trainerId, trainerId), eq(bookings.id, bookingId)));
        if (!row) throw new Error(`no booking ${bookingId} visible to this trainer`);

        const [trainerRow] = await client
          .query("select late_cancel_hours from trainers where id = $1", [trainerId])
          .then((r) => r.rows);
        const disposition = cancelDisposition(
          toEngineBooking(row),
          { lateCancelHours: trainerRow.lateCancelHours ?? trainerRow.late_cancel_hours },
          now,
        );
        if (!disposition) {
          throw new Error(
            `booking ${bookingId} cannot be cancelled — it is already past, or not in a ` +
              `slot-holding status (currently ${row.status}).`,
          );
        }

        const [updated] = await db.update(bookings)
          .set({
            status: disposition.kind,
            // The price is NOT zeroed. What the lesson would have cost survives for reporting;
            // is_billable carries the charge decision instead.
            isBillable: disposition.billable,
            updatedAt: sql`now()`,
          })
          .where(and(eq(bookings.trainerId, trainerId), eq(bookings.id, bookingId)))
          .returning();

        // Informational, never an approval gate. Dated to the day the problem lands on.
        await db.insert(studentAlerts).values({
          studentId: row.studentId,
          kind: "lesson_cancelled",
          detail: `${actor === "student" ? "Student" : "Coach"} cancelled the ${row.date} ` +
                  `${toHHMM(row.startTime)} lesson. ${disposition.note}`,
        });

        return { booking: updated, disposition };
      },

      /**
       * Move ONE lesson onto a different horse, leaving everything else about it alone.
       *
       * The one-off against a standing slot: "Rocket this Tuesday, Duke is lame." It changes
       * nothing about the pattern, which is why `recurring.update` then recognises this
       * occurrence as deliberate and leaves it where it is.
       *
       * THE PRICE DOES NOT CHANGE, and that is not an oversight. A price is set by the student,
       * the lesson type and the slot — never by which animal turned up — so there is nothing to
       * recompute, and recomputing anyway would re-stamp a receipt the schema exists to keep
       * still. The horse moves; the five components do not.
       *
       * The booking's own row is excluded from the world it is validated against. It occupies
       * the very slot being re-horsed, so leaving it in means every swap fails `trainer_free`
       * against itself — which is exactly what `validateSwap` does on the client, and the two
       * have to agree or the screen offers horses the server then refuses.
       */
      async changeHorse({ bookingId, horseId, actor = "trainer" }) {
        await assertInTenantTransaction(client, tenant);
        const [row] = await db.select().from(bookings)
          .where(and(eq(bookings.trainerId, trainerId), eq(bookings.id, bookingId)));
        if (!row) throw new Error(`no booking ${bookingId} visible to this trainer`);
        if (!["pending", "confirmed"].includes(row.status)) {
          // A lesson that is over, or cancelled, is a record of what happened. Re-horsing it
          // would rewrite history rather than change a plan.
          throw new Error(
            `booking ${bookingId} is ${row.status}, so the horse it ran with cannot be changed`,
          );
        }
        if (row.horseId === horseId) return { booking: row, unchanged: true };

        const date = toDate(row.date);
        await lockTrainerDay(client, trainerId, asDateString(date));

        const ctx = await engineInputsFor(date);
        const student = ctx.students.find((s) => s.id === row.studentId);
        const horse = ctx.horses.find((h) => h.id === horseId);
        const lessonType = ctx.lessonTypes.find((l) => l.id === row.lessonTypeId);
        if (!student) throw new Error(`no student ${row.studentId} visible to this trainer`);
        if (!horse) throw new Error(`no horse ${horseId} visible to this account`);
        if (!lessonType) throw new Error(`no lesson type ${row.lessonTypeId} visible to this trainer`);

        const without = (list) => (list || []).filter((b) => b.id !== bookingId);
        const validation = validateBooking({
          ...ctx,
          bookings: without(ctx.bookings),
          trainerBookings: without(ctx.trainerBookings),
          student, horse, lessonType,
          date, start: toHHMM(row.startTime),
          offerDiscount: row.offerDiscount,
          manualAdjustment: row.manualAdjustment,
        });
        if (!validation.ok) throw new BookingRejected(validation.checks, { date: row.date });

        try {
          const [updated] = await db.update(bookings)
            .set({ horseId, updatedAt: sql`now()` })
            .where(and(eq(bookings.trainerId, trainerId), eq(bookings.id, bookingId)))
            .returning();

          if (actor !== "student") {
            await db.insert(studentAlerts).values({
              studentId: row.studentId,
              kind: "substitute_horse",
              detail: `Your ${row.date} ${toHHMM(row.startTime)} lesson is on ${horse.name} ` +
                      `this time. Same lesson, same price.`,
            });
          }
          return { booking: updated, horse: horse.name };
        } catch (err) {
          const pg = pgErrorOf(err);
          if (pg?.code === "23P01") throw new SlotTaken(pg.constraint);
          if (pg?.code === "55P03") throw new BookingBusy(LOCK_TIMEOUT_SECONDS);
          throw err;
        }
      },

      /** Mark a lesson completed or a no-show. Both are billable; neither holds the slot. */
      async settle({ bookingId, outcome }) {
        await assertInTenantTransaction(client, tenant);
        if (!["completed", "no_show"].includes(outcome)) {
          throw new Error(`settle expects 'completed' or 'no_show', got ${outcome}`);
        }
        const [updated] = await db.update(bookings)
          .set({ status: outcome, isBillable: true, updatedAt: sql`now()` })
          .where(and(eq(bookings.trainerId, trainerId), eq(bookings.id, bookingId)))
          .returning();
        if (!updated) throw new Error(`no booking ${bookingId} visible to this trainer`);
        if (outcome === "no_show") {
          await db.insert(studentAlerts).values({
            studentId: updated.studentId,
            kind: "no_show",
            detail: `Missed the ${updated.date} ${toHHMM(updated.startTime)} lesson.`,
          });
        }
        return updated;
      },
    },

    recurring: {
      /**
       * Create a standing weekly slot, and the occurrences it generates.
       *
       * ALL OR NOTHING, and that is the whole design. A weekly pattern that works once is not a
       * pattern — the rider finds out three weeks later — so every occurrence is validated
       * before any of them is written, and one refusal refuses the series. `findRecurringOptions`
       * only ever offers patterns whose first four occurrences all pass, and this is the write
       * that has to still be true by the time the coach presses the button.
       *
       * Each occurrence is validated against a context that already contains the ones planned
       * before it. Occurrences are seven days apart and the rest-day window is seven days wide,
       * so consecutive weeks sit exactly on that boundary: validating each against a world where
       * the others do not exist would let a pattern through that its own second week breaks.
       *
       * The price is stamped per occurrence rather than once on the pattern. The pattern
       * deliberately carries no price — base and band are fixed by the slot, but the rider's
       * frequency tier is a fact about the month a lesson happens in, and a tier that moves in
       * October must not retroactively reprice September.
       */
      async create({
        studentId, horseId, lessonTypeId, day, start, startDate,
        occurrences = 4, manualAdjustment = 0, notes = null, status = "confirmed",
      }) {
        await assertInTenantTransaction(client, tenant);
        if (!Number.isInteger(day) || day < 0 || day > 6) {
          throw new Error(`recurring.create expects a weekday index 0-6, got ${day}`);
        }
        if (occurrences < 1) throw new Error("a recurring pattern needs at least one occurrence");

        const planned = await planSeries({
          studentId, horseId, lessonTypeId, day, start, from: startDate,
          occurrences, manualAdjustment, status,
        });
        const dates = planned.map((p) => p.date);

        const [pattern] = await db.insert(recurringBookings).values({
          trainerId, studentId, horseId, lessonTypeId,
          dayOfWeek: DOW_NAME[day], startTime: start,
          startDate: asDateString(dates[0]), status: "active", notes,
        }).returning();

        try {
          const rows = await db.insert(bookings).values(planned.map((p) => ({
            trainerId, recurringId: pattern.id, studentId, horseId, lessonTypeId,
            date: asDateString(p.date), startTime: start, endTime: p.endTime, status,
            basePrice: p.quote.basePrice,
            bandAdjustment: p.quote.bandAdjustment,
            frequencyDiscount: p.quote.frequencyDiscount,
            offerDiscount: p.quote.offerDiscount,
            manualAdjustment: p.quote.manualAdjustment,
            price: p.quote.price,
            isBillable: false,
            isNewStudent: false,
            notes,
          }))).returning();
          return { recurring: pattern, bookings: rows };
        } catch (err) {
          const pg = pgErrorOf(err);
          if (pg?.code === "23P01") throw new SlotTaken(pg.constraint);
          if (pg?.code === "55P03") throw new BookingBusy(LOCK_TIMEOUT_SECONDS);
          throw err;
        }
      },

      /**
       * Change a standing slot from here on, leaving what already happened alone.
       *
       * That split is the whole semantics. A coach moving a rider's Tuesday to Thursday, or
       * swapping the horse, is saying something about the weeks to come — not rewriting the
       * lessons that already ran. Those are historical facts: the ride tallies counted them,
       * the welfare forecast counted them, and the rider was charged for them. So the past
       * occurrences keep the horse, day, time and price they actually had.
       *
       * The upcoming ones are DELETED and re-planned rather than patched in place, because a
       * patch cannot answer the question that matters. Moving a series onto a different horse
       * has to re-ask whether that horse is free every week, is within its daily cap every week,
       * and is a legal pairing for this rider — which is `planSeries`, not an UPDATE statement.
       * Re-planning also re-prices from scratch: a pattern that moves out of the late-afternoon
       * band must stop carrying the premium, and carrying the old amount forward would show an
       * after-school price on a lesson that is no longer after school.
       *
       * Deleting BEFORE validating is deliberate and safe. The occurrences being replaced are
       * exactly the ones the new plan would collide with — swap only the horse and every week
       * fails `trainer_free` against its own old row — so they have to be gone before the engine
       * looks. If any week then fails, the whole transaction rolls back and the deletion is
       * undone with it: there is no state in which the series is half-moved.
       */
      async update({
        recurringId, horseId, lessonTypeId, day, start,
        now = new Date(), occurrences = 4, manualAdjustment = 0, notes,
      }) {
        await assertInTenantTransaction(client, tenant);
        const [pattern] = await db.select().from(recurringBookings)
          .where(and(
            eq(recurringBookings.trainerId, trainerId),
            eq(recurringBookings.id, recurringId),
          ));
        if (!pattern) throw new Error(`no recurring pattern ${recurringId} visible to this trainer`);
        if (pattern.status !== "active") {
          throw new Error(`recurring pattern ${recurringId} has ended and cannot be changed`);
        }

        const next = {
          studentId: pattern.studentId,
          horseId: horseId ?? pattern.horseId,
          lessonTypeId: lessonTypeId ?? pattern.lessonTypeId,
          day: day ?? DOW_NAME.indexOf(pattern.dayOfWeek),
          start: start ?? toHHMM(pattern.startTime),
        };

        const today = asDateString(now);

        // A week already moved onto a different horse is a deliberate one-off — "Rocket this
        // Tuesday, Duke is lame" — and changing the standing horse must not quietly undo it.
        // The test is the horse: an occurrence still on the pattern's own horse is following
        // the pattern, and anything else was overridden by hand. The screen promises exactly
        // this ("Occurrences already substituted to another horse are left alone"), and before
        // this it was a promise only the prototype's local state kept.
        const upcoming = await db.select().from(bookings)
          .where(and(
            eq(bookings.trainerId, trainerId),
            eq(bookings.recurringId, recurringId),
            sql`${bookings.date} >= ${today}`,
            inArray(bookings.status, ["pending", "confirmed"]),
          ));
        const substituted = upcoming.filter((b) => b.horseId !== pattern.horseId);
        const replaceable = upcoming.filter((b) => b.horseId === pattern.horseId);

        const removed = replaceable.length
          ? await db.delete(bookings)
              .where(and(
                eq(bookings.trainerId, trainerId),
                inArray(bookings.id, replaceable.map((b) => b.id)),
              ))
              .returning()
          : [];

        const planned = await planSeries({
          ...next, from: today, occurrences, manualAdjustment, status: "confirmed",
          skip: new Set(substituted.map((b) => asDateString(b.date))),
        });

        const [updated] = await db.update(recurringBookings)
          .set({
            horseId: next.horseId,
            lessonTypeId: next.lessonTypeId,
            dayOfWeek: DOW_NAME[next.day],
            startTime: next.start,
            // `start_date` is left alone on purpose: it records when this rider's standing slot
            // began, which is not changed by moving it to a different horse.
            ...(notes === undefined ? {} : { notes }),
            updatedAt: sql`now()`,
          })
          .where(and(
            eq(recurringBookings.trainerId, trainerId),
            eq(recurringBookings.id, recurringId),
          ))
          .returning();

        try {
          const rows = await db.insert(bookings).values(planned.map((p) => ({
            trainerId, recurringId, studentId: next.studentId,
            horseId: next.horseId, lessonTypeId: next.lessonTypeId,
            date: asDateString(p.date), startTime: next.start, endTime: p.endTime,
            status: "confirmed",
            basePrice: p.quote.basePrice,
            bandAdjustment: p.quote.bandAdjustment,
            frequencyDiscount: p.quote.frequencyDiscount,
            offerDiscount: p.quote.offerDiscount,
            manualAdjustment: p.quote.manualAdjustment,
            price: p.quote.price,
            isBillable: false,
            isNewStudent: false,
            notes: notes ?? pattern.notes,
          }))).returning();

          await db.insert(studentAlerts).values({
            studentId: pattern.studentId,
            kind: "recurring_changed",
            detail: `Your standing lesson is now ${DOW_LABEL[DOW_NAME[next.day]]}s at ` +
                    `${next.start}. The next ${rows.length} are booked.`,
          });

          return {
            recurring: updated, bookings: rows,
            replaced: removed.length, keptSubstitutions: substituted.length,
          };
        } catch (err) {
          const pg = pgErrorOf(err);
          if (pg?.code === "23P01") throw new SlotTaken(pg.constraint);
          if (pg?.code === "55P03") throw new BookingBusy(LOCK_TIMEOUT_SECONDS);
          throw err;
        }
      },

      /**
       * End a series, and drop the occurrences that have not happened yet.
       *
       * Deleted rather than cancelled, and the distinction matters on the coach's calendar: a
       * cancelled lesson is an event that happened — someone called off a lesson that was
       * going to run — and it stays visible and may still be billable. A week of a series that
       * is simply no longer happening is not that, and rendering it as a cancellation would
       * invent a story about every remaining week.
       *
       * Everything already in the past is untouched. Those lessons DID happen, and the ride
       * tallies, the welfare forecasts and the rider's history all count them.
       */
      async end({ recurringId, now = new Date() }) {
        await assertInTenantTransaction(client, tenant);
        const [pattern] = await db.select().from(recurringBookings)
          .where(and(
            eq(recurringBookings.trainerId, trainerId),
            eq(recurringBookings.id, recurringId),
          ));
        if (!pattern) throw new Error(`no recurring pattern ${recurringId} visible to this trainer`);

        // Never before the day it began. A series created for next Thursday and ended this
        // Tuesday would otherwise get an end date two days before its start, which
        // `recurring_bookings_end_after_start` refuses — correctly, since a span that closes
        // before it opens is not a span. A series ended before its first lesson ends on the day
        // it would have started, having run for none.
        const today = asDateString(now);
        const endDate = today < pattern.startDate ? pattern.startDate : today;

        const removed = await db.delete(bookings)
          .where(and(
            eq(bookings.trainerId, trainerId),
            eq(bookings.recurringId, recurringId),
            sql`${bookings.date} >= ${today}`,
            inArray(bookings.status, ["pending", "confirmed"]),
          ))
          .returning();

        const [updated] = await db.update(recurringBookings)
          .set({ status: "ended", endDate, updatedAt: sql`now()` })
          .where(and(
            eq(recurringBookings.trainerId, trainerId),
            eq(recurringBookings.id, recurringId),
          ))
          .returning();

        await db.insert(studentAlerts).values({
          studentId: pattern.studentId,
          kind: "recurring_ended",
          detail: `Your standing ${DOW_LABEL[pattern.dayOfWeek]} ${toHHMM(pattern.startTime)} ` +
                  `lesson has ended. ${removed.length} upcoming lesson` +
                  `${removed.length === 1 ? " was" : "s were"} removed.`,
        });

        return { recurring: updated, removed: removed.length };
      },
    },

    horses: {
      /**
       * Add a horse to the BARN, not to a coach.
       *
       * Account-scoped, and that is the whole difference from every other write here: a horse
       * is a physical animal at a facility, its rest days and saddle-time cap are facts about
       * the animal, and both coaches who ride it share them. So `accountId` is stamped and
       * `trainerId` never appears — a horse added by one coach is immediately the other's too,
       * which is correct and is what the RLS policy on this table already assumes.
       */
      async create(values) {
        await assertInTenantTransaction(client, tenant);
        const [row] = await db.insert(horses).values({ ...values, accountId }).returning();
        return row;
      },

      /**
       * Change a horse. Deactivating is this, with `active: false` — there is no delete.
       *
       * Nothing in the render path survives a horse disappearing: every `horses.find(...).name`
       * becomes a white screen on the day one is deleted, and the lessons it already taught
       * would lose the animal they name. Deactivating keeps the row and takes it out of
       * circulation, which is what `horse_active` in the engine reads.
       */
      async update({ horseId, ...values }) {
        await assertInTenantTransaction(client, tenant);
        // Never from the caller. Moving a horse between barns is not an edit, and accepting it
        // here would hand one account's animal to another with a friendly signature.
        delete values.accountId;
        const [row] = await db.update(horses)
          .set({ ...values, updatedAt: sql`now()` })
          .where(and(eq(horses.accountId, accountId), eq(horses.id, horseId)))
          .returning();
        if (!row) throw new Error(`no horse ${horseId} visible to this account`);
        return row;
      },
    },

    lessonTypes: {
      /**
       * Create or replace a lesson type, with its band premiums and its horse restrictions.
       *
       * Three tables, one call, because they are one thing to the coach. The adjustments and
       * the restricted horses are junctions here and inline fields in the engine, so a partial
       * save would leave a type priced for a band it no longer has, or restricted to a horse
       * that is no longer on the list — states no screen can produce and every screen would
       * then have to tolerate.
       *
       * Replaced wholesale rather than diffed, for the same reason availability is: the coach
       * edits the whole form at once, and a diff would have to guess which existing row a
       * changed one corresponds to. Both junctions are rewritten inside the caller's
       * transaction, so nobody observes the empty middle.
       */
      async save({ lessonTypeId = null, bandAdjustments = {}, restrictedHorseIds = [], ...values }) {
        await assertInTenantTransaction(client, tenant);

        // A role is a flag, never an id — and exactly one type may carry the intro flag, which
        // the schema enforces with a partial unique index. Clearing the others FIRST turns
        // "the coach moved the intro flag" from a constraint violation into what she meant.
        if (values.isIntro) {
          await db.update(lessonTypesTable)
            .set({ isIntro: false, updatedAt: sql`now()` })
            .where(and(
              eq(lessonTypesTable.trainerId, trainerId),
              eq(lessonTypesTable.isIntro, true),
              ...(lessonTypeId ? [sql`${lessonTypesTable.id} <> ${lessonTypeId}`] : []),
            ));
        }

        let row;
        if (lessonTypeId) {
          [row] = await db.update(lessonTypesTable)
            .set({ ...values, updatedAt: sql`now()` })
            .where(and(
              eq(lessonTypesTable.trainerId, trainerId),
              eq(lessonTypesTable.id, lessonTypeId),
            ))
            .returning();
          if (!row) throw new Error(`no lesson type ${lessonTypeId} visible to this trainer`);
        } else {
          [row] = await db.insert(lessonTypesTable)
            .values({ ...values, trainerId })
            .returning();
        }

        await db.delete(bandAdjustmentsTable)
          .where(and(
            eq(bandAdjustmentsTable.trainerId, trainerId),
            eq(bandAdjustmentsTable.lessonTypeId, row.id),
          ));
        // A zero is stored as ABSENT rather than as 0, so "not priced for this band" and
        // "priced at nothing" stay the same state however the coach arrived at it — which is
        // what the band editor and the lesson type form both already do on screen.
        const amounts = Object.entries(bandAdjustments)
          .map(([bandId, amount]) => [bandId, Number(amount) || 0])
          .filter(([, amount]) => amount !== 0);
        if (amounts.length) {
          await db.insert(bandAdjustmentsTable).values(
            amounts.map(([bandId, amount]) => ({ lessonTypeId: row.id, bandId, trainerId, amount })),
          );
        }

        await db.delete(restrictedHorsesTable)
          .where(eq(restrictedHorsesTable.lessonTypeId, row.id));
        if (restrictedHorseIds.length) {
          await db.insert(restrictedHorsesTable).values(
            restrictedHorseIds.map((horseId) => ({ lessonTypeId: row.id, horseId })),
          );
        }

        return row;
      },

      /**
       * Remove a lesson type no lesson refers to.
       *
       * The foreign key from `bookings` is ON DELETE RESTRICT, so a type any lesson used cannot
       * go — which is right: the lesson would lose what it was. This catches the refusal and
       * says so in those terms rather than surfacing a constraint name.
       */
      async remove({ lessonTypeId }) {
        await assertInTenantTransaction(client, tenant);

        // Asked before deleting, rather than catching the foreign key afterwards. The FK is
        // RESTRICT and would stop it either way, but a 23503 arrives wrapped by drizzle and
        // reads as a failed DELETE statement — and the coach needs to know a lesson still uses
        // this, not that a query failed. Counting first also lets the message say how many.
        const used = await db.select({ id: bookings.id }).from(bookings)
          .where(and(eq(bookings.trainerId, trainerId), eq(bookings.lessonTypeId, lessonTypeId)));
        const patterns = await db.select({ id: recurringBookings.id }).from(recurringBookings)
          .where(and(
            eq(recurringBookings.trainerId, trainerId),
            eq(recurringBookings.lessonTypeId, lessonTypeId),
          ));
        if (used.length || patterns.length) {
          // Any lesson, past or future. Checking only upcoming ones lets a coach clear next
          // week, delete the type, and leave every past lesson pointing at a definition that no
          // longer exists — the rider's history then cannot say what they rode or why it cost
          // what it did. A type that has ever been used is part of the record.
          throw new Error(
            `lessons still refer to this type (${used.length} lesson` +
              `${used.length === 1 ? "" : "s"}, ${patterns.length} standing slot` +
              `${patterns.length === 1 ? "" : "s"}), so it cannot be removed. A lesson that lost ` +
              `its type would lose what it was.`,
          );
        }

        const [row] = await db.delete(lessonTypesTable)
          .where(and(
            eq(lessonTypesTable.trainerId, trainerId),
            eq(lessonTypesTable.id, lessonTypeId),
          ))
          .returning();
        if (!row) throw new Error(`no lesson type ${lessonTypeId} visible to this trainer`);
        return row;
      },
    },

    priceBands: {
      /**
       * Create or replace a band: its name, the days and hours it covers, and what each lesson
       * type charges for it.
       *
       * The band editor is a second way into the same `band_adjustments` the lesson type form
       * writes — not a copy of it. Both exist because the coach approaches the number from two
       * directions: "what does this lesson cost?" when setting up a type, and "what is
       * after-school worth?" when defining the band. So this writes the junction too, and a
       * band saved here and a type saved there end up at the same row.
       *
       * One window per day, all sharing the band's start and end. That is the shape
       * `toEnginePriceBands` collapses back into a single entry with several days, and keeping
       * them as separate rows is what lets the exclusion constraint index `day_of_week` with
       * `=` and catch two bands overlapping on a shared day.
       */
      async save({ bandId = null, name, days = [], start, end, amounts = {} }) {
        await assertInTenantTransaction(client, tenant);
        if (!name) throw new Error("a price band needs a name");
        if (!days.length) throw new Error("a price band covers at least one day");

        let band;
        if (bandId) {
          [band] = await db.update(priceBandsTable)
            .set({ name })
            .where(and(
              eq(priceBandsTable.trainerId, trainerId),
              eq(priceBandsTable.id, bandId),
            ))
            .returning();
          if (!band) throw new Error(`no price band ${bandId} visible to this trainer`);
          await db.delete(bandWindowsTable)
            .where(and(
              eq(bandWindowsTable.trainerId, trainerId),
              eq(bandWindowsTable.bandId, bandId),
            ));
        } else {
          [band] = await db.insert(priceBandsTable).values({ trainerId, name }).returning();
        }

        try {
          await db.insert(bandWindowsTable).values(days.map((day) => ({
            bandId: band.id, trainerId,
            dayOfWeek: typeof day === "number" ? DOW_NAME[day] : day,
            startTime: start, endTime: end,
          })));
        } catch (err) {
          // 23P01 is the price_bands_no_overlap exclusion constraint. Two bands covering the
          // same hour on the same day would make the premium on a slot ambiguous, which is the
          // one thing a published band cannot be.
          if (pgErrorOf(err)?.code === "23P01") {
            throw new Error(
              `those hours overlap another band on one of those days. A slot can only sit in ` +
                `one band, or the premium on it has two answers.`,
            );
          }
          throw err;
        }

        // The amounts arrive keyed by lesson type, because a new band has no id until this
        // point and the draft had nowhere else to hang them.
        for (const [lessonTypeId, raw] of Object.entries(amounts)) {
          const amount = Number(raw) || 0;
          await db.delete(bandAdjustmentsTable)
            .where(and(
              eq(bandAdjustmentsTable.trainerId, trainerId),
              eq(bandAdjustmentsTable.bandId, band.id),
              eq(bandAdjustmentsTable.lessonTypeId, lessonTypeId),
            ));
          if (amount !== 0) {
            await db.insert(bandAdjustmentsTable)
              .values({ lessonTypeId, bandId: band.id, trainerId, amount });
          }
        }

        return band;
      },

      /**
       * Remove a band that prices nothing.
       *
       * Refused while any lesson type carries an amount for it. The cascade would take those
       * adjustments with it, and silently zeroing a premium across three lesson types is not
       * something a coach should be able to do by tapping one X — the screen blocks it for the
       * same reason, and this is the half of that rule the screen cannot enforce.
       */
      async remove({ bandId }) {
        await assertInTenantTransaction(client, tenant);
        const inUse = await db.select().from(bandAdjustmentsTable)
          .where(and(
            eq(bandAdjustmentsTable.trainerId, trainerId),
            eq(bandAdjustmentsTable.bandId, bandId),
          ));
        if (inUse.length) {
          throw new Error(
            `${inUse.length} lesson type${inUse.length === 1 ? "" : "s"} still price this band. ` +
              `Set their amounts to 0 first, so the change is one you can see.`,
          );
        }
        const [row] = await db.delete(priceBandsTable)
          .where(and(eq(priceBandsTable.trainerId, trainerId), eq(priceBandsTable.id, bandId)))
          .returning();
        if (!row) throw new Error(`no price band ${bandId} visible to this trainer`);
        return row;
      },
    },

    offers: {
      /**
       * Record that a slot was offered to a rider.
       *
       * Offers are how `offerStats` derives who tends to say yes, which is what ranks the next
       * gap-fill — so an offer that is sent and not written down makes the ranking worse every
       * time. Acceptance is never stored: it is derived from a booking that matches the offer's
       * student, date and time, because Phase 1a has no reply channel and a stored "accepted"
       * would be a guess.
       *
       * `offers_one_per_student_slot` means offering the same rider the same slot twice is a
       * conflict rather than a second row. The screen already flags an existing offer instead of
       * hiding it — the coach decides whether to ask again — so this reports the clash plainly
       * rather than quietly overwriting what was offered the first time.
       */
      async create(values) {
        await assertInTenantTransaction(client, tenant);
        try {
          const [row] = await db.insert(offers).values({ ...values, trainerId }).returning();

          // BOTH figures, always. A discounted price shown on its own reads as the new price and
          // sets the expectation that next week is the same; the pair is what makes it legible
          // as a one-off. That is why the discount and its reason are captured here rather than
          // reconstructed later — see "Pricing is three separate mechanisms" in CLAUDE.md.
          const date = toDate(values.date);
          const ctx = await engineInputsFor(date);
          const student = ctx.students.find((s) => s.id === values.studentId);
          const lessonType = ctx.lessonTypes.find((l) => l.id === values.lessonTypeId);
          const horse = ctx.horses.find((h) => h.id === values.horseId);
          let priceNote = "";
          if (student && lessonType) {
            const quote = (offerDiscount) => priceFor({
              student, lessonType, date, start: values.startTime, offerDiscount,
              priceBands: ctx.priceBands, trainerConfig: ctx.trainerConfig,
            }).price;
            const full = quote(0);
            const offered = quote(values.offerDiscount ?? 0);
            priceNote = offered < full
              ? ` · $${offered} instead of the usual $${full}` +
                (values.offerReason ? `, ${values.offerReason}` : "")
              : ` · $${offered}`;
          }

          await db.insert(studentAlerts).values({
            studentId: values.studentId,
            kind: "offer",
            detail: `${values.date} at ${toHHMM(values.startTime)}` +
                    `${horse ? ` with ${horse.name}` : ""}${priceNote}`,
          });
          return row;
        } catch (err) {
          const pg = pgErrorOf(err);
          if (pg?.code === "23505") {
            throw new Error(
              `that rider has already been offered ${values.date} at ${values.startTime}. ` +
                `The first offer stands, with the discount and reason it was made on.`,
            );
          }
          throw err;
        }
      },
    },

    students: {
      /** Add a rider to this coach's roster. Trainer-scoped: a rider with two coaches is two rows. */
      async create(values) {
        await assertInTenantTransaction(client, tenant);
        const [row] = await db.insert(students)
          .values({ ...values, trainerId })
          .returning();
        return row;
      },

      async update({ studentId, ...values }) {
        await assertInTenantTransaction(client, tenant);
        // trainerId is never taken from the caller — moving a rider between coaches is not an
        // edit, and accepting it here would be a tenancy hole with a friendly signature.
        delete values.trainerId;
        const [row] = await db.update(students)
          .set({ ...values, updatedAt: sql`now()` })
          .where(and(eq(students.trainerId, trainerId), eq(students.id, studentId)))
          .returning();
        if (!row) throw new Error(`no student ${studentId} visible to this trainer`);
        return row;
      },
    },

    availability: {
      /**
       * Replace this trainer's weekly windows wholesale.
       *
       * Delete-then-insert rather than a diff: the windows are a small set the coach edits as a
       * whole on one screen, and a diff would have to guess which existing row a changed window
       * corresponds to. Both statements are in the caller's transaction, so no one ever observes
       * the empty middle.
       */
      async replace(windows) {
        await assertInTenantTransaction(client, tenant);
        await db.delete(trainerAvailability).where(eq(trainerAvailability.trainerId, trainerId));
        if (!windows.length) return [];
        return db.insert(trainerAvailability)
          .values(windows.map((w) => ({
            trainerId, dayOfWeek: w.dayOfWeek, startTime: w.startTime, endTime: w.endTime,
          })))
          .returning();
      },
    },
  };
}
