import "server-only";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import WebSocket from "ws";
import * as schema from "./schema";

neonConfig.webSocketConstructor = WebSocket;

// A serverless request owns its connections; no sockets survive the request.
// Resolve configuration lazily so importing a route during build needs no secrets.
export async function withDatabase<T>(work: (db: NeonDatabase<typeof schema>) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");

  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    return await work(drizzle(pool, { schema }));
  } finally {
    await pool.end();
  }
}
