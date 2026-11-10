import { afterEach, describe, expect, it, vi } from "vitest";
import { billingPeriod, easternDay, parseBillingAnchor } from "../../lib/domain/odds-budget";
import { oddsSettings } from "../../lib/odds/settings";

afterEach(() => vi.unstubAllEnvs());
describe("provider quota periods", () => {
  it("uses the verified quota-reset day and time instead of the calendar or payment month", () => {
    const anchor = parseBillingAnchor("2026-01-17T12:30:00Z");
    expect(billingPeriod(new Date("2026-11-17T12:29:59Z"), anchor)).toEqual({
      start: new Date("2026-10-17T12:30:00Z"), end: new Date("2026-11-17T12:30:00Z"),
    });
    expect(billingPeriod(new Date("2026-11-17T12:30:00Z"), anchor)).toEqual({
      start: new Date("2026-11-17T12:30:00Z"), end: new Date("2026-12-17T12:30:00Z"),
    });
  });
  it("clamps short months without losing the anchor day, including leap years and year boundaries", () => {
    const anchor = parseBillingAnchor("2026-01-31T08:00:00Z");
    expect(billingPeriod(new Date("2028-02-29T08:00:00Z"), anchor)).toEqual({
      start: new Date("2028-02-29T08:00:00Z"), end: new Date("2028-03-31T08:00:00Z"),
    });
    expect(billingPeriod(new Date("2027-01-01T00:00:00Z"), anchor).start.toISOString()).toBe("2026-12-31T08:00:00.000Z");
  });
  it.each(["", "2026-02-31T00:00:00Z", "2026-11-01", "2026-11-01T00:00:00-04:00"])("rejects unverified/invalid UTC anchor %s", (anchor) => {
    expect(() => parseBillingAnchor(anchor)).toThrow();
  });
  it("counts Eastern calendar days across DST changes", () => {
    expect(easternDay(new Date("2026-03-08T04:59:59Z"))).toBe("2026-03-07");
    expect(easternDay(new Date("2026-03-09T04:00:00Z"))).toBe("2026-03-09");
    expect(easternDay(new Date("2026-11-02T04:59:59Z"))).toBe("2026-11-01");
    expect(easternDay(new Date("2026-11-02T05:00:00Z"))).toBe("2026-11-02");
  });
  it("defaults to the approved limits and requires no live billing configuration for mock use", () => {
    for (const key of ["ODDS_REFRESH_SECONDS", "ODDS_MONTHLY_CREDIT_CAP", "ODDS_DAILY_PAID_REFRESH_LIMIT", "ODDS_BILLING_ANCHOR"]) vi.stubEnv(key, "");
    expect(oddsSettings()).toMatchObject({ refreshSeconds: 21_600, monthlyCreditCap: 300, dailyPaidRefreshLimit: 3, billingAnchor: null });
  });
  it.each([["ODDS_MONTHLY_CREDIT_CAP", "301"], ["ODDS_DAILY_PAID_REFRESH_LIMIT", "4"], ["ODDS_REFRESH_SECONDS", "60"]])("rejects a setting exceeding policy: %s", (key, value) => {
    vi.stubEnv(key, value);
    expect(() => oddsSettings()).toThrow();
  });
});
