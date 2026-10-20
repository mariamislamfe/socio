"use client";
import { AlertTriangle, ShieldAlert, TrendingUp, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useUi } from "@/components/providers";
import {
  Badge,
  Button,
  Card,
  clsx,
  ConfirmDialog,
  EmptyState,
  ErrorNote,
  Field,
  Hint,
  IconButton,
  Input,
  Modal,
  Money,
  MoneyInput,
  PageHeader,
  Select,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

interface Inv {
  id: string;
  name: string;
  kind: string;
  invested: number;
  started_on: string;
  closed_on: string | null;
  note: string | null;
  current: number;
  gain: number;
  returnPct: number;
  annualisedPct: number | null;
  days: number;
  marked: boolean;
  marked_on: string | null;
}
interface Data {
  currency: string;
  items: Inv[];
  totals: { invested: number; current: number };
  safeToInvest: {
    amount: number;
    cash: number;
    lowestCash60d: number;
    bufferHeld: number;
    bufferBasis: string;
    firstShortfall: string | null;
  };
}
const KINDS: Record<string, string> = {
  savings: "Savings account",
  deposit: "Bank deposit",
  certificate: "Bank certificate",
  gold: "Gold",
  stocks: "Stocks",
  fund: "Investment fund",
  real_estate: "Real estate",
  business: "Another business",
  other: "Other",
};

// Qualitative only: no return figures, because Socio does not know today's market rates.
const LEARN = [
  {
    k: "Bank savings & certificates",
    risk: 1,
    liquidity: 2,
    note: "Rates are set by the bank and change. Early withdrawal can cost you. Check the current rate and terms with the bank itself.",
  },
  {
    k: "Gold",
    risk: 2,
    liquidity: 3,
    note: "Holds value over long periods but the price swings, and buying/selling has a spread. Good for protecting savings, not for growing a business.",
  },
  {
    k: "Stocks & funds",
    risk: 3,
    liquidity: 3,
    note: "Can grow, can fall hard. Money you may need within a year does not belong here. Use regulated brokers only.",
  },
  {
    k: "Your own business (stock, ads, equipment)",
    risk: 3,
    liquidity: 1,
    note: "Often the highest return available to you — and the money is hardest to get back out. Test with a small batch first.",
  },
  {
    k: "Lending to someone / informal schemes",
    risk: 4,
    liquidity: 1,
    note: "Where most losses happen. If it is not regulated and written down, treat it as gone.",
  },
];

const RED_FLAGS = [
  "A fixed, “guaranteed” return that is far above what banks and regulated products offer",
  "Pressure to decide today, or a “last places” countdown",
  "Returns that depend on bringing in other people",
  "You cannot clearly explain where the profit comes from",
  "No regulator licence you can verify on the regulator's own website",
  "Withdrawals are delayed, or you are asked to reinvest to withdraw",
  "The offer arrives by chat message from someone you barely know",
];

function Meter({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink3" title={`${label}: ${n} of 4`}>
      {label}
      <span className="flex gap-0.5" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={clsx("h-1.5 w-3 rounded-full", i <= n ? "bg-accent" : "bg-line")} />
        ))}
      </span>
    </span>
  );
}

export default function InvestmentsPage() {
  const { biz } = useMe();
  const { toast } = useUi();
  const { data, error, isLoading, mutate } = useSWR<Data>("/api/investments");
  const [adding, setAdding] = useState(false);
  const [mark, setMark] = useState<Inv | null>(null);
  const [del, setDel] = useState<Inv | null>(null);
  const cur = data?.currency ?? biz?.currency.trim() ?? "EGP";
  const canWrite = biz && biz.role !== "viewer";

  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (isLoading && !data) return <Skeleton className="h-96" />;
  if (!data) return null;
  const s = data.safeToInvest;
  const gain = data.totals.current - data.totals.invested;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Investments"
        subtitle="Keep some of the profit working — carefully. Socio tells you how much you can safely spare and tracks what you chose. It never places a trade or recommends a product."
        actions={
          <Button variant="primary" disabled={!canWrite} onClick={() => setAdding(true)}>
            Record an investment
          </Button>
        }
      />

      {/* safe to invest */}
      <Card className="overflow-hidden">
        <div className="grid lg:grid-cols-[1.1fr_1fr]">
          <div className="p-6 sm:p-8">
            <div className="flex items-center gap-1">
              <span className="eyebrow">You could safely set aside</span>
              <Hint k="safe_to_invest" />
            </div>
            <p className="fig mt-1 text-5xl">
              <Money value={s.amount} currency={cur} />
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-ink2">
              {s.amount > 0
                ? "That is the money left after your lowest expected balance over the next 60 days, minus the safety buffer. Anything beyond it could leave a bill unpaid."
                : s.firstShortfall
                  ? `Not now. Scheduled payments already push you below zero on ${s.firstShortfall}. Fix cash first.`
                  : "Nothing to spare yet. Build your safety buffer first — it is the best “investment” a young business can make."}
            </p>
          </div>
          <dl className="space-y-3 border-t border-line bg-sunken/60 p-6 text-sm sm:p-8 lg:border-s lg:border-t-0">
            <div className="flex justify-between gap-4">
              <dt className="text-ink2">Cash today</dt>
              <dd className="num font-medium">{formatMoney(s.cash, cur)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink2">Lowest balance in 60 days</dt>
              <dd className={clsx("num font-medium", s.lowestCash60d < 0 && "text-neg")}>
                {formatMoney(s.lowestCash60d, cur)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink2">Safety buffer kept</dt>
              <dd className="num font-medium">− {formatMoney(s.bufferHeld, cur)}</dd>
            </div>
            <p className="text-xs text-ink3">
              Buffer basis: {s.bufferBasis}. Scheduled items only; sales are not assumed.
            </p>
          </dl>
        </div>
      </Card>

      {/* portfolio */}
      {data.items.length === 0 ? (
        <EmptyState
          icon={<TrendingUp className="size-6" />}
          title="Nothing tracked yet"
          body="When you put money somewhere — a bank certificate, gold, a new batch of stock — record it here, and update its value now and then. Socio shows the real return over time."
          action={
            canWrite && (
              <Button variant="primary" onClick={() => setAdding(true)}>
                Record an investment
              </Button>
            )
          }
        />
      ) : (
        <Card className="p-5 sm:p-7">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Tracked total</p>
              <p className="fig mt-1 text-3xl">
                <Money value={data.totals.current} currency={cur} />{" "}
                <span className="text-lg text-ink3">
                  from {formatMoney(data.totals.invested, cur, { compact: true })}
                </span>
              </p>
            </div>
            <p className={clsx("fig text-2xl", gain >= 0 ? "text-pos" : "text-neg")}>
              {formatMoney(gain, cur, { sign: true })}
            </p>
          </div>
          <ul className="mt-5 divide-y divide-line">
            {data.items.map((i) => (
              <li key={i.id} className="py-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-ink">
                      {i.name} <Badge>{KINDS[i.kind]}</Badge>
                      {i.closed_on && <Badge tone="neutral">Closed</Badge>}
                    </p>
                    <p className="mt-0.5 text-xs text-ink3">
                      Put in {formatMoney(i.invested, cur)} on {i.started_on} · {i.days} days
                      {i.marked ? ` · value as of ${i.marked_on}` : " · value not updated yet"}
                    </p>
                  </div>
                  <div className="text-end">
                    <p className="fig text-xl">{formatMoney(i.current, cur)}</p>
                    <p className={clsx("text-xs font-medium", i.gain >= 0 ? "text-pos" : "text-neg")}>
                      {formatMoney(i.gain, cur, { sign: true })} · {(i.returnPct * 100).toFixed(1)}%
                      {i.annualisedPct !== null ? ` · ${(i.annualisedPct * 100).toFixed(1)}%/yr` : ""}
                    </p>
                  </div>
                </div>
                {canWrite && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setMark(i)}>
                      Update value
                    </Button>
                    {!i.closed_on && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await api.patch(`/api/investments/${i.id}`, {
                            closed_on: new Date().toISOString().slice(0, 10),
                          });
                          mutate();
                        }}
                      >
                        Mark as closed
                      </Button>
                    )}
                    <IconButton label={`Delete ${i.name}`} className="ms-auto" onClick={() => setDel(i)}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink3">
            Values are what you tell Socio. Returns before fees and tax. Past results do not predict future ones.
          </p>
        </Card>
      )}

      <RealityCheck cur={cur} />

      {/* learn */}
      <Card className="p-5 sm:p-7">
        <h2 className="display text-xl">The shape of the options</h2>
        <p className="mt-1 text-sm text-ink2">
          No rates here on purpose — they change, and Socio will not quote one it cannot verify. This is how the options
          behave.
        </p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {LEARN.map((l) => (
            <li key={l.k} className="rounded-2xl border border-line p-4">
              <p className="text-sm font-semibold text-ink">{l.k}</p>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                <Meter n={l.risk} label="Risk" />
                <Meter n={l.liquidity} label="Locked up" />
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-ink2">{l.note}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 flex items-start gap-2 rounded-xl bg-infosoft px-3.5 py-3 text-[13px] text-ink">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
          Socio is not a licensed investment adviser. Before putting money into any financial product, confirm the
          provider is licensed by your financial regulator (in Egypt: the Central Bank for banks, the Financial
          Regulatory Authority for non-bank financial activities).
        </p>
      </Card>

      <AddInv
        open={adding}
        onClose={() => setAdding(false)}
        cur={cur}
        onSaved={() => {
          mutate();
          refreshAll();
          toast({ title: "Investment recorded" });
        }}
      />
      <MarkInv
        inv={mark}
        onClose={() => setMark(null)}
        cur={cur}
        onSaved={() => {
          mutate();
          toast({ title: "Value updated" });
        }}
      />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title="Delete this investment record?"
        body="Only the record in Socio is removed."
        onConfirm={async () => {
          await api.del(`/api/investments/${del!.id}`);
          mutate();
        }}
      />
    </div>
  );
}

function RealityCheck({ cur }: { cur: string }) {
  const [rate, setRate] = useState(10);
  const [per, setPer] = useState<"month" | "year">("month");
  const [amount, setAmount] = useState(10000);
  const r = useMemo(() => {
    const periods = per === "month" ? 12 : 1;
    const growth = Math.pow(1 + rate / 100, periods);
    return {
      annual: (growth - 1) * 100,
      final: amount * growth,
      simple: amount * (1 + (rate / 100) * periods),
      growth,
    };
  }, [rate, per, amount]);
  const suspicious = per === "month" ? rate >= 3 : rate >= 40;
  return (
    <Card className="p-5 sm:p-7">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-5 text-accent" aria-hidden />
        <h2 className="display text-xl">Reality check an offer</h2>
      </div>
      <p className="mt-1 text-sm text-ink2">
        Someone promised you a return? Put it here and see what it really implies.
      </p>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="space-y-4">
          <Field label={`Promised return per ${per}`} htmlFor="rc-r">
            <div className="flex items-center gap-3">
              <input
                id="rc-r"
                type="range"
                min={0.5}
                max={per === "month" ? 30 : 300}
                step={0.5}
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                className="h-2 w-full accent-[var(--accent)]"
              />
              <span className="num w-16 text-end text-lg font-semibold">{rate}%</span>
            </div>
          </Field>
          <div className="flex gap-2">
            {(["month", "year"] as const).map((p) => (
              <button
                key={p}
                onClick={() => (setPer(p), setRate(p === "month" ? 5 : 30))}
                aria-pressed={per === p}
                className={clsx(
                  "rounded-full border px-4 py-1.5 text-sm font-medium",
                  per === p ? "border-accent bg-accentsoft text-accent" : "border-line text-ink2",
                )}
              >
                per {p}
              </button>
            ))}
          </div>
          <Field label="Amount you would put in" htmlFor="rc-a">
            <Input
              id="rc-a"
              type="number"
              min={0}
              value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
            />
          </Field>
        </div>
        <motion.div layout className={clsx("rounded-2xl p-5", suspicious ? "bg-negsoft" : "bg-sunken")}>
          <p className="eyebrow">If it really paid that, compounding</p>
          <p className="fig mt-1 text-3xl">
            {r.annual >= 100000 ? ">100,000%" : `${r.annual.toFixed(0)}%`}{" "}
            <span className="text-lg text-ink3">a year</span>
          </p>
          <p className="mt-2 text-sm text-ink2">
            {formatMoney(Math.round(amount * 100), cur)} would become{" "}
            <strong className="text-ink">
              {formatMoney(Math.round(Math.min(r.final, 9e12) * 100), cur, { compact: true })}
            </strong>{" "}
            in 12 months.
          </p>
          <p className={clsx("mt-3 flex items-start gap-2 text-sm", suspicious ? "text-neg" : "text-ink2")}>
            {suspicious ? (
              <>
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> Steady returns like this do not exist
                in legitimate, regulated products. The money paying you is almost always other people&rsquo;s deposits.
              </>
            ) : (
              "Still ask who is paying it and who regulates them. A believable number is not proof."
            )}
          </p>
        </motion.div>
      </div>
      <details className="mt-5">
        <summary className="cursor-pointer text-sm font-medium text-ink">Common red flags</summary>
        <ul className="mt-2 space-y-1.5 text-sm text-ink2">
          {RED_FLAGS.map((f) => (
            <li key={f} className="flex gap-2">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-neg" aria-hidden />
              {f}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

function AddInv({
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
    kind: "deposit",
    invested: null as number | null,
    date: new Date().toISOString().slice(0, 10),
    note: "",
  });
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open)
      setF({ name: "", kind: "deposit", invested: null, date: new Date().toISOString().slice(0, 10), note: "" }),
        setErr({});
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Record an investment"
      description="You made the decision; Socio keeps track. Nothing here moves money."
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
                await api.post("/api/investments", {
                  name: f.name,
                  kind: f.kind,
                  invested: f.invested,
                  started_on: f.date,
                  note: f.note || undefined,
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
        {err._ && !err.name && !err.invested && (
          <p role="alert" className="text-sm text-neg">
            {err._}
          </p>
        )}
        <Field label="What is it?" error={err.name} htmlFor="iv-n">
          <Input
            id="iv-n"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder="e.g. 1-year certificate"
          />
        </Field>
        <Field label="Type" htmlFor="iv-k">
          <Select id="iv-k" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(KINDS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount put in" error={err.invested} htmlFor="iv-a">
            <MoneyInput
              id="iv-a"
              value={f.invested}
              onChange={(v) => setF({ ...f, invested: v })}
              currency={cur}
              digits={currencyDigits(cur)}
              invalid={!!err.invested}
            />
          </Field>
          <Field label="On" htmlFor="iv-d">
            <Input id="iv-d" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function MarkInv({
  inv,
  onClose,
  cur,
  onSaved,
}: {
  inv: Inv | null;
  onClose: () => void;
  cur: string;
  onSaved: () => void;
}) {
  const [v, setV] = useState<number | null>(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState("");
  useEffect(() => {
    if (inv) setV(inv.current), setErr("");
  }, [inv]);
  return (
    <Modal
      open={!!inv}
      onOpenChange={(o) => !o && onClose()}
      title={`Update value — ${inv?.name ?? ""}`}
      description="Enter what it is worth today, from your statement or the provider."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              if (v === null) return setErr("Enter the current value");
              try {
                await api.post(`/api/investments/${inv!.id}/marks`, { value: v, marked_on: date });
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
        <Field label="Worth today" error={err} htmlFor="mk-v">
          <MoneyInput
            id="mk-v"
            value={v}
            onChange={setV}
            currency={cur}
            digits={currencyDigits(cur)}
            invalid={!!err}
            autoFocus
          />
        </Field>
        <Field label="As of" htmlFor="mk-d">
          <Input id="mk-d" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
