import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "../../lib/db/schema";

// Use a separate database per suite so committed migrations (including explicit
// public-schema foreign keys) run unchanged. Never use the application's URL.
export function disposablePostgres() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString || !new URL(connectionString).pathname.endsWith("_test")) {
    throw new Error("Set TEST_DATABASE_URL to a disposable PostgreSQL database ending in _test.");
  }
  if (connectionString === process.env.DATABASE_URL) throw new Error("Test and application databases must be separate.");
  const name = `rkvtk_${randomUUID().replaceAll("-", "")}_test`;
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({ connectionString: url.toString(), max: 12 });
  const queries: string[] = [];
  const db = drizzle(pool, { schema, logger: { logQuery(query) { queries.push(query); } } });
  let created = false;
  return {
    pool, db, queries, connectionString: url.toString(),
    async initialize() {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      await migrate(db, { migrationsFolder: "./drizzle" });
      queries.length = 0;
    },
    async close() {
      await pool.end();
      try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
      finally { await admin.end(); }
    },
    async captureMutations(tables: string[]) {
      if (tables.some((name) => !/^[a-z_]+$/.test(name))) throw new Error("Invalid audit table name");
      await pool.query(`CREATE TABLE test_row_mutations (table_name text NOT NULL, operation text NOT NULL)`);
      await pool.query(`CREATE FUNCTION test_count_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO test_row_mutations VALUES (TG_TABLE_NAME, TG_OP);
          RETURN NULL;
        END;
      $$`);
      for (const table of tables) await pool.query(`CREATE TRIGGER test_count_mutation AFTER INSERT OR UPDATE OR DELETE ON "${table}"
        FOR EACH ROW EXECUTE FUNCTION test_count_mutation()`);
    },
  };
}
