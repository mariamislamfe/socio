"use client";
import { AlertTriangle, ArrowRight, CheckCircle2, Info } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { AreaLine } from "@/components/charts";
import {
  Badge,
  Button,
  Card,
  clsx,
  DataLabel,
  EmptyState,
  ErrorNote,
  Field,
  Hint,
  Input,
  MetricLabel,
  Money,
  PageHeader,
  Segmented,
  Skeleton,
} from "@/components/ui";
import { useMe } from "@/lib/client/hooks";
import { formatMoney } from "@/lib/finance/money";

interface Ev {
  date: string;
  amount: number;
  label: string;
  kind: string;
  assumed?: string;
}
interface CF {
  currency: string;
  today: string;
  cash: number;
  reserved: number;
  hasData: boolean;
  accounts: { id: string; name: string; currency: string; balance: number }[];
  forecast: {
    points: { date: string; balance: number; inflow: number; outflow: number }[];
    events: Ev[];
    endCash: number;
    minCash: number;
    minCashDate: string;
    firstShortfallDate: string | null;
    shortfallContributors: Ev[];
    totalIn: number;
    totalOut: number;
    assumptions: string[];
    suppressedDuplicates: number;
    days: number;
  };
  typical: { inPerDay: number; outPerDay: number; days: number } | null;
  typicalAvailable: boolean;
  includeTypical: boolean;
  overdue: { id: string; direction: string; label: string; due_date: string; outstanding: number }[];
}

const KIND: Record<string, { label: string; tone: "neutral" | "pos" | "neg" | "info" | "warn" }> = {
  recurring_out: { label: "Recurring", tone: "neutral" },
  recurring_in: { label: "Recurring income", tone: "pos" },
  payable: { label: "Bill", tone: "warn" },
  receivable: { label: "Invoice", tone: "info" },
  scenario: { label: "Scenario", tone: "info" },
};

export default function CashFlowPage() {
  const { biz } = useMe();
  const [days, setDays] = useState(60);
  const [typical, setTypical] = useState(false);
  const [overdueDelay, setOverdueDelay] = useState(14);
  const [delay, setDelay] = useState(0);
  const key = `/api/cashflow?days=${days}&typical=${typical ? 1 : 0}&overdue=${overdueDelay}&delay=${delay}`;
  const { data, error, isLoading, mutate } = useSWR<CF>(key, { keepPreviousData: true });

  const cur = data?.currency ?? biz?.currency.trim() ?? "EGP";
  const eventsByDate = useMemo(() => {
    const m = new Map<string, Ev[]>();
    for (const e of data?.forecast.events ?? []) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return [...m.entries()];
  }, [data]);

  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (isLoading && !data) return <Skeleton className="h-[40rem]" />;
  if (!data) return null;
  const f = data.forecast;
  const short = f.firstShortfallDate;
  const gap = Math.max(0, -f.minCash);
  const overdueRecv = data.overdue.filter((o) => o.direction === "receivable");
  const overdueRecvTotal = overdueRecv.reduce((a, o) => a + o.outstanding, 0);
  const bigBills = f.shortfallContributors
    .filter((c) => c.kind === "payable" || c.kind === "recurring_out")
    .slice(0, 3);
  const markers = f.events
    .filter((e) => Math.abs(e.amount) >= Math.max(1, (data.cash || 1) * 0.05))
    .map((e) => ({ date: e.date, label: e.label, amount: e.amount }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash flow"
        subtitle="Will you have enough money for the next few weeks? Your recorded cash, then every scheduled bill, recurring payment and expected invoice, day by day."
        actions={
          <Segmented
            label="Forecast horizon"
            value={String(days) as "30"}
            onChange={(v) => setDays(Number(v))}
            options={[
              { value: "30", label: "30 days" },
              { value: "60", label: "60 days" },
              { value: "90", label: "90 days" },
              { value: "180", label: "180 days" },
            ]}
          />
        }
      />

      {!data.hasData ? (
        <EmptyState
          title="No cash data yet"
          body="Add your account balances, recurring bills and unpaid invoices to see when money comes in and goes out."
          action={
            <>
              <Button href="/app/obligations" variant="primary">
                Add bills &amp; invoices
              </Button>
              <Button href="/app/transactions?new=income">Add a transaction</Button>
            </>
          }
        />
      ) : (
        <>
          <section className="grid gap-5 lg:grid-cols-12">
            <Card className="overflow-hidden lg:col-span-8">
              <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                <div className="p-5">
                  <MetricLabel k="cash_balance" term="Cash today" question={false} />
                  <p className="fig mt-1 text-3xl">
                    <Money value={data.cash} currency={cur} />
                  </p>
                  <p className="mt-1">
                    <DataLabel kind="actual" />
                  </p>
                </div>
                <div className="p-5">
                  <div className="flex items-center gap-1">
                    <span className="eyebrow">Lowest point</span>
                    <Hint k="forecast" />
                  </div>
                  <p className={clsx("fig mt-1 text-3xl", f.minCash < 0 && "text-neg")}>
                    <Money value={f.minCash} currency={cur} />
                  </p>
                  <p className="mt-1 text-xs text-ink3">on {f.minCashDate}</p>
                </div>
                <div className="p-5">
                  <div className="flex items-center gap-1">
                    <span className="eyebrow">In {days} days</span>
                  </div>
                  <p className={clsx("fig mt-1 text-3xl", f.endCash < 0 && "text-neg")}>
                    <Money value={f.endCash} currency={cur} />
                  </p>
                  <p className="mt-1">
                    <DataLabel kind="projected" />
                  </p>
                </div>
              </div>
              <div className="border-t border-line p-5 sm:p-6">
                <AreaLine
                  series={f.points.map((p) => ({ date: p.date, value: p.balance }))}
                  currency={cur}
                  height={300}
                  markers={markers}
                  projectedFrom={data.today}
                  label={`Projected cash balance for the next ${days} days`}
                />
                <p className="mt-3 flex items-start gap-2 text-xs text-ink3">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  Everything right of today is a projection built from your assumptions. Dots mark large payments and
                  receipts. Use the arrow keys on the chart to step through days.
                </p>
              </div>
            </Card>

            <div className="space-y-5 lg:col-span-4">
              {short ? (
                <Card className="border-neg/40 bg-negsoft/40 p-5">
                  <p className="flex items-center gap-2 text-sm font-semibold text-neg">
                    <AlertTriangle className="size-4" aria-hidden /> Shortfall on {short}
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-ink2">
                    You would be short by up to <strong className="text-neg">{formatMoney(gap, cur)}</strong> (lowest
                    balance {formatMoney(f.minCash, cur)}). The biggest contributors before that date:
                  </p>
                  <ul className="mt-3 space-y-1.5">
                    {f.shortfallContributors.slice(0, 4).map((c, i) => (
                      <li key={i} className="flex justify-between gap-3 text-sm">
                        <span className="truncate text-ink">
                          {c.label} <span className="text-ink3">· {c.date}</span>
                        </span>
                        <span className="num text-neg">{formatMoney(c.amount, cur)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4 border-t border-neg/20 pt-4">
                    <p className="text-sm font-medium text-ink">Options to consider</p>
                    <ul className="mt-2 space-y-2 text-[13px] leading-relaxed text-ink2">
                      {overdueRecvTotal > 0 && (
                        <li>
                          • Collect overdue invoices — {formatMoney(overdueRecvTotal, cur)} is past due
                          {overdueRecvTotal >= gap
                            ? ", enough to cover the gap"
                            : `, covering ${Math.round((overdueRecvTotal / gap) * 100)}% of it`}
                          .
                        </li>
                      )}
                      {bigBills.length > 0 && (
                        <li>
                          • Ask suppliers to move or split <strong>{bigBills[0].label}</strong> (
                          {formatMoney(-bigBills[0].amount, cur)}, due {bigBills[0].date}).
                        </li>
                      )}
                      <li>
                        • Test a cut in spending or a delayed purchase in the{" "}
                        <Link href="/app/scenarios" className="font-medium text-accent underline">
                          what-if simulator
                        </Link>
                        .
                      </li>
                      {data.reserved > 0 && (
                        <li>
                          • You have {formatMoney(data.reserved, cur)} noted as reserve — a planning figure you may
                          choose to draw on.
                        </li>
                      )}
                    </ul>
                  </div>
                </Card>
              ) : (
                <Card className="border-pos/30 bg-possoft/50 p-5">
                  <p className="flex items-center gap-2 text-sm font-semibold text-pos">
                    <CheckCircle2 className="size-4" aria-hidden /> No shortfall in the next {days} days
                  </p>
                  <p className="mt-2 text-sm text-ink2">
                    Based on what is scheduled, cash stays above zero. Your tightest day is {f.minCashDate} at{" "}
                    {formatMoney(f.minCash, cur)}.
                  </p>
                  {data.reserved > 0 && f.minCash < data.reserved && (
                    <p className="mt-2 text-[13px] text-warn">
                      That dips below the {formatMoney(data.reserved, cur)} you have set aside as a reserve.
                    </p>
                  )}
                </Card>
              )}

              <Card className="p-5">
                <p className="text-sm font-semibold text-ink">Assumptions you control</p>
                <div className="mt-4 space-y-4">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={typical && data.typicalAvailable}
                      disabled={!data.typicalAvailable}
                      onChange={(e) => setTypical(e.target.checked)}
                      className="mt-1 size-4 accent-[var(--accent)]"
                    />
                    <span className="text-sm">
                      <span className="font-medium text-ink">Include typical sales &amp; spending</span>
                      <span className="mt-0.5 block text-[13px] text-ink3">
                        {data.typical
                          ? `Uses your ${data.typical.days}-day average (${formatMoney(data.typical.inPerDay, cur)} in / ${formatMoney(data.typical.outPerDay, cur)} out per day), excluding scheduled items.`
                          : "Needs at least 14 days of recorded activity."}
                      </span>
                    </span>
                  </label>
                  <Field
                    label="Overdue invoices arrive in (days)"
                    htmlFor="od"
                    hint="Overdue receivables are never assumed to arrive today."
                  >
                    <Input
                      id="od"
                      type="number"
                      min={0}
                      max={120}
                      value={overdueDelay}
                      onChange={(e) => setOverdueDelay(Math.max(0, Math.min(120, Number(e.target.value) || 0)))}
                    />
                  </Field>
                  <Field
                    label="Extra delay on invoices (days)"
                    htmlFor="dl"
                    hint="Customers often pay after the due date."
                  >
                    <Input
                      id="dl"
                      type="number"
                      min={0}
                      max={120}
                      value={delay}
                      onChange={(e) => setDelay(Math.max(0, Math.min(120, Number(e.target.value) || 0)))}
                    />
                  </Field>
                </div>
              </Card>
            </div>
          </section>

          <section className="grid gap-5 lg:grid-cols-12">
            <Card className="p-5 sm:p-6 lg:col-span-8">
              <div className="flex items-center justify-between">
                <h2 className="display text-xl">Scheduled money movements</h2>
                <p className="text-[13px] text-ink3">
                  <span className="text-pos">+{formatMoney(f.totalIn, cur, { compact: true })}</span> in ·{" "}
                  <span>−{formatMoney(f.totalOut, cur, { compact: true })}</span> out
                </p>
              </div>
              {eventsByDate.length === 0 ? (
                <p className="mt-6 rounded-xl bg-sunken px-4 py-8 text-center text-sm text-ink3">
                  Nothing is scheduled in this window.{" "}
                  <Link href="/app/obligations" className="font-medium text-accent">
                    Add recurring bills or invoices
                  </Link>
                  .
                </p>
              ) : (
                <ul className="mt-4 divide-y divide-line">
                  {eventsByDate.map(([date, evs]) => (
                    <li key={date} className="grid gap-3 py-3.5 sm:grid-cols-[7.5rem_1fr]">
                      <p className="num text-sm font-medium text-ink2">
                        {new Date(date + "T00:00:00Z").toLocaleDateString("en", {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                          timeZone: "UTC",
                        })}
                      </p>
                      <ul className="space-y-2">
                        {evs.map((e, i) => (
                          <li key={i} className="flex items-center justify-between gap-3">
                            <span className="flex min-w-0 flex-1 items-start gap-2">
                              <Badge tone={KIND[e.kind]?.tone ?? "neutral"} className="mt-0.5 shrink-0">
                                {KIND[e.kind]?.label ?? e.kind}
                              </Badge>
                              <span className="min-w-0">
                                <span className="block truncate text-sm text-ink">{e.label}</span>
                                {e.assumed && <span className="block text-xs text-ink3">{e.assumed}</span>}
                              </span>
                            </span>
                            <Money
                              value={e.amount}
                              currency={cur}
                              sign
                              className={clsx("shrink-0 text-sm font-medium", e.amount > 0 ? "text-pos" : "text-ink")}
                              animate={false}
                            />
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="p-5 sm:p-6 lg:col-span-4">
              <h2 className="display text-xl">How this forecast is built</h2>
              <ul className="mt-3 space-y-2.5 text-[13px] leading-relaxed text-ink2">
                {f.assumptions.map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                    {a}
                  </li>
                ))}
                {f.suppressedDuplicates > 0 && (
                  <li className="flex gap-2">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                    {f.suppressedDuplicates} recurring payment{f.suppressedDuplicates > 1 ? "s were" : " was"} not
                    counted twice because an open bill from the same payee covers it.
                  </li>
                )}
              </ul>
              {data.overdue.length > 0 && (
                <div className="mt-5 border-t border-line pt-4">
                  <p className="text-sm font-medium text-ink">Overdue now</p>
                  <ul className="mt-2 space-y-1.5 text-[13px]">
                    {data.overdue.slice(0, 4).map((o) => (
                      <li key={o.id} className="flex justify-between gap-2">
                        <span className="truncate text-ink2">
                          {o.label}{" "}
                          <span className="text-ink3">
                            ({o.direction === "receivable" ? "owed to you" : "you owe"}, due {o.due_date})
                          </span>
                        </span>
                        <span className="num text-ink">{formatMoney(o.outstanding, cur, { compact: true })}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/app/obligations"
                    className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent"
                  >
                    Manage <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                </div>
              )}
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
