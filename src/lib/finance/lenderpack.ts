// Lender-ready pack: the documents a lender asks a small business for, generated only from recorded data and stamped
// with a fingerprint so it can be shown that nothing was edited after generation. Pure; the server adds the hash.
import { assessDataQuality, SALES_HAIRCUT, type QualityInputs } from "./cashrisk";
import { addDays, addMonths, endOfMonth, startOfMonth, type ISODate } from "./dates";
import { forecast, invoiceOutstanding, summarize, typicalRates } from "./engine";
import type { OfferAnalysis } from "./financing";
import { cashBalance } from "./planning";
import type { Snapshot } from "./snapshot";

export interface LenderPack {
  version: 1;
  business: { name: string; type: string | null; country: string | null; currency: string; timezone: string };
  generatedOn: ISODate;
  request: {
    amount: number;
    purpose: string;
    lender: string | null;
    offerKind: string | null;
    repayment: { date: ISODate; amount: number }[];
  } | null;
  months: { month: string; revenue: number; cogs: number; grossProfit: number; opex: number; netProfit: number }[];
  cash: { total: number; accounts: { name: string; balance: number }[]; pendingNonCash: number };
  weeks: { weekStart: ISODate; inflows: number; outflows: number; endBalance: number; withLoan: number | null }[];
  receivables: { bucket: string; amount: number }[];
  payables: { bucket: string; amount: number }[];
  dataQuality: { score: number; issues: string[]; sources: string[] };
  basis: string[];
}

const BUCKETS = [
  { label: "Not yet due", test: (d: number) => d < 0 },
  { label: "1–30 days late", test: (d: number) => d >= 0 && d <= 30 },
  { label: "31–60 days late", test: (d: number) => d > 30 && d <= 60 },
  { label: "Over 60 days late", test: (d: number) => d > 60 },
];

export function buildLenderPack(args: {
  s: Snapshot;
  business: LenderPack["business"];
  quality: QualityInputs;
  sources: string[];
  request?: { amount: number; purpose: string; offer?: OfferAnalysis | null };
}): LenderPack {
  const { s } = args;
  // Last six complete months plus the current month to date.
  const months: LenderPack["months"] = [];
  for (let i = 6; i >= 0; i--) {
    const from = startOfMonth(addMonths(startOfMonth(s.today), -i, 1));
    const to = i === 0 ? s.today : endOfMonth(from);
    const m = summarize(s.txns, s.cats, s.currency, { from, to });
    if (m.txnCount === 0 && months.length === 0) continue;
    months.push({
      month: from.slice(0, 7) + (i === 0 ? " (to date)" : ""),
      revenue: m.revenue,
      cogs: m.cogs,
      grossProfit: m.grossProfit,
      opex: m.opex,
      netProfit: m.netProfit,
    });
  }

  // 13-week cash forecast: scheduled items plus typical day-to-day activity, with and without the requested financing.
  const cash = cashBalance(s);
  const typical = typicalRates(s.txns, s.cats, s.currency, s.today, s.recurring);
  const typIn = Math.round((typical?.inPerDay ?? 0) * SALES_HAIRCUT);
  const opts = { includeTypical: !!typical, typicalInPerDay: typIn, typicalOutPerDay: typical?.outPerDay ?? 0 };
  const base = forecast({
    today: s.today,
    days: 91,
    startCash: cash.total,
    currency: s.currency,
    recurring: s.recurring,
    invoices: s.invoices,
    options: opts,
  });
  const loanFlows = args.request?.offer?.flows ?? [];
  const withLoan = loanFlows.length
    ? forecast({
        today: s.today,
        days: 91,
        startCash: cash.total,
        currency: s.currency,
        recurring: s.recurring,
        invoices: s.invoices,
        options: {
          ...opts,
          extraEvents: loanFlows.map((f) => ({
            date: f.date,
            amount: f.amount,
            label: "Financing",
            kind: "scenario" as const,
          })),
        },
      })
    : null;
  const balanceOn = (f: typeof base, d: ISODate) =>
    [...f.points].reverse().find((p) => p.date <= d)?.balance ?? cash.total;
  const weeks: LenderPack["weeks"] = [];
  for (let w = 0; w < 13; w++) {
    const from = addDays(s.today, w * 7 + 1);
    const to = addDays(from, 6);
    const ev = base.events.filter((e) => e.date >= from && e.date <= to);
    const typOut = typical ? typical.outPerDay * 7 : 0;
    weeks.push({
      weekStart: from,
      inflows: ev.filter((e) => e.amount > 0 && e.kind !== "typical").reduce((a, e) => a + e.amount, 0) + typIn * 7,
      outflows: -ev.filter((e) => e.amount < 0 && e.kind !== "typical").reduce((a, e) => a + e.amount, 0) + typOut,
      endBalance: balanceOn(base, to),
      withLoan: withLoan ? balanceOn(withLoan, to) : null,
    });
  }

  const aging = (dir: "receivable" | "payable") =>
    BUCKETS.map((b) => ({
      bucket: b.label,
      amount: s.invoices
        .filter(
          (i) =>
            i.direction === dir &&
            i.currency === s.currency &&
            invoiceOutstanding(i) > 0 &&
            b.test(Math.round((Date.parse(s.today) - Date.parse(i.due_date)) / 86_400_000)),
        )
        .reduce((a, i) => a + invoiceOutstanding(i), 0),
    }));

  const q = assessDataQuality(s, args.quality);
  const offer = args.request?.offer ?? null;
  return {
    version: 1,
    business: args.business,
    generatedOn: s.today,
    request: args.request
      ? {
          amount: args.request.amount,
          purpose: args.request.purpose,
          lender: offer?.offer.lender ?? null,
          offerKind: offer?.offer.kind ?? null,
          repayment: offer ? offer.flows.slice(1).slice(0, 52) : [],
        }
      : null,
    months,
    cash: {
      total: cash.total,
      accounts: cash.accounts.filter((a) => a.countsAsCash).map((a) => ({ name: a.name, balance: a.balance })),
      pendingNonCash: cash.pending,
    },
    weeks,
    receivables: aging("receivable"),
    payables: aging("payable"),
    dataQuality: { score: q.score, issues: q.issues, sources: args.sources },
    basis: [
      "Figures come from the business's recorded transactions, invoices and schedules; nothing is typed in for this document.",
      "Profit is cash-basis: costs count when they are recorded.",
      typical
        ? `The 13-week forecast adds typical day-to-day spending and sales to scheduled items; sales are counted at ${Math.round(SALES_HAIRCUT * 100)}% of the last ${typical.days} days, to stay on the safe side.`
        : "The 13-week forecast uses scheduled items only (not enough history for typical activity).",
      "Unpaid customer invoices are counted only from their due date.",
    ],
  };
}
