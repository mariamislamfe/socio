import { periodInfo } from "@/lib/finance/dates";
import { invoiceOutstanding, runway, summarize } from "@/lib/finance/engine";
import { estimateValuation, readiness, type Asset } from "@/lib/finance/health";
import { adsSummary } from "@/lib/finance/insights";
import { formatMoney } from "@/lib/finance/money";
import { baseForecast, budgetView, cashBalance, goalProgress } from "@/lib/finance/planning";
import type { Snapshot } from "@/lib/finance/snapshot";

/* * A compact, pre-formatted fact sheet. Agents may only quote what is in here (or in scenario results). */
export function buildFacts(
  s: Snapshot,
  assets: Asset[],
  business: { name: string; type: string; country: string; stage: string; channels: string[] },
  compliance: { requiredDone: number; requiredTotal: number; overdue: string[] },
) {
  const fm = (v: number) => formatMoney(v, s.currency);
  const m = periodInfo("month", s.today);
  const cur = summarize(s.txns, s.cats, s.currency, m.current);
  const prev = summarize(s.txns, s.cats, s.currency, m.previous);
  const cash = cashBalance(s).total;
  const f = baseForecast(s, 60);
  const rw = runway(cash, s.txns, s.cats, s.currency, s.today);
  const val = estimateValuation(s, assets);
  const ready = readiness(s, compliance);
  const ads = adsSummary(s.ads, s.currency, m.current);
  const open = (dir: "receivable" | "payable") =>
    s.invoices.filter((i) => i.direction === dir && i.status === "open" && i.currency === s.currency);
  const recv = open("receivable");
  const pay = open("payable");
  return {
    business: {
      name: business.name,
      type: business.type,
      country: business.country,
      stage: business.stage,
      channels: business.channels,
      currency: s.currency,
      today: s.today,
    },
    thisMonthSoFar: {
      daysElapsed: m.elapsedDays,
      daysInMonth: m.totalDays,
      revenue: fm(cur.revenue),
      refunds: fm(cur.refunds),
      costOfGoods: fm(cur.cogs),
      operatingExpenses: fm(cur.opex),
      netProfit: fm(cur.netProfit),
      marginPercent: cur.margin === null ? null : Math.round(cur.margin * 100),
      profitIsIncomplete: cur.incomplete,
      lastMonthSameDays: { revenue: fm(prev.revenue), netProfit: fm(prev.netProfit) },
    },
    cash: {
      today: fm(cash),
      lowestInNext60Days: fm(f.minCash),
      lowestOn: f.minCashDate,
      firstShortfall: f.firstShortfallDate,
      runwayMonths:
        rw.months === null
          ? rw.monthlyBurn === null
            ? "not burning cash / not enough history"
            : "unknown"
          : Number(rw.months.toFixed(1)),
      monthlyNetBurn: rw.monthlyBurn === null ? null : fm(rw.monthlyBurn),
    },
    upcoming30Days: f.events
      .filter((e) => e.date <= f.points[Math.min(30, f.points.length - 1)].date)
      .slice(0, 10)
      .map((e) => `${e.date} ${e.label}: ${fm(e.amount)}${e.assumed ? ` (${e.assumed})` : ""}`),
    owedToYou: {
      total: fm(recv.reduce((a, i) => a + invoiceOutstanding(i), 0)),
      overdue: fm(recv.filter((i) => i.due_date < s.today).reduce((a, i) => a + invoiceOutstanding(i), 0)),
    },
    youOwe: {
      total: fm(pay.reduce((a, i) => a + invoiceOutstanding(i), 0)),
      overdue: fm(pay.filter((i) => i.due_date < s.today).reduce((a, i) => a + invoiceOutstanding(i), 0)),
    },
    budgets: budgetView(s).map(
      (b) =>
        `${b.categoryName}: spent ${fm(b.spent)} of ${fm(b.planned)} (${b.status.replace("_", " ")}, ${Math.round(b.timeElapsedPct * 100)}% of period elapsed)`,
    ),
    goals: s.goals.map((g) => {
      const p = goalProgress(g, s);
      return `${p.name} (${p.type}): ${fm(p.current)} of ${fm(p.target)}`;
    }),
    advertising:
      ads.spend > 0
        ? {
            spend: fm(ads.spend),
            attributedRevenue: fm(ads.attributedRevenue),
            roas: ads.roas === null ? null : Number(ads.roas.toFixed(2)),
            note: "ROAS is platform-attributed revenue per 1 spent, not profit",
          }
        : "no platform ad data connected",
    productCosts: s.productCount
      ? `${s.productCount - s.productsWithoutCost} of ${s.productCount} products have a unit cost`
      : "no products recorded",
    valuationEstimate: {
      low: fm(val.low),
      mid: fm(val.mid),
      high: fm(val.high),
      confidence: val.confidence,
      monthsOfHistory: val.windowMonths,
      method: "rough multiples of yearly profit and revenue plus net assets; not an official valuation",
    },
    readiness: { score: ready.score, failing: ready.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`) },
    compliance: {
      requiredDone: compliance.requiredDone,
      requiredTotal: compliance.requiredTotal,
      overdueItems: compliance.overdue,
    },
    dataQuality: { transactions: s.txns.length, monthsOfHistory: val.windowMonths },
  };
}
