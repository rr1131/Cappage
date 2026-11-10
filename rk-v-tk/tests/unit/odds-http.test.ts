import { describe, expect, it, vi } from "vitest";
import { ProfileError } from "../../lib/domain/profile";
import { OddsError } from "../../lib/odds/errors";
import { oddsHandlers } from "../../lib/odds/http";

const now = new Date("2026-11-10T12:00:00Z");
const id = "00000000-0000-4000-8000-000000000001";
function dependencies() {
  return {
    authenticate: vi.fn().mockResolvedValue("verified-cognito-sub"),
    listGames: vi.fn().mockResolvedValue({ games: [], meta: {} }),
    gameOdds: vi.fn().mockResolvedValue({ game: { id }, quotes: [], markets: [], meta: {} }),
    refresh: vi.fn().mockResolvedValue({ status: "updated", games: 2, quotes: 24, warnings: 0 }),
    clock: () => now,
  };
}
const post = (suffix = "", body?: string) => new Request(`https://example.com/api/nfl/refresh${suffix}`, {
  method: "POST", body, headers: { Authorization: "Bearer access-token" },
});

describe("authenticated demand refresh", () => {
  it("verifies identity before allowing an ingestion attempt", async () => {
    const deps = dependencies();
    deps.refresh.mockImplementationOnce(async () => {
      expect(deps.authenticate).toHaveBeenCalledTimes(1);
      return { status: "updated", games: 2, quotes: 24, warnings: 0 };
    });
    const request = post();
    const result = await oddsHandlers(deps).refresh(request);
    expect(deps.authenticate).toHaveBeenCalledWith(request);
    expect(deps.refresh).toHaveBeenCalledWith();
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ status: "updated", games: 2, quotes: 24, warnings: 0 });
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("vary")).toBe("Authorization");
  });
  it("rejects unauthenticated demand without touching the cache or provider", async () => {
    const deps = dependencies();
    deps.authenticate.mockRejectedValue(new ProfileError("UNAUTHORIZED", "Sign in.", 401));
    const result = await oddsHandlers(deps).refresh(post("?userId=forged", "{}"));
    expect(result.status).toBe(401);
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.listGames).not.toHaveBeenCalled();
    expect(deps.gameOdds).not.toHaveBeenCalled();
  });
  it.each([
    post("?force=true"), post("?provider=the-odds-api"), post("", '{"userId":"forged"}'),
    post("", "{}"), new Request("https://example.com/api/nfl/refresh"),
  ])("rejects client controls and non-POST requests", async (request) => {
    const deps = dependencies();
    const result = await oddsHandlers(deps).refresh(request);
    expect(result.status).toBe(400);
    expect(deps.authenticate).toHaveBeenCalledTimes(1);
    expect(deps.refresh).not.toHaveBeenCalled();
  });
  it("returns shared cooldown or lease skips without starting a second action", async () => {
    const deps = dependencies();
    deps.refresh.mockResolvedValue({ status: "skipped", reason: "Refresh is not due or another sync is running." });
    const result = await oddsHandlers(deps).refresh(post());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: "skipped" });
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });
  it("returns sanitized budget errors while keeping GETs independent", async () => {
    const deps = dependencies();
    deps.refresh.mockRejectedValue(new OddsError("ODDS_CREDIT_LIMIT", "Refresh budget is unavailable.", 503));
    const handlers = oddsHandlers(deps);
    const result = await handlers.refresh(post());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: { code: "ODDS_CREDIT_LIMIT", message: "Refresh budget is unavailable." } });
    expect((await handlers.games(new Request("https://example.com/api/nfl/games"))).status).toBe(200);
    expect((await handlers.odds(new Request(`https://example.com/api/nfl/games/${id}/odds`), id)).status).toBe(200);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });
  it("does not expose unexpected database or provider error messages", async () => {
    const deps = dependencies();
    deps.refresh.mockRejectedValue(new Error("secret-database-url-and-api-key"));
    const result = await oddsHandlers(deps).refresh(post());
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("secret");
  });
});

describe("read contracts remain cache only", () => {
  it("preserves games/detail shapes and never calls demand refresh", async () => {
    const deps = dependencies();
    const handlers = oddsHandlers(deps);
    const games = await handlers.games(new Request("https://example.com/api/nfl/games?days=2"));
    const odds = await handlers.odds(new Request(`https://example.com/api/nfl/games/${id}/odds`), id);
    expect(await games.json()).toEqual({ games: [], meta: {} });
    expect(await odds.json()).toEqual({ game: { id }, quotes: [], markets: [], meta: {} });
    expect(deps.listGames).toHaveBeenCalledWith(now, 2);
    expect(deps.gameOdds).toHaveBeenCalledWith(id, now);
    expect(deps.refresh).not.toHaveBeenCalled();
  });
});
