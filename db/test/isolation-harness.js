// The checker. Given one registry entry and two seeded tenants, decide whether that read
// leaks — and return the reasons rather than throwing, so the harness itself can be tested
// against a query that is known to leak (see the negative controls in tenancy.test.js).
//
// A harness like this has one characteristic failure, and it is not a false alarm: it is the
// silent pass. A read that returns nothing satisfies "returned no other tenant's rows"
// perfectly. So does a read that is broken, a read against an empty table, and a read whose
// filter accidentally excludes everything. Four of the seven checks below exist only to make
// that impossible:
//
//   nonEmpty      — the read must actually return rows for BOTH tenants, or the result is
//                   evidence of nothing.
//   ownedByCaller — every row must be one the caller's own seed created. Catches a read that
//                   returns rows belonging to nobody (a bad join fabricating rows).
//   distinct      — A and B must not return the SAME rows. This is the one that catches an
//                   unscoped `select * from horses`: it returns all six horses for both
//                   tenants, which passes "non-empty" and fails here.
//   noForeignRows — the direct check: none of A's rows may be B's.
//
// `distinct` and `noForeignRows` overlap but are not redundant. A read returning the union of
// both tenants fails both. A read returning ONLY the other tenant's rows fails
// noForeignRows and ownedByCaller but would pass distinct. Keeping all of them means no
// single wrong implementation slips through.

const setOf = (xs) => new Set(xs);
const intersect = (a, b) => [...a].filter((x) => b.has(x));

/**
 * @param entry  a registry entry from tenant-queries.js
 * @param ctx    { a: {repo, manifest}, b: {repo, manifest} }
 * @returns      array of human-readable violations; empty means the read is isolated
 */
export async function checkEntry(entry, ctx) {
  const violations = [];
  const note = (m) => violations.push(`${entry.name}: ${m}`);

  const { a, b } = ctx;
  const ownedA = setOf(a.manifest[entry.owns]);
  const ownedB = setOf(b.manifest[entry.owns]);

  if (!a.manifest[entry.owns] || !b.manifest[entry.owns]) {
    note(`registry names entity set "${entry.owns}", which the seed manifest does not define`);
    return violations;
  }
  if (ownedA.size === 0 || ownedB.size === 0) {
    note(`the seed created no "${entry.owns}" rows for one of the tenants — this check would be vacuous`);
    return violations;
  }

  let rowsA, rowsB;
  try {
    rowsA = await entry.run(a.repo, a.manifest);
    rowsB = await entry.run(b.repo, b.manifest);
  } catch (err) {
    note(`threw: ${err.message}`);
    return violations;
  }

  const idsA = setOf(rowsA.map(entry.id));
  const idsB = setOf(rowsB.map(entry.id));

  // 1. Vacuity. A read that returns nothing proves nothing.
  if (idsA.size === 0) note("returned no rows for tenant A — a pass here would be vacuous");
  if (idsB.size === 0) note("returned no rows for tenant B — a pass here would be vacuous");
  if (idsA.size === 0 || idsB.size === 0) return violations;

  // 2. Every row the caller got must be one the caller owns.
  const strayA = intersect(idsA, ownedA).length !== idsA.size;
  if (strayA) {
    const stray = [...idsA].filter((id) => !ownedA.has(id));
    note(`returned ${stray.length} row(s) tenant A does not own: ${stray.slice(0, 3).join(", ")}`);
  }

  // 3. The direct leak: A holding B's rows.
  const leaked = intersect(idsA, ownedB);
  if (leaked.length) {
    note(
      `LEAK — returned ${leaked.length} row(s) belonging to tenant B: ${leaked.slice(0, 3).join(", ")}`,
    );
  }
  const leakedOther = intersect(idsB, ownedA);
  if (leakedOther.length) {
    note(
      `LEAK — tenant B's call returned ${leakedOther.length} row(s) belonging to tenant A: ${leakedOther.slice(0, 3).join(", ")}`,
    );
  }

  // 4. The two tenants must genuinely disagree. An unscoped read returns identical rows to
  //    both callers, and every check above except this one can be satisfied by that.
  const shared = intersect(idsA, idsB);
  if (shared.length) {
    note(
      `returned ${shared.length} identical row(s) to both tenants — the tenant argument is not filtering: ${shared.slice(0, 3).join(", ")}`,
    );
  }

  // 5. Optional: ask for the OTHER tenant's row by id while bound to this tenant. The
  //    enumeration attack — the one a naive `byId` fails and every check above misses,
  //    because a naive byId is perfectly well-behaved until someone passes a foreign id.
  if (entry.probe) {
    try {
      const probed = await entry.probe(a.repo, b.manifest);
      if (probed.length) {
        note(
          `LEAK — fetching tenant B's identifier while bound to tenant A returned ${probed.length} row(s)`,
        );
      }
    } catch (err) {
      note(`cross-tenant probe threw: ${err.message}`);
    }
  }

  return violations;
}
