// Business-health detectors: pure and deterministic, like the cash-risk analysis. Each one returns a finding with
// computed facts, plausible (unconfirmed) explanations, unknowns, and options whose effect is calculated, or null.
import { addDays, diffDays, startOfMonth, type ISODate } from "./dates";
import { descendants, summarize, type Txn } from "./engine";
import { formatMoney, mulDiv } from "./money";
import { baseForecast, cashBalance, monthlyBaseline } from "./planning";
import type { ProductEconomics } from "./profit";
import type { Snapshot } from "./snapshot";

export type FindingKind = "product_loss" | "ads_burn" | "tax_setaside";

export interface FindingMetric {
  label: string;
  value: number;
  format: "money" | "pct" | "ratio" | "count";
  tone?: "pos" | "neg" | "warn";
}

export interface FindingOption {
  key: string;
  title: string;
  description: string;
  /* * Change in monthly profit if taken (null = cannot be estimated honestly). */
  monthlyProfitImpact: number | null;
  /* * Change in cash over the next 60 days if taken. */
  cash60Impact: number | null;
  execution: { tool: "manual" } | { tool: "create_tax_reserve"; params: { amount: number; label: string } };
  assumptions: string[];
}

export interface Finding {
  kind: FindingKind;
  dedupeKey: string;
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  facts: string[];
  hypotheses: string[];
  unknowns: string[];
  metrics: FindingMetric[];
  options: FindingOption[];
}

const pctText = (x: number) => `${Math.round(x * 100)}%`;

// 1. A product that loses money

export function detectProductLoss(args: {
  currency: string;
  products: ProductEconomics[];
  revenue: number; // sales revenue in the same range (ledger)
  ads: number; // advertising in the same range
  rangeDays: number;
}): Finding | null {
  const fm = (v: number) => formatMoney(v, args.currency);
  const scale = 30 / Math.max(1, args.rangeDays);
  const known = args.products.filter((p) => p.costKnown && p.contribution !== null && p.units >= 3 && p.revenue > 0);
  const totalRev = known.reduce((a, p) => a + p.revenue, 0) || 1;
  const rows = known.map((p) => {
    // Advertising cannot be traced to a product reliably; it is spread by share of sales and labelled as such.
    const adShare =
      args.ads > 0 && args.revenue > 0 ? Math.round((args.ads * p.revenue) / Math.max(args.revenue, totalRev)) : 0;
    return { p, adShare, before: p.contribution!, after: p.contribution! - adShare };
  });
  const losing = rows.filter((r) => r.after < 0).sort((a, b) => a.after - b.after);
  const worst = losing[0];
  if (!worst) return null;

  const { p, adShare, before, after } = worst;
  const certain = before < 0;
  const avgPrice = Math.round(p.revenue / p.units);
  const unitCost = Math.round((p.cogs ?? 0) / p.units);
  const unitVariable = Math.round(p.variableCosts / p.units);
  const unitAds = Math.round(adShare / p.units);
  const lossPerUnit = Math.round(-after / p.units);
  const monthlyLoss = Math.round(-after * scale);
  const raise = lossPerUnit; // price increase per unit that brings it to break-even at today's volume
  const raisePct = avgPrice > 0 ? raise / avgPrice : 0;

  const facts = [
    `${p.title} sold ${p.units} unit${p.units === 1 ? "" : "s"} for ${fm(p.revenue)} in the last ${args.rangeDays} days (about ${fm(avgPrice)} each).`,
    `Each unit costs about ${fm(unitCost)} to buy or make, plus about ${fm(unitVariable)} in fees, shipping and packaging.`,
    certain
      ? `Before any advertising it already loses ${fm(Math.round(-before / p.units))} per unit.`
      : `Before advertising it earns ${fm(Math.round(before / p.units))} per unit; its share of ad spend (${fm(unitAds)} per unit) turns that into a loss of ${fm(lossPerUnit)}.`,
    `At this pace that is about ${fm(monthlyLoss)} lost per month.`,
  ];
  const hypotheses: string[] = [];
  if (unitVariable > avgPrice * 0.3)
    hypotheses.push(
      "Shipping is a large share of its price; it may often be ordered alone rather than with other items.",
    );
  if (!certain)
    hypotheses.push("Ads may not actually drive this product's sales; the loss depends on how ad spend is split.");
  if (losing.length > 1)
    hypotheses.push(
      `${losing.length - 1} other product${losing.length > 2 ? "s also look" : " also looks"} unprofitable after costs.`,
    );
  const unknowns = [
    "Advertising is spread across products by their share of sales, because no reliable per-product ad data exists.",
    "Customers who buy this product may also buy others; stopping it could lose some of those sales.",
  ];

  const options: FindingOption[] = [
    {
      key: "raise_price",
      title: `Raise the price of ${p.title} by ${fm(raise)} (${pctText(raisePct)})`,
      description: `A price of about ${fm(avgPrice + raise)} covers its cost, fees, shipping and ad share at today's volume.`,
      monthlyProfitImpact: monthlyLoss,
      cash60Impact: monthlyLoss * 2,
      execution: { tool: "manual" },
      assumptions: ["Assumes the same number of units sell at the new price; some buyers may not."],
    },
    {
      key: "bundle_only",
      title: `Sell ${p.title} only with other items (bundle or minimum order)`,
      description: "Shipping is then shared with a larger order, which usually removes most of the loss.",
      monthlyProfitImpact: null,
      cash60Impact: null,
      execution: { tool: "manual" },
      assumptions: ["The effect depends on how customers respond, so it is not estimated."],
    },
    {
      key: "stop",
      title: `Stop selling ${p.title}`,
      description: `Removes a loss of about ${fm(monthlyLoss)} a month.`,
      monthlyProfitImpact: monthlyLoss,
      cash60Impact: monthlyLoss * 2,
      execution: { tool: "manual" },
      assumptions: ["Assumes no other sales are lost with it."],
    },
  ];
  if (unitCost > 0) {
    const cut = Math.min(unitCost, lossPerUnit);
    options.push({
      key: "supplier",
      title: `Ask the supplier for ${fm(cut)} less per unit`,
      description:
        cut >= lossPerUnit
          ? "That alone would bring it to break-even."
          : "That reduces, but does not remove, the loss.",
      monthlyProfitImpact: Math.round(cut * p.units * scale),
      cash60Impact: Math.round(cut * p.units * scale) * 2,
      execution: { tool: "manual" },
      assumptions: ["Only if the supplier agrees."],
    });
  }

  return {
    kind: "product_loss",
    dedupeKey: `product_loss:${p.key}`,
    severity: certain ? "warning" : "info",
    title: `${p.title} loses about ${fm(lossPerUnit)} on every sale`,
    summary: `${certain ? "Even before advertising" : "After its share of advertising"}, ${p.title} costs more to sell than it brings in — about ${fm(monthlyLoss)} a month. The simplest fix: raise its price by ${pctText(raisePct)}.`,
    facts,
    hypotheses,
    unknowns,
    metrics: [
      { label: "Price", value: avgPrice, format: "money" },
      { label: "Cost + fees + shipping", value: unitCost + unitVariable, format: "money" },
      { label: "Ad share per unit", value: unitAds, format: "money" },
      { label: "Result per unit", value: -lossPerUnit, format: "money", tone: "neg" },
    ],
    options,
  };
}

// 2. Advertising that burns money

function inRange(t: Txn, from: ISODate, to: ISODate) {
  return t.date >= from && t.date <= to;
}

export function detectAdsBurn(s: Snapshot, window = 28): Finding | null {
  const fm = (v: number) => formatMoney(v, s.currency);
  const adIds = new Set(s.cats.filter((c) => c.role === "ads").flatMap((c) => [...descendants(s.cats, c.id)]));
  const curFrom = addDays(s.today, -(window - 1));
  const prevTo = addDays(curFrom, -1);
  const prevFrom = addDays(prevTo, -(window - 1));
  const spend = (from: ISODate, to: ISODate) =>
    s.txns
      .filter(
        (t) =>
          t.type === "expense" &&
          t.currency === s.currency &&
          t.category_id &&
          adIds.has(t.category_id) &&
          inRange(t, from, to),
      )
      .reduce((a, t) => a + t.amount, 0);
  const spendCur = spend(curFrom, s.today);
  const spendPrev = spend(prevFrom, prevTo);
  if (spendPrev <= 0 || spendCur <= spendPrev) return null;
  const sumCur = summarize(s.txns, s.cats, s.currency, { from: curFrom, to: s.today });
  const sumPrev = summarize(s.txns, s.cats, s.currency, { from: prevFrom, to: prevTo });
  const dSpend = spendCur - spendPrev;
  const dRev = sumCur.revenue - sumPrev.revenue;
  const spendGrowth = dSpend / spendPrev;
  if (spendGrowth < 0.2) return null;

  // What each extra unit of revenue keeps after product costs (gross margin, last 90 days).
  const base = monthlyBaseline(s);
  const gm = base && base.revenue > 0 ? Math.max(0, (base.revenue - base.cogs) / base.revenue) : null;
  if (gm === null || gm === 0) return null;
  const extraGross = Math.round(dRev * gm);
  const netEffect = extraGross - dSpend; // what the extra spend added to profit in the window
  if (netEffect >= 0) return null;

  const marginalRoas = dRev / dSpend;
  const breakEven = 1 / gm;
  const k = 30 / window;
  const monthlyWaste = Math.round(-netEffect * k);
  const revGrowth = sumPrev.revenue > 0 ? dRev / sumPrev.revenue : 0;

  // Re-forecast cash with spend back at the previous level: the extra spend stops, the extra gross profit is lost too.
  const f0 = baseForecast(s, 60);
  const cash60Back = Math.round(monthlyWaste * 2);
  const cutTo = Math.round(spendCur * 0.7);
  const cut30Saving = Math.round((spendCur - cutTo) * k);

  const facts = [
    `Advertising: ${fm(spendCur)} in the last ${window} days, up ${pctText(spendGrowth)} from ${fm(spendPrev)} the ${window} days before.`,
    `Sales: ${fm(sumCur.revenue)}, ${dRev >= 0 ? `up ${pctText(revGrowth)}` : `down ${pctText(-revGrowth)}`} (${dRev >= 0 ? "+" : ""}${fm(dRev)}).`,
    `Each extra 1 spent on ads brought about ${marginalRoas.toFixed(2)} in sales. With a ${pctText(gm)} gross margin you need at least ${breakEven.toFixed(2)} just to break even.`,
    `So the extra spend cost about ${fm(-netEffect)} more than it earned — about ${fm(monthlyWaste)} a month.`,
  ];
  const hypotheses: string[] = [];
  const platform = s.ads.filter((a) => a.currency === s.currency && a.date >= curFrom && a.date <= s.today);
  if (platform.length) {
    const byCampaign = new Map<string, { name: string; spend: number; rev: number }>();
    for (const a of platform) {
      const c = byCampaign.get(a.campaign_id) ?? { name: a.campaign_name, spend: 0, rev: 0 };
      c.spend += a.spend;
      c.rev += a.attributed_revenue;
      byCampaign.set(a.campaign_id, c);
    }
    const worstC = [...byCampaign.values()]
      .filter((c) => c.spend > 0)
      .sort((a, b) => a.rev / a.spend - b.rev / b.spend)[0];
    if (worstC)
      hypotheses.push(
        `The ad platform credits "${worstC.name}" with the lowest return (${(worstC.rev / worstC.spend).toFixed(2)} per 1 spent); platforms tend to over-credit themselves.`,
      );
  }
  hypotheses.push("Results from new ads can lag by a week or two; part of the effect may still be coming.");
  if (dRev < 0)
    hypotheses.push("Sales fell despite more ads: seasonality, stock-outs or price changes may also be involved.");
  const unknowns = [
    "Ad spend comes from expenses recorded in advertising categories; spend paid outside them is not seen.",
    "Sales are your total sales, not only those caused by ads.",
  ];

  return {
    kind: "ads_burn",
    dedupeKey: `ads_burn:${curFrom.slice(0, 7)}`,
    severity: monthlyWaste > Math.max(1, spendPrev) * 0.25 ? "warning" : "info",
    title: `Extra ad spend is costing about ${fm(monthlyWaste)} a month more than it earns`,
    summary: `Ads went up ${pctText(spendGrowth)} but sales ${dRev >= 0 ? `only rose ${pctText(revGrowth)}` : "fell"}. Going back to the previous level would keep about ${fm(cash60Back)} more cash over the next 60 days.`,
    facts,
    hypotheses,
    unknowns,
    metrics: [
      { label: "Ad spend change", value: spendGrowth, format: "pct", tone: "warn" },
      { label: "Sales change", value: revGrowth, format: "pct", tone: dRev >= 0 ? undefined : "neg" },
      { label: "Return on extra spend", value: marginalRoas, format: "ratio", tone: "neg" },
      { label: "Needed to break even", value: breakEven, format: "ratio" },
    ],
    options: [
      {
        key: "back_to_previous",
        title: `Bring ad spend back to about ${fm(Math.round(spendPrev * k))} a month`,
        description: `Stops the extra spend that did not pay for itself. Lowest cash in the next 60 days rises from ${fm(f0.minCash)} to about ${fm(f0.minCash + Math.round(cash60Back / 2))}.`,
        monthlyProfitImpact: monthlyWaste,
        cash60Impact: cash60Back,
        execution: { tool: "manual" },
        assumptions: [
          "Assumes the sales gained from the extra spend are lost too (already counted).",
          "Has to be changed in your ad platform: this app only reads ad data.",
        ],
      },
      {
        key: "cut_30",
        title: "Cut ad spend by 30% and watch sales for two weeks",
        description: `Saves about ${fm(cut30Saving)} a month in spend; check sales before cutting more.`,
        monthlyProfitImpact: null,
        cash60Impact: cut30Saving * 2,
        execution: { tool: "manual" },
        assumptions: ["Cash saving only: the effect on sales is unknown until you test it."],
      },
      {
        key: "pause_worst",
        title: "Pause the weakest campaign first",
        description: "Keep what works, stop what does not. Use the platform's results as a guide, not as proof.",
        monthlyProfitImpact: null,
        cash60Impact: null,
        execution: { tool: "manual" },
        assumptions: ["Platform-reported results are attribution estimates."],
      },
    ],
  };
}

// 3. Money that belongs to the tax office

export interface TaxSettings {
  vatRegistered?: boolean;
  vatRatePct?: number; // Egypt standard rate: 14
  pricesIncludeVat?: boolean; // default true
  incomeTaxReservePct?: number | null; // optional: share of profit to put aside for income tax
}

export interface TaxPosition {
  vatRate: number;
  vatThisMonth: number;
  vatLastMonth: number;
  lastMonthPaid: boolean;
  vatOwed: number;
  incomeTaxReserve: number;
  total: number;
  dueBy: ISODate;
}

function vatIn(amount: number, ratePct: number, inclusive: boolean) {
  return inclusive
    ? mulDiv(amount, Math.round(ratePct * 100), 10_000 + Math.round(ratePct * 100))
    : mulDiv(amount, Math.round(ratePct * 100), 10_000);
}

/* * How much of today's cash is estimated to belong to the tax office (VAT collected, plus an optional income-tax reserve). */
export function taxPosition(s: Snapshot, t: TaxSettings): TaxPosition | null {
  if (!t.vatRegistered && !t.incomeTaxReservePct) return null;
  const rate = t.vatRatePct ?? 14;
  const inclusive = t.pricesIncludeVat !== false;
  const monthStart = startOfMonth(s.today);
  const lastStart = startOfMonth(addDays(monthStart, -1));
  const lastEnd = addDays(monthStart, -1);
  const salesThis = summarize(s.txns, s.cats, s.currency, { from: monthStart, to: s.today }).revenue;
  const salesLast = summarize(s.txns, s.cats, s.currency, { from: lastStart, to: lastEnd }).revenue;
  const taxCats = new Set(
    s.cats.filter((c) => /tax|ضريب/i.test(c.name)).flatMap((c) => [...descendants(s.cats, c.id)]),
  );
  const paidThisMonth = s.txns.some(
    (x) =>
      x.type === "expense" && x.category_id && taxCats.has(x.category_id) && x.date >= monthStart && x.date <= s.today,
  );
  const vatThisMonth = t.vatRegistered ? vatIn(Math.max(0, salesThis), rate, inclusive) : 0;
  const vatLastMonth = t.vatRegistered ? vatIn(Math.max(0, salesLast), rate, inclusive) : 0;
  const vatOwed = vatThisMonth + (paidThisMonth ? 0 : vatLastMonth);
  let incomeTaxReserve = 0;
  if (t.incomeTaxReservePct && t.incomeTaxReservePct > 0) {
    const yearStart = `${s.today.slice(0, 4)}-01-01` as ISODate;
    const p = summarize(s.txns, s.cats, s.currency, { from: yearStart, to: s.today }).netProfit;
    incomeTaxReserve = Math.max(0, Math.round((p * t.incomeTaxReservePct) / 100));
  }
  return {
    vatRate: rate,
    vatThisMonth,
    vatLastMonth,
    lastMonthPaid: paidThisMonth,
    vatOwed,
    incomeTaxReserve,
    total: vatOwed + incomeTaxReserve,
    dueBy: addDays(startOfMonth(addDays(monthStart, 40)), -1), // end of this month: planning date for last month's return
  };
}

export function detectTaxSetAside(
  s: Snapshot,
  t: TaxSettings,
  reserve: number | null,
  alreadySetAside: number,
): Finding | null {
  const pos = taxPosition(s, t);
  if (!pos || pos.total <= 0) return null;
  const fm = (v: number) => formatMoney(v, s.currency);
  const cash = cashBalance(s).total;
  const next30 = baseForecast(s, 30);
  const outflows30 = next30.events.filter((e) => e.amount < 0).reduce((a, e) => a - e.amount, 0);
  const trulyYours = cash - pos.total;
  const afterBills = trulyYours - outflows30;
  const gap = Math.max(0, pos.total - alreadySetAside);
  const spentIt = trulyYours < 0 || afterBills < (reserve ?? 0);
  const severity: Finding["severity"] = trulyYours < 0 ? "critical" : spentIt ? "warning" : "info";

  const facts: string[] = [];
  if (pos.vatThisMonth)
    facts.push(
      `Sales this month include about ${fm(pos.vatThisMonth)} of VAT (${pos.vatRate}%) that you collected for the tax office.`,
    );
  if (pos.vatLastMonth)
    facts.push(
      pos.lastMonthPaid
        ? "A tax payment is recorded this month, so last month's VAT is treated as paid."
        : `Last month's sales carried about ${fm(pos.vatLastMonth)} of VAT; plan to pay it by ${pos.dueBy}.`,
    );
  if (pos.incomeTaxReserve)
    facts.push(
      `Your income-tax reserve (${t.incomeTaxReservePct}% of this year's profit) is ${fm(pos.incomeTaxReserve)}.`,
    );
  facts.push(
    `Recorded cash is ${fm(cash)}; after taxes, about ${fm(trulyYours)} is really yours. Scheduled payments in the next 30 days: ${fm(outflows30)}.`,
  );
  if (alreadySetAside > 0) facts.push(`You have already put ${fm(alreadySetAside)} aside in a tax reserve.`);

  return {
    kind: "tax_setaside",
    dedupeKey: `tax_setaside:${s.today.slice(0, 7)}`,
    severity,
    title:
      trulyYours < 0
        ? `Part of the tax money has already been spent (${fm(-trulyYours)} short)`
        : spentIt
          ? `After taxes and bills, cash is thinner than it looks`
          : `Put ${fm(gap || pos.total)} aside for taxes`,
    summary: `About ${fm(pos.total)} of your cash belongs to the tax office. ${trulyYours < 0 ? "Your cash does not cover it, so the next payment will hurt unless sales come in first." : spentIt ? `Once it is paid and the next 30 days of bills go out, you are left with ${fm(afterBills)}.` : "Keeping it separate stops it from being spent by accident."}`,
    facts,
    hypotheses: [],
    unknowns: [
      "VAT you paid on purchases reduces what you owe; without purchase invoices this is a conservative (higher) estimate.",
      `Assumes your prices ${t.pricesIncludeVat === false ? "exclude" : "include"} VAT and that all recorded sales are taxable. Confirm the amount with your accountant.`,
      "The pay-by date is a planning date, not a legal deadline.",
    ],
    metrics: [
      { label: "Cash recorded", value: cash, format: "money" },
      { label: "Belongs to the tax office", value: pos.total, format: "money", tone: "warn" },
      { label: "Really yours", value: trulyYours, format: "money", tone: trulyYours < 0 ? "neg" : undefined },
      {
        label: "After 30 days of bills",
        value: afterBills,
        format: "money",
        tone: afterBills < (reserve ?? 0) ? "neg" : undefined,
      },
    ],
    options: [
      ...(gap > 0
        ? [
            {
              key: "set_aside",
              title: `Put ${fm(gap)} into a tax reserve`,
              description:
                "A labelled reserve shows this money as not available, so it is not spent by mistake. Move the same amount to a separate account if you can.",
              monthlyProfitImpact: 0,
              cash60Impact: 0,
              execution: { tool: "create_tax_reserve" as const, params: { amount: pos.total, label: "Tax set-aside" } },
              assumptions: ["Bookkeeping only: no money is moved by the app."],
            },
          ]
        : []),
      {
        key: "file_on_time",
        title: `Plan the VAT payment before ${pos.dueBy}`,
        description:
          "Paying on time avoids penalties; record the payment under a tax category so the estimate updates.",
        monthlyProfitImpact: null,
        cash60Impact: null,
        execution: { tool: "manual" },
        assumptions: [],
      },
    ],
  };
}

export function daysBetween(a: ISODate, b: ISODate) {
  return diffDays(a, b);
}
