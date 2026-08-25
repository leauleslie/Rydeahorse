// Small, hand-built fixtures. Deliberately NOT the prototype's seed data: seed data is tuned
// to make screens look plausible, which makes it a poor instrument for pinning down a rule.
// Each fixture here exists to make one boundary reachable.

export const NOW = new Date(2026, 7, 18, 7, 0); // Tue 18 Aug 2026, 7:00 AM
export const d = (day) => new Date(2026, 7, day);

export const horses = [
  {
    id: "buttercup",
    name: "Buttercup",
    active: true,
    minExp: "beginner",
    adultOnly: false,
    styles: ["English", "Western"],
    maxWeight: 180,
    restDaysPerWeek: 1,
    maxDailyAdult: 120,
    maxDailyOverall: 180,
  },
  {
    id: "atlas",
    name: "Atlas",
    active: true,
    minExp: "advanced",
    adultOnly: true,
    styles: ["English"],
    maxWeight: 200,
    restDaysPerWeek: 2,
    maxDailyAdult: 60,
    maxDailyOverall: 120,
  },
  {
    id: "retired",
    name: "Retired",
    active: false,
    minExp: "beginner",
    adultOnly: false,
    styles: ["English", "Western"],
    maxWeight: 200,
    restDaysPerWeek: 1,
    maxDailyAdult: 120,
    maxDailyOverall: 180,
  },
];

export const students = [
  {
    id: "maya",
    name: "Maya",
    age: 34,
    experienceLevel: "intermediate",
    ridingStyles: ["English"],
    weight: 140,
    noRideHorses: [],
    frequencyTier: 0,
  },
  {
    id: "jordan",
    name: "Jordan",
    age: 12,
    experienceLevel: "beginner",
    ridingStyles: ["Western"],
    weight: 90,
    noRideHorses: [],
    frequencyTier: 0,
  },
];

export const lessonTypes = [
  {
    id: "private60",
    name: "60-min private",
    durationMin: 60,
    rideTimeMin: 50,
    basePrice: 60,
    minPrice: 55,
    maxPrice: 90,
    bandAdjustments: { evening: 10 },
    freqDiscount1: 5,
    freqDiscount2: 10,
    restrictedHorseIds: [],
    ridingStyles: [],
    isGroup: false,
  },
  {
    id: "group90",
    name: "90-min group",
    durationMin: 90,
    rideTimeMin: 70,
    basePrice: 40,
    minPrice: 30,
    maxPrice: 60,
    bandAdjustments: {},
    freqDiscount1: 0,
    freqDiscount2: 0,
    restrictedHorseIds: [],
    ridingStyles: [],
    isGroup: true,
    maxGroupSize: 3,
  },
];

export const priceBands = [
  { id: "evening", name: "Evening", days: [1, 2, 3, 4, 5], start: "15:00", end: "19:00" },
];

export const trainerConfig = {
  minBufferMin: 15,
  maxBufferMin: 30,
  maxBackToBack: 4,
  schedulingPreference: "back_to_back",
  lateCancelHours: 24,
  freqTier1MinRides: 8,
  freqTier2MinRides: 12,
};

export const availability = [
  { day: 1, start: "08:00", end: "19:00" },
  { day: 2, start: "08:00", end: "19:00" },
  { day: 3, start: "08:00", end: "19:00" },
  { day: 4, start: "08:00", end: "19:00" },
  { day: 5, start: "08:00", end: "19:00" },
];

export const timeOffBlocks = [];

export function booking(over = {}) {
  return {
    id: "b-" + Math.random().toString(36).slice(2, 8),
    studentId: "maya",
    horseId: "buttercup",
    lessonTypeId: "private60",
    date: d(19),
    start: "10:00",
    status: "confirmed",
    isBillable: true,
    ...over,
  };
}

// A booking request with sensible defaults, so each test overrides only what it is testing.
export function request(over = {}) {
  return {
    student: students[0],
    horse: horses[0],
    lessonType: lessonTypes[0],
    date: d(19),
    start: "10:00",
    bookings: [],
    students,
    lessonTypes,
    availability,
    timeOffBlocks,
    priceBands,
    trainerConfig,
    ...over,
  };
}
