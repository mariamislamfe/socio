// What-if simulation. Pure: takes a snapshot, returns baseline vs scenario. Never writes records.
import { addDays, occurrences, type ISODate } from "./dates";
import { descendants, forecast, invoiceOutstanding, typicalRates, type ForecastEvent } from "./engine";
import { mulDiv, pct } from "./money";
import { cashBalance, goalProgress, monthlyBaseline } from "./planning";
import type { Snapshot } from "./snapshot";

export type Adjustment =
  | { type: "ad_spend"; pct: number; assumedRoas?: number }
  | { type: "inventory"; amount: number; date: ISODate; expectedRevenue?: number; sellDays?: number }
  | { type: "hire"; monthlyCost: number; startDate: ISODate; oneTime?: number }
  | { type: "price"; pct: number; volumePct: number }
  | { type: "sales_drop"; pct: number }
  | { type: "late_payment"; invoiceId?: string; delayDays: number }
  | { type: "shipping"; pct: number }
  | { type: "supplier_cost"; pct: number }
  | { type: "new_product"; launchCost: number; monthlyRevenue: number; marginPct: number; startDate: ISODate };

export const ADJUSTMENT_LABELS: Record<Adjustment["type"], string> = {
  ad_spend: "Change advertising spend",
  inventory: "Buy a new inventory batch",
  hire: "Hire someone",
  price: "Change prices",
  sales_drop: "Sales drop",
  late_payment: "A customer pays late",
  shipping: "Shipping costs change",
  supplier_cost: "Supplier costs change",
  new_product: "Launch a new product",
};

export interface Metrics {
  monthlyRevenue: number;
  monthlyProfit: number;
  endCash: number;
  minCash: number;
  minCashDate: ISODate;
  firstShortfallDate: ISODate | null;
  cashAfterReserve: number;
}

export interface ScenarioResult {
  horizonDays: number;
  hasHistory: boolean;
  baseline: Metrics;
  scenario: Metrics;
  baselineSeries: { date: ISODate; balance: number }[];
  scenarioSeries: { date: ISODate; balance: number }[];
  budgets: { id: string; name: string; plannedMonthly: number; baselineMonthly: number; scenarioMonthly: number }[];
  reserved: number;
  events: ForecastEvent[];
  oneTimeCosts: number;
  assumptions: string[];
  warnings: string[];
}

interface Deltas {
  revenue: number;
  cogs: number;
  opex: number;
  roleDelta: Partial<Record<"ads" | "shipping" | "payroll", number>>;
}

export function simulate(s: Snapshot, adjustments: Adjustment[], horizonDays = 90): ScenarioResult {
  const base = monthlyBaseline(s);
  const hasHistory = !!base;
  const b = base ?? { revenue: 0, cogs: 0, opex: 0, adSpend: 0, shipping: 0, payroll: 0, netProfit: 0, basisDays: 0 };
  const typical = typicalRates(s.txns, s.cats, s.currency, s.today, s.recurring);
  const cash = cashBalance(s).total;
  const reserved = s.goals.filter((g) => g.type === "reserve").reduce((a, g) => a + g.contributed, 0);
  const assumptions: string[] = [];
  const warnings: string[] = [];
  const d: Deltas = { revenue: 0, cogs: 0, opex: 0, roleDelta: {} };
  const extra: ForecastEvent[] = [];
  const skip = new Set<string>();
  const end = addDays(s.today, horizonDays);
  const cogsRatio = b.revenue > 0 ? b.cogs / b.revenue : 0;
  let oneTimeCosts = 0;

  if (!hasHistory)
    warnings.push(
      "There is not enough recorded history (at least 14 days) to estimate typical sales and costs, so only the change caused by each decision is modelled.",
    );
  assumptions.push(
    "Baseline uses your recorded cash, scheduled payments and invoices, plus typical sales and spending from the last 90 days when available.",
  );

  for (const a of adjustments) {
    switch (a.type) {
      case "ad_spend": {
        const dAd = pct(b.adSpend, a.pct);
        d.opex += dAd;
        d.roleDelta.ads = (d.roleDelta.ads ?? 0) + dAd;
        if (b.adSpend === 0)
          warnings.push(
            "No advertising spend is recorded in an advertising category, so a percentage change has nothing to scale.",
          );
        if (a.assumedRoas && a.assumedRoas > 0) {
          const dRev = Math.round(dAd * a.assumedRoas);
          d.revenue += dRev;
          d.cogs += mulDiv(dRev, Math.round(cogsRatio * 10000), 10000);
          assumptions.push(`You assumed each extra 1 of ad spend brings ${a.assumedRoas} of revenue.`);
        } else
          assumptions.push("Extra ad spend is assumed to bring no extra revenue unless you set an expected return.");
        break;
      }
      case "inventory": {
        extra.push({ date: a.date, amount: -a.amount, label: "Inventory batch", kind: "scenario" });
        oneTimeCosts += a.amount;
        if (a.expectedRevenue && a.expectedRevenue > 0) {
          const sellDays = Math.max(7, a.sellDays ?? 60);
          const chunks = Math.max(1, Math.round(sellDays / 7));
          const per = Math.round(a.expectedRevenue / chunks);
          for (let i = 1; i <= chunks; i++)
            extra.push({
              date: addDays(a.date, i * 7),
              amount: per,
              label: "Sales from new batch",
              kind: "scenario",
              assumed: "Your expected sell-through",
            });
          assumptions.push(`New batch is assumed to generate ${a.expectedRevenue} in sales over ${sellDays} days.`);
        } else assumptions.push("No sales are assumed from the new inventory batch.");
        break;
      }
      case "hire": {
        d.opex += a.monthlyCost;
        d.roleDelta.payroll = (d.roleDelta.payroll ?? 0) + a.monthlyCost;
        for (const dt of occurrences(a.startDate, "monthly", addDays(s.today, 1), end))
          extra.push({ date: dt, amount: -a.monthlyCost, label: "New hire", kind: "scenario" });
        if (a.oneTime) {
          extra.push({ date: a.startDate, amount: -a.oneTime, label: "Hiring one-time cost", kind: "scenario" });
          oneTimeCosts += a.oneTime;
        }
        assumptions.push("The hire is assumed to add no revenue within this horizon.");
        break;
      }
      case "price": {
        const newRev = Math.round(b.revenue * (1 + a.pct / 100) * (1 + a.volumePct / 100));
        d.revenue += newRev - b.revenue;
        d.cogs += pct(b.cogs, a.volumePct);
        assumptions.push(
          `Prices change by ${a.pct}% and unit volume by ${a.volumePct}% (your assumption). Product costs per unit are unchanged.`,
        );
        break;
      }
      case "sales_drop": {
        d.revenue += -pct(b.revenue, a.pct);
        d.cogs += -pct(b.cogs, a.pct);
        assumptions.push("Product costs fall in proportion to sales; operating expenses stay fixed.");
        break;
      }
      case "supplier_cost": {
        d.cogs += pct(b.cogs, a.pct);
        if (b.cogs === 0)
          warnings.push("No cost of goods is recorded, so a supplier price change has nothing to scale.");
        assumptions.push(`Product costs change by ${a.pct}%; prices and sales volume stay the same.`);
        break;
      }
      case "shipping": {
        const dSh = pct(b.shipping, a.pct);
        d.opex += dSh;
        d.roleDelta.shipping = (d.roleDelta.shipping ?? 0) + dSh;
        if (b.shipping === 0)
          warnings.push(
            "No shipping costs are recorded in a shipping category, so a percentage change has nothing to scale.",
          );
        break;
      }
      case "new_product": {
        d.revenue += a.monthlyRevenue;
        d.cogs += mulDiv(a.monthlyRevenue, 10000 - Math.round(a.marginPct * 100), 10000);
        extra.push({ date: a.startDate, amount: -a.launchCost, label: "Product launch", kind: "scenario" });
        oneTimeCosts += a.launchCost;
        assumptions.push(
          `New product revenue of ${a.monthlyRevenue}/month at a ${a.marginPct}% gross margin is your estimate, not a prediction.`,
        );
        break;
      }
      case "late_payment": {
        const inv =
          s.invoices.find((i) => i.id === a.invoiceId) ??
          [...s.invoices]
            .filter((i) => i.direction === "receivable" && i.status === "open" && invoiceOutstanding(i) > 0)
            .sort((x, y) => invoiceOutstanding(y) - invoiceOutstanding(x))[0];
        if (!inv) {
          warnings.push("There is no open receivable to delay.");
          break;
        }
        skip.add(inv.id);
        const expected = inv.due_date < s.today ? addDays(s.today, 14) : inv.due_date;
        extra.push({
          date: addDays(expected, a.delayDays),
          amount: invoiceOutstanding(inv),
          label: `${inv.description || inv.number || "Invoice"} (paid late)`,
          kind: "scenario",
          assumed: `${a.delayDays} days late`,
        });
        assumptions.push(
          `"${inv.description || inv.number || "Invoice"}" is assumed to arrive ${a.delayDays} days after its expected date.`,
        );
        break;
      }
    }
  }

  const mk = (opts: { d: Deltas; extraEvents: ForecastEvent[]; skipIds: Set<string> }) =>
    forecast({
      today: s.today,
      days: horizonDays,
      startCash: cash,
      currency: s.currency,
      recurring: s.recurring,
      invoices: s.invoices,
      options: {
        includeTypical: true,
        typicalInPerDay: Math.max(0, (typical?.inPerDay ?? 0) + Math.round(opts.d.revenue / 30)),
        typicalOutPerDay: Math.max(
          0,
          (typical?.outPerDay ?? 0) + Math.round((opts.d.cogs + (opts.d.opex - sumRoleHire(opts.d))) / 30),
        ),
        extraEvents: opts.extraEvents,
        skipInvoiceIds: opts.skipIds,
      },
    });

  const zero: Deltas = { revenue: 0, cogs: 0, opex: 0, roleDelta: {} };
  const fb = mk({ d: zero, extraEvents: [], skipIds: new Set() });
  const fs = mk({ d, extraEvents: extra, skipIds: skip });

  if (!typical)
    assumptions.push(
      "There is not enough history to estimate typical day-to-day sales and spending, so those are not part of either line.",
    );
  else
    assumptions.push(
      `Typical activity is the average of the last ${typical.days} days, excluding payments already scheduled.`,
    );

  const metrics = (f: typeof fb, revDelta: number, profitDelta: number): Metrics => ({
    monthlyRevenue: b.revenue + revDelta,
    monthlyProfit: b.netProfit + profitDelta,
    endCash: f.endCash,
    minCash: f.minCash,
    minCashDate: f.minCashDate,
    firstShortfallDate: f.firstShortfallDate,
    cashAfterReserve: f.endCash - reserved,
  });
  const profitDelta = d.revenue - d.cogs - d.opex;

  const budgets: ScenarioResult["budgets"] = [];
  for (const bd of s.budgets) {
    const cat = s.cats.find((c) => c.id === bd.category_id);
    if (!cat?.role || !(cat.role in d.roleDelta)) continue;
    const ids = descendants(s.cats, cat.id);
    let v = 0;
    const from = addDays(s.today, -(Math.max(30, b.basisDays) - 1));
    for (const t of s.txns)
      if (
        t.type === "expense" &&
        t.currency === s.currency &&
        t.date >= from &&
        t.date <= s.today &&
        t.category_id &&
        ids.has(t.category_id)
      )
        v += t.amount;
    const monthly = Math.round((v / Math.max(30, b.basisDays)) * 30);
    const planned =
      bd.period === "monthly"
        ? bd.amount
        : bd.period === "quarterly"
          ? Math.round(bd.amount / 3)
          : Math.round(bd.amount / 12);
    budgets.push({
      id: bd.id,
      name: cat.name,
      plannedMonthly: planned,
      baselineMonthly: monthly,
      scenarioMonthly: monthly + (d.roleDelta[cat.role as "ads"] ?? 0),
    });
  }
  void goalProgress;

  return {
    horizonDays,
    hasHistory,
    baseline: metrics(fb, 0, 0),
    scenario: metrics(fs, d.revenue, profitDelta),
    baselineSeries: fb.points.map((p) => ({ date: p.date, balance: p.balance })),
    scenarioSeries: fs.points.map((p) => ({ date: p.date, balance: p.balance })),
    budgets,
    reserved,
    events: extra,
    oneTimeCosts,
    assumptions: [...new Set(assumptions)],
    warnings,
  };
}

// Hire costs are modelled as dated events, so they must not also be spread into the daily typical rate.
function sumRoleHire(d: Deltas): number {
  return d.roleDelta.payroll ?? 0;
}
