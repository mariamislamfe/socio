"use client";
import { ArrowRight, CalendarClock, CheckCircle2, CircleAlert, Plug, ShieldAlert, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import useSWR from "swr";
import { Badge, Card, clsx, Hint, Money, Skeleton } from "../ui";
import { formatMoney } from "@/lib/finance/money";

interface Home {
  currency: string;
  today: string;
  status: "act" | "watch" | "good" | "start";
  cash: { recorded: number; pendingNonCash: number; accounts: number; lowest30: number; lowestDate: string };
  reserve: number | null;
  nextEvent: { date: string; amount: number; label: string; kind: string } | null;
  attention: { recommendations: { id: string; title: string; severity: string }[]; approvals: number };
  nextAction: { title: string; why: string; href: string } | null;
  integrations: { provider: string; status: string; last_sync_at: string | null; display_name: string | null }[];
  dataQuality: { score: number; issues: string[] };
  briefing: {
    headline: string;
    change: string | null;
    priorities: { title: string; why: string; href: string }[];
    date: string;
  } | null;
}

const LINE = {
  act: { icon: ShieldAlert, tone: "text-neg", bg: "bg-negsoft/60", text: "Something needs action today." },
  watch: { icon: CircleAlert, tone: "text-warn", bg: "bg-warnsoft/60", text: "A few things are worth your attention." },
  good: { icon: CheckCircle2, tone: "text-pos", bg: "bg-possoft/60", text: "Your business looks steady today." },
  start: { icon: Sparkles, tone: "text-accent", bg: "bg-accentsoft/60", text: "Let’s get your numbers in." },
};
const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/* * The first thing on the home screen: status, money, attention, what's next, and the one thing to do. */
export function TodayPanel() {
  const { data } = useSWR<Home>("/api/home", { refreshInterval: 60_000 });
  if (!data) return <Skeleton className="h-48" />;
  const L = LINE[data.status];
  const cur = data.currency;
  const below = data.reserve !== null && data.cash.lowest30 < data.reserve;
  return (
    <Card className="overflow-hidden">
      <div className={clsx("flex flex-wrap items-center gap-3 px-5 py-4 sm:px-7", L.bg)}>
        <L.icon className={clsx("size-6 shrink-0", L.tone)} aria-hidden />
        <p className="display min-w-0 flex-1 text-2xl leading-snug">
          {data.briefing?.headline && data.status !== "start" ? data.briefing.headline : L.text}
        </p>
        {data.attention.approvals > 0 && (
          <Link href="/app/actions?tab=approvals">
            <Badge tone="warn">{data.attention.approvals} waiting for approval</Badge>
          </Link>
        )}
      </div>
      <div className="grid divide-y divide-line md:grid-cols-[1fr_1fr_1.2fr] md:divide-x md:divide-y-0">
        <div className="p-5">
          <div className="flex items-center gap-1">
            <span className="eyebrow">Money available</span>
            <Hint k="cash_balance" />
          </div>
          <Money value={data.cash.recorded} currency={cur} className="fig mt-1 block text-3xl" />
          <p className="mt-1 text-xs text-ink3">
            {data.cash.accounts
              ? "From the balances and transactions you recorded."
              : "From the balances and transactions you recorded (no accounts yet)."}
          </p>
          {data.cash.pendingNonCash > 0 && (
            <p className="mt-1 text-xs text-ink2">
              + {formatMoney(data.cash.pendingNonCash, cur)} in your Shopify balance, not paid out yet.
            </p>
          )}
          <p className={clsx("mt-2 text-xs", below ? "font-medium text-neg" : "text-ink3")}>
            {`Lowest in 30 days: ${formatMoney(data.cash.lowest30, cur)} on ${data.cash.lowestDate}${data.reserve !== null ? ` · reserve ${formatMoney(data.reserve, cur, { compact: true })}` : ""}`}
          </p>
        </div>
        <div className="p-5">
          <p className="eyebrow flex items-center gap-1.5">
            <CalendarClock className="size-3.5" aria-hidden /> Next money event
          </p>
          {data.nextEvent ? (
            <>
              <p className="mt-1 truncate text-[15px] font-medium text-ink">{data.nextEvent.label}</p>
              <p className={clsx("fig text-2xl", data.nextEvent.amount > 0 ? "text-pos" : "text-ink")}>
                {formatMoney(data.nextEvent.amount, cur, { sign: true })}
              </p>
              <p className="text-xs text-ink3">
                {data.nextEvent.date} ·{" "}
                <Link href="/app/calendar" className="text-accent underline">
                  see the calendar
                </Link>
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-ink3">
              Nothing scheduled.{" "}
              <Link href="/app/obligations" className="text-accent underline">
                Add bills or recurring payments
              </Link>
              .
            </p>
          )}
        </div>
        <div className="p-5">
          <p className="eyebrow">The one thing to do next</p>
          {data.nextAction ? (
            <Link
              href={data.nextAction.href}
              className="group mt-2 block rounded-2xl bg-accent p-4 text-accentink transition hover:brightness-110"
            >
              <span className="flex items-center justify-between gap-2 text-[15px] font-semibold">
                {data.nextAction.title}
                <ArrowRight className="size-4 shrink-0 transition group-hover:translate-x-0.5" aria-hidden />
              </span>
              <span className="mt-1 line-clamp-2 block text-[13px] text-accentink/80">{data.nextAction.why}</span>
            </Link>
          ) : (
            <p className="mt-2 rounded-2xl bg-sunken p-4 text-sm text-ink2">
              Nothing urgent. Keep recording as you go — Socio re-checks after every change.
            </p>
          )}
          {data.attention.recommendations.length > 1 && (
            <ul className="mt-3 space-y-1 text-[13px]">
              {data.attention.recommendations.slice(1).map((r) => (
                <li key={r.id}>
                  <Link href="/app/actions" className="text-ink2 hover:text-accent">
                    • {r.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {(data.briefing?.change || data.integrations.length > 0 || data.dataQuality.issues.length > 0) && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line px-5 py-3 text-xs text-ink3 sm:px-7"
        >
          {data.briefing?.change && <span className="text-ink2">{data.briefing.change}</span>}
          {data.integrations.map((i) => (
            <span key={i.provider} className="flex items-center gap-1.5">
              <Plug className="size-3.5" aria-hidden />
              {i.display_name ?? i.provider}:{" "}
              <span className={i.status === "connected" ? "text-pos" : "text-warn"}>{i.status.replace("_", " ")}</span>,
              synced {ago(i.last_sync_at)}
            </span>
          ))}
          {data.dataQuality.score < 80 && (
            <Link href="/app/health" className="text-warn underline">
              Data completeness {data.dataQuality.score}/100
            </Link>
          )}
        </motion.div>
      )}
    </Card>
  );
}
