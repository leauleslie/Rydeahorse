// The isolation assertions, factored out so the SAME checks can run over a direct connection
// and over the PgBouncer-pooled one.
//
// Every query here deliberately omits a WHERE clause. If a row does not come back, the
// database decided that — not the repository, and not the query.
//
// Returns failures rather than throwing, so a caller can report which connection mode failed.
import { students, horses, bookings, studentAlerts } from "../schema/index.js";
import { withTenantTransaction } from "../repo/index.js";

const idsOf = (rows) => new Set(rows.map((r) => r.id));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const listOf = (s) => [...s].slice(0, 3).join(", ");

/**
 * @param ctx { client, db, alder, birch, label }
 * @returns string[] failures; empty means isolation held
 */
export async function collectIsolationFailures({ client, db, alder, birch, label }) {
  const fails = [];
  const note = (m) => fails.push(`[${label}] ${m}`);
  const [a1, a2] = alder.trainers;
  const [b1] = birch.trainers;
  const tenant = (acc, t) => ({ accountId: acc.accountId, trainerId: t.trainerId });

  // 1. The point: no WHERE clause, and only the caller's roster comes back.
  const roster = await withTenantTransaction(client, tenant(alder, a1), () =>
    db.select().from(students));
  if (!same(idsOf(roster), new Set(a1.students))) {
    note(`select * from students returned ${idsOf(roster).size} rows, expected a1's 3: ${listOf(idsOf(roster))}`);
  }
  for (const id of [...a2.students, ...b1.students]) {
    if (idsOf(roster).has(id)) note(`another trainer's student ${id} was visible`);
  }

  // 2. Two trainers in one barn, identical query, different rosters.
  const rosterA2 = await withTenantTransaction(client, tenant(alder, a2), () =>
    db.select().from(students));
  if (!same(idsOf(rosterA2), new Set(a2.students))) {
    note("a2's roster was wrong");
  }
  if ([...idsOf(roster)].some((id) => idsOf(rosterA2).has(id))) {
    note("a1 and a2 share roster rows — sharing an account must not mean sharing a roster");
  }

  // 3. Account-scoped rows stay SHARED. A policy that isolated horses per trainer would put
  //    the welfare rules on half of a horse's saddle time.
  const hA1 = await withTenantTransaction(client, tenant(alder, a1), () => db.select().from(horses));
  const hA2 = await withTenantTransaction(client, tenant(alder, a2), () => db.select().from(horses));
  if (!same(idsOf(hA1), new Set(alder.horses))) note("a1 did not see the account's horses");
  if (!same(idsOf(hA1), idsOf(hA2))) note("horses were not shared between two trainers in one account");
  for (const id of birch.horses) {
    if (idsOf(hA1).has(id)) note(`another account's horse ${id} was visible`);
  }

  // 4. Bookings are account-scoped so horse welfare can see the whole barn.
  const bk = await withTenantTransaction(client, tenant(alder, a1), () => db.select().from(bookings));
  if (!same(idsOf(bk), new Set(alder.accountBookings))) {
    note(`bookings returned ${idsOf(bk).size} rows, expected the account's ${alder.accountBookings.length}`);
  }
  for (const id of b1.bookings) {
    if (idsOf(bk).has(id)) note(`another account's booking ${id} was visible`);
  }

  // 5. A table with no tenant column at all, scoped through students.
  const al = await withTenantTransaction(client, tenant(alder, a1), () =>
    db.select().from(studentAlerts));
  if (!same(idsOf(al), new Set(a1.alerts))) note("student_alerts leaked or came back wrong");

  // 6. Fails closed: identified as nobody, see nothing.
  await client.query("begin");
  const bare = await db.select().from(students);
  await client.query("commit");
  if (bare.length !== 0) {
    note(`an unidentified transaction returned ${bare.length} rows — it must return none`);
  }

  return fails;
}
