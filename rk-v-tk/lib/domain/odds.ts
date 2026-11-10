export const BOOKMAKERS = ["draftkings", "fanduel"] as const;
export const MARKETS = ["h2h", "spreads", "totals"] as const;
export const SELECTIONS = ["home", "away", "over", "under"] as const;

export type ProviderName = "mock" | "the-odds-api";
export type Bookmaker = typeof BOOKMAKERS[number];
export type Market = typeof MARKETS[number];
export type Selection = typeof SELECTIONS[number];

export type ProviderGame = {
  providerEventId: string;
  homeTeamId: string;
  awayTeamId: string;
  startsAt: string;
  status: "scheduled";
  seasonYear: number;
  seasonSource: "derived";
};

export type ProviderQuote = {
  providerEventId: string;
  bookmaker: Bookmaker;
  market: Market;
  selection: Selection;
  point: number | null;
  americanOdds: number;
  providerUpdatedAt: string;
};

export type ProviderQuota = {
  remaining: number | null;
  used: number | null;
  lastCost: number | null;
};

export type ProviderSnapshot = {
  games: ProviderGame[];
  quotes: ProviderQuote[];
  fetchedAt: string;
  quota: ProviderQuota;
  warnings: string[];
};

export function isAmericanOdds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && Math.abs(value) >= 100 && Math.abs(value) <= 1_000_000;
}

// Display conversion only. Future wager arithmetic must use its own exact
// payout representation rather than rounded display decimals.
export function americanToDecimal(value: number): number {
  if (!isAmericanOdds(value)) throw new RangeError("Invalid American odds");
  const decimal = value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
  return Math.round(decimal * 1_000_000) / 1_000_000;
}

export function nflSeasonYear(startsAt: Date): number {
  // Jan/Feb postseason belongs to the previous season. The odds feed does not
  // supply an authoritative season phase or week, so neither is invented.
  return startsAt.getUTCFullYear() - (startsAt.getUTCMonth() < 2 ? 1 : 0);
}
