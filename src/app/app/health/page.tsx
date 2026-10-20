"use client";
import { AlertTriangle, ArrowRight, Check, ChevronDown, ExternalLink, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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
  Input,
  Modal,
  Money,
  MoneyInput,
  PageHeader,
  Segmented,
  Select,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

interface Health {
  currency: string;
  today: string;
  month: string;
  hasData: boolean;
  score: number;
  verdict: { tone: "good" | "watch" | "act" | "start"; headline: string };
  readiness: {
    key: string;
    label: string;
    ok: boolean;
    weight: number;
    detail: string;
    fixHref: string;
    glossary?: string;
  }[];
  valuation: {
    low: number;
    mid: number;
    high: number;
    confidence: "low" | "medium" | "good";
    windowMonths: number;
    annualRevenue: number;
    annualProfit: number;
    netAssets: number;
    cautions: string[];
    methods: { key: string; label: string; low: number; high: number; applies: boolean; note: string }[];
    history: { period: string; low: number; mid: number; high: number }[];
    editable: { earningsLow: number; earningsHigh: number; revenueLow: number; revenueHigh: number };
  };
  statements: {
    current: St;
    previous: St;
    position: {
      cash: number;
      receivables: number;
      inventory: number;
      fixed: number;
      payables: number;
      total: number;
      equity: number;
    };
  };
  outlook: {
    cash: number;
    days: number;
    endCash: number;
    minCash: number;
    minCashDate: string;
    firstShortfallDate: string | null;
    points: { date: string; balance: number }[];
    nextMonthProfit: number | null;
    basisDays: number;
    assumptions: string[];
    runway: { months: number | null; monthlyBurn: number | null };
  };
  priorities: { title: string; why: string; href: string }[];
  compliance: {
    supported: boolean;
    country: string;
    reviewedOn: string;
    vatRegistered: boolean | null;
    reasons: Record<string, string>;
  };
  todos: Todo[];
  assets: {
    id: string;
    name: string;
    cost: number;
    purchase_date: string;
    useful_life_months: number;
    monthlyDepreciation: number;
    bookValue: number;
    accumulated: number;
    fair_value: number | null;
    fullyDepreciated: boolean;
  }[];
  requiredDone: number;
  requiredTotal: number;
}
interface St {
  month: string;
  from: string;
  to: string;
  depreciation: number;
  profitAfterDepreciation: number;
  openingCash: number;
  closingCash: number;
  summary: {
    revenue: number;
    refunds: number;
    cogs: number;
    grossProfit: number;
    opex: number;
    netProfit: number;
    margin: number | null;
    incomplete: boolean;
    cashIn: number;
    cashOut: number;
    netCash: number;
  };
}
interface Todo {
  id: string;
  source: string;
  catalog_key: string | null;
  title: string;
  detail: string | null;
  due_date: string | null;
  status: "todo" | "done" | "skipped";
  actual_cost: number | null;
  notes: string | null;
  kind: string;
  reason: string | null;
  req: {
    authority: string;
    titleAr: string;
    why: string;
    steps: string[];
    documents: string[];
    feeNote: string;
    source: { label: string; url: string };
    confidence: string;
    caveat: string | null;
    planningDefault: boolean;
  } | null;
}

const TONE = {
  good: { ring: "var(--pos)", bg: "bg-possoft", label: "In good shape" },
  watch: { ring: "var(--warn)", bg: "bg-warnsoft", label: "Needs a look" },
  act: { ring: "var(--neg)", bg: "bg-negsoft", label: "Act now" },
  start: { ring: "var(--ink-3)", bg: "bg-sunken", label: "Getting started" },
};
const KIND: Record<string, { label: string; tone: "neg" | "warn" | "info" | "accent" | "neutral" }> = {
  required: { label: "Required", tone: "neg" },
  check: { label: "Check", tone: "warn" },
  recommended: { label: "Recommended", tone: "info" },
  internal: { label: "Your routine", tone: "accent" },
  manual: { label: "Yours", tone: "neutral" },
};

function ScoreRing({ score, color }: { score: number; color: string }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative size-36 shrink-0">
      <svg viewBox="0 0 128 128" className="size-full -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" stroke="var(--line)" strokeWidth="10" />
        <motion.circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - score / 100) }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <p className="fig text-4xl leading-none">{score}</p>
          <p className="eyebrow mt-1">readiness</p>
        </div>
      </div>
    </div>
  );
}

export default function HealthPage() {
  const { biz } = useMe();
  const { toast } = useUi();
  const { data, error, isLoading, mutate } = useSWR<Health>("/api/company-health", { keepPreviousData: true });
  const [tab, setTab] = useState<"income" | "cash" | "position">("income");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [asset, setAsset] = useState(false);
  const [tuning, setTuning] = useState(false);
  const cur = data?.currency ?? biz?.currency.trim() ?? "EGP";
  const canWrite = biz && biz.role !== "viewer";

  useEffect(() => {
    if (data && window.location.hash === "#todo")
      document.getElementById("todo")?.scrollIntoView({ behavior: "smooth" });
  }, [data]);

  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (isLoading && !data) return <Skeleton className="h-[40rem]" />;
  if (!data) return null;
  const d = data;
  const t = TONE[d.verdict.tone];
  const v = d.valuation;
  const open_ = d.todos.filter((x) => x.status === "todo");
  const done_ = d.todos.filter((x) => x.status !== "todo");
  const rangeMax = Math.max(v.high, v.mid, 1);

  const setVat = async (val: boolean) => {
    await api.patch("/api/business", { settings: { vatRegistered: val } });
    await refreshAll();
    mutate();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Company health"
        subtitle="Once a month, in five minutes: where you stand, what the business might be worth, what paperwork is due, and what to do next."
      />

      {/* Verdict */}
      <Card className="overflow-hidden">
        <div className={clsx("flex flex-wrap items-center gap-6 p-6 sm:p-8", t.bg)}>
          <ScoreRing score={d.score} color={t.ring} />
          <div className="min-w-0 flex-1">
            <Badge
              tone={
                d.verdict.tone === "good"
                  ? "pos"
                  : d.verdict.tone === "act"
                    ? "neg"
                    : d.verdict.tone === "watch"
                      ? "warn"
                      : "neutral"
              }
            >
              {t.label}
            </Badge>
            <h2 className="display mt-2 text-[1.9rem] leading-tight sm:text-4xl">{d.verdict.headline}</h2>
            <p className="mt-2 text-sm text-ink2">
              Readiness is how prepared your numbers and paperwork are for a bank, a buyer or an investor asking
              questions. It is not a credit score.
            </p>
          </div>
        </div>
        {d.priorities.length > 0 && (
          <ol className="grid divide-y divide-line border-t border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {d.priorities.map((p, i) => (
              <li key={p.title}>
                <Link href={p.href} className="group flex h-full gap-3 p-5 transition hover:bg-sunken">
                  <span className="fig text-3xl text-accent">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold leading-snug text-ink">{p.title}</span>
                    <span className="mt-1 block text-[13px] text-ink2">{p.why}</span>
                    <span className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-accent">
                      Open <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* Valuation */}
      <Card className="p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1">
              <span className="eyebrow">What the business might be worth</span>
              <Hint k="valuation" />
            </div>
            <p className="mt-0.5 text-[13px] text-ink3">
              “If someone wanted to buy it today, roughly what range would they talk about?”
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DataLabel kind="estimated" />
            <Badge tone={v.confidence === "good" ? "pos" : v.confidence === "medium" ? "warn" : "neutral"}>
              {v.confidence} confidence
            </Badge>
          </div>
        </div>
        {v.high === 0 ? (
          <p className="mt-6 rounded-xl bg-sunken px-4 py-8 text-center text-sm text-ink2">
            Not enough information yet. Record sales and costs for a few weeks and a range will appear.
          </p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-baseline gap-x-3">
              <Money value={v.low} currency={cur} compact className="fig text-4xl sm:text-5xl" />
              <span className="fig text-3xl text-ink3">–</span>
              <Money value={v.high} currency={cur} compact className="fig text-4xl sm:text-5xl" />
            </div>
            <div className="relative mt-5 h-3 rounded-full bg-sunken" aria-hidden>
              <motion.div
                className="absolute inset-y-0 rounded-full bg-accent/70"
                initial={{ left: 0, width: 0 }}
                animate={{ left: `${(v.low / rangeMax) * 100}%`, width: `${((v.high - v.low) / rangeMax) * 100}%` }}
                transition={{ type: "spring", stiffness: 90, damping: 20 }}
              />
              <motion.div
                className="absolute -top-1.5 h-6 w-1 rounded bg-ink"
                initial={{ left: 0 }}
                animate={{ left: `${(v.mid / rangeMax) * 100}%` }}
                transition={{ type: "spring", stiffness: 90, damping: 20 }}
              />
            </div>
            <p className="mt-2 text-xs text-ink3">
              Middle of the range: {formatMoney(v.mid, cur)} · based on {v.windowMonths} month(s) of records
            </p>
            <ul className="mt-5 grid gap-3 sm:grid-cols-3">
              {v.methods.map((m) => (
                <li key={m.key} className={clsx("rounded-2xl border border-line p-4", !m.applies && "opacity-50")}>
                  <p className="text-sm font-semibold text-ink">{m.label}</p>
                  <p className="fig mt-1 text-xl">
                    {m.applies
                      ? m.low === m.high
                        ? formatMoney(m.low, cur, { compact: true })
                        : `${formatMoney(m.low, cur, { compact: true })} – ${formatMoney(m.high, cur, { compact: true })}`
                      : "n/a"}
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink3">{m.note}</p>
                </li>
              ))}
            </ul>
            {v.history.length > 1 && (
              <div className="mt-6">
                <p className="text-sm font-medium text-ink">Month by month</p>
                <AreaLine
                  series={v.history.map((h) => ({ date: `${h.period}-01`, value: h.mid }))}
                  currency={cur}
                  height={170}
                  label="Estimated value, monthly midpoint"
                />
              </div>
            )}
          </>
        )}
        {v.cautions.map((c) => (
          <p key={c} className="mt-3 flex items-start gap-2 rounded-xl bg-warnsoft px-3.5 py-2.5 text-[13px] text-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
            {c}
          </p>
        ))}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink3">
          <p>This is a rough, heuristic range for planning — not a formal valuation or an offer.</p>
          <button className="font-medium text-accent underline underline-offset-2" onClick={() => setTuning(true)}>
            Change the multiples
          </button>
        </div>
      </Card>

      {/* Statements */}
      <Card className="p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <h2 className="display text-xl">This month in three statements</h2>
            <Hint k="financial_statements" />
          </div>
          <Segmented
            label="Statement"
            value={tab}
            onChange={setTab}
            options={[
              { value: "income", label: "Earned" },
              { value: "cash", label: "Cash" },
              { value: "position", label: "Own & owe" },
            ]}
          />
        </div>
        <div className="mt-5">
          {tab === "income" && <Income cur={cur} s={d.statements.current} p={d.statements.previous} />}
          {tab === "cash" && <CashSt cur={cur} s={d.statements.current} />}
          {tab === "position" && (
            <Position
              cur={cur}
              pos={d.statements.position}
              assets={d.assets}
              onAdd={() => setAsset(true)}
              canWrite={!!canWrite}
              onChange={() => {
                refreshAll();
                mutate();
              }}
            />
          )}
        </div>
      </Card>

      {/* Outlook */}
      <Card className="p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <h2 className="display text-xl">Outlook, next {d.outlook.days} days</h2>
            <Hint k="forecast" />
          </div>
          <DataLabel kind="projected" />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Fig label="Cash today" value={d.outlook.cash} cur={cur} />
          <Fig
            label="Lowest point"
            value={d.outlook.minCash}
            cur={cur}
            sub={d.outlook.minCashDate}
            neg={d.outlook.minCash < 0}
          />
          <Fig
            label="Expected monthly profit"
            value={d.outlook.nextMonthProfit}
            cur={cur}
            sub={
              d.outlook.nextMonthProfit === null
                ? "needs 14+ days of records"
                : `average of the last ${d.outlook.basisDays} days`
            }
          />
        </div>
        <div className="mt-4">
          <AreaLine
            series={d.outlook.points.map((p) => ({ date: p.date, value: p.balance }))}
            currency={cur}
            height={200}
            label="Projected cash for the next 90 days"
            projectedFrom={d.today}
          />
        </div>
        <p className="mt-2 text-xs text-ink3">{d.outlook.assumptions.join(" ")}</p>
      </Card>

      {/* Readiness */}
      <Card className="p-5 sm:p-7">
        <div className="flex items-center gap-1">
          <h2 className="display text-xl">Ready for questions?</h2>
          <Hint k="due_diligence" />
        </div>
        <p className="mt-1 text-sm text-ink2">
          The checks a bank, buyer or investor would run first. Each one links to the fix.
        </p>
        <ul className="mt-4 divide-y divide-line">
          {d.readiness.map((r) => (
            <li key={r.key} className="flex items-start gap-3 py-3">
              <span
                className={clsx(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                  r.ok ? "bg-pos text-white" : "bg-line text-ink3",
                )}
              >
                {r.ok ? <Check className="size-3.5" /> : <span className="size-1.5 rounded-full bg-ink3" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 text-sm font-medium text-ink">
                  {r.label}
                  {r.glossary && <Hint k={r.glossary} />}
                </p>
                <p className="text-[13px] text-ink3">{r.detail}</p>
              </div>
              {!r.ok && (
                <Link href={r.fixHref} className="shrink-0 text-[13px] font-medium text-accent">
                  Fix
                </Link>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {/* To-do */}
      <section id="todo" className="scroll-mt-24">
        <Card className="p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="display flex items-center gap-2 text-xl">
                <ShieldCheck className="size-5 text-accent" aria-hidden /> This month&rsquo;s to-do
              </h2>
              <p className="mt-1 text-sm text-ink2">
                Paperwork and routines for a business like yours.{" "}
                {d.requiredTotal > 0 && (
                  <>
                    Required items done:{" "}
                    <strong>
                      {d.requiredDone} of {d.requiredTotal}
                    </strong>
                    .
                  </>
                )}
              </p>
            </div>
            <Button variant="secondary" disabled={!canWrite} onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> Add my own
            </Button>
          </div>

          {!d.compliance.supported ? (
            <p className="mt-5 rounded-xl bg-sunken px-4 py-5 text-sm text-ink2">
              Legal checklists are available for Egypt for now. Your country ({d.compliance.country}) is not covered
              yet, so only your own routines appear here. Socio will not guess rules it has not checked.
            </p>
          ) : (
            <div className="mt-4 rounded-xl border border-line bg-sunken/60 p-4 text-sm">
              <p className="font-medium text-ink">Are you registered for VAT?</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={d.compliance.vatRegistered === true ? "primary" : "secondary"}
                  disabled={!canWrite}
                  onClick={() => setVat(true)}
                >
                  Yes
                </Button>
                <Button
                  size="sm"
                  variant={d.compliance.vatRegistered === false ? "primary" : "secondary"}
                  disabled={!canWrite}
                  onClick={() => setVat(false)}
                >
                  No
                </Button>
              </div>
              <p className="mt-2 text-xs text-ink3">
                Used to decide whether monthly VAT items apply. Guide last reviewed {d.compliance.reviewedOn}; always
                confirm with the authority or your accountant.
              </p>
            </div>
          )}

          <ul className="mt-5 space-y-2.5">
            {open_.length === 0 && (
              <li className="rounded-xl bg-possoft px-4 py-6 text-center text-sm text-pos">
                Everything for this month is done. Nice.
              </li>
            )}
            {open_.map((t) => (
              <TodoRow
                key={t.id}
                t={t}
                cur={cur}
                isOpen={open === t.id}
                onToggle={() => setOpen(open === t.id ? null : t.id)}
                canWrite={!!canWrite}
                onChanged={() => {
                  refreshAll();
                  mutate();
                }}
              />
            ))}
          </ul>
          {done_.length > 0 && (
            <details className="mt-5">
              <summary className="cursor-pointer text-sm font-medium text-ink2">Done recently ({done_.length})</summary>
              <ul className="mt-2 space-y-2">
                {done_.map((t) => (
                  <TodoRow
                    key={t.id}
                    t={t}
                    cur={cur}
                    isOpen={open === t.id}
                    onToggle={() => setOpen(open === t.id ? null : t.id)}
                    canWrite={!!canWrite}
                    onChanged={() => {
                      refreshAll();
                      mutate();
                    }}
                  />
                ))}
              </ul>
            </details>
          )}
        </Card>
      </section>

      <AddTodo
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={() => {
          refreshAll();
          mutate();
        }}
      />
      <AddAsset
        open={asset}
        onClose={() => setAsset(false)}
        cur={cur}
        onSaved={() => {
          refreshAll();
          mutate();
        }}
      />
      <Tune
        open={tuning}
        onClose={() => setTuning(false)}
        init={v.editable}
        onSaved={() => {
          refreshAll();
          mutate();
          toast({ title: "Valuation updated" });
        }}
      />
    </div>
  );
}

function Fig({
  label,
  value,
  cur,
  sub,
  neg,
}: {
  label: string;
  value: number | null;
  cur: string;
  sub?: string;
  neg?: boolean;
}) {
  return (
    <div className="rounded-2xl bg-sunken p-4">
      <p className="eyebrow">{label}</p>
      <p className={clsx("fig mt-1 text-2xl", neg && "text-neg")}>
        {value === null ? "—" : <Money value={value} currency={cur} compact />}
      </p>
      {sub && <p className="mt-0.5 text-xs text-ink3">{sub}</p>}
    </div>
  );
}

function Line({
  label,
  value,
  cur,
  strong,
  indent,
  hint,
  sign,
}: {
  label: string;
  value: number;
  cur: string;
  strong?: boolean;
  indent?: boolean;
  hint?: string;
  sign?: boolean;
}) {
  return (
    <div
      className={clsx(
        "flex items-center justify-between gap-4 py-2.5",
        strong && "border-t border-line2 pt-3",
        indent && "ps-4",
      )}
    >
      <span className={clsx("flex items-center gap-1 text-sm", strong ? "font-semibold text-ink" : "text-ink2")}>
        {label}
        {hint && <Hint k={hint} />}
      </span>
      <Money
        value={value}
        currency={cur}
        sign={sign}
        animate={false}
        className={clsx(strong ? "fig text-xl" : "text-sm", value < 0 && strong && "text-neg")}
      />
    </div>
  );
}

function Income({ cur, s, p }: { cur: string; s: St; p: St }) {
  const x = s.summary;
  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="divide-y divide-line">
        <Line label="What you sold (revenue)" value={x.revenue} cur={cur} hint="revenue" />
        <Line label="Cost of what you sold" value={-x.cogs} cur={cur} indent hint="cogs" />
        <Line label="Left after those costs (gross profit)" value={x.grossProfit} cur={cur} hint="gross_profit" />
        <Line label="Running the business" value={-x.opex} cur={cur} indent hint="opex" />
        <Line label="Wear on equipment (depreciation)" value={-s.depreciation} cur={cur} indent hint="depreciation" />
        <Line label="What the business kept" value={s.profitAfterDepreciation} cur={cur} strong hint="net_profit" />
      </div>
      <div className="rounded-2xl bg-sunken p-5 text-sm text-ink2">
        <p className="font-medium text-ink">Compared with last month</p>
        <p className="mt-2">
          Kept then: <strong className="text-ink">{formatMoney(p.profitAfterDepreciation, cur)}</strong>
        </p>
        <p className="mt-1">
          Margin now: <strong className="text-ink">{x.margin === null ? "—" : `${Math.round(x.margin * 100)}%`}</strong>
        </p>
        {x.incomplete && (
          <p className="mt-3 rounded-lg bg-warnsoft px-3 py-2 text-[13px] text-ink">
            Product costs are missing, so this probably looks better than reality.
          </p>
        )}
        <p className="mt-3 text-xs text-ink3">
          Costs count when you record them. Record equipment as an asset (below), not as an expense, so it is spread
          over its life.
        </p>
      </div>
    </div>
  );
}

function CashSt({ cur, s }: { cur: string; s: St }) {
  const x = s.summary;
  return (
    <div className="max-w-xl divide-y divide-line">
      <Line label="Cash at the start of the month" value={s.openingCash} cur={cur} />
      <Line label="Money in" value={x.cashIn} cur={cur} indent sign />
      <Line label="Money out" value={-x.cashOut} cur={cur} indent sign />
      <Line label="Cash now" value={s.closingCash} cur={cur} strong hint="cash_balance" />
      <p className="pt-3 text-xs text-ink3">
        Moving money between your own accounts is not “in” or “out”. Profit and cash differ when customers pay later or
        you buy stock ahead.
      </p>
    </div>
  );
}

function Position({
  cur,
  pos,
  assets,
  onAdd,
  canWrite,
  onChange,
}: {
  cur: string;
  pos: Health["statements"]["position"];
  assets: Health["assets"];
  onAdd: () => void;
  canWrite: boolean;
  onChange: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="divide-y divide-line">
          <p className="eyebrow pb-2">What you own</p>
          <Line label="Cash in your accounts" value={pos.cash} cur={cur} />
          <Line label="Money customers owe you" value={pos.receivables} cur={cur} hint="receivable" />
          <Line label="Equipment (after wear)" value={pos.fixed} cur={cur} hint="book_value" />
        </div>
        <div className="divide-y divide-line">
          <p className="eyebrow pb-2">What you owe</p>
          <Line label="Bills you still have to pay" value={pos.payables} cur={cur} hint="payable" />
          <Line label="What is left for the owner (equity)" value={pos.equity} cur={cur} strong />
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">Equipment &amp; assets</p>
          {canWrite && (
            <Button size="sm" onClick={onAdd}>
              <Plus className="size-4" aria-hidden /> Add asset
            </Button>
          )}
        </div>
        {assets.length === 0 ? (
          <p className="mt-3 rounded-xl bg-sunken px-4 py-5 text-sm text-ink2">
            No equipment recorded. Add a laptop, machine or vehicle and Socio will spread its cost over its life (
            <Link href="/app/learn#depreciation" className="font-medium text-accent underline">
              depreciation
            </Link>
            ).
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
            {assets.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{a.name}</p>
                  <p className="text-xs text-ink3">
                    Bought {a.purchase_date} for {formatMoney(a.cost, cur)} · loses{" "}
                    {formatMoney(a.monthlyDepreciation, cur)}/month{a.fullyDepreciated ? " · fully written down" : ""}
                  </p>
                </div>
                <div className="text-end">
                  <p className="fig text-lg">{formatMoney(a.bookValue, cur)}</p>
                  <p className="text-xs text-ink3">
                    book value{a.fair_value !== null ? ` · you estimate ${formatMoney(a.fair_value, cur)} fair` : ""}
                  </p>
                </div>
                {canWrite && (
                  <button
                    aria-label={`Delete ${a.name}`}
                    className="text-ink3 hover:text-neg"
                    onClick={async () => {
                      await api.del(`/api/assets/${a.id}`);
                      onChange();
                    }}
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TodoRow({
  t,
  cur,
  isOpen,
  onToggle,
  canWrite,
  onChanged,
}: {
  t: Todo;
  cur: string;
  isOpen: boolean;
  onToggle: () => void;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [cost, setCost] = useState<number | null>(t.actual_cost);
  const k = KIND[t.kind] ?? KIND.manual;
  const overdue = t.status === "todo" && t.due_date && t.due_date < new Date().toISOString().slice(0, 10);
  const set = async (status: Todo["status"]) => {
    await api.patch(`/api/todos/${t.id}`, {
      status,
      ...(status === "done" && cost !== null ? { actual_cost: cost } : {}),
    });
    onChanged();
  };
  return (
    <li
      className={clsx(
        "rounded-2xl border bg-raised",
        t.status !== "todo" ? "border-line opacity-70" : overdue ? "border-neg/40" : "border-line",
      )}
    >
      <div className="flex items-center gap-3 p-3.5">
        <button
          aria-label={t.status === "done" ? `Mark “${t.title}” as not done` : `Mark “${t.title}” as done`}
          disabled={!canWrite}
          onClick={() => set(t.status === "done" ? "todo" : "done")}
          className={clsx(
            "flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition",
            t.status === "done" ? "border-pos bg-pos text-white" : "border-line2 hover:border-accent",
          )}
        >
          {t.status === "done" && <Check className="size-3.5" />}
        </button>
        <button className="flex min-w-0 flex-1 items-center gap-3 text-start" onClick={onToggle} aria-expanded={isOpen}>
          <span className="min-w-0 flex-1">
            <span
              className={clsx(
                "block truncate text-[15px] font-medium",
                t.status !== "todo" ? "text-ink3 line-through" : "text-ink",
              )}
            >
              {t.title}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <Badge tone={k.tone}>{k.label}</Badge>
              {t.due_date && (
                <span className={clsx("text-xs", overdue ? "font-medium text-neg" : "text-ink3")}>
                  {t.req?.planningDefault ? "plan for " : "due "}
                  {t.due_date}
                </span>
              )}
              {!t.due_date && t.req && <span className="text-xs text-ink3">date depends on your entity</span>}
            </span>
          </span>
          <ChevronDown className={clsx("size-4 shrink-0 text-ink3 transition", isOpen && "rotate-180")} aria-hidden />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-4 border-t border-line px-4 py-4 text-[13px] leading-relaxed text-ink2">
              {t.reason && <p className="text-ink3">Why it is here: {t.reason}</p>}
              {t.detail && <p>{t.detail}</p>}
              {t.req ? (
                <>
                  <p>
                    <span className="font-medium text-ink">Why it matters. </span>
                    {t.req.why}
                  </p>
                  <div>
                    <p className="font-medium text-ink">How to do it</p>
                    <ol className="mt-1 list-decimal space-y-1 ps-5">
                      {t.req.steps.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ol>
                  </div>
                  {t.req.documents.length > 0 && (
                    <p>
                      <span className="font-medium text-ink">Usually needed: </span>
                      {t.req.documents.join(" · ")}
                    </p>
                  )}
                  <p>
                    <span className="font-medium text-ink">Who: </span>
                    {t.req.authority}
                  </p>
                  <p>
                    <span className="font-medium text-ink">Cost: </span>
                    {t.req.feeNote}
                  </p>
                  {t.req.caveat && (
                    <p className="rounded-lg bg-warnsoft px-3 py-2 text-ink">
                      <AlertTriangle className="me-1.5 inline size-3.5 text-warn" aria-hidden />
                      {t.req.caveat}
                    </p>
                  )}
                  <p className="flex flex-wrap items-center gap-2 text-xs text-ink3">
                    <Badge tone="warn">
                      {t.req.confidence === "official" ? "Socio routine" : "Verify before relying"}
                    </Badge>
                    <a
                      href={t.req.source.url}
                      target={t.req.source.url.startsWith("http") ? "_blank" : undefined}
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-accent underline"
                    >
                      {t.req.source.label} <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </p>
                </>
              ) : null}
              {canWrite && (
                <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
                  <div className="w-48">
                    <label className="mb-1 block text-xs font-medium text-ink2">
                      What you actually paid (optional)
                    </label>
                    <MoneyInput value={cost} onChange={setCost} currency={cur} digits={currencyDigits(cur)} />
                  </div>
                  {t.status === "todo" ? (
                    <>
                      <Button size="sm" variant="primary" onClick={() => set("done")}>
                        Mark done
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => set("skipped")}>
                        Not applicable
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => set("todo")}>
                      Reopen
                    </Button>
                  )}
                  {t.source === "manual" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await api.del(`/api/todos/${t.id}`);
                        onChanged();
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function AddTodo({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (open) setTitle(""), setDue(""), setErr("");
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add a to-do"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!title.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("/api/todos", { title, due_date: due || null });
                onSaved();
                onClose();
              } catch (x) {
                setErr(x instanceof ApiError ? x.message : "Could not save.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err && (
          <p role="alert" className="text-sm text-neg">
            {err}
          </p>
        )}
        <Field label="What needs doing?" htmlFor="td-t">
          <Input id="td-t" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Due (optional)" htmlFor="td-d">
          <Input id="td-d" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function AddAsset({
  open,
  onClose,
  cur,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  cur: string;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: "",
    cost: null as number | null,
    date: new Date().toISOString().slice(0, 10),
    years: 3,
    salvage: null as number | null,
    fair: null as number | null,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open)
      setF({ name: "", cost: null, date: new Date().toISOString().slice(0, 10), years: 3, salvage: null, fair: null }),
        setErr({});
  }, [open]);
  const digits = currencyDigits(cur);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add equipment or an asset"
      description="Something that lasts longer than a year: a laptop, machine, vehicle, furniture."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("/api/assets", {
                  name: f.name,
                  cost: f.cost,
                  purchase_date: f.date,
                  useful_life_months: Math.round(f.years * 12),
                  salvage_value: f.salvage ?? 0,
                  fair_value: f.fair,
                });
                onSaved();
                onClose();
              } catch (x) {
                setErr(x instanceof ApiError ? { ...(x.fields ?? {}), _: x.message } : { _: "Could not save." });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err._ && !err.name && !err.cost && (
          <p role="alert" className="text-sm text-neg">
            {err._}
          </p>
        )}
        <Field label="Name" error={err.name} htmlFor="as-n">
          <Input
            id="as-n"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder="e.g. Sewing machine"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="What it cost" error={err.cost} htmlFor="as-c">
            <MoneyInput
              id="as-c"
              value={f.cost}
              onChange={(v) => setF({ ...f, cost: v })}
              currency={cur}
              digits={digits}
              invalid={!!err.cost}
            />
          </Field>
          <Field label="Bought on" htmlFor="as-d">
            <Input id="as-d" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="Useful for (years)" htmlFor="as-y" hint="How long you expect to use it.">
            <Input
              id="as-y"
              type="number"
              min={1}
              max={50}
              value={f.years}
              onChange={(e) => setF({ ...f, years: Number(e.target.value) || 1 })}
            />
          </Field>
          <Field label="Worth at the end (optional)" htmlFor="as-s" error={err.salvage_value}>
            <MoneyInput
              id="as-s"
              value={f.salvage}
              onChange={(v) => setF({ ...f, salvage: v })}
              currency={cur}
              digits={digits}
            />
          </Field>
        </div>
        <Field
          label="What you think it is worth today (optional)"
          htmlFor="as-f"
          hint="Your own estimate of its market value — its “fair value”."
        >
          <MoneyInput
            id="as-f"
            value={f.fair}
            onChange={(v) => setF({ ...f, fair: v })}
            currency={cur}
            digits={digits}
          />
        </Field>
      </div>
    </Modal>
  );
}

function Tune({
  open,
  onClose,
  init,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  init: { earningsLow: number; earningsHigh: number; revenueLow: number; revenueHigh: number };
  onSaved: () => void;
}) {
  const [f, setF] = useState(init);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (open) setF(init), setErr("");
  }, [open, init]);
  const num = (k: keyof typeof f, step = 0.1) => (
    <Input
      type="number"
      step={step}
      min={0}
      value={f[k]}
      onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })}
    />
  );
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Change the valuation multiples"
      description="Small businesses sell for different multiples by industry and size. Use what you have seen in your own market."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await api.patch("/api/company-health/valuation", f);
                onSaved();
                onClose();
              } catch (x) {
                setErr(x instanceof ApiError ? x.message : "Could not save.");
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err && (
          <p role="alert" className="text-sm text-neg">
            {err}
          </p>
        )}
        <p className="text-sm font-medium text-ink">Yearly profit ×</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Low">{num("earningsLow")}</Field>
          <Field label="High">{num("earningsHigh")}</Field>
        </div>
        <p className="text-sm font-medium text-ink">Yearly revenue ×</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Low">{num("revenueLow", 0.05)}</Field>
          <Field label="High">{num("revenueHigh", 0.05)}</Field>
        </div>
      </div>
    </Modal>
  );
}

export { Select, useMemo };
