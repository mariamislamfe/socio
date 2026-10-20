// Cash-risk diagnosis and planning. Pure and deterministic: every number comes from the forecast engine.
import { addDays, diffDays, occurrences, type ISODate } from "./dates";
import {
  descendants,
  forecast,
  invoiceOutstanding,
  summarize,
  typicalRates,
  type ForecastEvent,
  type Invoice,
} from "./engine";
import { formatMoney } from "./money";
import { cashBalance, monthlyBaseline } from "./planning";
import type { Snapshot } from "./snapshot";

export interface DataQuality {
  score: number; // 0-100
  issues: string[];
}

export interface CashOption {
  key: string;
  title: string;
  description: string;
  newLowest: number;
  impact: number; // improvement of the lowest balance vs. doing nothing
  resolves: boolean;
  /* * First date below the reserve if this option is taken (null = no dip within the horizon). */
  newBreachDate: ISODate | null;
  /* * True when the lowest point is unchanged but the first dip comes later (time to collect or sell). */
  buysTime: boolean;
  /* * How it would be carried out. `manual` means Socio can only create a task for you. */
  execution:
    | { tool: "reschedule_payable"; params: { invoiceId: string; newDueDate: ISODate } }
    | { tool: "send_payment_reminder"; params: { invoiceId: string } }
    | { tool: "manual" };
  assumptions: string[];
}

export interface CashRiskAnalysis {
  atRisk: boolean;
  reserve: number;
  reserveSource: "setting" | "none";
  horizonDays: number;
  startCash: number;
  pendingNonCash: number;
  breachDate: ISODate | null;
  lowest: number;
  lowestDate: ISODate;
  gap: number;
  contributors: ForecastEvent[];
  collections: ForecastEvent[];
  facts: string[];
  hypotheses: string[];
  unknowns: string[];
  options: CashOption[];
  dataQuality: DataQuality;
  points: { date: ISODate; balance: number }[];
}

export interface QualityInputs {
  integrations: { provider: string; status: string; lastSyncAt: string | null }[];
  now?: Date;
}

export function assessDataQuality(s: Snapshot, qi: QualityInputs): DataQuality {
  const issues: string[] = [];
  let score = 100;
  const now = qi.now ?? new Date();
  if (!s.accounts.some((a) => a.counts_as_cash !== false)) {
    issues.push("No cash account is set up, so there is no starting cash.");
    score -= 40;
  } else if (s.accounts.every((a) => a.opening_balance === 0) && s.txns.length === 0) {
    issues.push("No opening balance or transactions: cash starts at zero.");
    score -= 30;
  }
  const last = s.txns.reduce<string | null>((m, t) => (m === null || t.date > m ? t.date : m), null);
  if (!last) {
    issues.push("No transactions recorded yet.");
    score -= 20;
  } else if (diffDays(s.today, last) > 14) {
    issues.push(`The latest record is from ${last}; anything since then is missing.`);
    score -= 15;
  }
  const uncategorised = s.txns.filter(
    (t) => t.type === "expense" && !t.category_id && t.date > addDays(s.today, -60),
  ).length;
  if (uncategorised > 0) {
    issues.push(`${uncategorised} recent expenses have no category.`);
    score -= Math.min(10, uncategorised);
  }
  for (const i of qi.integrations) {
    if (i.status === "sync_failed" || i.status === "requires_reauth") {
      issues.push(`${i.provider} is not syncing (${i.status.replace("_", " ")}).`);
      score -= 20;
    } else if (
      i.status === "connected" &&
      i.lastSyncAt &&
      now.getTime() - new Date(i.lastSyncAt).getTime() > 36 * 3600_000
    ) {
      issues.push(`${i.provider} last synced over a day and a half ago.`);
      score -= 10;
    }
  }
  return { score: Math.max(0, score), issues };
}

/* * Future sales are counted at this share of the recent average, so forecasts err on the side of caution. */
export const SALES_HAIRCUT = 0.8;

export function analyzeCashRisk(
  s: Snapshot,
  opts: { reserve?: number | null; horizonDays?: number; quality: QualityInputs },
): CashRiskAnalysis {
  const fm = (v: number) => formatMoney(v, s.currency);
  const horizon = opts.horizonDays ?? 60;
  const reserve = Math.max(0, opts.reserve ?? 0);
  const cash = cashBalance(s);
  // Prudent forecast: scheduled items, plus typical day-to-day sales (cut to SALES_HAIRCUT) and spending when history exists.
  const typical = typicalRates(s.txns, s.cats, s.currency, s.today, s.recurring);
  const typ = typical
    ? {
        includeTypical: true,
        typicalInPerDay: Math.round(typical.inPerDay * SALES_HAIRCUT),
        typicalOutPerDay: typical.outPerDay,
      }
    : {};
  const run = (extra: ForecastEvent[] = [], skip = new Set<string>(), invoices: Invoice[] = s.invoices) =>
    forecast({
      today: s.today,
      days: horizon,
      startCash: cash.total,
      currency: s.currency,
      recurring: s.recurring,
      invoices,
      options: { ...typ, extraEvents: extra, skipInvoiceIds: skip },
    });
  const base = run();
  const breach = base.points.find((p) => p.balance < reserve) ?? null;
  const atRisk = !!breach;
  const breachDate = breach?.date ?? null;
  const until = breachDate ?? base.minCashDate;
  const contributors = base.events
    .filter((e) => e.kind !== "typical" && e.amount < 0 && e.date <= until)
    .sort((a, b) => a.amount - b.amount)
    .slice(0, 5);
  const collections = base.events
    .filter((e) => e.kind !== "typical" && e.amount > 0 && e.date <= addDays(until, 14))
    .slice(0, 5);

  // diagnosis: facts (computed), hypotheses (plausible, unverified), unknowns
  const facts: string[] = [];
  const hypotheses: string[] = [];
  const unknowns: string[] = [];
  facts.push(`Recorded cash today is ${fm(cash.total)}.`);
  if (atRisk)
    facts.push(
      `${typical ? "Expected payments and income" : "Scheduled payments"} take cash to ${fm(base.minCash)} on ${base.minCashDate}${reserve ? `, below your safety reserve of ${fm(reserve)}` : ""}. It first drops below ${reserve ? "the reserve" : "zero"} on ${breachDate}.`,
    );
  for (const c of contributors.slice(0, 3)) facts.push(`${c.label} (${fm(-c.amount)}) is due ${c.date}.`);
  const now30 = summarize(s.txns, s.cats, s.currency, { from: addDays(s.today, -29), to: s.today });
  const prev30 = summarize(s.txns, s.cats, s.currency, { from: addDays(s.today, -59), to: addDays(s.today, -30) });
  if (prev30.txnCount > 0 && now30.txnCount > 0) {
    const revChange = prev30.revenue ? (now30.revenue - prev30.revenue) / prev30.revenue : 0;
    facts.push(
      `Sales over the last 30 days were ${fm(now30.revenue)} versus ${fm(prev30.revenue)} in the 30 days before.`,
    );
    if (revChange < -0.15)
      hypotheses.push(
        "Lower sales may be part of the squeeze. This is a pattern in your records, not a confirmed cause.",
      );
    if (prev30.refunds > 0 && now30.refunds > prev30.refunds * 1.5)
      hypotheses.push(`Refunds rose to ${fm(now30.refunds)} from ${fm(prev30.refunds)}; returns may be draining cash.`);
    const out = now30.cogs + now30.opex;
    const outPrev = prev30.cogs + prev30.opex;
    if (outPrev > 0 && out > outPrev * 1.2)
      hypotheses.push(`Spending rose to ${fm(out)} from ${fm(outPrev)} in the previous 30 days.`);
  } else unknowns.push("There is not enough history to compare this month with the last one.");
  if (cash.pending > 0)
    unknowns.push(
      `${fm(cash.pending)} sits in your Shopify balance awaiting payout. It is not counted until it reaches your bank.`,
    );
  unknowns.push(
    typical
      ? `Future sales are estimated at ${Math.round(SALES_HAIRCUT * 100)}% of your average over the last ${typical.days} days, to stay on the safe side. If sales fall further, the dip is deeper.`
      : "Future sales are not assumed in this check (not enough history): it uses your recorded cash, bills, schedules and invoices only.",
  );
  unknowns.push("Socio has no bank connection; cash comes from the balances and transactions you recorded.");
  if (opts.reserve == null) unknowns.push("No safety reserve is set, so the warning level is zero.");

  // options, each re-forecast deterministically
  const options: CashOption[] = [];
  if (atRisk) {
    // Offered only if it raises the lowest balance or pushes the first dip later; anything else is not a fix.
    const opt = (
      fc: ReturnType<typeof run>,
      o: Omit<CashOption, "impact" | "resolves" | "newBreachDate" | "buysTime">,
    ) => {
      const impact = o.newLowest - base.minCash;
      const newBreachDate = fc.points.find((p) => p.balance < reserve)?.date ?? null;
      const later = !!breachDate && (newBreachDate === null || newBreachDate > breachDate);
      if (impact <= 0 && !later) return;
      const buysTime = impact <= 0;
      const description = buysTime
        ? `${o.description} The lowest point does not change, but the first dip below your reserve moves from ${breachDate} to ${newBreachDate ?? "after " + addDays(s.today, horizon)}, which buys time.`
        : o.description;
      options.push({ ...o, description, impact, resolves: o.newLowest >= reserve, newBreachDate, buysTime });
    };

    // 1. Collect what customers owe, sooner.
    const recv = s.invoices.filter(
      (i) =>
        i.direction === "receivable" && i.status === "open" && i.currency === s.currency && invoiceOutstanding(i) > 0,
    );
    if (recv.length) {
      const total = recv.reduce((a, i) => a + invoiceOutstanding(i), 0);
      const f = run(
        recv.map((i) => ({
          date: addDays(s.today, 3),
          amount: invoiceOutstanding(i),
          label: i.description,
          kind: "scenario" as const,
        })),
        new Set(recv.map((i) => i.id)),
      );
      const biggest = [...recv].sort((a, b) => invoiceOutstanding(b) - invoiceOutstanding(a))[0];
      opt(f, {
        key: "collect",
        title: `Collect ${fm(total)} owed to you this week`,
        description: `${recv.length} open invoice${recv.length > 1 ? "s" : ""}; the largest is ${biggest.description || biggest.number} (${fm(invoiceOutstanding(biggest))}). If they pay within 3 days, the lowest balance becomes ${fm(f.minCash)}.`,
        newLowest: f.minCash,
        execution: { tool: "send_payment_reminder", params: { invoiceId: biggest.id } },
        assumptions: ["Assumes customers pay within 3 days of a reminder — that is a best case, not a promise."],
      });
    }

    // 2. Move one supplier bill (needs the supplier's agreement).
    const essentialCats = new Set(s.cats.filter((c) => c.essential).flatMap((c) => [...descendants(s.cats, c.id)]));
    const pay = s.invoices
      .filter(
        (i) =>
          i.direction === "payable" &&
          i.status === "open" &&
          i.currency === s.currency &&
          invoiceOutstanding(i) > 0 &&
          i.due_date <= (breachDate ?? until),
      )
      .sort(
        (a, b) =>
          Number(!!(a.category_id && essentialCats.has(a.category_id))) -
            Number(!!(b.category_id && essentialCats.has(b.category_id))) ||
          invoiceOutstanding(b) - invoiceOutstanding(a),
      )[0];
    if (pay) {
      const newDue = addDays(pay.due_date < s.today ? s.today : pay.due_date, 30);
      const moved = s.invoices.map((i) => (i.id === pay.id ? { ...i, due_date: newDue } : i));
      const f = run([], new Set(), moved);
      opt(f, {
        key: "delay_payable",
        title: `Ask to pay ${pay.description || pay.number} 30 days later`,
        description: `${fm(invoiceOutstanding(pay))} is due ${pay.due_date}. Moving it to ${newDue} changes the lowest balance to ${fm(f.minCash)}.`,
        newLowest: f.minCash,
        execution: { tool: "reschedule_payable", params: { invoiceId: pay.id, newDueDate: newDue } },
        assumptions: ["Only valid if the supplier agrees. Record the new date in Socio after they confirm."],
      });
    }

    // 3. Trim advertising (Socio cannot change ad budgets itself: this becomes a task).
    const base3 = monthlyBaseline(s);
    if (base3 && base3.adSpend > 0) {
      const daily = Math.round((base3.adSpend * 0.3) / 30);
      const days = Math.max(1, diffDays(breachDate ?? until, s.today));
      const ev: ForecastEvent[] = [];
      for (let d = 7; d <= days + 6; d += 7)
        ev.push({
          date: addDays(s.today, Math.min(d, days)),
          amount: daily * Math.min(7, days - (d - 7)),
          label: "Lower ad spend",
          kind: "scenario",
        });
      const f = run(ev);
      opt(f, {
        key: "trim_ads",
        title: "Cut ad spend by 30% until cash recovers",
        description: `You spend about ${fm(base3.adSpend)} a month on ads. Cutting 30% saves roughly ${fm(daily * 7)} a week; the lowest balance becomes ${fm(f.minCash)}.`,
        newLowest: f.minCash,
        execution: { tool: "manual" },
        assumptions: [
          "Assumes the cut does not reduce sales in the meantime; it may.",
          "Has to be changed in your ad platform: Socio only reads ad data.",
        ],
      });
    }

    // 4. Skip one non-essential recurring payment.
    const rec = s.recurring
      .filter(
        (r) =>
          r.active &&
          r.direction === "out" &&
          r.currency === s.currency &&
          !(r.category_id && essentialCats.has(r.category_id)),
      )
      .map((r) => ({
        r,
        next: occurrences(r.next_due, r.frequency, addDays(s.today, 1), breachDate ?? until, r.end_date)[0],
      }))
      .filter((x) => x.next)
      .sort((a, b) => b.r.amount - a.r.amount)[0];
    if (rec) {
      const f = run([{ date: rec.next!, amount: rec.r.amount, label: `Skip ${rec.r.name}`, kind: "scenario" }]);
      opt(f, {
        key: "skip_recurring",
        title: `Pause ${rec.r.name} once`,
        description: `${fm(rec.r.amount)} is scheduled on ${rec.next}. Skipping it once changes the lowest balance to ${fm(f.minCash)}.`,
        newLowest: f.minCash,
        execution: { tool: "manual" },
        assumptions: ["Only if the service can be paused without penalties."],
      });
    }
    options.sort(
      (a, b) =>
        Number(b.resolves) - Number(a.resolves) ||
        b.impact - a.impact ||
        (a.newBreachDate === null ? 1 : 0) - (b.newBreachDate === null ? 1 : 0),
    );
  }

  return {
    atRisk,
    reserve,
    reserveSource: opts.reserve == null ? "none" : "setting",
    horizonDays: horizon,
    startCash: cash.total,
    pendingNonCash: cash.pending,
    breachDate,
    lowest: base.minCash,
    lowestDate: base.minCashDate,
    gap: Math.max(0, reserve - base.minCash),
    contributors,
    collections,
    facts,
    hypotheses,
    unknowns,
    options,
    dataQuality: assessDataQuality(s, opts.quality),
    points: base.points.map((p) => ({ date: p.date, balance: p.balance })),
  };
}

/* * Recorded cash at the end of a given date (for comparing a forecast with what actually happened). */
export function cashOn(s: Snapshot, date: ISODate): number {
  return cashBalance({ ...s, today: date }).total;
}
