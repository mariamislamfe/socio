// Dates are business-local calendar days stored as "YYYY-MM-DD" strings. No timezones involved.
export type ISODate = string;

const MS = 86_400_000;
export function parse(d: ISODate): number {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, day);
}
export function fmt(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10);
}
export function todayISO(now: Date = new Date()): ISODate {
  return fmt(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}
export function addDays(d: ISODate, n: number): ISODate {
  return fmt(parse(d) + n * MS);
}
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((parse(a) - parse(b)) / MS);
}
export function daysInMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}
export function addMonths(d: ISODate, n: number, anchorDay?: number): ISODate {
  const [y, m, day] = d.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const want = anchorDay ?? day;
  return fmt(Date.UTC(ny, nm, Math.min(want, daysInMonth(ny, nm))));
}
export function startOfMonth(d: ISODate): ISODate {
  return d.slice(0, 7) + "-01";
}
export function endOfMonth(d: ISODate): ISODate {
  const [y, m] = d.split("-").map(Number);
  return fmt(Date.UTC(y, m - 1, daysInMonth(y, m - 1)));
}
export function monthKey(d: ISODate): string {
  return d.slice(0, 7);
}
export function inRange(d: ISODate, from: ISODate, to: ISODate): boolean {
  return d >= from && d <= to;
}

export type PeriodKind = "week" | "month" | "quarter" | "year";
export interface Range {
  from: ISODate;
  to: ISODate;
}
export interface PeriodInfo {
  kind: PeriodKind;
  /* * Whole calendar period (e.g. the entire month). */
  full: Range;
  /* * Period up to and including today. */
  current: Range;
  /* * Same elapsed length of the previous period, for like-for-like comparison. */
  previous: Range;
  totalDays: number;
  elapsedDays: number;
  remainingDays: number;
}

export function periodInfo(kind: PeriodKind, today: ISODate): PeriodInfo {
  let start: ISODate, end: ISODate, prevStart: ISODate;
  if (kind === "week") {
    const dow = (new Date(parse(today)).getUTCDay() + 6) % 7; // Monday = 0
    start = addDays(today, -dow);
    end = addDays(start, 6);
    prevStart = addDays(start, -7);
  } else if (kind === "month") {
    start = startOfMonth(today);
    end = endOfMonth(today);
    prevStart = addMonths(start, -1);
  } else if (kind === "quarter") {
    const [y, m] = today.split("-").map(Number);
    const qm = Math.floor((m - 1) / 3) * 3;
    start = fmt(Date.UTC(y, qm, 1));
    end = endOfMonth(fmt(Date.UTC(y, qm + 2, 1)));
    prevStart = addMonths(start, -3);
  } else {
    const y = today.slice(0, 4);
    start = `${y}-01-01`;
    end = `${y}-12-31`;
    prevStart = `${Number(y) - 1}-01-01`;
  }
  const totalDays = diffDays(end, start) + 1;
  const elapsedDays = Math.min(totalDays, Math.max(1, diffDays(today, start) + 1));
  const current = { from: start, to: addDays(start, elapsedDays - 1) };
  const previous = { from: prevStart, to: addDays(prevStart, elapsedDays - 1) };
  return {
    kind,
    full: { from: start, to: end },
    current,
    previous,
    totalDays,
    elapsedDays,
    remainingDays: totalDays - elapsedDays,
  };
}

/* * Period bounds for a budget period type containing `today`. */
export function budgetPeriod(period: "monthly" | "quarterly" | "yearly", today: ISODate): PeriodInfo {
  return periodInfo(period === "monthly" ? "month" : period === "quarterly" ? "quarter" : "year", today);
}

export type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";
export function nextOccurrence(d: ISODate, f: Frequency, anchorDay?: number): ISODate {
  if (f === "weekly") return addDays(d, 7);
  if (f === "monthly") return addMonths(d, 1, anchorDay);
  if (f === "quarterly") return addMonths(d, 3, anchorDay);
  return addMonths(d, 12, anchorDay);
}
/* * Every due date of a schedule within [from, to], starting from its next_due. */
export function occurrences(
  nextDue: ISODate,
  f: Frequency,
  from: ISODate,
  to: ISODate,
  endDate?: ISODate | null,
): ISODate[] {
  const out: ISODate[] = [];
  const anchor = Number(nextDue.slice(8, 10));
  let cur = nextDue;
  for (let i = 0; i < 400 && cur <= to; i++) {
    if (endDate && cur > endDate) break;
    if (cur >= from) out.push(cur);
    cur = nextOccurrence(cur, f, anchor);
  }
  return out;
}

/* * The calendar date "today" for a business in its own IANA timezone (falls back to UTC on an invalid zone). */
export function todayIn(timeZone: string, now: Date = new Date()): ISODate {
  return localDateOf(now.toISOString(), timeZone);
}

/* * Converts an instant (ISO timestamp) to the calendar date it falls on in `timeZone`. */
export function localDateOf(instant: string, timeZone: string): ISODate {
  const d = new Date(instant);
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
