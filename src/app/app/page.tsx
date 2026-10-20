"use client";
import { ArrowRight, CalendarClock, CheckCircle2, Circle, Plus, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { AreaLine, CompositionBar, RevenueBars } from "@/components/charts";
import { InsightItem, type InsightData } from "@/components/app/insight";
import { useShell } from "@/components/app/shell";
import { TodayPanel } from "@/components/app/today";
import { SimpleHome } from "@/components/app/simple-home";
import { useMode } from "@/lib/client/mode";
import {
  Badge,
  Button,
  Card,
  DataLabel,
  Delta,
  ErrorNote,
  Hint,
  MetricLabel,
  Money,
  PageHeader,
  Progress,
  Segmented,
  Skeleton,
} from "@/components/ui";
import { useMe } from "@/lib/client/hooks";
import { formatMoney } from "@/lib/finance/money";

type Period = "week" | "month" | "quarter" | "year";

interface Overview {
  currency: string;
  today: string;
  isDemo: boolean;
  period: {
    kind: Period;
    full: { from: string; to: string };
    current: { from: string; to: string };
    elapsedDays: number;
    totalDays: number;
  };
  summary: Summary;
  previous: Summary;
  issues: { code: string; severity: string; message: string; href?: string }[];
  cash: {
    total: number;
    accounts: { id: string; name: string; currency: string; balance: number }[];
    otherCurrencies: any[];
  };
  runway: { months: number | null; monthlyBurn: number | null; basisDays: number };
  series: { label: string; from: string; to: string; revenue: number; expenses: number; profit: number }[];
  breakdown: { slices: { id: string; name: string; color: string; amount: number }[]; total: number };
  forecast: {
    points: { date: string; balance: number }[];
    minCash: number;
    minCashDate: string;
    firstShortfallDate: string | null;
    endCash: number;
    days: number;
  };
  upcoming: { date: string; amount: number; label: string; kind: string; assumed?: string }[];
  receivables: { outstanding: number; overdue: number; count: number };
  payables: { outstanding: number; overdue: number; count: number };
  budgets: {
    id: string;
    categoryName: string;
    planned: number;
    spent: number;
    usedPct: number;
    timeElapsedPct: number;
    status: string;
    projectedByPace: number;
  }[];
  goals: { id: string; name: string; type: string; target: number; current: number; pct: number; achieved: boolean }[];
  insights: InsightData[];
  checklist: { id: string; label: string; done: boolean; href: string; optional?: boolean }[];
  hasData: boolean;
}
interface Summary {
  revenue: number;
  refunds: number;
  cogs: number;
  grossProfit: number;
  opex: number;
  netProfit: number;
  margin: number | null;
  incomplete: boolean;
  txnCount: number;
  cashIn: number;
  cashOut: number;
  netCash: number;
}

const PERIOD_LABEL: Record<Period, string> = {
  week: "this week",
  month: "this month",
  quarter: "this quarter",
  year: "this year",
};

export default function Home() {
  const [mode] = useMode();
  return mode === "simple" ? <SimpleHome /> : <Dashboard />;
}

function Dashboard() {
  const { biz } = useMe();
  const [period, setPeriod] = useState<Period>("month");
  useEffect(() => {
    try {
      const p = localStorage.getItem("margin-period") as Period | null;
      if (p && ["week", "month", "quarter", "year"].includes(p)) setPeriod(p);
    } catch {
      /* ignore */
    }
  }, []);
  const choose = (p: Period) => {
    setPeriod(p);
    try {
      localStorage.setItem("margin-period", p);
    } catch {
      /* ignore */
    }
  };
  const { data, error, isLoading, mutate } = useSWR<Overview>(`/api/overview?period=${period}`, {
    keepPreviousData: true,
  });
  const { openAdd } = useShell();

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();

  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (isLoading || !data) return <DashboardSkeleton />;
  const d = data;
  const cur = d.currency;
  const s = d.summary;
  const p = d.previous;
  const doneCount = d.checklist.filter((c) => c.done).length;
  const setupNeeded = !d.hasData || doneCount < d.checklist.filter((c) => !c.optional).length;
  const marginOut100 = s.margin !== null ? Math.round(s.margin * 100) : null;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`${biz?.name ?? ""}${d.isDemo ? " · demo data" : ""}`}
        title={`${greeting}.`}
        subtitle={
          d.hasData
            ? `Here is how the business is doing ${PERIOD_LABEL[period]} — ${d.period.elapsedDays} of ${d.period.totalDays} days in.`
            : "Your workspace is ready. Add a few records and this page will come alive."
        }
        actions={
          <>
            <Segmented
              label="Period"
              value={period}
              onChange={choose}
              options={[
                { value: "week", label: "Week" },
                { value: "month", label: "Month" },
                { value: "quarter", label: "Quarter" },
                { value: "year", label: "Year" },
              ]}
            />
            <Button variant="primary" onClick={() => openAdd()} className="md:hidden">
              <Plus className="size-4" /> Add
            </Button>
          </>
        }
      />

      <TodayPanel />

      {setupNeeded && <SetupChecklist items={d.checklist} done={doneCount} />}

      {d.issues.filter((i) => i.severity === "warning").length > 0 && (
        <ul className="space-y-2" aria-label="Data completeness">
          {d.issues
            .filter((i) => i.severity === "warning")
            .map((i) => (
              <li
                key={i.code}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warn/30 bg-warnsoft px-4 py-3 text-sm text-warn"
              >
                <span className="flex items-start gap-2">
                  <DataLabel kind="incomplete" />
                  <span className="text-ink">{i.message}</span>
                </span>
                {i.href && (
                  <Link href={i.href} className="font-medium underline underline-offset-2">
                    Fix this
                  </Link>
                )}
              </li>
            ))}
        </ul>
      )}

      {/* Performance + cash */}
      <section className="grid gap-5 lg:grid-cols-12">
        <Card className="overflow-hidden lg:col-span-8">
          <div className="p-5 sm:p-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <MetricLabel k="profit" term="Profit" />
              <div className="flex items-center gap-2">
                {s.incomplete ? <DataLabel kind="incomplete" /> : <DataLabel kind="actual" />}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-1">
              <Money
                value={s.netProfit}
                currency={cur}
                className={`fig text-[2.8rem] leading-none sm:text-[3.6rem] ${s.netProfit < 0 ? "text-neg" : "text-ink"}`}
              />
              <div className="pb-1.5">
                <Delta now={s.netProfit} before={p.netProfit} />
              </div>
            </div>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink2">
              {!d.hasData
                ? "Once you record income and expenses, this shows what the business actually kept."
                : s.incomplete
                  ? "This is revenue minus the costs you have recorded so far. Product costs are missing, so the real profit is probably lower."
                  : s.netProfit < 0
                    ? `Your recorded costs ${PERIOD_LABEL[period]} are higher than what you sold${marginOut100 !== null ? ` — a loss of about ${Math.abs(marginOut100)} for every 100 you sold` : ""}.`
                    : `Your business kept this much after the costs recorded ${PERIOD_LABEL[period]}${marginOut100 !== null ? ` — about ${marginOut100} out of every 100 you sold` : ""}.`}
            </p>
          </div>

          {/* Revenue − costs = profit, each term teachable */}
          <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
            {[
              {
                k: "revenue",
                label: "Revenue",
                v: s.revenue,
                sub:
                  s.refunds > 0 ? `after ${formatMoney(s.refunds, cur, { compact: true })} refunds` : "net of refunds",
                op: "",
              },
              {
                k: "cogs",
                label: "Cost of goods",
                v: s.cogs,
                sub: s.cogs === 0 && s.revenue > 0 ? "none recorded" : "direct costs",
                op: "−",
              },
              { k: "opex", label: "Operating expenses", v: s.opex, sub: "running the business", op: "−" },
              {
                k: "profit_margin",
                label: "Profit margin",
                v: -1,
                sub:
                  marginOut100 === null
                    ? "needs revenue"
                    : marginOut100 >= 0
                      ? `${marginOut100} of every 100 sold kept`
                      : `${Math.abs(marginOut100)} lost per 100 sold`,
                op: "",
              },
            ].map((t) => (
              <div key={t.k} className="bg-surface px-5 py-4">
                <div className="flex items-center gap-1">
                  <span className="eyebrow">
                    {t.op && <span className="me-1 text-ink3">{t.op}</span>}
                    {t.label}
                  </span>
                  <Hint k={t.k} />
                </div>
                {t.v === -1 ? (
                  <p className="fig mt-1 text-2xl text-ink">{marginOut100 !== null ? `${marginOut100}%` : "—"}</p>
                ) : (
                  <p className="fig mt-1 text-2xl text-ink">
                    <Money value={t.v} currency={cur} compact />
                  </p>
                )}
                <p className="mt-0.5 text-xs text-ink3">{t.sub}</p>
              </div>
            ))}
          </div>

          <div className="border-t border-line p-5 sm:p-7">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-ink">Revenue and expenses</p>
              <div className="flex items-center gap-4 text-xs text-ink3">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm bg-accent" /> Revenue
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm bg-ink3/60" /> Expenses
                </span>
              </div>
            </div>
            {d.hasData ? (
              <RevenueBars
                data={d.series.map((b) => ({
                  label: b.label,
                  from: b.from,
                  revenue: Math.max(0, b.revenue),
                  expenses: Math.max(0, b.expenses),
                  profit: b.profit,
                  future: b.from > d.today,
                }))}
                currency={cur}
                label={`Revenue and expenses ${PERIOD_LABEL[period]}`}
              />
            ) : (
              <p className="py-10 text-center text-sm text-ink3">No activity in this period yet.</p>
            )}
          </div>
        </Card>

        <div className="space-y-5 lg:col-span-4">
          <Card className="p-5 sm:p-6">
            <MetricLabel k="cash_balance" term="Cash available" />
            <div className="mt-2">
              <Money
                value={d.cash.total}
                currency={cur}
                className={`fig text-[2.4rem] leading-none ${d.cash.total < 0 ? "text-neg" : "text-ink"}`}
              />
            </div>
            <p className="mt-2 text-[13px] text-ink3">{`Recorded across ${d.cash.accounts.filter((a) => a.currency.trim() === cur).length} account(s). Not the same as profit.`}</p>
            <div className="mt-4 space-y-2 border-t border-line pt-4">
              {d.cash.accounts.slice(0, 4).map((a) => (
                <div key={a.id} className="flex items-center justify-between text-sm">
                  <span className="truncate text-ink2">{a.name}</span>
                  <Money value={a.balance} currency={a.currency.trim()} compact className="text-ink" animate={false} />
                </div>
              ))}
            </div>
            <div className="mt-4 border-t border-line pt-4">
              <div className="flex items-center gap-1">
                <span className="eyebrow">Runway</span>
                <Hint k="runway" />
              </div>
              <p className="fig mt-1 text-xl text-ink">
                {d.runway.months === null
                  ? d.runway.monthlyBurn === null && d.runway.basisDays >= 14
                    ? "Not burning cash"
                    : "Not enough history"
                  : `${d.runway.months.toFixed(1)} months`}
              </p>
              <p className="mt-0.5 text-xs text-ink3">
                {d.runway.monthlyBurn
                  ? `At about ${formatMoney(d.runway.monthlyBurn, cur, { compact: true })} net outflow per month (last ${d.runway.basisDays} days).`
                  : "Based on your last 90 days of activity."}
              </p>
            </div>
          </Card>

          <Card className="p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <MetricLabel k="receivable" question={false} term="Owed to you" />
              <Link href="/app/obligations?tab=receivables" className="text-xs font-medium text-accent">
                View
              </Link>
            </div>
            <Money value={d.receivables.outstanding} currency={cur} className="fig mt-1 block text-2xl text-ink" />
            <p className="text-xs text-ink3">
              {d.receivables.overdue > 0
                ? `${formatMoney(d.receivables.overdue, cur, { compact: true })} is overdue`
                : d.receivables.count
                  ? "Nothing overdue"
                  : "No open invoices"}
            </p>
            <div className="my-3 h-px bg-line" />
            <div className="flex items-center justify-between">
              <MetricLabel k="payable" question={false} term="You owe" />
              <Link href="/app/obligations?tab=payables" className="text-xs font-medium text-accent">
                View
              </Link>
            </div>
            <Money value={d.payables.outstanding} currency={cur} className="fig mt-1 block text-2xl text-ink" />
            <p className="text-xs text-ink3">
              {d.payables.overdue > 0
                ? `${formatMoney(d.payables.overdue, cur, { compact: true })} is overdue`
                : d.payables.count
                  ? "Nothing overdue"
                  : "No open bills"}
            </p>
          </Card>
        </div>
      </section>

      {/* Cash outlook + coming up */}
      <section className="grid gap-5 lg:grid-cols-12">
        <Card className="p-5 sm:p-7 lg:col-span-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <MetricLabel k="cash_flow" term="Cash outlook" />
            </div>
            <div className="flex items-center gap-2">
              <DataLabel kind="projected" />
              <Link href="/app/cash-flow" className="text-[13px] font-medium text-accent">
                Open timeline →
              </Link>
            </div>
          </div>
          <p className="mt-3 text-[15px] leading-relaxed text-ink2">
            {d.forecast.firstShortfallDate ? (
              <>
                Scheduled payments push your balance below zero on{" "}
                <strong className="text-neg">{d.forecast.firstShortfallDate}</strong>, to a low of{" "}
                <strong className="text-neg">{formatMoney(d.forecast.minCash, cur)}</strong>.
              </>
            ) : d.upcoming.length ? (
              <>
                {`With the payments you have scheduled, your lowest balance over the next ${d.forecast.days} days is ${formatMoney(d.forecast.minCash, cur)} on ${d.forecast.minCashDate}.`}
              </>
            ) : (
              "No payments are scheduled yet. Add recurring bills and invoices to see your cash outlook."
            )}
          </p>
          <div className="mt-4">
            <AreaLine
              series={d.forecast.points.map((q) => ({ date: q.date, value: q.balance }))}
              currency={cur}
              height={220}
              label="Projected cash balance, scheduled items only"
              projectedFrom={d.today}
            />
          </div>
          <p className="mt-2 text-xs text-ink3">
            Scheduled items only: future sales and unscheduled spending are not included.
          </p>
        </Card>

        <Card className="p-5 sm:p-7 lg:col-span-5">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-5 text-accent" aria-hidden />
            <h2 className="display text-xl">Coming up</h2>
          </div>
          <p className="mt-1 text-[13px] text-ink3">
            Next 14 days · scheduled bills, recurring payments and expected receipts
          </p>
          {d.upcoming.length === 0 ? (
            <p className="mt-6 rounded-xl bg-sunken px-4 py-6 text-center text-sm text-ink3">
              Nothing scheduled.{" "}
              <Link href="/app/obligations" className="font-medium text-accent">
                Add a bill or recurring expense
              </Link>
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-line">
              {d.upcoming.map((u, i) => (
                <li key={i} className="flex items-center gap-3 py-3">
                  <div className="w-12 shrink-0 text-center">
                    <p className="eyebrow">
                      {new Date(u.date + "T00:00:00Z").toLocaleDateString("en", { month: "short", timeZone: "UTC" })}
                    </p>
                    <p className="fig text-xl leading-none">{u.date.slice(8)}</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{u.label}</p>
                    <p className="truncate text-xs text-ink3">
                      {u.assumed ??
                        (u.kind === "payable"
                          ? "Bill due"
                          : u.kind === "receivable"
                            ? "Invoice expected"
                            : u.amount < 0
                              ? "Recurring payment"
                              : "Recurring income")}
                    </p>
                  </div>
                  <Money
                    value={u.amount}
                    currency={cur}
                    sign
                    className={u.amount < 0 ? "text-ink" : "text-pos"}
                    compact
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* Budgets + spending + goals */}
      <section className="grid gap-5 lg:grid-cols-12">
        <Card className="p-5 sm:p-7 lg:col-span-5">
          <div className="flex items-start justify-between">
            <MetricLabel k="budget" term="Budgets" />
            <Link href="/app/budgets" className="text-[13px] font-medium text-accent">
              Manage →
            </Link>
          </div>
          {d.budgets.length === 0 ? (
            <div className="mt-5 rounded-xl bg-sunken p-5 text-center text-sm text-ink2">
              No budgets yet. A budget turns “how much should I spend?” into a guardrail.
              <div className="mt-3">
                <Button href="/app/budgets" variant="secondary" size="sm">
                  Create a budget
                </Button>
              </div>
            </div>
          ) : (
            <ul className="mt-5 space-y-5">
              {d.budgets.slice(0, 5).map((b) => (
                <li key={b.id}>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-medium text-ink">{b.categoryName}</span>
                    <span className="num shrink-0 text-ink2">
                      {formatMoney(b.spent, cur, { compact: true })}{" "}
                      <span className="text-ink3">of {formatMoney(b.planned, cur, { compact: true })}</span>
                    </span>
                  </div>
                  <div className="relative mt-2">
                    <Progress
                      value={b.usedPct}
                      tone={
                        b.status === "over" ? "neg" : b.status === "at_risk" || b.status === "watch" ? "warn" : "accent"
                      }
                      label={`${b.categoryName} budget used`}
                    />
                    <span
                      aria-hidden
                      title="Time elapsed in the period"
                      className="absolute -top-1 h-4 w-0.5 rounded bg-ink/60"
                      style={{ insetInlineStart: `${Math.min(100, b.timeElapsedPct * 100)}%` }}
                    />
                  </div>
                  {(b.status === "over" || b.status === "at_risk") && (
                    <p className={`mt-1.5 text-xs ${b.status === "over" ? "text-neg" : "text-warn"}`}>
                      {b.status === "over"
                        ? "Over budget"
                        : `On pace for ${formatMoney(b.projectedByPace, cur, { compact: true })} — may exceed this budget`}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5 sm:p-7 lg:col-span-7">
          <h2 className="display text-xl">Where the money went</h2>
          <p className="mt-1 text-[13px] text-ink3">Expenses {PERIOD_LABEL[period]} by category</p>
          <div className="mt-5">
            {d.breakdown.total > 0 ? (
              <CompositionBar slices={d.breakdown.slices} total={d.breakdown.total} currency={cur} />
            ) : (
              <p className="rounded-xl bg-sunken px-4 py-8 text-center text-sm text-ink3">
                No expenses recorded in this period.
              </p>
            )}
          </div>
          {d.goals.length > 0 && (
            <div className="mt-7 border-t border-line pt-5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-ink">Goals</p>
                <Link href="/app/goals" className="text-[13px] font-medium text-accent">
                  All goals →
                </Link>
              </div>
              <ul className="mt-3 space-y-3">
                {d.goals.slice(0, 3).map((g) => (
                  <li key={g.id}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 truncate text-ink2">
                        {g.name}
                        {g.achieved && <Badge tone="pos">Reached</Badge>}
                      </span>
                      <span className="num text-ink">{Math.round(g.pct * 100)}%</span>
                    </div>
                    <Progress
                      className="mt-1.5"
                      value={g.pct}
                      tone={g.achieved ? "pos" : "accent"}
                      label={`${g.name} progress`}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </section>

      {/* Attention */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="display flex items-center gap-2 text-2xl">
            <Sparkles className="size-5 text-accent" aria-hidden /> What needs your attention
          </h2>
          <Link href="/app/insights" className="text-[13px] font-medium text-accent">
            Ask the copilot →
          </Link>
        </div>
        {d.insights.length === 0 ? (
          <Card className="px-5 py-8 text-center text-sm text-ink2">
            {d.hasData
              ? "Nothing needs attention right now. Socio will flag budget, cash and data issues as they appear."
              : "Insights appear once you have records to analyse."}
          </Card>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {d.insights.slice(0, 4).map((i) => (
              <InsightItem key={i.key} i={i} compact />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SetupChecklist({ items, done }: { items: Overview["checklist"]; done: number }) {
  return (
    <Card className="overflow-hidden">
      <div className="grid gap-0 md:grid-cols-[1fr_1.4fr]">
        <div className="bg-accent p-6 text-accentink sm:p-7">
          <p className="eyebrow text-accentink/70">First steps</p>
          <h2 className="display mt-1 text-3xl leading-tight">Make Socio useful in ten minutes.</h2>
          <p className="mt-2 text-sm text-accentink/80">
            {done} of {items.length} done. Everything works without any integration — connect one whenever you like.
          </p>
          <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-accentink/20">
            <motion.div
              className="h-full rounded-full bg-signal"
              initial={{ width: 0 }}
              animate={{ width: `${(done / items.length) * 100}%` }}
            />
          </div>
        </div>
        <ul className="divide-y divide-line">
          {items.map((c) => (
            <li key={c.id}>
              <Link href={c.href} className="group flex items-center gap-3 px-5 py-3.5 transition hover:bg-sunken">
                {c.done ? (
                  <CheckCircle2 className="size-5 shrink-0 text-pos" aria-label="Done" />
                ) : (
                  <Circle className="size-5 shrink-0 text-line2" aria-label="To do" />
                )}
                <span className={`flex-1 text-sm ${c.done ? "text-ink3 line-through" : "font-medium text-ink"}`}>
                  {c.label}
                </span>
                {c.optional && <Badge>Optional</Badge>}
                {!c.done && (
                  <ArrowRight
                    className="size-4 text-ink3 transition group-hover:translate-x-0.5 group-hover:text-accent"
                    aria-hidden
                  />
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading overview">
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-12 w-72" />
      </div>
      <div className="grid gap-5 lg:grid-cols-12">
        <Skeleton className="h-[34rem] lg:col-span-8" />
        <div className="space-y-5 lg:col-span-4">
          <Skeleton className="h-72" />
          <Skeleton className="h-52" />
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-12">
        <Skeleton className="h-80 lg:col-span-7" />
        <Skeleton className="h-80 lg:col-span-5" />
      </div>
    </div>
  );
}
