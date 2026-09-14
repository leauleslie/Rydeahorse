// The rules and pricing engine. Pure: no React, no DOM, no database, no global clock.
// The same module runs on the server (where it is authoritative) and in the browser (where it
// previews). Neither reimplements it — that is the point.

export * from "./time.js";
export * from "./clock.js";
export * from "./constants.js";
export * from "./pricing.js";
export * from "./derive.js";
export * from "./rules.js";

// Matching sits ABOVE the rules: they answer "may this booking exist?", it answers "what should
// we suggest?". The dependency runs one way only — matching imports from rules, never the
// reverse — and test/layering.test.js asserts it stays that way.
export * from "./matching.js";
