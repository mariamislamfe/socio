import { addDays, diffDays, periodInfo, type PeriodKind } from "./dates";
import {
  accountBalances,
  budgetStatuses,
  descendants,
  essentialMonthly,
  forecast,
  summarize,
  typicalRates,
  type Forecast,
  type Summary,
} from "./engine";
import type { GoalRow, Snapshot } from "./snapshot";

export function cashBalance(s: Snapshot) {
  const bal = accountBalances(s.accounts, s.txns, s.cats, s.today);
  return {
    accounts: bal,
    // Only spendable money in the base currency counts as cash.
    total: bal.filter((b) => b.currency === s.currency && b.countsAsCash).reduce((a, b) => a + b.balance, 0),
    /* * Money that exists but is not spendable yet (e.g. Shopify balance awaiting payout). Never counted as cash. */
    pending: bal.filter((b) => b.currency === s.currency && !b.countsAsCash).reduce((a, b) => a + b.balance, 0),
    otherCurrencies: bal.filter((b) => b.currency !== s.currency),
  };
}

export type BaseForecast = Forecast & { typical: ReturnType<typeof typicalRates>; typicalAvailable: boolean };

export function baseForecast(
  s: Snapshot,
  days: number,
  opts: { includeTypical?: boolean; receivableDelayDays?: number; overdueReceivableDelayDays?: number } = {},
): BaseForecast {
  const cash = cashBalance(s).total;
  const typical = typicalRates(s.txns, s.cats, s.currency, s.today, s.recurring);
  const include = !!opts.includeTypical && !!typical;
  const f = forecast({
    today: s.today,
    days,
    startCash: cash,
    currency: s.currency,
    recurring: s.recurring,
    invoices: s.invoices,
    options: {
      includeTypical: include,
      typicalInPerDay: typical?.inPerDay ?? 0,
      typicalOutPerDay: typical?.outPerDay ?? 0,
      receivableDelayDays: opts.receivableDelayDays ?? 0,
      overdueReceivableDelayDays: opts.overdueReceivableDelayDays ?? 14,
    },
  });
  return { ...f, typical, typicalAvailable: !!typical };
}

export interface GoalProgress {
  id: string;
  type: GoalRow["type"];
  name: string;
  target: number;
  current: number;
  pct: number;
  remaining: number;
  achieved: boolean;
  targetDate: string | null;
  basis: string;
  mode: GoalRow["mode"];
  coverageMonths: number | null;
  suggestedMonthly?: number;
  safeNow?: number;
  etaMonths?: number | null;
  cashAfterReserve?: number;
  projected?: number;
  warnings: string[];
}

export function goalProgress(g: GoalRow, s: Snapshot): GoalProgress {
  const warnings: string[] = [];
  const cash = cashBalance(s).total;
  const periodKind: PeriodKind = g.period === "monthly" ? "month" : g.period === "quarterly" ? "quarter" : "year";
  let target = g.target;
  let current = 0;
  let basis = "";
  let projected: number | undefined;
  const p = periodInfo(periodKind, s.today);

  if (g.type === "reserve") {
    current = g.contributed;
    if (g.mode === "essentials" && g.coverage_months) {
      const monthly = essentialMonthly(s.txns, s.cats, s.recurring, s.currency, s.today);
      target = monthly * g.coverage_months;
      basis = monthly > 0 ? `${g.coverage_months} months of essential expenses` : "No essential expenses found yet";
      if (monthly === 0)
        warnings.push(
          "The target is zero because no essential expenses are recorded or flagged. Mark categories as essential or record spending.",
        );
    } else basis = "Manual target";
  } else if (g.type === "cash") {
    current = cash;
    basis = "Recorded cash across accounts";
  } else {
    const sum = summarize(s.txns, s.cats, s.currency, p.current);
    if (g.type === "revenue") {
      current = sum.revenue;
      basis = `Net revenue this ${periodKind}`;
    } else if (g.type === "profit") {
      current = sum.netProfit;
      basis = `Net profit this ${periodKind}${sum.incomplete ? " (incomplete: costs missing)" : ""}`;
      if (sum.incomplete)
        warnings.push("Profit is incomplete because product costs are missing, so this progress may be overstated.");
    } else {
      const inv = new Set(s.cats.filter((c) => c.role === "inventory").flatMap((c) => [...descendants(s.cats, c.id)]));
      for (const t of s.txns) {
        if (
          t.type === "expense" &&
          t.currency === s.currency &&
          t.date >= p.current.from &&
          t.date <= p.current.to &&
          t.category_id &&
          inv.has(t.category_id)
        )
          current += t.amount;
      }
      basis = `Inventory purchases this ${periodKind}`;
    }
    projected = Math.round((current / p.elapsedDays) * p.totalDays);
  }
  const remaining = Math.max(0, target - current);
  const pct = target > 0 ? Math.min(1, Math.max(0, current / target)) : 0;
  const out: GoalProgress = {
    id: g.id,
    type: g.type,
    name: g.name,
    target,
    current,
    pct,
    remaining,
    achieved: target > 0 && current >= target,
    targetDate: g.target_date,
    basis,
    mode: g.mode,
    coverageMonths: g.coverage_months,
    warnings,
    projected,
  };

  if (g.type === "reserve") {
    const f = baseForecast(s, 60, { includeTypical: false });
    const headroom = Math.max(0, Math.min(cash, f.minCash) - current);
    out.cashAfterReserve = cash - current;
    out.safeNow = Math.min(remaining, headroom);
    const months = g.target_date ? Math.max(1, Math.round(diffDays(g.target_date, s.today) / 30)) : 6;
    out.suggestedMonthly = remaining > 0 ? Math.ceil(remaining / months) : 0;
    out.etaMonths = out.suggestedMonthly > 0 ? Math.ceil(remaining / out.suggestedMonthly) : 0;
    if (f.firstShortfallDate)
      warnings.push(
        `Scheduled payments push your cash below zero on ${f.firstShortfallDate}. Setting money aside now could make that worse.`,
      );
    else if (remaining > 0 && out.safeNow < Math.min(remaining, out.suggestedMonthly))
      warnings.push(
        "Known upcoming payments leave limited room right now, so the suggested contribution may be too much this month.",
      );
    if (current > cash) warnings.push("Your reserve is larger than the cash you have recorded.");
  }
  return out;
}

export interface MonthlyBaseline {
  revenue: number;
  cogs: number;
  opex: number;
  adSpend: number;
  shipping: number;
  payroll: number;
  netProfit: number;
  basisDays: number;
}

/* * Trailing average per 30 days used by scenarios. Null when there is too little history to say anything. */
export function monthlyBaseline(s: Snapshot): MonthlyBaseline | null {
  const days = 90;
  const from = addDays(s.today, -(days - 1));
  const rel = s.txns.filter((t) => t.date >= from && t.date <= s.today);
  if (rel.length === 0) return null;
  const first = rel.reduce((m, t) => (t.date < m ? t.date : m), s.today);
  const basisDays = Math.min(days, diffDays(s.today, first) + 1);
  if (basisDays < 14) return null;
  const start = addDays(s.today, -(basisDays - 1));
  const sum = summarize(s.txns, s.cats, s.currency, { from: start, to: s.today });
  const k = 30 / basisDays;
  const m = (v: number) => Math.round(v * k);
  const roleSum = (role: string) => {
    const ids = new Set(s.cats.filter((c) => c.role === role).flatMap((c) => [...descendants(s.cats, c.id)]));
    let v = 0;
    for (const t of s.txns) {
      if (
        t.type === "expense" &&
        t.currency === s.currency &&
        t.date >= start &&
        t.date <= s.today &&
        t.category_id &&
        ids.has(t.category_id)
      )
        v += t.amount;
    }
    return m(v);
  };
  return {
    revenue: m(sum.revenue),
    cogs: m(sum.cogs),
    opex: m(sum.opex),
    adSpend: roleSum("ads"),
    shipping: roleSum("shipping"),
    payroll: roleSum("payroll"),
    netProfit: m(sum.netProfit),
    basisDays,
  };
}

export function budgetView(s: Snapshot) {
  return budgetStatuses({
    budgets: s.budgets,
    cats: s.cats,
    txns: s.txns,
    recurring: s.recurring,
    invoices: s.invoices,
    currency: s.currency,
    today: s.today,
  });
}

export function summaryFor(
  s: Snapshot,
  kind: PeriodKind,
): { info: ReturnType<typeof periodInfo>; current: Summary; previous: Summary } {
  const info = periodInfo(kind, s.today);
  return {
    info,
    current: summarize(s.txns, s.cats, s.currency, info.current),
    previous: summarize(s.txns, s.cats, s.currency, info.previous),
  };
}
