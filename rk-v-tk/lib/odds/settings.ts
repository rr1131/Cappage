import "server-only";

export type OddsSettings = { refreshSeconds: number; freshSeconds: number; maxAgeSeconds: number; creditReserve: number };

function setting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`Invalid setting: ${name}`);
  return Number(raw);
}

export function oddsSettings(): OddsSettings {
  const result = {
    refreshSeconds: setting("ODDS_REFRESH_SECONDS", 21_600, 60, 86_400),
    freshSeconds: setting("ODDS_FRESH_SECONDS", 300, 30, 3_600),
    maxAgeSeconds: setting("ODDS_MAX_AGE_SECONDS", 86_400, 300, 86_400),
    creditReserve: setting("ODDS_CREDIT_RESERVE", 25, 0, 1_000_000),
  };
  if (result.freshSeconds > result.maxAgeSeconds) throw new Error("Freshness must not exceed maximum quote age");
  return result;
}
