import "server-only";

import { ProviderError, type OddsProvider } from "../providers/odds-provider";
import { OddsError } from "./errors";
import type { oddsRepository } from "./repository";

export async function syncOdds(provider: OddsProvider, repository: ReturnType<typeof oddsRepository>, clock: () => Date = () => new Date()) {
  const lease = await repository.acquire(provider.name, clock());
  if (!lease) return { status: "skipped" as const, reason: "Refresh is not due or another sync is running." };
  try {
    const snapshot = await provider.fetchSnapshot(clock());
    const counts = await repository.save(provider.name, lease.token, snapshot, clock());
    return { status: "updated" as const, ...counts };
  } catch (error) {
    const code = error instanceof ProviderError || error instanceof OddsError ? error.code : "SYNC_UNAVAILABLE";
    const retryAfter = error instanceof ProviderError ? error.retryAfterSeconds ?? 0 : 0;
    const backoff = Math.min(3600, 60 * 2 ** Math.min(lease.failures, 6));
    const delay = code === "PROVIDER_QUOTA_EXHAUSTED" || code === "PROVIDER_CONFIGURATION" ? 86_400 : Math.max(backoff, Math.min(retryAfter, 86_400));
    await repository.fail(provider.name, lease.token, clock(), code, delay);
    // Only typed, sanitized codes escape the worker. Never expose fetch URLs or
    // raw database errors, which may contain provider keys and connection URLs.
    throw new OddsError(code, "Odds sync failed; the last successful cache was retained.", 503);
  }
}
