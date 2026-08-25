// Controlled vocabularies, as Postgres enums.
//
// These are the same vocabularies the engine holds in `engine/constants.js`, and they are
// spelled the same way on both sides — the repository maps snake_case column names to the
// engine's camelCase keys, but it does not translate values. A value that reads `confirmed`
// in the database reads `confirmed` in the engine.
//
// Enums rather than text + CHECK because the set is fixed, small, and named in the spec.
// btree_gist supports enum types, which matters for `day_of_week`: the price-band exclusion
// constraint in Section 3 indexes it with `=`.
import { pgEnum } from "drizzle-orm/pg-core";

// Mon–Sun, per Section 8. Stored as names rather than 0–6 so a row is readable and so the
// exclusion constraint reads as the rule it enforces.
export const dayOfWeek = pgEnum("day_of_week", [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
]);

// Revised down to two in v5. Both `horses` and `students` draw from this one list so the
// pairing check does exact matching rather than fuzzy string comparison.
export const ridingStyle = pgEnum("riding_style", ["English", "Western"]);

// Ordinal: beginner < intermediate < advanced. The ordering lives in the engine (EXP_RANK);
// Postgres enums happen to sort in declaration order too, which makes `>=` comparisons in
// ad hoc SQL agree with the engine rather than contradict it.
export const experienceLevel = pgEnum("experience_level", [
  "beginner",
  "intermediate",
  "advanced",
]);

// The first two hold a slot (engine: HOLDS_SLOT). The exclusion constraint on `bookings`
// repeats that pair in its WHERE clause — the one place the list is spelled out twice, and
// deliberately, because a constraint predicate cannot import a constant.
export const bookingStatus = pgEnum("booking_status", [
  "pending",
  "confirmed",
  "completed",
  "no_show",
  "late_cancel",
  "early_cancel",
]);

export const schedulingPreference = pgEnum("scheduling_preference", [
  "back_to_back",
  "spaced",
]);

export const profileStatus = pgEnum("profile_status", ["pending_review", "approved"]);

// `all` is specified but behaves as `target_and_potential` today (Section 8, known gap). The
// value exists in the enum so the column can hold what the coach picked; wiring it needs a
// third `kind` on student_riding_windows, not a schema change here.
export const notificationPreference = pgEnum("notification_preference", [
  "target_only",
  "target_and_potential",
  "all",
]);

// Target vs. potential, used by both `student_riding_windows` (which list a window is on) and
// `offers` (which list the slot matched at the moment of the offer). One vocabulary, because
// the second is a record of the first.
export const ridingWindowKind = pgEnum("riding_window_kind", ["target", "potential"]);

export const noteCategory = pgEnum("note_category", [
  "intro_lesson_no_fit",
  "recurring_lesson_no_fit",
  "message",
]);

export const noteStatus = pgEnum("note_status", ["open", "resolved"]);

// Section 13's table, in its order: red, then amber, then green, then blue, then grey. The
// kind determines the heading and the colour; the row carries no styling.
export const alertKind = pgEnum("alert_kind", [
  "lesson_cancelled",
  "no_show",
  "recurring_ended",
  "lesson_moved",
  "substitute_horse",
  "recurring_changed",
  "no_ride_changed",
  "booking_created",
  "recurring_created",
  "offer",
  "price_changed",
  "rate_changed",
]);

export const inactivePeriodStatus = pgEnum("inactive_period_status", ["active", "ended"]);

export const recurringStatus = pgEnum("recurring_status", ["active", "ended"]);

// Empty in Phase 1a — there is no reply channel yet.
export const offerResponse = pgEnum("offer_response", [
  "accepted",
  "declined",
  "no_response",
]);

export const messageChannel = pgEnum("message_channel", ["sms", "web"]);
export const messageDirection = pgEnum("message_direction", ["in", "out"]);
