import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { profileRepository } from "../../lib/profiles/repository";
import { profileHandlers } from "../../lib/profiles/http";
import * as schema from "../../lib/db/schema";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !new URL(connectionString).pathname.endsWith("_test")) {
  throw new Error("Set TEST_DATABASE_URL to a separate PostgreSQL database with a name ending in _test. Integration tests never use DATABASE_URL.");
}
if (connectionString === process.env.DATABASE_URL) throw new Error("Test and application databases must be separate.");

const testSchema = `profile_test_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString, max: 1 });
const pool = new Pool({ connectionString, max: 12, options: `-c search_path=${testSchema}` });
let db: NodePgDatabase<typeof schema>;
let repository: ReturnType<typeof profileRepository>;

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${testSchema}"`);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "./drizzle", migrationsSchema: testSchema });
  repository = profileRepository(db);
});
beforeEach(async () => { await pool.query('TRUNCATE TABLE "users"'); });
afterAll(async () => {
  await pool.end();
  try { await admin.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`); }
  finally { await admin.end(); }
});

describe("PostgreSQL profile persistence", () => {
  it("persists generated IDs and UTC timestamps across connections", async () => {
    const result = await repository.create("subject-a", { username: "rod", displayName: null });
    expect(result.created).toBe(true);
    expect(result.profile.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.profile.createdAt).toMatch(/Z$/);
    expect(result.profile.updatedAt).toBe(result.profile.createdAt);
    const fresh = new Pool({ connectionString, options: `-c search_path=${testSchema}` });
    try {
      expect(await profileRepository(drizzle(fresh, { schema })).findBySubject("subject-a")).toEqual(result.profile);
    } finally { await fresh.end(); }
  });

  it("returns an existing profile without overwriting it", async () => {
    const first = await repository.create("subject-a", { username: "rod", displayName: "Rod" });
    const repeat = await repository.create("subject-a", { username: "new_name", displayName: "Changed" });
    expect(repeat).toEqual({ created: false, profile: first.profile });
  });

  it("creates one row under simultaneous duplicate registration", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      repository.create("subject-a", { username: "rod", displayName: null })));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.profile.id)).size).toBe(1);
    expect((await pool.query('SELECT * FROM "users"')).rowCount).toBe(1);
  });

  it("preserves the winner when one subject races different usernames", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      repository.create("subject-a", { username: `name_${i}`, displayName: null })));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.profile.username)).size).toBe(1);
    expect((await pool.query('SELECT * FROM "users"')).rowCount).toBe(1);
  });

  it("allows only one subject to claim a username concurrently", async () => {
    const results = await Promise.allSettled(["subject-a", "subject-b"].map((subject) =>
      repository.create(subject, { username: "shared", displayName: null })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "USERNAME_TAKEN", status: 409 });
    expect((await pool.query('SELECT * FROM "users"')).rowCount).toBe(1);
  });

  it("enforces both unique constraints even for direct SQL", async () => {
    await repository.create("subject-a", { username: "rod", displayName: null });
    await expect(pool.query("INSERT INTO users (cognito_sub, username) VALUES ($1, $2)", ["subject-a", "different"]))
      .rejects.toMatchObject({ code: "23505", constraint: "users_cognito_sub_unique" });
    await expect(pool.query("INSERT INTO users (cognito_sub, username) VALUES ($1, $2)", ["subject-b", "rod"]))
      .rejects.toMatchObject({ code: "23505", constraint: "users_username_unique" });
    await expect(pool.query("INSERT INTO users (cognito_sub, username) VALUES ($1, $2)", ["subject-b", "Rod"]))
      .rejects.toMatchObject({ code: "23514", constraint: "users_username_format" });
  });

  it("updates updated_at at the database layer without changing created_at", async () => {
    await pool.query("INSERT INTO users (cognito_sub, username, created_at, updated_at) VALUES ($1, $2, $3, $3)",
      ["subject-a", "rod", "2000-01-01T00:00:00Z"]);
    const initial = (await repository.findBySubject("subject-a"))!;
    await pool.query("UPDATE users SET display_name = $1 WHERE cognito_sub = $2", ["Rod", "subject-a"]);
    const updated = await repository.findBySubject("subject-a");
    expect(updated?.createdAt).toBe(initial.createdAt);
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThan(Date.parse(initial.updatedAt));
    expect(updated?.displayName).toBe("Rod");
  });

  it("isolates accounts through the HTTP handlers and normalizes username collisions", async () => {
    const forSubject = (subject: string) => profileHandlers({
      authenticate: async () => subject,
      find: repository.findBySubject,
      create: repository.create,
    });
    const post = (body: unknown) => new Request("http://localhost/api/me", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const a = forSubject("subject-a");
    const b = forSubject("subject-b");
    expect((await a.POST(post({ username: "Rod" }))).status).toBe(201);
    expect((await b.POST(post({ username: "ROD" }))).status).toBe(409);
    expect((await b.POST(post({ username: "tk_", displayName: "TK" }))).status).toBe(201);
    expect((await b.POST(post({ username: "rod", userId: "subject-a" }))).status).toBe(422);
    const own = await (await b.GET(new Request("http://localhost/api/me?userId=subject-a"))).json();
    expect(own.profile.username).toBe("tk_");
    expect(own.profile).not.toHaveProperty("cognitoSub");
    expect((await repository.findBySubject("subject-a"))?.username).toBe("rod");
  });

  it("can reapply the migration runner without changing stored profiles", async () => {
    const first = await repository.create("subject-a", { username: "rod", displayName: null });
    await migrate(db, { migrationsFolder: "./drizzle", migrationsSchema: testSchema });
    expect(await repository.findBySubject("subject-a")).toEqual(first.profile);
  });
});
