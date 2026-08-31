// Connections that CANNOT bypass row-level security.
//
// Everything else in db/test/ connects as the owner, which on Neon carries BYPASSRLS and is
// therefore the one role for which every policy is inert. That is correct for seeding and
// truncating — they legitimately write across tenants — but it means the owner connection can
// prove nothing about isolation. These helpers open a connection as `rydeahorse_app`, which
// owns nothing and has no BYPASSRLS, so a query on it is subject to policy whether or not the
// author knew RLS existed.
//
// The password is rotated to a random value in memory at setup, as the owner, and never
// written anywhere. A test-only credential committed to a file is a credential that outlives
// the test, and the repository already refuses to keep one.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { resolveTestDatabaseUrl } from "./guard.js";

export const APP_ROLE = "rydeahorse_app";

/**
 * Give the application role a fresh random password and return it.
 * @param ownerClient a connection as the owner (the only role that may ALTER ROLE)
 */
export async function rotateAppPassword(ownerClient) {
  // base64url is [A-Za-z0-9_-], but the statement is still assembled with format(%L) rather
  // than interpolated — ALTER ROLE ... PASSWORD cannot take a bind parameter, and "the value
  // happens to be safe today" is not a rule that survives someone changing the generator.
  const password = randomBytes(24).toString("base64url");
  const { rows } = await ownerClient.query(
    "select format('alter role %I with login password %L', $1::text, $2::text) as sql",
    [APP_ROLE, password],
  );
  await ownerClient.query(rows[0].sql);
  return password;
}

/** The guarded test URL, rewritten to connect as the application role. */
export function appUrl(password, { pooled = false } = {}) {
  const url = new URL(resolveTestDatabaseUrl());
  url.username = APP_ROLE;
  url.password = password;
  if (pooled) {
    // Neon exposes one endpoint twice: `ep-x-123` direct and `ep-x-123-pooler` through
    // PgBouncer. Same database, different connection semantics — which is the entire point of
    // the pooler suite.
    const [first, ...rest] = url.hostname.split(".");
    if (!first.endsWith("-pooler")) url.hostname = [`${first}-pooler`, ...rest].join(".");
  }
  return url.toString();
}

/** Open a connection as the application role. Refuses production via resolveTestDatabaseUrl. */
export async function connectAsApp(password, opts) {
  const client = new Client({ connectionString: appUrl(password, opts) });
  await client.connect();
  return client;
}
