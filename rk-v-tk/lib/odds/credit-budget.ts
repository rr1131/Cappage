import "server-only";

import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import { oddsProviderBudget as budgets, oddsProviderRequests as requests, oddsSyncState as sync } from "../db/schema";
import { billingPeriod, easternDay, parseBillingAnchor } from "../domain/odds-budget";
import { easternWindowEnd } from "../domain/odds-window";
import type { ProviderName, ProviderQuota } from "../domain/odds";
import { OddsError } from "./errors";
import type { OddsSettings } from "./settings";

const deny = (code: string) => new OddsError(code, "The shared odds refresh budget is unavailable. Cached prices remain available.", 503);
const validCount = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;

export function creditBudget(db: PgDatabase<PgQueryResultHKT, typeof schema>, settings: OddsSettings) {
  // Only tests supply now. Production uses PostgreSQL's clock across instances.
  async function reserve(provider: ProviderName, token: string, quota: ProviderQuota, now?: Date) {
    if (provider !== "the-odds-api" || !settings.billingAnchor) throw deny("PROVIDER_CONFIGURATION");
    const anchor = parseBillingAnchor(settings.billingAnchor);
    if (!validCount(quota.used) || !validCount(quota.remaining) || quota.remaining < settings.creditReserve + 3) {
      throw deny("PROVIDER_QUOTA_EXHAUSTED");
    }
    await db.transaction(async (tx) => {
      const [locked] = await tx.select({ state: sync, time: now ? sql<string>`${now.toISOString()}::timestamptz::text` : sql<string>`clock_timestamp()::text` })
        .from(sync).where(eq(sync.provider, provider)).for("update");
      const time = new Date(locked?.time ?? NaN);
      if (!locked || locked.state.leaseToken !== token || !locked.state.leaseUntil || locked.state.leaseUntil <= time) {
        throw deny("SYNC_LEASE_LOST");
      }
      const period = billingPeriod(time, anchor);
      const day = easternDay(time);
      // Leave more than the provider's 10-second timeout before a counter resets.
      // This avoids dispatching an ordinary in-flight request across a boundary.
      if (Math.min(period.end.getTime(), easternWindowEnd(time, 1).getTime()) - time.getTime() <= 120_000) {
        throw deny("PROVIDER_BUDGET_BOUNDARY");
      }
      await tx.insert(budgets).values({ provider, billingAnchor: anchor, periodStart: period.start, periodEnd: period.end,
        day, monthlyCreditCap: settings.monthlyCreditCap, dailyPaidRefreshLimit: settings.dailyPaidRefreshLimit }).onConflictDoNothing();
      const [budget] = await tx.select().from(budgets).where(eq(budgets.provider, provider)).for("update");
      // Changing a deployed anchor cannot create a new allowance mid-period.
      if (budget.billingAnchor.getTime() !== anchor.getTime() || time < budget.periodStart) throw deny("PROVIDER_CONFIGURATION");
      const credits = Math.max(time >= budget.periodEnd ? 0 : budget.creditsCharged, quota.used!);
      const daily = budget.day === day ? budget.dailyPaidRefreshes : 0;
      const cap = Math.min(settings.monthlyCreditCap, budget.monthlyCreditCap);
      const dailyLimit = Math.min(settings.dailyPaidRefreshLimit, budget.dailyPaidRefreshLimit);
      if (credits + 3 > cap) throw deny("PROVIDER_MONTHLY_LIMIT");
      if (daily + 1 > dailyLimit) throw deny("PROVIDER_DAILY_LIMIT");
      if (budget.nextPaidAttemptAt && time < budget.nextPaidAttemptAt) throw deny("PROVIDER_REFRESH_NOT_DUE");
      await tx.update(budgets).set({ periodStart: period.start, periodEnd: period.end,
        creditsCharged: credits + 3, day, dailyPaidRefreshes: daily + 1,
        monthlyCreditCap: cap, dailyPaidRefreshLimit: dailyLimit,
        nextPaidAttemptAt: new Date(time.getTime() + Math.max(21_600, settings.refreshSeconds) * 1000),
      }).where(eq(budgets.provider, provider));
      const inserted = await tx.insert(requests).values({ id: token, provider, periodStart: period.start, day, requestedAt: time })
        .onConflictDoNothing().returning({ id: requests.id });
      // Reusing a reservation must never authorize a second external request.
      if (!inserted.length) throw deny("PAID_REQUEST_ALREADY_RESERVED");
    });
  }

  async function confirm(provider: ProviderName, token: string, quota: ProviderQuota) {
    if (!validCount(quota.lastCost) || quota.lastCost > 3 || !validCount(quota.used)) return;
    await db.transaction(async (tx) => {
      // Match the reservation lock order. Reconciliation is idempotent, and an
      // old response can only adjust the period in which it was reserved.
      await tx.select({ provider: budgets.provider }).from(budgets).where(eq(budgets.provider, provider)).for("update");
      const [receipt] = await tx.update(requests).set({ chargedCredits: quota.lastCost!, status: "confirmed",
        confirmedAt: sql`clock_timestamp()`, providerUsed: quota.used,
      }).where(and(eq(requests.provider, provider), eq(requests.id, token), eq(requests.status, "uncertain")))
        .returning({ periodStart: requests.periodStart });
      if (!receipt) return;
      const charged = sql`greatest(0, ${budgets.creditsCharged} - ${3 - quota.lastCost!}, ${quota.used})`;
      await tx.update(budgets).set({ creditsCharged: charged })
        .where(and(eq(budgets.provider, provider), eq(budgets.periodStart, receipt.periodStart),
          sql`${budgets.creditsCharged} IS DISTINCT FROM ${charged}`));
    });
  }

  return { reserve, confirm };
}
