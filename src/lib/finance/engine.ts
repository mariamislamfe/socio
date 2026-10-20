// Single source of truth for financial calculations. Pure functions over plain rows.
import {
  addDays,
  budgetPeriod,
  diffDays,
  inRange,
  occurrences,
  type Frequency,
  type ISODate,
  type Range,
} from "./dates";
import { ratio } from "./money";

export type TxnType = "income" | "expense" | "transfer" | "refund" | "adjustment";

export interface Txn {
  id: string;
  type: TxnType;
  date: ISODate;
  amount: number;
  currency: string;
  account_id: string;
  to_account_id: string | null;
  category_id: string | null;
  payee_id?: string | null;
  direction: "in" | "out" | null;
  description?: string;
  source?: string;
  recurring_id?: string | null;
  invoice_id?: string | null;
  cogs_estimate?: number | null;
  cost_missing?: boolean;
}

export interface Cat {
  id: string;
  name: string;
  kind: "income" | "expense";
  cost_type: "cogs" | "opex" | null;
  parent_id: string | null;
  essential?: boolean;
  role?: "ads" | "shipping" | "inventory" | "payroll" | "tax" | "software" | "rent" | "owner_draw" | null;
  color?: string;
}

export interface Account {
  id: string;
  name: string;
  type: string;
  currency: string;
  opening_balance: number;
  archived?: boolean;
  /* * False for balances that are not spendable yet, e.g. a store balance awaiting payout. */
  counts_as_cash?: boolean;
}

export interface Recurring {
  id: string;
  name: string;
  direction: "in" | "out";
  kind: string;
  amount: number;
  currency: string;
  category_id: string | null;
  payee_id?: string | null;
  frequency: Frequency;
  next_due: ISODate;
  end_date: ISODate | null;
  active: boolean;
}

export interface Invoice {
  id: string;
  direction: "receivable" | "payable";
  payee_id?: string | null;
  payee_name?: string | null;
  number?: string | null;
  description: string;
  amount: number;
  paid: number;
  currency: string;
  issue_date: ISODate;
  due_date: ISODate;
  category_id: string | null;
  status: "open" | "void";
}

export type Severity = "info" | "warning" | "critical";
export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  count?: number;
  href?: string;
}

// category helpers

export function catMap(cats: Cat[]): Map<string, Cat> {
  return new Map(cats.map((c) => [c.id, c]));
}

/* * Customer refunds reduce revenue (cash out). Refunds filed under an expense category are supplier refunds (cash in). */
export function refundSide(t: Txn, cm: Map<string, Cat>): "customer" | "vendor" {
  const c = t.category_id ? cm.get(t.category_id) : undefined;
  return c && c.kind === "expense" ? "vendor" : "customer";
}

/* * Signed effect of a transaction on the cash of `accountId` (in that account's currency). */
export function accountEffect(t: Txn, accountId: string, cm: Map<string, Cat>): number {
  if (t.type === "transfer") {
    if (t.account_id === accountId) return -t.amount;
    if (t.to_account_id === accountId) return t.amount;
    return 0;
  }
  if (t.account_id !== accountId) return 0;
  switch (t.type) {
    case "income":
      return t.amount;
    case "expense":
      return -t.amount;
    case "refund":
      return refundSide(t, cm) === "customer" ? -t.amount : t.amount;
    case "adjustment":
      return t.direction === "in" ? t.amount : -t.amount;
  }
  return 0;
}

export interface AccountBalance {
  id: string;
  name: string;
  type: string;
  currency: string;
  balance: number;
  countsAsCash: boolean;
}

/* * Balances as of `asOf` (future-dated records are scheduled, not yet in the balance). */
export function accountBalances(accounts: Account[], txns: Txn[], cats: Cat[], asOf: ISODate): AccountBalance[] {
  const cm = catMap(cats);
  const sums = new Map<string, number>();
  for (const t of txns) {
    if (t.date > asOf) continue;
    sums.set(t.account_id, (sums.get(t.account_id) ?? 0) + accountEffect(t, t.account_id, cm));
    if (t.type === "transfer" && t.to_account_id)
      sums.set(t.to_account_id, (sums.get(t.to_account_id) ?? 0) + t.amount);
  }
  return accounts
    .filter((a) => !a.archived)
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      balance: a.opening_balance + (sums.get(a.id) ?? 0),
      countsAsCash: a.counts_as_cash !== false,
    }));
}

// performance summary

export interface Summary {
  range: Range;
  currency: string;
  revenueGross: number;
  refunds: number;
  revenue: number; // net of customer refunds
  cogs: number;
  grossProfit: number;
  opex: number;
  netProfit: number;
  margin: number | null; // net profit / revenue
  grossMargin: number | null;
  cashIn: number;
  cashOut: number;
  netCash: number;
  estimatedCogs: number;
  txnCount: number;
  transferCount: number;
  uncategorizedCount: number;
  excludedForeignCount: number;
  revenueWithoutCostCount: number;
  incomplete: boolean;
  /* * Money the owner took out for themselves: reduces cash, not profit (it is a share of profit, not a cost). */
  ownerDraws: number;
}

export function summarize(txns: Txn[], cats: Cat[], currency: string, range: Range): Summary {
  const cm = catMap(cats);
  const s: Summary = {
    range,
    currency,
    revenueGross: 0,
    refunds: 0,
    revenue: 0,
    cogs: 0,
    grossProfit: 0,
    opex: 0,
    netProfit: 0,
    margin: null,
    grossMargin: null,
    cashIn: 0,
    cashOut: 0,
    netCash: 0,
    estimatedCogs: 0,
    txnCount: 0,
    transferCount: 0,
    uncategorizedCount: 0,
    excludedForeignCount: 0,
    revenueWithoutCostCount: 0,
    incomplete: false,
    ownerDraws: 0,
  };
  let vendorRefundCogs = 0;
  let vendorRefundOpex = 0;
  for (const t of txns) {
    if (!inRange(t.date, range.from, range.to)) continue;
    if (t.currency !== currency) {
      s.excludedForeignCount++;
      continue;
    }
    s.txnCount++;
    const cat = t.category_id ? cm.get(t.category_id) : undefined;
    switch (t.type) {
      case "transfer":
        s.transferCount++; // own-account movement: never revenue or expense
        break;
      case "income":
        s.revenueGross += t.amount;
        s.cashIn += t.amount;
        if (t.cogs_estimate != null) s.estimatedCogs += t.cogs_estimate;
        else if (t.cost_missing) s.revenueWithoutCostCount++;
        break;
      case "refund":
        if (refundSide(t, cm) === "customer") {
          s.refunds += t.amount;
          s.cashOut += t.amount;
        } else {
          s.cashIn += t.amount;
          if (cat?.cost_type === "cogs") vendorRefundCogs += t.amount;
          else vendorRefundOpex += t.amount;
        }
        break;
      case "expense":
        s.cashOut += t.amount;
        if (!cat) s.uncategorizedCount++;
        if (cat?.role === "owner_draw") s.ownerDraws += t.amount;
        else if (cat?.cost_type === "cogs") s.cogs += t.amount;
        else s.opex += t.amount;
        break;
      case "adjustment":
        if (t.direction === "in") s.cashIn += t.amount;
        else s.cashOut += t.amount;
        break;
    }
  }
  s.cogs = Math.max(0, s.cogs - vendorRefundCogs);
  s.opex = Math.max(0, s.opex - vendorRefundOpex);
  s.revenue = s.revenueGross - s.refunds;
  s.grossProfit = s.revenue - s.cogs;
  s.netProfit = s.grossProfit - s.opex;
  s.netCash = s.cashIn - s.cashOut;
  s.margin = s.revenue > 0 ? s.netProfit / s.revenue : null;
  s.grossMargin = s.revenue > 0 ? s.grossProfit / s.revenue : null;
  s.incomplete = s.revenue > 0 && s.cogs === 0 && s.estimatedCogs === 0;
  return s;
}

export function summaryIssues(s: Summary, opts: { productHref?: string } = {}): Issue[] {
  const out: Issue[] = [];
  if (s.revenue > 0 && s.cogs === 0) {
    out.push({
      code: "no_cogs",
      severity: "warning",
      message:
        s.estimatedCogs > 0
          ? "No product costs are recorded as expenses. Profit uses no cost of goods; estimated product costs from your catalog are shown separately."
          : "No cost of goods (inventory or product costs) is recorded for this period, so profit is likely overstated.",
      href: opts.productHref ?? "/app/transactions?new=expense",
    });
  }
  if (s.revenueWithoutCostCount > 0) {
    out.push({
      code: "orders_missing_cost",
      severity: "info",
      message: `${s.revenueWithoutCostCount} imported orders include products with no unit cost, so their costs cannot be estimated.`,
      count: s.revenueWithoutCostCount,
      href: "/app/products",
    });
  }
  if (s.uncategorizedCount > 0) {
    out.push({
      code: "uncategorized",
      severity: "info",
      message: `${s.uncategorizedCount} expenses have no category and are counted as operating expenses.`,
      count: s.uncategorizedCount,
      href: "/app/transactions?filter=uncategorized",
    });
  }
  if (s.excludedForeignCount > 0) {
    out.push({
      code: "foreign_currency",
      severity: "warning",
      message: `${s.excludedForeignCount} records in another currency are excluded because no exchange-rate policy is set.`,
      count: s.excludedForeignCount,
      href: "/app/transactions",
    });
  }
  if (s.txnCount === 0) {
    out.push({
      code: "no_data",
      severity: "info",
      message: "No transactions are recorded in this period yet.",
      href: "/app/transactions?new=income",
    });
  }
  return out;
}

// category spend & budgets

/* * Direct spend per expense category within a range (supplier refunds reduce it). */
export function spendByCategory(txns: Txn[], cats: Cat[], currency: string, range: Range): Map<string | null, number> {
  const cm = catMap(cats);
  const out = new Map<string | null, number>();
  for (const t of txns) {
    if (t.currency !== currency || !inRange(t.date, range.from, range.to)) continue;
    if (t.type === "expense") out.set(t.category_id, (out.get(t.category_id) ?? 0) + t.amount);
    else if (t.type === "refund" && refundSide(t, cm) === "vendor")
      out.set(t.category_id, (out.get(t.category_id) ?? 0) - t.amount);
  }
  return out;
}

export function descendants(cats: Cat[], id: string): Set<string> {
  const ids = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cats) if (c.parent_id && ids.has(c.parent_id) && !ids.has(c.id)) ids.add(c.id), (grew = true);
  }
  return ids;
}

export interface Budget {
  id: string;
  category_id: string;
  period: "monthly" | "quarterly" | "yearly";
  amount: number;
  position: number;
}

export interface BudgetStatus {
  id: string;
  categoryId: string;
  categoryName: string;
  period: Budget["period"];
  planned: number;
  spent: number;
  remaining: number;
  usedPct: number;
  timeElapsedPct: number;
  daysRemaining: number;
  /* * Pace-based projection: spent so far scaled to a full period. */
  projectedByPace: number;
  /* * Spent plus scheduled payments still due in this period for the category. */
  committed: number;
  upcoming: { name: string; date: ISODate; amount: number }[];
  status: "ok" | "watch" | "at_risk" | "over";
  lowConfidence: boolean;
  message: string;
  position: number;
}

export function budgetStatuses(args: {
  budgets: Budget[];
  cats: Cat[];
  txns: Txn[];
  recurring: Recurring[];
  invoices: Invoice[];
  currency: string;
  today: ISODate;
}): BudgetStatus[] {
  const { budgets, cats, txns, recurring, invoices, currency, today } = args;
  const cm = catMap(cats);
  return budgets
    .map((b) => {
      const p = budgetPeriod(b.period, today);
      const ids = descendants(cats, b.category_id);
      const spend = spendByCategory(txns, cats, currency, p.current);
      let spent = 0;
      for (const [cid, v] of spend) if (cid && ids.has(cid)) spent += v;
      const upcoming: BudgetStatus["upcoming"] = [];
      const horizonFrom = addDays(today, 0);
      for (const r of recurring) {
        if (!r.active || r.direction !== "out" || r.currency !== currency || !r.category_id || !ids.has(r.category_id))
          continue;
        for (const d of occurrences(r.next_due, r.frequency, horizonFrom, p.full.to, r.end_date))
          upcoming.push({ name: r.name, date: d, amount: r.amount });
      }
      for (const inv of invoices) {
        if (
          inv.direction !== "payable" ||
          inv.status !== "open" ||
          inv.currency !== currency ||
          !inv.category_id ||
          !ids.has(inv.category_id)
        )
          continue;
        const out = inv.amount - inv.paid;
        if (out > 0 && inv.due_date <= p.full.to)
          upcoming.push({
            name: inv.description || inv.number || "Bill",
            date: inv.due_date < today ? today : inv.due_date,
            amount: out,
          });
      }
      upcoming.sort((a, b2) => a.date.localeCompare(b2.date));
      const scheduled = upcoming.reduce((a, u) => a + u.amount, 0);
      // Categories driven by a recurring schedule (rent, salaries) are not paced: spend is lumpy and already known.
      const scheduledCategory = recurring.some(
        (r) => r.active && r.direction === "out" && r.currency === currency && r.category_id && ids.has(r.category_id),
      );
      const elapsed = p.elapsedDays / p.totalDays;
      const committed = spent + scheduled;
      const projectedByPace = scheduledCategory ? committed : elapsed > 0 ? Math.round(spent / elapsed) : spent;
      const usedPct = b.amount > 0 ? spent / b.amount : spent > 0 ? Infinity : 0;
      const lowConfidence = !scheduledCategory && p.elapsedDays < 5 && p.totalDays > 10;
      let status: BudgetStatus["status"] = "ok";
      if (spent > b.amount) status = "over";
      else if (!lowConfidence && (projectedByPace > b.amount || committed > b.amount)) status = "at_risk";
      else if (committed > b.amount) status = "at_risk";
      else if (usedPct >= 0.8 || (!lowConfidence && projectedByPace > b.amount * 0.9)) status = "watch";
      const name = cm.get(b.category_id)?.name ?? "Category";
      const pctUsed = Math.round(Math.min(usedPct, 9.99) * 100);
      const pctTime = Math.round(elapsed * 100);
      let message = `${pctUsed}% used with ${100 - pctTime}% of the ${b.period === "monthly" ? "month" : b.period === "quarterly" ? "quarter" : "year"} remaining.`;
      if (status === "over") message = `You have gone over this budget. ${message}`;
      else if (status === "at_risk") {
        message =
          projectedByPace > b.amount && !lowConfidence
            ? `You have used ${pctUsed}% of your ${name} budget with ${100 - pctTime}% of the period remaining. At your current pace you may exceed it.`
            : `Spent plus payments already scheduled for ${name} would exceed this budget.`;
      }
      return {
        id: b.id,
        categoryId: b.category_id,
        categoryName: name,
        period: b.period,
        planned: b.amount,
        spent,
        remaining: b.amount - spent,
        usedPct,
        timeElapsedPct: elapsed,
        daysRemaining: p.remainingDays,
        projectedByPace,
        committed,
        upcoming,
        status,
        lowConfidence,
        message,
        position: b.position,
      };
    })
    .sort((a, b) => a.position - b.position);
}

// cash-flow forecast

export interface ForecastEvent {
  date: ISODate;
  amount: number; // signed
  label: string;
  kind: "recurring_in" | "recurring_out" | "receivable" | "payable" | "typical" | "scenario";
  refId?: string;
  assumed?: string;
}

export interface ForecastOptions {
  receivableDelayDays: number; // applied to not-yet-due receivables
  overdueReceivableDelayDays: number; // overdue receivables expected this many days from today
  includeTypical: boolean;
  typicalInPerDay: number;
  typicalOutPerDay: number;
  extraEvents: ForecastEvent[];
  skipInvoiceIds?: Set<string>;
}

export const defaultForecastOptions: ForecastOptions = {
  receivableDelayDays: 0,
  overdueReceivableDelayDays: 14,
  includeTypical: false,
  typicalInPerDay: 0,
  typicalOutPerDay: 0,
  extraEvents: [],
};

export interface ForecastPoint {
  date: ISODate;
  balance: number;
  inflow: number;
  outflow: number;
}

export interface Forecast {
  startCash: number;
  days: number;
  points: ForecastPoint[];
  events: ForecastEvent[];
  endCash: number;
  minCash: number;
  minCashDate: ISODate;
  firstShortfallDate: ISODate | null;
  shortfallContributors: ForecastEvent[];
  totalIn: number;
  totalOut: number;
  assumptions: string[];
  suppressedDuplicates: number;
}

export function forecast(args: {
  today: ISODate;
  days: number;
  startCash: number;
  currency: string;
  recurring: Recurring[];
  invoices: Invoice[];
  options?: Partial<ForecastOptions>;
}): Forecast {
  const { today, days, startCash, currency, recurring, invoices } = args;
  const o: ForecastOptions = { ...defaultForecastOptions, ...(args.options ?? {}) };
  const end = addDays(today, days);
  const events: ForecastEvent[] = [];
  const assumptions: string[] = [];
  let suppressed = 0;

  const payables = invoices.filter(
    (i) =>
      i.direction === "payable" &&
      i.status === "open" &&
      i.currency === currency &&
      i.amount - i.paid > 0 &&
      !o.skipInvoiceIds?.has(i.id),
  );
  const receivables = invoices.filter(
    (i) =>
      i.direction === "receivable" &&
      i.status === "open" &&
      i.currency === currency &&
      i.amount - i.paid > 0 &&
      !o.skipInvoiceIds?.has(i.id),
  );

  for (const r of recurring) {
    if (!r.active || r.currency !== currency) continue;
    for (const d of occurrences(r.next_due, r.frequency, addDays(today, 1), end, r.end_date)) {
      // Avoid counting the same payment twice: an open bill from the same payee for the same amount near the date.
      const dup =
        r.direction === "out" &&
        r.payee_id &&
        payables.some(
          (p) => p.payee_id === r.payee_id && p.amount - p.paid === r.amount && Math.abs(diffDays(p.due_date, d)) <= 5,
        );
      if (dup) {
        suppressed++;
        continue;
      }
      events.push({
        date: d,
        amount: r.direction === "in" ? r.amount : -r.amount,
        label: r.name,
        kind: r.direction === "in" ? "recurring_in" : "recurring_out",
        refId: r.id,
      });
    }
    // overdue recurring payment that was never recorded is shown by the obligations screen; not assumed paid here.
  }
  for (const p of payables) {
    const out = p.amount - p.paid;
    const overdue = p.due_date <= today;
    const date = overdue ? addDays(today, 1) : p.due_date;
    if (date > end) continue;
    events.push({
      date,
      amount: -out,
      label: p.description || p.number || p.payee_name || "Bill",
      kind: "payable",
      refId: p.id,
      assumed: overdue ? "Overdue — assumed paid tomorrow" : undefined,
    });
  }
  let usedOverdueAssumption = false;
  for (const r of receivables) {
    const owed = r.amount - r.paid;
    const overdue = r.due_date < today;
    const date = overdue ? addDays(today, o.overdueReceivableDelayDays) : addDays(r.due_date, o.receivableDelayDays);
    if (overdue) usedOverdueAssumption = true;
    if (date > end) continue;
    events.push({
      date: date <= today ? addDays(today, 1) : date,
      amount: owed,
      label: r.description || r.number || r.payee_name || "Invoice",
      kind: "receivable",
      refId: r.id,
      assumed: overdue
        ? `Overdue — assumed received ${o.overdueReceivableDelayDays} days from today`
        : o.receivableDelayDays
          ? `Assumed ${o.receivableDelayDays} days after due date`
          : undefined,
    });
  }
  for (const e of o.extraEvents)
    if (e.date <= end) events.push({ ...e, date: e.date <= today ? addDays(today, 1) : e.date });

  assumptions.push("Starting cash is your recorded account balances in the business currency.");
  assumptions.push("Unpaid invoices are never counted as cash received until their due date (plus any delay you set).");
  if (usedOverdueAssumption)
    assumptions.push(`Overdue receivables are assumed to arrive ${o.overdueReceivableDelayDays} days from today.`);
  if (o.includeTypical)
    assumptions.push(
      "Includes typical day-to-day sales and unscheduled spending, based on your recent average. This is an estimate, not a promise.",
    );
  else assumptions.push("Scheduled items only: future sales and unscheduled spending are not included.");

  const byDate = new Map<ISODate, ForecastEvent[]>();
  for (const e of events) {
    const arr = byDate.get(e.date) ?? [];
    arr.push(e);
    byDate.set(e.date, arr);
  }
  const points: ForecastPoint[] = [];
  let bal = startCash;
  let min = startCash;
  let minDate = today;
  let firstShort: ISODate | null = startCash < 0 ? today : null;
  let totalIn = 0;
  let totalOut = 0;
  points.push({ date: today, balance: bal, inflow: 0, outflow: 0 });
  for (let i = 1; i <= days; i++) {
    const d = addDays(today, i);
    let inflow = 0;
    let outflow = 0;
    for (const e of byDate.get(d) ?? []) e.amount >= 0 ? (inflow += e.amount) : (outflow += -e.amount);
    if (o.includeTypical) {
      inflow += o.typicalInPerDay;
      outflow += o.typicalOutPerDay;
    }
    bal += inflow - outflow;
    totalIn += inflow;
    totalOut += outflow;
    points.push({ date: d, balance: bal, inflow, outflow });
    if (bal < min) {
      min = bal;
      minDate = d;
    }
    if (bal < 0 && !firstShort) firstShort = d;
  }
  const contributors = firstShort
    ? events
        .filter((e) => e.amount < 0 && e.date <= firstShort!)
        .sort((a, b) => a.amount - b.amount)
        .slice(0, 5)
    : [];
  return {
    startCash,
    days,
    points,
    events: events.sort((a, b) => a.date.localeCompare(b.date)),
    endCash: bal,
    minCash: min,
    minCashDate: minDate,
    firstShortfallDate: firstShort,
    shortfallContributors: contributors,
    totalIn,
    totalOut,
    assumptions,
    suppressedDuplicates: suppressed,
  };
}

/* * Average daily unscheduled activity over the trailing window; null when history is too short to be meaningful. */
export function typicalRates(
  txns: Txn[],
  cats: Cat[],
  currency: string,
  today: ISODate,
  recurring: Recurring[] = [],
  windowDays = 90,
): { inPerDay: number; outPerDay: number; days: number } | null {
  const cm = catMap(cats);
  const from = addDays(today, -windowDays);
  const scheduledCats = new Set(
    recurring.filter((r) => r.active && r.direction === "out" && r.category_id).map((r) => r.category_id as string),
  );
  const rel = txns.filter(
    (t) =>
      t.currency === currency && t.date > from && t.date <= today && t.type !== "transfer" && t.type !== "adjustment",
  );
  if (rel.length === 0) return null;
  const first = rel.reduce((m, t) => (t.date < m ? t.date : m), today);
  const days = Math.min(windowDays, diffDays(today, first) + 1);
  if (days < 14) return null;
  let inn = 0;
  let out = 0;
  for (const t of rel) {
    if (t.recurring_id || t.invoice_id) continue; // already represented by schedules / invoices
    if (t.type === "expense" && t.category_id && scheduledCats.has(t.category_id)) continue; // category has a schedule: treated as scheduled
    if (t.type === "income") inn += t.amount;
    else if (t.type === "expense") out += t.amount;
    else if (t.type === "refund") refundSide(t, cm) === "customer" ? (out += t.amount) : (inn += t.amount);
  }
  return { inPerDay: Math.round(inn / days), outPerDay: Math.round(out / days), days };
}

/* * Runway in months from recent average monthly net outflow. null burn means cash is not being consumed. */
export function runway(
  cash: number,
  txns: Txn[],
  cats: Cat[],
  currency: string,
  today: ISODate,
): { months: number | null; monthlyBurn: number | null; basisDays: number } {
  const cm = catMap(cats);
  const from = addDays(today, -90);
  let net = 0;
  let first = today;
  for (const t of txns) {
    if (t.currency !== currency || t.date <= from || t.date > today) continue;
    if (t.date < first) first = t.date;
    if (t.type === "income") net += t.amount;
    else if (t.type === "expense") net -= t.amount;
    else if (t.type === "refund") net += refundSide(t, cm) === "customer" ? -t.amount : t.amount;
  }
  const basisDays = Math.min(90, diffDays(today, first) + 1);
  if (basisDays < 14) return { months: null, monthlyBurn: null, basisDays };
  const monthlyNet = (net / basisDays) * 30;
  if (monthlyNet >= 0) return { months: null, monthlyBurn: null, basisDays };
  const burn = Math.round(-monthlyNet);
  return { months: cash > 0 ? cash / burn : 0, monthlyBurn: burn, basisDays };
}

/* * Essential monthly expenses: average of the last 3 months of spend in essential-flagged categories (plus recurring essentials). */
export function essentialMonthly(
  txns: Txn[],
  cats: Cat[],
  recurring: Recurring[],
  currency: string,
  today: ISODate,
): number {
  const essentialIds = new Set(cats.filter((c) => c.essential).map((c) => c.id));
  const from = addDays(today, -90);
  let sum = 0;
  let first = today;
  for (const t of txns) {
    if (t.type !== "expense" || t.currency !== currency || t.date <= from || t.date > today) continue;
    if (!t.category_id || !essentialIds.has(t.category_id)) continue;
    sum += t.amount;
    if (t.date < first) first = t.date;
  }
  const basis = Math.max(30, Math.min(90, diffDays(today, first) + 1));
  const fromHistory = Math.round((sum / basis) * 30);
  const factor: Record<Frequency, number> = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
  const fromSchedules = recurring
    .filter(
      (r) =>
        r.active &&
        r.direction === "out" &&
        r.currency === currency &&
        r.category_id &&
        essentialIds.has(r.category_id),
    )
    .reduce((a, r) => a + Math.round(r.amount * factor[r.frequency]), 0);
  return Math.max(fromHistory, fromSchedules);
}

// obligations

export function invoiceOutstanding(i: Invoice): number {
  return i.status === "void" ? 0 : Math.max(0, i.amount - i.paid);
}
export function invoiceState(
  i: Invoice,
  today: ISODate,
): "paid" | "partial" | "overdue" | "due_soon" | "open" | "void" {
  if (i.status === "void") return "void";
  if (i.paid >= i.amount) return "paid";
  if (i.due_date < today) return "overdue";
  if (diffDays(i.due_date, today) <= 7) return "due_soon";
  return i.paid > 0 ? "partial" : "open";
}

export function ratioPct(n: number, d: number): number | null {
  const r = ratio(n, d);
  return r === null ? null : r * 100;
}
