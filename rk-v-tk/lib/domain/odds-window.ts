// Calendar boundaries are Eastern; adding 86,400,000ms would be wrong on DST days.
const easternParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
});
function parts(date: Date) {
  return Object.fromEntries(easternParts.formatToParts(date).map((p) => [p.type, Number(p.value)]));
}
export function easternWindowEnd(now: Date, days: number): Date {
  const today = parts(now);
  const wallMidnight = Date.UTC(today.year, today.month - 1, today.day + days);
  let instant = wallMidnight;
  // Midnight is unambiguous in New York. Resolve its offset, including when
  // the first approximation falls on the other side of a DST transition.
  for (let i = 0; i < 3; i++) {
    const local = parts(new Date(instant));
    instant += wallMidnight - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  }
  return new Date(instant);
}
