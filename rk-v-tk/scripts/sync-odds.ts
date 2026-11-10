import { loadEnvConfig } from "@next/env";
import { withDatabase } from "../lib/db/client";
import { createOddsProvider } from "../lib/providers/odds-provider";
import { oddsRepository } from "../lib/odds/repository";
import { oddsSettings } from "../lib/odds/settings";
import { syncOdds } from "../lib/odds/sync";
import { OddsError } from "../lib/odds/errors";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

async function main() {
  try {
    const settings = oddsSettings();
    const provider = createOddsProvider();
    const result = await withDatabase((db) => syncOdds(provider, oddsRepository(db, settings)));
    console.log(JSON.stringify({ provider: provider.name, ...result }));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof OddsError ? error.code : "SYNC_CONFIGURATION_OR_CONNECTION_FAILED" }));
    process.exitCode = 1;
  }
}
void main();
