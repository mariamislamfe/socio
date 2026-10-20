"use client";
import { ArrowRight, Calculator, Cpu, Send, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { InsightItem, type InsightData } from "@/components/app/insight";
import {
  Badge,
  Button,
  Card,
  clsx,
  EmptyState,
  ErrorNote,
  Input,
  MoneyInput,
  PageHeader,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { currencyDigits } from "@/lib/finance/money";

interface Answer {
  intent: string;
  title: string;
  answer: string;
  facts: { label: string; value: string }[];
  actions: { label: string; href: string }[];
  assumptions: string[];
  needs?: { field: "amount" | "percent"; label: string; hint: string };
  verdict?: "ok" | "caution" | "no";
  ai: { status: "unconfigured" | "ok" | "unavailable"; text?: string; model?: string };
}

const SUGGESTIONS = [
  "Why did my profit decrease?",
  "What are my largest expenses?",
  "Can I afford to hire a designer?",
  "Can I afford another inventory order?",
  "What happens if sales decrease by 20%?",
  "Which payments are due soon?",
  "How much should I reserve?",
  "Which budget is most at risk?",
];

function Inner() {
  const sp = useSearchParams();
  const { biz } = useMe();
  const cur = biz?.currency.trim() ?? "EGP";
  const [q, setQ] = useState("");
  const [thread, setThread] = useState<{ question: string; a: Answer }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [needVal, setNeedVal] = useState<number | null>(null);
  const insights = useSWR<{ items: InsightData[]; dismissed: number; hasData: boolean }>("/api/insights");
  const end = useRef<HTMLDivElement>(null);
  const asked = useRef(false);

  const ask = async (question: string, extra: { amount?: number; percent?: number } = {}) => {
    if (!question.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const a = await api.post<Answer>("/api/copilot", { question, ...extra });
      setThread((t) => [...t.filter((x) => !(x.question === question && x.a.needs)), { question, a }]);
      setQ("");
      setNeedVal(null);
      setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const initial = sp.get("q");
    if (initial && !asked.current) {
      asked.current = true;
      ask(initial);
    }
  }, [sp]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Copilot"
        subtitle="Ask about your own numbers. Every figure is calculated from your records by the same engine that powers the dashboard — never guessed."
      />

      <Card className="overflow-hidden">
        <div className="p-5 sm:p-7">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(q);
            }}
            className="flex gap-2"
          >
            <Input
              aria-label="Ask a question about your business"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ask: Why did my profit decrease?"
              className="h-12 text-base"
              maxLength={300}
            />
            <Button type="submit" variant="primary" size="lg" loading={busy} disabled={q.trim().length < 2}>
              <Send className="size-4" aria-hidden /> <span className="hidden sm:inline">Ask</span>
            </Button>
          </form>
          <div className="mt-4 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => ask(s)}
                disabled={busy}
                className="rounded-full border border-line bg-raised px-3.5 py-1.5 text-[13px] text-ink2 transition hover:border-accent hover:text-accent disabled:opacity-60"
              >
                {s}
              </button>
            ))}
          </div>
          {err && (
            <p role="alert" className="mt-4 rounded-xl bg-negsoft px-3.5 py-2.5 text-sm text-neg">
              {err}
            </p>
          )}
        </div>

        {thread.length > 0 && (
          <div className="space-y-6 border-t border-line bg-surface p-5 sm:p-7" aria-live="polite">
            {thread.map(({ question, a }, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-3"
              >
                <p className="ms-auto w-fit max-w-[90%] rounded-2xl rounded-ee-md bg-accent px-4 py-2.5 text-sm text-accentink">
                  {question}
                </p>
                <div className="rounded-2xl border border-line bg-raised p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="display text-xl">{a.title}</h3>
                    <Badge tone="accent">
                      <Calculator className="size-3" aria-hidden /> Calculated from your records
                    </Badge>
                    {a.verdict && (
                      <Badge tone={a.verdict === "ok" ? "pos" : a.verdict === "caution" ? "warn" : "neg"}>
                        {a.verdict === "ok" ? "Looks affordable" : a.verdict === "caution" ? "Tight" : "Not safely"}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-2 text-[15px] leading-relaxed text-ink">{a.answer}</p>
                  {a.needs && (
                    <form
                      className="mt-4 flex max-w-sm items-end gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (needVal) ask(question, { amount: needVal });
                      }}
                    >
                      <div className="flex-1">
                        <label className="mb-1.5 block text-[13px] font-medium text-ink2">{a.needs.label}</label>
                        <MoneyInput
                          value={needVal}
                          onChange={setNeedVal}
                          currency={cur}
                          digits={currencyDigits(cur)}
                          autoFocus
                        />
                      </div>
                      <Button type="submit" variant="primary" disabled={!needVal} loading={busy}>
                        Check
                      </Button>
                    </form>
                  )}
                  {a.facts.length > 0 && (
                    <dl className="mt-4 divide-y divide-line rounded-xl bg-sunken px-4">
                      {a.facts.map((f, i) => (
                        <div key={i} className="flex justify-between gap-4 py-2.5 text-sm">
                          <dt className="text-ink2">{f.label}</dt>
                          <dd className="num text-end font-medium text-ink">{f.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {a.ai.status === "ok" && a.ai.text && (
                    <div className="mt-4 rounded-xl border border-info/30 bg-infosoft px-4 py-3">
                      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-info">
                        <Cpu className="size-3.5" aria-hidden /> AI explanation · not a calculation
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-ink">{a.ai.text}</p>
                      <p className="mt-1 text-[11px] text-ink3">
                        Written by {a.ai.model} from the figures above. It cannot add numbers.
                      </p>
                    </div>
                  )}
                  {a.assumptions.length > 0 && (
                    <details className="mt-4 text-[13px] text-ink2">
                      <summary className="cursor-pointer font-medium text-ink">Assumptions &amp; limits</summary>
                      <ul className="mt-2 list-disc space-y-1 ps-5">
                        {a.assumptions.map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {a.actions.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {a.actions.map((x) => (
                        <Link
                          key={x.href + x.label}
                          href={x.href}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-accent transition hover:border-accent"
                        >
                          {x.label} <ArrowRight className="size-3.5" aria-hidden />
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
            <div ref={end} />
          </div>
        )}
      </Card>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="display flex items-center gap-2 text-2xl">
            <Sparkles className="size-5 text-accent" aria-hidden /> Insights from your records
          </h2>
          {(insights.data?.dismissed ?? 0) > 0 && (
            <button
              className="text-[13px] text-ink2 underline underline-offset-2"
              onClick={async () => {
                await api.post("/api/insights/restore-all");
                refreshAll();
              }}
            >
              Show {insights.data!.dismissed} dismissed
            </button>
          )}
        </div>
        {insights.error ? (
          <ErrorNote error={insights.error} onRetry={() => insights.mutate()} />
        ) : !insights.data ? (
          <Skeleton className="h-40" />
        ) : insights.data.items.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="size-6" />}
            title={insights.data.hasData ? "Nothing needs your attention" : "Not enough data for insights yet"}
            body={
              insights.data.hasData
                ? "Socio re-checks budgets, cash and data quality whenever your records change."
                : "Add transactions, budgets or bills and Socio will start pointing out risks and opportunities, with the numbers behind each one."
            }
          />
        ) : (
          <ul className="space-y-3">
            {insights.data.items.map((i) => (
              <InsightItem key={i.key} i={i} />
            ))}
          </ul>
        )}
        <p className={clsx("mt-4 text-xs text-ink3")}>
          Insights are rule-based and deterministic: each one lists the records and assumptions behind it. They are
          guidance, not financial or tax advice.
        </p>
      </section>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
