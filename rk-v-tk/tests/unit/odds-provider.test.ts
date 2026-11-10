import { afterEach, describe, expect, it, vi } from "vitest";
import { americanToDecimal, nflSeasonYear } from "../../lib/domain/odds";
import { NFL_TEAMS, resolveTeam } from "../../lib/domain/nfl-teams";
import { configuredProviderName, createOddsProvider, type PaidRequestGuard } from "../../lib/providers/odds-provider";
import { MockOddsProvider } from "../../lib/providers/mock-odds-provider";
import { normalizeTheOddsApiResponse, TheOddsApiProvider } from "../../lib/providers/the-odds-api";

const now = new Date("2026-11-10T12:00:00Z");
const marketTime = "2026-11-10T11:59:00Z";
const game = {
  id: "event-one", sport_key: "americanfootball_nfl", commence_time: "2026-11-15T18:00:00Z",
  home_team: "Buffalo Bills", away_team: "Kansas City Chiefs",
};
const markets = () => [
  { key: "h2h", last_update: marketTime,
    outcomes: [{ name: "Kansas City Chiefs", price: 130 }, { name: "Buffalo Bills", price: -150 }] },
  { key: "spreads", last_update: marketTime,
    outcomes: [{ name: "Kansas City Chiefs", price: -105, point: 3.5 }, { name: "Buffalo Bills", price: -115, point: -3.5 }] },
  { key: "totals", last_update: marketTime,
    outcomes: [{ name: "Under", price: -110, point: 47.5 }, { name: "Over", price: -110, point: 47.5 }] },
];
function oddsEvent() {
  return { ...game, bookmakers: [
    { key: "draftkings", last_update: "2026-11-10T11:59:59Z", markets: markets() },
    { key: "fanduel", last_update: "2026-11-10T11:59:59Z", markets: markets().slice(0, 2) },
  ] };
}
const headers = { "x-requests-remaining": "400", "x-requests-used": "100", "x-requests-last": "3" };
const response = (data: unknown, customHeaders: Record<string, string> = headers) => Response.json(data, { headers: customHeaders });
const paidGuard = (): PaidRequestGuard => ({
  beforePaidRequest: vi.fn().mockResolvedValue(undefined),
  afterPaidResponse: vi.fn().mockResolvedValue(undefined),
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("odds domain", () => {
  it.each([[100, 2], [-100, 2], [150, 2.5], [-200, 1.5], [-110, 1.909091]])(
    "converts American %s to decimal %s", (input, expected) => expect(americanToDecimal(input)).toBe(expected),
  );
  it.each([0, 99, -99, 100.5, NaN, Infinity, -Infinity, 1_000_001])("rejects invalid odds %s", (value) => {
    expect(() => americanToDecimal(value)).toThrow(RangeError);
  });
  it("uses stable team IDs and explicit aliases", () => {
    expect(Object.keys(NFL_TEAMS)).toHaveLength(32);
    expect(resolveTeam("Buffalo Bills")?.id).toBe("nfl:buf");
    expect(resolveTeam("LA Rams")?.id).toBe("nfl:lar");
    expect(resolveTeam("nfl:kc")?.name).toBe("Kansas City Chiefs");
    expect(resolveTeam("Kansas City")?.id).toBeUndefined();
    expect(resolveTeam("fake team")).toBeNull();
    expect(resolveTeam("constructor")).toBeNull();
    expect(resolveTeam("__proto__")).toBeNull();
  });
  it("attributes January/February to the preceding season", () => {
    expect(nflSeasonYear(new Date("2027-02-07T23:30:00Z"))).toBe(2026);
    expect(nflSeasonYear(new Date("2026-09-08T00:00:00Z"))).toBe(2026);
  });
});

describe("The Odds API normalization", () => {
  it("maps identity and outcome roles independently of array order", () => {
    const result = normalizeTheOddsApiResponse([game], [oddsEvent()], now);
    expect(result.games).toEqual([{ providerEventId: game.id, homeTeamId: "nfl:buf", awayTeamId: "nfl:kc",
      startsAt: "2026-11-15T18:00:00.000Z", status: "scheduled", seasonYear: 2026, seasonSource: "derived" }]);
    expect(result.quotes).toHaveLength(10);
    expect(result.quotes.find((q) => q.market === "h2h" && q.selection === "home"))
      .toMatchObject({ americanOdds: -150, point: null });
    expect(result.quotes.find((q) => q.market === "spreads" && q.selection === "away"))
      .toMatchObject({ point: 3.5, americanOdds: -105 });
    expect(result.quotes.find((q) => q.market === "spreads" && q.selection === "home"))
      .toMatchObject({ point: -3.5, americanOdds: -115 });
    expect(result.quotes.filter((q) => q.market === "totals").map((q) => q.selection).sort()).toEqual(["over", "under"]);
  });
  it("preserves missing sportsbook markets and absent books", () => {
    const event = oddsEvent();
    const result = normalizeTheOddsApiResponse([game], [event], now);
    expect(result.quotes.some((quote) => quote.bookmaker === "fanduel" && quote.market === "totals")).toBe(false);
    event.bookmakers = [];
    expect(normalizeTheOddsApiResponse([game], [event], now).quotes).toEqual([]);
  });
  it("keeps provider age separate from ingestion time and prefers market timestamps", () => {
    const first = normalizeTheOddsApiResponse([game], [oddsEvent()], now);
    const later = normalizeTheOddsApiResponse([game], [oddsEvent()], new Date("2026-11-10T14:00:00Z"));
    expect(first.quotes[0].providerUpdatedAt).toBe("2026-11-10T11:59:00.000Z");
    expect(later.quotes[0].providerUpdatedAt).toBe(first.quotes[0].providerUpdatedAt);
    expect(later.fetchedAt).not.toBe(first.fetchedAt);
  });
  it("deduplicates events and quotes by provider identity", () => {
    const result = normalizeTheOddsApiResponse([game, game], [oddsEvent(), oddsEvent()], now);
    expect(result.games).toHaveLength(1);
    expect(result.quotes).toHaveLength(10);
  });
  it("omits started, out-of-window, non-NFL, and unmapped-team events", () => {
    const data = [
      { ...game, commence_time: now.toISOString() },
      { ...game, id: "far", commence_time: "2027-01-01T00:00:00Z" },
      { ...game, id: "nba", sport_key: "basketball_nba" },
      { ...game, id: "unknown", home_team: "Untrusted team name" },
    ];
    const result = normalizeTheOddsApiResponse(data, [], now);
    expect(result.games).toEqual([]);
    expect(result.warnings).toEqual(["UNMAPPED_TEAM", "UNSUPPORTED_SPORT"]);
    expect(JSON.stringify(result)).not.toContain("Untrusted team name");
  });
  it("removes pregame data if the later odds feed moves kickoff into the past", () => {
    const result = normalizeTheOddsApiResponse([game], [oddsEvent(), { ...oddsEvent(), commence_time: now.toISOString() }], now);
    expect(result.games).toEqual([]);
    expect(result.quotes).toEqual([]);
  });
  it("rejects malformed envelopes and conflicting event identities", () => {
    expect(() => normalizeTheOddsApiResponse({}, [], now)).toThrow("PROVIDER_INVALID_RESPONSE");
    expect(() => normalizeTheOddsApiResponse([{}], [], now)).toThrow("PROVIDER_INVALID_RESPONSE");
    expect(() => normalizeTheOddsApiResponse([game], [{ ...oddsEvent(), home_team: "Seattle Seahawks" }], now))
      .toThrow("PROVIDER_INVALID_RESPONSE");
    expect(() => normalizeTheOddsApiResponse([{ ...game, commence_time: "2026-11-31T18:00:00Z" }], [], now))
      .toThrow("PROVIDER_INVALID_RESPONSE");
  });
  it("rejects incomplete, mismatched, duplicate, and unrecognized outcomes without fabricating quotes", () => {
    for (const badOutcomes of [
      [{ name: "Over", price: -110, point: 47.5 }],
      [{ name: "Over", price: -110, point: 47.5 }, { name: "Under", price: -110, point: 48.5 }],
      [{ name: "Over", price: -110, point: 47.5 }, { name: "Over", price: -110, point: 47.5 }],
      [{ name: "Other", price: -110, point: 47.5 }, { name: "Under", price: -110, point: 47.5 }],
    ]) {
      const event = oddsEvent();
      event.bookmakers[0].markets = [{ key: "totals", last_update: marketTime, outcomes: badOutcomes }];
      event.bookmakers = event.bookmakers.slice(0, 1);
      expect(normalizeTheOddsApiResponse([game], [event], now).quotes).toEqual([]);
    }
  });
  it("does not reverse incorrect spread signs or accept invalid prices", () => {
    const event = oddsEvent();
    event.bookmakers = [{ key: "draftkings", last_update: marketTime, markets: [
      { key: "spreads", last_update: marketTime, outcomes: [
        { name: "Buffalo Bills", price: -110, point: 3.5 }, { name: "Kansas City Chiefs", price: -110, point: 3.5 },
      ] },
      { key: "h2h", last_update: marketTime, outcomes: [
        { name: "Buffalo Bills", price: 0 }, { name: "Kansas City Chiefs", price: 150 },
      ] },
    ] }];
    expect(normalizeTheOddsApiResponse([game], [event], now).quotes).toEqual([]);
  });
  it("omits timestamps materially in the future and unsupported markets", () => {
    const event = oddsEvent();
    event.bookmakers = [{ key: "draftkings", last_update: marketTime, markets: [
      { ...markets()[0], last_update: "2026-11-11T00:00:00Z" }, { ...markets()[0], key: "player_pass_tds" },
    ] }];
    expect(normalizeTheOddsApiResponse([game], [event], now).quotes).toEqual([]);
  });
  it("rejects even slightly future timestamps and points that would be rounded by storage", () => {
    const event = oddsEvent();
    event.bookmakers = [{ key: "draftkings", last_update: marketTime, markets: [
      { ...markets()[0], last_update: "2026-11-10T12:00:01Z" },
      { key: "spreads", last_update: marketTime, outcomes: [
        { name: "Buffalo Bills", price: -110, point: -3.125 }, { name: "Kansas City Chiefs", price: -110, point: 3.125 },
      ] },
    ] }];
    const result = normalizeTheOddsApiResponse([game], [event], now);
    expect(result.quotes).toEqual([]);
    expect(result.warnings).toEqual(["INVALID_MARKET_TIMESTAMP", "INVALID_POINT"]);
  });
  it("uses an exclusive Eastern calendar cutoff across DST", () => {
    const boundaryNow = new Date("2026-10-31T12:00:00Z");
    const events = [
      { ...game, id: "inside", commence_time: "2026-11-14T04:59:59Z" },
      { ...game, id: "outside", commence_time: "2026-11-14T05:00:00Z" },
    ];
    expect(normalizeTheOddsApiResponse(events, [], boundaryNow).games.map((event) => event.providerEventId)).toEqual(["inside"]);
  });
  it("chooses newer duplicate markets and rejects conflicting prices at equal timestamps", () => {
    const first = oddsEvent();
    const newer = oddsEvent();
    newer.bookmakers[0].markets[0].last_update = "2026-11-10T12:00:00Z";
    newer.bookmakers[0].markets[0].outcomes[1].price = -155;
    const result = normalizeTheOddsApiResponse([game], [first, newer], now);
    expect(result.quotes.find((q) => q.bookmaker === "draftkings" && q.market === "h2h" && q.selection === "home")?.americanOdds).toBe(-155);
    newer.bookmakers[0].markets[0].last_update = marketTime;
    const ambiguous = normalizeTheOddsApiResponse([game], [first, newer], now);
    expect(ambiguous.quotes.some((q) => q.bookmaker === "draftkings" && q.market === "h2h")).toBe(false);
  });
});

describe("The Odds API transport and quota guards", () => {
  it("refuses a paid call without a durable guard", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response([game]));
    await expect(new TheOddsApiProvider({ apiKey: "test-key", fetchImpl }).fetchSnapshot(now))
      .rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("waits for a committed reservation before sending the paid request", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const paid = String(url).includes("/odds?");
      calls.push(paid ? "paid" : "free");
      return response(paid ? [oddsEvent()] : [game]);
    });
    const guard = {
      beforePaidRequest: vi.fn(async () => { calls.push("reserved"); }),
      afterPaidResponse: vi.fn(async () => { calls.push("confirmed"); }),
    };
    await new TheOddsApiProvider({ apiKey: "test-key", fetchImpl }).fetchSnapshot(now, guard);
    expect(calls).toEqual(["free", "reserved", "paid", "confirmed"]);
    expect(guard.beforePaidRequest).toHaveBeenCalledExactlyOnceWith({ remaining: 400, used: 100, lastCost: 3 });
    expect(guard.afterPaidResponse).toHaveBeenCalledExactlyOnceWith({ remaining: 400, used: 100, lastCost: 3 });
  });
  it("does not send a paid request when reservation is denied or uncertain", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response([game]));
    const guard = paidGuard();
    guard.beforePaidRequest = vi.fn().mockRejectedValue(new Error("reservation unavailable"));
    await expect(new TheOddsApiProvider({ apiKey: "test-key", fetchImpl }).fetchSnapshot(now, guard)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(guard.afterPaidResponse).not.toHaveBeenCalled();
  });
  it.each(["network", "timeout", "429", "503", "json", "normalization"])(
    "keeps a failed %s paid request ambiguous without retrying", async (failure) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response([game]));
      if (failure === "network") fetchImpl.mockRejectedValueOnce(new Error("uncertain connection"));
      else if (failure === "timeout") fetchImpl.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("timeout")));
      }));
      else if (failure === "429" || failure === "503") fetchImpl.mockResolvedValueOnce(new Response(null, { status: Number(failure) }));
      else if (failure === "json") fetchImpl.mockResolvedValueOnce(new Response("invalid JSON", { headers }));
      else fetchImpl.mockResolvedValueOnce(response({ invalid: "shape" }));
      const guard = paidGuard();
      await expect(new TheOddsApiProvider({ apiKey: "test-key", fetchImpl, timeoutMs: 5 }).fetchSnapshot(now, guard)).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(guard.beforePaidRequest).toHaveBeenCalledTimes(1);
      expect(guard.afterPaidResponse).not.toHaveBeenCalled();
    },
  );
  it.each(["0", "1", "3"])("confirms a valid receipt costing %s credits", async (cost) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response([game]))
      .mockResolvedValueOnce(response([oddsEvent()], { ...headers, "x-requests-last": cost }));
    const guard = paidGuard();
    await new TheOddsApiProvider({ apiKey: "test-key", fetchImpl }).fetchSnapshot(now, guard);
    expect(guard.afterPaidResponse).toHaveBeenCalledExactlyOnceWith({ remaining: 400, used: 100, lastCost: Number(cost) });
  });
  it.each(["", "NaN", "-1", "4"])("retains the reservation when the paid receipt is invalid (%s)", async (cost) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response([game]))
      .mockResolvedValueOnce(response([oddsEvent()], { ...headers, "x-requests-last": cost }));
    const guard = paidGuard();
    const snapshot = await new TheOddsApiProvider({ apiKey: "test-key", fetchImpl }).fetchSnapshot(now, guard);
    expect(snapshot.quotes).toHaveLength(10);
    expect(guard.beforePaidRequest).toHaveBeenCalledTimes(1);
    expect(guard.afterPaidResponse).not.toHaveBeenCalled();
  });
  it("does not repeat the paid call when receipt persistence fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response([game]))
      .mockResolvedValueOnce(response([oddsEvent()]));
    const guard = paidGuard();
    guard.afterPaidResponse = vi.fn().mockRejectedValue(new Error("database unavailable"));
    await expect(new TheOddsApiProvider({ apiKey: "test-key", fetchImpl }).fetchSnapshot(now, guard)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(guard.beforePaidRequest).toHaveBeenCalledTimes(1);
  });
  it("makes a free quota check then one batch odds request with only permitted parameters", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response([game]))
      .mockResolvedValueOnce(response([oddsEvent()]));
    const provider = new TheOddsApiProvider({ apiKey: "test-key", fetchImpl });
    const result = await provider.fetchSnapshot(now, paidGuard());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(url.pathname).toBe("/v4/sports/americanfootball_nfl/odds");
    expect(url.searchParams.get("bookmakers")).toBe("draftkings,fanduel");
    expect(url.searchParams.get("markets")).toBe("h2h,spreads,totals");
    expect(url.searchParams.get("oddsFormat")).toBe("american");
    expect(url.searchParams.get("commenceTimeTo")).toBe("2026-11-24T04:59:59.999Z");
    expect(url.searchParams.has("includeLinks")).toBe(false);
    expect(result.quota).toEqual({ remaining: 400, used: 100, lastCost: 3 });
    expect(JSON.stringify(result)).not.toContain("test-key");
  });
  it.each(["27", "0"])("does not spend credits when remaining is %s", async (remaining) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response([game], { ...headers, "x-requests-remaining": remaining }));
    const provider = new TheOddsApiProvider({ apiKey: "test-key", fetchImpl });
    await expect(provider.fetchSnapshot(now, paidGuard())).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("allows the exact reserve boundary and rereads quota after a reset", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([game], { ...headers, "x-requests-remaining": "0" }))
      .mockResolvedValueOnce(response([game], { ...headers, "x-requests-remaining": "28" }))
      .mockResolvedValueOnce(response([oddsEvent()], { ...headers, "x-requests-remaining": "25" }));
    const provider = new TheOddsApiProvider({ apiKey: "test-key", fetchImpl });
    await expect(provider.fetchSnapshot(now, paidGuard())).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED" });
    expect((await provider.fetchSnapshot(now, paidGuard())).quota.remaining).toBe(25);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it.each([{}, { "x-requests-remaining": "NaN" }] as Record<string, string>[])("fails closed when quota is missing or invalid", async (customHeaders) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response([game], customHeaders));
    await expect(new TheOddsApiProvider({ apiKey: "test-key", fetchImpl }).fetchSnapshot(now, paidGuard()))
      .rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("returns a sanitized 429 with bounded retry-after and does not retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret upstream text", {
      status: 429, headers: { "Retry-After": "120" },
    }));
    await expect(new TheOddsApiProvider({ apiKey: "secret-key", fetchImpl }).fetchSnapshot(now, paidGuard()))
      .rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryAfterSeconds: 120, message: "PROVIDER_RATE_LIMITED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("accepts an HTTP-date Retry-After", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 429, headers: { "Retry-After": "Tue, 10 Nov 2026 12:02:00 GMT" },
    }));
    await expect(new TheOddsApiProvider({ apiKey: "test-key", fetchImpl }).fetchSnapshot(now, paidGuard()))
      .rejects.toMatchObject({ retryAfterSeconds: 120 });
  });
  it("sanitizes network and upstream errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("https://upstream?apiKey=secret"))
      .mockResolvedValueOnce(new Response("secret upstream body", { status: 503 }));
    const provider = new TheOddsApiProvider({ apiKey: "test-key", fetchImpl });
    await expect(provider.fetchSnapshot(now, paidGuard())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: "PROVIDER_UNAVAILABLE" });
    await expect(provider.fetchSnapshot(now, paidGuard())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("aborts a timed-out request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("request aborted")));
    }));
    await expect(new TheOddsApiProvider({ apiKey: "test-key", fetchImpl, timeoutMs: 5 }).fetchSnapshot(now, paidGuard()))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("rejects malformed JSON and oversized bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("not json"))
      .mockResolvedValueOnce(new Response("[]", { headers: { "content-length": "2000001" } }));
    const provider = new TheOddsApiProvider({ apiKey: "test-key", fetchImpl });
    await expect(provider.fetchSnapshot(now, paidGuard())).rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
    await expect(provider.fetchSnapshot(now, paidGuard())).rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
  });
});

describe("empty schedule protection", () => {
  it("does not make a paid request for an empty or malformed schedule", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([{}]));
    const provider = new TheOddsApiProvider({ apiKey: "test-key", fetchImpl });
    expect((await provider.fetchSnapshot(now, paidGuard())).games).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(provider.fetchSnapshot(now, paidGuard())).rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("provider selection and deterministic mock", () => {
  it("defaults to mock without an API key and rejects unsupported configurations", () => {
    vi.stubEnv("ODDS_PROVIDER", undefined);
    vi.stubEnv("ODDS_API_KEY", undefined);
    expect(configuredProviderName()).toBe("mock");
    expect(createOddsProvider()).toBeInstanceOf(MockOddsProvider);
    vi.stubEnv("ODDS_PROVIDER", "untrusted-provider");
    expect(() => createOddsProvider()).toThrow("PROVIDER_CONFIGURATION");
    vi.stubEnv("ODDS_PROVIDER", "the-odds-api");
    expect(() => createOddsProvider()).toThrow("PROVIDER_CONFIGURATION");
    vi.stubEnv("ODDS_API_KEY", "test-key");
    vi.stubEnv("ODDS_CREDIT_RESERVE", "-1");
    expect(() => createOddsProvider()).toThrow("PROVIDER_CONFIGURATION");
  });
  it("returns deterministic future fixtures and a deliberate missing market", async () => {
    const provider = new MockOddsProvider();
    const result = await provider.fetchSnapshot(now);
    expect(await provider.fetchSnapshot(now)).toEqual(result);
    expect(result.games.length).toBeGreaterThan(1);
    expect(result.games.every((event) => event.providerEventId.startsWith("mock-") && Date.parse(event.startsAt) > now.getTime())).toBe(true);
    const missing = result.games.find((event) => event.homeTeamId === "nfl:buf")!;
    expect(result.quotes.some((q) => q.providerEventId === missing.providerEventId && q.bookmaker === "fanduel" && q.market === "totals")).toBe(false);
  });
});
