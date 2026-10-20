"use client";
import { AlertTriangle, Settings2 } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import useSWR from "swr";
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
  Skeleton,
} from "@/components/ui";
import { api } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

type P = "week" | "month" | "quarter" | "year";
interface Line {
  key: string;
  label: string;
  amount: number | null;
  sign: 1 | -1 | 0;
  source: string;
  complete: boolean;
}
interface Prod {
  key: string;
  title: string;
  sku: string | null;
  units: number;
  revenue: number;
  cogs: number | null;
  variableCosts: number;
  contribution: number | null;
  margin: number | null;
  costKnown: boolean;
}
interface Data {
  period: { current: { from: string; to: string } };
  report: {
    currency: string;
    ladder: Line[];
    netProfit: number | null;
    missing: string[];
    products: Prod[];
    orders: number;
    hasOrders: boolean;
  };
  assumptions: {
    paymentFeeBps?: number | null;
    paymentFeeFixed?: number | null;
    packagingPerOrder?: number | null;
    shippingPerOrder?: number | null;
  };
}
const DEF: Record<string, { k: string; text: string }> = {
  revenue: { k: "revenue", text: "What customers paid for your products, minus refunds." },
  cogs: { k: "cogs", text: "What the products you sold cost you." },
  gross: { k: "gross_profit", text: "What is left after paying for what you sold." },
  fees: { k: "opex", text: "What payment providers keep from each order." },
  shipping: { k: "opex", text: "Getting orders to customers." },
  ads: { k: "roas", text: "What you spent to bring customers in." },
  contribution: { k: "profit", text: "What each sale really contributes after every cost that grows with sales." },
  opex: { k: "opex", text: "Costs that do not change with each order: rent, salaries, software." },
  operating: { k: "net_profit", text: "What remains after the costs we currently know about." },
};

export default function ProfitPage() {
  const { biz } = useMe();
  const [period, setPeriod] = useState<P>("month");
  const { data, error, isLoading, mutate } = useSWR<Data>(`/api/profit?period=${period}`, { keepPreviousData: true });
  const [edit, setEdit] = useState(false);
  const cur = data?.report.currency ?? biz?.currency.trim() ?? "EGP";
  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (isLoading && !data) return <Skeleton className="h-96" />;
  if (!data) return null;
  const r = data.report;
  const max = Math.max(1, ...r.ladder.map((l) => Math.abs(l.amount ?? 0)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="True profit"
        subtitle="From what you sold to what the business keeps, one step at a time. Every line says where its number came from. Missing costs are shown as missing — never as zero."
        actions={
          <>
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
            <Button onClick={() => setEdit(true)}>
              <Settings2 className="size-4" aria-hidden /> Cost assumptions
            </Button>
          </>
        }
      />

      {r.missing.length > 0 && (
        <Card className="border-warn/40 bg-warnsoft/50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
            <AlertTriangle className="size-4 text-warn" aria-hidden /> Profit is incomplete
          </p>
          <ul className="mt-1.5 space-y-1 text-[13px] text-ink2">
            {r.missing.map((m) => (
              <li key={m}>• {m}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" href="/app/products">
              Add product costs
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>
              Set fee & shipping assumptions
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow">
            {data.period.current.from} → {data.period.current.to}
          </p>
          {r.netProfit === null ? <DataLabel kind="incomplete" /> : <DataLabel kind="actual" />}
        </div>
        <ol className="mt-4 space-y-1">
          {r.ladder.map((l, i) => {
            const sub = l.sign === 0;
            const d = DEF[l.key];
            return (
              <motion.li
                key={l.key}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                className={clsx(
                  "grid items-center gap-x-4 gap-y-1 rounded-xl px-3 py-2.5 sm:grid-cols-[minmax(0,15rem)_1fr_auto]",
                  sub && "bg-sunken",
                )}
              >
                <div className="min-w-0">
                  <p className={clsx("flex items-center gap-1 text-sm", sub ? "font-semibold text-ink" : "text-ink2")}>
                    {l.sign === -1 && <span className="text-ink3">−</span>}
                    {l.label}
                    {d && <Hint k={d.k} />}
                  </p>
                  <p className="truncate text-xs text-ink3" title={l.source}>
                    {d?.text ?? l.source}
                  </p>
                </div>
                <div className="hidden h-2.5 rounded-full bg-line/50 sm:block">
                  {l.amount !== null && (
                    <motion.div
                      className={clsx(
                        "h-full rounded-full",
                        sub ? (l.amount < 0 ? "bg-neg" : "bg-accent") : l.sign === -1 ? "bg-ink3/50" : "bg-accent/70",
                      )}
                      initial={{ width: 0 }}
                      animate={{ width: `${(Math.abs(l.amount) / max) * 100}%` }}
                      transition={{ type: "spring", stiffness: 100, damping: 20 }}
                    />
                  )}
                </div>
                <div className="text-end">
                  {l.amount === null ? (
                    <Badge tone="warn">Missing</Badge>
                  ) : (
                    <Money
                      value={l.sign === -1 ? -l.amount : l.amount}
                      currency={cur}
                      className={clsx(sub ? "fig text-xl" : "text-sm", l.amount < 0 && sub && "text-neg")}
                    />
                  )}
                  <p className="text-[11px] text-ink3">{l.source}</p>
                </div>
              </motion.li>
            );
          })}
        </ol>
        <p className="mt-4 text-[13px] text-ink2">
          {r.netProfit === null
            ? "We can calculate your sales, but not a reliable profit until the missing costs above are added."
            : `On the costs recorded, the business kept ${formatMoney(r.netProfit, cur)} in this period.`}
        </p>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <h2 className="display text-xl">Which products make you money?</h2>
          <p className="mt-0.5 text-[13px] text-ink3">
            Contribution = product revenue − its cost − its share of fees and shipping. Advertising and fixed costs are
            not split per product (no reliable way to do it).
          </p>
        </div>
        {!r.hasOrders ? (
          <p className="p-6 text-sm text-ink2">
            Product-level profit needs individual orders.{" "}
            <Link href="/app/settings/integrations" className="font-medium text-accent underline">
              Connect Shopify
            </Link>{" "}
            to import them with their line items.
          </p>
        ) : r.products.length === 0 ? (
          <p className="p-6 text-sm text-ink3">No orders in this period.</p>
        ) : (
          <>
            {/* Phones: one card per product, contribution first. */}
            <ul className="divide-y divide-line md:hidden">
              {r.products.map((p) => (
                <li key={p.key} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-medium text-ink">{p.title}</p>
                    <p className={clsx("num shrink-0 text-sm font-medium", (p.contribution ?? 0) < 0 && "text-neg")}>
                      {p.contribution === null ? "Unknown" : formatMoney(p.contribution, cur, { compact: true })}
                      {p.margin !== null && (
                        <span className="ms-1 text-xs font-normal text-ink3">{Math.round(p.margin * 100)}%</span>
                      )}
                    </p>
                  </div>
                  <p className="mt-0.5 text-xs text-ink3">
                    {p.units} sold · {formatMoney(p.revenue, cur, { compact: true })} revenue ·{" "}
                    {p.cogs === null ? (
                      <Link href="/app/products" className="text-warn underline">
                        add cost
                      </Link>
                    ) : (
                      <>cost {formatMoney(p.cogs, cur, { compact: true })}</>
                    )}
                  </p>
                </li>
              ))}
            </ul>
            <div className="scroll-thin hidden overflow-x-auto md:block">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr>
                    {["Product", "Units", "Revenue", "Cost", "Fees & shipping", "Contribution", "Margin"].map(
                      (h, i) => (
                        <th key={h} className={clsx("eyebrow px-4 py-3 font-normal", i ? "text-end" : "text-start")}>
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {r.products.map((p) => (
                    <tr key={p.key} className="border-t border-line">
                      <td className="px-4 py-3">
                        <span className="font-medium text-ink">{p.title}</span>
                        {p.sku && <span className="ms-2 text-xs text-ink3">{p.sku}</span>}
                      </td>
                      <td className="num px-4 py-3 text-end">{p.units}</td>
                      <td className="num px-4 py-3 text-end">{formatMoney(p.revenue, cur, { compact: true })}</td>
                      <td className="num px-4 py-3 text-end">
                        {p.cogs === null ? (
                          <Link href="/app/products" className="text-warn underline">
                            add cost
                          </Link>
                        ) : (
                          formatMoney(p.cogs, cur, { compact: true })
                        )}
                      </td>
                      <td className="num px-4 py-3 text-end">{formatMoney(p.variableCosts, cur, { compact: true })}</td>
                      <td
                        className={clsx("num px-4 py-3 text-end font-medium", (p.contribution ?? 0) < 0 && "text-neg")}
                      >
                        {p.contribution === null ? "—" : formatMoney(p.contribution, cur, { compact: true })}
                      </td>
                      <td className="num px-4 py-3 text-end">
                        {p.margin === null ? "—" : `${Math.round(p.margin * 100)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
      <Assumptions
        open={edit}
        onClose={() => setEdit(false)}
        init={data.assumptions}
        cur={cur}
        onSaved={() => {
          mutate();
          refreshAll();
        }}
      />
    </div>
  );
}

function Assumptions({
  open,
  onClose,
  init,
  cur,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  init: Data["assumptions"];
  cur: string;
  onSaved: () => void;
}) {
  const { toast } = useUi();
  const [f, setF] = useState(init);
  const [pct, setPct] = useState("");
  useEffect(() => {
    if (open) setF(init), setPct(init.paymentFeeBps ? String(init.paymentFeeBps / 100) : "");
  }, [open, init]);
  const d = currencyDigits(cur);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Cost assumptions"
      description="Only used when the matching costs are NOT already in your ledger, so nothing is counted twice. Leave empty to show the cost as missing."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              await api.patch("/api/profit/assumptions", {
                ...f,
                paymentFeeBps: pct === "" ? null : Math.round(Number(pct) * 100),
              });
              toast({ title: "Assumptions saved", description: "Shown as assumptions wherever they are used." });
              onSaved();
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Payment fee (% of each order)" htmlFor="fp" hint="E.g. 2.9 for 2.9%.">
          <Input
            id="fp"
            inputMode="decimal"
            value={pct}
            onChange={(e) => setPct(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </Field>
        <Field label="Fixed fee per order" htmlFor="ff">
          <MoneyInput
            id="ff"
            value={f.paymentFeeFixed ?? null}
            onChange={(v) => setF({ ...f, paymentFeeFixed: v })}
            currency={cur}
            digits={d}
          />
        </Field>
        <Field label="Packaging per order" htmlFor="pk">
          <MoneyInput
            id="pk"
            value={f.packagingPerOrder ?? null}
            onChange={(v) => setF({ ...f, packagingPerOrder: v })}
            currency={cur}
            digits={d}
          />
        </Field>
        <Field label="Shipping cost per order" htmlFor="sh">
          <MoneyInput
            id="sh"
            value={f.shippingPerOrder ?? null}
            onChange={(v) => setF({ ...f, shippingPerOrder: v })}
            currency={cur}
            digits={d}
          />
        </Field>
      </div>
    </Modal>
  );
}
