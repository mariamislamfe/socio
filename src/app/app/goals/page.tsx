"use client";
import { AlertTriangle, PiggyBank, Plus, Target, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
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
  Progress,
  Select,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

interface G {
  id: string;
  type: "reserve" | "revenue" | "profit" | "inventory" | "cash";
  name: string;
  target: number;
  current: number;
  pct: number;
  remaining: number;
  achieved: boolean;
  targetDate: string | null;
  basis: string;
  mode: "manual" | "essentials";
  coverageMonths: number | null;
  suggestedMonthly?: number;
  safeNow?: number;
  etaMonths?: number | null;
  cashAfterReserve?: number;
  projected?: number;
  warnings: string[];
}
const TYPE_LABEL = {
  reserve: "Emergency reserve",
  revenue: "Revenue goal",
  profit: "Profit goal",
  inventory: "Inventory goal",
  cash: "Cash goal",
};

export default function GoalsPage() {
  const { biz } = useMe();
  const { toast } = useUi();
  const { data, error, isLoading, mutate } = useSWR<{ items: G[]; currency: string }>("/api/goals");
  const cur = data?.currency ?? biz?.currency.trim() ?? "EGP";
  const [modal, setModal] = useState(false);
  const [contrib, setContrib] = useState<G | null>(null);
  const [del, setDel] = useState<G | null>(null);
  const canWrite = biz && biz.role !== "viewer";
  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Goals & reserve"
        subtitle="Decide what you are working toward. A reserve here is a planning figure — it tells you how protected the business is, it does not move money."
        actions={
          <Button variant="primary" disabled={!canWrite} onClick={() => setModal(true)}>
            <Plus className="size-4" aria-hidden /> New goal
          </Button>
        }
      />
      {isLoading && !data ? (
        <Skeleton className="h-64" />
      ) : (data?.items ?? []).length === 0 ? (
        <EmptyState
          icon={<PiggyBank className="size-6" />}
          title="Set your first goal"
          body="Start with an emergency reserve: how many months of essential expenses would make you feel safe if sales dropped?"
          action={
            canWrite && (
              <Button variant="primary" onClick={() => setModal(true)}>
                Create a goal
              </Button>
            )
          }
        />
      ) : (
        <ul className="grid gap-5 lg:grid-cols-2">
          {data!.items.map((g) => (
            <li key={g.id} className={clsx(g.type === "reserve" && "lg:col-span-2")}>
              <Card className="h-full p-5 sm:p-7">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="eyebrow">{TYPE_LABEL[g.type]}</span>
                      {g.type === "reserve" && <Hint k="emergency_reserve" />}
                    </div>
                    <h3 className="display mt-0.5 text-2xl">{g.name}</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    {g.achieved && <Badge tone="pos">Reached</Badge>}
                    {canWrite && (
                      <IconButton label={`Delete ${g.name}`} onClick={() => setDel(g)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    )}
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-end justify-between gap-2">
                  <p className="fig text-4xl">
                    <Money value={g.current} currency={cur} />{" "}
                    <span className="text-xl text-ink3">of {formatMoney(g.target, cur)}</span>
                  </p>
                  <p className="fig text-2xl text-accent">{Math.round(g.pct * 100)}%</p>
                </div>
                <Progress
                  className="mt-3 h-3"
                  value={g.pct}
                  tone={g.achieved ? "pos" : "accent"}
                  label={`${g.name} progress`}
                />
                <p className="mt-2 text-xs text-ink3">
                  {g.basis}
                  {g.targetDate ? ` · target ${g.targetDate}` : ""}
                </p>

                {g.type === "reserve" && (
                  <div className="mt-6 grid gap-4 sm:grid-cols-3">
                    <Stat
                      label="Suggested per month"
                      value={g.suggestedMonthly ?? 0}
                      cur={cur}
                      note={g.targetDate ? "to reach it by your date" : "to reach it in about 6 months"}
                    />
                    <Stat
                      label="Safe to set aside now"
                      value={g.safeNow ?? 0}
                      cur={cur}
                      note="without risking scheduled payments (next 60 days)"
                    />
                    <Stat
                      label="Cash left after reserve"
                      value={g.cashAfterReserve ?? 0}
                      cur={cur}
                      note="recorded cash minus reserve"
                      negative={(g.cashAfterReserve ?? 0) < 0}
                    />
                  </div>
                )}
                {g.type !== "reserve" && g.projected !== undefined && g.type !== "cash" && (
                  <p className="mt-4 text-sm text-ink2">
                    At the current pace you would finish the period at{" "}
                    <strong className="text-ink">{formatMoney(g.projected, cur)}</strong>
                    {g.target > 0 ? ` (${Math.round((g.projected / g.target) * 100)}% of the goal).` : "."}
                  </p>
                )}
                {g.warnings.length > 0 && (
                  <ul className="mt-4 space-y-2" aria-label="Warnings">
                    {g.warnings.map((w, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 rounded-xl bg-warnsoft px-3.5 py-2.5 text-[13px] text-ink"
                      >
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden /> {w}
                      </li>
                    ))}
                  </ul>
                )}
                {g.type === "reserve" && canWrite && (
                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button variant="primary" onClick={() => setContrib(g)}>
                      Record set-aside
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <GoalModal open={modal} onClose={() => setModal(false)} currency={cur} />
      <ContribModal goal={contrib} onClose={() => setContrib(null)} currency={cur} />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title="Delete this goal?"
        body="Its history of set-asides is removed too. Your transactions are not affected."
        onConfirm={async () => {
          await api.del(`/api/goals/${del!.id}`);
          await refreshAll();
          toast({ title: "Goal deleted" });
        }}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  cur,
  note,
  negative,
}: {
  label: string;
  value: number;
  cur: string;
  note: string;
  negative?: boolean;
}) {
  return (
    <div className="rounded-2xl bg-sunken p-4">
      <p className="eyebrow">{label}</p>
      <p className={clsx("fig mt-1 text-2xl", negative && "text-neg")}>
        <Money value={value} currency={cur} />
      </p>
      <p className="mt-1 text-xs text-ink3">{note}</p>
    </div>
  );
}

function GoalModal({ open, onClose, currency }: { open: boolean; onClose: () => void; currency: string }) {
  const { toast } = useUi();
  const [f, setF] = useState({
    type: "reserve",
    name: "Emergency reserve",
    mode: "essentials",
    coverage: 3,
    target: null as number | null,
    date: "",
  });
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setF({ type: "reserve", name: "Emergency reserve", mode: "essentials", coverage: 3, target: null, date: "" });
      setErr({});
    }
  }, [open]);
  const isReserve = f.type === "reserve";
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="New goal"
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
              setErr({});
              try {
                await api.post("/api/goals", {
                  type: f.type,
                  name: f.name,
                  mode: isReserve ? f.mode : "manual",
                  target: isReserve && f.mode === "essentials" ? 0 : (f.target ?? 0),
                  coverage_months: isReserve && f.mode === "essentials" ? f.coverage : null,
                  target_date: f.date || null,
                  period: "monthly",
                });
                await refreshAll();
                toast({ title: "Goal created" });
                onClose();
              } catch (x) {
                setErr(
                  x instanceof ApiError
                    ? { ...(x.fields ?? {}), _: x.fields ? "" : x.message }
                    : { _: "Could not save." },
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            Create goal
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err._ && (
          <p role="alert" className="rounded-xl bg-negsoft px-3 py-2 text-sm text-neg">
            {err._}
          </p>
        )}
        <Field label="Type" htmlFor="g-t">
          <Select
            id="g-t"
            value={f.type}
            onChange={(e) =>
              setF({
                ...f,
                type: e.target.value,
                name: TYPE_LABEL[e.target.value as keyof typeof TYPE_LABEL],
                mode: e.target.value === "reserve" ? "essentials" : "manual",
              })
            }
          >
            <option value="reserve">Emergency reserve</option>
            <option value="revenue">Monthly revenue</option>
            <option value="profit">Monthly profit</option>
            <option value="inventory">Monthly inventory purchases</option>
            <option value="cash">Cash balance</option>
          </Select>
        </Field>
        <Field label="Name" htmlFor="g-n" error={err.name}>
          <Input id="g-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} invalid={!!err.name} />
        </Field>
        {isReserve && (
          <Field label="How should the target be set?" htmlFor="g-m">
            <Select id="g-m" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
              <option value="essentials">Months of essential expenses</option>
              <option value="manual">A fixed amount</option>
            </Select>
          </Field>
        )}
        {isReserve && f.mode === "essentials" ? (
          <Field
            label="Months to cover"
            htmlFor="g-c"
            hint="Based on categories you mark as essential (rent, salaries, utilities) and your recurring schedules."
          >
            <Select
              id="g-c"
              value={String(f.coverage)}
              onChange={(e) => setF({ ...f, coverage: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 6, 9, 12].map((m) => (
                <option key={m} value={m}>
                  {m} month{m > 1 ? "s" : ""}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Target amount" htmlFor="g-a" error={err.target}>
            <MoneyInput
              id="g-a"
              value={f.target}
              onChange={(v) => setF({ ...f, target: v })}
              currency={currency}
              digits={currencyDigits(currency)}
              invalid={!!err.target}
            />
          </Field>
        )}
        {isReserve && (
          <Field label="Target date (optional)" htmlFor="g-d">
            <Input id="g-d" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function ContribModal({ goal, onClose, currency }: { goal: G | null; onClose: () => void; currency: string }) {
  const { toast } = useUi();
  const [amount, setAmount] = useState<number | null>(null);
  const [withdraw, setWithdraw] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (goal)
      setAmount(goal.safeNow ? Math.min(goal.safeNow, goal.suggestedMonthly ?? goal.safeNow) : null),
        setWithdraw(false),
        setErr("");
  }, [goal]);
  return (
    <Modal
      open={!!goal}
      onOpenChange={(o) => !o && onClose()}
      title="Record a reserve set-aside"
      description="This is a planning entry. It does not transfer money — move it in your bank if you want it physically separated."
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
              if (!amount) return setErr("Enter an amount");
              setBusy(true);
              try {
                await api.post(`/api/goals/${goal!.id}/contributions`, { amount: withdraw ? -amount : amount });
                await refreshAll();
                toast({ title: withdraw ? "Withdrawal recorded" : "Set-aside recorded" });
                onClose();
              } catch (x) {
                setErr(x instanceof ApiError ? x.message : "Could not save.");
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
        {goal?.safeNow !== undefined && (
          <p className="rounded-xl bg-sunken px-3.5 py-3 text-sm text-ink2">
            Up to <strong className="text-ink">{formatMoney(goal.safeNow, currency)}</strong> can be set aside without
            putting scheduled payments at risk over the next 60 days.
          </p>
        )}
        <Field label="Amount" error={err} htmlFor="c-a">
          <MoneyInput
            id="c-a"
            value={amount}
            onChange={(v) => (setAmount(v), setErr(""))}
            currency={currency}
            digits={currencyDigits(currency)}
            invalid={!!err}
            autoFocus
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink2">
          <input
            type="checkbox"
            checked={withdraw}
            onChange={(e) => setWithdraw(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />{" "}
          This is a withdrawal from the reserve
        </label>
      </div>
    </Modal>
  );
}

export { Target };
