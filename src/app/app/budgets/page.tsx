"use client";
import { GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { Reorder } from "motion/react";
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
  Modal,
  Money,
  MoneyInput,
  PageHeader,
  Progress,
  Select,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useCategories, useMe } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

interface B {
  id: string;
  categoryId: string;
  categoryName: string;
  period: "monthly" | "quarterly" | "yearly";
  planned: number;
  spent: number;
  remaining: number;
  usedPct: number;
  timeElapsedPct: number;
  daysRemaining: number;
  projectedByPace: number;
  committed: number;
  upcoming: { name: string; date: string; amount: number }[];
  status: "ok" | "watch" | "at_risk" | "over";
  lowConfidence: boolean;
  position: number;
}

const PERIOD = { monthly: "month", quarterly: "quarter", yearly: "year" } as const;
const STATUS = {
  ok: { tone: "pos" as const, label: "On track" },
  watch: { tone: "warn" as const, label: "Watch" },
  at_risk: { tone: "warn" as const, label: "May exceed" },
  over: { tone: "neg" as const, label: "Over budget" },
};

export default function BudgetsPage() {
  const { biz } = useMe();
  const { toast } = useUi();
  const { data, error, isLoading, mutate } = useSWR<{ items: B[]; currency: string }>("/api/budgets");
  const [order, setOrder] = useState<B[]>([]);
  const [modal, setModal] = useState<{ open: boolean; edit?: B }>({ open: false });
  const [del, setDel] = useState<B | null>(null);
  const cur = data?.currency ?? biz?.currency.trim() ?? "EGP";
  const canWrite = biz && biz.role !== "viewer";

  useEffect(() => {
    if (data) setOrder(data.items);
  }, [data]);

  const totals = useMemo(() => {
    const m = order.filter((b) => b.period === "monthly");
    return { planned: m.reduce((a, b) => a + b.planned, 0), spent: m.reduce((a, b) => a + b.spent, 0) };
  }, [order]);

  const persistOrder = async (items: B[]) => {
    try {
      await api.post("/api/budgets/reorder", { ids: items.map((b) => b.id) });
    } catch {
      toast({ title: "Could not save the new order", tone: "error" });
      mutate();
    }
  };

  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Budgets"
        subtitle="Plan what each part of the business should cost, then watch real spending against it. Warnings come from your actual records and the time left in the period."
        actions={
          <Button variant="primary" disabled={!canWrite} onClick={() => setModal({ open: true })}>
            <Plus className="size-4" aria-hidden /> New budget
          </Button>
        }
      />

      {order.length > 0 && (
        <Card className="p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-1">
                <span className="eyebrow">Monthly budgets in total</span>
                <Hint k="budget" />
              </div>
              <p className="fig mt-1 text-4xl">
                <Money value={totals.spent} currency={cur} />{" "}
                <span className="text-xl text-ink3">of {formatMoney(totals.planned, cur)}</span>
              </p>
            </div>
            <p className="max-w-sm text-sm text-ink2">
              Remaining across monthly budgets:{" "}
              <strong className={totals.planned - totals.spent < 0 ? "text-neg" : "text-ink"}>
                {formatMoney(totals.planned - totals.spent, cur)}
              </strong>
            </p>
          </div>
          <Progress
            className="mt-4 h-3"
            value={totals.planned ? totals.spent / totals.planned : 0}
            tone={totals.spent > totals.planned ? "neg" : "accent"}
            label="Total monthly budget used"
          />
        </Card>
      )}

      {isLoading && !data ? (
        <div className="space-y-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : order.length === 0 ? (
        <EmptyState
          title="No budgets yet"
          body="A budget is a planned limit for a category over a period. Start with the costs that worry you most — advertising, inventory or salaries."
          action={
            <Button variant="primary" disabled={!canWrite} onClick={() => setModal({ open: true })}>
              Create your first budget
            </Button>
          }
        />
      ) : (
        <Reorder.Group axis="y" values={order} onReorder={setOrder} className="space-y-3">
          {order.map((b) => {
            const st = STATUS[b.status];
            const tone = b.status === "over" ? "neg" : b.status === "ok" ? "accent" : "warn";
            return (
              <Reorder.Item
                key={b.id}
                value={b}
                onDragEnd={() => persistOrder(order)}
                className="list-none"
                dragListener={!!canWrite}
              >
                <Card className="p-5 sm:p-6">
                  <div className="flex flex-wrap items-start gap-3">
                    {canWrite && (
                      <GripVertical
                        className="mt-1 size-5 shrink-0 cursor-grab text-ink3 active:cursor-grabbing"
                        aria-label="Drag to reorder"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-[17px] font-semibold text-ink">{b.categoryName}</h3>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        <Badge>per {PERIOD[b.period]}</Badge>
                      </div>
                      <div className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-3">
                        <div>
                          <p className="eyebrow">Spent</p>
                          <p className="fig text-2xl">
                            <Money value={b.spent} currency={cur} />
                          </p>
                        </div>
                        <div>
                          <p className="eyebrow">Planned</p>
                          <p className="fig text-2xl">
                            <Money value={b.planned} currency={cur} />
                          </p>
                        </div>
                        <div>
                          <p className="eyebrow">{b.remaining < 0 ? "Over by" : "Remaining"}</p>
                          <p className={clsx("fig text-2xl", b.remaining < 0 && "text-neg")}>
                            <Money value={Math.abs(b.remaining)} currency={cur} />
                          </p>
                        </div>
                      </div>
                    </div>
                    {canWrite && (
                      <div className="flex gap-0.5">
                        <IconButton
                          label={`Edit ${b.categoryName} budget`}
                          onClick={() => setModal({ open: true, edit: b })}
                        >
                          <Pencil className="size-4" />
                        </IconButton>
                        <IconButton label={`Delete ${b.categoryName} budget`} onClick={() => setDel(b)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                    )}
                  </div>

                  <div className="mt-5">
                    <div className="relative">
                      <Progress
                        className="h-3"
                        value={Math.min(1, b.usedPct)}
                        tone={tone}
                        label={`${b.categoryName} budget used`}
                      />
                      <span
                        aria-hidden
                        className="absolute -top-1.5 h-6 w-0.5 rounded bg-ink"
                        style={{ insetInlineStart: `${Math.min(100, b.timeElapsedPct * 100)}%` }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-ink3">
                      <span>{Math.round(Math.min(b.usedPct, 9.99) * 100)}% used</span>
                      <span>
                        {Math.round(b.timeElapsedPct * 100)}% of the {PERIOD[b.period]} elapsed · {b.daysRemaining} days
                        left
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 rounded-xl bg-sunken p-4 text-sm sm:grid-cols-2">
                    <p>
                      <span className="text-ink3">At the current pace: </span>
                      <strong className={clsx(b.projectedByPace > b.planned && "text-neg")}>
                        {formatMoney(b.projectedByPace, cur)}
                      </strong>
                      <span className="block text-xs text-ink3">
                        {b.lowConfidence
                          ? "Early in the period — a rough guide only."
                          : "Spent so far scaled to a full period."}
                      </span>
                    </p>
                    <p>
                      <span className="text-ink3">Spent + scheduled payments: </span>
                      <strong className={clsx(b.committed > b.planned && "text-neg")}>
                        {formatMoney(b.committed, cur)}
                      </strong>
                      <span className="block text-xs text-ink3">
                        {b.upcoming.length
                          ? `${b.upcoming.length} upcoming: ${b.upcoming
                              .slice(0, 2)
                              .map((u) => `${u.name} ${formatMoney(u.amount, cur, { compact: true })}`)
                              .join(", ")}`
                          : "Nothing scheduled in this category."}
                      </span>
                    </p>
                  </div>
                  {(b.status === "at_risk" || b.status === "over") && (
                    <p className={clsx("mt-3 text-sm", b.status === "over" ? "text-neg" : "text-warn")} role="status">
                      {b.status === "over"
                        ? `You have gone over this budget by ${formatMoney(-b.remaining, cur)}.`
                        : `You have used ${Math.round(b.usedPct * 100)}% of this budget with ${Math.round((1 - b.timeElapsedPct) * 100)}% of the ${PERIOD[b.period]} remaining. At your current spending pace, you may exceed it.`}
                    </p>
                  )}
                </Card>
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
      )}

      <BudgetModal
        state={modal}
        onClose={() => setModal({ open: false })}
        existing={order}
        currency={cur}
        onSaved={() => mutate()}
      />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title="Remove this budget?"
        body={
          <>
            The <strong>{del?.categoryName}</strong> budget will be removed. Your transactions are not affected.
          </>
        }
        confirmLabel="Remove"
        onConfirm={async () => {
          await api.del(`/api/budgets/${del!.id}`);
          await refreshAll();
          toast({ title: "Budget removed" });
        }}
      />
    </div>
  );
}

function BudgetModal({
  state,
  onClose,
  existing,
  currency,
  onSaved,
}: {
  state: { open: boolean; edit?: B };
  onClose: () => void;
  existing: B[];
  currency: string;
  onSaved: () => void;
}) {
  const { data: cats } = useCategories();
  const { toast } = useUi();
  const [category, setCategory] = useState("");
  const [period, setPeriod] = useState<"monthly" | "quarterly" | "yearly">("monthly");
  const [amount, setAmount] = useState<number | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const editing = state.edit;
  const digits = currencyDigits(currency);

  useEffect(() => {
    if (state.open) {
      setCategory(editing?.categoryId ?? "");
      setPeriod(editing?.period ?? "monthly");
      setAmount(editing?.planned ?? null);
      setErr({});
    }
  }, [state.open, editing]);

  const { data: sugg } = useSWR<{ monthlyAverage: number; hasHistory: boolean; basis: string }>(
    state.open && category && !editing ? `/api/budgets/suggest?category=${category}` : null,
  );
  const options = (cats?.items ?? []).filter(
    (c) =>
      c.kind === "expense" &&
      !c.archived &&
      (editing ? true : !existing.some((b) => b.categoryId === c.id && b.period === period)),
  );

  const save = async () => {
    const e: Record<string, string> = {};
    if (!category) e.category_id = "Choose a category";
    if (amount === null || amount < 0) e.amount = "Enter a planned amount";
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      if (editing) await api.patch(`/api/budgets/${editing.id}`, { amount, period });
      else await api.post("/api/budgets", { category_id: category, period, amount });
      await refreshAll();
      toast({
        title: editing ? "Budget updated" : "Budget created",
        description: "Dashboard and warnings now use the new plan.",
      });
      onSaved();
      onClose();
    } catch (x) {
      setErr(x instanceof ApiError ? { ...(x.fields ?? {}), _: x.message } : { _: "Could not save the budget." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={state.open}
      onOpenChange={(o) => !o && onClose()}
      title={editing ? `Edit ${editing.categoryName} budget` : "New budget"}
      description="Spending in subcategories counts toward the parent category."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save budget
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
        <Field label="Category" error={err.category_id} htmlFor="b-cat">
          <Select
            id="b-cat"
            value={category}
            disabled={!!editing}
            onChange={(e) => setCategory(e.target.value)}
            invalid={!!err.category_id}
          >
            <option value="">Choose a category…</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.parent_id ? "— " : ""}
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Period" htmlFor="b-per">
          <Select id="b-per" value={period} onChange={(e) => setPeriod(e.target.value as typeof period)}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </Select>
        </Field>
        <Field label="Planned amount" error={err.amount} htmlFor="b-amt">
          <MoneyInput
            id="b-amt"
            value={amount}
            onChange={setAmount}
            currency={currency}
            digits={digits}
            invalid={!!err.amount}
          />
        </Field>
        {sugg && category && !editing && (
          <div className="rounded-xl bg-sunken px-3.5 py-3 text-[13px] text-ink2">
            {sugg.hasHistory ? (
              <>
                You have spent about <strong className="text-ink">{formatMoney(sugg.monthlyAverage, currency)}</strong>{" "}
                a month here recently.{" "}
                <button
                  type="button"
                  className="font-medium text-accent underline"
                  onClick={() =>
                    setAmount(
                      period === "monthly"
                        ? sugg.monthlyAverage
                        : period === "quarterly"
                          ? sugg.monthlyAverage * 3
                          : sugg.monthlyAverage * 12,
                    )
                  }
                >
                  Use as a starting point
                </button>
              </>
            ) : (
              "No spending recorded in this category yet, so there is no history to suggest from."
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
