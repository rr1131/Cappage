import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import { nflGames as games, nflGameProviderIds as mappings, nflCurrentOdds as odds, oddsSyncState as sync } from "../db/schema";
import { americanToDecimal, BOOKMAKERS, MARKETS, type ProviderName, type ProviderSnapshot } from "../domain/odds";
import { NFL_TEAMS } from "../domain/nfl-teams";
import { easternWindowEnd } from "../domain/odds-window";
import { OddsError } from "./errors";
import type { OddsSettings } from "./settings";

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

  async function acquire(provider: ProviderName, now: Date) {
    await db.insert(sync).values({ provider }).onConflictDoNothing();
    const token = randomUUID();
    const [state] = await db.update(sync).set({ leaseToken: token, leaseUntil: new Date(now.getTime() + 120_000), lastAttemptAt: now })
      .where(and(eq(sync.provider, provider), or(isNull(sync.leaseUntil), lte(sync.leaseUntil, now)),
        or(isNull(sync.nextRefreshAt), lte(sync.nextRefreshAt, now)))).returning();
    return state ? { token, failures: state.failures } : null;
  }

  async function fail(provider: ProviderName, token: string, now: Date, code: string, delaySeconds: number) {
    await db.update(sync).set({ leaseToken: null, leaseUntil: null, lastError: code,
      failures: sql`${sync.failures} + 1`, nextRefreshAt: new Date(now.getTime() + milliseconds(delaySeconds)) })
      .where(and(eq(sync.provider, provider), eq(sync.leaseToken, token)));
  }

  async function save(provider: ProviderName, token: string, snapshot: ProviderSnapshot, now: Date) {
    return db.transaction(async (tx) => {
      const [state] = await tx.select().from(sync).where(eq(sync.provider, provider)).for("update");
      if (!state || state.leaseToken !== token || !state.leaseUntil || state.leaseUntil <= now) {
        throw new OddsError("SYNC_LEASE_LOST", "The sync lease has expired or was replaced.", 409);
      }
      const snapshotAt = new Date(snapshot.fetchedAt);
      if (!Number.isFinite(snapshotAt.getTime()) || snapshotAt > now || (state.snapshotAt && snapshotAt < state.snapshotAt)) {
        throw new OddsError("STALE_SNAPSHOT", "Ignoring an out-of-order snapshot.", 409);
      }
      const existingMappings = await tx.select().from(mappings).where(eq(mappings.provider, provider));
      const byProviderId = new Map(existingMappings.map((m) => [m.providerEventId, m.gameId]));
      const gameIds = new Map<string, string>();
      for (const game of snapshot.games) {
        if (gameIds.has(game.providerEventId)) continue;
        if (!NFL_TEAMS[game.homeTeamId] || !NFL_TEAMS[game.awayTeamId] || game.homeTeamId === game.awayTeamId) {
          throw new OddsError("INVALID_SNAPSHOT", "Invalid event identity.", 503);
        }
        const startsAt = new Date(game.startsAt);
        if (!Number.isFinite(startsAt.getTime())) throw new OddsError("INVALID_SNAPSHOT", "Invalid event time.", 503);
        if (startsAt <= now) continue;
        const values = { homeTeamId: game.homeTeamId, awayTeamId: game.awayTeamId, startsAt,
          status: "scheduled" as const, seasonYear: game.seasonYear, seasonSource: game.seasonSource, lastSeenAt: now, updatedAt: now };
        let id = byProviderId.get(game.providerEventId);
        if (id) {
          const [existing] = await tx.select().from(games).where(eq(games.id, id));
          if (existing.homeTeamId !== game.homeTeamId || existing.awayTeamId !== game.awayTeamId) {
            throw new OddsError("INVALID_SNAPSHOT", "Provider changed an event's team identities.", 503);
          }
          await tx.update(games).set(values).where(eq(games.id, id));
        } else {
          const [created] = await tx.insert(games).values(values).returning({ id: games.id });
          id = created.id;
          await tx.insert(mappings).values({ provider, providerEventId: game.providerEventId, gameId: id });
        }
        gameIds.set(game.providerEventId, id);
      }
      const missing = existingMappings.filter((m) => !gameIds.has(m.providerEventId)).map((m) => m.gameId);
      if (missing.length) await tx.update(games).set({ status: "unavailable", updatedAt: now }).where(inArray(games.id, missing));

      const existingOdds = await tx.select().from(odds).where(eq(odds.provider, provider));
      const bySlot = new Map(existingOdds.map((q) => [slot(q), q]));
      const seen = new Set<string>();
      const observedSlots = new Set<string>();
      for (const quote of snapshot.quotes) {
        const gameId = gameIds.get(quote.providerEventId);
        if (!gameId) continue;
        const key = slot({ ...quote, gameId });
        if (observedSlots.has(key)) throw new OddsError("INVALID_SNAPSHOT", "Duplicate quote selection.", 503);
        observedSlots.add(key);
        const old = bySlot.get(key);
        const providerUpdatedAt = new Date(quote.providerUpdatedAt);
        if (!Number.isFinite(providerUpdatedAt.getTime()) || providerUpdatedAt > now) throw new OddsError("INVALID_SNAPSHOT", "Invalid quote timestamp.", 503);
        if (old) {
          seen.add(old.id);
          const changed = old.americanOdds !== quote.americanOdds || old.point !== quote.point || !old.available;
          // An old provider timestamp must neither change the price nor revive a
          // removed market. Equal, identical observations may renew ingestion age.
          if (providerUpdatedAt < old.providerUpdatedAt || (changed && providerUpdatedAt <= old.providerUpdatedAt)) continue;
          await tx.update(odds).set({ point: quote.point, americanOdds: quote.americanOdds, providerUpdatedAt,
            ingestedAt: now, available: true, revision: changed ? old.revision + 1 : old.revision }).where(eq(odds.id, old.id));
        } else {
          const [created] = await tx.insert(odds).values({ provider, gameId, bookmaker: quote.bookmaker,
            market: quote.market, selection: quote.selection, point: quote.point, americanOdds: quote.americanOdds,
            providerUpdatedAt, ingestedAt: now }).returning({ id: odds.id });
          seen.add(created.id);
        }
      }
      await tx.update(odds).set({ available: false, revision: sql`${odds.revision} + 1` }).where(and(
        eq(odds.provider, provider), eq(odds.available, true), seen.size ? notInArray(odds.id, [...seen]) : undefined));
      const cutoff = new Date(now.getTime() - milliseconds(settings.maxAgeSeconds));
      await tx.delete(odds).where(and(eq(odds.provider, provider), or(lte(odds.providerUpdatedAt, cutoff), lte(odds.ingestedAt, cutoff))));
      await tx.update(sync).set({ leaseToken: null, leaseUntil: null, lastSuccessAt: now, snapshotAt,
        nextRefreshAt: new Date(now.getTime() + milliseconds(settings.refreshSeconds)), failures: 0, lastError: null,
        quotaRemaining: snapshot.quota.remaining, quotaUsed: snapshot.quota.used, quotaLastCost: snapshot.quota.lastCost,
        warningsCount: snapshot.warnings.length }).where(eq(sync.provider, provider));
      return { games: gameIds.size, quotes: observedSlots.size, warnings: snapshot.warnings.length };
    });
  }

  return { listGames, gameOdds, acquire, fail, save };
}
