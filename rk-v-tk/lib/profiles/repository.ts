import "server-only";

import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import { users, type User } from "../db/schema";
import { ProfileError, type Profile, type ProfileInput } from "../domain/profile";

type Database = Pick<PgDatabase<PgQueryResultHKT, typeof schema>, "select" | "insert">;

export function serializeProfile(user: User): Profile {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export function profileRepository(db: Database) {
  async function findBySubject(subject: string): Promise<Profile | null> {
    const [user] = await db.select().from(users).where(eq(users.cognitoSub, subject)).limit(1);
    return user ? serializeProfile(user) : null;
  }

  async function create(subject: string, input: ProfileInput) {
    const existing = await findBySubject(subject);
    if (existing) return { profile: existing, created: false };

    // Both unique constraints arbitrate concurrent registrations. Never update
    // the winning row: retries must not change the username or timestamps.
    const [inserted] = await db.insert(users).values({ cognitoSub: subject, ...input })
      .onConflictDoNothing().returning();
    if (inserted) return { profile: serializeProfile(inserted), created: true };

    // A separate READ COMMITTED statement sees a concurrent committed winner.
    // Avoid a single insert/select CTE, whose snapshot could miss that row.
    const winner = await findBySubject(subject);
    if (winner) return { profile: winner, created: false };
    throw new ProfileError("USERNAME_TAKEN", "That username is already taken.", 409);
  }

  return { findBySubject, create };
}
