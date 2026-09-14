// The dependency direction, asserted rather than trusted.
//
// Matching sits above the rules: it answers "what should we suggest?" by calling into "may this
// booking exist?". The moment a rule imports matching, that inverts — a validity check would
// start depending on a suggestion heuristic, and the engine's whole claim (that a rule can be
// tested with nothing but hand-built objects) goes with it.
//
// This is cheap to state and easy to violate accidentally, which is exactly the kind of rule
// worth spending a test on.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = readdirSync(engineDir).filter((f) => f.endsWith(".js"));

// Matched against real import/export statements only, anchored at the start of a line. A
// looser `from "..."` scan reads prose out of comments — this file's first version flagged the
// phrase `separate from "which horse ended up on it"` in derive.js as a dependency.
const IMPORT_RE = /^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm;

const specifiersOf = (file) => {
  const src = readFileSync(join(engineDir, file), "utf8");
  return [...src.matchAll(IMPORT_RE)].map((m) => m[1]);
};

const importsOf = (file) =>
  specifiersOf(file).filter((sp) => sp.startsWith("./")).map((sp) => sp.replace("./", ""));

describe("the engine's layering", () => {
  test("nothing in the rules layer imports matching", () => {
    // index.js re-exports everything and is the one file allowed to name both.
    const offenders = sourceFiles
      .filter((f) => f !== "matching.js" && f !== "index.js")
      .filter((f) => importsOf(f).includes("matching.js"));
    assert.deepEqual(
      offenders,
      [],
      "a rule may not depend on a suggestion heuristic — move the shared part down, not the caller up",
    );
  });

  test("matching does depend on the rules, so the layering is real and not merely unused", () => {
    // Without this, the test above would also pass on a matching.js that imported nothing,
    // which would prove no layering at all.
    const deps = importsOf("matching.js");
    assert.ok(deps.includes("rules.js"), "matching should validate through the rules");
    assert.ok(deps.length > 1, "and reuse the shared primitives rather than re-deriving them");
  });

  test("the engine still has no dependencies outside itself", () => {
    // Purity is the property that lets the same functions run in the browser, on the server and
    // in a test with no database. A single import of `pg` or React here would end it.
    for (const file of sourceFiles) {
      const external = specifiersOf(file).filter((sp) => !sp.startsWith("."));
      assert.deepEqual(external, [], `${file} imports something outside the engine: ${external}`);
    }
  });
});
