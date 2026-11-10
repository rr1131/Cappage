import { writeFileSync } from "node:fs";

// Run from the application root in Amplify's build phase. Never dump the
// environment: only these explicit keys are allowed into the SSR artifact.
const required = ["DATABASE_URL", "NEXT_PUBLIC_COGNITO_USER_POOL_ID", "NEXT_PUBLIC_COGNITO_CLIENT_ID"];
const optional = ["COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "ODDS_PROVIDER", "ODDS_API_KEY",
  "ODDS_REFRESH_SECONDS", "ODDS_FRESH_SECONDS", "ODDS_MAX_AGE_SECONDS", "ODDS_CREDIT_RESERVE",
  "ODDS_MONTHLY_CREDIT_CAP", "ODDS_DAILY_PAID_REFRESH_LIMIT", "ODDS_BILLING_ANCHOR"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required Amplify setting: ${key}`);
}
const lines = [...required, ...optional].flatMap((key) => {
  const value = process.env[key];
  if (!value) return [];
  // URLs must percent-encode reserved credential characters. Reject values
  // that could inject another dotenv entry; escape dotenv's dollar expansion.
  if (/[\r\n"\\]/.test(value) || value.includes("\u0000")) throw new Error(`Invalid characters in Amplify setting: ${key}`);
  return [`${key}="${value.replaceAll("$", "\\$")}"`];
});
writeFileSync(".env.production", `${lines.join("\n")}\n`, { mode: 0o600 });
