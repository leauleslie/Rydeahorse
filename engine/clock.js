// The clock is a parameter, not a global.
//
// In the prototype, TODAY and NOW_MIN were module-level constants pinned to Tue 8/18/2026
// 7:00 AM, and eight functions reached out and read them directly. That is fine in a browser
// tab that belongs to one person. It does not survive contact with a server, for three
// separate reasons:
//
//   1. A server process runs for weeks. A module-level "today" evaluated at boot is wrong by
//      the next morning, and wrong silently — no error, just a rest-day window sliding out of
//      alignment with reality.
//   2. Coaches are in different timezones. "Today" is a question you cannot answer without
//      knowing whose today you mean.
//   3. Time-dependent rules cannot be tested if time cannot be set. The two-month tier
//      ratchet, the 24-hour cancel boundary and the 7-day rest window are the highest-value
//      things to test and the hardest to reach without an injectable now.
//
// So every function whose answer depends on the current moment takes `now` explicitly. Callers
// build it once per request and thread it down.

// Collapses the prototype's TODAY (date only) + NOW_MIN (minutes) into one real instant.
export function clockAt(date, minutesPastMidnight = 0) {
  const d = new Date(date);
  d.setHours(Math.floor(minutesPastMidnight / 60), minutesPastMidnight % 60, 0, 0);
  return d;
}

export function nowFor() {
  return new Date();
}

// Minutes past midnight of `now`. Replaces NOW_MIN.
export function minutesOfDay(now) {
  return now.getHours() * 60 + now.getMinutes();
}
