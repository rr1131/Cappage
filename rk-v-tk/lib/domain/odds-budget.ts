// The anchor is a verified provider quota-reset instant, not a payment date.
// Repeat its UTC day/time monthly, clamping day 29–31 in shorter months.
export function parseBillingAnchor(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error("ODDS_BILLING_ANCHOR must be a verified UTC quota-reset timestamp");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace(".000Z", "Z") !== value.replace(".000Z", "Z")) {
    throw new Error("Invalid ODDS_BILLING_ANCHOR");
  }
  return date;
}

export function billingPeriod(now: Date, anchor: Date) {
  const boundary = (month: number) => {
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(now.getUTCFullYear(), month, Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
  };
  let month = now.getUTCMonth();
  if (now < boundary(month)) month -= 1;
  return { start: boundary(month), end: boundary(month + 1) };
}

export function easternDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
