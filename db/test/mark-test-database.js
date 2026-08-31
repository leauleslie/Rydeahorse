// One-time designation of a database as safe to truncate. `npm run test:mark`.
//
// Deliberately a separate, explicit command rather than something the suites do for
// themselves. If the test run could mark its own target, the marker would prove nothing —
// it would appear on whatever you pointed at, including production.
//
// Two conditions, both required:
//   1. guard.js passes (not production's host, not a production-sounding name).
//   2. The database is EMPTY. This is the load-bearing one. It cannot be satisfied by a
//      database anyone is using, which is what makes production unmarkable in practice
//      rather than merely by convention.
import { connect, isEmpty, MARKER_TABLE } from "./db.js";

const client = await connect();
try {
  const { rows } = await client.query("select to_regclass($1) is not null as marked", [
    `public.${MARKER_TABLE}`,
  ]);
  if (rows[0].marked) {
    console.log(`Already marked. public.${MARKER_TABLE} exists; nothing to do.`);
  } else {
    if (!(await isEmpty(client))) {
      const counts = [];
      for (const t of ["accounts", "trainers", "horses", "students", "bookings"]) {
        const { rows: c } = await client.query(`select count(*)::int n from ${t}`);
        counts.push(`${t}=${c[0].n}`);
      }
      console.error(
        "REFUSED: the target database is not empty.\n" +
          `  ${counts.join("  ")}\n\n` +
          "Only an empty database can be designated as the test database. A database with rows\n" +
          "is one someone is using. If this is genuinely a scratch branch, empty it deliberately\n" +
          "first — that step is meant to be uncomfortable.",
      );
      process.exit(1);
    }
    await client.query(
      `create table ${MARKER_TABLE} (
         marked_at timestamptz not null default now(),
         note text not null
       )`,
    );
    await client.query(`insert into ${MARKER_TABLE} (note) values ($1)`, [
      "Designated by db/test/mark-test-database.js. Suites in db/test/ TRUNCATE every table here.",
    ]);
    console.log(`Marked. public.${MARKER_TABLE} created.`);
  }
  const { rows: who } = await client.query("select current_database() db");
  console.log(`Test database ready: ${who[0].db}`);
} finally {
  await client.end();
}
