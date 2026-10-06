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
  bookings, students, studentAlerts, trainerAvailability, recurringBookings,
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
