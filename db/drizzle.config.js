// drizzle-kit reads this to generate SQL. `generate` never opens a connection — the
// dbCredentials below exist only so `drizzle-kit check`/`push` have somewhere to point when
// there eventually is a database. Nothing in this repo connects yet.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

// The connection string lives in .env.local at the REPO ROOT, one level up, but the npm
// scripts here run with db/ as cwd — so drizzle-kit's own dotenv lookup would miss it. Resolve
// from this file's directory rather than cwd, so `npm run check` works from either place.
//
// Guarded because `generate` must keep working on a checkout that has no .env.local at all
// (loadEnvFile throws ENOENT); it only reads the schema files.
//
// A DIRECT_DATABASE_URL already set in the shell wins — loadEnvFile does not clobber existing
// vars — so a one-off `DIRECT_DATABASE_URL=... npm run migrate` still points where you tell it
// to. That is also how you migrate the test branch: point it at TEST_DATABASE_URL's value.
//
// fileURLToPath(import.meta.url), NOT import.meta.dirname: drizzle-kit transpiles this config
// through esbuild before running it, and dirname comes out undefined there — join() then throws
// "The path argument must be of type string" and every command dies. import.meta.url survives.
const envLocal = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
if (existsSync(envLocal)) process.loadEnvFile(envLocal);

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema/*.js",
  out: "./migrations",
  casing: "snake_case",
  dbCredentials: {
    // DIRECT_DATABASE_URL, never DATABASE_URL. DATABASE_URL is Neon's *pooled* endpoint
    // (the `-pooler` host) — PgBouncer in transaction mode, which is right for the app's
    // many short-lived connections and wrong for every migration. Transaction-mode pooling
    // hands the underlying connection to another client between statements, so a migration
    // loses the session that `CREATE EXTENSION`, `CREATE TYPE ... AS RANGE` and drizzle's
    // own advisory lock depend on. 0001 does all three. Migrations run unpooled.
    url: process.env.DIRECT_DATABASE_URL ?? "postgres://localhost:5432/rydeahorse",
  },
});
