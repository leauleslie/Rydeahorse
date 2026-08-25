// The guard's own tests. Offline and pure — assertNotProduction parses strings and opens no
// socket, which is what makes it safe to point at the REAL production URL from `.env.local`
// here. That case is the one that matters: it is the actual mistake being defended against,
// tested against the actual values, not a plausible-looking stand-in.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNotProduction, ProductionDatabaseRefusal } from "./guard.js";

const envLocal = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.local");
if (existsSync(envLocal)) process.loadEnvFile(envLocal);

const PROD = "postgres://u:p@ep-tiny-breeze-a69luthu.us-west-2.aws.neon.tech/neondb";
const POOLED = "postgres://u:p@ep-tiny-breeze-a69luthu-pooler.us-west-2.aws.neon.tech/neondb";
const TEST = "postgres://u:p@ep-sparkling-scene-a62v379o.us-west-2.aws.neon.tech/neondb";
const env = { DATABASE_URL: POOLED, DIRECT_DATABASE_URL: PROD };

const refuses = (fn, why) => assert.throws(fn, ProductionDatabaseRefusal, why);

describe("the guard refuses production", () => {
  test("refuses the unpooled production URL", () => {
    refuses(() => assertNotProduction(PROD, env));
  });

  test("refuses the POOLED production URL, which is a different hostname for the same database", () => {
    // The likeliest near-miss. `ep-x-pooler.…` and `ep-x.…` are one database behind two
    // names; a raw hostname comparison would call them different and wave this through.
    refuses(() => assertNotProduction(POOLED, env));
  });

  test("refuses when DATABASE_URL is the only production URL present", () => {
    refuses(() => assertNotProduction(POOLED, { DATABASE_URL: POOLED }));
  });

  test("refuses an unset TEST_DATABASE_URL rather than falling back", () => {
    refuses(() => assertNotProduction(undefined, env));
    refuses(() => assertNotProduction("", env));
  });

  test("refuses a database that names itself production, even with nothing to compare against", () => {
    // The CI case: no DATABASE_URL in the environment, so the deny list is empty.
    refuses(() => assertNotProduction("postgres://u:p@db.internal/rydeahorse_production", {}));
    refuses(() => assertNotProduction("postgres://u:p@prod.db.internal/rydeahorse", {}));
  });

  test("refuses to run under NODE_ENV=production whatever the URL says", () => {
    refuses(() => assertNotProduction(TEST, { ...env, NODE_ENV: "production" }));
  });

  test("refuses a URL it cannot parse — an unidentifiable target is not a safe one", () => {
    refuses(() => assertNotProduction("not-a-url", env));
  });
});

describe("the guard allows a genuine test branch", () => {
  test("accepts a separate Neon endpoint", () => {
    assert.equal(assertNotProduction(TEST, env), TEST);
  });

  test("does not reject a host merely for containing production-ish letters", () => {
    // Whole-token matching. `ep-proud-...` contains "pro"; rejecting it would be a false
    // alarm, and a guard that cries wolf is a guard someone disables.
    const ok = "postgres://u:p@ep-proud-livery-9x.us-west-2.aws.neon.tech/neondb";
    assert.equal(assertNotProduction(ok, env), ok);
  });
});

describe("against the real .env.local", () => {
  const { DATABASE_URL, DIRECT_DATABASE_URL, TEST_DATABASE_URL } = process.env;

  test("the configured TEST_DATABASE_URL is accepted", { skip: !TEST_DATABASE_URL }, () => {
    assert.equal(assertNotProduction(TEST_DATABASE_URL, process.env), TEST_DATABASE_URL);
  });

  test("the configured production URLs are refused", { skip: !DATABASE_URL }, () => {
    // No connection is opened by any of this.
    refuses(() => assertNotProduction(DATABASE_URL, process.env));
    if (DIRECT_DATABASE_URL) refuses(() => assertNotProduction(DIRECT_DATABASE_URL, process.env));
  });
});
