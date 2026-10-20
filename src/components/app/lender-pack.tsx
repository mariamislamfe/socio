"use client";
import { BadgeCheck, Printer, ShieldCheck } from "lucide-react";
import { AreaLine } from "@/components/charts";
import { Badge, Button, Card, clsx } from "@/components/ui";
import type { LenderPack } from "@/lib/finance/lenderpack";
import { formatMoney } from "@/lib/finance/money";

export function LenderPackView({
  pack,
  fingerprint,
  verified,
  recipient,
  expiresAt,
  preview,
}: {
  pack: LenderPack;
  fingerprint: string;
  verified?: boolean;
  recipient?: string | null;
  expiresAt?: string;
  preview?: boolean;
}) {
  const cur = pack.business.currency;
  const fm = (v: number) => formatMoney(v, cur);
  const totals = pack.months.reduce((a, m) => ({ revenue: a.revenue + m.revenue, net: a.net + m.netProfit }), {
    revenue: 0,
    net: 0,
  });
  return (
    <div className="space-y-5 print:space-y-3">
      <Card className="p-5 sm:p-7 print:border-0 print:p-0 print:shadow-none">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Financing file{preview ? " · preview (not shared)" : ""}</p>
            <h1 className="display mt-1 text-3xl">{pack.business.name}</h1>
            <p className="text-[13px] text-ink3">
              {[pack.business.type, pack.business.country].filter(Boolean).join(" · ")} · figures in {cur} · generated{" "}
              {pack.generatedOn}
              {recipient ? ` · prepared for ${recipient}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2 print:hidden">
            {verified !== undefined && (
              <Badge tone={verified ? "pos" : "neg"}>
                {verified ? (
                  <>
                    <BadgeCheck className="size-3.5" /> Unchanged since generation
                  </>
                ) : (
                  "Fingerprint mismatch"
                )}
              </Badge>
            )}
            <Button size="sm" onClick={() => window.print()}>
              <Printer className="size-4" aria-hidden /> Print / PDF
            </Button>
          </div>
        </div>
        {pack.request && (
          <div className="mt-5 grid gap-3 rounded-2xl bg-sunken p-4 sm:grid-cols-3">
            <div>
              <p className="eyebrow">Requested</p>
              <p className="fig text-2xl">{fm(pack.request.amount)}</p>
            </div>
            <div>
              <p className="eyebrow">Purpose</p>
              <p className="text-[15px] text-ink">{pack.request.purpose}</p>
            </div>
            <div>
              <p className="eyebrow">Proposed repayment</p>
              <p className="text-[15px] text-ink">
                {pack.request.repayment.length
                  ? `${pack.request.repayment.length} payment${pack.request.repayment.length > 1 ? "s" : ""}, last on ${pack.request.repayment[pack.request.repayment.length - 1].date}`
                  : "To be agreed"}
              </p>
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2 print:grid-cols-2">
        <Card className="p-5 print:break-inside-avoid">
          <h2 className="text-[15px] font-semibold text-ink">Monthly results</h2>
          <p className="text-xs text-ink3">
            Last six months and this month to date. Total sales {fm(totals.revenue)}, total profit {fm(totals.net)}.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-[13px]">
              <thead>
                <tr className="text-ink3">
                  {["Month", "Sales", "Product costs", "Gross profit", "Running costs", "Profit"].map((h, i) => (
                    <th key={h} className={clsx("px-2 py-1.5 font-normal", i ? "text-end" : "text-start")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pack.months.map((m) => (
                  <tr key={m.month} className="border-t border-line">
                    <td className="px-2 py-1.5">{m.month}</td>
                    <td className="num px-2 py-1.5 text-end">{fm(m.revenue)}</td>
                    <td className="num px-2 py-1.5 text-end">{fm(m.cogs)}</td>
                    <td className="num px-2 py-1.5 text-end">{fm(m.grossProfit)}</td>
                    <td className="num px-2 py-1.5 text-end">{fm(m.opex)}</td>
                    <td className={clsx("num px-2 py-1.5 text-end font-medium", m.netProfit < 0 && "text-neg")}>
                      {fm(m.netProfit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card className="p-5 print:break-inside-avoid">
          <h2 className="text-[15px] font-semibold text-ink">Cash today</h2>
          <p className="fig mt-1 text-3xl">{fm(pack.cash.total)}</p>
          <ul className="mt-2 space-y-1 text-[13px]">
            {pack.cash.accounts.map((a) => (
              <li key={a.name} className="flex justify-between">
                <span className="text-ink2">{a.name}</span>
                <span className="num">{fm(a.balance)}</span>
              </li>
            ))}
          </ul>
          {pack.cash.pendingNonCash > 0 && (
            <p className="mt-2 text-xs text-ink3">
              Plus {fm(pack.cash.pendingNonCash)} awaiting payout (not counted as cash).
            </p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-4">
            <Aging title="Customers owe" rows={pack.receivables} fm={fm} />
            <Aging title="Bills to pay" rows={pack.payables} fm={fm} />
          </div>
        </Card>
      </div>

      <Card className="p-5 print:break-inside-avoid">
        <h2 className="text-[15px] font-semibold text-ink">
          13-week cash forecast{pack.weeks.some((w) => w.withLoan !== null) ? ", with and without the financing" : ""}
        </h2>
        <div className="mt-3">
          <AreaLine
            series={pack.weeks.map((w) => ({ date: w.weekStart, value: w.endBalance }))}
            compare={
              pack.weeks.some((w) => w.withLoan !== null)
                ? pack.weeks.map((w) => ({ date: w.weekStart, value: w.withLoan ?? w.endBalance }))
                : undefined
            }
            seriesLabel="Without"
            compareLabel="With financing"
            currency={cur}
            height={200}
            label="13-week cash forecast"
          />
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-[12px]">
            <thead>
              <tr className="text-ink3">
                <th className="px-2 py-1 text-start font-normal">Week from</th>
                <th className="px-2 py-1 text-end font-normal">Money in</th>
                <th className="px-2 py-1 text-end font-normal">Money out</th>
                <th className="px-2 py-1 text-end font-normal">Cash at end</th>
                {pack.weeks.some((w) => w.withLoan !== null) && (
                  <th className="px-2 py-1 text-end font-normal">With financing</th>
                )}
              </tr>
            </thead>
            <tbody>
              {pack.weeks.map((w) => (
                <tr key={w.weekStart} className="border-t border-line">
                  <td className="px-2 py-1">{w.weekStart}</td>
                  <td className="num py-1 text-end">{fm(w.inflows)}</td>
                  <td className="num py-1 text-end">{fm(w.outflows)}</td>
                  <td className={clsx("num py-1 text-end", w.endBalance < 0 && "text-neg")}>{fm(w.endBalance)}</td>
                  {w.withLoan !== null && <td className="num py-1 text-end">{fm(w.withLoan)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-5 print:break-inside-avoid">
        <div className="flex flex-wrap items-start gap-3">
          <ShieldCheck className="size-5 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-ink">How these numbers were produced</h2>
            <p className="text-[13px] text-ink2">
              Data completeness {pack.dataQuality.score}/100
              {pack.dataQuality.issues.length ? ` — ${pack.dataQuality.issues.join(" ")}` : ""}
            </p>
            <ul className="mt-2 space-y-1 text-[13px] text-ink2">
              {[...pack.dataQuality.sources.map((s) => `Source: ${s}`), ...pack.basis].map((b, i) => (
                <li key={i}>• {b}</li>
              ))}
            </ul>
            <p className="mt-3 break-all font-mono text-[11px] text-ink3">Fingerprint (SHA-256): {fingerprint}</p>
            {expiresAt && (
              <p className="text-[11px] text-ink3">
                This read-only link expires {expiresAt.slice(0, 16).replace("T", " ")}.
              </p>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function Aging({
  title,
  rows,
  fm,
}: {
  title: string;
  rows: { bucket: string; amount: number }[];
  fm: (v: number) => string;
}) {
  return (
    <div>
      <p className="text-[13px] font-medium text-ink">{title}</p>
      <ul className="mt-1 space-y-0.5 text-[12px]">
        {rows.map((r) => (
          <li key={r.bucket} className="flex justify-between gap-2">
            <span className="text-ink3">{r.bucket}</span>
            <span className={clsx("num", r.bucket.includes("late") && r.amount > 0 ? "text-warn" : "text-ink")}>
              {fm(r.amount)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
