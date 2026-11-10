import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/write-amplify-env.mjs", import.meta.url));
const nextEnv = createRequire(import.meta.url).resolve("@next/env");
const settings = {
  NODE_ENV: "production" as const,
  DATABASE_URL: "postgresql://user:literal$PASSWORD@db.example/app?sslmode=require",
  NEXT_PUBLIC_COGNITO_USER_POOL_ID: "us-east-1_TestPool",
  NEXT_PUBLIC_COGNITO_CLIENT_ID: "test-client",
  UNRELATED_SECRET: "must-not-export",
};
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "rkvtk-env-test-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe("Amplify runtime environment export", () => {
  it("exports only the allowed values and preserves literal dollars through Next's dotenv loader", () => {
    const output = execFileSync(process.execPath, [script], { cwd: directory, env: settings, encoding: "utf8" });
    expect(output).toBe("");
    expect(readFileSync(join(directory, ".env.production"), "utf8")).not.toContain("UNRELATED_SECRET");
    const loaded = execFileSync(process.execPath, ["-e",
      "require(process.argv[1]).loadEnvConfig(process.cwd(), false); process.stdout.write(process.env.DATABASE_URL)", nextEnv,
    ], { cwd: directory, env: { NODE_ENV: "production" }, encoding: "utf8" });
    expect(loaded).toBe(settings.DATABASE_URL);
  });
  it("fails before writing when required settings are absent", () => {
    expect(() => execFileSync(process.execPath, [script], { cwd: directory, env: { NODE_ENV: "production" }, stdio: "pipe" })).toThrow();
    expect(existsSync(join(directory, ".env.production"))).toBe(false);
  });
  it("rejects newline injection without echoing the secret value", () => {
    try {
      execFileSync(process.execPath, [script], {
        cwd: directory, env: { ...settings, DATABASE_URL: "secret\nNEXT_PUBLIC_LEAK=secret" }, stdio: "pipe",
      });
      expect.fail("Expected invalid setting to fail");
    } catch (error) {
      expect(String((error as { stderr: Buffer }).stderr)).not.toContain("NEXT_PUBLIC_LEAK");
      expect(existsSync(join(directory, ".env.production"))).toBe(false);
    }
  });
});
