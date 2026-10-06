// Login is a phone number and a six-digit code, then a name (schema.md Section 4).
//
// Name-plus-phone was a defensible simplicity choice for one coach's roster. It stops being
// defensible when the platform is custodian of several barns' minor-rider data, guardian
// contacts and signed agreements, because a signature is worth exactly what the identity
// behind it is worth. What the replacement preserves: a code goes to the phone, and the
// screen then lists everyone attached to that number so the rider picks. A family sharing one
// phone still works with no extra design.
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { trainers } from "./tenancy.js";

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid().primaryKey().defaultRandom(),
    // E.164. One row per phone, globally — deliberately not tenant-scoped, because the point
    // of the identity is that a rider taking lessons from two coaches sees both after one
    // code, which is the case the original mechanism could not have handled at all.
    phone: text().notNull(),
    verifiedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("auth_identities_phone_key").on(t.phone)],
);

export const authCodes = pgTable(
  "auth_codes",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Keyed on the phone string, not on `auth_identities.id`: the first code a number ever
    // receives is sent before any identity exists for it.
    phone: text().notNull(),
    // Hashed, never the code itself.
    codeHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    // Single-use: set on redemption, so a code that worked once cannot work again.
    consumedAt: timestamp({ withTimezone: true }),
    // Rate limiting is per phone; this is the counter the limiter reads.
    attempts: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_codes_phone_idx").on(t.phone, t.expiresAt)],
);

// ---------------------------------------------------------------------------
// The COACH side
// ---------------------------------------------------------------------------
//
// Deliberately separate from the two tables above. Section 4 gives the rider side — a phone, a
// short code, single-use and rate-limited — and says only that coaches authenticate separately,
// "since a coach's account controls pricing and student records and should not share a mechanism
// with the rider side". Reusing `auth_codes` would have meant keying it on a generic identifier
// and giving both audiences one blast radius, which is the thing that sentence rules out.
//
// `trainers.email` is the identifier, as decided in SCHEMA-NOTES §5. No password column: a magic
// link needs no secret the coach has to remember, no reset flow, and nothing to leak in a dump.
//
// NEITHER TABLE IS TENANT-SCOPED, and that is not an oversight. Resolving identity is what
// PRODUCES the tenant, so a lookup that already required one could never run. They carry no RLS
// policy for the same reason, and they hold nothing worth scoping: a hash and an expiry.
export const trainerLoginTokens = pgTable(
  "trainer_login_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "cascade" }),
    // The SHA-256 of the token, never the token. A database dump, a log line or a backup
    // therefore contains nothing that can be used to log in — the raw value exists only in the
    // link that was sent, and only until it is used.
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    // Set the moment it is redeemed. Single use: a link forwarded, quoted in a reply, or sitting
    // in a mail archive is already spent.
    consumedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("trainer_login_tokens_hash_key").on(t.tokenHash),
    index("trainer_login_tokens_trainer_idx").on(t.trainerId, t.createdAt),
  ],
);

export const trainerSessions = pgTable(
  "trainer_sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "cascade" }),
    // Hashed for the same reason the login token is: what is stored cannot be replayed.
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    // Signing out sets this rather than deleting the row, so "this session ended" stays
    // distinguishable from "this session never existed" when something has to be explained.
    revokedAt: timestamp({ withTimezone: true }),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("trainer_sessions_hash_key").on(t.tokenHash),
    index("trainer_sessions_trainer_idx").on(t.trainerId, t.expiresAt),
  ],
);
