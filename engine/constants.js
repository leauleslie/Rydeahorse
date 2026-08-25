// One fixed vocabulary, shared by horses and students, so the pairing check does exact
// matching rather than fuzzy string comparison.
export const RIDING_STYLES = ["English", "Western"];

export const EXP_LEVELS = ["beginner", "intermediate", "advanced"];
export const EXP_RANK = { beginner: 0, intermediate: 1, advanced: 2 };

// Statuses that hold a slot. Rest-day counting, usage caps and conflict checks all read this
// one list — a status added later that should block a booking gets added here once, not in
// six places that each spelled the pair out inline.
export const HOLDS_SLOT = ["pending", "confirmed"];

export function holdsSlot(booking) {
  return HOLDS_SLOT.includes(booking.status);
}

export const MAX_PRICE_BANDS = 3;

export const STUDENT_ALERT_RETENTION_DAYS = 7;
