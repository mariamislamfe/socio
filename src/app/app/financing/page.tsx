"use client";
import {
  AlertOctagon,
  CheckCircle2,
  ExternalLink,
  FileText,
  Link2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
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
  Input,
  Modal,
  MoneyInput,
  PageHeader,
  Select,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

interface Flag {
  level: "danger" | "warning";
  text: string;
}
interface OfferA {
  offer: {
    id: string;
    lender: string;
    kind: string;
    amount: number;
    upfrontFee: number;
    ratePct: number | null;
    flatFee: number | null;
    termDays: number;
    repayment: string;
    revenueSharePct: number | null;
    source?: string;
  };
  received: number;
  totalRepaid: number;
  cost: number;
  apr: number | null;
  payoffDate: string;
  covers: boolean;
  newLowest: number;
  newBreachDate: string | null;
  flags: Flag[];
  verdict: "best" | "ok" | "risky" | "avoid";
  explanation: string;
}
interface Share {
  id: string;
  recipient: string;
  fingerprint: string;
  expiresAt: string;
  revokedAt: string | null;
  views: number;
  lastViewedAt: string | null;
  createdAt: string;
  url: string | null;
}
interface Data {
  currency: string;
  today: string;
  reserve: number | null;
  baseLowest: number;
  kinds: Record<string, string>;
  need: {
    basis: string;
    atRisk: boolean;
    amount: number;
    neededBy: string | null;
    lowest: number;
    lowestDate: string;
    reserve: number;
    horizonDays: number;
  };
  offers: OfferA[];
  shares: Share[];
  readiness: {
    score: number;
    band: "strong" | "fair" | "weak";
    summary: string;
    checks: {
      key: string;
      label: string;
      points: number;
      max: number;
      ok: boolean;
      detail: string;
      how: string | null;
    }[];
  };
}

const VERDICT: Record<
  OfferA["verdict"],
  { label: string; tone: "pos" | "info" | "warn" | "neg"; icon: typeof CheckCircle2 }
> = {
  best: { label: "Best choice", tone: "pos", icon: CheckCircle2 },
  ok: { label: "Workable", tone: "info", icon: ShieldCheck },
  risky: { label: "Not enough / risky", tone: "warn", icon: TriangleAlert },
  avoid: { label: "Avoid", tone: "neg", icon: AlertOctagon },
};
const REPAY: Record<string, string> = {
  bullet: "in one payment",
  monthly: "monthly",
  weekly: "weekly",
  daily_sales: "from daily sales",
};

export default function FinancingPage() {
  const { biz } = useMe();
  const { data, error, isLoading, mutate } = useSWR<Data>("/api/financing");
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState<OfferA | null | "none">(null);
  const [remove, setRemove] = useState<OfferA | null>(null);
  const { toast } = useUi();
  const admin = biz && (biz.role === "owner" || biz.role === "admin");
  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (isLoading || !data) return <Skeleton className="h-96" />;
  const cur = data.currency;
  const fm = (v: number) => formatMoney(v, cur);
  const n = data.need;
  const best = data.offers.find((o) => o.verdict === "best");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Financing"
        subtitle="What you need, what each offer really costs, whether it actually fixes the gap without creating a new one, and which offers to walk away from."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden /> Add an offer
          </Button>
        }
      />

      {/* What is needed */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <Card className={clsx("overflow-hidden", n.atRisk ? "border-warn/40" : "")}>
          <div
            className={clsx(
              "grid gap-6 p-5 sm:p-7 md:grid-cols-[1.4fr_1fr]",
              n.atRisk ? "bg-warnsoft/40" : "bg-possoft/30",
            )}
          >
            <div>
              <p className="eyebrow">Do you need financing?</p>
              {n.atRisk ? (
                <>
                  <h2 className="display mt-1 text-3xl leading-tight">{`You need about ${fm(n.amount)} by ${n.neededBy}`}</h2>
                  <p className="mt-2 text-[15px] text-ink2">
                    {`Without it, cash falls to ${fm(n.lowest)} on ${n.lowestDate}, below your safety reserve of ${fm(n.reserve)}.`}
                    {best
                      ? ` The best offer below covers it for ${fm(best.cost)} in total cost.`
                      : " None of the offers you added covers it safely yet."}
                  </p>
                </>
              ) : (
                <>
                  <h2 className="display mt-1 text-3xl leading-tight">{`No financing needed in the next ${n.horizonDays} days`}</h2>
                  <p className="mt-2 text-[15px] text-ink2">
                    Cash is expected to stay above {fm(n.reserve)} (lowest {fm(n.lowest)} on {n.lowestDate}). Borrowing
                    now would only add cost — unless it funds growth you have tested in What-if.
                  </p>
                </>
              )}
              <p className="mt-3 text-xs text-ink3">{n.basis}</p>
            </div>
            <div className="grid grid-cols-2 gap-3 self-center">
              <Stat label="Lowest cash ahead" value={fm(n.lowest)} tone={n.atRisk ? "warn" : undefined} />
              <Stat label="Safety reserve" value={data.reserve === null ? "not set" : fm(n.reserve)} />
              <Stat label="Gap to cover" value={fm(n.amount)} tone={n.amount > 0 ? "warn" : "pos"} />
              <Stat label="Offers compared" value={String(data.offers.length)} />
            </div>
          </div>
        </Card>
      </motion.div>

      <Readiness r={data.readiness} />

      {/* Offers */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="display text-2xl">Offers, compared honestly</h2>
            <p className="text-[13px] text-ink3">
              Ranked by: no warning signs, keeps your cash safe including repayments, then lowest total cost. The annual
              rate is the true yearly cost including all fees.
            </p>
          </div>
        </div>
        {data.offers.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="size-6" />}
            title="No offers yet"
            body="Add any offer you received — from a bank, a supplier, a fintech app or a message — and see what it really costs before you sign."
            action={<Button onClick={() => setAdding(true)}>Add an offer</Button>}
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {data.offers.map((o, i) => {
              const v = VERDICT[o.verdict];
              return (
                <motion.div
                  key={o.offer.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.06 * i }}
                >
                  <Card
                    className={clsx(
                      "flex h-full flex-col p-5",
                      o.verdict === "best" && "border-pos ring-1 ring-pos/30",
                      o.verdict === "avoid" && "border-neg/40",
                    )}
                  >
                    <div className="flex flex-wrap items-start gap-2">
                      <v.icon
                        className={clsx(
                          "mt-0.5 size-5 shrink-0",
                          o.verdict === "best"
                            ? "text-pos"
                            : o.verdict === "avoid"
                              ? "text-neg"
                              : o.verdict === "risky"
                                ? "text-warn"
                                : "text-info",
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-[15px] font-semibold text-ink">{o.offer.lender}</p>
                        <p className="text-xs text-ink3">
                          {data.kinds[o.offer.kind] ?? o.offer.kind} · repaid {REPAY[o.offer.repayment]} ·{" "}
                          {o.offer.termDays} days
                        </p>
                      </div>
                      <Badge tone={v.tone}>{v.label}</Badge>
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
                      <Kv k="You receive" v={fm(o.received)} />
                      <Kv k="You repay" v={fm(o.totalRepaid)} />
                      <Kv k="True cost" v={fm(o.cost)} strong />
                      <Kv
                        k="Annual rate"
                        v={o.apr === null ? "off the scale" : `${Math.round(o.apr * 100)}%`}
                        tone={o.apr === null || o.apr > 0.5 ? "neg" : undefined}
                        strong
                      />
                    </dl>
                    <p
                      className={clsx(
                        "mt-3 rounded-xl px-3 py-2 text-[13px]",
                        o.verdict === "avoid"
                          ? "bg-negsoft text-neg"
                          : o.covers
                            ? "bg-possoft text-pos"
                            : "bg-warnsoft text-ink",
                      )}
                    >
                      {o.explanation}
                    </p>
                    {o.flags.length > 0 && (
                      <ul className="mt-3 space-y-1.5">
                        {o.flags.map((f, k) => (
                          <li key={k} className="flex gap-2 text-[13px] text-ink2">
                            <ShieldAlert
                              className={clsx(
                                "mt-0.5 size-4 shrink-0",
                                f.level === "danger" ? "text-neg" : "text-warn",
                              )}
                              aria-hidden
                            />
                            <span>{f.text}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                      {o.offer.source === "demo" && <Badge>demo offer</Badge>}
                      <span className="text-xs text-ink3">
                        Lowest cash with it:{" "}
                        <span className={clsx("num", o.newLowest < n.reserve ? "text-neg" : "text-ink")}>
                          {fm(o.newLowest)}
                        </span>
                        {o.newBreachDate ? ` · dips on ${o.newBreachDate}` : ""}
                      </span>
                      <span className="flex-1" />
                      {o.verdict !== "avoid" && (
                        <Button size="sm" onClick={() => setSharing(o)}>
                          <FileText className="size-4" aria-hidden /> Lender file
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRemove(o)}
                        aria-label={`Remove ${o.offer.lender}`}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        )}
      </section>

      {/* Lender-ready file */}
      <Card className="p-5 sm:p-7">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Be lender-ready</p>
            <h2 className="display mt-1 text-2xl">A financing file built from your real records</h2>
            <p className="mt-1 max-w-2xl text-[14px] text-ink2">
              Monthly profit, a 13-week cash forecast with and without the loan, who owes you and whom you owe, and a
              data-quality score — with a fingerprint that proves nothing was edited. Sharing it creates a read-only
              link that expires, and always needs your approval.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href={`/app/financing/pack?amount=${n.amount || ""}&offerId=${best?.offer.id ?? ""}`}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium hover:bg-sunken"
            >
              <ExternalLink className="size-4" aria-hidden /> Preview
            </Link>
            <Button variant="primary" onClick={() => setSharing(best ?? "none")}>
              <Link2 className="size-4" aria-hidden /> Share with a lender…
            </Button>
          </div>
        </div>
        {data.shares.length > 0 && (
          <ul className="mt-5 divide-y divide-line rounded-2xl border border-line">
            {data.shares.map((s) => {
              const live = !s.revokedAt && new Date(s.expiresAt) > new Date();
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink">{s.recipient}</p>
                    <p className="text-xs text-ink3">
                      Fingerprint {s.fingerprint.slice(0, 12)}… · {s.views} view{s.views === 1 ? "" : "s"} ·{" "}
                      {live
                        ? `expires ${s.expiresAt.slice(0, 16).replace("T", " ")}`
                        : s.revokedAt
                          ? "revoked"
                          : "expired"}
                    </p>
                  </div>
                  {live && s.url && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await navigator.clipboard?.writeText(s.url!);
                        toast({ title: "Link copied" });
                      }}
                    >
                      Copy link
                    </Button>
                  )}
                  {live && admin && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-neg"
                      onClick={async () => {
                        await api.post(`/api/financing/shares/${s.id}/revoke`);
                        mutate();
                        toast({ title: "Link revoked", description: "It stops working immediately." });
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                  <Badge tone={live ? "pos" : "neutral"}>{live ? "Active" : s.revokedAt ? "Revoked" : "Expired"}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <AddOffer
        open={adding}
        onClose={() => setAdding(false)}
        cur={cur}
        kinds={data.kinds}
        onSaved={() => {
          mutate();
        }}
      />
      <ShareDialog
        target={sharing}
        onClose={() => setSharing(null)}
        cur={cur}
        need={n.amount}
        onDone={() => {
          mutate();
          refreshAll();
        }}
      />
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title="Remove this offer?"
        body="It is only removed from your comparison."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (remove) await api.del(`/api/financing/offers/${remove.offer.id}`);
          mutate();
        }}
      />
    </div>
  );
}

function Readiness({ r }: { r: Data["readiness"] }) {
  const tone = r.band === "strong" ? "var(--pos)" : r.band === "fair" ? "var(--warn)" : "var(--neg)";
  const C = 2 * Math.PI * 42;
  return (
    <Card className="p-5 sm:p-7">
      <div className="grid gap-6 md:grid-cols-[180px_1fr]">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="relative size-36">
            <svg viewBox="0 0 100 100" className="size-36 -rotate-90" aria-hidden>
              <circle cx="50" cy="50" r="42" fill="none" stroke="var(--line)" strokeWidth="9" />
              <motion.circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                stroke={tone}
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray={C}
                initial={{ strokeDashoffset: C }}
                animate={{ strokeDashoffset: C * (1 - r.score / 100) }}
                transition={{ duration: 1, ease: "easeOut" }}
              />
            </svg>
            <p className="fig absolute inset-0 grid place-items-center text-4xl">{r.score}</p>
          </div>
          <p className="text-[12px] uppercase tracking-wide text-ink3">out of 100</p>
        </div>
        <div>
          <p className="eyebrow">Financing readiness</p>
          <h2 className="display mt-1 text-2xl">
            {r.band === "strong" ? "Lender-ready" : r.band === "fair" ? "Almost lender-ready" : "Not lender-ready yet"}
          </h2>
          <p className="mt-1 text-[14px] text-ink2">
            {r.summary} This is how a lender is likely to look at your business — and what would raise it.
          </p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {r.checks.map((c, i) => (
              <motion.li
                key={c.key}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 * i }}
                className="rounded-xl border border-line p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[14px] font-medium text-ink">{c.label}</span>
                  <span className={clsx("num text-[13px] font-semibold", c.ok ? "text-pos" : "text-warn")}>
                    {c.points}/{c.max}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sunken">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: c.ok ? "var(--pos)" : "var(--warn)" }}
                    initial={{ width: 0 }}
                    animate={{ width: `${(c.points / c.max) * 100}%` }}
                    transition={{ duration: 0.7, delay: 0.05 * i }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-ink3">{c.detail}</p>
                {c.how && <p className="mt-0.5 text-xs text-accent">→ {c.how}</p>}
              </motion.li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "pos" }) {
  return (
    <div className="rounded-2xl bg-surface/80 px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className={clsx("fig mt-1 text-lg", tone === "warn" ? "text-warn" : tone === "pos" ? "text-pos" : "text-ink")}>
        {value}
      </p>
    </div>
  );
}

function Kv({ k, v, strong, tone }: { k: string; v: string; strong?: boolean; tone?: "neg" }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-ink3">{k}</dt>
      <dd className={clsx("num text-[15px]", strong && "font-semibold", tone === "neg" ? "text-neg" : "text-ink")}>
        {v}
      </dd>
    </div>
  );
}

const FLAG_LABELS: [string, string][] = [
  ["upfrontPaymentRequested", "They asked me to pay something before I receive the money"],
  ["personalAccountPayment", "Fees go to a personal account or mobile wallet"],
  ["notLicensed", "I can't find them registered with the Central Bank / FRA"],
  ["guaranteedApproval", "They promise approval no matter what"],
  ["pressureToSignToday", "They push me to decide today"],
];

function AddOffer({
  open,
  onClose,
  cur,
  kinds,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  cur: string;
  kinds: Record<string, string>;
  onSaved: () => void;
}) {
  const d = currencyDigits(cur);
  const blank = {
    lender: "",
    kind: "term_loan",
    amount: null as number | null,
    upfrontFee: null as number | null,
    ratePct: "",
    flatFee: null as number | null,
    termDays: "90",
    repayment: "monthly",
    revenueSharePct: "",
    flags: {} as Record<string, boolean>,
  };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add a financing offer"
      description="Type what the offer says. The true annual cost and the warning signs are calculated for you."
      size="md"
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
              setErr({});
              try {
                await api.post("/api/financing/offers", {
                  lender: f.lender,
                  kind: f.kind,
                  amount: f.amount ?? 0,
                  upfrontFee: f.upfrontFee ?? 0,
                  ratePct: f.ratePct === "" ? null : Number(f.ratePct),
                  flatFee: f.flatFee,
                  termDays: Number(f.termDays),
                  repayment: f.repayment,
                  revenueSharePct: f.revenueSharePct === "" ? null : Number(f.revenueSharePct),
                  flags: f.flags,
                });
                setF(blank);
                onSaved();
                onClose();
              } catch (x) {
                if (x instanceof ApiError) setErr({ ...(x.fields ?? {}), _: x.fields ? "" : x.message });
              } finally {
                setBusy(false);
              }
            }}
          >
            Compare it
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Who is offering" error={err.lender} className="sm:col-span-2">
          <Input
            value={f.lender}
            onChange={(e) => set("lender", e.target.value)}
            placeholder="e.g. My bank, Supplier, an app"
          />
        </Field>
        <Field label="Type">
          <Select value={f.kind} onChange={(e) => set("kind", e.target.value)}>
            {Object.entries(kinds).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount offered" error={err.amount}>
          <MoneyInput value={f.amount} onChange={(v) => set("amount", v)} currency={cur} digits={d} />
        </Field>
        <Field label="Fee paid at the start" hint="Deducted or paid upfront">
          <MoneyInput value={f.upfrontFee} onChange={(v) => set("upfrontFee", v)} currency={cur} digits={d} />
        </Field>
        <Field label="Interest rate per year (%)" hint="Leave empty if they quote a fixed fee">
          <Input
            inputMode="decimal"
            value={f.ratePct}
            onChange={(e) => set("ratePct", e.target.value)}
            placeholder="e.g. 24"
          />
        </Field>
        <Field label="Fixed fee added to repayment" hint="e.g. a “15% fee” on 100,000 = 15,000">
          <MoneyInput value={f.flatFee} onChange={(v) => set("flatFee", v)} currency={cur} digits={d} />
        </Field>
        <Field label="Length (days)" error={err.termDays}>
          <Input inputMode="numeric" value={f.termDays} onChange={(e) => set("termDays", e.target.value)} />
        </Field>
        <Field label="How you repay">
          <Select value={f.repayment} onChange={(e) => set("repayment", e.target.value)}>
            <option value="bullet">All at the end</option>
            <option value="monthly">Monthly installments</option>
            <option value="weekly">Weekly installments</option>
            <option value="daily_sales">A share of daily sales</option>
          </Select>
        </Field>
        {f.repayment === "daily_sales" && (
          <Field label="Share of daily sales withheld (%)" error={err.revenueSharePct}>
            <Input
              inputMode="decimal"
              value={f.revenueSharePct}
              onChange={(e) => set("revenueSharePct", e.target.value)}
              placeholder="e.g. 15"
            />
          </Field>
        )}
      </div>
      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-ink">Anything like this? (scam check)</legend>
        <div className="mt-2 space-y-1.5">
          {FLAG_LABELS.map(([k, l]) => (
            <label key={k} className="flex items-start gap-2 text-[13px] text-ink2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={!!f.flags[k]}
                onChange={(e) => set("flags", { ...f.flags, [k]: e.target.checked })}
              />
              {l}
            </label>
          ))}
        </div>
      </fieldset>
      {err._ && <p className="mt-3 text-sm text-neg">{err._}</p>}
    </Modal>
  );
}

function ShareDialog({
  target,
  onClose,
  cur,
  need,
  onDone,
}: {
  target: OfferA | null | "none";
  onClose: () => void;
  cur: string;
  need: number;
  onDone: () => void;
}) {
  const { toast } = useUi();
  const offer = target && target !== "none" ? target : null;
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [purpose, setPurpose] = useState("Working capital");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const amt = amount ?? (offer?.offer.amount || need || null);
  return (
    <Modal
      open={target !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Share a lender-ready file"
      description="Creates a read-only link that expires. It is sent for your approval first, tied to exactly these details."
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
                await api.post("/api/financing/share", {
                  recipient: recipient || offer?.offer.lender || "",
                  amount: amt ?? 0,
                  purpose,
                  offerId: offer?.offer.id ?? null,
                  expiresInDays: Number(days),
                });
                toast({
                  title: "Waiting for approval",
                  description: "Approve it in the Action Center (Approvals) to create the link.",
                });
                onDone();
                onClose();
              } catch (x) {
                setErr(x instanceof ApiError ? x.message : "Could not prepare the file.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Request approval
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Recipient (lender)">
          <Input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={offer?.offer.lender ?? "e.g. Bank SME desk"}
          />
        </Field>
        <Field label="Amount requested">
          <MoneyInput value={amt} onChange={setAmount} currency={cur} digits={currencyDigits(cur)} />
        </Field>
        <Field label="Purpose">
          <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </Field>
        <Field label="Link works for">
          <Select value={days} onChange={(e) => setDays(e.target.value)}>
            {["1", "3", "7", "14"].map((d) => (
              <option key={d} value={d}>
                {d} day{d === "1" ? "" : "s"}
              </option>
            ))}
          </Select>
        </Field>
        <p className="flex items-center gap-1.5 text-xs text-ink3">
          <DataLabel kind="actual" /> Built only from your records. You can revoke the link at any time.
        </p>
        {err && <p className="text-sm text-neg">{err}</p>}
      </div>
    </Modal>
  );
}
