// The public surface of the data layer's schema. Mirrors `engine/index.js`: one place that
// re-exports everything, so nothing imports a file path.
//
// Note what is NOT here: any query, any connection, any tenant filter. The engine takes the
// horses, students, bookings and config it is given and never asks where they came from, so
// it cannot leak across tenants — because it cannot query. Scoping is one `trainer_id` (or
// `account_id`) filter at the repository, and the camelCase/snake_case mapping lives there
// too, not inside the engine.
export * from "./enums.js";
export * from "./tenancy.js";
export * from "./horses.js";
export * from "./trainerSchedule.js";
export * from "./pricing.js";
export * from "./identity.js";
export * from "./students.js";
export * from "./disclosures.js";
export * from "./bookings.js";
export * from "./messages.js";
