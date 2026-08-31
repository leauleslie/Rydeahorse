// The refusal. Nothing in db/test/ opens a connection except through here.
//
// The threat is not exotic: it is a copy-pasted connection string. `.env.local` holds three,
// all three are Neon, and — this is the part that makes a casual check useless — all three
// have the SAME database name (`neondb`) and the SAME user (`neondb_owner`). Only the host
// differs. A guard that asserts `dbname === 'test'` would pass against production here.
//
// So the guard is two layers, and they fail in opposite directions on purpose:
//
//   1. A DENY list, computed from the environment itself (below, `assertNotProduction`).
//      Whatever DATABASE_URL and DIRECT_DATABASE_URL point at is production BY DEFINITION,
//      and the test URL may not resolve to the same place. This runs BEFORE any socket is
//      opened, so a refusal never touches the server it is refusing.
//
//   2. An ALLOW list, checked after connecting (`assertMarked`, in db.js). The database must
//      carry a marker table that only `npm run test:mark` creates, and marking only succeeds
//      on an EMPTY database. Production is not empty, so production cannot be marked.
//
// Layer 1 alone is not enough: in CI only TEST_DATABASE_URL may be set, leaving nothing to
// compare against, and a deny list with no entries denies nothing. Layer 2 alone is not
// enough either: a marker can be copied by a careless `pg_dump | psql`. Together, the failure
// that gets past both is "someone marked production on purpose, while it was empty", which is
// not the mistake this is defending against.
//
// There is deliberately no override flag. A guard with a documented bypass is a guard that
// gets bypassed at 2am by the person it exists to protect.

export class ProductionDatabaseRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "ProductionDatabaseRefusal";
  }
}

// Tokens that name a production database outright. Matched as whole `-`/`_`/`.` separated
// words, never as substrings — a substring match would reject a perfectly good host called
// `ep-proud-sky-1234` for containing "pro", and a guard that cries wolf gets deleted.
const PRODUCTION_TOKENS = new Set(["prod", "production", "live", "prd"]);

function tokens(s) {
  return String(s ?? "")
    .toLowerCase()
    .split(/[-_.]+/)
    .filter(Boolean);
}

// Neon exposes one endpoint twice: `ep-x-123.region.aws.neon.tech` (direct) and
// `ep-x-123-pooler.region.aws.neon.tech` (PgBouncer). Those are the SAME database. Comparing
// raw hostnames would call them different and wave the pooled production URL straight
// through, which is the single most likely way this guard would have failed in practice.
function normalizeHost(hostname) {
  const [first, ...rest] = String(hostname).toLowerCase().split(".");
  return [first.replace(/-pooler$/, ""), ...rest].join(".");
}

// The identity a connection string actually resolves to. Credentials are excluded on purpose:
// the same database reached as a different user is still the same database.
function target(url) {
  const u = new URL(url);
  return {
    host: normalizeHost(u.hostname),
    port: u.port || "5432",
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

const sameTarget = (a, b) =>
  a.host === b.host && a.port === b.port && a.database === b.database;

const describe = (t) => `${t.host}:${t.port}/${t.database}`;

/**
 * Decide whether `candidate` may be used destructively, given the surrounding environment.
 * Pure and offline — it parses strings and opens nothing, so it is safe to unit-test against
 * a real production URL, which is exactly what test/guard.test.js does.
 *
 * @throws {ProductionDatabaseRefusal}
 */
export function assertNotProduction(candidate, env = process.env) {
  if (!candidate || !String(candidate).trim()) {
    throw new ProductionDatabaseRefusal(
      "TEST_DATABASE_URL is not set.\n" +
        "Refusing to fall back to DATABASE_URL — that fallback is the accident this guard exists to prevent.",
    );
  }

  let candidateTarget;
  try {
    candidateTarget = target(candidate);
  } catch {
    throw new ProductionDatabaseRefusal(
      "TEST_DATABASE_URL is not a parseable connection URL. Refusing to connect to something we cannot identify.",
    );
  }

  if (env.NODE_ENV === "production") {
    throw new ProductionDatabaseRefusal(
      "NODE_ENV=production. These suites truncate tables; they do not run in a production process.",
    );
  }

  // The deny list, derived from the environment rather than hardcoded. If this checkout can
  // see where production lives, the test URL may not point there.
  for (const name of ["DATABASE_URL", "DIRECT_DATABASE_URL"]) {
    const value = env[name];
    if (!value || !String(value).trim()) continue;

    let known;
    try {
      known = target(value);
    } catch {
      continue; // An unparseable production URL tells us nothing; layer 2 still applies.
    }

    if (sameTarget(candidateTarget, known)) {
      throw new ProductionDatabaseRefusal(
        `TEST_DATABASE_URL resolves to the same database as ${name}.\n` +
          `  both -> ${describe(candidateTarget)}\n` +
          "These suites TRUNCATE every table. Point TEST_DATABASE_URL at a separate branch.\n" +
          "(Pooled and direct Neon hosts for one endpoint compare equal here — they are one database.)",
      );
    }
  }

  // Names that announce themselves. Catches the CI case where the deny list above is empty
  // because no production URL is present to compare against.
  for (const token of [...tokens(candidateTarget.host), ...tokens(candidateTarget.database)]) {
    if (PRODUCTION_TOKENS.has(token)) {
      throw new ProductionDatabaseRefusal(
        `TEST_DATABASE_URL names itself as production (token "${token}"):\n` +
          `  -> ${describe(candidateTarget)}\n` +
          "Refusing. These suites truncate every table.",
      );
    }
  }

  return candidate;
}

/** The only supported way to obtain a connection string in the test suites. */
export function resolveTestDatabaseUrl(env = process.env) {
  return assertNotProduction(env.TEST_DATABASE_URL, env);
}

export const _internals = { normalizeHost, target, sameTarget };
