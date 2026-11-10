import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  cognitoSub: text("cognito_sub").notNull().unique("users_cognito_sub_unique"),
  username: varchar("username", { length: 30 }).notNull().unique("users_username_unique"),
  displayName: varchar("display_name", { length: 80 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("users_username_format", sql`${table.username} ~ '^[a-z0-9_]{3,30}$'`),
  check("users_cognito_sub_nonempty", sql`length(trim(${table.cognitoSub})) > 0`),
]);

export type User = typeof users.$inferSelect;

export * from "./odds-schema";
