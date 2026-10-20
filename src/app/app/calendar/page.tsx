"use client";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Badge, Button, Card, clsx, DataLabel, ErrorNote, Hint, PageHeader, Skeleton } from "@/components/ui";
import { EntrySheet, type EntryTarget, type SimpleData } from "@/components/app/simple-home";
import { useUi } from "@/components/providers";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { formatMoney } from "@/lib/finance/money";

interface Ev {
  date: string;
  amount: number;
  label: string;
  kind: string;
  status: string;
  cashAfter: number | null;
  assumed?: string;
  outstanding?: number;
}
interface Data {
  currency: string;
  today: string;
  month: string;
  prev: string;
  next: string;
  startCash: number;
  reserve: number | null;
  events: Ev[];
  lowest: number;
  lowestDate: string;
  assumptions: string[];
}
const STATUS: Record<string, { tone: "pos" | "neg" | "warn" | "info" | "neutral"; label: string }> = {
  scheduled: { tone: "info", label: "Expected" },
  paid: { tone: "pos", label: "Paid" },
  partially_paid: { tone: "warn", label: "Partly paid" },
  pending: { tone: "neutral", label: "Pending" },
  overdue: { tone: "neg", label: "Overdue" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function CalendarPage() {
  const { biz } = useMe();
  const [month, setMonth] = useState<string | null>(null);
  const { data, error, isLoading, mutate } = useSWR<Data>(`/api/calendar${month ? `?month=${month}` : ""}`, {
    keepPreviousData: true,
  });
  const [sel, setSel] = useState<string | null>(null);
  // Tapping a day adds something on that day right here; the categories come from the simple view's data.
  const { data: simple } = useSWR<SimpleData>("/api/simple");
  const [entry, setEntry] = useState<EntryTarget | null>(null);
  const { toast } = useUi();
  const addOn = (d: string) => setEntry({ dir: "out", date: d, pickDir: true });
  const cur = data?.currency ?? biz?.currency.trim() ?? "EGP";

  const grid = useMemo(() => {
    if (!data) return [];
    const first = new Date(`${data.month}-01T00:00:00Z`);
    const offset = (first.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const cells: (string | null)[] = Array(offset).fill(null);
    for (let d = 1; d <= days; d++) cells.push(`${data.month}-${String(d).padStart(2, "0")}`);
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [data]);

  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (isLoading && !data) return <Skeleton className="h-96" />;
  if (!data) return null;
  const byDay = new Map<string, Ev[]>();
  for (const e of data.events) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const list = sel ? data.events.filter((e) => e.date === sel) : data.events;
  const title = new Date(`${data.month}-01T00:00:00Z`).toLocaleDateString("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Money calendar"
        subtitle="Every payment you expect to make or receive, and how much cash you should have after each one. Past items show their real status."
      />
      <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
        <Card className="p-4 sm:p-6">
          <div className="flex items-center justify-between">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => (setMonth(data.prev), setSel(null))}
              aria-label="Previous month"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <h2 className="display text-xl">{title}</h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => (setMonth(data.next), setSel(null))}
              aria-label="Next month"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
          <div className="mt-4 grid grid-cols-7 gap-1 text-center text-[11px] text-ink3">
            {WD.map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {grid.map((d, i) => {
              if (!d) return <div key={i} />;
              const evs = byDay.get(d) ?? [];
              const net = evs.reduce(
                (a, e) => a + (["scheduled", "paid", "partially_paid"].includes(e.status) ? e.amount : 0),
                0,
              );
              const after = evs.find((e) => e.cashAfter !== null)?.cashAfter ?? null;
              const below = after !== null && (after < 0 || (data.reserve !== null && after < data.reserve));
              return (
                <button
                  key={d}
                  onClick={() => {
                    setSel(d);
                    if (!byDay.get(d)?.length) addOn(d);
                  }}
                  aria-pressed={sel === d}
                  aria-label={`${d}${evs.length ? `, ${evs.length} item(s)` : ""}`}
                  className={clsx(
                    "relative flex min-h-16 flex-col rounded-xl border p-1.5 text-start transition sm:min-h-20",
                    sel === d ? "border-accent bg-accentsoft/50" : "border-line hover:border-line2",
                    d === data.today && "ring-2 ring-accent/40",
                    d < data.today && "opacity-70",
                  )}
                >
                  <span className="text-xs text-ink3">{Number(d.slice(8))}</span>
                  {evs.length > 0 && (
                    <motion.span
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className={clsx("mt-auto truncate text-[11px] font-medium", net < 0 ? "text-ink" : "text-pos")}
                    >
                      {formatMoney(net, cur, { compact: true, sign: true, hideCurrency: true })}
                    </motion.span>
                  )}
                  {below && (
                    <span
                      className="absolute end-1 top-1 size-2 rounded-full bg-neg"
                      title="Projected cash below your safety line"
                    />
                  )}
                  {sel === d && <Plus aria-hidden className="absolute bottom-1 end-1 size-3.5 text-accent" />}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-ink3">
            Tap a day to add a payment or money coming in on that day. A red dot marks a day where projected cash is
            below {data.reserve !== null ? "your safety reserve" : "zero"}.
          </p>
        </Card>

        <Card className="p-4 sm:p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <h2 className="display text-xl">{sel ? sel : "This month"}</h2>
              <Hint k="cash_flow" />
            </div>
            <DataLabel kind="projected" />
          </div>
          {sel && simple && (
            <Button className="mt-3 w-full" variant="primary" onClick={() => addOn(sel)}>
              <Plus className="size-4" aria-hidden /> Add something on this day
            </Button>
          )}
          <p className="mt-2 text-[13px] text-ink3">
            Cash today {formatMoney(data.startCash, cur)} · lowest ahead {formatMoney(data.lowest, cur)} on{" "}
            {data.lowestDate}
            {data.reserve !== null ? ` · reserve ${formatMoney(data.reserve, cur)}` : ""}
          </p>
          {list.length === 0 ? (
            <p className="mt-6 rounded-xl bg-sunken px-4 py-8 text-center text-sm text-ink3">
              Nothing scheduled.{" "}
              <Link href="/app/fixed" className="font-medium text-accent">
                Add bills, salaries or fixed costs
              </Link>
              .
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-line">
              {list.map((e, i) => {
                const st = STATUS[e.status] ?? STATUS.scheduled;
                return (
                  <li key={i} className="flex items-center gap-3 py-3">
                    <div className="w-11 shrink-0 text-center">
                      <p className="eyebrow">
                        {new Date(e.date + "T00:00:00Z").toLocaleDateString("en", { month: "short", timeZone: "UTC" })}
                      </p>
                      <p className="fig text-lg leading-none">{e.date.slice(8)}</p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p
                        className={clsx(
                          "truncate text-sm font-medium",
                          e.status === "cancelled" ? "text-ink3 line-through" : "text-ink",
                        )}
                      >
                        {e.label}
                      </p>
                      <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink3">
                        <Badge tone={st.tone}>{st.label}</Badge>
                        {e.assumed ?? ""}
                        {e.status === "partially_paid" && e.outstanding !== undefined
                          ? `${formatMoney(Math.abs(e.amount), cur)} paid · ${formatMoney(e.outstanding, cur)} still open`
                          : ""}
                      </p>
                    </div>
                    <div className="text-end">
                      <p className={clsx("num text-sm font-medium", e.amount > 0 ? "text-pos" : "text-ink")}>
                        {formatMoney(e.amount, cur, { sign: true })}
                      </p>
                      {e.cashAfter !== null && (
                        <p
                          className={clsx(
                            "num text-xs",
                            e.cashAfter < 0 || (data.reserve !== null && e.cashAfter < data.reserve)
                              ? "text-neg"
                              : "text-ink3",
                          )}
                        >
                          cash after: {formatMoney(e.cashAfter, cur, { compact: true })}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {sel && (
            <button onClick={() => setSel(null)} className="mt-3 text-[13px] font-medium text-accent">
              Show the whole month
            </button>
          )}
          <p className="mt-3 text-xs text-ink3">
            {data.assumptions.join(" ")} A payment you record is removed from the forecast, so it is never counted
            twice.
          </p>
        </Card>
      </div>
      {simple && (
        <EntrySheet
          target={entry}
          onClose={() => setEntry(null)}
          d={simple}
          onSaved={(msg) => {
            toast({ title: msg });
            mutate();
            refreshAll();
          }}
        />
      )}
    </div>
  );
}
