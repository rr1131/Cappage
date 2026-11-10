import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderName, ProviderSnapshot } from "../../lib/domain/odds";
import { oddsRepository } from "../../lib/odds/repository";
import { syncOdds } from "../../lib/odds/sync";
import { ProviderError, type OddsProvider } from "../../lib/providers/odds-provider";

import { disposablePostgres } from "../helpers/postgres";

const postgres = disposablePostgres();
const { pool, db, queries } = postgres;
const settings = { refreshSeconds: 60, freshSeconds: 300, maxAgeSeconds: 86_400, creditReserve: 25,
  monthlyCreditCap: 300, dailyPaidRefreshLimit: 3, billingAnchor: null };
const repository = oddsRepository(db, settings);
const start = new Date("2026-11-10T12:00:00.000Z");
const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);

function snapshot(time = start): ProviderSnapshot {
  const game = { providerEventId: "event-a", homeTeamId: "nfl:buf", awayTeamId: "nfl:kc",
    startsAt: at(3 * 86_400).toISOString(), status: "scheduled" as const, seasonYear: 2026, seasonSource: "derived" as const };
  return {
    games: [
      { ...game, providerEventId: "event-b", homeTeamId: "nfl:phi", awayTeamId: "nfl:dal", startsAt: at(4 * 86_400).toISOString() },
      game,
    ],
    quotes: ["draftkings", "fanduel"].flatMap((bookmaker) => [
      { market: "h2h", selection: "home", point: null, americanOdds: -145 },
      { market: "h2h", selection: "away", point: null, americanOdds: 125 },
      { market: "spreads", selection: "home", point: -3.5, americanOdds: -110 },
      { market: "spreads", selection: "away", point: 3.5, americanOdds: -110 },
      { market: "totals", selection: "over", point: 47.5, americanOdds: -110 },
      { market: "totals", selection: "under", point: 47.5, americanOdds: -110 },
    ].map((quote) => ({ ...quote, providerEventId: "event-a", bookmaker, providerUpdatedAt: time.toISOString() }))) as ProviderSnapshot["quotes"],
    fetchedAt: time.toISOString(), quota: { remaining: 497, used: 3, lastCost: 3 }, warnings: [],
  };
}

async function ingest(data = snapshot(), time = start, provider: ProviderName = "mock") {
  const lease = await repository.acquire(provider, time);
  expect(lease).not.toBeNull();
  return repository.save(provider, lease!.token, data, time);
}

async function gameId(provider: ProviderName = "mock", event = "event-a") {
  const result = await pool.query("SELECT game_id FROM nfl_game_provider_ids WHERE provider = $1 AND provider_event_id = $2", [provider, event]);
  return result.rows[0].game_id as string;
}

beforeAll(async () => {
  await postgres.initialize();
  await postgres.captureMutations(["nfl_games", "nfl_game_provider_ids", "nfl_current_odds", "odds_sync_state"]);
});
beforeEach(async () => {
  await pool.query("TRUNCATE nfl_current_odds, nfl_game_provider_ids, nfl_games, odds_sync_state, test_row_mutations");
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => postgres.close());

describe("PostgreSQL NFL odds ingestion and cache", () => {
  it("distinguishes an uninitialized cache from a successful empty snapshot", async () => {
    await expect(repository.listGames("mock", start, 14)).rejects.toMatchObject({ code: "ODDS_NOT_SYNCED", status: 503 });
    await ingest({ ...snapshot(), games: [], quotes: [] });
    expect((await repository.listGames("mock", start, 14)).games).toEqual([]);
  });

  it("deduplicates events and persists quote identities across repeat syncs", async () => {
    const first = snapshot();
    first.games.push({ ...first.games[1] });
    await ingest(first);
    const id = await gameId();
    const before = await repository.gameOdds("mock", id, start);
    expect(before.quotes).toHaveLength(12);
    expect(before.quotes.every((quote) => quote.revision === 1)).toBe(true);
    await ingest({ ...snapshot(), fetchedAt: at(60).toISOString() }, at(60));
    const after = await repository.gameOdds("mock", id, at(60));
    expect(after.quotes.map((quote) => [quote.id, quote.revision])).toEqual(before.quotes.map((quote) => [quote.id, quote.revision]));
    expect((await pool.query("SELECT * FROM nfl_games")).rowCount).toBe(2);
    expect((await pool.query("SELECT * FROM nfl_game_provider_ids")).rowCount).toBe(2);
    expect((await pool.query("SELECT * FROM nfl_current_odds")).rowCount).toBe(12);
  });

  it("keeps provider event ID collisions separate and never falls back to mock data", async () => {
    await ingest();
    await expect(repository.listGames("the-odds-api", start, 14)).rejects.toMatchObject({ code: "ODDS_NOT_SYNCED" });
    const real = snapshot();
    real.quotes[0].americanOdds = -160;
    await ingest(real, start, "the-odds-api");
    const mockId = await gameId();
    const realId = await gameId("the-odds-api");
    expect(realId).not.toBe(mockId);
    await expect(repository.gameOdds("mock", realId, start)).rejects.toMatchObject({ code: "GAME_NOT_FOUND" });
    expect((await repository.gameOdds("the-odds-api", realId, start)).meta.isMock).toBe(false);
    expect((await pool.query("SELECT * FROM nfl_current_odds")).rowCount).toBe(24);
  });

  it("returns chronological games and explicit empty markets without contacting the provider", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Reads must not call upstream"));
    await ingest();
    const listed = await repository.listGames("mock", start, 14);
    expect(listed.games.map((game) => game.homeTeam.id)).toEqual(["nfl:buf", "nfl:phi"]);
    const empty = await repository.gameOdds("mock", await gameId("mock", "event-b"), start);
    expect(empty.quotes).toEqual([]);
    expect(empty.markets).toHaveLength(6);
    expect(empty.markets.every((market) => !market.available && !market.complete)).toBe(true);
    await repository.gameOdds("mock", await gameId(), start);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("updates changed lines/prices in place only with a newer provider timestamp", async () => {
    await ingest();
    const id = await gameId();
    const before = (await repository.gameOdds("mock", id, start)).quotes.find((quote) => quote.bookmaker === "draftkings" && quote.market === "spreads" && quote.selection === "home")!;
    const changed = snapshot(at(60));
    const quote = changed.quotes.find((quote) => quote.bookmaker === "draftkings" && quote.market === "spreads" && quote.selection === "home")!;
    quote.point = -4.5;
    quote.americanOdds = -115;
    await ingest(changed, at(60));
    const after = (await repository.gameOdds("mock", id, at(60))).quotes.find((quote) => quote.id === before.id)!;
    expect(after).toMatchObject({ id: before.id, revision: 2, point: -4.5, americanOdds: -115, providerUpdatedAt: at(60).toISOString() });
    expect((await pool.query("SELECT * FROM nfl_current_odds")).rowCount).toBe(12);
  });

  it("marks removed markets unavailable and refuses old-timestamp reactivation", async () => {
    await ingest();
    const missing = snapshot(at(60));
    missing.quotes = missing.quotes.filter((quote) => !(quote.bookmaker === "fanduel" && quote.market === "totals"));
    await ingest(missing, at(60));
    const id = await gameId();
    const missingRead = await repository.gameOdds("mock", id, at(60));
    expect(missingRead.quotes).toHaveLength(10);
    expect(missingRead.markets.find((market) => market.bookmaker === "fanduel" && market.market === "totals"))
      .toMatchObject({ available: false, complete: false });
    const old = { ...snapshot(), fetchedAt: at(120).toISOString() };
    await ingest(old, at(120));
    expect((await repository.gameOdds("mock", id, at(120))).quotes).toHaveLength(10);
    await ingest(snapshot(at(180)), at(180));
    const restored = (await repository.gameOdds("mock", id, at(180))).quotes.filter((quote) => quote.bookmaker === "fanduel" && quote.market === "totals");
    expect(restored).toHaveLength(2);
    expect(restored.every((quote) => quote.revision === 3)).toBe(true);
  });

  it("does not let an older quote overwrite a newer price or its timestamps", async () => {
    await ingest();
    const newest = snapshot(at(60));
    newest.quotes[0].americanOdds = -160;
    await ingest(newest, at(60));
    const id = await gameId();
    const before = (await repository.gameOdds("mock", id, at(60))).quotes;
    await ingest({ ...snapshot(), fetchedAt: at(120).toISOString() }, at(120));
    expect((await repository.gameOdds("mock", id, at(120))).quotes).toEqual(before);
  });

  it("does not renew source freshness when an unchanged old quote is fetched again", async () => {
    await ingest();
    await ingest({ ...snapshot(), fetchedAt: at(240).toISOString() }, at(240));
    const id = await gameId();
    expect((await repository.gameOdds("mock", id, at(299))).quotes.every((quote) => !quote.stale)).toBe(true);
    const expired = await repository.gameOdds("mock", id, at(300));
    expect(expired.quotes.every((quote) => quote.stale)).toBe(true);
    expect(expired.meta.stale).toBe(true);
    expect(expired.quotes[0]).toMatchObject({ providerUpdatedAt: start.toISOString(), ingestedAt: start.toISOString(),
      freshUntil: at(300).toISOString(), expiresAt: at(86_400).toISOString() });
    expect((await repository.gameOdds("mock", id, at(86_400))).quotes).toEqual([]);
  });

  it("excludes games and odds at kickoff even before the next ingestion", async () => {
    const near = snapshot();
    near.games = [ { ...near.games[1], startsAt: at(600).toISOString() } ];
    await ingest(near);
    const id = await gameId();
    expect((await repository.gameOdds("mock", id, at(599))).quotes[0]).toMatchObject({ expiresAt: at(600).toISOString() });
    await expect(repository.gameOdds("mock", id, at(600))).rejects.toMatchObject({ code: "GAME_STARTED", status: 409 });
    expect((await repository.listGames("mock", at(600), 14)).games).toEqual([]);
  });

  it("retains cached data and applies Retry-After when the provider returns 429", async () => {
    await ingest();
    const id = await gameId();
    const original = (await repository.gameOdds("mock", id, at(360))).quotes;
    const provider: OddsProvider = { name: "mock", fetchSnapshot: vi.fn().mockRejectedValue(new ProviderError("PROVIDER_RATE_LIMITED", 600)) };
    await expect(syncOdds(provider, repository, () => at(360))).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", status: 503 });
    const cached = await repository.gameOdds("mock", id, at(360));
    expect(cached.quotes).toEqual(original);
    expect(cached.meta).toMatchObject({ lastSuccessAt: start.toISOString(), lastAttemptAt: at(360).toISOString(),
      nextRefreshAt: at(960).toISOString(), refreshError: "PROVIDER_RATE_LIMITED", stale: true });
    expect(await syncOdds(provider, repository, () => at(959))).toMatchObject({ status: "skipped" });
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("redacts unexpected failures and recovers after cooldown", async () => {
    await ingest();
    const provider: OddsProvider = { name: "mock", fetchSnapshot: vi.fn().mockRejectedValue(new Error("apiKey=do-not-log-this")) };
    await expect(syncOdds(provider, repository, () => at(60))).rejects.toMatchObject({ code: "SYNC_UNAVAILABLE" });
    const failed = await pool.query("SELECT last_error, last_success_at FROM odds_sync_state WHERE provider = 'mock'");
    expect(failed.rows[0].last_error).toBe("SYNC_UNAVAILABLE");
    expect(failed.rows[0].last_success_at).toEqual(start);
    vi.mocked(provider.fetchSnapshot).mockResolvedValue(snapshot(at(120)));
    expect(await syncOdds(provider, repository, () => at(120))).toMatchObject({ status: "updated" });
    const recovered = await repository.listGames("mock", at(120), 14);
    expect(recovered.meta).toMatchObject({ lastSuccessAt: at(120).toISOString(), refreshError: null });
  });

  it("applies a 24-hour quota cooldown instead of repeatedly requesting exhausted credits", async () => {
    const provider: OddsProvider = { name: "the-odds-api", fetchSnapshot: vi.fn().mockRejectedValue(new ProviderError("PROVIDER_QUOTA_EXHAUSTED")) };
    await expect(syncOdds(provider, repository, () => start)).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED" });
    expect(await syncOdds(provider, repository, () => at(86_399))).toMatchObject({ status: "skipped" });
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(1);
    const state = await pool.query("SELECT next_refresh_at FROM odds_sync_state WHERE provider = 'the-odds-api'");
    expect(state.rows[0].next_refresh_at).toEqual(at(86_400));
  });

  it("grants exactly one lease to simultaneous workers", async () => {
    const leases = await Promise.all(Array.from({ length: 12 }, () => repository.acquire("mock", start)));
    expect(leases.filter(Boolean)).toHaveLength(1);
    const winner = leases.find(Boolean)!;
    await repository.save("mock", winner.token, snapshot(), start);
    expect(await repository.acquire("mock", at(59))).toBeNull();
    expect(await repository.acquire("mock", at(60))).not.toBeNull();
  });

  it("fences expired writers and prevents their failure callback from clearing a new owner's lease", async () => {
    const previous = (await repository.acquire("mock", start))!;
    const current = (await repository.acquire("mock", at(121)))!;
    expect(current.token).not.toBe(previous.token);
    await expect(repository.save("mock", previous.token, snapshot(at(121)), at(121)))
      .rejects.toMatchObject({ code: "SYNC_LEASE_LOST" });
    await repository.fail("mock", previous.token, at(122), "OLD_WORKER_FAILURE", 3600);
    const state = await pool.query("SELECT lease_token, last_error, failures FROM odds_sync_state WHERE provider = 'mock'");
    expect(state.rows[0]).toMatchObject({ lease_token: current.token, last_error: null, failures: 0 });
    await repository.save("mock", current.token, snapshot(at(122)), at(122));
    expect((await repository.listGames("mock", at(122), 14)).games).toHaveLength(2);
  });

  it("rejects a snapshot older than the last successful snapshot without overwriting data", async () => {
    await ingest();
    await ingest(snapshot(at(60)), at(60));
    const old = snapshot();
    const lease = (await repository.acquire("mock", at(120)))!;
    await expect(repository.save("mock", lease.token, old, at(120))).rejects.toMatchObject({ code: "STALE_SNAPSHOT" });
    const state = await pool.query("SELECT last_success_at FROM odds_sync_state WHERE provider = 'mock'");
    expect(state.rows[0].last_success_at).toEqual(at(60));
  });

  it("rolls back the whole ingestion if a later quote violates a database constraint", async () => {
    await ingest();
    const id = await gameId();
    const before = await repository.gameOdds("mock", id, start);
    const broken = snapshot(at(60));
    broken.games[1].startsAt = at(3 * 86_400 + 600).toISOString();
    broken.games.push({ ...broken.games[0], providerEventId: "new-event" });
    broken.quotes[0].americanOdds = -180;
    broken.quotes[broken.quotes.length - 1].americanOdds = 0;
    const lease = (await repository.acquire("mock", at(60)))!;
    await expect(repository.save("mock", lease.token, broken, at(60))).rejects.toThrow();
    const after = await repository.gameOdds("mock", id, start);
    expect(after.quotes).toEqual(before.quotes);
    expect(after.game.startsAt).toBe(before.game.startsAt);
    expect((await pool.query("SELECT * FROM nfl_games")).rowCount).toBe(2);
    expect((await pool.query("SELECT * FROM nfl_game_provider_ids")).rowCount).toBe(2);
    expect(after.meta.lastSuccessAt).toBe(start.toISOString());
  });

  it("retains removal tombstones for one maximum age then deletes them on demand", async () => {
    await ingest();
    await ingest({ ...snapshot(at(86_400)), quotes: [] }, at(86_400));
    expect((await pool.query("SELECT * FROM nfl_current_odds WHERE available")).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM nfl_current_odds")).rowCount).toBe(12);
    await ingest({ ...snapshot(at(172_800)), quotes: [] }, at(172_800));
    expect((await pool.query("SELECT * FROM nfl_current_odds")).rowCount).toBe(0);
  });

  it("does not revive a removed quote with a timestamp between its last quote and removal", async () => {
    await ingest();
    await ingest({ ...snapshot(at(120)), quotes: [] }, at(120));
    const intermediate = { ...snapshot(at(60)), fetchedAt: at(180).toISOString() };
    await ingest(intermediate, at(180));
    expect((await repository.gameOdds("mock", await gameId(), at(180))).quotes).toEqual([]);
    expect((await pool.query("SELECT DISTINCT unavailable_at FROM nfl_current_odds")).rows).toEqual([{ unavailable_at: at(120) }]);
  });

  it("does not rewrite games that were already unavailable", async () => {
    await ingest();
    await ingest({ ...snapshot(at(60)), games: [], quotes: [] }, at(60));
    await pool.query("TRUNCATE test_row_mutations");
    await ingest({ ...snapshot(at(120)), games: [], quotes: [] }, at(120));
    expect((await pool.query("SELECT * FROM test_row_mutations WHERE table_name <> 'odds_sync_state'")).rows).toEqual([]);
  });

  it("bulk writes a changed batch in a constant number of SQL statements", async () => {
    await ingest();
    queries.length = 0;
    await ingest(snapshot(at(60)), at(60));
    expect(queries.filter((query) => query.startsWith('insert into "nfl_current_odds"'))).toHaveLength(1);
    expect(queries).toHaveLength(8);
  });

  it("measures an unchanged 32-game 384-quote refresh with zero cache row mutations", async () => {
    const fixture = snapshot();
    const quotes = fixture.quotes;
    const games = Array.from({ length: 32 }, (_, index) => ({ ...fixture.games[1], providerEventId: `benchmark-${index}` }));
    const batch = { ...fixture, games, quotes: games.flatMap((game) => quotes.map((quote) => ({ ...quote, providerEventId: game.providerEventId }))) };
    await ingest(batch);
    await pool.query("TRUNCATE test_row_mutations");
    queries.length = 0;
    await ingest({ ...batch, fetchedAt: at(60).toISOString() }, at(60));
    const statements = queries.length;
    const mutations = (await pool.query("SELECT table_name, operation, count(*)::integer AS count FROM test_row_mutations GROUP BY table_name, operation")).rows;
    expect(statements).toBe(7);
    expect(mutations).toEqual([{ table_name: "odds_sync_state", operation: "UPDATE", count: 2 }]);
    console.info(JSON.stringify({ benchmark: "unchanged mock refresh", games: 32, quotes: 384, sqlStatements: statements, rowMutations: mutations }));
  });

  it("uses the PostgreSQL clock when no test clock is supplied", async () => {
    const before = (await pool.query("SELECT statement_timestamp() AS now")).rows[0].now as Date;
    const lease = (await repository.acquire("mock"))!;
    const after = (await pool.query("SELECT statement_timestamp() AS now")).rows[0].now as Date;
    expect(lease.now.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(lease.now.getTime()).toBeLessThanOrEqual(after.getTime());
    const state = (await pool.query("SELECT next_refresh_at, lease_until FROM odds_sync_state")).rows[0];
    expect(state.next_refresh_at.getTime() - lease.now.getTime()).toBe(60_000);
    expect(state.lease_until.getTime() - lease.now.getTime()).toBe(120_000);
  });

  it("keeps the six-hour pacing after a crashed worker even after its lease expires", async () => {
    const cautious = oddsRepository(db, { ...settings, refreshSeconds: 21_600 });
    expect(await cautious.acquire("mock", start)).not.toBeNull();
    expect(await cautious.acquire("mock", at(121))).toBeNull();
    expect(await cautious.acquire("mock", at(21_599))).toBeNull();
    expect(await cautious.acquire("mock", at(21_600))).not.toBeNull();
  });

  it("enforces six hours for the real provider even if a caller supplies a shorter interval", async () => {
    await ingest(snapshot(), start, "the-odds-api");
    expect(await repository.acquire("the-odds-api", at(60))).toBeNull();
    expect(await repository.acquire("the-odds-api", at(21_599))).toBeNull();
    expect(await repository.acquire("the-odds-api", at(21_600))).not.toBeNull();
  });

  it("never shortens an acquired cooldown when reporting a failure", async () => {
    const cautious = oddsRepository(db, { ...settings, refreshSeconds: 21_600 });
    const lease = (await cautious.acquire("mock", start))!;
    await cautious.fail("mock", lease.token, at(10), "SYNC_UNAVAILABLE", 60);
    expect(await cautious.acquire("mock", at(21_599))).toBeNull();
    expect(await cautious.acquire("mock", at(21_600))).not.toBeNull();
  });
});
