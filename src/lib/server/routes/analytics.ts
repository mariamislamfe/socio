import "server-only";
import { z } from "zod";
import { addDays, periodInfo, todayISO, type PeriodKind } from "@/lib/finance/dates";
import { invoiceOutstanding, invoiceState, runway, summarize, summaryIssues } from "@/lib/finance/engine";
import { adsSummary, generateInsights } from "@/lib/finance/insights";
import { baseForecast, budgetView, cashBalance, goalProgress, monthlyBaseline } from "@/lib/finance/planning";
import { expenseBreakdown, periodSeries } from "@/lib/finance/series";
import { simulate, type Adjustment } from "@/lib/finance/scenarios";
import { answer } from "@/lib/finance/copilot";
import { profitReport } from "@/lib/finance/profit";
import { formatMoney } from "@/lib/finance/money";
import { asService } from "../db";
import { api, isoDate, notFound, params, uuid } from "../http";
import { loadSnapshot } from "../workspace";
import { explainWithAi } from "../ai";
import type { Route } from "./types";
import type { Snapshot } from "@/lib/finance/snapshot";

const periodKind = z.enum(["week", "month", "quarter", "year"]).default("month");

/* * Notifications are derived from deterministic insights and deduplicated by a stable key. */
async function syncNotifications(bizId: string, s: Snapshot) {
  const fm = (v: number) => formatMoney(v, s.currency);
  const wanted: {
    key: string;
    severity: "info" | "warning" | "critical" | "success";
    title: string;
    body: string;
    href: string;
  }[] = [];
  for (const i of generateInsights(s)) {
    if (i.severity === "critical" || i.severity === "warning") {
      wanted.push({
        key: i.key,
        severity: i.severity === "critical" ? "critical" : "warning",
        title: i.title,
        body: i.observed,
        href: i.action.href,
      });
    }
    if (i.severity === "positive" && i.key.startsWith("reserve:done"))
      wanted.push({ key: i.key, severity: "success", title: i.title, body: i.observed, href: i.action.href });
  }
  for (const inv of s.invoices) {
    const out = invoiceOutstanding(inv);
    if (inv.direction === "payable" && inv.status === "open" && out > 0 && inv.currency === s.currency) {
      const st = invoiceState(inv, s.today);
      if (st === "overdue")
        wanted.push({
          key: `payable:overdue:${inv.id}`,
          severity: "critical",
          title: "Overdue payment",
          body: `${inv.description || inv.number} (${fm(out)}) was due ${inv.due_date}.`,
          href: "/app/obligations?tab=payables",
        });
      else if (st === "due_soon")
        wanted.push({
          key: `payable:soon:${inv.id}`,
          severity: "info",
          title: "Payment due this week",
          body: `${inv.description || inv.number} (${fm(out)}) is due ${inv.due_date}.`,
          href: "/app/obligations?tab=payables",
        });
    }
  }
  const keys = new Set(wanted.map((w) => w.key));
  await asService(async (q) => {
    for (const w of wanted.slice(0, 20)) {
      await q.query(
        `insert into notifications(business_id,dedupe_key,severity,title,body,href) values ($1,$2,$3,$4,$5,$6)
         on conflict (business_id,dedupe_key) do update set severity=excluded.severity, title=excluded.title, body=excluded.body, href=excluded.href,
           resolved_at = null`,
        [bizId, w.key, w.severity, w.title, w.body, w.href],
      );
    }
    // Anything no longer true is marked resolved (kept for history, hidden from the active list).
    const active = await q.query<{ id: string; dedupe_key: string }>(
      "select id,dedupe_key from notifications where business_id=$1 and resolved_at is null and dedupe_key not like 'integration:%'",
      [bizId],
    );
    for (const a of active)
      if (!keys.has(a.dedupe_key)) await q.query("update notifications set resolved_at=now() where id=$1", [a.id]);
  });
}

export const analyticsRoutes: Route[] = [
  [
    "GET",
    "overview",
    api(async (c) => {
      const { period } = c.query(z.object({ period: periodKind }));
      const s = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const info = periodInfo(period as PeriodKind, s.today);
      const cur = summarize(s.txns, s.cats, s.currency, info.current);
      const prev = summarize(s.txns, s.cats, s.currency, info.previous);
      const cash = cashBalance(s);
      const f = baseForecast(s, 45);
      const rw = runway(cash.total, s.txns, s.cats, s.currency, s.today);
      const series = periodSeries(s.txns, s.cats, s.currency, info, s.today);
      const breakdown = expenseBreakdown(s.txns, s.cats, s.currency, info.current);
      const budgets = budgetView(s);
      const goals = s.goals.map((g) => goalProgress(g, s));
      const receivables = s.invoices.filter(
        (i) => i.direction === "receivable" && i.status === "open" && i.currency === s.currency,
      );
      const payables = s.invoices.filter(
        (i) => i.direction === "payable" && i.status === "open" && i.currency === s.currency,
      );
      const outstanding = (arr: typeof receivables) => arr.reduce((a, i) => a + invoiceOutstanding(i), 0);
      const overdue = (arr: typeof receivables) =>
        arr.filter((i) => i.due_date < s.today).reduce((a, i) => a + invoiceOutstanding(i), 0);
      const insights = generateInsights(s);
      const dismissed = await c.db((q) =>
        q.query<{ key: string }>("select key from insight_dismissals where business_id=$1", [c.biz.id]),
      );
      const dset = new Set(dismissed.map((d) => d.key));
      const upcoming = f.events.filter((e) => e.date <= addDays(s.today, 14)).slice(0, 8);
      const biz = await c.db((q) =>
        q.query<any>("select onboarding, is_demo, setup_mode from businesses where id=$1", [c.biz.id]),
      );
      const integ = await c.db((q) =>
        q.query<{ provider: string; status: string }>("select provider,status from integrations where business_id=$1", [
          c.biz.id,
        ]),
      );

      await syncNotifications(c.biz.id, s).catch((e) => console.error("[notifications]", e));
      const unread = await c.db((q) =>
        q.query<{ n: number }>(
          "select count(*)::int n from notifications where business_id=$1 and read_at is null and resolved_at is null",
          [c.biz.id],
        ),
      );

      const checklist = [
        {
          id: "account",
          label: "Add your accounts and opening balances",
          done: s.accounts.length > 0 && s.accounts.some((a) => a.opening_balance !== 0 || s.txns.length > 0),
          href: "/app/settings/business",
        },
        {
          id: "transaction",
          label: "Record your first income and expense",
          done: s.txns.some((t) => t.type === "income") && s.txns.some((t) => t.type === "expense"),
          href: "/app/transactions?new=expense",
        },
        {
          id: "costs",
          label: "Add product or inventory costs",
          done:
            s.txns.some(
              (t) => t.type === "expense" && s.cats.find((c2) => c2.id === t.category_id)?.cost_type === "cogs",
            ) || s.productCount - s.productsWithoutCost > 0,
          href: "/app/products",
        },
        { id: "budget", label: "Create a budget", done: s.budgets.length > 0, href: "/app/budgets" },
        {
          id: "obligations",
          label: "Add recurring bills or unpaid invoices",
          done: s.recurring.length > 0 || s.invoices.length > 0,
          href: "/app/obligations",
        },
        { id: "goal", label: "Set a reserve or financial goal", done: s.goals.length > 0, href: "/app/goals" },
        {
          id: "integration",
          label: "Connect Shopify or an ads account (optional)",
          done: integ.some((i) => i.status !== "disconnected"),
          href: "/app/settings/integrations",
          optional: true,
        },
      ];

      return {
        currency: s.currency,
        today: s.today,
        isDemo: biz[0]?.is_demo ?? false,
        period: info,
        summary: cur,
        previous: prev,
        issues: summaryIssues(cur),
        cash: { total: cash.total, accounts: cash.accounts, otherCurrencies: cash.otherCurrencies },
        runway: rw,
        series,
        breakdown,
        forecast: {
          points: f.points.filter((_, i) => i % Math.ceil(f.days / 45) === 0 || i === f.days),
          minCash: f.minCash,
          minCashDate: f.minCashDate,
          firstShortfallDate: f.firstShortfallDate,
          endCash: f.endCash,
          days: f.days,
          assumptions: f.assumptions,
        },
        upcoming,
        receivables: {
          outstanding: outstanding(receivables),
          overdue: overdue(receivables),
          count: receivables.length,
        },
        payables: { outstanding: outstanding(payables), overdue: overdue(payables), count: payables.length },
        budgets: budgets.slice(0, 6),
        goals,
        insights: insights.filter((i) => !dset.has(i.key)).slice(0, 5),
        ads: adsSummary(s.ads, s.currency, info.current),
        checklist,
        hasData: s.txns.length > 0,
        unreadNotifications: unread[0]?.n ?? 0,
      };
    }),
  ],

  [
    "GET",
    "cashflow",
    api(async (c) => {
      const q2 = c.query(
        z.object({
          days: z.coerce.number().int().min(14).max(180).default(60),
          typical: z.enum(["0", "1"]).default("0"),
          delay: z.coerce.number().int().min(0).max(120).default(0),
          overdue: z.coerce.number().int().min(0).max(120).default(14),
        }),
      );
      const s = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const f = baseForecast(s, q2.days, {
        includeTypical: q2.typical === "1",
        receivableDelayDays: q2.delay,
        overdueReceivableDelayDays: q2.overdue,
      });
      const cash = cashBalance(s);
      return {
        currency: s.currency,
        today: s.today,
        cash: cash.total,
        accounts: cash.accounts,
        forecast: { ...f, points: f.points },
        typical: f.typical,
        typicalAvailable: f.typicalAvailable,
        includeTypical: q2.typical === "1" && f.typicalAvailable,
        reserved: s.goals.filter((g) => g.type === "reserve").reduce((a, g) => a + g.contributed, 0),
        overdue: s.invoices
          .filter(
            (i) =>
              i.status === "open" && i.due_date < s.today && invoiceOutstanding(i) > 0 && i.currency === s.currency,
          )
          .map((i) => ({
            id: i.id,
            direction: i.direction,
            label: i.description || i.number,
            due_date: i.due_date,
            outstanding: invoiceOutstanding(i),
          })),
        hasData: s.txns.length > 0 || s.invoices.length > 0 || s.recurring.length > 0,
      };
    }),
  ],

  [
    "GET",
    "ads",
    api(async (c) => {
      const { period } = c.query(z.object({ period: periodKind }));
      const s = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const info = periodInfo(period as PeriodKind, s.today);
      const cur = summarize(s.txns, s.cats, s.currency, info.current);
      const ads = adsSummary(s.ads, s.currency, info.current);
      const prev = adsSummary(s.ads, s.currency, info.previous);
      const recorded = s.cats.filter((x) => x.role === "ads").map((x) => x.id);
      const adCats = new Set<string>(recorded);
      for (const ct of s.cats) if (ct.parent_id && adCats.has(ct.parent_id)) adCats.add(ct.id);
      const recordedSpend = s.txns
        .filter(
          (t) =>
            t.type === "expense" &&
            t.currency === s.currency &&
            t.date >= info.current.from &&
            t.date <= info.current.to &&
            t.category_id &&
            adCats.has(t.category_id),
        )
        .reduce((a, t) => a + t.amount, 0);
      const integ = await c.db((q) =>
        q.query<any>(
          "select provider,status,last_sync_at,last_error from integrations where business_id=$1 and provider in ('meta_ads','google_ads')",
          [c.biz.id],
        ),
      );
      const gm = cur.grossMargin;
      return {
        currency: s.currency,
        period: info,
        ads,
        previous: prev,
        recordedSpend,
        revenue: cur.revenue,
        grossMargin: gm,
        breakEvenRoas: gm && gm > 0 && !cur.incomplete ? 1 / gm : null,
        marginIncomplete: cur.incomplete,
        integrations: integ,
        adShareOfRevenue: cur.revenue > 0 ? recordedSpend / cur.revenue : null,
      };
    }),
  ],

  [
    "GET",
    "insights",
    api(async (c) => {
      const s = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const dismissed = await c.db((q) =>
        q.query<{ key: string }>("select key from insight_dismissals where business_id=$1", [c.biz.id]),
      );
      const dset = new Set(dismissed.map((d) => d.key));
      const all = generateInsights(s);
      return {
        items: all.filter((i) => !dset.has(i.key)),
        dismissed: all.filter((i) => dset.has(i.key)).length,
        hasData: s.txns.length > 0,
      };
    }),
  ],
  [
    "POST",
    "insights/dismiss",
    api(async (c) => {
      const b = await c.body(z.object({ key: z.string().min(1).max(200), restore: z.boolean().optional() }));
      await c.db((q) =>
        b.restore
          ? q.query("delete from insight_dismissals where business_id=$1 and key=$2", [c.biz.id, b.key])
          : q.query("insert into insight_dismissals(business_id,key) values ($1,$2) on conflict do nothing", [
              c.biz.id,
              b.key,
            ]),
      );
      return { ok: true };
    }),
  ],
  [
    "POST",
    "insights/restore-all",
    api(async (c) => {
      await c.db((q) => q.query("delete from insight_dismissals where business_id=$1", [c.biz.id]));
      return { ok: true };
    }),
  ],

  [
    "POST",
    "copilot",
    api(async (c) => {
      const b = await c.body(
        z.object({
          question: z.string().trim().min(2, "Ask a question").max(300),
          amount: z.number().int().positive().optional(),
          percent: z.number().min(0).max(100).optional(),
        }),
      );
      const s = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const extra = await c.db(async (q) => {
        const from = addDays(s.today, -89);
        const [orders, lines, products, recs] = await Promise.all([
          q.query<any>(
            "select id,local_date::text,currency,cancelled_at,is_test,total,tax,shipping,discounts,refunded from orders where business_id=$1 and local_date >= $2",
            [c.biz.id, from],
          ),
          q.query<any>(
            "select l.order_id,l.variant_external_id,l.title,l.sku,l.quantity,l.current_quantity,l.discounted_total,l.unit_cost from order_lines l join orders o on o.id=l.order_id where l.business_id=$1 and o.local_date >= $2",
            [c.biz.id, from],
          ),
          q.query<any>("select external_id,name,unit_cost from products where business_id=$1", [c.biz.id]),
          q.query<{ title: string }>(
            "select title from recommendations where business_id=$1 and status='open' order by created_at desc limit 3",
            [c.biz.id],
          ),
        ]);
        const settings =
          (await q.query<any>("select settings from businesses where id=$1", [c.biz.id]))[0]?.settings ?? {};
        const rep = profitReport({
          range: { from, to: s.today },
          currency: s.currency,
          txns: s.txns,
          cats: s.cats,
          orders,
          lines,
          products,
          ads: s.ads,
          assumptions: settings.costAssumptions ?? {},
        });
        return { products: rep.products, openRecommendations: recs };
      });
      const a = answer(s, b.question, { amount: b.amount, percent: b.percent }, extra);
      const ai = await explainWithAi(a, c.biz.currency);
      return { ...a, ai };
    }),
  ],

  // scenarios
  [
    "POST",
    "scenarios/simulate",
    api(async (c) => {
      const b = await c.body(
        z.object({
          adjustments: z.array(z.record(z.string(), z.unknown())).min(1).max(6),
          horizon: z.number().int().min(30).max(180).default(90),
        }),
      );
      const s = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const result = simulate(s, b.adjustments as unknown as Adjustment[], b.horizon);
      const base = monthlyBaseline(s);
      return { result, currency: s.currency, baselineMonthly: base, today: s.today };
    }),
  ],
  [
    "GET",
    "scenarios",
    api(async (c) => ({
      items: await c.db((q) =>
        q.query(
          "select id,name,kind,params,result,created_at from scenarios where business_id=$1 order by created_at desc limit 50",
          [c.biz.id],
        ),
      ),
    })),
  ],
  [
    "POST",
    "scenarios",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1, "Name this scenario").max(100),
          adjustments: z.array(z.record(z.string(), z.unknown())).min(1).max(6),
        }),
      );
      const s = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const result = simulate(s, b.adjustments as unknown as Adjustment[]);
      const slim = { baseline: result.baseline, scenario: result.scenario };
      const r = await c.db((q) =>
        q.query(
          "insert into scenarios(business_id,name,kind,params,result,created_by) values ($1,$2,$3,$4::text::jsonb,$5::text::jsonb,$6) returning id",
          [
            c.biz.id,
            b.name,
            String((b.adjustments[0] as any).type ?? "mixed"),
            JSON.stringify(b.adjustments),
            JSON.stringify(slim),
            c.user.id,
          ],
        ),
      );
      return { id: r[0].id };
    }),
  ],
  [
    "DELETE",
    "scenarios/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db((q) => q.query("delete from scenarios where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],

  // notifications
  [
    "GET",
    "notifications",
    api(async (c) => {
      const rows = await c.db((q) =>
        q.query(
          "select id,severity,title,body,href,read_at,created_at from notifications where business_id=$1 and resolved_at is null order by (read_at is null) desc, created_at desc limit 40",
          [c.biz.id],
        ),
      );
      return { items: rows, unread: rows.filter((r: any) => !r.read_at).length };
    }),
  ],
  [
    "POST",
    "notifications/read",
    api(async (c) => {
      const b = await c.body(z.object({ id: uuid.optional(), all: z.boolean().optional() }));
      await c.db((q) =>
        b.all
          ? q.query("update notifications set read_at=now() where business_id=$1 and read_at is null", [c.biz.id])
          : q.query("update notifications set read_at=now() where business_id=$1 and id=$2", [c.biz.id, b.id ?? null]),
      );
      return { ok: true };
    }),
  ],
];

export { isoDate, notFound, todayISO };
