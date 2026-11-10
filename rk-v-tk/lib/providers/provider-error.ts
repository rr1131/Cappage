export type ProviderErrorCode = "PROVIDER_CONFIGURATION" | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RATE_LIMITED" | "PROVIDER_INVALID_RESPONSE" | "PROVIDER_QUOTA_EXHAUSTED";

export class ProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode, public readonly retryAfterSeconds?: number) {
    // Upstream bodies and URLs can contain keys or untrusted text. Codes are the
    // only provider details safe to report outside the adapter.
    super(code);
    this.name = "ProviderError";
  }
}
