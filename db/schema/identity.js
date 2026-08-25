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
