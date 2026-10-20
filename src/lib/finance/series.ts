import { addDays, addMonths, diffDays, fmt, parse, type ISODate, type PeriodInfo, type Range } from "./dates";
import { catMap, descendants, refundSide, type Cat, type Txn } from "./engine";

export interface Bucket {
  label: string;
  from: ISODate;
  to: ISODate;
  revenue: number;
  expenses: number;
  profit: number;
  cashIn: number;
  cashOut: number;
}

/* * Revenue/expense buckets across a period. Uses days for week/month, weeks for a quarter, months for a year. */
export function periodSeries(txns: Txn[], cats: Cat[], currency: string, p: PeriodInfo, today: ISODate): Bucket[] {
  const cm = catMap(cats);
  const buckets: Bucket[] = [];
  const mk = (from: ISODate, to: ISODate, label: string): Bucket => ({
    label,
    from,
    to,
    revenue: 0,
    expenses: 0,
    profit: 0,
    cashIn: 0,
    cashOut: 0,
  });
  if (p.kind === "week" || p.kind === "month") {
    for (let i = 0; i < p.totalDays; i++) {
      const d = addDays(p.full.from, i);
      buckets.push(mk(d, d, d.slice(8)));
    }
  } else if (p.kind === "quarter") {
    for (let d = p.full.from; d <= p.full.to; d = addDays(d, 7))
      buckets.push(mk(d, addDays(d, 6) > p.full.to ? p.full.to : addDays(d, 6), d.slice(5)));
  } else {
    for (let m = 0; m < 12; m++) {
      const from = addMonths(p.full.from, m, 1);
      const to = addDays(addMonths(from, 1, 1), -1);
      buckets.push(mk(from, to, new Date(parse(from)).toLocaleString("en", { month: "short", timeZone: "UTC" })));
    }
  }
  const size = p.kind === "week" || p.kind === "month" ? 1 : p.kind === "quarter" ? 7 : 0;
  for (const t of txns) {
    if (t.currency !== currency || t.date < p.full.from || t.date > p.full.to || t.type === "transfer") continue;
    let idx: number;
    if (size) idx = Math.floor(diffDays(t.date, p.full.from) / size);
    else idx = Number(t.date.slice(5, 7)) - 1;
    const b = buckets[idx];
    if (!b) continue;
    if (t.type === "income") {
      b.revenue += t.amount;
      b.cashIn += t.amount;
    } else if (t.type === "refund") {
      if (refundSide(t, cm) === "customer") {
        b.revenue -= t.amount;
        b.cashOut += t.amount;
      } else {
        b.expenses -= t.amount;
        b.cashIn += t.amount;
      }
    } else if (t.type === "expense") {
      b.expenses += t.amount;
      b.cashOut += t.amount;
    } else if (t.type === "adjustment") {
      if (t.direction === "in") b.cashIn += t.amount;
      else b.cashOut += t.amount;
    }
  }
  for (const b of buckets) b.profit = b.revenue - b.expenses;
  void today;
  return buckets;
}

export interface Slice {
  id: string;
  name: string;
  color: string;
  amount: number;
}

/* * Expense breakdown rolled up to top-level categories. */
export function expenseBreakdown(
  txns: Txn[],
  cats: Cat[],
  currency: string,
  range: Range,
): { slices: Slice[]; total: number; uncategorized: number } {
  const cm = catMap(cats);
  const top = (id: string | null): Cat | null => {
    let c = id ? cm.get(id) : undefined;
    while (c?.parent_id && cm.get(c.parent_id)) c = cm.get(c.parent_id);
    return c ?? null;
  };
  const sums = new Map<string, number>();
  let uncategorized = 0;
  let total = 0;
  for (const t of txns) {
    if (t.currency !== currency || t.date < range.from || t.date > range.to) continue;
    let v = 0;
    if (t.type === "expense") v = t.amount;
    else if (t.type === "refund" && refundSide(t, cm) === "vendor") v = -t.amount;
    else continue;
    total += v;
    const c = top(t.category_id);
    if (!c) {
      uncategorized += v;
      continue;
    }
    sums.set(c.id, (sums.get(c.id) ?? 0) + v);
  }
  const slices = [...sums.entries()]
    .map(([id, amount]) => ({ id, name: cm.get(id)!.name, color: cm.get(id)!.color ?? "#6b7a72", amount }))
    .filter((s) => s.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  if (uncategorized > 0)
    slices.push({ id: "uncategorized", name: "Uncategorized", color: "#a7b0ab", amount: uncategorized });
  return { slices, total, uncategorized };
}

export { fmt, descendants };
