import "server-only";

import { nflSeasonYear, type ProviderGame, type ProviderQuote, type ProviderSnapshot } from "../domain/odds";
import { easternWindowEnd } from "../domain/odds-window";
import type { OddsProvider } from "./odds-provider";

export class MockOddsProvider implements OddsProvider {
  readonly name = "mock" as const;

  async fetchSnapshot(now: Date): Promise<ProviderSnapshot> {
    const week = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    week.setUTCDate(week.getUTCDate() - (week.getUTCDay() + 6) % 7);
    const updatedAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
    const games: ProviderGame[] = [];
    const quotes: ProviderQuote[] = [];
    const fixtures = [
      { day: 4, hour: 1, minute: 15, home: "nfl:phi", away: "nfl:dal" },
      { day: 6, hour: 18, minute: 0, home: "nfl:buf", away: "nfl:kc" },
      { day: 7, hour: 1, minute: 20, home: "nfl:sf", away: "nfl:sea" },
    ];
    for (const offset of [0, 7]) {
      for (const [index, fixture] of fixtures.entries()) {
        const starts = new Date(week);
        starts.setUTCDate(starts.getUTCDate() + offset + fixture.day);
        starts.setUTCHours(fixture.hour, fixture.minute);
        if (starts.getTime() <= now.getTime() || starts >= easternWindowEnd(now, 14)) continue;
        const providerEventId = `mock-${starts.toISOString().slice(0, 10)}-${fixture.home.slice(4)}-${fixture.away.slice(4)}`;
        games.push({ providerEventId, homeTeamId: fixture.home, awayTeamId: fixture.away,
          startsAt: starts.toISOString(), status: "scheduled", seasonYear: nflSeasonYear(starts), seasonSource: "derived" });
        for (const bookmaker of ["draftkings", "fanduel"] as const) {
          const adjustment = bookmaker === "fanduel" ? 5 : 0;
          for (const selection of ["home", "away"] as const) {
            quotes.push({ providerEventId, bookmaker, market: "h2h", selection, point: null,
              americanOdds: selection === "home" ? -145 - adjustment : 125 + adjustment, providerUpdatedAt: updatedAt });
            quotes.push({ providerEventId, bookmaker, market: "spreads", selection,
              point: selection === "home" ? -3.5 : 3.5, americanOdds: -110 + adjustment, providerUpdatedAt: updatedAt });
          }
          // A deliberate missing market exercises the real empty-data UI.
          if (index === 1 && bookmaker === "fanduel") continue;
          for (const selection of ["over", "under"] as const) {
            quotes.push({ providerEventId, bookmaker, market: "totals", selection, point: 47.5,
              americanOdds: -110 + adjustment, providerUpdatedAt: updatedAt });
          }
        }
      }
    }
    return { games: games.sort((a, b) => a.startsAt.localeCompare(b.startsAt)), quotes,
      fetchedAt: now.toISOString(), quota: { remaining: null, used: null, lastCost: null }, warnings: [] };
  }
}
