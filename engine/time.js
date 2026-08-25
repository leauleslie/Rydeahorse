// Time primitives. No module-level clock lives here or anywhere else in the engine —
// see clock.js for why.

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon-first display order

export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// "HH:MM" -> minutes past midnight.
export function parseTime(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// Minutes past midnight -> "HH:MM".
export function minToStr(m) {
  return `${Math.floor(m / 60).toString().padStart(2, "0")}:${(m % 60)
    .toString()
    .padStart(2, "0")}`;
}

export function fmtDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Two [start, end) minute intervals overlap.
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
