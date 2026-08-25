// The checker. Given one registry entry and three seeded trainers, decide whether that read
// obeys the scoping rule it claims — returning reasons rather than throwing, so the harness
// itself can be tested against reads that are known to be wrong.
//
// There are TWO rules, and conflating them is how this file was wrong before:
//
//   scope: "trainer"   Isolation. No two trainers may ever see each other's rows — not
//                      across accounts, and not inside one account either.
//
//   scope: "account"   Sharing. Two trainers in ONE account must see IDENTICAL rows, because
//                      a horse is a physical animal at a facility and both coaches ride it.
//                      Across accounts they must still be disjoint.
//
// So "A and B returned different rows" is evidence of correctness for one rule and evidence
// of a BUG for the other. A single disjointness check cannot express that, and applied to
// horses it would report the schema working as designed as a leak.
//
// Three trainers are the minimum needed to reach both directions:
//   a1 vs b1  — different accounts. Always disjoint, whatever the scope.
//   a1 vs a2  — same account. Disjoint for trainer scope, identical for account scope.
//
// The remaining checks exist because the characteristic failure of a harness like this is not
// a false alarm, it is the silent pass. A read returning nothing satisfies "returned no other
// tenant's rows" perfectly, and so does a read that is simply broken.

const setOf = (xs) => new Set(xs);
const intersect = (a, b) => [...a].filter((x) => b.has(x));
const equalSets = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const sample = (xs) => [...xs].slice(0, 3).join(", ");

export const SCOPES = ["trainer", "account"];

/**
 * @param entry  a registry entry from tenant-queries.js
 * @param ctx    { a1, a2, b1 } — each { repo, manifest }. a1/a2 share an account.
 * @returns      array of human-readable violations; empty means the read obeys its rule
 */
export async function checkEntry(entry, ctx) {
  const violations = [];
  const note = (m) => violations.push(`${entry.name}: ${m}`);
  const { a1, a2, b1 } = ctx;

  if (!SCOPES.includes(entry.scope)) {
    note(`declares unknown scope "${entry.scope}" — must be one of ${SCOPES.join(" | ")}`);
    return violations;
  }
  for (const [who, t] of [["a1", a1], ["a2", a2], ["b1", b1]]) {
    if (!t.manifest[entry.owns]) {
      note(`names entity set "${entry.owns}", which ${who}'s manifest does not define`);
      return violations;
    }
    if (t.manifest[entry.owns].length === 0) {
      note(`the seed created no "${entry.owns}" rows for ${who} — every check would be vacuous`);
      return violations;
    }
  }

  let rows;
  try {
    rows = {
      a1: await entry.run(a1.repo, a1.manifest),
      a2: await entry.run(a2.repo, a2.manifest),
      b1: await entry.run(b1.repo, b1.manifest),
    };
  } catch (err) {
    note(`threw: ${err.message}`);
    return violations;
  }

  const ids = {
    a1: setOf(rows.a1.map(entry.id)),
    a2: setOf(rows.a2.map(entry.id)),
    b1: setOf(rows.b1.map(entry.id)),
  };
  const owned = {
    a1: setOf(a1.manifest[entry.owns]),
    a2: setOf(a2.manifest[entry.owns]),
    b1: setOf(b1.manifest[entry.owns]),
  };

  // 1. Vacuity. A read that returns nothing proves nothing, for either rule.
  let vacuous = false;
  for (const who of ["a1", "a2", "b1"]) {
    if (ids[who].size === 0) {
      note(`returned no rows for ${who} — a pass here would be vacuous`);
      vacuous = true;
    }
  }
  if (vacuous) return violations;

  // 2. Every row a caller got must be one that caller is entitled to.
  for (const who of ["a1", "a2", "b1"]) {
    const stray = [...ids[who]].filter((id) => !owned[who].has(id));
    if (stray.length) {
      note(`returned ${stray.length} row(s) ${who} does not own: ${sample(stray)}`);
    }
  }

  // 3. Cross-account. Disjoint under BOTH rules — no exceptions, whatever the scope.
  const aIntoB = intersect(ids.a1, owned.b1);
  if (aIntoB.length) {
    note(`LEAK — a1 received ${aIntoB.length} row(s) owned by another account: ${sample(aIntoB)}`);
  }
  const bIntoA = intersect(ids.b1, owned.a1);
  if (bIntoA.length) {
    note(`LEAK — b1 received ${bIntoA.length} row(s) owned by another account: ${sample(bIntoA)}`);
  }
  const sharedAcrossAccounts = intersect(ids.a1, ids.b1);
  if (sharedAcrossAccounts.length) {
    note(
      `returned ${sharedAcrossAccounts.length} identical row(s) to two different ACCOUNTS — ` +
        `the tenant argument is not filtering: ${sample(sharedAcrossAccounts)}`,
    );
  }

  // 4. Same account, two trainers. This is where the two rules diverge.
  if (entry.scope === "trainer") {
    const bleed = intersect(ids.a1, ids.a2);
    if (bleed.length) {
      note(
        `LEAK — two trainers in ONE account both received ${bleed.length} trainer-scoped row(s): ` +
          `${sample(bleed)}. Sharing an account does not mean sharing a roster.`,
      );
    }
  } else {
    // The direction that was untested: account-scoped rows MUST be shared. A horse ridden by
    // both coaches is one animal, and a read that hid a1's horses from a2 would put the
    // welfare rules on half the picture — the exact failure that made coach-level tenancy
    // untenable.
    if (!equalSets(ids.a1, ids.a2)) {
      const onlyA1 = [...ids.a1].filter((x) => !ids.a2.has(x));
      const onlyA2 = [...ids.a2].filter((x) => !ids.a1.has(x));
      note(
        `NOT SHARED — two trainers in one account got different account-scoped rows ` +
          `(${onlyA1.length} only a1: ${sample(onlyA1)}; ${onlyA2.length} only a2: ${sample(onlyA2)}). ` +
          `An account-scoped read must return the same rows to every trainer in the account.`,
      );
    }
  }

  // 5. Ask for someone else's row by identifier. The enumeration attack: a read that never
  //    filters by tenant behaves perfectly until a foreign id is passed, so nothing above
  //    catches it.
  if (entry.probe) {
    const probes = [["another account", b1.manifest]];
    // Only meaningful for trainer scope — a1 and a2 share their account-scoped ids by design,
    // so probing a2 with an account-scoped read is asking for a row a1 is entitled to.
    if (entry.scope === "trainer") probes.push(["another trainer in the SAME account", a2.manifest]);

    for (const [what, manifest] of probes) {
      try {
        const probed = await entry.probe(a1.repo, manifest);
        if (probed.length) {
          note(`LEAK — fetching an identifier belonging to ${what} returned ${probed.length} row(s)`);
        }
      } catch (err) {
        note(`cross-tenant probe (${what}) threw: ${err.message}`);
      }
    }
  }

  return violations;
}
