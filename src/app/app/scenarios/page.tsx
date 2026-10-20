"use client";
import { AlertTriangle, FlaskConical, Plus, Save, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { AreaLine } from "@/components/charts";
import { useUi } from "@/components/providers";
import {
  Badge,
  Button,
  Card,
  clsx,
  DataLabel,
  ErrorNote,
  Field,
  Hint,
  IconButton,
  Input,
  Money,
  MoneyInput,
  PageHeader,
  Skeleton,
} from "@/components/ui";
import { api } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

type Adj = { _id: string; type: string; [k: string]: any };
interface Metrics {
  monthlyRevenue: number;
  monthlyProfit: number;
  endCash: number;
  minCash: number;
  minCashDate: string;
  firstShortfallDate: string | null;
  cashAfterReserve: number;
}
interface Result {
  result: {
    horizonDays: number;
    hasHistory: boolean;
    baseline: Metrics;
    scenario: Metrics;
    baselineSeries: { date: string; balance: number }[];
    scenarioSeries: { date: string; balance: number }[];
    budgets: { id: string; name: string; plannedMonthly: number; baselineMonthly: number; scenarioMonthly: number }[];
    reserved: number;
    oneTimeCosts: number;
    assumptions: string[];
    warnings: string[];
  };
  currency: string;
  today: string;
}

const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 9);

type Field = {
  key: string;
  label: string;
  kind: "money" | "pct" | "date" | "days" | "ratio";
  hint?: string;
  def: () => any;
};
const SPECS: Record<string, { label: string; blurb: string; fields: Field[] }> = {
  ad_spend: {
    label: "Change ad spend",
    blurb: "Raise or cut advertising by a percentage.",
    fields: [
      { key: "pct", label: "Change in ad spend (%)", kind: "pct", def: () => 30 },
      {
        key: "assumedRoas",
        label: "Revenue expected per 1 of extra spend (optional)",
        kind: "ratio",
        hint: "Leave empty to assume no extra revenue.",
        def: () => undefined,
      },
    ],
  },
  inventory: {
    label: "Buy an inventory batch",
    blurb: "A one-off purchase and (optionally) the sales it brings.",
    fields: [
      { key: "amount", label: "Order cost", kind: "money", def: () => null },
      { key: "date", label: "Pay on", kind: "date", def: () => addDays(7) },
      { key: "expectedRevenue", label: "Sales you expect from it (optional)", kind: "money", def: () => undefined },
      { key: "sellDays", label: "…over how many days", kind: "days", def: () => 60 },
    ],
  },
  hire: {
    label: "Hire someone",
    blurb: "A new monthly cost starting on a date.",
    fields: [
      { key: "monthlyCost", label: "Monthly cost", kind: "money", def: () => null },
      { key: "startDate", label: "Starts on", kind: "date", def: () => addDays(14) },
      { key: "oneTime", label: "One-time cost (optional)", kind: "money", def: () => undefined },
    ],
  },
  price: {
    label: "Change prices",
    blurb: "Raise or cut prices and say how volume might react.",
    fields: [
      { key: "pct", label: "Price change (%)", kind: "pct", def: () => -10 },
      {
        key: "volumePct",
        label: "Resulting change in units sold (%)",
        kind: "pct",
        hint: "Your assumption — Socio does not guess elasticity.",
        def: () => 0,
      },
    ],
  },
  sales_drop: {
    label: "Sales drop",
    blurb: "What if revenue falls?",
    fields: [{ key: "pct", label: "Drop in sales (%)", kind: "pct", def: () => 20 }],
  },
  late_payment: {
    label: "A customer pays late",
    blurb: "Delay your largest open invoice.",
    fields: [{ key: "delayDays", label: "Days late", kind: "days", def: () => 30 }],
  },
  shipping: {
    label: "Shipping costs change",
    blurb: "Courier rates move.",
    fields: [{ key: "pct", label: "Change in shipping cost (%)", kind: "pct", def: () => 15 }],
  },
  supplier_cost: {
    label: "Supplier raises prices",
    blurb: "Your product costs go up or down.",
    fields: [{ key: "pct", label: "Change in product cost (%)", kind: "pct", def: () => 10 }],
  },
  new_product: {
    label: "Launch a product",
    blurb: "Launch cost, expected sales and margin.",
    fields: [
      { key: "launchCost", label: "Launch cost", kind: "money", def: () => null },
      { key: "monthlyRevenue", label: "Expected monthly revenue", kind: "money", def: () => null },
      { key: "marginPct", label: "Gross margin (%)", kind: "pct", def: () => 50 },
      { key: "startDate", label: "Launch date", kind: "date", def: () => addDays(21) },
    ],
  },
};

function usable(a: Adj): boolean {
  const spec = SPECS[a.type];
  return spec.fields.every(
    (f) =>
      f.key === "assumedRoas" ||
      f.key === "oneTime" ||
      f.key === "expectedRevenue" ||
      f.key === "sellDays" ||
      (a[f.key] !== null && a[f.key] !== undefined && a[f.key] !== ""),
  );
}

export default function ScenariosPage() {
  const { biz } = useMe();
  const { toast } = useUi();
  const cur = biz?.currency.trim() ?? "EGP";
  const digits = currencyDigits(cur);
  const [adjs, setAdjs] = useState<Adj[]>([]);
  const [horizon, setHorizon] = useState(90);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const saved = useSWR<{ items: { id: string; name: string; params: any[]; result: any; created_at: string }[] }>(
    "/api/scenarios",
  );
  const ready = adjs.length > 0 && adjs.every(usable);
  const seq = useRef(0);

  const payload = useMemo(
    () =>
      adjs.map(({ _id, ...a }) =>
        Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== null && v !== "")),
      ),
    [adjs],
  );

  useEffect(() => {
    if (!ready) {
      setRes(null);
      return;
    }
    const my = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.post<Result>("/api/scenarios/simulate", { adjustments: payload, horizon });
        if (my === seq.current) setRes(r), setError(null);
      } catch (e) {
        if (my === seq.current) setError(e);
      } finally {
        if (my === seq.current) setBusy(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [payload, ready, horizon]);

  const add = (type: string) =>
    setAdjs((a) => [
      ...a,
      { _id: uid(), type, ...Object.fromEntries(SPECS[type].fields.map((f) => [f.key, f.def()])) },
    ]);
  const upd = (id: string, k: string, v: any) => setAdjs((a) => a.map((x) => (x._id === id ? { ...x, [k]: v } : x)));

  const r = res?.result;
  const dEnd = r ? r.scenario.endCash - r.baseline.endCash : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="What-if"
        subtitle="Test a decision before you make it. Your real records are never touched — a simulation only changes a copy of the numbers."
      />

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-5">
          <Card className="p-5">
            <p className="text-sm font-semibold text-ink">1. Choose what you are considering</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.entries(SPECS).map(([k, s]) => (
                <button
                  key={k}
                  onClick={() => add(k)}
                  title={s.blurb}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-raised px-3.5 text-[13px] font-medium text-ink2 transition hover:border-accent hover:text-accent active:scale-95"
                >
                  <Plus className="size-3.5" aria-hidden /> {s.label}
                </button>
              ))}
            </div>
          </Card>

          <AnimatePresence initial={false}>
            {adjs.map((a) => {
              const spec = SPECS[a.type];
              return (
                <motion.div
                  key={a._id}
                  layout
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                >
                  <Card className="p-5">
                    <div className="mb-4 flex items-center justify-between">
                      <p className="flex items-center gap-2 font-semibold text-ink">
                        <FlaskConical className="size-4 text-accent" aria-hidden /> {spec.label}
                      </p>
                      <IconButton label="Remove" onClick={() => setAdjs((x) => x.filter((y) => y._id !== a._id))}>
                        <X className="size-4" />
                      </IconButton>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {spec.fields.map((f) => (
                        <Field
                          key={f.key}
                          label={f.label}
                          hint={f.hint}
                          htmlFor={`${a._id}-${f.key}`}
                          className={f.kind === "money" || f.key === "assumedRoas" ? "sm:col-span-2" : ""}
                        >
                          {f.kind === "money" ? (
                            <MoneyInput
                              id={`${a._id}-${f.key}`}
                              value={a[f.key] ?? null}
                              onChange={(v) => upd(a._id, f.key, v ?? undefined)}
                              currency={cur}
                              digits={digits}
                            />
                          ) : f.kind === "date" ? (
                            <Input
                              id={`${a._id}-${f.key}`}
                              type="date"
                              value={a[f.key] ?? ""}
                              onChange={(e) => upd(a._id, f.key, e.target.value)}
                            />
                          ) : (
                            <Input
                              id={`${a._id}-${f.key}`}
                              type="number"
                              step={f.kind === "ratio" ? 0.1 : 1}
                              value={a[f.key] ?? ""}
                              onChange={(e) =>
                                upd(a._id, f.key, e.target.value === "" ? undefined : Number(e.target.value))
                              }
                            />
                          )}
                        </Field>
                      ))}
                    </div>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
          {adjs.length === 0 && (
            <p className="rounded-2xl border border-dashed border-line2 px-5 py-8 text-center text-sm text-ink3">
              Pick a decision above to start. You can combine several.
            </p>
          )}

          {ready && (
            <Card className="p-5">
              <p className="text-sm font-semibold text-ink">Keep this scenario</p>
              <div className="mt-3 flex gap-2">
                <Input
                  aria-label="Scenario name"
                  placeholder="e.g. Hire a designer in November"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Button
                  disabled={!name.trim()}
                  onClick={async () => {
                    await api.post("/api/scenarios", { name: name.trim(), adjustments: payload });
                    setName("");
                    saved.mutate();
                    toast({ title: "Scenario saved", description: "Saved scenarios never change your records." });
                  }}
                >
                  <Save className="size-4" aria-hidden /> Save
                </Button>
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-4 lg:col-span-7">
          {error != null && <ErrorNote error={error} />}
          {!ready ? (
            <Card className="grid min-h-[22rem] place-items-center p-8 text-center">
              <div>
                <FlaskConical className="mx-auto size-10 text-accent" aria-hidden />
                <h2 className="display mt-3 text-2xl">See the effect before you commit</h2>
                <p className="mx-auto mt-2 max-w-sm text-sm text-ink2">
                  Add a decision on the left and fill in the numbers. The comparison appears here instantly, with every
                  assumption listed.
                </p>
              </div>
            </Card>
          ) : !r ? (
            <Skeleton className="h-[30rem]" />
          ) : (
            <>
              <Card className={clsx("overflow-hidden transition-opacity", busy && "opacity-70")}>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
                  <div className="flex items-center gap-2">
                    <DataLabel kind="projected" />
                    <span className="text-[13px] text-ink3">Next {r.horizonDays} days</span>
                  </div>
                  <div className="flex gap-1">
                    {[60, 90, 180].map((h) => (
                      <button
                        key={h}
                        onClick={() => setHorizon(h)}
                        aria-pressed={horizon === h}
                        className={clsx(
                          "rounded-lg px-2.5 py-1 text-xs font-medium",
                          horizon === h ? "bg-accent text-accentink" : "text-ink3 hover:bg-sunken",
                        )}
                      >
                        {h}d
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                  <Compare
                    label="Cash at the end"
                    base={r.baseline.endCash}
                    sim={r.scenario.endCash}
                    cur={cur}
                    k="cash_balance"
                  />
                  <Compare
                    label="Estimated monthly profit"
                    base={r.baseline.monthlyProfit}
                    sim={r.scenario.monthlyProfit}
                    cur={cur}
                    k="profit"
                    estimated
                  />
                  <Compare
                    label="Lowest cash"
                    base={r.baseline.minCash}
                    sim={r.scenario.minCash}
                    cur={cur}
                    k="cash_flow"
                    bordered
                  />
                  <Compare
                    label="Estimated monthly revenue"
                    base={r.baseline.monthlyRevenue}
                    sim={r.scenario.monthlyRevenue}
                    cur={cur}
                    k="revenue"
                    estimated
                    bordered
                  />
                </div>
                <div className="border-t border-line p-5">
                  <div className="mb-2 flex items-center gap-4 text-xs text-ink3">
                    <span className="flex items-center gap-1.5">
                      <span className="h-0.5 w-5 rounded bg-accent" /> Baseline
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-0.5 w-5 rounded border-t-2 border-dashed border-signal" /> With this decision
                    </span>
                  </div>
                  <AreaLine
                    series={r.baselineSeries.map((p) => ({ date: p.date, value: p.balance }))}
                    compare={r.scenarioSeries.map((p) => ({ date: p.date, value: p.balance }))}
                    currency={cur}
                    height={270}
                    label="Cash balance: baseline versus scenario"
                    seriesLabel="Baseline"
                    compareLabel="With decision"
                  />
                </div>
              </Card>

              <Card className="p-5">
                <p className="text-sm font-semibold text-ink">What it means</p>
                <ul className="mt-3 space-y-2 text-[15px] leading-relaxed text-ink2">
                  <li>
                    After {r.horizonDays} days your cash would be{" "}
                    <strong className="text-ink">{formatMoney(r.scenario.endCash, cur)}</strong>,{" "}
                    {dEnd === 0
                      ? "the same as"
                      : dEnd < 0
                        ? `${formatMoney(-dEnd, cur)} lower than`
                        : `${formatMoney(dEnd, cur)} higher than`}{" "}
                    the baseline.
                  </li>
                  <li>
                    {r.scenario.firstShortfallDate ? (
                      <span className="text-neg">
                        Cash would run short around <strong>{r.scenario.firstShortfallDate}</strong>
                        {r.baseline.firstShortfallDate ? " (the baseline already does)" : " — the baseline does not"}.
                      </span>
                    ) : (
                      <>
                        Cash stays above zero throughout; the tightest point is {formatMoney(r.scenario.minCash, cur)}{" "}
                        on {r.scenario.minCashDate}.
                      </>
                    )}
                  </li>
                  {r.reserved > 0 && (
                    <li>
                      Your reserve is {formatMoney(r.reserved, cur)}. Cash after reserve at the end:{" "}
                      <strong className={r.scenario.cashAfterReserve < 0 ? "text-neg" : "text-ink"}>
                        {formatMoney(r.scenario.cashAfterReserve, cur)}
                      </strong>
                      .
                    </li>
                  )}
                  {r.oneTimeCosts > 0 && <li>One-time costs in this scenario: {formatMoney(r.oneTimeCosts, cur)}.</li>}
                </ul>
                {r.budgets.length > 0 && (
                  <div className="mt-4 border-t border-line pt-4">
                    <p className="text-sm font-medium text-ink">Budgets affected (per month)</p>
                    <ul className="mt-2 space-y-2">
                      {r.budgets.map((b) => (
                        <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="text-ink2">{b.name}</span>
                          <span className="num">
                            {formatMoney(b.baselineMonthly, cur, { compact: true })} →{" "}
                            <strong className={b.scenarioMonthly > b.plannedMonthly ? "text-neg" : "text-ink"}>
                              {formatMoney(b.scenarioMonthly, cur, { compact: true })}
                            </strong>{" "}
                            <span className="text-ink3">
                              of {formatMoney(b.plannedMonthly, cur, { compact: true })}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.warnings.map((w, i) => (
                  <p
                    key={i}
                    className="mt-3 flex items-start gap-2 rounded-xl bg-warnsoft px-3.5 py-2.5 text-[13px] text-ink"
                  >
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden /> {w}
                  </p>
                ))}
                <div className="mt-4 border-t border-line pt-4">
                  <p className="text-sm font-medium text-ink">Assumptions &amp; limits</p>
                  <ul className="mt-2 space-y-1.5 text-[13px] text-ink2">
                    {r.assumptions.map((a, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ink3" aria-hidden />
                        {a}
                      </li>
                    ))}
                    <li className="flex gap-2">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ink3" aria-hidden />
                      This is a projection built from your numbers and the inputs above. It is not a prediction or a
                      guarantee.
                    </li>
                  </ul>
                </div>
              </Card>
            </>
          )}

          {(saved.data?.items ?? []).length > 0 && (
            <Card className="p-5">
              <p className="text-sm font-semibold text-ink">Saved scenarios</p>
              <ul className="mt-3 divide-y divide-line">
                {saved.data!.items.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                    <button
                      className="min-w-0 text-start"
                      onClick={() => setAdjs((s.params as any[]).map((p) => ({ ...p, _id: uid() })))}
                    >
                      <span className="block truncate text-sm font-medium text-ink">{s.name}</span>
                      <span className="text-xs text-ink3">
                        {(s.params as any[]).map((p) => SPECS[p.type]?.label ?? p.type).join(" + ")} · saved{" "}
                        {new Date(s.created_at).toLocaleDateString()}
                      </span>
                    </button>
                    <span className="flex items-center gap-2">
                      <Badge>Open</Badge>
                      <IconButton
                        label="Delete scenario"
                        onClick={async () => {
                          await api.del(`/api/scenarios/${s.id}`);
                          saved.mutate();
                          refreshAll();
                        }}
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Compare({
  label,
  base,
  sim,
  cur,
  k,
  estimated,
  bordered,
}: {
  label: string;
  base: number;
  sim: number;
  cur: string;
  k: string;
  estimated?: boolean;
  bordered?: boolean;
}) {
  const d = sim - base;
  return (
    <div className={clsx("p-5", bordered && "sm:border-t sm:border-line")}>
      <div className="flex items-center gap-1">
        <span className="eyebrow">{label}</span>
        <Hint k={k} />
        {estimated && <span className="ms-1 text-[10px] uppercase tracking-wider text-warn">est.</span>}
      </div>
      <p className={clsx("fig mt-1 text-3xl", sim < 0 && "text-neg")}>
        <Money value={sim} currency={cur} />
      </p>
      <p className="mt-1 text-xs text-ink3">
        baseline {formatMoney(base, cur, { compact: true })}
        {d !== 0 && (
          <span className={clsx("ms-2 font-medium", d > 0 ? "text-pos" : "text-neg")}>
            {d > 0 ? "▲" : "▼"} {formatMoney(Math.abs(d), cur, { compact: true })}
          </span>
        )}
      </p>
    </div>
  );
}
