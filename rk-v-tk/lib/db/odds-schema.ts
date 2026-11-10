import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, numeric, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true });

export const nflGames = pgTable("nfl_games", {
  id: uuid("id").defaultRandom().primaryKey(),
  homeTeamId: text("home_team_id").notNull(),
  awayTeamId: text("away_team_id").notNull(),
  startsAt: time("starts_at").notNull(),
  status: text("status", { enum: ["scheduled", "unavailable"] }).notNull().default("scheduled"),
  seasonYear: integer("season_year").notNull(),
  seasonSource: text("season_source", { enum: ["derived"] }).notNull().default("derived"),
  lastSeenAt: time("last_seen_at").notNull(),
  createdAt: time("created_at").defaultNow().notNull(),
  updatedAt: time("updated_at").defaultNow().notNull(),
}, (t) => [
  index("nfl_games_start_idx").on(t.startsAt),
  check("nfl_games_distinct_teams", sql`${t.homeTeamId} <> ${t.awayTeamId}`),
  check("nfl_games_status", sql`${t.status} IN ('scheduled', 'unavailable')`),
  check("nfl_games_season_source", sql`${t.seasonSource} = 'derived'`),
]);

export const nflGameProviderIds = pgTable("nfl_game_provider_ids", {
  provider: text("provider", { enum: ["mock", "the-odds-api"] }).notNull(),
  providerEventId: text("provider_event_id").notNull(),
  gameId: uuid("game_id").notNull().references(() => nflGames.id, { onDelete: "cascade" }),
}, (t) => [
  primaryKey({ columns: [t.provider, t.providerEventId] }),
  unique("nfl_game_provider_game_unique").on(t.provider, t.gameId),
  check("nfl_game_provider_name", sql`${t.provider} IN ('mock', 'the-odds-api')`),
]);

export const nflCurrentOdds = pgTable("nfl_current_odds", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider", { enum: ["mock", "the-odds-api"] }).notNull(),
  gameId: uuid("game_id").notNull(),
  bookmaker: text("bookmaker", { enum: ["draftkings", "fanduel"] }).notNull(),
  market: text("market", { enum: ["h2h", "spreads", "totals"] }).notNull(),
  selection: text("selection", { enum: ["home", "away", "over", "under"] }).notNull(),
  point: numeric("point", { precision: 7, scale: 2, mode: "number" }),
  americanOdds: integer("american_odds").notNull(),
  providerUpdatedAt: time("provider_updated_at").notNull(),
  ingestedAt: time("ingested_at").notNull(),
  available: boolean("available").default(true).notNull(),
  unavailableAt: time("unavailable_at"),
  revision: integer("revision").default(1).notNull(),
}, (t) => [
  unique("nfl_odds_slot_unique").on(t.provider, t.gameId, t.bookmaker, t.market, t.selection),
  foreignKey({ columns: [t.provider, t.gameId], foreignColumns: [nflGameProviderIds.provider, nflGameProviderIds.gameId] }).onDelete("cascade"),
  check("nfl_odds_book", sql`${t.bookmaker} IN ('draftkings', 'fanduel')`),
  check("nfl_odds_price", sql`${t.americanOdds} <= -100 OR ${t.americanOdds} >= 100`),
  check("nfl_odds_revision", sql`${t.revision} > 0`),
  check("nfl_odds_selection", sql`(
    (${t.market} = 'h2h' AND ${t.selection} IN ('home', 'away') AND ${t.point} IS NULL) OR
    (${t.market} = 'spreads' AND ${t.selection} IN ('home', 'away') AND ${t.point} IS NOT NULL) OR
    (${t.market} = 'totals' AND ${t.selection} IN ('over', 'under') AND ${t.point} IS NOT NULL AND ${t.point} > 0)
  )`),
]);

export const oddsSyncState = pgTable("odds_sync_state", {
  provider: text("provider", { enum: ["mock", "the-odds-api"] }).primaryKey(),
  leaseToken: uuid("lease_token"),
  leaseUntil: time("lease_until"),
  lastAttemptAt: time("last_attempt_at"),
  lastSuccessAt: time("last_success_at"),
  snapshotAt: time("snapshot_at"),
  nextRefreshAt: time("next_refresh_at"),
  failures: integer("failures").default(0).notNull(),
  lastError: text("last_error"),
  quotaRemaining: integer("quota_remaining"),
  quotaUsed: integer("quota_used"),
  quotaLastCost: integer("quota_last_cost"),
  warningsCount: integer("warnings_count").default(0).notNull(),
}, (t) => [check("odds_sync_provider_name", sql`${t.provider} IN ('mock', 'the-odds-api')`)]);

// One shared account budget. Every instance using this API allocation must use
// this database. Limits can be tightened by runtime config, never silently raised.
export const oddsProviderBudget = pgTable("odds_provider_budget", {
  provider: text("provider").primaryKey(),
  billingAnchor: time("billing_anchor").notNull(),
  periodStart: time("period_start").notNull(),
  periodEnd: time("period_end").notNull(),
  creditsCharged: integer("credits_charged").default(0).notNull(),
  monthlyCreditCap: integer("monthly_credit_cap").notNull(),
  dailyPaidRefreshLimit: integer("daily_paid_refresh_limit").notNull(),
  day: text("day").notNull(),
  dailyPaidRefreshes: integer("daily_paid_refreshes").default(0).notNull(),
  nextPaidAttemptAt: time("next_paid_attempt_at"),
}, (t) => [
  check("odds_budget_provider", sql`${t.provider} = 'the-odds-api'`),
  check("odds_budget_limits", sql`${t.monthlyCreditCap} BETWEEN 0 AND 300 AND ${t.dailyPaidRefreshLimit} BETWEEN 0 AND 3`),
  check("odds_budget_counts", sql`${t.creditsCharged} >= 0 AND ${t.dailyPaidRefreshes} BETWEEN 0 AND 3`),
  check("odds_budget_period", sql`${t.periodStart} < ${t.periodEnd}`),
]);

export const oddsProviderRequests = pgTable("odds_provider_requests", {
  id: uuid("id").primaryKey(),
  provider: text("provider").notNull().references(() => oddsProviderBudget.provider),
  periodStart: time("period_start").notNull(),
  day: text("day").notNull(),
  requestedAt: time("requested_at").notNull(),
  chargedCredits: integer("charged_credits").default(3).notNull(),
  status: text("status", { enum: ["uncertain", "confirmed"] }).default("uncertain").notNull(),
  confirmedAt: time("confirmed_at"),
  providerUsed: integer("provider_used"),
}, (t) => [
  index("odds_requests_period_idx").on(t.provider, t.periodStart),
  check("odds_request_cost", sql`${t.chargedCredits} BETWEEN 0 AND 3`),
  check("odds_request_status", sql`${t.status} IN ('uncertain', 'confirmed')`),
]);
