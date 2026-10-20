"use client";
import { AlertTriangle, Megaphone } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { RevenueBars } from "@/components/charts";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Hint,
  MetricLabel,
  Money,
  PageHeader,
  Segmented,
  Skeleton,
} from "@/components/ui";
import { useMe } from "@/lib/client/hooks";
import { formatMoney } from "@/lib/finance/money";

interface Ads {
  currency: string;
  ads: {
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
  };
  previous: { spend: number; roas: number | null };
  recordedSpend: number;
  revenue: number;
  grossMargin: number | null;
  breakEvenRoas: number | null;
  marginIncomplete: boolean;
  adShareOfRevenue: number | null;
  integrations: { provider: string; status: string; last_sync_at: string | null; last_error: string | null }[];
}
type P = "week" | "month" | "quarter" | "year";
const NAME: Record<string, string> = { meta_ads: "Meta Ads", google_ads: "Google Ads" };

export default function AdsPage() {
  const { biz } = useMe();
  const [period, setPeriod] = useState<P>("month");
  const { data, error, isLoading, mutate } = useSWR<Ads>(`/api/ads?period=${period}`, { keepPreviousData: true });
  const cur = data?.currency ?? biz?.currency.trim() ?? "EGP";
  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (isLoading && !data) return <Skeleton className="h-96" />;
  if (!data) return null;
  const a = data.ads;
  const has = a.spend > 0 || a.campaigns.length > 0;
  const below = data.breakEvenRoas !== null && a.roas !== null && a.roas < data.breakEvenRoas;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Advertising"
        subtitle="What your ads cost, what the platforms say they returned, and whether that return actually covers your product costs."
        actions={
          <Segmented
            label="Period"
            value={period}
            onChange={setPeriod}
            options={[
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
              { value: "quarter", label: "Quarter" },
              { value: "year", label: "Year" },
            ]}
          />
        }
      />

      <Card className="flex flex-wrap items-start gap-3 border-info/30 bg-infosoft/50 p-4 text-sm text-ink2">
        <Hint k="roas" />
        <p className="min-w-0 flex-1">
          <strong className="text-ink">ROAS is not profit.</strong> It is revenue the ad platform attributes to ads,
          divided by what you spent. Product costs, shipping and fees still come out of that revenue, and platform
          attribution can differ from your own sales.
        </p>
      </Card>

      {!has ? (
        <EmptyState
          icon={<Megaphone className="size-6" />}
          title="No advertising data yet"
          body={
            data.recordedSpend > 0
              ? `You have recorded ${formatMoney(data.recordedSpend, cur)} of advertising expenses in this period, but no platform data (clicks, conversions, attributed revenue). Connect Meta Ads or Google Ads to see returns.`
              : "Connect Meta Ads or Google Ads to import spend, clicks and conversions — or simply record advertising as expenses and Socio will track it against budget."
          }
          action={
            <>
              <Button href="/app/settings/integrations" variant="primary">
                See integrations
              </Button>
              <Button href="/app/transactions?new=expense">Record ad spend</Button>
            </>
          }
        />
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="grid divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
              <div className="p-5">
                <span className="eyebrow">Platform ad spend</span>
                <p className="fig mt-1 text-3xl">
                  <Money value={a.spend} currency={cur} />
                </p>
                <p className="mt-1 text-xs text-ink3">{a.providers.map((p) => NAME[p] ?? p).join(" + ")}</p>
              </div>
              <div className="p-5">
                <span className="eyebrow">Attributed revenue</span>
                <p className="fig mt-1 text-3xl">
                  <Money value={a.attributedRevenue} currency={cur} />
                </p>
                <p className="mt-1 text-xs text-ink3">as reported by the platform</p>
              </div>
              <div className="p-5">
                <MetricLabel k="roas" term="ROAS" question={false} />
                <p className="fig mt-1 text-3xl">{a.roas !== null ? a.roas.toFixed(2) : "—"}</p>
                <p className="mt-1 text-xs text-ink3">
                  {data.previous.roas !== null ? `last period ${data.previous.roas.toFixed(2)}` : "no prior period"}
                </p>
              </div>
              <div className="p-5">
                <MetricLabel k="break_even_roas" term="Break-even ROAS" question={false} />
                <p className="fig mt-1 text-3xl">{data.breakEvenRoas !== null ? data.breakEvenRoas.toFixed(2) : "—"}</p>
                <p className="mt-1 text-xs text-ink3">
                  {data.breakEvenRoas !== null
                    ? `from a ${Math.round((data.grossMargin ?? 0) * 100)}% gross margin`
                    : data.marginIncomplete
                      ? "needs product costs"
                      : "needs revenue"}
                </p>
              </div>
            </div>
            {below && (
              <div className="flex items-start gap-3 border-t border-line bg-warnsoft px-5 py-3.5 text-sm text-ink">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                <p>
                  Your ROAS ({a.roas!.toFixed(2)}) is below the break-even ({data.breakEvenRoas!.toFixed(2)}): on these
                  numbers, ad-driven sales are not covering their product costs, before shipping and fees.
                </p>
              </div>
            )}
            {data.marginIncomplete && (
              <div className="flex items-start gap-3 border-t border-line bg-warnsoft px-5 py-3.5 text-sm text-ink">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                <p>
                  Break-even needs your product costs, which are missing.{" "}
                  <Link href="/app/products" className="font-medium text-accent underline">
                    Add them
                  </Link>
                  .
                </p>
              </div>
            )}
          </Card>

          <div className="grid gap-5 lg:grid-cols-12">
            <Card className="p-5 sm:p-6 lg:col-span-7">
              <h2 className="display text-xl">Spend and attributed revenue</h2>
              <div className="mt-4">
                <RevenueBars
                  data={a.daily.map((d) => ({
                    label: d.date.slice(5),
                    from: d.date,
                    revenue: d.revenue,
                    expenses: d.spend,
                    profit: d.revenue - d.spend,
                  }))}
                  currency={cur}
                  label="Daily attributed revenue (green) versus ad spend (grey)"
                />
              </div>
            </Card>
            <Card className="p-5 sm:p-6 lg:col-span-5">
              <h2 className="display text-xl">Efficiency</h2>
              <dl className="mt-4 space-y-3 text-sm">
                {[
                  ["Clicks", a.clicks.toLocaleString()],
                  ["Click-through rate", a.ctr !== null ? `${(a.ctr * 100).toFixed(2)}%` : "—"],
                  ["Cost per click", a.cpc !== null ? formatMoney(a.cpc, cur) : "—"],
                  ["Conversions", Math.round(a.conversions).toLocaleString()],
                  ["Cost per conversion", a.cpa !== null ? formatMoney(a.cpa, cur) : "—"],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between border-b border-line pb-2 last:border-0">
                    <dt className="text-ink2">{k}</dt>
                    <dd className="num font-medium text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-5 rounded-xl bg-sunken p-3.5 text-[13px] text-ink2">
                <p>
                  <strong className="text-ink">Recorded as expenses:</strong> {formatMoney(data.recordedSpend, cur)}
                  {data.adShareOfRevenue !== null && ` (${Math.round(data.adShareOfRevenue * 100)}% of net revenue)`}.
                </p>
                <p className="mt-1.5 text-ink3">
                  Platform spend is kept separate from your ledger so ads are never counted twice. If the two differ,
                  you may be missing an expense record.
                </p>
              </div>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <h2 className="display text-xl">Campaigns</h2>
            </div>
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="text-start">
                    <th className="eyebrow px-5 py-3 text-start font-normal">Campaign</th>
                    <th className="eyebrow px-3 py-3 text-end font-normal">Spend</th>
                    <th className="eyebrow px-3 py-3 text-end font-normal">Attributed</th>
                    <th className="eyebrow px-3 py-3 text-end font-normal">ROAS</th>
                    <th className="eyebrow px-5 py-3 text-end font-normal">Conv.</th>
                  </tr>
                </thead>
                <tbody>
                  {a.campaigns.map((c) => (
                    <tr key={c.provider + c.id} className="border-t border-line">
                      <td className="px-5 py-3">
                        <span className="font-medium text-ink">{c.name || c.id}</span>{" "}
                        <Badge>{NAME[c.provider] ?? c.provider}</Badge>
                      </td>
                      <td className="num px-3 py-3 text-end">{formatMoney(c.spend, cur, { compact: true })}</td>
                      <td className="num px-3 py-3 text-end">
                        {formatMoney(c.attributedRevenue, cur, { compact: true })}
                      </td>
                      <td className="num px-3 py-3 text-end font-medium">
                        <span
                          className={
                            data.breakEvenRoas !== null && c.roas !== null && c.roas < data.breakEvenRoas
                              ? "text-neg"
                              : "text-ink"
                          }
                        >
                          {c.roas !== null ? c.roas.toFixed(2) : "—"}
                        </span>
                      </td>
                      <td className="num px-5 py-3 text-end">{Math.round(c.conversions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
