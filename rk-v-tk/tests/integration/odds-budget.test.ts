import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disposablePostgres } from "../helpers/postgres";
import { oddsRepository } from "../../lib/odds/repository";
import { syncOdds } from "../../lib/odds/sync";
import { ProviderError, type OddsProvider } from "../../lib/providers/odds-provider";
import type { OddsSettings } from "../../lib/odds/settings";
import type { ProviderSnapshot } from "../../lib/domain/odds";

const postgres = disposablePostgres();
const { pool, db, queries } = postgres;
const settings: OddsSettings = { refreshSeconds: 21_600, freshSeconds: 300, maxAgeSeconds: 86_400,
  creditReserve: 25, monthlyCreditCap: 300, dailyPaidRefreshLimit: 3, billingAnchor: "2026-01-17T12:30:00Z" };
const repository = oddsRepository(db, settings);
const start = new Date("2026-11-10T05:05:00Z");
const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
const quota = { used: 0, remaining: 500, lastCost: 0 };
const budget = async () => (await pool.query("SELECT * FROM odds_provider_budget")).rows[0];
const ledger = async () => (await pool.query("SELECT * FROM odds_provider_requests ORDER BY requested_at")).rows;

function snapshot(now: Date, gameCount = 1): ProviderSnapshot {
  const games = Array.from({ length: gameCount }, (_, index) => ({ providerEventId: `event-${index}`, homeTeamId: "nfl:buf", awayTeamId: "nfl:kc",
    startsAt: at(3 * 86_400).toISOString(), status: "scheduled" as const, seasonYear: 2026, seasonSource: "derived" as const }));
  const quotes = games.flatMap((game) => (["draftkings", "fanduel"] as const).flatMap((bookmaker) => [
    { market: "h2h", selection: "home", point: null }, { market: "h2h", selection: "away", point: null },
    { market: "spreads", selection: "home", point: -3.5 }, { market: "spreads", selection: "away", point: 3.5 },
    { market: "totals", selection: "over", point: 47.5 }, { market: "totals", selection: "under", point: 47.5 },
  ].map((quote) => ({ ...quote, providerEventId: game.providerEventId, bookmaker, americanOdds: -110, providerUpdatedAt: now.toISOString() })))) as ProviderSnapshot["quotes"];
  return { games, quotes, fetchedAt: now.toISOString(), quota: { used: 3, remaining: 497, lastCost: 3 }, warnings: [] };
}

async function reserve(now = start, used = 0, repo = repository) {
  const lease = await repo.acquire("the-odds-api", now);
  expect(lease).not.toBeNull();
  await repo.reservePaidRequest("the-odds-api", lease!.token, { ...quota, used }, now);
  return lease!;
}

beforeAll(async () => {
  await postgres.initialize();
  await postgres.captureMutations(["nfl_games", "nfl_game_provider_ids", "nfl_current_odds", "odds_sync_state", "odds_provider_budget", "odds_provider_requests"]);
});
beforeEach(async () => {
  await pool.query("TRUNCATE nfl_current_odds, nfl_game_provider_ids, nfl_games, odds_sync_state, odds_provider_requests, odds_provider_budget, test_row_mutations");
  queries.length = 0;
});
afterAll(() => postgres.close());

describe("durable shared provider budgets", () => {
  it("commits three credits and a daily attempt before authorizing a paid call", async () => {
    await reserve();
    expect(await budget()).toMatchObject({ credits_charged: 3, daily_paid_refreshes: 1, period_start: new Date("2026-10-17T12:30:00Z") });
    expect(await ledger()).toMatchObject([{ charged_credits: 3, status: "uncertain" }]);
  });

  it("permits just one of twelve concurrent refreshes from separate application instances", async () => {
    const paid = vi.fn();
    const provider: OddsProvider = { name: "the-odds-api", async fetchSnapshot(now, guard) {
      await guard!.beforePaidRequest(quota);
      paid();
      await guard!.afterPaidResponse({ used: 3, remaining: 497, lastCost: 3 });
      return snapshot(now);
    } };
    const results = await Promise.all(Array.from({ length: 12 }, () => syncOdds(provider, oddsRepository(db, settings), () => start)));
    expect(results.filter((r) => r.status === "updated")).toHaveLength(1);
    expect(paid).toHaveBeenCalledTimes(1);
    expect(await budget()).toMatchObject({ credits_charged: 3, daily_paid_refreshes: 1 });
  });

  it("never authorizes concurrent reuse of one reservation", async () => {
    const lease = await repository.acquire("the-odds-api", start);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => repository.reservePaidRequest("the-odds-api", lease!.token, quota, start)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await budget()).toMatchObject({ credits_charged: 3, daily_paid_refreshes: 1 });
    expect(await ledger()).toHaveLength(1);
  });

  it("imports existing provider consumption and cannot overspend the final three credits", async () => {
    await reserve(start, 297);
    expect((await budget()).credits_charged).toBe(300);
    await expect(reserve(at(21_600), 297)).rejects.toMatchObject({ code: "PROVIDER_MONTHLY_LIMIT" });
    expect((await budget()).credits_charged).toBe(300);
    expect(await ledger()).toHaveLength(1);
  });

  it("enforces three attempts per Eastern day and resets the daily counter at Eastern midnight", async () => {
    await reserve();
    await reserve(at(21_600));
    await reserve(at(43_200));
    await expect(reserve(at(64_800))).rejects.toMatchObject({ code: "PROVIDER_DAILY_LIMIT" });
    await reserve(at(86_400));
    expect(await budget()).toMatchObject({ credits_charged: 12, daily_paid_refreshes: 1, day: "2026-11-11" });
  });

  it.each(["PROVIDER_UNAVAILABLE", "PROVIDER_INVALID_RESPONSE", "PROVIDER_RATE_LIMITED"] as const)("keeps ambiguous %s charges and six-hour retry pacing", async (code) => {
    const paid = vi.fn();
    const provider: OddsProvider = { name: "the-odds-api", async fetchSnapshot(_now, guard) {
      await guard!.beforePaidRequest(quota);
      paid();
      throw new ProviderError(code);
    } };
    await expect(syncOdds(provider, repository, () => start)).rejects.toMatchObject({ code });
    expect(await budget()).toMatchObject({ credits_charged: 3, daily_paid_refreshes: 1 });
    expect((await ledger())[0].status).toBe("uncertain");
    expect((await syncOdds(provider, repository, () => at(60))).status).toBe("skipped");
    expect((await syncOdds(provider, repository, () => at(21_599))).status).toBe("skipped");
    await expect(syncOdds(provider, repository, () => at(21_600))).rejects.toMatchObject({ code });
    expect(paid).toHaveBeenCalledTimes(2);
    expect((await budget()).credits_charged).toBe(6);
  });

  it("retains charges after a paid success followed by a database persistence error", async () => {
    const provider: OddsProvider = { name: "the-odds-api", async fetchSnapshot(now, guard) {
      await guard!.beforePaidRequest(quota);
      await guard!.afterPaidResponse({ ...quota, used: 3, lastCost: 3 });
      const data = snapshot(now);
      data.games[0].homeTeamId = "invalid-team";
      return data;
    } };
    await expect(syncOdds(provider, repository, () => start)).rejects.toMatchObject({ code: "INVALID_SNAPSHOT" });
    expect((await budget()).credits_charged).toBe(3);
    expect((await ledger())[0].status).toBe("confirmed");
    expect((await syncOdds(provider, repository, () => at(121))).status).toBe("skipped");
  });

  it("survives a process crash and does not use lease expiry as permission to retry", async () => {
    const lease = await reserve();
    expect(await repository.acquire("the-odds-api", at(121))).toBeNull();
    await expect(repository.reservePaidRequest("the-odds-api", lease.token, quota, at(121))).rejects.toMatchObject({ code: "SYNC_LEASE_LOST" });
    expect((await budget()).credits_charged).toBe(3);
  });

  it("reconciles confirmed lower costs exactly once without refunding the daily attempt", async () => {
    const lease = await reserve();
    await Promise.all(Array.from({ length: 6 }, () => repository.confirmPaidRequest("the-odds-api", lease.token, quota)));
    expect(await budget()).toMatchObject({ credits_charged: 0, daily_paid_refreshes: 1 });
    expect((await ledger())[0]).toMatchObject({ charged_credits: 0, status: "confirmed" });
  });

  it("leaves invalid or missing receipts conservatively charged", async () => {
    const lease = await reserve();
    for (const lastCost of [null, -1, 4, 1.5, NaN]) await repository.confirmPaidRequest("the-odds-api", lease.token, { ...quota, lastCost });
    expect((await budget()).credits_charged).toBe(3);
    expect((await ledger())[0].status).toBe("uncertain");
  });

  it("rolls the cap at the configured quota boundary and cannot refund the new period with a late old receipt", async () => {
    const old = await reserve(start, 297);
    const nextPeriod = new Date("2026-11-17T12:30:00Z");
    await reserve(nextPeriod);
    await repository.confirmPaidRequest("the-odds-api", old.token, quota);
    expect(await budget()).toMatchObject({ credits_charged: 3, period_start: nextPeriod, period_end: new Date("2026-12-17T12:30:00Z") });
    expect(await ledger()).toHaveLength(2);
  });

  it("does not reset credits on calendar month boundaries or anchor configuration changes", async () => {
    const late = new Date("2026-10-31T12:30:00Z");
    await reserve(late, 297);
    await expect(reserve(new Date("2026-11-01T12:30:00Z"))).rejects.toMatchObject({ code: "PROVIDER_MONTHLY_LIMIT" });
    const changed = oddsRepository(db, { ...settings, billingAnchor: "2026-01-01T00:00:00Z" });
    await expect(reserve(new Date("2026-11-02T12:30:00Z"), 0, changed)).rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION" });
  });

  it("fails closed without a verified anchor or usable quota headers", async () => {
    const lease = await repository.acquire("the-odds-api", start);
    const unconfigured = oddsRepository(db, { ...settings, billingAnchor: null });
    await expect(unconfigured.reservePaidRequest("the-odds-api", lease!.token, quota, start)).rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION" });
    for (const header of [{ ...quota, used: null }, { ...quota, remaining: 27 }]) {
      await expect(repository.reservePaidRequest("the-odds-api", lease!.token, header, start)).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED" });
    }
    expect(await ledger()).toHaveLength(0);
  });

  it.each(["2026-11-17T12:29:00Z", "2026-11-11T04:59:00Z"])("avoids dispatch across a quota/day boundary at %s", async (instant) => {
    await expect(reserve(new Date(instant))).rejects.toMatchObject({ code: "PROVIDER_BUDGET_BOUNDARY" });
    expect(await ledger()).toHaveLength(0);
  });

  it("uses the database clock when application clocks are not injected", async () => {
    const before = new Date((await pool.query("SELECT clock_timestamp() AS time")).rows[0].time);
    const lease = await repository.acquire("the-odds-api");
    expect(lease!.now.getTime()).toBeGreaterThanOrEqual(before.getTime());
    const after = new Date((await pool.query("SELECT clock_timestamp() AS time")).rows[0].time);
    expect(lease!.now.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("measures full paid unchanged refresh SQL and physical row mutations for 32 games / 384 quotes", async () => {
    let used = 0;
    const base = snapshot(start, 32);
    const provider: OddsProvider = { name: "the-odds-api", async fetchSnapshot(now, guard) {
      await guard!.beforePaidRequest({ ...quota, used });
      used += 3;
      const receipt = { used, remaining: 500 - used, lastCost: 3 };
      await guard!.afterPaidResponse(receipt);
      return { ...base, fetchedAt: now.toISOString(), quota: receipt };
    } };
    await syncOdds(provider, repository, () => start);
    await pool.query("TRUNCATE test_row_mutations");
    queries.length = 0;
    await syncOdds(provider, repository, () => at(21_600));
    const statements = queries.length;
    const mutations = (await pool.query("SELECT table_name, operation, count(*)::int AS count FROM test_row_mutations GROUP BY table_name, operation ORDER BY table_name, operation")).rows;
    console.log("UNCHANGED_PAID_REFRESH", JSON.stringify({ games: 32, quotes: 384, statements, mutations }));
    expect(mutations).toEqual([
      { table_name: "odds_provider_budget", operation: "UPDATE", count: 1 },
      { table_name: "odds_provider_requests", operation: "INSERT", count: 1 },
      { table_name: "odds_provider_requests", operation: "UPDATE", count: 1 },
      { table_name: "odds_sync_state", operation: "UPDATE", count: 2 },
    ]);
    expect(statements).toBe(19);

    await pool.query("TRUNCATE test_row_mutations");
    queries.length = 0;
    expect((await syncOdds(provider, repository, () => at(21_601))).status).toBe("skipped");
    expect(queries).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM test_row_mutations")).rows[0].count).toBe(0);
    expect(used).toBe(6);
  });
});
