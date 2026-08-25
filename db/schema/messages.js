// Transport record — proof of what text actually went over the wire. Distinct from `offers`,
// which records the scheduling fact that an offer was made: one message may carry several
// offers, and a Phase 1a offer is made with no message sent at all. When both exist, an
// outbound offer message writes a row in each.
//
// The table ships empty. Including it now is cheaper than adding it later; nothing writes to
// it until SMS (Phase 1b).
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { trainers } from "./tenancy.js";
import { students } from "./students.js";
import { bookings } from "./bookings.js";
import { messageChannel, messageDirection } from "./enums.js";

export const messageLog = pgTable(
  "message_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    trainerId: uuid()
      .notNull()
      .references(() => trainers.id, { onDelete: "cascade" }),
    // Null for trainer-only messages.
    studentId: uuid().references(() => students.id, { onDelete: "set null" }),
    channel: messageChannel().notNull(),
    direction: messageDirection().notNull(),
    // `timestamp` in Section 8, renamed here: it collides with the column type's own name in
    // every SQL statement that touches it.
    sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    messageText: text().notNull(),
    relatedLessonId: uuid().references(() => bookings.id, { onDelete: "set null" }),
  },
  (t) => [
    index("message_log_student_idx").on(t.studentId, t.sentAt),
    index("message_log_trainer_idx").on(t.trainerId, t.sentAt),
  ],
);
