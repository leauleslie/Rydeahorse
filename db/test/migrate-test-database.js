// Apply migrations to the TEST branch, through the same guard the suites use.
// `npm run test:migrate`.
//
// The alternative in db/README.md is to override the variable by hand:
//
//   DIRECT_DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
//
// which is correct but unguarded and easy to get wrong — a shell that keeps the surrounding
// quotes hands drizzle-kit a malformed URL, and a shell that expands the WRONG variable
// migrates production. This wrapper resolves the URL through guard.js first, so the same
// refusal that protects the suites protects DDL.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./db.js"; // loads .env.local; opens nothing at import time
import { resolveTestDatabaseUrl } from "./guard.js";

const url = resolveTestDatabaseUrl();
const dbDir = join(dirname(fileURLToPath(import.meta.url)), "..");

console.log(`Migrating test branch: ${new URL(url).hostname}`);
const result = spawnSync("npx", ["drizzle-kit", "migrate"], {
  cwd: dbDir,
  stdio: "inherit",
  // drizzle.config.js reads DIRECT_DATABASE_URL, and loadEnvFile does not clobber a variable
  // already set — so this wins over the production value in .env.local.
  env: { ...process.env, DIRECT_DATABASE_URL: url },
});
process.exit(result.status ?? 1);
