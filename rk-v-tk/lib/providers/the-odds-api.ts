import "server-only";

import { isAmericanOdds, nflSeasonYear, type Bookmaker, type Market, type ProviderGame,
  type ProviderQuota, type ProviderQuote, type ProviderSnapshot, type Selection } from "../domain/odds";
import { resolveTeam } from "../domain/nfl-teams";
import { easternWindowEnd } from "../domain/odds-window";
import type { OddsProvider } from "./odds-provider";
import { ProviderError } from "./provider-error";

type ObjectValue = Record<string, unknown>;
const SPORT = "americanfootball_nfl";
const MAX_RESPONSE_BYTES = 2_000_000;

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts.map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 500) throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  return value;
}

function parseGame(value: unknown, now: Date, warnings: Set<string>): ProviderGame | null {
  if (!object(value) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)
    || typeof value.sport_key !== "string" || typeof value.home_team !== "string" || typeof value.away_team !== "string") {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }
  if (value.sport_key !== SPORT) { warnings.add("UNSUPPORTED_SPORT"); return null; }
  const startsAt = timestamp(value.commence_time);
  if (!startsAt) throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  const starts = new Date(startsAt);
  if (starts.getTime() <= now.getTime() || starts >= easternWindowEnd(now, 14)) return null;
  const home = resolveTeam(value.home_team);
  const away = resolveTeam(value.away_team);
  if (!home || !away || home.id === away.id) { warnings.add("UNMAPPED_TEAM"); return null; }
  return { providerEventId: value.id, homeTeamId: home.id, awayTeamId: away.id,
    startsAt, status: "scheduled", seasonYear: nflSeasonYear(starts), seasonSource: "derived" };
}

function parseMarket(raw: ObjectValue, bookmaker: Bookmaker, fallbackTimestamp: unknown,
  game: ProviderGame, now: Date, warnings: Set<string>): ProviderQuote[] {
  if (raw.key !== "h2h" && raw.key !== "spreads" && raw.key !== "totals") return [];
  const market: Market = raw.key;
  const updatedAt = timestamp(raw.last_update === undefined ? fallbackTimestamp : raw.last_update);
  if (!updatedAt || Date.parse(updatedAt) > now.getTime()) {
    warnings.add("INVALID_MARKET_TIMESTAMP"); return [];
  }
  if (!Array.isArray(raw.outcomes) || raw.outcomes.length !== 2) {
    warnings.add("INCOMPLETE_MARKET"); return [];
  }
  const results: ProviderQuote[] = [];
  for (const outcome of raw.outcomes) {
    if (!object(outcome) || !isAmericanOdds(outcome.price)) {
      warnings.add("INVALID_OUTCOME"); return [];
    }
    let selection: Selection;
    if (market === "totals") {
      if (outcome.name !== "Over" && outcome.name !== "Under") { warnings.add("INVALID_OUTCOME"); return []; }
      selection = outcome.name === "Over" ? "over" : "under";
    } else {
      const team = resolveTeam(outcome.name);
      if (team?.id === game.homeTeamId) selection = "home";
      else if (team?.id === game.awayTeamId) selection = "away";
      else { warnings.add("INVALID_OUTCOME"); return []; }
    }
    let point: number | null = null;
    if (market !== "h2h") {
      if (typeof outcome.point !== "number" || !Number.isFinite(outcome.point)
        || Math.abs(outcome.point) > 1000 || (market === "totals" && outcome.point <= 0)
        || Math.abs(outcome.point * 100 - Math.round(outcome.point * 100)) > 1e-7) {
        warnings.add("INVALID_POINT"); return [];
      }
      point = outcome.point === 0 ? 0 : outcome.point;
    } else if (outcome.point != null) { warnings.add("INVALID_POINT"); return []; }
    results.push({ providerEventId: game.providerEventId, bookmaker, market, selection,
      point, americanOdds: outcome.price, providerUpdatedAt: updatedAt });
  }
  if (results[0].selection === results[1].selection
    || (market === "spreads" && Math.abs(results[0].point! + results[1].point!) > 1e-7)
    || (market === "totals" && results[0].point !== results[1].point)) {
    warnings.add("AMBIGUOUS_MARKET"); return [];
  }
  return results;
}

/** The rest of the app never sees the vendor's JSON shape. Missing markets are
 * represented by absent quotes, never fabricated values or another book's line. */
export function normalizeTheOddsApiResponse(eventsPayload: unknown, oddsPayload: unknown,
  now: Date, quota: ProviderQuota = { remaining: null, used: null, lastCost: null }): ProviderSnapshot {
  if (!Number.isFinite(now.getTime())) throw new ProviderError("PROVIDER_CONFIGURATION");
  const events = list(eventsPayload);
  const odds = list(oddsPayload);
  const games = new Map<string, ProviderGame>();
  const warnings = new Set<string>();
  const addGame = (game: ProviderGame) => {
    const existing = games.get(game.providerEventId);
    if (existing && (existing.homeTeamId !== game.homeTeamId || existing.awayTeamId !== game.awayTeamId)) {
      throw new ProviderError("PROVIDER_INVALID_RESPONSE");
    }
    games.set(game.providerEventId, game);
  };
  for (const event of events) {
    const game = parseGame(event, now, warnings);
    if (game) addGame(game);
  }
  const marketQuotes = new Map<string, ProviderQuote[]>();
  const ambiguousKeys = new Set<string>();
  for (const event of odds) {
    const game = parseGame(event, now, warnings);
    if (!game || !object(event)) {
      // The later odds response may know that kickoff moved earlier. Do not
      // retain a pregame schedule from the preceding /events response.
      if (object(event) && typeof event.id === "string") games.delete(event.id);
      continue;
    }
    addGame(game);
    if (!Array.isArray(event.bookmakers)) throw new ProviderError("PROVIDER_INVALID_RESPONSE");
    for (const book of event.bookmakers) {
      if (!object(book) || (book.key !== "draftkings" && book.key !== "fanduel")) continue;
      if (!Array.isArray(book.markets)) { warnings.add("INCOMPLETE_BOOKMAKER"); continue; }
      for (const market of book.markets) {
        if (!object(market)) { warnings.add("INVALID_MARKET"); continue; }
        const parsed = parseMarket(market, book.key, book.last_update, game, now, warnings);
        if (!parsed.length) continue;
        const key = `${game.providerEventId}:${book.key}:${parsed[0].market}`;
        if (ambiguousKeys.has(key)) continue;
        const previous = marketQuotes.get(key);
        if (!previous || previous[0].providerUpdatedAt < parsed[0].providerUpdatedAt) {
          marketQuotes.set(key, parsed);
        } else if (previous[0].providerUpdatedAt === parsed[0].providerUpdatedAt) {
          const comparable = (quotes: ProviderQuote[]) => JSON.stringify([...quotes].sort((a, b) => a.selection.localeCompare(b.selection)));
          if (comparable(previous) !== comparable(parsed)) {
            warnings.add("AMBIGUOUS_MARKET");
            ambiguousKeys.add(key);
            marketQuotes.delete(key);
          }
        }
      }
    }
  }
  return { games: [...games.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.providerEventId.localeCompare(b.providerEventId)),
    quotes: [...marketQuotes.values()].flat().filter((quote) => games.has(quote.providerEventId)),
    fetchedAt: now.toISOString(), quota, warnings: [...warnings].sort() };
}

function quotaFrom(headers: Headers): ProviderQuota {
  const read = (name: string) => {
    const raw = headers.get(name);
    if (!raw || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  };
  return { remaining: read("x-requests-remaining"), used: read("x-requests-used"), lastCost: read("x-requests-last") };
}

function retryAfter(headers: Headers, now: Date): number {
  const raw = headers.get("retry-after");
  const seconds = raw && /^\d+$/.test(raw) ? Number(raw)
    : raw ? Math.ceil((Date.parse(raw) - now.getTime()) / 1000) : 60;
  return Number.isFinite(seconds) ? Math.min(86_400, Math.max(1, seconds)) : 60;
}

export class TheOddsApiProvider implements OddsProvider {
  readonly name = "the-odds-api" as const;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly creditReserve: number;

  constructor(options: { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number; creditReserve?: number } = {}) {
    if (!options.apiKey?.trim()) throw new ProviderError("PROVIDER_CONFIGURATION");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.creditReserve = options.creditReserve ?? 25;
    if (!Number.isSafeInteger(this.creditReserve) || this.creditReserve < 0
      || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new ProviderError("PROVIDER_CONFIGURATION");
    }
  }

  private async request(path: "events" | "odds", now: Date): Promise<{ data: unknown; quota: ProviderQuota }> {
    const url = new URL(`https://api.the-odds-api.com/v4/sports/${SPORT}/${path}`);
    url.searchParams.set("apiKey", this.apiKey);
    url.searchParams.set("dateFormat", "iso");
    url.searchParams.set("commenceTimeFrom", now.toISOString());
    url.searchParams.set("commenceTimeTo", new Date(easternWindowEnd(now, 14).getTime() - 1).toISOString());
    if (path === "odds") {
      url.searchParams.set("bookmakers", "draftkings,fanduel");
      url.searchParams.set("markets", "h2h,spreads,totals");
      url.searchParams.set("oddsFormat", "american");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { cache: "no-store", redirect: "error", signal: controller.signal });
      if (response.status === 429) throw new ProviderError("PROVIDER_RATE_LIMITED", retryAfter(response.headers, now));
      if ([400, 401, 403, 404].includes(response.status)) throw new ProviderError("PROVIDER_CONFIGURATION");
      if (!response.ok) throw new ProviderError("PROVIDER_UNAVAILABLE");
      const declaredSize = Number(response.headers.get("content-length"));
      if (declaredSize > MAX_RESPONSE_BYTES) throw new ProviderError("PROVIDER_INVALID_RESPONSE");
      const reader = response.body?.getReader();
      if (!reader) throw new ProviderError("PROVIDER_INVALID_RESPONSE");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ProviderError("PROVIDER_INVALID_RESPONSE");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      return { data, quota: quotaFrom(response.headers) };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof SyntaxError) throw new ProviderError("PROVIDER_INVALID_RESPONSE");
      throw new ProviderError("PROVIDER_UNAVAILABLE");
    } finally { clearTimeout(timer); }
  }

  async fetchSnapshot(now: Date): Promise<ProviderSnapshot> {
    if (!Number.isFinite(now.getTime())) throw new ProviderError("PROVIDER_CONFIGURATION");
    const events = await this.request("events", now);
    const schedule = normalizeTheOddsApiResponse(events.data, [], now, events.quota);
    if (schedule.games.length === 0) return schedule;
    // The free endpoint supplies current account quota, so exhaustion can recover
    // when the provider billing period resets. No paid request with unknown quota.
    if (events.quota.remaining === null) throw new ProviderError("PROVIDER_INVALID_RESPONSE");
    if (events.quota.remaining < this.creditReserve + 3) throw new ProviderError("PROVIDER_QUOTA_EXHAUSTED");
    const odds = await this.request("odds", now);
    return normalizeTheOddsApiResponse(events.data, odds.data, now, odds.quota);
  }
}
