import "server-only";

import type { ProviderName, ProviderQuota, ProviderSnapshot } from "../domain/odds";
import { MockOddsProvider } from "./mock-odds-provider";
import { TheOddsApiProvider } from "./the-odds-api";
import { ProviderError } from "./provider-error";

export { ProviderError } from "./provider-error";
export type { ProviderErrorCode } from "./provider-error";

export interface PaidRequestGuard {
  /** Commit a durable reservation before any paid HTTP request is sent. */
  beforePaidRequest(quota: ProviderQuota): Promise<void>;
  /** Record a confirmed response; absent/invalid receipts stay conservatively charged. */
  afterPaidResponse(quota: ProviderQuota): Promise<void>;
}

export interface OddsProvider {
  readonly name: ProviderName;
  fetchSnapshot(now: Date, guard?: PaidRequestGuard): Promise<ProviderSnapshot>;
}

export function configuredProviderName(): ProviderName {
  const name = process.env.ODDS_PROVIDER ?? "mock";
  if (name !== "mock" && name !== "the-odds-api") throw new ProviderError("PROVIDER_CONFIGURATION");
  return name;
}

export function createOddsProvider(): OddsProvider {
  if (configuredProviderName() === "mock") return new MockOddsProvider();
  const reserve = process.env.ODDS_CREDIT_RESERVE ?? "25";
  if (!/^\d+$/.test(reserve) || !Number.isSafeInteger(Number(reserve))) {
    throw new ProviderError("PROVIDER_CONFIGURATION");
  }
  return new TheOddsApiProvider({ apiKey: process.env.ODDS_API_KEY, creditReserve: Number(reserve) });
}
