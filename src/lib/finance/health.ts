// Company health: valuation range, simplified statements, due-diligence readiness, depreciation.
// Pure functions. All figures are rough guides built from the user's own records and stated assumptions.
import { addDays, addMonths, diffDays, endOfMonth, startOfMonth, type ISODate } from "./dates";
import { summarize, type Summary } from "./engine";
import { formatMoney } from "./money";
import { baseForecast, cashBalance, monthlyBaseline } from "./planning";
import type { Snapshot } from "./snapshot";

export interface Asset {
  id: string;
  name: string;
  cost: number;
  purchase_date: ISODate;
  useful_life_months: number;
  salvage_value: number;
  fair_value: number | null;
  disposed_on: ISODate | null;
}

export interface AssetValue extends Asset {
  monthlyDepreciation: number;
  accumulated: number;
  bookValue: number;
  monthsElapsed: number;
  fullyDepreciated: boolean;
}

/* * Straight-line depreciation: (cost − salvage) spread evenly over the useful life. */
export function depreciate(a: Asset, asOf: ISODate): AssetValue {
  const end = a.disposed_on && a.disposed_on < asOf ? a.disposed_on : asOf;
  const months = Math.max(
    0,
    (Number(end.slice(0, 4)) - Number(a.purchase_date.slice(0, 4))) * 12 +
      (Number(end.slice(5, 7)) - Number(a.purchase_date.slice(5, 7))),
  );
  const depreciable = a.cost - a.salvage_value;
  const monthly = Math.round(depreciable / a.useful_life_months);
  const accumulated = Math.min(depreciable, monthly * months);
  return {
    ...a,
    monthlyDepreciation: monthly,
    accumulated,
    bookValue: a.disposed_on && a.disposed_on <= asOf ? 0 : a.cost - accumulated,
    monthsElapsed: months,
    fullyDepreciated: accumulated >= depreciable,
  };
}

// valuation

export interface ValuationInputs {
  earningsMultiple: [number, number];
  revenueMultiple: [number, number];
}
export const DEFAULT_MULTIPLES: ValuationInputs = { earningsMultiple: [2, 4], revenueMultiple: [0.3, 0.8] };

export interface Valuation {
  windowMonths: number;
  annualRevenue: number;
  annualProfit: number;
  netAssets: number;
  methods: {
    key: "earnings" | "revenue" | "assets";
    label: string;
    low: number;
    high: number;
    applies: boolean;
    note: string;
  }[];
  low: number;
  mid: number;
  high: number;
  confidence: "low" | "medium" | "good";
  cautions: string[];
  inputs: ValuationInputs;
}

function trailing(s: Snapshot, months: number) {
  const first = s.txns.reduce((m, t) => (t.date < m ? t.date : m), s.today);
  const available = Math.max(0, Math.round(diffDays(s.today, first) / 30.4));
  const used = Math.min(months, Math.max(1, available));
  const from = addDays(s.today, -(used * 30) + 1);
  return { used, from, sum: summarize(s.txns, s.cats, s.currency, { from, to: s.today }) };
}

export function netAssetsOf(
  s: Snapshot,
  assets: Asset[],
): { cash: number; receivables: number; inventory: number; fixed: number; payables: number; total: number } {
  const cash = cashBalance(s).total;
  const open = (dir: "receivable" | "payable") =>
    s.invoices
      .filter((i) => i.direction === dir && i.status === "open" && i.currency === s.currency)
      .reduce((a, i) => a + Math.max(0, i.amount - i.paid), 0);
  const receivables = open("receivable");
  const payables = open("payable");
  const fixed = assets.map((a) => depreciate(a, s.today)).reduce((x, a) => x + a.bookValue, 0);
  return { cash, receivables, inventory: 0, fixed, payables, total: cash + receivables + fixed - payables };
}

export function estimateValuation(
  s: Snapshot,
  assets: Asset[],
  inputs: ValuationInputs = DEFAULT_MULTIPLES,
): Valuation {
  const t = trailing(s, 12);
  const scale = 12 / t.used;
  const annualRevenue = Math.round(t.sum.revenue * scale);
  const annualProfit = Math.round(t.sum.netProfit * scale);
  const na = netAssetsOf(s, assets).total;
  const cautions: string[] = [];
  if (t.used < 6)
    cautions.push(`Only ${t.used} month(s) of history, so annual figures are extrapolated and uncertain.`);
  if (t.sum.incomplete)
    cautions.push("Product costs are missing, so profit is probably overstated and so is the earnings-based value.");
  if (s.txns.length === 0) cautions.push("There are no records yet.");
  const methods: Valuation["methods"] = [
    {
      key: "earnings",
      label: "Earnings multiple",
      applies: annualProfit > 0,
      low: Math.max(0, Math.round(annualProfit * inputs.earningsMultiple[0])),
      high: Math.max(0, Math.round(annualProfit * inputs.earningsMultiple[1])),
      note: `Yearly profit × ${inputs.earningsMultiple[0]}–${inputs.earningsMultiple[1]}. Small businesses are usually priced on what the owner can take out.`,
    },
    {
      key: "revenue",
      label: "Revenue multiple",
      applies: annualRevenue > 0,
      low: Math.round(annualRevenue * inputs.revenueMultiple[0]),
      high: Math.round(annualRevenue * inputs.revenueMultiple[1]),
      note: `Yearly revenue × ${inputs.revenueMultiple[0]}–${inputs.revenueMultiple[1]}. Ignores costs, so it is a looser guide.`,
    },
    {
      key: "assets",
      label: "Net assets",
      applies: true,
      low: Math.max(0, na),
      high: Math.max(0, na),
      note: "What you own (cash, money owed to you, equipment at book value) minus what you owe. A floor, not a price.",
    },
  ];
  // Headline: what a small-business buyer usually prices (earnings), else revenue as a looser guide, else net assets.
  // Net assets is a floor: a business is rarely worth less than what it owns minus what it owes.
  const primary =
    methods.find((m) => m.key === "earnings" && m.applies) ?? methods.find((m) => m.key === "revenue" && m.applies);
  let low = primary ? primary.low : Math.max(0, na);
  let high = primary ? primary.high : Math.max(0, na);
  if (primary && na > low) low = Math.min(na, high);
  const mid = Math.round((low + high) / 2);
  const confidence: Valuation["confidence"] =
    t.used >= 9 && !t.sum.incomplete ? "good" : t.used >= 4 ? "medium" : "low";
  return {
    windowMonths: t.used,
    annualRevenue,
    annualProfit,
    netAssets: na,
    methods,
    low,
    mid,
    high,
    confidence,
    cautions,
    inputs,
  };
}

// statements

export interface MonthStatement {
  month: string;
  from: ISODate;
  to: ISODate;
  summary: Summary;
  depreciation: number;
  profitAfterDepreciation: number;
  openingCash: number;
  closingCash: number;
}

export function monthStatement(s: Snapshot, assets: Asset[], month: string): MonthStatement {
  const from = `${month}-01`;
  const to = endOfMonth(from) > s.today ? s.today : endOfMonth(from);
  const summary = summarize(s.txns, s.cats, s.currency, { from, to });
  const dep = assets
    .map((a) => depreciate(a, to))
    .reduce((x, a) => x + (a.purchase_date <= to && !a.fullyDepreciated ? a.monthlyDepreciation : 0), 0);
  const before = addDays(from, -1);
  const balAt = (d: ISODate) => {
    let total = 0;
    for (const a of s.accounts) {
      if (a.currency !== s.currency || a.archived) continue;
      total += a.opening_balance;
    }
    for (const t of s.txns) {
      if (t.currency !== s.currency || t.date > d) continue;
      if (t.type === "income") total += t.amount;
      else if (t.type === "expense") total -= t.amount;
      else if (t.type === "refund")
        total += s.cats.find((c) => c.id === t.category_id)?.kind === "expense" ? t.amount : -t.amount;
      else if (t.type === "adjustment") total += t.direction === "in" ? t.amount : -t.amount;
    }
    return total;
  };
  return {
    month,
    from,
    to,
    summary,
    depreciation: dep,
    profitAfterDepreciation: summary.netProfit - dep,
    openingCash: balAt(before),
    closingCash: balAt(to),
  };
}

// readiness ("due diligence, lightly")

export interface ReadinessCheck {
  key: string;
  label: string;
  ok: boolean;
  weight: number;
  detail: string;
  fixHref: string;
  glossary?: string;
}

export function readiness(
  s: Snapshot,
  opts: { requiredDone: number; requiredTotal: number },
): { score: number; checks: ReadinessCheck[] } {
  const first = s.txns.reduce((m, t) => (t.date < m ? t.date : m), s.today);
  const months = s.txns.length ? diffDays(s.today, first) / 30.4 : 0;
  const recent = s.txns.filter((t) => t.date > addDays(s.today, -90) && t.currency === s.currency);
  const exp = recent.filter((t) => t.type === "expense");
  const categorised = exp.length ? exp.filter((t) => t.category_id).length / exp.length : 1;
  const reconcileShare = 0; // reconciliation flag is not part of the snapshot; kept out of the score on purpose
  void reconcileShare;
  const overduePay = s.invoices.filter(
    (i) => i.direction === "payable" && i.status === "open" && i.due_date < s.today && i.amount - i.paid > 0,
  ).length;
  const recv = s.invoices.filter((i) => i.direction === "receivable" && i.status === "open" && i.amount - i.paid > 0);
  const recvTotal = recv.reduce((a, i) => a + i.amount - i.paid, 0);
  const recvLate = recv.filter((i) => i.due_date < s.today).reduce((a, i) => a + i.amount - i.paid, 0);
  const three = summarize(s.txns, s.cats, s.currency, { from: addDays(s.today, -89), to: s.today });
  const base = monthlyBaseline(s);
  const f = baseForecast(s, 60);
  const checks: ReadinessCheck[] = [
    {
      key: "history",
      label: "At least 6 months of records",
      ok: months >= 6,
      weight: 15,
      detail: `${Math.floor(months)} month(s) recorded. Buyers and lenders want a track record.`,
      fixHref: "/app/settings/data",
    },
    {
      key: "categorised",
      label: "Expenses are categorised (95%+)",
      ok: categorised >= 0.95,
      weight: 15,
      detail: `${Math.round(categorised * 100)}% of the last 90 days' expenses have a category.`,
      fixHref: "/app/transactions?filter=uncategorized",
    },
    {
      key: "costs",
      label: "Product costs are recorded",
      ok: !three.incomplete && (three.cogs > 0 || three.revenue === 0),
      weight: 15,
      detail: three.incomplete
        ? "Revenue without any cost of goods — profit is overstated."
        : "Cost of goods is recorded.",
      fixHref: "/app/products",
      glossary: "cogs",
    },
    {
      key: "profit",
      label: "Profitable over the last 90 days",
      ok: three.netProfit > 0,
      weight: 10,
      detail: `Net profit over 90 days: ${formatMoney(three.netProfit, s.currency, { compact: true })}.`,
      fixHref: "/app/insights",
      glossary: "net_profit",
    },
    {
      key: "payables",
      label: "No overdue bills",
      ok: overduePay === 0,
      weight: 10,
      detail: overduePay ? `${overduePay} overdue bill(s).` : "Nothing overdue.",
      fixHref: "/app/obligations?tab=payables",
      glossary: "payable",
    },
    {
      key: "receivables",
      label: "Little money stuck with late customers",
      ok: recvTotal === 0 || recvLate / recvTotal < 0.25,
      weight: 10,
      detail: recvTotal
        ? `${Math.round((recvLate / recvTotal) * 100)}% of what you are owed is overdue.`
        : "No open invoices.",
      fixHref: "/app/obligations?tab=receivables",
      glossary: "receivable",
    },
    {
      key: "cash",
      label: "No cash shortfall in the next 60 days",
      ok: !f.firstShortfallDate,
      weight: 10,
      detail: f.firstShortfallDate
        ? `Cash goes below zero on ${f.firstShortfallDate}.`
        : "Scheduled payments are covered.",
      fixHref: "/app/cash-flow",
      glossary: "cash_flow",
    },
    {
      key: "paperwork",
      label: "Required paperwork is up to date",
      ok: opts.requiredTotal === 0 ? false : opts.requiredDone >= opts.requiredTotal,
      weight: 15,
      detail: opts.requiredTotal
        ? `${opts.requiredDone} of ${opts.requiredTotal} required items done.`
        : "Open the monthly to-do list to set this up.",
      fixHref: "/app/health#todo",
    },
  ];
  void base;
  const total = checks.reduce((a, c) => a + c.weight, 0);
  const got = checks.reduce((a, c) => a + (c.ok ? c.weight : 0), 0);
  return { score: Math.round((got / total) * 100), checks };
}

// verdict

export function verdict(args: { readiness: number; shortfall: boolean; profitable: boolean; hasData: boolean }): {
  tone: "good" | "watch" | "act" | "start";
  headline: string;
} {
  if (!args.hasData) return { tone: "start", headline: "Add a few records and I will tell you where you stand." };
  if (args.shortfall)
    return { tone: "act", headline: "Cash needs attention first — a payment is coming that you cannot cover yet." };
  if (!args.profitable)
    return { tone: "watch", headline: "You are selling, but not keeping anything yet. Costs need a look." };
  if (args.readiness < 75)
    return { tone: "watch", headline: "The business is earning. The records and paperwork are what hold it back." };
  return { tone: "good", headline: "You are in good shape. Keep the monthly routine going." };
}

export { addMonths, startOfMonth };
