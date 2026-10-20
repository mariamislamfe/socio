"use client";
import { Building2, HandCoins, Info, UserRound } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import useSWR from "swr";
import { useUi } from "@/components/providers";
import {
  Badge,
  Button,
  Card,
  clsx,
  ErrorNote,
  Field,
  Hint,
  Modal,
  MoneyInput,
  PageHeader,
  Segmented,
  Select,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import type { MoneyPlan, Slice } from "@/lib/finance/moneyplan";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

interface Data {
  currency: string;
  today: string;
  plan: MoneyPlan;
  accounts: { id: string; name: string }[];
  vatRegistered: boolean;
}

const COLOR: Record<Slice["key"], string> = {
  product: "#a8742b",
  tax: "#7a4f4f",
  ads: "#b4513a",
  shipping: "#4f6d8a",
  people: "#5b4f8a",
  rent: "#8a6a4f",
  other: "#6b7a72",
  owner: "#2f5d7d",
  keep: "#2f7d5b",
  loss: "#c0392b",
};

export default function PlanPage() {
  const { biz } = useMe();
  const { data, error, mutate } = useSWR<Data>("/api/money-plan");
  const [paying, setPaying] = useState(false);
  const { toast } = useUi();
  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (!data) return <Skeleton className="h-96" />;
  const cur = data.currency;
  const fm = (v: number) => formatMoney(v, cur);
  const p = data.plan;
  const admin = biz && (biz.role === "owner" || biz.role === "admin");
  const costSlices = p.slices.filter((s) => !["owner", "keep", "loss"].includes(s.key));
  const pos = p.slices.filter((s) => s.amount > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your money plan"
        subtitle="What you can safely take for yourself, what the business can still spend, and where every 100 of sales really goes. Your money and the business's money, kept apart."
      />

      {/* Safe to spend */}
      <div className="grid gap-4 lg:grid-cols-2">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <Card className={clsx("h-full p-5 sm:p-6", p.owner.status === "ok" ? "border-pos/40" : "border-warn/40")}>
            <div className="flex items-center gap-2">
              <UserRound className="size-5 text-accent" aria-hidden />
              <p className="eyebrow">For you · this month</p>
            </div>
            <p className="display mt-2 text-4xl">
              <span className={p.owner.canTakeNow > 0 ? "text-pos" : "text-ink"}>{fm(p.owner.canTakeNow)}</span>
            </p>
            <p className="mt-1 text-[15px] text-ink2">you can safely take for yourself now.</p>
            <p className="mt-3 text-[13px] text-ink3">{p.owner.reason}</p>
            {p.owner.avgMonthlyProfit !== null && p.owner.avgMonthlyProfit > 0 && (
              <dl className="mt-4 grid grid-cols-3 gap-3 text-[13px]">
                <div>
                  <dt className="text-ink3">Business earns</dt>
                  <dd className="num font-medium text-ink">
                    {fm(p.owner.avgMonthlyProfit)}
                    <span className="text-ink3">/mo</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-ink3">Your share ({p.owner.pct}%)</dt>
                  <dd className="num font-medium text-ink">{fm(p.owner.suggestedMonthly)}</dd>
                </div>
                <div>
                  <dt className="text-ink3">Already taken</dt>
                  <dd className="num font-medium text-ink">{fm(p.owner.takenThisMonth)}</dd>
                </div>
              </dl>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {admin && (
                <ShareControl
                  pct={p.owner.pct}
                  onSaved={() => {
                    mutate();
                  }}
                />
              )}
              <span className="flex-1" />
              <Button size="sm" onClick={() => setPaying(true)}>
                <HandCoins className="size-4" aria-hidden /> I took my pay
              </Button>
            </div>
          </Card>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
          <Card className="h-full p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <Building2 className="size-5 text-accent" aria-hidden />
              <p className="eyebrow">For the business · today</p>
            </div>
            <p className="display mt-2 text-4xl">
              <span className={p.business.canSpend > 0 ? "text-ink" : "text-warn"}>{fm(p.business.canSpend)}</span>
            </p>
            <p className="mt-1 text-[15px] text-ink2">it can still spend, beyond the bills already planned.</p>
            <p className="mt-3 text-[13px] text-ink3">{p.business.reason}</p>
            <ul className="mt-4 space-y-1.5 text-[13px]">
              <Row label="Cash you have" value={fm(p.safe.cash)} />
              <Row label="− Belongs to the tax office" value={fm(p.safe.taxes)} minus />
              <Row label="− Bills in the next 30 days" value={fm(p.safe.bills30)} minus />
              <Row label="− Your safety reserve" value={fm(p.safe.reserve)} minus />
              <Row label={`− Your pay now`} value={fm(p.owner.canTakeNow)} minus />
              <li className="flex justify-between border-t border-line pt-1.5 font-semibold">
                <span>= Free to spend</span>
                <span className={clsx("num", p.business.canSpend > 0 ? "text-pos" : "text-warn")}>
                  {fm(p.business.canSpend)}
                </span>
              </li>
            </ul>
          </Card>
        </motion.div>
      </div>

      {/* Where every 100 goes */}
      <Card className="p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Last 30 days</p>
            <h2 className="display mt-1 text-2xl">From every 100 you sell…</h2>
            <p className="mt-1 text-[13px] text-ink3">
              Each sale is split like this. This is what “profit” really means — and why sales are not money you can
              spend.
            </p>
          </div>
          <Badge tone="neutral">
            {p.period.from} → {p.period.to}
          </Badge>
        </div>
        <div
          className="mt-5 flex h-12 w-full overflow-hidden rounded-2xl bg-sunken"
          role="img"
          aria-label="How each 100 of sales is split"
        >
          {pos.map((s, i) => (
            <motion.div
              key={s.key}
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(0, s.per100)}%` }}
              transition={{ delay: 0.06 * i, duration: 0.7, ease: "easeOut" }}
              style={{ background: COLOR[s.key] }}
              className="relative h-full"
              title={`${s.label}: ${s.per100}`}
            >
              {s.per100 >= 7 && (
                <span className="absolute inset-0 grid place-items-center text-[12px] font-semibold text-white">
                  {Math.round(s.per100)}
                </span>
              )}
            </motion.div>
          ))}
        </div>
        <ul className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {p.slices.map((s) => (
            <li key={s.key} className="flex items-center gap-2 text-[14px]">
              <span className="size-3 shrink-0 rounded-full" style={{ background: COLOR[s.key] }} />
              <span
                className={clsx("flex-1", s.key === "owner" || s.key === "keep" ? "font-medium text-ink" : "text-ink2")}
              >
                {s.label}
              </span>
              <span className="num text-ink3">{fm(s.amount)}</span>
              <span className={clsx("num w-12 text-end font-semibold", s.key === "loss" ? "text-neg" : "text-ink")}>
                {s.per100}
              </span>
            </li>
          ))}
        </ul>
        {costSlices.length > 0 && p.numbers.revenue > 0 && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-ink3">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {data.vatRegistered
              ? "Taxes = the VAT inside your sales (estimated), which you collect for the tax office."
              : "Taxes = tax payments recorded in this period."}{" "}
            Your pay and what stays in the business are split from the profit using your share ({p.owner.pct}%).
          </p>
        )}
      </Card>

      {/* The numbers */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Num label="Sales (revenue)" k="revenue" value={fm(p.numbers.revenue)} />
        <Num label="Gross profit" k="gross_profit" value={fm(p.numbers.grossProfit)} sub="Sales − product costs" />
        <Num
          label="Profit after everything"
          k="net_profit"
          value={fm(p.numbers.profit)}
          sub="After running costs and taxes"
          tone={p.numbers.profit < 0 ? "neg" : "pos"}
        />
        <Num label="You took" value={fm(p.numbers.ownerTook)} sub="Your pay is not a business cost" />
      </div>

      <PayDialog
        open={paying}
        onClose={() => setPaying(false)}
        cur={cur}
        suggested={p.owner.canTakeNow}
        accounts={data.accounts}
        onDone={() => {
          mutate();
          refreshAll();
          toast({ title: "Recorded", description: "Your cash went down; the business's profit did not." });
        }}
      />
    </div>
  );
}

function Row({ label, value, minus }: { label: string; value: string; minus?: boolean }) {
  return (
    <li className="flex justify-between">
      <span className="text-ink2">{label}</span>
      <span className={clsx("num", minus ? "text-ink3" : "text-ink")}>{value}</span>
    </li>
  );
}

function Num({
  label,
  value,
  sub,
  tone,
  k,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg";
  k?: string;
}) {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1 text-[12px] uppercase tracking-wide text-ink3">
        {label}
        {k && <Hint k={k} />}
      </p>
      <p className={clsx("fig mt-1 text-2xl", tone === "neg" ? "text-neg" : tone === "pos" ? "text-pos" : "text-ink")}>
        {value}
      </p>
      {sub && <p className="text-xs text-ink3">{sub}</p>}
    </Card>
  );
}

function ShareControl({ pct, onSaved }: { pct: number; onSaved: () => void }) {
  const opts = ["25", "50", "75"] as const;
  const v = (opts as readonly string[]).includes(String(pct)) ? (String(pct) as (typeof opts)[number]) : "50";
  return (
    <div className="flex items-center gap-2 text-[13px] text-ink3">
      <span>Your share of profit</span>
      <Segmented
        value={v}
        onChange={async (x) => {
          await api.patch("/api/money-plan", { ownerPayPct: Number(x) });
          onSaved();
        }}
        options={opts.map((o) => ({ value: o, label: `${o}%` }))}
        label="Your share of profit"
      />
    </div>
  );
}

function PayDialog({
  open,
  onClose,
  cur,
  suggested,
  accounts,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  cur: string;
  suggested: number;
  accounts: { id: string; name: string }[];
  onDone: () => void;
}) {
  const [amount, setAmount] = useState<number | null>(null);
  const [acc, setAcc] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Record your pay"
      description="Money you took from the business for yourself. It lowers cash, not profit."
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
              setErr("");
              try {
                await api.post("/api/money-plan/owner-pay", {
                  amount: amount ?? suggested,
                  accountId: acc || accounts[0]?.id,
                });
                onDone();
                onClose();
              } catch (x) {
                setErr(x instanceof ApiError ? x.message : "Could not record it.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Record
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Amount">
          <MoneyInput value={amount ?? suggested} onChange={setAmount} currency={cur} digits={currencyDigits(cur)} />
        </Field>
        <Field label="From account">
          <Select value={acc || accounts[0]?.id || ""} onChange={(e) => setAcc(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        {err && <p className="text-sm text-neg">{err}</p>}
      </div>
    </Modal>
  );
}
