// Financing: what is needed, what each offer really costs, whether it actually fixes the cash gap without creating a
// new one, and which warning signs an offer shows. Pure and deterministic; amounts in minor units.
import { assessDataQuality, SALES_HAIRCUT } from "./cashrisk";
import { addDays, diffDays, type ISODate } from "./dates";
import { forecast, typicalRates, type ForecastEvent } from "./engine";
import { formatMoney } from "./money";
import { cashBalance, monthlyBaseline } from "./planning";
import { invoiceOutstanding, summarize } from "./engine";
import type { Snapshot } from "./snapshot";

export type OfferKind =
  | "supplier_credit"
  | "invoice_financing"
  | "overdraft"
  | "term_loan"
  | "revenue_advance"
  | "owner_funds"
  | "other";
export type Repayment = "bullet" | "monthly" | "weekly" | "daily_sales";

export interface OfferFlags {
  upfrontPaymentRequested?: boolean; // asks for money before you receive anything
  pressureToSignToday?: boolean;
  guaranteedApproval?: boolean; // "approved regardless of history"
  notLicensed?: boolean; // lender is not registered with the regulator (CBE / FRA in Egypt)
  personalAccountPayment?: boolean; // asks to pay fees to a personal account / wallet
}

export interface Offer {
  id: string;
  lender: string;
  kind: OfferKind;
  amount: number; // what the lender advances (before fees)
  upfrontFee: number; // deducted or paid at the start
  ratePct: number | null; // nominal annual interest rate
  flatFee: number | null; // fixed cost added to the repayment (e.g. "factor fee", lost supplier discount)
  termDays: number;
  repayment: Repayment;
  revenueSharePct: number | null; // for daily_sales: share of daily sales withheld
  flags: OfferFlags;
  source?: "user" | "demo";
}

export interface Flow {
  date: ISODate;
  amount: number; // + received, − repaid
}

export interface RedFlag {
  level: "danger" | "warning";
  text: string;
}

export interface OfferAnalysis {
  offer: Offer;
  received: number;
  totalRepaid: number;
  cost: number; // totalRepaid − received
  apr: number | null; // effective annual rate (0.25 = 25%); null if it cannot be computed
  payoffDate: ISODate;
  flows: Flow[];
  covers: boolean; // keeps cash at or above the reserve over the horizon
  newLowest: number;
  newLowestDate: ISODate;
  newBreachDate: ISODate | null;
  flags: RedFlag[];
  verdict: "best" | "ok" | "risky" | "avoid";
  explanation: string;
}

export interface FinancingNeed {
  basis: string;
  atRisk: boolean;
  amount: number; // how much is needed to stay at the reserve
  neededBy: ISODate | null;
  lowest: number;
  lowestDate: ISODate;
  reserve: number;
  horizonDays: number;
}

export const KIND_LABEL: Record<OfferKind, string> = {
  supplier_credit: "Supplier credit (pay a bill later)",
  invoice_financing: "Invoice financing (advance on what customers owe)",
  overdraft: "Overdraft / credit line",
  term_loan: "Short-term loan",
  revenue_advance: "Revenue advance (repaid from daily sales)",
  owner_funds: "Owner or family funds",
  other: "Other",
};

const HORIZON = 120;

function runner(s: Snapshot) {
  const cash = cashBalance(s).total;
  const typical = typicalRates(s.txns, s.cats, s.currency, s.today, s.recurring);
  const options = typical
    ? {
        includeTypical: true,
        typicalInPerDay: Math.round(typical.inPerDay * SALES_HAIRCUT),
        typicalOutPerDay: typical.outPerDay,
      }
    : {};
  const basis = typical
    ? `Scheduled payments and invoices, plus typical daily sales (at ${Math.round(SALES_HAIRCUT * 100)}% of your last ${typical.days} days, to stay on the safe side) and typical spending.`
    : "Scheduled payments and invoices only: there is not enough history to include typical sales.";
  return {
    typical,
    basis,
    run: (extra: ForecastEvent[]) =>
      forecast({
        today: s.today,
        days: HORIZON,
        startCash: cash,
        currency: s.currency,
        recurring: s.recurring,
        invoices: s.invoices,
        options: { ...options, extraEvents: extra },
      }),
  };
}

/* * How much money is needed, and by when, to keep cash at the reserve over the next 120 days. */
export function financingNeed(s: Snapshot, reserve: number | null): FinancingNeed {
  const r = Math.max(0, reserve ?? 0);
  const { run, basis } = runner(s);
  const f = run([]);
  const breach = f.points.find((p) => p.balance < r)?.date ?? null;
  return {
    basis,
    atRisk: !!breach,
    amount: Math.max(0, r - f.minCash),
    neededBy: breach,
    lowest: f.minCash,
    lowestDate: f.minCashDate,
    reserve: r,
    horizonDays: HORIZON,
  };
}

/* * The cash flows of an offer, starting on `start`. */
export function offerFlows(o: Offer, start: ISODate, dailySales: number): Flow[] {
  const received = o.amount - o.upfrontFee;
  const flows: Flow[] = [{ date: start, amount: received }];
  const interest = o.ratePct ? Math.round((o.amount * o.ratePct * o.termDays) / (100 * 365)) : 0;
  const total = o.amount + interest + (o.flatFee ?? 0);
  const term = Math.max(1, o.termDays);
  if (o.repayment === "bullet") {
    flows.push({ date: addDays(start, term), amount: -total });
  } else if (o.repayment === "monthly" || o.repayment === "weekly") {
    const step = o.repayment === "monthly" ? 30 : 7;
    const n = Math.max(1, Math.round(term / step));
    const per = Math.floor(total / n);
    for (let i = 1; i <= n; i++)
      flows.push({ date: addDays(start, i * step), amount: -(i === n ? total - per * (n - 1) : per) });
  } else {
    // Repaid as a share of daily sales until the total is reached.
    const perDay = Math.max(1, Math.round((dailySales * (o.revenueSharePct ?? 10)) / 100));
    let left = total;
    let d = 1;
    while (left > 0 && d <= 3650) {
      const pay = Math.min(left, perDay);
      flows.push({ date: addDays(start, d), amount: -pay });
      left -= pay;
      d++;
    }
  }
  return flows;
}

/* * Effective annual rate from dated flows (internal rate of return, compounded daily). */
export function effectiveApr(flows: Flow[]): number | null {
  if (flows.length < 2) return null;
  const t0 = flows[0].date;
  const npv = (r: number) => flows.reduce((a, f) => a + f.amount / Math.pow(1 + r, diffDays(f.date, t0)), 0);
  const repaid = -flows.slice(1).reduce((a, f) => a + f.amount, 0);
  if (repaid <= flows[0].amount) return 0;
  let lo = 0;
  let hi = 0.05; // 5% per day is far beyond any legitimate offer
  if (npv(hi) < 0) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) < 0) lo = mid;
    else hi = mid;
  }
  return Math.pow(1 + (lo + hi) / 2, 365) - 1;
}

export function redFlags(
  o: Offer,
  apr: number | null,
  monthlyProfit: number | null = null,
  totalRepaid = 0,
  currency = "EGP",
): RedFlag[] {
  const out: RedFlag[] = [];
  if (monthlyProfit !== null && totalRepaid > 0 && o.repayment !== "bullet") {
    const months = Math.max(1, o.termDays / 30);
    const perMonth = Math.round(totalRepaid / months);
    const fm = (v: number) => formatMoney(v, currency);
    if (monthlyProfit <= 0)
      out.push({
        level: "warning",
        text: `The business is not profitable on average, so repayments (${fm(perMonth)} a month) would come out of cash, not earnings. A loan can bridge a gap; it does not fix a loss.`,
      });
    else if (perMonth > monthlyProfit)
      out.push({
        level: "danger",
        text: `Repayments of about ${fm(perMonth)} a month are more than the business earns (${fm(monthlyProfit)} a month). This loan could sink the business.`,
      });
    else if (perMonth > monthlyProfit * 0.5)
      out.push({
        level: "warning",
        text: `Repayments would take ${Math.round((perMonth / monthlyProfit) * 100)}% of what the business earns each month, leaving little room for a bad month.`,
      });
  }
  if (o.flags.upfrontPaymentRequested)
    out.push({
      level: "danger",
      text: "Asks you to pay before you receive any money. This is the most common lending scam.",
    });
  if (o.flags.personalAccountPayment)
    out.push({
      level: "danger",
      text: "Asks for fees to a personal account or mobile wallet. Licensed lenders do not do this.",
    });
  if (o.flags.notLicensed)
    out.push({
      level: "danger",
      text: "The lender is not registered with the regulator (in Egypt: the Central Bank or the Financial Regulatory Authority).",
    });
  if (o.flags.guaranteedApproval)
    out.push({ level: "warning", text: "Promises approval regardless of your history; real lenders check." });
  if (o.flags.pressureToSignToday)
    out.push({
      level: "warning",
      text: "Pressure to sign today leaves no time to compare. A fair offer can wait a day.",
    });
  if (apr === null)
    out.push({
      level: "danger",
      text: "The cost is so high that it cannot even be expressed as a normal annual rate.",
    });
  else if (apr > 1)
    out.push({
      level: "danger",
      text: `Costs ${Math.round(apr * 100)}% a year: you would pay back more than double over a year.`,
    });
  else if (apr > 0.5)
    out.push({ level: "warning", text: `Costs ${Math.round(apr * 100)}% a year, which is very expensive.` });
  if (o.repayment === "daily_sales" && o.flatFee && apr !== null) {
    const pct = Math.round((o.flatFee / Math.max(1, o.amount)) * 100);
    out.push({
      level: "warning",
      text: `Advertised as a ${pct}% fee, but because it is repaid quickly the true annual cost is ${Math.round(apr * 100)}%.`,
    });
  }
  if (o.upfrontFee > o.amount * 0.05)
    out.push({
      level: "warning",
      text: `An upfront fee of ${Math.round((o.upfrontFee / o.amount) * 100)}% means you receive noticeably less than the headline amount.`,
    });
  return out;
}

export function analyzeOffers(
  s: Snapshot,
  offers: Offer[],
  reserve: number | null,
  start: ISODate = s.today,
): { need: FinancingNeed; offers: OfferAnalysis[]; baseLowest: number } {
  const need = financingNeed(s, reserve);
  const r = need.reserve;
  const { run, typical } = runner(s);
  const dailySales = Math.round((typical?.inPerDay ?? 0) * SALES_HAIRCUT);
  const base = run([]);
  const fm = (v: number) => formatMoney(v, s.currency);

  const analyses = offers.map((o) => {
    const flows = offerFlows(o, start, dailySales);
    const received = flows[0].amount;
    const totalRepaid = -flows.slice(1).reduce((a, f) => a + f.amount, 0);
    const apr = effectiveApr(flows);
    const monthlyProfit = monthlyBaseline(s)?.netProfit ?? null;
    const f = run(
      flows.map((x) => ({
        date: x.date,
        amount: x.amount,
        label: `${o.lender}: ${x.amount > 0 ? "funds received" : "repayment"}`,
        kind: "scenario" as const,
      })),
    );
    const breach = f.points.find((p) => p.balance < r)?.date ?? null;
    const flags = redFlags(o, apr, monthlyProfit, totalRepaid, s.currency);
    const covers = breach === null;
    const danger = flags.some((x) => x.level === "danger");
    const verdict: OfferAnalysis["verdict"] = danger ? "avoid" : !covers || flags.length ? "risky" : "ok";
    const explanation = danger
      ? "Do not take this offer: it shows signs of a scam or an unaffordable cost."
      : covers
        ? `Keeps cash above ${fm(r)} for the next ${HORIZON} days, including the repayments.`
        : breach && breach < (need.neededBy ?? breach)
          ? `Repayments start too early: cash falls below ${fm(r)} on ${breach}.`
          : `Not enough on its own, or the repayments create a new dip: cash falls below ${fm(r)} on ${breach}.`;
    return {
      offer: o,
      received,
      totalRepaid,
      cost: totalRepaid - received,
      apr,
      payoffDate: flows[flows.length - 1].date,
      flows,
      covers,
      newLowest: f.minCash,
      newLowestDate: f.minCashDate,
      newBreachDate: breach,
      flags,
      verdict,
      explanation,
    } as OfferAnalysis;
  });

  // Best: no warning signs, keeps cash safe, cheapest in money terms.
  const safe = analyses
    .filter((a) => a.verdict === "ok")
    .sort((a, b) => a.cost - b.cost || (a.apr ?? 9) - (b.apr ?? 9));
  if (safe[0]) safe[0].verdict = "best";
  const order = { best: 0, ok: 1, risky: 2, avoid: 3 } as const;
  analyses.sort((a, b) => order[a.verdict] - order[b.verdict] || a.cost - b.cost);
  return { need, offers: analyses, baseLowest: base.minCash };
}

// Financing readiness: how a lender is likely to see the business, and how to improve

export interface ReadinessCheck {
  key: string;
  label: string;
  points: number;
  max: number;
  ok: boolean;
  detail: string;
  how: string | null;
}
export interface Readiness {
  score: number;
  band: "strong" | "fair" | "weak";
  summary: string;
  checks: ReadinessCheck[];
}

export function financingReadiness(
  s: Snapshot,
  opts: {
    reserve: number | null;
    legalDone: number;
    legalTotal: number;
    integrations: { provider: string; status: string; lastSyncAt: string | null }[];
  },
): Readiness {
  const fm = (v: number) => formatMoney(v, s.currency);
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push({ ...c, points: Math.round(Math.max(0, Math.min(c.max, c.points))) });

  const first = s.txns.reduce((m, t) => (t.date < m ? t.date : m), s.today);
  const months = Math.floor(diffDays(s.today, first) / 30);
  add({
    key: "history",
    label: "Track record",
    max: 20,
    points: (Math.min(6, months) / 6) * 20,
    ok: months >= 6,
    detail: `${months} month${months === 1 ? "" : "s"} of records`,
    how: months >= 6 ? null : "Keep recording every sale and cost; lenders usually want 6+ months.",
  });

  const base = monthlyBaseline(s);
  const profit = base?.netProfit ?? null;
  add({
    key: "profit",
    label: "Profitable on average",
    max: 20,
    points: profit === null ? 0 : profit > 0 ? 20 : 0,
    ok: !!profit && profit > 0,
    detail: profit === null ? "Not enough history" : `${fm(profit)} a month on average`,
    how:
      profit !== null && profit > 0
        ? null
        : "Fix losing products and costs first (see the Action Center); a loan does not fix a loss.",
  });

  let lowMonths = 0;
  for (let i = 1; i <= 3; i++) {
    const to = addDays(s.today, -30 * (i - 1));
    const m = summarize(s.txns, s.cats, s.currency, { from: addDays(to, -29), to });
    if (m.txnCount > 0 && m.netProfit < 0) lowMonths++;
  }
  add({
    key: "stability",
    label: "Steady results",
    max: 10,
    points: 10 - lowMonths * 4,
    ok: lowMonths === 0,
    detail: lowMonths ? `${lowMonths} of the last 3 months lost money` : "No losing month in the last 3",
    how: lowMonths ? "A few steady months make a stronger case than one big month." : null,
  });

  const q = assessDataQuality(s, { integrations: opts.integrations });
  add({
    key: "data",
    label: "Complete, verifiable records",
    max: 15,
    points: (q.score / 100) * 15,
    ok: q.score >= 85,
    detail: `Data completeness ${q.score}/100`,
    how: q.score >= 85 ? null : (q.issues[0] ?? "Categorise expenses and connect your store."),
  });

  const open = s.invoices.filter(
    (i) => i.direction === "receivable" && i.status === "open" && invoiceOutstanding(i) > 0,
  );
  const owed = open.reduce((a, i) => a + invoiceOutstanding(i), 0);
  const late = open.filter((i) => i.due_date < s.today).reduce((a, i) => a + invoiceOutstanding(i), 0);
  const lateShare = owed > 0 ? late / owed : 0;
  add({
    key: "collections",
    label: "Customers pay on time",
    max: 10,
    points: owed === 0 ? 10 : (1 - Math.min(1, lateShare * 2)) * 10,
    ok: lateShare <= 0.2,
    detail: owed === 0 ? "Nothing owed to you" : `${Math.round(lateShare * 100)}% of what customers owe is late`,
    how: lateShare <= 0.2 ? null : "Collect overdue invoices (the co-pilot can draft the reminders).",
  });

  const cash = cashBalance(s).total;
  const r = Math.max(0, opts.reserve ?? 0);
  const buffer = base ? Math.max(1, base.opex + base.cogs) : 1;
  const cover = cash / buffer;
  add({
    key: "buffer",
    label: "Cash cushion",
    max: 15,
    points: Math.min(1, cover) * 15,
    ok: cover >= 1 && cash >= r,
    detail: `Cash covers about ${cover.toFixed(1)} month${cover >= 1.5 ? "s" : ""} of costs`,
    how: cover >= 1 ? null : "Build a reserve of at least one month of costs before borrowing.",
  });

  add({
    key: "legal",
    label: "Legal basics in place",
    max: 10,
    points: opts.legalTotal ? (opts.legalDone / opts.legalTotal) * 10 : 0,
    ok: opts.legalTotal > 0 && opts.legalDone >= opts.legalTotal,
    detail: opts.legalTotal ? `${opts.legalDone} of ${opts.legalTotal} required papers done` : "Not tracked yet",
    how:
      opts.legalTotal && opts.legalDone >= opts.legalTotal
        ? null
        : "Finish the required papers in Company health (commercial register, tax card).",
  });

  const score = checks.reduce((a, c) => a + c.points, 0);
  const band: Readiness["band"] = score >= 75 ? "strong" : score >= 50 ? "fair" : "weak";
  const weakest = [...checks].filter((c) => c.how).sort((a, b) => b.max - b.points - (a.max - a.points))[0];
  return {
    score,
    band,
    checks,
    summary:
      band === "strong"
        ? "A lender is likely to see a well-run business."
        : band === "fair"
          ? `Getting there.${weakest ? ` Biggest gain: ${weakest.label.toLowerCase()}.` : ""}`
          : `Not ready yet.${weakest ? ` Start with: ${weakest.label.toLowerCase()}.` : ""}`,
  };
}
