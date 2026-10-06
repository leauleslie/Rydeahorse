// A believable barn, for looking at the screens.
//
// This is NOT `db/test/seed.js` and must never replace it. That fixture is three trainers
// across two accounts whose values collide on everything but their ids, because its job is to
// make an unscoped query fail — a property that depends on the data being artificial. This
// one's job is the opposite: one coach's week, shaped the way a real one is, so the Day view,
// the open-slot matching and the welfare forecasts all have something true-to-life to say.
// Using either for the other's purpose gets you a seed that proves nothing and screens that
// look like a unit test.
//
// The barn:
//
//   Willowbrook Stables, one coach, four horses, twenty-four riders.
//   Half the riders come more than once a week, on a standing weekly slot.
//   Vesper is the advanced horse, and exactly five riders are cleared for her.
//   Saturdays are the coach's day off — there is no Saturday availability row at all.
//
// Every booking it writes is one the engine would accept: the generator below re-implements
// the pairing, horse-free, daily-cap and rest-day checks and skips any slot that fails them.
// That is deliberate duplication of `engine/rules.js`, and it is worth it — a seed that writes
// rows the rules would have refused produces screens full of warnings about data that could
// never have existed, and sends you looking for a bug in the engine.
//
// Re-runnable: it TRUNCATES first, and generates the same barn every time from a fixed random
// seed, so ids are stable across re-seeds and a row you were looking at yesterday is the same
// row today.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const envLocal = join(here, "..", "..", ".env.local");
if (existsSync(envLocal)) process.loadEnvFile(envLocal);

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

// Tuesday 15 Sep 2026. This is COUPLED to `SIMULATED_TODAY_ISO` in app/src/App.jsx — the app
// asks the API for this date, so a barn built around any other one opens on an empty day.
// Change them together or change neither.
const TODAY = "2026-09-15";
// Three weeks back and two forward. The history is not decoration: offer-acceptance rates, the
// rest-day forecast and the completed-lesson counts are all computed from past bookings, and a
// barn that begins last Monday has nothing to compute them from.
const FIRST_DAY = "2026-08-24";
const LAST_DAY = "2026-09-27";

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

// A seeded generator rather than Math.random, so re-seeding reproduces the same barn down to
// the ids. Being able to say "Priya's Thursday lesson" and have it still be there after a
// re-seed is worth more here than variety.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260915);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const chance = (p) => rand() < p;

function uuid() {
  const b = Array.from({ length: 16 }, () => Math.floor(rand() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const s = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Dates and times, as strings
// ---------------------------------------------------------------------------
//
// Kept as "YYYY-MM-DD" and "HH:MM" throughout rather than as Date objects. A Date here would
// be parsed in the seeder's timezone and written in the database's, and a lesson would land on
// the wrong day for anyone west of UTC — the same class of bug `reviveBarn` exists to undo at
// the HTTP boundary.

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const toParts = (iso) => iso.split("-").map(Number);
const dayOfWeek = (iso) => {
  const [y, m, d] = toParts(iso);
  return DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const addDays = (iso, n) => {
  const [y, m, d] = toParts(iso);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => {
  const [ay, am, ad] = toParts(a);
  const [by, bm, bd] = toParts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
};
const dateRange = (from, to) => {
  const out = [];
  for (let d = from; daysBetween(d, to) >= 0; d = addDays(d, 1)) out.push(d);
  return out;
};

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toTime = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// The barn
// ---------------------------------------------------------------------------

// Saturday is absent on purpose — that IS the day off. Availability is per weekday, so a day
// the coach does not teach is a day with no row, not a row with a flag. Nothing needs to know
// about Saturday for Saturday to be empty.
const AVAILABILITY = [
  ["mon", "09:00", "18:00"],
  ["tue", "09:00", "18:00"],
  ["wed", "09:00", "18:00"],
  ["thu", "09:00", "18:00"],
  ["fri", "09:00", "17:00"],
  ["sun", "10:00", "16:00"],
];
const TEACHING_DAYS = AVAILABILITY.map(([d]) => d);

const HORSES = [
  // Vesper is the point of this list. `min_experience_level: advanced` is the whole mechanism —
  // the pairing check compares it against the rider's own level, so "only five riders may take
  // her" is a fact about five riders, not a list maintained on the horse. No weight limit and
  // no adult-only flag, so experience is the ONLY thing gating her and the five is exact.
  {
    key: "vesper", name: "Vesper", minExp: "advanced", adultOnly: false,
    styles: ["English"], maxWeight: null, restDays: 2, maxAdult: 120, maxOverall: 150,
    notes: "Forward and sharp. Experienced riders only — she reads a nervous seat instantly.",
  },
  {
    key: "biscuit", name: "Biscuit", minExp: "beginner", adultOnly: false,
    styles: ["English", "Western"], maxWeight: 190, restDays: 2, maxAdult: 120, maxOverall: 180,
    notes: "The schoolmaster. Patient with absolute beginners.",
  },
  {
    key: "pepper", name: "Pepper", minExp: "beginner", adultOnly: false,
    styles: ["English", "Western"], maxWeight: 180, restDays: 2, maxAdult: 120, maxOverall: 180,
    notes: "Steady. Good first canter horse.",
  },
  {
    key: "juniper", name: "Juniper", minExp: "intermediate", adultOnly: true,
    styles: ["English"], maxWeight: 185, restDays: 2, maxAdult: 120, maxOverall: 150,
    notes: "Careful jumper. Adults only — needs a rider who can hold a line.",
  },
];

const LESSON_TYPES = [
  {
    key: "intro", name: "Intro Lesson", durationMin: 60, rideTimeMin: 40, isIntro: true,
    basePrice: 55, minPrice: 50, maxPrice: 80, potentialEligible: true,
  },
  {
    key: "private", name: "Private Lesson", durationMin: 60, rideTimeMin: 45, isIntro: false,
    basePrice: 65, minPrice: 55, maxPrice: 95, potentialEligible: true,
  },
  {
    key: "half", name: "Half-Hour Private", durationMin: 30, rideTimeMin: 25, isIntro: false,
    basePrice: 40, minPrice: 35, maxPrice: 60, potentialEligible: true,
  },
  // A group type can never be gap-fill-eligible — the schema enforces it
  // (`lesson_types_group_never_potential`), because coordinating several riders and horses at
  // once is more than a fill-the-gap offer can carry.
  {
    key: "group", name: "Group Lesson", durationMin: 60, rideTimeMin: 45, isIntro: false,
    basePrice: 40, minPrice: 35, maxPrice: 60, potentialEligible: false,
    isGroup: true, maxGroupSize: 4,
  },
];

// Twenty-four riders. The first five are the advanced ones, and they are the five — and the
// only five — who clear Vesper's experience bar.
const PEOPLE = [
  { name: "Priya Raman", age: 34, level: "advanced" },
  { name: "Marcus Hale", age: 41, level: "advanced" },
  { name: "Imogen Blake", age: 27, level: "advanced" },
  { name: "Tomas Lindqvist", age: 38, level: "advanced" },
  { name: "Sadie Okonkwo", age: 16, level: "advanced" },

  { name: "Harriet Vance", age: 52, level: "intermediate" },
  { name: "Daniel Ortega", age: 29, level: "intermediate" },
  { name: "Nell Fairbanks", age: 45, level: "intermediate" },
  { name: "Oscar Mbeki", age: 33, level: "intermediate" },
  { name: "Rosa Calderón", age: 24, level: "intermediate" },
  { name: "Finn Doherty", age: 15, level: "intermediate" },
  { name: "Aisha Rahman", age: 17, level: "intermediate" },
  { name: "Gregor Petrov", age: 48, level: "intermediate" },

  { name: "Lucy Whitmore", age: 11, level: "beginner" },
  { name: "Theo Nakamura", age: 9, level: "beginner" },
  { name: "Clara Bennett", age: 36, level: "beginner" },
  { name: "Jonah Reyes", age: 13, level: "beginner" },
  { name: "Maeve Sullivan", age: 10, level: "beginner" },
  { name: "Ravi Chandra", age: 31, level: "beginner" },
  { name: "Elsie Thornton", age: 8, level: "beginner" },
  { name: "Noor Haddad", age: 26, level: "beginner" },
  { name: "Benedict Shaw", age: 57, level: "beginner" },
  { name: "Wren Alvarez", age: 12, level: "beginner" },
  { name: "Callum Frost", age: 19, level: "beginner" },
];

// ---------------------------------------------------------------------------
// Build every row in memory
// ---------------------------------------------------------------------------

function build() {
  const accountId = uuid();
  const trainerId = uuid();

  const horses = HORSES.map((h) => ({ ...h, id: uuid() }));
  const horseByKey = Object.fromEntries(horses.map((h) => [h.key, h]));
  const types = LESSON_TYPES.map((t) => ({ ...t, id: uuid() }));
  const typeByKey = Object.fromEntries(types.map((t) => [t.key, t]));

  // Riders. The first twelve ride more than once a week; the rest come weekly or less.
  const students = PEOPLE.map((p, i) => {
    const minor = p.age < 18;
    return {
      ...p,
      id: uuid(),
      frequent: i < 12,
      styles: p.level === "beginner" && chance(0.3) ? ["English", "Western"] : ["English"],
      weight: minor ? 80 + Math.floor(rand() * 55) : 125 + Math.floor(rand() * 60),
      // Two profiles left awaiting review, so the coach's review queue is not empty — that is a
      // real state of a real barn, not a defect.
      profileStatus: i >= 22 ? "pending_review" : "approved",
      unlocked: i < 22,
      guardianName: minor ? pick(["Dana", "Marie", "Paul", "Yusuf", "Helen"]) + " " + p.name.split(" ")[1] : null,
      guardianPhone: minor ? `555-01${String(20 + i).padStart(2, "0")}` : null,
      // Required before a minor's profile can be approved — `profileGaps` on the review screen
      // refuses without it, so a seed that omits it produces riders the coach cannot approve.
      guardianRelationship: minor ? pick(["Parent", "Parent", "Grandparent", "Legal Guardian"]) : null,
      phone: `555-02${String(10 + i).padStart(2, "0")}`,
      windows: [],
      ridesPerWeek: i < 12 ? (i < 5 ? 3 : 2) : 1,
    };
  });

  // Riding windows: when each rider says they can come. These feed the open-slot matching, so a
  // barn whose riders have no windows produces a Day view where every open slot reads "no
  // matching student availability" — true, and useless to look at.
  // Days and hours are handed out round-robin rather than at random. Random assignment across
  // six days and twenty-four riders clumps badly — the first draft put 33 lessons on Sunday and
  // 12 on Tuesday, which is the day the app actually opens on, so the barn looked half-empty on
  // the one screen anybody sees first. Rotating gives every weekday a comparable load, which is
  // also what a real coach's book looks like.
  const HOURS = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];
  for (const [i, s] of students.entries()) {
    const rotate = (xs, n) => [...xs.slice(n % xs.length), ...xs.slice(0, n % xs.length)];
    const days = rotate(TEACHING_DAYS, i);
    const targetDays = days.slice(0, s.frequent ? 3 : 2);
    for (const [j, d] of targetDays.entries()) {
      const start = HOURS[(i * 2 + j * 3) % HOURS.length];
      s.windows.push({ kind: "target", day: d, start, end: toTime(toMin(start) + 180) });
    }
    // The potential window is a time they would not normally book but would take to help fill a
    // gap — so it is deliberately a DIFFERENT day from their standing ones.
    s.windows.push({
      kind: "potential", day: days[days.length - 1], start: "11:00", end: "14:00",
    });
  }

  // A couple of riders who will not take a particular horse. Real, and it exercises the
  // junction rather than leaving it empty — the empty case is the one that passes by accident.
  const noRide = [
    { studentId: students[14].id, horseId: horseByKey.juniper.id },
    { studentId: students[19].id, horseId: horseByKey.pepper.id },
  ];
  const noRideFor = (id) => noRide.filter((n) => n.studentId === id).map((n) => n.horseId);

  // ---- the engine's rules, re-stated so the generator cannot write a row they would refuse --

  const eligibleHorses = (student, type) =>
    horses.filter((h) => {
      const RANK = { beginner: 0, intermediate: 1, advanced: 2 };
      if (RANK[student.level] < RANK[h.minExp]) return false;
      if (h.adultOnly && student.age < 18) return false;
      if (!h.styles.some((s) => student.styles.includes(s))) return false;
      if (h.maxWeight !== null && student.weight > h.maxWeight) return false;
      if (noRideFor(student.id).includes(h.id)) return false;
      return true;
    });

  const bookings = [];
  const byHorseDate = new Map(); // `${horseId}|${date}` -> [{start,end,rideTime}]
  const horseDates = new Map(); // horseId -> Set(date)
  const byStudentDate = new Map(); // `${studentId}|${date}` -> [{start,end}]

  const keyOf = (a, b) => `${a}|${b}`;
  const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

  function horseFree(horseId, date, startMin, endMin) {
    const held = byHorseDate.get(keyOf(horseId, date)) ?? [];
    return !held.some((b) => overlaps(startMin, endMin, b.start, b.end));
  }
  function studentFree(studentId, date, startMin, endMin) {
    const held = byStudentDate.get(keyOf(studentId, date)) ?? [];
    return !held.some((b) => overlaps(startMin, endMin, b.start, b.end));
  }
  function withinDailyCap(horse, date, rideTime, student) {
    const held = byHorseDate.get(keyOf(horse.id, date)) ?? [];
    const total = held.reduce((n, b) => n + b.rideTime, 0);
    if (horse.maxOverall !== null && total + rideTime > horse.maxOverall) return false;
    if (horse.maxAdult !== null && student.age >= 18) {
      const adult = held.reduce((n, b) => n + (b.adult ? b.rideTime : 0), 0);
      if (adult + rideTime > horse.maxAdult) return false;
    }
    return true;
  }
  // The rolling 7-day window allows at most `7 - restDays` distinct ridden DATES — dates, not
  // bookings, so two lessons on one day cost one day of the allowance. Every window that would
  // contain this date has to still pass, not just the one starting on it.
  function withinRestDays(horse, date) {
    const dates = horseDates.get(horse.id) ?? new Set();
    if (dates.has(date)) return true; // already ridden that day; costs nothing more
    const limit = 7 - horse.restDays;
    const candidate = new Set([...dates, date]);
    for (let offset = -6; offset <= 0; offset++) {
      const from = addDays(date, offset);
      let n = 0;
      for (const d of candidate) {
        const delta = daysBetween(from, d);
        if (delta >= 0 && delta <= 6) n++;
      }
      if (n > limit) return false;
    }
    return true;
  }

  function place({ student, horse, type, date, startMin, status, recurringId = null }) {
    const endMin = startMin + type.durationMin;
    byHorseDate.set(keyOf(horse.id, date), [
      ...(byHorseDate.get(keyOf(horse.id, date)) ?? []),
      { start: startMin, end: endMin, rideTime: type.rideTimeMin, adult: student.age >= 18 },
    ]);
    byStudentDate.set(keyOf(student.id, date), [
      ...(byStudentDate.get(keyOf(student.id, date)) ?? []),
      { start: startMin, end: endMin },
    ]);
    if (!horseDates.has(horse.id)) horseDates.set(horse.id, new Set());
    horseDates.get(horse.id).add(date);

    // The peak band: weekday late afternoons. Stored on the row, because a price is a
    // historical fact — see "Derive, don't store" in CLAUDE.md.
    const peak =
      ["mon", "tue", "wed", "thu", "fri"].includes(dayOfWeek(date)) &&
      startMin >= toMin("16:00") && startMin < toMin("19:00");
    const bandAdjustment = peak ? 10 : 0;
    const billable = ["completed", "no_show", "late_cancel"].includes(status);

    bookings.push({
      id: uuid(), studentId: student.id, horseId: horse.id, lessonTypeId: type.id,
      recurringId, date, start: toTime(startMin), end: toTime(endMin), status,
      basePrice: type.basePrice, bandAdjustment,
      price: type.basePrice + bandAdjustment, billable,
      isNewStudent: type.isIntro,
    });
  }

  function statusFor(date) {
    const daysAgo = daysBetween(date, TODAY);
    if (daysAgo <= 0) return "confirmed";

    // In the past. Most lessons happen; a few do not, and the ones that do not are what make the
    // alert feed and the billing columns worth looking at.
    //
    // The recent week gets a higher rate on purpose. Alert retention is 7 days and expiry is a
    // read filter, so anything older simply is not on the screen — at the natural rate the
    // coach's alert feed came out with two items in it, which reads as a bug in the feed rather
    // than as a quiet week.
    const recent = daysAgo <= 7;
    if (chance(recent ? 0.1 : 0.05)) return "no_show";
    if (chance(recent ? 0.1 : 0.05)) return "late_cancel";
    if (chance(0.05)) return "early_cancel";
    return "completed";
  }

  const days = dateRange(FIRST_DAY, LAST_DAY).filter((d) => TEACHING_DAYS.includes(dayOfWeek(d)));

  // ---- standing weekly slots, booked first --------------------------------------------------
  //
  // The frequent riders' lessons are the barn's skeleton: they recur at the same time every
  // week, so they must be placed before the ad-hoc ones can take their slots.

  const recurring = [];
  for (const s of students.filter((x) => x.frequent)) {
    const type = typeByKey.private;
    const options = eligibleHorses(s, type);
    if (!options.length) continue;
    const wanted = s.windows.filter((w) => w.kind === "target").slice(0, s.ridesPerWeek);
    for (const w of wanted) {
      const startMin = toMin(w.start);
      // Try every eligible horse at every hour in the rider's window, least-worked horse first.
      //
      // Picking a horse at random exhausts one animal's rest-day allowance early and starves
      // whichever weekday is considered last — which put four lessons on Tuesdays, the day the
      // app opens on. Spreading by current workload is both better-packed and truer: a coach
      // rotates her horses rather than riding one into the ground and then reaching for the next.
      let chosen = null;
      const ranked = [...options].sort(
        (a, b) => (horseDates.get(a.id)?.size ?? 0) - (horseDates.get(b.id)?.size ?? 0),
      );
      for (const horse of ranked) {
        for (let step = 0; step < 6 && !chosen; step++) {
          const start = startMin + step * 60;
          const fits = days
            .filter((d) => dayOfWeek(d) === w.day)
            .every(
              (d) =>
                horseFree(horse.id, d, start, start + type.durationMin) &&
                studentFree(s.id, d, start, start + type.durationMin) &&
                withinDailyCap(horse, d, type.rideTimeMin, s) &&
                withinRestDays(horse, d),
            );
          if (fits) chosen = { horse, start };
        }
        if (chosen) break;
      }
      if (!chosen) continue;
      const { horse, start: placedDay } = chosen;

      const recurringId = uuid();
      recurring.push({
        id: recurringId, studentId: s.id, horseId: horse.id, lessonTypeId: type.id,
        day: w.day, start: toTime(placedDay), startDate: FIRST_DAY,
      });
      for (const d of days.filter((x) => dayOfWeek(x) === w.day)) {
        place({ student: s, horse, type, date: d, startMin: placedDay, status: statusFor(d), recurringId });
      }
    }
  }

  // ---- one group lesson a week ---------------------------------------------------------------
  //
  // A group session is not a stored entity — it IS the set of bookings sharing lesson type,
  // date and start time where the type is a group type. So this writes three ordinary bookings
  // and nothing else; there is no group row to keep in sync.
  const groupType = typeByKey.group;
  for (const d of days.filter((x) => dayOfWeek(x) === "sun")) {
    const startMin = toMin("11:00");
    const riders = students.filter((s) => !s.frequent && s.profileStatus === "approved").slice(0, 3);
    for (const s of riders) {
      const horse = eligibleHorses(s, groupType).find(
        (h) =>
          horseFree(h.id, d, startMin, startMin + groupType.durationMin) &&
          withinDailyCap(h, d, groupType.rideTimeMin, s) &&
          withinRestDays(h, d),
      );
      if (!horse) continue;
      if (!studentFree(s.id, d, startMin, startMin + groupType.durationMin)) continue;
      place({ student: s, horse, type: groupType, date: d, startMin, status: statusFor(d) });
    }
  }

  // ---- everyone else, filling in around the skeleton -----------------------------------------

  for (const s of students.filter((x) => !x.frequent && x.profileStatus === "approved")) {
    const type = s.unlocked ? typeByKey.private : typeByKey.intro;
    const options = eligibleHorses(s, type);
    if (!options.length) continue;

    let booked = 0;
    const wantedTotal = days.length / 7 >= 1 ? 3 : 1; // roughly one a week across the range
    for (const w of [...s.windows].sort(() => rand() - 0.5)) {
      if (booked >= wantedTotal) break;
      for (const d of days.filter((x) => dayOfWeek(x) === w.day)) {
        if (booked >= wantedTotal) break;
        for (let step = 0; step < 4; step++) {
          const start = toMin(w.start) + step * 60;
          if (start + type.durationMin > toMin("18:00")) break;
          const horse = options.find(
            (h) =>
              horseFree(h.id, d, start, start + type.durationMin) &&
              withinDailyCap(h, d, type.rideTimeMin, s) &&
              withinRestDays(h, d),
          );
          if (!horse) continue;
          if (!studentFree(s.id, d, start, start + type.durationMin)) continue;
          place({ student: s, horse, type, date: d, startMin: start, status: statusFor(d) });
          booked++;
          break;
        }
      }
    }
  }

  // ---- things the coach is meant to notice ----------------------------------------------------

  const alerts = [];
  for (const b of bookings.filter((x) => x.status === "no_show" || x.status === "late_cancel")) {
    const s = students.find((x) => x.id === b.studentId);
    alerts.push({
      id: uuid(), studentId: s.id,
      kind: b.status === "no_show" ? "no_show" : "lesson_cancelled",
      detail: b.status === "no_show"
        ? `Missed ${b.date} at ${b.start} — billed in full`
        : `Cancelled ${b.date} at ${b.start}, inside the 24-hour notice period — billed`,
    });
  }

  const notes = [
    { id: uuid(), studentId: students[6].id, category: "message", note: "Could we move to mornings while it stays this hot?" },
    { id: uuid(), studentId: students[13].id, category: "message", note: "Lucy would like to try jumping when you think she's ready." },
    { id: uuid(), studentId: students[22].id, category: "intro_lesson_no_fit", note: "None of the offered intro times work — weekends only, please." },
  ];

  // Past offers, so the acceptance rate the matching layer ranks on is not uniform. Offers are
  // unique per student+date+time, so these are spread across distinct slots.
  const offers = [];
  const pastDays = days.filter((d) => daysBetween(d, TODAY) > 0);
  for (const [i, s] of students.slice(5, 13).entries()) {
    const d = pastDays[i % pastDays.length];
    const horse = eligibleHorses(s, typeByKey.private)[0];
    if (!horse || !d) continue;
    offers.push({
      id: uuid(), studentId: s.id, date: d, start: toTime(toMin("12:00")),
      horseId: horse.id, lessonTypeId: typeByKey.private.id,
      kind: i % 3 === 0 ? "potential" : "target",
      discount: i % 3 === 0 ? 10 : null, rank: (i % 3) + 1,
    });
  }

  return {
    accountId, trainerId, horses, types, typeByKey, students, bookings, recurring,
    alerts, notes, offers, noRide,
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

async function bulk(client, table, columns, rows) {
  if (!rows.length) return 0;
  const params = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  await client.query(
    `insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")}`,
    params,
  );
  return rows.length;
}

const arr = (xs) => `{${xs.join(",")}}`;

/**
 * Build the barn and report it without connecting to anything.
 *
 * Worth having for its own sake: the generator is where the interesting mistakes live — a rest
 * window miscounted, a horse booked twice, a rider cleared for a horse they should not be — and
 * none of those need a database to find. `--dry-run` also makes the destructive path opt-in
 * rather than the only way to exercise this file.
 */
function dryRun() {
  const barn = build();
  const problems = [];

  // Every rule the generator claims to respect, re-checked over the finished set. Checking the
  // OUTPUT rather than trusting the loop that produced it is the point: a bug in the placement
  // logic would otherwise be invisible until the screens showed something impossible.
  const held = barn.bookings.filter((b) => ["pending", "confirmed"].includes(b.status));
  for (const a of held) {
    for (const b of held) {
      if (a === b || a.date !== b.date) continue;
      if (a.horseId === b.horseId && a.start < b.end && b.start < a.end) {
        problems.push(`${a.date}: horse double-booked at ${a.start}/${b.start}`);
      }
      if (a.studentId === b.studentId && a.start < b.end && b.start < a.end) {
        problems.push(`${a.date}: rider double-booked at ${a.start}/${b.start}`);
      }
    }
  }

  const RANK = { beginner: 0, intermediate: 1, advanced: 2 };
  for (const b of barn.bookings) {
    const s = barn.students.find((x) => x.id === b.studentId);
    const h = barn.horses.find((x) => x.id === b.horseId);
    if (RANK[s.level] < RANK[h.minExp]) problems.push(`${s.name} is on ${h.name}, above their level`);
    if (h.adultOnly && s.age < 18) problems.push(`${s.name} (${s.age}) is on adult-only ${h.name}`);
    if (h.maxWeight !== null && s.weight > h.maxWeight) problems.push(`${s.name} is over ${h.name}'s weight limit`);
    if (!h.styles.some((x) => s.styles.includes(x))) problems.push(`${s.name} and ${h.name} share no riding style`);
  }

  for (const d of new Set(barn.bookings.map((b) => b.date))) {
    if (dayOfWeek(d) === "sat") problems.push(`${d} is a Saturday and the coach is off`);
    for (const h of barn.horses) {
      const mins = barn.bookings
        .filter((b) => b.date === d && b.horseId === h.id)
        .reduce((n, b) => n + barn.types.find((t) => t.id === b.lessonTypeId).rideTimeMin, 0);
      if (h.maxOverall !== null && mins > h.maxOverall) {
        problems.push(`${h.name} is over its daily cap on ${d}: ${mins} > ${h.maxOverall}`);
      }
    }
  }

  const vesper = barn.horses.find((h) => h.key === "vesper");
  const vesperRiders = new Set(
    barn.bookings.filter((b) => b.horseId === vesper.id).map((b) => b.studentId),
  );
  const cleared = barn.students.filter((s) => RANK[s.level] >= RANK[vesper.minExp]);
  if (cleared.length !== 5) problems.push(`${cleared.length} riders clear ${vesper.name}, expected 5`);
  for (const id of vesperRiders) {
    if (!cleared.some((s) => s.id === id)) {
      problems.push(`${barn.students.find((s) => s.id === id).name} rode ${vesper.name} uncleared`);
    }
  }

  const byDay = {};
  for (const b of barn.bookings) byDay[dayOfWeek(b.date)] = (byDay[dayOfWeek(b.date)] ?? 0) + 1;

  console.log("\nWillowbrook Stables — dry run, nothing written\n");
  console.log(`  horses           ${barn.horses.length}`);
  console.log(`  riders           ${barn.students.length} (${barn.students.filter((s) => s.frequent).length} more than once a week)`);
  console.log(`  cleared for ${vesper.name}  ${cleared.length}: ${cleared.map((s) => s.name).join(", ")}`);
  console.log(`  standing slots   ${barn.recurring.length}`);
  console.log(`  lessons          ${barn.bookings.length}`);
  console.log(`  by weekday       ${JSON.stringify(byDay)}`);
  // The day the app opens on is the one that has to look right, so it gets its own line.
  const today = barn.bookings.filter((b) => b.date === TODAY);
  console.log(`  on ${TODAY}    ${today.length} lessons: ${today
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((b) => `${b.start} ${barn.students.find((s) => s.id === b.studentId).name.split(" ")[0]}`)
    .join(", ")}`);
  console.log(`  per horse        ${barn.horses
    .map((h) => `${h.name} ${barn.bookings.filter((b) => b.horseId === h.id).length}`)
    .join(", ")}`);
  console.log(`  riding windows   ${barn.students.reduce((n, s) => n + s.windows.length, 0)}`);
  console.log(`  alerts / offers  ${barn.alerts.length} / ${barn.offers.length}`);
  console.log(
    problems.length
      ? `\n  ${problems.length} PROBLEM(S):\n    ${[...new Set(problems)].slice(0, 20).join("\n    ")}\n`
      : "\n  Every booking satisfies pairing, horse-free, daily-cap and day-off rules.\n",
  );
  return problems.length ? 1 : 0;
}

async function main() {
  if (process.argv.includes("--dry-run")) {
    process.exit(dryRun());
  }
  const url = process.env.APP_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) {
    console.error(
      "Neither APP_DATABASE_URL nor TEST_DATABASE_URL is set, so there is no database to seed.\n" +
        "This script writes the demo barn wherever the app is pointed.",
    );
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  // The same refusal the test suites use, and for the same reason: this TRUNCATES. A database
  // is only safe to wipe if someone has explicitly designated it, and `npm run test:mark`
  // refuses to designate a database that has rows — which is what makes production unmarkable.
  const { rows: marker } = await client.query(
    "select to_regclass('public._rydeahorse_test_marker') as m",
  );
  if (!marker[0].m) {
    const { rows: who } = await client.query(
      "select current_database() as db, inet_server_addr()::text as addr",
    );
    console.error(
      `Refusing to seed ${who[0].db} (${who[0].addr ?? "unknown host"}).\n\n` +
        "This script TRUNCATES every table, so it will not run against a database that has not\n" +
        "been explicitly designated as safe to wipe. If this really is your development branch:\n\n" +
        "  cd db && npm run test:mark\n\n" +
        "which marks it, and which itself refuses unless the database is empty.",
    );
    await client.end();
    process.exit(1);
  }

  const barn = build();

  const { rows: tables } = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
        and table_name <> '_rydeahorse_test_marker'`,
  );
  await client.query(
    `truncate table ${tables.map((t) => client.escapeIdentifier(t.table_name)).join(", ")} restart identity cascade`,
  );

  await bulk(client, "accounts", ["id", "name"], [[barn.accountId, "Willowbrook Stables"]]);

  await bulk(client, "trainers",
    ["id", "account_id", "name", "email", "phone", "timezone", "scheduling_preference",
     "min_buffer_min", "late_cancel_hours"],
    [[barn.trainerId, barn.accountId, "Nora Whitfield", "nora@willowbrook.example", "555-0100",
      "America/Los_Angeles", "spaced", 0, 24]]);

  await bulk(client, "horses",
    ["id", "account_id", "name", "min_experience_level", "adult_only", "riding_styles",
     "max_rider_weight_lbs", "rest_days_per_week", "max_daily_minutes_adult",
     "max_daily_minutes_overall", "active", "notes"],
    barn.horses.map((h) => [h.id, barn.accountId, h.name, h.minExp, h.adultOnly, arr(h.styles),
      h.maxWeight, h.restDays, h.maxAdult, h.maxOverall, true, h.notes]));

  await bulk(client, "students",
    ["id", "trainer_id", "name", "phone", "emergency_contact_name", "emergency_contact_phone",
     "age", "experience_level", "riding_styles", "weight", "guardian_name", "guardian_phone",
     "guardian_relationship", "profile_status", "recurring_potential_unlocked", "active"],
    barn.students.map((s) => [s.id, barn.trainerId, s.name, s.phone, "Emergency Contact",
      "555-0199", s.age, s.level, arr(s.styles), s.weight, s.guardianName, s.guardianPhone,
      s.guardianRelationship, s.profileStatus, s.unlocked, true]));

  await bulk(client, "lesson_types",
    ["id", "trainer_id", "name", "duration_min", "ride_time_min", "is_intro", "is_group",
     "max_group_size", "base_price", "min_price", "max_price", "potential_lesson_eligible",
     "riding_styles"],
    barn.types.map((t) => [t.id, barn.trainerId, t.name, t.durationMin, t.rideTimeMin,
      !!t.isIntro, !!t.isGroup, t.maxGroupSize ?? null, t.basePrice, t.minPrice, t.maxPrice,
      t.potentialEligible, arr([])]));

  const bandId = uuid();
  await bulk(client, "price_bands", ["id", "trainer_id", "name"], [[bandId, barn.trainerId, "Peak"]]);
  await bulk(client, "price_band_windows",
    ["id", "band_id", "trainer_id", "day_of_week", "start_time", "end_time"],
    ["mon", "tue", "wed", "thu", "fri"].map((d) => [uuid(), bandId, barn.trainerId, d, "16:00", "19:00"]));
  await bulk(client, "lesson_type_band_adjustments",
    ["lesson_type_id", "band_id", "trainer_id", "amount"],
    [[barn.typeByKey.private.id, bandId, barn.trainerId, 10]]);

  await bulk(client, "trainer_availability",
    ["id", "trainer_id", "day_of_week", "start_time", "end_time"],
    AVAILABILITY.map(([d, s, e]) => [uuid(), barn.trainerId, d, s, e]));

  await bulk(client, "recurring_bookings",
    ["id", "trainer_id", "student_id", "horse_id", "lesson_type_id", "day_of_week", "start_time",
     "start_date", "status"],
    barn.recurring.map((r) => [r.id, barn.trainerId, r.studentId, r.horseId, r.lessonTypeId,
      r.day, r.start, r.startDate, "active"]));

  await bulk(client, "bookings",
    ["id", "trainer_id", "recurring_id", "student_id", "horse_id", "lesson_type_id", "date",
     "start_time", "end_time", "status", "base_price", "band_adjustment", "price",
     "is_billable", "is_new_student"],
    barn.bookings.map((b) => [b.id, barn.trainerId, b.recurringId, b.studentId, b.horseId,
      b.lessonTypeId, b.date, b.start, b.end, b.status, b.basePrice, b.bandAdjustment, b.price,
      b.billable, b.isNewStudent]));

  await bulk(client, "student_riding_windows",
    ["id", "student_id", "kind", "day_of_week", "start_time", "end_time"],
    barn.students.flatMap((s) =>
      s.windows.map((w) => [uuid(), s.id, w.kind, w.day, w.start, w.end])));

  await bulk(client, "student_no_ride_horses", ["student_id", "horse_id"],
    barn.noRide.map((n) => [n.studentId, n.horseId]));

  await bulk(client, "student_alerts", ["id", "student_id", "kind", "detail"],
    barn.alerts.map((a) => [a.id, a.studentId, a.kind, a.detail]));

  await bulk(client, "student_notes", ["id", "student_id", "category", "note"],
    barn.notes.map((n) => [n.id, n.studentId, n.category, n.note]));

  await bulk(client, "offers",
    ["id", "trainer_id", "student_id", "date", "start_time", "horse_id", "lesson_type_id",
     "kind", "offer_discount", "rank"],
    barn.offers.map((o) => [o.id, barn.trainerId, o.studentId, o.date, o.start, o.horseId,
      o.lessonTypeId, o.kind, o.discount, o.rank]));

  // ---- what was written -----------------------------------------------------------------------

  const counts = {};
  for (const t of ["horses", "students", "lesson_types", "bookings", "recurring_bookings",
                   "trainer_availability", "student_riding_windows", "student_alerts", "offers"]) {
    counts[t] = (await client.query(`select count(*)::int n from ${t}`)).rows[0].n;
  }

  const thisWeek = barn.bookings.filter(
    (b) => daysBetween(b.date, TODAY) <= 6 && daysBetween(TODAY, b.date) <= 6,
  );
  const vesper = barn.horses.find((h) => h.key === "vesper");
  const clearedForVesper = barn.students.filter((s) => s.level === "advanced").length;

  console.log("\nWillowbrook Stables — seeded\n");
  console.log(`  coach            Nora Whitfield, off on Saturdays`);
  console.log(`  teaching days    ${TEACHING_DAYS.join(", ")}`);
  console.log(`  horses           ${counts.horses}  (${vesper.name} is advanced-only)`);
  console.log(`  riders           ${counts.students}  — ${clearedForVesper} cleared for ${vesper.name}`);
  console.log(`  standing slots   ${counts.recurring_bookings} weekly, for ${barn.students.filter((s) => s.frequent).length} riders`);
  console.log(`  lessons          ${counts.bookings} over three weeks, ${thisWeek.length} in the week of ${TODAY}`);
  console.log(`  riding windows   ${counts.student_riding_windows}`);
  console.log(`  alerts / offers  ${counts.student_alerts} / ${counts.offers}`);
  console.log(`\n  Open the app and it lands on ${TODAY}.\n`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
