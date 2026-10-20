// Deterministic, evidence-backed insights. Every insight is computed from the user's records; none is canned.
import { addDays, periodInfo, type Range } from "./dates";
import { descendants, invoiceOutstanding, spendByCategory, summarize, summaryIssues, type Issue } from "./engine";
import { formatMoney } from "./money";
import { baseForecast, budgetView, cashBalance, goalProgress } from "./planning";
import type { AdDay, Snapshot } from "./snapshot";

export interface Evidence {
  label: string;
  value: string;
}
export interface Insight {
  key: string;
  severity: "info" | "warning" | "critical" | "positive";
  topic: "cash" | "budget" | "expenses" | "profit" | "advertising" | "receivables" | "data" | "reserve";
  title: string;
  observed: string;
  evidence: Evidence[];
  why: string;
  action: { label: string; href: string };
  assumptions: string[];
  score: number; // for ordering, higher first
}

export interface AdsSummary {
  spend: number;
  attributedRevenue: number;
  roas: number | null;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
  providers: string[];
  campaigns: {
    id: string;
    name: string;
    provider: string;
    spend: number;
    attributedRevenue: number;
    roas: number | null;
    clicks: number;
    conversions: number;
  }[];
  daily: { date: string; spend: number; revenue: number }[];
}

export function adsSummary(ads: AdDay[], currency: string, range: Range): AdsSummary {
  const rows = ads.filter((a) => a.currency === currency && a.date >= range.from && a.date <= range.to);
  const by = new Map<string, AdsSummary["campaigns"][number]>();
  const daily = new Map<string, { date: string; spend: number; revenue: number }>();
  let spend = 0,
    rev = 0,
    imp = 0,
    clk = 0,
    conv = 0;
  for (const r of rows) {
    spend += r.spend;
    rev += r.attributed_revenue;
    imp += r.impressions;
    clk += r.clicks;
    conv += r.conversions;
    const k = `${r.provider}:${r.campaign_id}`;
    const c = by.get(k) ?? {
      id: r.campaign_id,
      name: r.campaign_name,
      provider: r.provider,
      spend: 0,
      attributedRevenue: 0,
      roas: null,
      clicks: 0,
      conversions: 0,
    };
    c.spend += r.spend;
    c.attributedRevenue += r.attributed_revenue;
    c.clicks += r.clicks;
    c.conversions += r.conversions;
    by.set(k, c);
    const d = daily.get(r.date) ?? { date: r.date, spend: 0, revenue: 0 };
    d.spend += r.spend;
    d.revenue += r.attributed_revenue;
    daily.set(r.date, d);
  }
  const campaigns = [...by.values()]
    .map((c) => ({ ...c, roas: c.spend > 0 ? c.attributedRevenue / c.spend : null }))
    .sort((a, b) => b.spend - a.spend);
  return {
    spend,
    attributedRevenue: rev,
    roas: spend > 0 ? rev / spend : null,
    impressions: imp,
    clicks: clk,
    conversions: conv,
    ctr: imp > 0 ? clk / imp : null,
    cpc: clk > 0 ? Math.round(spend / clk) : null,
    cpa: conv > 0 ? Math.round(spend / conv) : null,
    providers: [...new Set(rows.map((r) => r.provider))],
    campaigns,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function generateInsights(s: Snapshot): Insight[] {
  const out: Insight[] = [];
  const fm = (v: number) => formatMoney(v, s.currency);
  const month = periodInfo("month", s.today);
  const cur = summarize(s.txns, s.cats, s.currency, month.current);
  const prev = summarize(s.txns, s.cats, s.currency, month.previous);
  const cash = cashBalance(s).total;
  const hasData = s.txns.length > 0;

  // 1. Cash shortfall on scheduled obligations
  const f = baseForecast(s, 60);
  if (f.firstShortfallDate) {
    out.push({
      key: `cash:shortfall:${f.firstShortfallDate}`,
      severity: "critical",
      topic: "cash",
      title: `Cash may run short on ${f.firstShortfallDate}`,
      observed: `Based on the payments you have scheduled, your balance is expected to fall below zero on ${f.firstShortfallDate}, reaching a low of ${fm(f.minCash)}.`,
      evidence: [
        { label: "Recorded cash today", value: fm(cash) },
        ...f.shortfallContributors.slice(0, 3).map((e) => ({ label: `${e.label} (${e.date})`, value: fm(-e.amount) })),
      ],
      why: "A payment you cannot cover can mean late fees, strained supplier relationships, or paused operations.",
      action: { label: "Open cash flow", href: "/app/cash-flow" },
      assumptions: f.assumptions.slice(0, 3),
      score: 100,
    });
  } else if (cash > 0 && f.minCash < cash * 0.15 && f.events.some((e) => e.amount < 0)) {
    out.push({
      key: "cash:tight",
      severity: "warning",
      topic: "cash",
      title: "Cash gets tight in the next 60 days",
      observed: `Scheduled payments bring your balance down to ${fm(f.minCash)} on ${f.minCashDate}.`,
      evidence: [
        { label: "Recorded cash today", value: fm(cash) },
        { label: "Lowest point", value: fm(f.minCash) },
      ],
      why: "Staying above zero is not much of a cushion if sales are slower than usual.",
      action: { label: "See the timeline", href: "/app/cash-flow" },
      assumptions: f.assumptions.slice(0, 2),
      score: 70,
    });
  }

  // 2. Budgets
  for (const b of budgetView(s)) {
    if (b.status === "over" || b.status === "at_risk") {
      const pctUsed = Math.round(Math.min(b.usedPct, 9.99) * 100);
      out.push({
        key: `budget:${b.id}:${b.status}`,
        severity: b.status === "over" ? "critical" : "warning",
        topic: "budget",
        title: b.status === "over" ? `${b.categoryName} is over budget` : `${b.categoryName} may exceed its budget`,
        observed:
          b.status === "over"
            ? `You have spent ${fm(b.spent)} against a ${fm(b.planned)} ${b.period} budget (${pctUsed}% used).`
            : `${pctUsed}% of the ${b.categoryName} budget is used with ${Math.round((1 - b.timeElapsedPct) * 100)}% of the period remaining.`,
        evidence: [
          { label: "Planned", value: fm(b.planned) },
          { label: "Spent", value: fm(b.spent) },
          { label: "Projected at current pace", value: fm(b.projectedByPace) },
          ...(b.upcoming.length
            ? [
                {
                  label: `Scheduled still to pay (${b.upcoming.length})`,
                  value: fm(b.upcoming.reduce((a, u) => a + u.amount, 0)),
                },
              ]
            : []),
        ],
        why: "Catching this early leaves room to adjust spending or the budget before the period ends.",
        action: { label: "Review budget", href: "/app/budgets" },
        assumptions: [
          b.lowConfidence
            ? "Early in the period, so pace-based projections are unreliable."
            : "Pace projection assumes spending continues at the same daily rate.",
        ],
        score: b.status === "over" ? 90 : 75,
      });
    }
  }

  // 3. Expense categories rising versus the previous like-for-like period
  const spendNow = spendByCategory(s.txns, s.cats, s.currency, month.current);
  const spendPrev = spendByCategory(s.txns, s.cats, s.currency, month.previous);
  const threshold = Math.max(cur.revenue * 0.03, 5_000);
  const rising = [...spendNow.entries()]
    .filter(([id]) => id !== null)
    .map(([id, v]) => ({ id: id as string, now: v, was: spendPrev.get(id) ?? 0 }))
    .filter((r) => r.now - r.was > threshold && (r.was === 0 ? false : r.now / r.was >= 1.3))
    .sort((a, b) => b.now - b.was - (a.now - a.was))
    .slice(0, 2);
  for (const r of rising) {
    const c = s.cats.find((x) => x.id === r.id);
    if (!c) continue;
    out.push({
      key: `expense:rising:${r.id}:${month.full.from}`,
      severity: "warning",
      topic: "expenses",
      title: `${c.name} spending is up ${Math.round((r.now / r.was - 1) * 100)}%`,
      observed: `${c.name} is ${fm(r.now)} so far this month versus ${fm(r.was)} over the same days last month.`,
      evidence: [
        { label: "This month so far", value: fm(r.now) },
        { label: "Same days last month", value: fm(r.was) },
        { label: "Difference", value: fm(r.now - r.was) },
      ],
      why: "Growing costs reduce profit unless sales grow with them.",
      action: { label: "See these transactions", href: `/app/transactions?category=${r.id}` },
      assumptions: ["Compares equal elapsed days of this and the previous month."],
      score: 60,
    });
  }

  // 4. Profit down vs previous period
  if (
    prev.revenue > 0 &&
    cur.revenue > 0 &&
    !cur.incomplete &&
    cur.netProfit < prev.netProfit &&
    prev.netProfit - cur.netProfit > threshold
  ) {
    out.push({
      key: `profit:down:${month.full.from}`,
      severity: "warning",
      topic: "profit",
      title: "Profit is lower than last month's pace",
      observed: `Net profit is ${fm(cur.netProfit)} versus ${fm(prev.netProfit)} over the same days last month.`,
      evidence: [
        { label: "Revenue now / then", value: `${fm(cur.revenue)} / ${fm(prev.revenue)}` },
        { label: "Cost of goods now / then", value: `${fm(cur.cogs)} / ${fm(prev.cogs)}` },
        { label: "Operating expenses now / then", value: `${fm(cur.opex)} / ${fm(prev.opex)}` },
      ],
      why: "Seeing whether revenue fell or costs rose points to where to act.",
      action: { label: "Ask the copilot why", href: "/app/insights?q=Why%20did%20my%20profit%20decrease%3F" },
      assumptions: ["Costs are counted when recorded (cash basis)."],
      score: 65,
    });
  }

  // 5. Advertising return vs break-even
  const ads = adsSummary(s.ads, s.currency, month.current);
  if (ads.spend > 0 && ads.roas !== null) {
    const gm = cur.grossMargin;
    if (gm && gm > 0 && !cur.incomplete) {
      const be = 1 / gm;
      if (ads.roas < be) {
        out.push({
          key: `ads:roas:${month.full.from}`,
          severity: "warning",
          topic: "advertising",
          title: "Ad return is below break-even",
          observed: `Ads returned ${ads.roas.toFixed(2)} in attributed revenue per 1 spent. With a gross margin of ${(gm * 100).toFixed(0)}%, you need about ${be.toFixed(2)} to cover product costs.`,
          evidence: [
            { label: "Ad spend", value: fm(ads.spend) },
            { label: "Attributed revenue", value: fm(ads.attributedRevenue) },
            { label: "ROAS", value: ads.roas.toFixed(2) },
            { label: "Break-even ROAS", value: be.toFixed(2) },
          ],
          why: "ROAS is attributed revenue, not profit. Below break-even, each ad sale costs more than it earns after product costs.",
          action: { label: "Open advertising", href: "/app/ads" },
          assumptions: [
            "Attribution comes from the ad platform and may over- or under-count.",
            "Break-even uses this month's gross margin.",
          ],
          score: 62,
        });
      }
    }
  }

  // 6. Overdue receivables
  const overdue = s.invoices.filter(
    (i) =>
      i.direction === "receivable" &&
      i.status === "open" &&
      i.due_date < s.today &&
      invoiceOutstanding(i) > 0 &&
      i.currency === s.currency,
  );
  if (overdue.length) {
    const total = overdue.reduce((a, i) => a + invoiceOutstanding(i), 0);
    out.push({
      key: `receivables:overdue:${overdue.length}:${total}`,
      severity: "warning",
      topic: "receivables",
      title: `${overdue.length} overdue invoice${overdue.length > 1 ? "s" : ""}`,
      observed: `${fm(total)} is past its due date and still unpaid.`,
      evidence: overdue
        .slice(0, 3)
        .map((i) => ({
          label: `${i.payee_name ?? i.description} (due ${i.due_date})`,
          value: fm(invoiceOutstanding(i)),
        })),
      why: "Money you are owed is not money you can spend. Late payments quietly shorten your runway.",
      action: { label: "Review receivables", href: "/app/obligations?tab=receivables" },
      assumptions: ["Socio does not know whether a customer has paid outside what you have recorded."],
      score: 68,
    });
  }

  // 7. Data quality
  if (hasData)
    for (const i of summaryIssues(cur)) {
      if (i.code === "no_cogs" || i.code === "uncategorized") out.push(issueToInsight(i));
    }
  if (s.productCount > 0 && s.productsWithoutCost > 0) {
    out.push({
      key: "data:product-cost",
      severity: "info",
      topic: "data",
      title: "Some products have no unit cost",
      observed: `${s.productsWithoutCost} of ${s.productCount} products have no cost, so their profit cannot be estimated.`,
      evidence: [{ label: "Products without cost", value: String(s.productsWithoutCost) }],
      why: "Without product costs, margin on those sales is unknown.",
      action: { label: "Add product costs", href: "/app/products" },
      assumptions: [],
      score: 40,
    });
  }

  // 8. Reserve
  for (const g of s.goals.filter((x) => x.type === "reserve")) {
    const p = goalProgress(g, s);
    if (p.target > 0 && p.pct < 0.5 && !p.achieved) {
      out.push({
        key: `reserve:low:${g.id}`,
        severity: "info",
        topic: "reserve",
        title: "Your emergency reserve is under half funded",
        observed: `${fm(p.current)} of ${fm(p.target)} is set aside (${Math.round(p.pct * 100)}%).`,
        evidence: [
          { label: "Target", value: fm(p.target) },
          { label: "Basis", value: p.basis },
          ...(p.safeNow !== undefined ? [{ label: "Safe to set aside now", value: fm(p.safeNow) }] : []),
        ],
        why: "A reserve helps the business absorb a slow month without missing payments.",
        action: { label: "Open goals", href: "/app/goals" },
        assumptions: ["A reserve is a planning figure in Socio; no money is moved."],
        score: 30,
      });
    }
    if (p.achieved) {
      out.push({
        key: `reserve:done:${g.id}`,
        severity: "positive",
        topic: "reserve",
        title: "Emergency reserve target reached",
        observed: `${fm(p.current)} is set aside against a target of ${fm(p.target)}.`,
        evidence: [],
        why: "Your buffer matches the target you chose.",
        action: { label: "Open goals", href: "/app/goals" },
        assumptions: [],
        score: 10,
      });
    }
  }

  // 9. Concentration
  const totalSpend = [...spendNow.values()].reduce((a, b) => a + b, 0);
  const top = [...spendNow.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[0] && totalSpend > 0 && top[1] / totalSpend >= 0.45 && month.elapsedDays >= 7) {
    const c = s.cats.find((x) => x.id === top[0]);
    if (c) {
      out.push({
        key: `expense:top:${c.id}:${month.full.from}`,
        severity: "info",
        topic: "expenses",
        title: `${c.name} is your largest cost`,
        observed: `${c.name} makes up ${Math.round((top[1] / totalSpend) * 100)}% of this month's spending (${fm(top[1])} of ${fm(totalSpend)}).`,
        evidence: [
          { label: c.name, value: fm(top[1]) },
          { label: "All expenses", value: fm(totalSpend) },
        ],
        why: "The biggest cost line is where a small improvement matters most.",
        action: { label: "Open transactions", href: `/app/transactions?category=${c.id}` },
        assumptions: [],
        score: 20,
      });
    }
  }

  if (out.length === 0 && hasData) {
    out.push({
      key: "all-clear",
      severity: "positive",
      topic: "data",
      title: "Nothing needs your attention right now",
      observed: "No budget, cash, or data-quality issues were detected from your current records.",
      evidence: [],
      why: "Socio checks again whenever your records change.",
      action: { label: "Explore scenarios", href: "/app/scenarios" },
      assumptions: [],
      score: 1,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

function issueToInsight(i: Issue): Insight {
  return {
    key: `data:${i.code}`,
    severity: i.severity === "warning" ? "warning" : "info",
    topic: "data",
    title: i.code === "no_cogs" ? "Profit looks better than it may be" : "Some expenses need a category",
    observed: i.message,
    evidence: i.count ? [{ label: "Records affected", value: String(i.count) }] : [],
    why:
      i.code === "no_cogs"
        ? "Profit is revenue minus costs. If product costs are missing, profit is overstated."
        : "Categories make budgets and spending analysis accurate.",
    action: { label: "Fix it", href: i.href ?? "/app/transactions" },
    assumptions: [],
    score: i.code === "no_cogs" ? 55 : 35,
  };
}

/* * Descendant expense totals for a role (ads, shipping...) in a range - used by copilot and scenarios. */
export function roleSpend(s: Snapshot, role: string, range: Range): number {
  const ids = new Set(s.cats.filter((c) => c.role === role).flatMap((c) => [...descendants(s.cats, c.id)]));
  let v = 0;
  for (const t of s.txns) {
    if (
      t.type === "expense" &&
      t.currency === s.currency &&
      t.date >= range.from &&
      t.date <= range.to &&
      t.category_id &&
      ids.has(t.category_id)
    )
      v += t.amount;
  }
  return v;
}

export { addDays };
