import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, getTableColumns, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import { nflGames as games, nflGameProviderIds as mappings, nflCurrentOdds as odds, oddsSyncState as sync } from "../db/schema";
import { americanToDecimal, BOOKMAKERS, MARKETS, type ProviderName, type ProviderSnapshot } from "../domain/odds";
import { NFL_TEAMS } from "../domain/nfl-teams";
import { easternWindowEnd } from "../domain/odds-window";
import { OddsError } from "./errors";
import type { OddsSettings } from "./settings";
import { creditBudget } from "./credit-budget";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
type GameRow = typeof games.$inferSelect;
const milliseconds = (seconds: number) => seconds * 1000;
const slot = (q: { gameId: string; bookmaker: string; market: string; selection: string }) =>
  `${q.gameId}/${q.bookmaker}/${q.market}/${q.selection}`;

function serializeGame(game: GameRow) {
  return {
    id: game.id,
    homeTeam: NFL_TEAMS[game.homeTeamId],
    awayTeam: NFL_TEAMS[game.awayTeamId],
    startsAt: game.startsAt.toISOString(),
    status: game.status,
    league: "NFL" as const,
    seasonYear: game.seasonYear,
    seasonSource: game.seasonSource,
  };
}

export function oddsRepository(db: Database, settings: OddsSettings) {
  async function metadata(provider: ProviderName, now: Date) {
    const [state] = await db.select().from(sync).where(eq(sync.provider, provider));
    if (!state?.lastSuccessAt) throw new OddsError("ODDS_NOT_SYNCED", "NFL odds are not available yet. Please try again later.", 503);
    return {
      provider, isMock: provider === "mock", asOf: now.toISOString(),
      lastSuccessAt: state.lastSuccessAt.toISOString(),
      lastAttemptAt: state.lastAttemptAt?.toISOString() ?? null,
      nextRefreshAt: state.nextRefreshAt?.toISOString() ?? null,
      stale: now.getTime() - state.lastSuccessAt.getTime() >= milliseconds(settings.freshSeconds),
      refreshError: state.lastError,
    };
  }

  async function listGames(provider: ProviderName, now: Date, days: number) {
    const meta = await metadata(provider, now);
    const rows = await db.select({ game: games }).from(games).innerJoin(mappings, eq(mappings.gameId, games.id))
      .where(and(eq(mappings.provider, provider), eq(games.status, "scheduled"), gt(games.startsAt, now),
        lt(games.startsAt, easternWindowEnd(now, days))))
      .orderBy(asc(games.startsAt), asc(games.id)).limit(256);
    return { games: rows.map(({ game }) => serializeGame(game)), meta };
  }

  async function gameOdds(provider: ProviderName, gameId: string, now: Date) {
    const [row] = await db.select({ game: games }).from(games).innerJoin(mappings, eq(mappings.gameId, games.id))
      .where(and(eq(games.id, gameId), eq(mappings.provider, provider))).limit(1);
    if (!row || row.game.status !== "scheduled") throw new OddsError("GAME_NOT_FOUND", "This game is not available.", 404);
    if (row.game.startsAt <= now) throw new OddsError("GAME_STARTED", "Pregame odds are no longer available for this game.", 409);
    const meta = await metadata(provider, now);
    const cutoff = new Date(now.getTime() - milliseconds(settings.maxAgeSeconds));
    const rows = await db.select().from(odds).where(and(eq(odds.provider, provider), eq(odds.gameId, gameId),
      eq(odds.available, true), gt(odds.providerUpdatedAt, cutoff), gt(odds.ingestedAt, cutoff)))
      .orderBy(asc(odds.bookmaker), asc(odds.market), asc(odds.selection));
    const quotes = rows.map((q) => ({
      id: q.id, revision: q.revision, gameId, bookmaker: q.bookmaker, market: q.market, selection: q.selection,
      point: q.point, americanOdds: q.americanOdds, decimalOdds: americanToDecimal(q.americanOdds),
      providerUpdatedAt: q.providerUpdatedAt.toISOString(), ingestedAt: q.ingestedAt.toISOString(),
      freshUntil: new Date(Math.min(q.providerUpdatedAt.getTime(), q.ingestedAt.getTime()) + milliseconds(settings.freshSeconds)).toISOString(),
      expiresAt: new Date(Math.min(row.game.startsAt.getTime(), Math.min(q.providerUpdatedAt.getTime(), q.ingestedAt.getTime()) + milliseconds(settings.maxAgeSeconds))).toISOString(),
      stale: Math.max(now.getTime() - q.providerUpdatedAt.getTime(), now.getTime() - q.ingestedAt.getTime()) >= milliseconds(settings.freshSeconds),
    }));
    const markets = BOOKMAKERS.flatMap((bookmaker) => MARKETS.map((market) => {
      const found = quotes.filter((q) => q.bookmaker === bookmaker && q.market === market);
      return { bookmaker, market, available: found.length > 0, complete: found.length === 2 };
    }));
    return { game: serializeGame(row.game), quotes, markets, meta: { ...meta, stale: meta.stale || quotes.some((q) => q.stale) } };
  }

  // Explicit times are an integration-test seam. Production callers use the
  // shared PostgreSQL clock, so Amplify instance clock skew cannot bypass pacing.
  const refreshInterval = (provider: ProviderName) => provider === "the-odds-api" ? Math.max(21_600, settings.refreshSeconds) : settings.refreshSeconds;
  const databaseNow = (now?: Date) => now ? sql`${now.toISOString()}::timestamptz` : sql`statement_timestamp()`;

  async function acquire(provider: ProviderName, now?: Date) {
    const time = databaseNow(now);
    const token = randomUUID();
    const values = { leaseToken: token, leaseUntil: sql`${time} + interval '120 seconds'`, lastAttemptAt: time,
      nextRefreshAt: sql`${time} + ${refreshInterval(provider)} * interval '1 second'` };
    const [state] = await db.insert(sync).values({ provider, ...values }).onConflictDoUpdate({
      target: sync.provider,
      set: values,
      setWhere: and(or(isNull(sync.leaseUntil), lte(sync.leaseUntil, time)),
        or(isNull(sync.nextRefreshAt), lte(sync.nextRefreshAt, time)),
        or(isNull(sync.lastSuccessAt), lte(sync.lastSuccessAt, sql`${time} - ${refreshInterval(provider)} * interval '1 second'`))),
    }).returning();
    return state ? { token, failures: state.failures, now: state.lastAttemptAt! } : null;
  }

  async function fail(provider: ProviderName, token: string, now: Date | undefined, code: string, delaySeconds: number) {
    await db.update(sync).set({ leaseToken: null, leaseUntil: null, lastError: code,
      failures: sql`${sync.failures} + 1`,
      nextRefreshAt: sql`greatest(${sync.nextRefreshAt}, ${databaseNow(now)} + ${delaySeconds} * interval '1 second')` })
      .where(and(eq(sync.provider, provider), eq(sync.leaseToken, token)));
  }

  async function save(provider: ProviderName, token: string, snapshot: ProviderSnapshot, suppliedNow?: Date) {
    return db.transaction(async (tx) => {
      const [state] = await tx.select({ ...getTableColumns(sync),
        databaseNow: sql<string>`${databaseNow(suppliedNow)}::text`,
      }).from(sync).where(eq(sync.provider, provider)).for("update");
      const now = state && new Date(state.databaseNow);
      if (!state || !now || state.leaseToken !== token || !state.leaseUntil || state.leaseUntil <= now) {
        throw new OddsError("SYNC_LEASE_LOST", "The sync lease has expired or was replaced.", 409);
      }
      const snapshotAt = new Date(snapshot.fetchedAt);
      if (!Number.isFinite(snapshotAt.getTime()) || snapshotAt > now || (state.snapshotAt && snapshotAt < state.snapshotAt)) {
        throw new OddsError("STALE_SNAPSHOT", "Ignoring an out-of-order snapshot.", 409);
      }
      // Historical unavailable games need neither a read nor another UPDATE on
      // each refresh. Incoming IDs still find their stable application UUID.
      const incomingIds = [...new Set(snapshot.games.map((game) => game.providerEventId))];
      const existingGames = await tx.select({ mapping: mappings, game: games }).from(mappings)
        .innerJoin(games, eq(games.id, mappings.gameId)).where(and(eq(mappings.provider, provider),
          or(eq(games.status, "scheduled"), incomingIds.length ? inArray(mappings.providerEventId, incomingIds) : undefined)));
      const byProviderId = new Map(existingGames.map((row) => [row.mapping.providerEventId, row.game]));
      const gameIds = new Map<string, string>();
      const gameWrites: (typeof games.$inferInsert)[] = [];
      const mappingWrites: (typeof mappings.$inferInsert)[] = [];
      for (const game of snapshot.games) {
        if (!Object.hasOwn(NFL_TEAMS, game.homeTeamId) || !Object.hasOwn(NFL_TEAMS, game.awayTeamId) || game.homeTeamId === game.awayTeamId) {
          throw new OddsError("INVALID_SNAPSHOT", "Invalid event identity.", 503);
        }
        const duplicate = gameIds.get(game.providerEventId);
        if (duplicate) continue;
        const startsAt = new Date(game.startsAt);
        if (!Number.isFinite(startsAt.getTime())) throw new OddsError("INVALID_SNAPSHOT", "Invalid event time.", 503);
        if (startsAt <= now) continue;
        const existing = byProviderId.get(game.providerEventId);
        if (existing && (existing.homeTeamId !== game.homeTeamId || existing.awayTeamId !== game.awayTeamId)) {
          throw new OddsError("INVALID_SNAPSHOT", "Provider changed an event's team identities.", 503);
        }
        const id = existing?.id ?? randomUUID();
        gameIds.set(game.providerEventId, id);
        if (!existing || existing.startsAt.getTime() !== startsAt.getTime() || existing.status !== "scheduled"
          || existing.seasonYear !== game.seasonYear || existing.seasonSource !== game.seasonSource) {
          gameWrites.push({ id, homeTeamId: game.homeTeamId, awayTeamId: game.awayTeamId, startsAt,
            status: "scheduled", seasonYear: game.seasonYear, seasonSource: game.seasonSource, lastSeenAt: now, updatedAt: now });
        }
        if (!existing) mappingWrites.push({ provider, providerEventId: game.providerEventId, gameId: id });
      }
      if (gameWrites.length) await tx.insert(games).values(gameWrites).onConflictDoUpdate({ target: games.id,
        set: { startsAt: sql`excluded.starts_at`, status: sql`excluded.status`, seasonYear: sql`excluded.season_year`,
          seasonSource: sql`excluded.season_source`, lastSeenAt: sql`excluded.last_seen_at`, updatedAt: sql`excluded.updated_at` },
        setWhere: sql`(${games.startsAt}, ${games.status}, ${games.seasonYear}, ${games.seasonSource})
          IS DISTINCT FROM (excluded.starts_at, excluded.status, excluded.season_year, excluded.season_source)`,
      });
      if (mappingWrites.length) await tx.insert(mappings).values(mappingWrites).onConflictDoNothing();
      const missingGames = existingGames.filter(({ mapping, game }) => game.status === "scheduled" && !gameIds.has(mapping.providerEventId))
        .map(({ game }) => game.id);
      if (missingGames.length) await tx.update(games).set({ status: "unavailable", updatedAt: now })
        .where(and(inArray(games.id, missingGames), eq(games.status, "scheduled")));

      const existingOdds = await tx.select().from(odds).where(eq(odds.provider, provider));
      const bySlot = new Map(existingOdds.map((q) => [slot(q), q]));
      const observedSlots = new Set<string>();
      const quoteWrites: (typeof odds.$inferInsert)[] = [];
      const cutoff = new Date(now.getTime() - milliseconds(settings.maxAgeSeconds));
      for (const quote of snapshot.quotes) {
        const gameId = gameIds.get(quote.providerEventId);
        if (!gameId) continue;
        const key = slot({ ...quote, gameId });
        if (observedSlots.has(key)) throw new OddsError("INVALID_SNAPSHOT", "Duplicate quote selection.", 503);
        observedSlots.add(key);
        const old = bySlot.get(key);
        const providerUpdatedAt = new Date(quote.providerUpdatedAt);
        if (!Number.isFinite(providerUpdatedAt.getTime()) || providerUpdatedAt > now) throw new OddsError("INVALID_SNAPSHOT", "Invalid quote timestamp.", 503);
        // The provider timestamp already bounds freshness: repeatedly observing
        // the identical quote must not churn its row or extend its lifetime.
        if (providerUpdatedAt <= cutoff || (old && (providerUpdatedAt <= old.providerUpdatedAt
          || (old.unavailableAt && providerUpdatedAt <= old.unavailableAt)))) continue;
        const changed = old && (old.americanOdds !== quote.americanOdds || old.point !== quote.point || !old.available);
        quoteWrites.push({ id: old?.id ?? randomUUID(), provider, gameId, bookmaker: quote.bookmaker,
          market: quote.market, selection: quote.selection, point: quote.point, americanOdds: quote.americanOdds,
          providerUpdatedAt, ingestedAt: now, available: true, unavailableAt: null,
          revision: old ? old.revision + (changed ? 1 : 0) : 1 });
      }
      if (quoteWrites.length) await tx.insert(odds).values(quoteWrites).onConflictDoUpdate({
        target: [odds.provider, odds.gameId, odds.bookmaker, odds.market, odds.selection],
        set: { point: sql`excluded.point`, americanOdds: sql`excluded.american_odds`,
          providerUpdatedAt: sql`excluded.provider_updated_at`, ingestedAt: sql`excluded.ingested_at`,
          available: true, unavailableAt: null, revision: sql`excluded.revision` },
        setWhere: and(lt(odds.providerUpdatedAt, sql`excluded.provider_updated_at`),
          or(isNull(odds.unavailableAt), lt(odds.unavailableAt, sql`excluded.provider_updated_at`))),
      });
      const missingQuotes = existingOdds.filter((quote) => quote.available && !observedSlots.has(slot(quote))).map((quote) => quote.id);
      if (missingQuotes.length) await tx.update(odds).set({ available: false, unavailableAt: now, revision: sql`${odds.revision} + 1` })
        .where(and(eq(odds.provider, provider), eq(odds.available, true), inArray(odds.id, missingQuotes)));
      // Avoid a DELETE round trip when no rows can have expired. Never delete a
      // quote refreshed in this transaction using its prior timestamp.
      const written = new Set(quoteWrites.map((quote) => quote.id));
      const removed = new Set(missingQuotes);
      const expired = existingOdds.filter((quote) => !written.has(quote.id) && !removed.has(quote.id)
        && (quote.available ? (quote.providerUpdatedAt <= cutoff || quote.ingestedAt <= cutoff)
          : (quote.unavailableAt ?? quote.ingestedAt) <= cutoff)).map((quote) => quote.id);
      if (expired.length) await tx.delete(odds).where(and(eq(odds.provider, provider), inArray(odds.id, expired)));
      await tx.update(sync).set({ leaseToken: null, leaseUntil: null, lastSuccessAt: now, snapshotAt,
        nextRefreshAt: new Date(now.getTime() + milliseconds(refreshInterval(provider))), failures: 0, lastError: null,
        quotaRemaining: snapshot.quota.remaining, quotaUsed: snapshot.quota.used, quotaLastCost: snapshot.quota.lastCost,
        warningsCount: snapshot.warnings.length }).where(eq(sync.provider, provider));
      return { games: gameIds.size, quotes: observedSlots.size, warnings: snapshot.warnings.length };
    });
  }

  const budget = creditBudget(db, settings);
  return { listGames, gameOdds, acquire, fail, save, reservePaidRequest: budget.reserve, confirmPaidRequest: budget.confirm };
}
