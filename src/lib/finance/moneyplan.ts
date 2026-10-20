// Money plan: what the owner can safely take for themselves, what the business can still spend, and where every 100
// of sales goes. Pure and deterministic; amounts in minor units.
import { addDays, startOfMonth } from "./dates";
import { descendants, summarize } from "./engine";
import { taxPosition, type TaxSettings } from "./detectors";
import { baseForecast, cashBalance, monthlyBaseline } from "./planning";
import type { Snapshot } from "./snapshot";

export interface MoneyPlanSettings {
  ownerPayPct: number; // share of average monthly profit the owner takes (default 50)
}
export const DEFAULT_PLAN: MoneyPlanSettings = { ownerPayPct: 50 };

export interface Slice {
  key: "product" | "tax" | "ads" | "shipping" | "people" | "rent" | "other" | "owner" | "keep" | "loss";
  label: string;
  amount: number;
  per100: number; // out of every 100 of sales
}

export interface MoneyPlan {
  period: { from: string; to: string; days: number };
  numbers: {
    revenue: number;
    productCosts: number;
    grossProfit: number;
    runningCosts: number;
    taxes: number;
    profit: number;
    ownerTook: number;
  };
  slices: Slice[];
  safe: { cash: number; taxes: number; bills30: number; reserve: number; free: number };
  owner: {
    status: "ok" | "wait" | "none";
    avgMonthlyProfit: number | null;
    pct: number;
    suggestedMonthly: number;
    takenThisMonth: number;
    canTakeNow: number;
    reason: string;
  };
  business: { canSpend: number; reason: string };
}

export function moneyPlan(
  s: Snapshot,
  opts: { tax: TaxSettings; reserve: number | null; plan?: Partial<MoneyPlanSettings> },
): MoneyPlan {
  const pct = Math.min(100, Math.max(0, opts.plan?.ownerPayPct ?? DEFAULT_PLAN.ownerPayPct));
  const from = addDays(s.today, -29);
  const sum = summarize(s.txns, s.cats, s.currency, { from, to: s.today });
  const role = (r: string) =>
    new Set(s.cats.filter((c) => c.role === r).flatMap((c) => [...descendants(s.cats, c.id)]));
  const spent = (ids: Set<string>) =>
    s.txns
      .filter(
        (t) =>
          t.type === "expense" &&
          t.currency === s.currency &&
          t.date >= from &&
          t.date <= s.today &&
          t.category_id &&
          ids.has(t.category_id),
      )
      .reduce((a, t) => a + t.amount, 0);
  const ads = spent(role("ads"));
  const shipping = spent(role("shipping"));
  const people = spent(role("payroll"));
  const rent = spent(role("rent"));
  const taxPaid = spent(role("tax"));
  // VAT inside sales belongs to the tax office; an income-tax reserve is not a 30-day cost, so only VAT is sliced here.
  const tp = taxPosition(s, { ...opts.tax, incomeTaxReservePct: null });
  const vat30 =
    opts.tax.vatRegistered && tp
      ? Math.round(
          ((Math.max(0, sum.revenue) * tp.vatRate) / (100 + tp.vatRate)) *
            (opts.tax.pricesIncludeVat === false ? (100 + tp.vatRate) / 100 : 1),
        )
      : 0;
  const other = Math.max(0, sum.opex - ads - shipping - people - rent - taxPaid);
  // Economic view: the VAT inside these sales (when registered); otherwise the taxes actually paid in the period.
  const taxes = opts.tax.vatRegistered ? vat30 : taxPaid;
  const profit = sum.revenue - sum.cogs - (sum.opex - taxPaid) - taxes;
  const ownerShare = Math.max(0, Math.round((Math.max(0, profit) * pct) / 100));
  const R = Math.max(1, sum.revenue);
  const raw: Omit<Slice, "per100">[] = [
    { key: "product", label: "Product costs", amount: sum.cogs },
    { key: "tax", label: "Taxes", amount: taxes },
    { key: "ads", label: "Advertising", amount: ads },
    { key: "shipping", label: "Shipping", amount: shipping },
    { key: "people", label: "Salaries & freelancers", amount: people },
    { key: "rent", label: "Rent", amount: rent },
    { key: "other", label: "Other running costs", amount: other },
    ...(profit >= 0
      ? [
          { key: "owner" as const, label: "Your pay", amount: ownerShare },
          { key: "keep" as const, label: "Stays in the business", amount: profit - ownerShare },
        ]
      : [{ key: "loss" as const, label: "Loss (costs above sales)", amount: profit }]),
  ];
  const slices = raw
    .filter((x) => x.amount !== 0)
    .map((x) => ({ ...x, per100: Math.round((x.amount / R) * 1000) / 10 }));

  // Safe to spend now: cash, minus what belongs to the tax office, minus bills due in 30 days, minus the safety reserve.
  const cash = cashBalance(s).total;
  const taxOwed = taxPosition(s, opts.tax)?.total ?? 0;
  const bills30 = baseForecast(s, 30)
    .events.filter((e) => e.amount < 0)
    .reduce((a, e) => a - e.amount, 0);
  const reserve = Math.max(0, opts.reserve ?? 0);
  const free = cash - taxOwed - bills30 - reserve;

  // Owner pay: a share of what the business really earns on average, never more than what is free right now.
  const base = monthlyBaseline(s);
  // What the business earns per month after the VAT inside its sales (when registered) - the base for the owner's share.
  const vatRate = opts.tax.vatRegistered ? (opts.tax.vatRatePct ?? 14) : 0;
  const vatInBase =
    base && vatRate
      ? Math.round((base.revenue * vatRate) / (opts.tax.pricesIncludeVat === false ? 100 : 100 + vatRate))
      : 0;
  const avg = base ? base.netProfit - vatInBase : null;
  const takenThisMonth = summarize(s.txns, s.cats, s.currency, { from: startOfMonth(s.today), to: s.today }).ownerDraws;
  let owner: MoneyPlan["owner"];
  if (avg === null) {
    owner = {
      status: "none",
      avgMonthlyProfit: null,
      pct,
      suggestedMonthly: 0,
      takenThisMonth,
      canTakeNow: 0,
      reason:
        "There is not enough history yet (at least two weeks) to know what the business earns. Record sales and costs first.",
    };
  } else if (avg <= 0) {
    owner = {
      status: "none",
      avgMonthlyProfit: avg,
      pct,
      suggestedMonthly: 0,
      takenThisMonth,
      canTakeNow: 0,
      reason:
        "On average the business is not making a profit yet. Paying yourself now would come out of its cash (or debt), not its earnings.",
    };
  } else {
    const suggested = Math.round((avg * pct) / 100);
    const remaining = Math.max(0, suggested - takenThisMonth);
    const canTakeNow = Math.max(0, Math.min(remaining, free));
    owner = {
      status: canTakeNow > 0 ? "ok" : "wait",
      avgMonthlyProfit: avg,
      pct,
      suggestedMonthly: suggested,
      takenThisMonth,
      canTakeNow,
      reason:
        remaining === 0
          ? "You have already taken this month's pay."
          : canTakeNow === remaining
            ? "Within what the business earns, and it still covers taxes, the next 30 days of bills and your safety reserve."
            : free <= 0
              ? "The business earns enough, but right now its cash is needed for taxes, upcoming bills and your reserve. Wait for more sales to come in."
              : "Only part of this month's pay is free right now; the rest is needed for taxes, bills and your reserve.",
    };
  }
  const canSpend = Math.max(0, free - owner.canTakeNow);
  return {
    period: { from, to: s.today, days: 30 },
    numbers: {
      revenue: sum.revenue,
      productCosts: sum.cogs,
      grossProfit: sum.revenue - sum.cogs,
      runningCosts: sum.opex - taxPaid,
      taxes,
      profit,
      ownerTook: sum.ownerDraws,
    },
    slices,
    safe: { cash, taxes: taxOwed, bills30, reserve, free },
    owner,
    business: {
      canSpend,
      reason:
        free <= 0
          ? "Nothing extra is free today: every pound is already needed for taxes, the next 30 days of bills or your safety reserve."
          : "Extra spending the business can afford today (beyond the bills already scheduled), after your pay.",
    },
  };
}
