"use client";
import { AlertTriangle, Check, CircleHelp, Lightbulb, Pause, Play, RefreshCw, ShieldCheck, X } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import useSWR from "swr";
import { AreaLine } from "@/components/charts";
import { useUi } from "@/components/providers";
import {
  Badge,
  Button,
  Card,
  clsx,
  ConfirmDialog,
  DataLabel,
  EmptyState,
  ErrorNote,
  Field,
  Hint,
  MoneyInput,
  PageHeader,
  Skeleton,
  Tabs,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

type Tab = "now" | "approvals" | "activity" | "workflows" | "learning" | "settings";
interface Option {
  key: string;
  title: string;
  description: string;
  newLowest: number;
  impact: number;
  resolves: boolean;
  buysTime?: boolean;
  newBreachDate?: string | null;
  execution: { tool: string; params?: any };
  assumptions: string[];
}
interface Rec {
  id: string;
  kind: string;
  status: string;
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  created_at: string;
  updated_at: string;
  evidence: {
    facts: string[];
    hypotheses: string[];
    unknowns: string[];
    lowest: number;
    lowestDate: string;
    breachDate: string | null;
    reserve: number;
    reserveSource: string;
    startCash: number;
    points: { date: string; balance: number }[];
  };
  options: Option[];
  data_quality: { score: number; issues: string[] };
}
interface Act {
  id: string;
  recommendation_id: string | null;
  tool: string;
  params: any;
  params_hash: string;
  risk_level: number;
  summary: string;
  status: string;
  requires_approval: boolean;
  approved_at: string | null;
  executed_at: string | null;
  result: any;
  verification: { ok: boolean; detail: string } | null;
  error: string | null;
  origin: string;
  created_at: string;
}
interface Data {
  currency: string;
  safetyReserve: number | null;
  automation: { paused: boolean; paymentReminders: { enabled: boolean; maxAmount: number; minDaysBetween: number } };
  recommendations: Rec[];
  approvals: Act[];
  actions: Act[];
  jobs: any[];
  predictions: any[];
  accuracy: { count: number; meanAbsError: number } | null;
  audit: any[];
  drafts: any[];
  tools: { name: string; label: string; risk: number; available: { ok: boolean; reason?: string } }[];
  emailConfigured: boolean;
  trust: Trust;
}
interface Trust {
  rung: 1 | 2 | 3;
  progress: number;
  rungs: { level: number; name: string; what: string; reached: boolean }[];
  evidence: { label: string; value: string; ok: boolean }[];
  suggestion: {
    title: string;
    why: string;
    change: { paymentReminders: { enabled: boolean; maxAmount: number; minDaysBetween: number } };
  } | null;
}

const STATUS: Record<string, { tone: "pos" | "neg" | "warn" | "info" | "neutral"; label: string }> = {
  succeeded: { tone: "pos", label: "Done & verified" },
  failed: { tone: "neg", label: "Failed" },
  awaiting_approval: { tone: "warn", label: "Needs your approval" },
  approved: { tone: "info", label: "Approved" },
  executing: { tone: "info", label: "Running" },
  rejected: { tone: "neutral", label: "Rejected" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};
const RISK = ["", "Internal", "Bounded", "Sensitive"];
const LABEL: Record<string, string> = {
  product_loss: "a product that loses money",
  ads_burn: "ad spend that does not pay off",
  tax_setaside: "money owed to the tax office",
  cash_risk: "cash risk",
};
interface FOption {
  key: string;
  title: string;
  description: string;
  monthlyProfitImpact: number | null;
  cash60Impact: number | null;
  execution: { tool: string; params?: any };
  assumptions: string[];
}
interface FRec {
  id: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  evidence: {
    facts: string[];
    hypotheses: string[];
    unknowns: string[];
    metrics: {
      label: string;
      value: number;
      format: "money" | "pct" | "ratio" | "count";
      tone?: "pos" | "neg" | "warn";
    }[];
  };
  options: FOption[];
}

function Inner() {
  const { biz } = useMe();
  const sp = useSearchParams();
  const router = useRouter();
  const { toast } = useUi();
  const [tab, setTab] = useState<Tab>((sp.get("tab") as Tab) || "now");
  const { data, error, isLoading, mutate } = useSWR<Data>("/api/actions", { refreshInterval: 15_000 });
  const [running, setRunning] = useState(false);
  const [confirm, setConfirm] = useState<Act | null>(null);
  const cur = data?.currency ?? biz?.currency.trim() ?? "EGP";
  const admin = biz && (biz.role === "owner" || biz.role === "admin");
  useEffect(() => {
    const t = sp.get("tab") as Tab | null;
    if (t) setTab(t);
  }, [sp]);
  const choose = (t: Tab) => {
    setTab(t);
    router.replace(`/app/actions?tab=${t}`);
  };

  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (isLoading && !data) return <Skeleton className="h-96" />;
  if (!data) return null;
  const open = data.recommendations.filter((r) => r.status === "open");

  const runCheck = async () => {
    setRunning(true);
    try {
      const r = await api.post<any>("/api/checks/run");
      await refreshAll();
      const n = (r.cash.atRisk ? 1 : 0) + r.findings.length;
      toast({
        title: n ? `${n} thing${n > 1 ? "s" : ""} worth your attention` : "All checks passed",
        description: [
          r.cash.atRisk
            ? `Cash: lowest point ${formatMoney(r.cash.lowest, cur)}.`
            : "Cash: no risk in the next 60 days.",
          r.findings.length ? `Also found: ${r.findings.map((x: any) => LABEL[x.kind] ?? x.kind).join(", ")}.` : "",
        ].join(" "),
        tone: n ? "warning" : "success",
      });
    } catch (x) {
      toast({
        title: "Could not run the check",
        description: x instanceof ApiError ? x.message : undefined,
        tone: "error",
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Action Center"
        subtitle="What Socio noticed, what it recommends, what it already did, and what needs your approval. Nothing external happens without your say-so."
        actions={
          <>
            {data.automation.paused && (
              <Badge tone="warn">
                <Pause className="size-3" /> Automation paused
              </Badge>
            )}
            <Button variant="primary" loading={running} onClick={runCheck}>
              <RefreshCw className="size-4" aria-hidden /> Run all checks now
            </Button>
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={choose}
        tabs={[
          { value: "now", label: "Recommendations", count: open.length },
          { value: "approvals", label: "Approvals", count: data.approvals.length },
          { value: "activity", label: "Action history" },
          { value: "workflows", label: "Background work" },
          { value: "learning", label: "Forecast vs reality" },
          { value: "settings", label: "Autonomy & safety" },
        ]}
      />

      {tab === "now" && (
        <div className="space-y-5">
          {open.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck className="size-6" />}
              title="Nothing needs attention"
              body={
                data.safetyReserve === null
                  ? "Tip: set a safety reserve so Socio warns you before cash gets uncomfortably low, not only when it hits zero."
                  : "Socio re-checks your cash after every change, every sync and once a day."
              }
              action={
                data.safetyReserve === null ? (
                  <Button onClick={() => choose("settings")}>Set a safety reserve</Button>
                ) : undefined
              }
            />
          ) : (
            open.map((r) =>
              r.kind !== "cash_risk" ? (
                <FindingCard
                  key={r.id}
                  r={r as unknown as FRec}
                  cur={cur}
                  actions={data.actions.filter((a) => a.recommendation_id === r.id)}
                  onChanged={() => {
                    mutate();
                    refreshAll();
                  }}
                />
              ) : (
                <RecCard
                  key={r.id}
                  r={r}
                  cur={cur}
                  actions={data.actions.filter((a) => a.recommendation_id === r.id)}
                  onApprove={(a) => setConfirm(a)}
                  onChanged={() => {
                    mutate();
                    refreshAll();
                  }}
                  admin={!!admin}
                />
              ),
            )
          )}
          {data.recommendations.filter((r) => r.status !== "open").length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium text-ink2">Earlier recommendations</summary>
              <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                {data.recommendations
                  .filter((r) => r.status !== "open")
                  .map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="truncate text-ink2">{r.title}</span>
                      <Badge>{r.status}</Badge>
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {tab === "approvals" && (
        <div className="space-y-3">
          {data.approvals.length === 0 ? (
            <EmptyState
              title="No approvals waiting"
              body="Sensitive actions (changing a bill's date, sending an email, anything external) wait here for you. Each approval is tied to the exact details you see."
            />
          ) : (
            data.approvals.map((a) => (
              <ActRow
                key={a.id}
                a={a}
                cur={cur}
                onApprove={() => setConfirm(a)}
                admin={!!admin}
                onChanged={() => mutate()}
              />
            ))
          )}
        </div>
      )}

      {tab === "activity" && (
        <Card className="overflow-hidden">
          {data.actions.length === 0 ? (
            <p className="p-6 text-sm text-ink3">No actions yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.actions.map((a) => (
                <ActRow
                  key={a.id}
                  a={a}
                  cur={cur}
                  compact
                  admin={!!admin}
                  onApprove={() => setConfirm(a)}
                  onChanged={() => mutate()}
                />
              ))}
            </ul>
          )}
          {data.drafts.length > 0 && (
            <div className="border-t border-line p-5">
              <p className="text-sm font-semibold text-ink">Email drafts (not sent)</p>
              <ul className="mt-2 space-y-2">
                {data.drafts.map((d) => (
                  <li key={d.id} className="rounded-xl bg-sunken p-3 text-[13px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{d.subject}</span>
                      <Badge tone={d.status === "sent" ? "pos" : "neutral"}>{d.status}</Badge>
                    </div>
                    <pre className="mt-1 whitespace-pre-wrap font-sans text-ink2">{d.body}</pre>
                    {d.status === "draft" && (
                      <button
                        className="mt-1 text-xs text-accent underline"
                        onClick={() => navigator.clipboard?.writeText(d.body).then(() => toast({ title: "Copied" }))}
                      >
                        Copy text
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {!data.emailConfigured && (
                <p className="mt-2 text-xs text-ink3">
                  No email provider is configured, so Socio drafts but never sends. Copy the text into your own email.
                </p>
              )}
            </div>
          )}
        </Card>
      )}

      {tab === "workflows" && (
        <Card className="overflow-hidden">
          <div className="border-b border-line px-5 py-3 text-[13px] text-ink3">
            Durable background jobs: syncs, webhook processing, cash checks, briefings. Failed jobs retry automatically
            with growing delays; after the last attempt they stop and appear here.
          </div>
          <ul className="divide-y divide-line">
            {data.jobs.length === 0 && <li className="p-5 text-sm text-ink3">No background work yet.</li>}
            {data.jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-mono text-[13px] text-ink">{j.kind}</span>
                  <span className="block text-xs text-ink3">
                    {new Date(j.created_at).toLocaleString()} · attempt {j.attempts}/{j.max_attempts}
                    {j.last_error ? ` · ${j.last_error}` : ""}
                  </span>
                </span>
                <Badge
                  tone={
                    j.status === "succeeded"
                      ? "pos"
                      : j.status === "dead"
                        ? "neg"
                        : j.status === "running"
                          ? "info"
                          : "warn"
                  }
                >
                  {j.status}
                </Badge>
                {j.status === "dead" && (
                  <Button
                    size="sm"
                    onClick={async () => {
                      await api.post(`/api/jobs/${j.id}/retry`);
                      mutate();
                    }}
                  >
                    Retry
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {tab === "learning" && (
        <Card className="p-5 sm:p-7">
          <h2 className="display text-xl">How good were the forecasts?</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink2">
            Every cash warning records what Socio predicted. Once the date passes, it compares the prediction with the
            cash you actually recorded. This is measured, not assumed — there is no hidden “learning”.
          </p>
          {data.accuracy ? (
            <p className="mt-4 text-sm text-ink">
              Average miss across {data.accuracy.count} measured prediction(s):{" "}
              <strong>{formatMoney(data.accuracy.meanAbsError, cur)}</strong>
            </p>
          ) : (
            <p className="mt-4 rounded-xl bg-sunken px-4 py-3 text-sm text-ink3">
              No prediction has reached its date yet.
            </p>
          )}
          <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
            {data.predictions.map((p) => (
              <li key={p.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[1fr_auto_auto]">
                <span className="text-ink2">
                  For {p.target_date} <span className="text-ink3">(made {p.made_on})</span>
                </span>
                <span className="num">predicted {formatMoney(Number(p.predicted), cur)}</span>
                <span className={clsx("num", p.actual === null ? "text-ink3" : "font-medium")}>
                  {p.actual === null ? "not measured yet" : `actual ${formatMoney(Number(p.actual), cur)}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {tab === "settings" && (
        <SettingsPanel
          d={data}
          cur={cur}
          admin={!!admin}
          onSaved={() => {
            mutate();
            refreshAll();
          }}
        />
      )}

      <ApproveDialog
        act={confirm}
        cur={cur}
        onClose={() => setConfirm(null)}
        onDone={() => {
          mutate();
          refreshAll();
        }}
      />
    </div>
  );
}

function RecCard({
  r,
  cur,
  actions,
  onApprove,
  onChanged,
  admin,
}: {
  r: Rec;
  cur: string;
  actions: Act[];
  onApprove: (a: Act) => void;
  onChanged: () => void;
  admin: boolean;
}) {
  const fm = (v: number) => formatMoney(v, cur);
  const [dismiss, setDismiss] = useState(false);
  const e = r.evidence;
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="overflow-hidden">
        <div
          className={clsx(
            "flex flex-wrap items-start gap-3 px-5 py-4 sm:px-7",
            r.severity === "critical" ? "bg-negsoft/60" : "bg-warnsoft/60",
          )}
        >
          <AlertTriangle
            className={clsx("mt-1 size-5 shrink-0", r.severity === "critical" ? "text-neg" : "text-warn")}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <h2 className="display text-2xl leading-snug">{r.title}</h2>
            <p className="mt-1 text-[15px] text-ink2">{r.summary}</p>
          </div>
          <DataLabel kind="projected" />
        </div>
        <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[1.3fr_1fr]">
          <div>
            <p className="eyebrow">What happened · and why it matters</p>
            <AreaLine
              series={e.points.map((p) => ({ date: p.date, value: p.balance }))}
              currency={cur}
              height={190}
              label="Projected cash: scheduled items plus typical activity, with sales counted cautiously"
              threshold={e.reserve || undefined}
            />
            <Section icon={<Check className="size-4 text-pos" />} title="Verified from your records" items={e.facts} />
            {e.hypotheses.length > 0 && (
              <Section
                icon={<Lightbulb className="size-4 text-warn" />}
                title="Plausible explanations (not confirmed)"
                items={e.hypotheses}
              />
            )}
            <Section
              icon={<CircleHelp className="size-4 text-ink3" />}
              title="What Socio does not know"
              items={e.unknowns}
            />
            <p className="mt-3 text-xs text-ink3">
              Data completeness: {r.data_quality.score}/100
              {r.data_quality.issues.length ? ` — ${r.data_quality.issues.join(" ")}` : ""}
            </p>
          </div>
          <div>
            <p className="eyebrow">Options, calculated</p>
            <ul className="mt-2 space-y-2.5">
              {r.options.map((o, i) => {
                const act = actions.find((a) => a.tool === o.execution.tool && a.status !== "rejected");
                return (
                  <li
                    key={o.key}
                    className={clsx(
                      "rounded-2xl border p-4",
                      i === 0 ? "border-accent bg-accentsoft/40" : "border-line",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {i === 0 && <Badge tone="accent">Recommended</Badge>}
                      <Badge tone={o.resolves ? "pos" : o.buysTime ? "info" : "warn"}>
                        {o.resolves ? "Fixes the gap" : o.buysTime ? "Buys time" : "Helps, not enough alone"}
                      </Badge>
                    </div>
                    <p className="mt-2 text-[15px] font-semibold text-ink">{o.title}</p>
                    <p className="mt-1 text-[13px] text-ink2">{o.description}</p>
                    <p className="mt-2 text-[13px]">
                      <span className="text-ink3">Lowest cash: </span>
                      <span className="num">
                        {fm(e.lowest)} →{" "}
                        <strong className={o.newLowest < 0 ? "text-neg" : "text-pos"}>{fm(o.newLowest)}</strong>
                      </span>{" "}
                      <span className="text-ink3">
                        ({o.impact >= 0 ? "+" : ""}
                        {fm(o.impact)})
                      </span>
                    </p>
                    {o.assumptions.length > 0 && <p className="mt-1 text-xs text-ink3">{o.assumptions.join(" ")}</p>}
                    <div className="mt-3">
                      {o.execution.tool === "manual" ? (
                        <p className="text-xs text-ink3">Done by you — a task was added to your to-do list.</p>
                      ) : act ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={STATUS[act.status]?.tone ?? "neutral"}>
                            {STATUS[act.status]?.label ?? act.status}
                          </Badge>
                          {act.status === "awaiting_approval" && admin && (
                            <Button size="sm" variant="primary" onClick={() => onApprove(act)}>
                              Review & approve
                            </Button>
                          )}
                        </div>
                      ) : o.execution.tool === "send_payment_reminder" ? (
                        <p className="text-xs text-ink3">
                          A reminder draft was prepared (no email provider configured).
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-[13px] text-ink3">
              Already done automatically:{" "}
              {actions
                .filter((a) => a.status === "succeeded" && a.risk_level === 1)
                .map((a) => a.summary)
                .join(" · ") || "nothing"}
              .
            </p>
            <div className="mt-4 flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDismiss(true)}>
                <X className="size-4" aria-hidden /> Dismiss
              </Button>
              <Link
                href="/app/scenarios"
                className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] text-accent hover:bg-sunken"
              >
                Test other ideas in What-if
              </Link>
            </div>
          </div>
        </div>
      </Card>
      <ConfirmDialog
        open={dismiss}
        onOpenChange={setDismiss}
        title="Dismiss this recommendation?"
        body="Pending approvals for it are cancelled. Socio will raise it again if the risk changes."
        confirmLabel="Dismiss"
        tone="primary"
        onConfirm={async () => {
          await api.post(`/api/recommendations/${r.id}/dismiss`);
          onChanged();
        }}
      />
    </motion.div>
  );
}

function FindingCard({ r, cur, actions, onChanged }: { r: FRec; cur: string; actions: Act[]; onChanged: () => void }) {
  const fm = (v: number) => formatMoney(v, cur);
  const [dismiss, setDismiss] = useState(false);
  const e = r.evidence;
  const fmt = (m: FRec["evidence"]["metrics"][number]) =>
    m.format === "money"
      ? fm(m.value)
      : m.format === "pct"
        ? `${m.value >= 0 ? "+" : ""}${Math.round(m.value * 100)}%`
        : m.format === "ratio"
          ? `${m.value.toFixed(2)}×`
          : String(m.value);
  const tone = r.severity === "critical" ? "neg" : r.severity === "warning" ? "warn" : "info";
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="overflow-hidden">
        <div
          className={clsx(
            "flex flex-wrap items-start gap-3 px-5 py-4 sm:px-7",
            tone === "neg" ? "bg-negsoft/60" : tone === "warn" ? "bg-warnsoft/60" : "bg-infosoft/60",
          )}
        >
          <AlertTriangle
            className={clsx(
              "mt-1 size-5 shrink-0",
              tone === "neg" ? "text-neg" : tone === "warn" ? "text-warn" : "text-info",
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="eyebrow">{LABEL[r.kind] ?? r.kind}</p>
            <h2 className="display text-2xl leading-snug">{r.title}</h2>
            <p className="mt-1 text-[15px] text-ink2">{r.summary}</p>
          </div>
          <DataLabel kind="actual" />
        </div>
        <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
          {e.metrics.map((m, i) => (
            <motion.div
              key={m.label}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i }}
              className="bg-surface px-5 py-4"
            >
              <p className="eyebrow">{m.label}</p>
              <p
                className={clsx(
                  "fig mt-1 text-xl",
                  m.tone === "neg"
                    ? "text-neg"
                    : m.tone === "warn"
                      ? "text-warn"
                      : m.tone === "pos"
                        ? "text-pos"
                        : "text-ink",
                )}
              >
                {fmt(m)}
              </p>
            </motion.div>
          ))}
        </div>
        <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <Section icon={<Check className="size-4 text-pos" />} title="Verified from your records" items={e.facts} />
            {e.hypotheses.length > 0 && (
              <Section
                icon={<Lightbulb className="size-4 text-warn" />}
                title="Plausible explanations (not confirmed)"
                items={e.hypotheses}
              />
            )}
            <Section icon={<CircleHelp className="size-4 text-ink3" />} title="What is not known" items={e.unknowns} />
          </div>
          <div>
            <p className="eyebrow">Options, calculated</p>
            <ul className="mt-2 space-y-2.5">
              {r.options.map((o, i) => {
                const act = actions.find(
                  (a) =>
                    (a.tool === o.execution.tool && o.execution.tool !== "manual") ||
                    (o.execution.tool === "manual" && a.tool === "create_task" && a.params?.title === o.title),
                );
                return (
                  <li
                    key={o.key}
                    className={clsx(
                      "rounded-2xl border p-4",
                      i === 0 ? "border-accent bg-accentsoft/40" : "border-line",
                    )}
                  >
                    {i === 0 && <Badge tone="accent">Recommended</Badge>}
                    <p className="mt-2 text-[15px] font-semibold text-ink">{o.title}</p>
                    <p className="mt-1 text-[13px] text-ink2">{o.description}</p>
                    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                      <span>
                        <span className="text-ink3">Monthly profit: </span>
                        {o.monthlyProfitImpact === null ? (
                          <span className="text-ink3">not estimated</span>
                        ) : (
                          <strong className={o.monthlyProfitImpact > 0 ? "text-pos" : "text-ink"}>
                            {o.monthlyProfitImpact > 0 ? "+" : ""}
                            {fm(o.monthlyProfitImpact)}
                          </strong>
                        )}
                      </span>
                      <span>
                        <span className="text-ink3">Cash, 60 days: </span>
                        {o.cash60Impact === null ? (
                          <span className="text-ink3">not estimated</span>
                        ) : (
                          <strong className={o.cash60Impact > 0 ? "text-pos" : "text-ink"}>
                            {o.cash60Impact > 0 ? "+" : ""}
                            {fm(o.cash60Impact)}
                          </strong>
                        )}
                      </span>
                    </p>
                    {o.assumptions.length > 0 && <p className="mt-1 text-xs text-ink3">{o.assumptions.join(" ")}</p>}
                    {act && (
                      <div className="mt-2">
                        <Badge tone={STATUS[act.status]?.tone ?? "neutral"}>
                          {act.tool === "create_task" && act.status === "succeeded"
                            ? "Added to your to-do list"
                            : (STATUS[act.status]?.label ?? act.status)}
                        </Badge>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDismiss(true)}>
                <X className="size-4" aria-hidden /> Dismiss
              </Button>
              <Link
                href={
                  r.kind === "product_loss" ? "/app/profit" : r.kind === "ads_burn" ? "/app/scenarios" : "/app/goals"
                }
                className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] text-accent hover:bg-sunken"
              >
                {r.kind === "product_loss"
                  ? "See product profit"
                  : r.kind === "ads_burn"
                    ? "Test a change in What-if"
                    : "See your reserves"}
              </Link>
            </div>
          </div>
        </div>
      </Card>
      <ConfirmDialog
        open={dismiss}
        onOpenChange={setDismiss}
        title="Dismiss this recommendation?"
        body="It will not be raised again for the same issue this period."
        confirmLabel="Dismiss"
        tone="primary"
        onConfirm={async () => {
          await api.post(`/api/recommendations/${r.id}/dismiss`);
          onChanged();
        }}
      />
    </motion.div>
  );
}

function Section({ icon, title, items }: { icon: React.ReactNode; title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-4">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        {icon}
        {title}
      </p>
      <ul className="mt-1.5 space-y-1 text-[13px] leading-relaxed text-ink2">
        {items.map((x, i) => (
          <li key={i}>• {x}</li>
        ))}
      </ul>
    </div>
  );
}

function ActRow({
  a,
  cur,
  compact,
  onApprove,
  admin,
  onChanged,
}: {
  a: Act;
  cur: string;
  compact?: boolean;
  onApprove: () => void;
  admin: boolean;
  onChanged: () => void;
}) {
  const st = STATUS[a.status] ?? { tone: "neutral" as const, label: a.status };
  return (
    <li className={clsx("list-none", !compact && "rounded-2xl border border-line bg-surface")}>
      <div className="flex flex-wrap items-start gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium text-ink">{a.summary}</p>
          <p className="mt-0.5 text-xs text-ink3">
            {a.tool} · {RISK[a.risk_level]} · {a.origin === "system" ? "proposed by Socio" : "requested by you"} ·{" "}
            {new Date(a.created_at).toLocaleString()}
          </p>
          {a.verification && (
            <p className={clsx("mt-1 text-[13px]", a.verification.ok ? "text-pos" : "text-neg")}>
              {a.verification.ok ? "Verified: " : "Not verified: "}
              {a.verification.detail}
            </p>
          )}
          {a.error && <p className="mt-1 text-[13px] text-neg">{a.error}</p>}
          {!compact && <ParamList params={a.params} cur={cur} />}
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
        {a.status === "awaiting_approval" && admin && (
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={onApprove}>
              Review & approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await api.post(`/api/actions/${a.id}/reject`);
                onChanged();
              }}
            >
              Reject
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function ParamList({ params, cur }: { params: Record<string, unknown>; cur: string }) {
  return (
    <dl className="mt-2 grid gap-x-6 gap-y-1 rounded-xl bg-sunken px-3.5 py-2.5 text-[13px] sm:grid-cols-2">
      {Object.entries(params).map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3">
          <dt className="text-ink3">{k}</dt>
          <dd className="truncate font-mono text-ink">
            {typeof v === "number" && /amount/i.test(k) ? formatMoney(v, cur) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ApproveDialog({
  act,
  cur,
  onClose,
  onDone,
}: {
  act: Act | null;
  cur: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  if (!act) return <ConfirmDialog open={false} onOpenChange={() => {}} title="" body="" onConfirm={() => {}} />;
  return (
    <ConfirmDialog
      open={!!act}
      onOpenChange={(o) => !o && onClose()}
      title="Approve exactly this action?"
      tone="primary"
      confirmLabel={busy ? "Running…" : "Approve and run"}
      body={
        <span className="block space-y-3">
          <span className="block font-medium text-ink">{act.summary}</span>
          <ParamList params={act.params} cur={cur} />
          <span className="block text-[13px]">
            This approval is bound to these exact details. If anything changes, Socio will ask again.{" "}
            {act.tool === "reschedule_payable"
              ? "Only approve after the supplier has agreed to the new date — Socio updates your records, it does not contact the supplier."
              : ""}
          </span>
        </span>
      }
      onConfirm={async () => {
        setBusy(true);
        try {
          const r = await api.post<any>(`/api/actions/${act.id}/approve`, { hash: act.params_hash });
          toast({
            title:
              r.status === "succeeded" ? "Done and verified" : r.status === "failed" ? "The action failed" : "Approved",
            description: r.verification?.detail ?? r.error ?? undefined,
            tone: r.status === "failed" ? "error" : "success",
          });
          onDone();
        } catch (x) {
          toast({ title: "Not approved", description: x instanceof ApiError ? x.message : undefined, tone: "error" });
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

function SettingsPanel({ d, cur, admin, onSaved }: { d: Data; cur: string; admin: boolean; onSaved: () => void }) {
  const { toast } = useUi();
  const [reserve, setReserve] = useState<number | null>(d.safetyReserve);
  const [pr, setPr] = useState(d.automation.paymentReminders);
  const digits = currencyDigits(cur);
  const save = async (body: unknown, msg: string) => {
    try {
      await api.patch("/api/automation", body);
      toast({ title: msg });
      onSaved();
    } catch (x) {
      toast({ title: "Not saved", description: x instanceof ApiError ? x.message : undefined, tone: "error" });
    }
  };
  return (
    <div className="space-y-5">
      <TrustCard
        t={d.trust}
        cur={cur}
        admin={admin}
        onAccept={(change) => save(change, "Done — small reminders can now be sent automatically")}
      />
      <Card className="p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="display text-xl">Automation switch</h2>
            <p className="mt-1 max-w-xl text-sm text-ink2">
              When paused, Socio still syncs and calculates, but takes no action on its own — every action waits for
              you.
            </p>
          </div>
          <Button
            variant={d.automation.paused ? "primary" : "danger"}
            disabled={!admin}
            onClick={() =>
              save({ paused: !d.automation.paused }, d.automation.paused ? "Automation resumed" : "Automation paused")
            }
          >
            {d.automation.paused ? (
              <>
                <Play className="size-4" /> Resume automation
              </>
            ) : (
              <>
                <Pause className="size-4" /> Pause all automation
              </>
            )}
          </Button>
        </div>
      </Card>
      <Card className="p-5 sm:p-7">
        <div className="flex items-center gap-1">
          <h2 className="display text-xl">Safety reserve</h2>
          <Hint k="emergency_reserve" />
        </div>
        <p className="mt-1 max-w-xl text-sm text-ink2">
          The minimum cash you want to keep. Socio warns you, explains why and suggests options when the forecast drops
          below it.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Keep at least" htmlFor="sr" className="w-60">
            <MoneyInput id="sr" value={reserve} onChange={setReserve} currency={cur} digits={digits} />
          </Field>
          <Button
            variant="primary"
            disabled={!admin}
            onClick={() => save({ safetyReserve: reserve ?? null }, "Safety reserve saved")}
          >
            Save
          </Button>
        </div>
      </Card>
      <Card className="p-5 sm:p-7">
        <h2 className="display text-xl">What Socio may do by itself</h2>
        <ul className="mt-3 space-y-3 text-sm">
          <li className="rounded-xl bg-sunken p-4">
            <Badge tone="pos">Level 1 · automatic</Badge>
            <p className="mt-1.5 text-ink2">
              Read and sync data, calculate, create internal alerts and tasks, draft emails (never sent).
            </p>
          </li>
          <li className="rounded-xl bg-sunken p-4">
            <Badge tone="info">Level 2 · within your limits</Badge>
            <p className="mt-1.5 text-ink2">
              Email a payment reminder for an overdue invoice. Limits are enforced on the server.
            </p>
            {!d.emailConfigured && (
              <p className="mt-1 text-xs text-warn">
                No email provider is configured (RESEND_API_KEY, EMAIL_FROM), so reminders can only be drafted.
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="flex items-center gap-2 text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={pr.enabled}
                  disabled={!admin}
                  onChange={(e) => setPr({ ...pr, enabled: e.target.checked })}
                />{" "}
                Allow automatic reminders
              </label>
              <Field label="Only for invoices up to" htmlFor="pmax" className="w-52">
                <MoneyInput
                  id="pmax"
                  value={pr.maxAmount}
                  onChange={(v) => setPr({ ...pr, maxAmount: v ?? 0 })}
                  currency={cur}
                  digits={digits}
                />
              </Field>
              <Field label="At most once every (days)" htmlFor="pdays" className="w-44">
                <input
                  id="pdays"
                  type="number"
                  min={1}
                  max={60}
                  value={pr.minDaysBetween}
                  onChange={(e) => setPr({ ...pr, minDaysBetween: Math.max(1, Number(e.target.value) || 1) })}
                  className="h-11 w-full rounded-xl border border-line bg-raised px-3.5"
                />
              </Field>
              <Button disabled={!admin} onClick={() => save({ paymentReminders: pr }, "Limits saved")}>
                Save limits
              </Button>
            </div>
          </li>
          <li className="rounded-xl bg-sunken p-4">
            <Badge tone="warn">Level 3 · always ask</Badge>
            <p className="mt-1.5 text-ink2">
              Changing what you owe and when, sending anything else externally, payments and commitments. Socio never
              moves money.
            </p>
          </li>
        </ul>
        <p className="mt-4 text-xs text-ink3">
          Available tools: {d.tools.map((t) => `${t.label}${t.available.ok ? "" : " (unavailable)"}`).join(" · ")}. Ad
          budgets cannot be changed by Socio: the ad connections are read-only.
        </p>
      </Card>
    </div>
  );
}

function TrustCard({
  t,
  cur,
  admin,
  onAccept,
}: {
  t: Trust;
  cur: string;
  admin: boolean;
  onAccept: (change: unknown) => void;
}) {
  const [later, setLater] = useState(false);
  return (
    <Card className="overflow-hidden">
      <div className="p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Trust ladder</p>
            <h2 className="display mt-1 text-2xl">Autonomy is earned — and only you can grant it</h2>
            <p className="mt-1 max-w-2xl text-sm text-ink2">
              The co-pilot proves itself first: its forecasts are checked against what really happened, and your
              approvals are counted. When the evidence is strong it may ask for a little more. It can never raise its
              own limits.
            </p>
          </div>
          <Badge tone={t.rung >= 2 ? "pos" : "info"}>
            Level {t.rung} · {t.rungs[t.rung - 1].name}
          </Badge>
        </div>
        <ol className="mt-5 grid gap-3 md:grid-cols-3">
          {t.rungs.map((r, i) => (
            <motion.li
              key={r.level}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 * i }}
              className={clsx(
                "relative rounded-2xl border p-4",
                r.reached ? "border-pos/40 bg-possoft/40" : "border-line bg-surface",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={clsx(
                    "grid size-7 place-items-center rounded-full text-[12px] font-semibold",
                    r.reached ? "bg-pos text-white" : "bg-sunken text-ink3",
                  )}
                >
                  {r.reached ? <Check className="size-4" /> : r.level}
                </span>
                <p className="text-[15px] font-semibold text-ink">{r.name}</p>
              </div>
              <p className="mt-2 text-[13px] text-ink2">{r.what}</p>
            </motion.li>
          ))}
        </ol>
        {t.rung === 1 && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-ink3">
              <span>Progress to level 2</span>
              <span>{t.progress}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-sunken">
              <motion.div
                className="h-full rounded-full bg-accent"
                initial={{ width: 0 }}
                animate={{ width: `${t.progress}%` }}
                transition={{ duration: 0.8 }}
              />
            </div>
          </div>
        )}
        <ul className="mt-4 grid gap-2 sm:grid-cols-3">
          {t.evidence.map((e) => (
            <li key={e.label} className="rounded-xl bg-sunken px-3.5 py-2.5">
              <p className="text-[12px] text-ink3">{e.label}</p>
              <p className={clsx("text-[14px] font-medium", e.ok ? "text-pos" : "text-ink")}>
                {e.ok ? "✓ " : ""}
                {e.value}
              </p>
            </li>
          ))}
        </ul>
      </div>
      {t.suggestion && !later && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="border-t border-line bg-accentsoft/40 px-5 py-4 sm:px-7"
        >
          <p className="text-[12px] font-semibold uppercase tracking-wide text-accent">The co-pilot is asking</p>
          <p className="mt-1 text-[16px] font-semibold text-ink">“{t.suggestion.title}”</p>
          <p className="mt-1 text-[13px] text-ink2">
            {t.suggestion.why} Limit: invoices up to {formatMoney(t.suggestion.change.paymentReminders.maxAmount, cur)},
            at most once a week per invoice.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" disabled={!admin} onClick={() => onAccept(t.suggestion!.change)}>
              Allow it
            </Button>
            <Button variant="ghost" onClick={() => setLater(true)}>
              Not now
            </Button>
          </div>
        </motion.div>
      )}
    </Card>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
