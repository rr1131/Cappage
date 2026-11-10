import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";

loadEnvConfig(process.cwd());

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Generation works offline; migrate requires DATABASE_URL in the environment.
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
});
