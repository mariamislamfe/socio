"use client";
import { ArrowLeftRight, ArrowDownLeft, ArrowUpRight, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useAccounts, useCategories, useMe, usePayees } from "@/lib/client/hooks";
import { currencyDigits } from "@/lib/finance/money";
import { useUi } from "../providers";
import { Button, clsx, Field, Hint, Input, Modal, MoneyInput, Select, Textarea } from "../ui";

export type TxnType = "expense" | "income" | "transfer" | "refund" | "adjustment";
export interface TxnDraft {
  id?: string;
  type: TxnType;
  date: string;
  amount: number | null;
  account_id: string;
  to_account_id: string;
  category_id: string;
  payee_id: string;
  description: string;
  notes: string;
  direction: "in" | "out";
  source?: string;
}

const TYPES: { v: TxnType; label: string; icon: typeof ArrowUpRight; hint: string; glossary?: string }[] = [
  { v: "expense", label: "Expense", icon: ArrowUpRight, hint: "Money you spent" },
  { v: "income", label: "Income", icon: ArrowDownLeft, hint: "Money you earned" },
  {
    v: "transfer",
    label: "Transfer",
    icon: ArrowLeftRight,
    hint: "Moving your own money between accounts",
    glossary: "transfer",
  },
  {
    v: "refund",
    label: "Refund",
    icon: RotateCcw,
    hint: "Money returned to a customer (or by a supplier)",
    glossary: "refund",
  },
  { v: "adjustment", label: "Adjustment", icon: SlidersHorizontal, hint: "Correct a balance without affecting profit" },
];

const todayStr = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
};
const addDaysStr = (s: string, n: number) => new Date(Date.parse(s) + n * 86400000).toISOString().slice(0, 10);

export function blankDraft(partial: Partial<TxnDraft> = {}): TxnDraft {
  return {
    type: "expense",
    date: todayStr(),
    amount: null,
    account_id: "",
    to_account_id: "",
    category_id: "",
    payee_id: "",
    description: "",
    notes: "",
    direction: "out",
    ...partial,
  };
}

export function TransactionModal({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: TxnDraft;
  onSaved?: () => void;
}) {
  const { biz } = useMe();
  const { data: accts } = useAccounts();
  const { data: cats } = useCategories();
  const { data: payees } = usePayees();
  const { toast } = useUi();
  const [d, setD] = useState<TxnDraft>(() => initial ?? blankDraft());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState(false);
  const editing = !!d.id;
  const imported = editing && d.source && d.source !== "manual";

  useEffect(() => {
    if (open) {
      setD(initial ?? blankDraft());
      setErrors({});
    }
  }, [open, initial]);

  const accounts = (accts?.items ?? []).filter((a) => !a.archived);
  useEffect(() => {
    if (open && !d.account_id && accounts[0]) setD((x) => ({ ...x, account_id: accounts[0].id }));
  }, [open, accounts, d.account_id]);

  const currency = accounts.find((a) => a.id === d.account_id)?.currency?.trim() ?? biz?.currency ?? "EGP";
  const digits = currencyDigits(currency);
  const categories = useMemo(() => {
    const items = (cats?.items ?? []).filter((c) => !c.archived);
    const kind = d.type === "income" ? "income" : d.type === "expense" ? "expense" : null;
    const filtered = kind ? items.filter((c) => c.kind === kind) : items;
    // parents first, children indented
    const out: { id: string; label: string }[] = [];
    for (const p of filtered.filter((c) => !c.parent_id)) {
      out.push({ id: p.id, label: p.name });
      for (const ch of filtered.filter((c) => c.parent_id === p.id)) out.push({ id: ch.id, label: `— ${ch.name}` });
    }
    return out;
  }, [cats, d.type]);

  const set = <K extends keyof TxnDraft>(k: K, v: TxnDraft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setErrors((e) => ({ ...e, [k]: "" }));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!d.amount || d.amount <= 0) e.amount = "Enter an amount greater than zero";
    if (!d.date) e.date = "Choose a date";
    if (!d.account_id) e.account_id = "Choose an account";
    if (d.type === "transfer") {
      if (!d.to_account_id) e.to_account_id = "Choose the account receiving the money";
      else if (d.to_account_id === d.account_id) e.to_account_id = "Choose a different account";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async (addAnother = false) => {
    if (!validate()) return;
    setBusy(true);
    try {
      const body: any = {
        type: d.type,
        date: d.date,
        amount: d.amount,
        account_id: d.account_id,
        description: d.description.trim(),
        notes: d.notes.trim() || null,
        to_account_id: d.type === "transfer" ? d.to_account_id : null,
        category_id: d.type === "transfer" || d.type === "adjustment" ? null : d.category_id || null,
        payee_id: d.payee_id || null,
        direction: d.type === "adjustment" ? d.direction : null,
      };
      if (editing) {
        if (imported) {
          delete body.amount;
          delete body.date;
          delete body.type;
          delete body.account_id;
          delete body.to_account_id;
          delete body.direction;
        }
        await api.patch(`/api/transactions/${d.id}`, body);
      } else await api.post("/api/transactions", body);
      await refreshAll();
      toast({
        title: editing ? "Transaction updated" : "Transaction saved",
        description: "Your totals have been updated.",
      });
      onSaved?.();
      if (addAnother) {
        setD(blankDraft({ type: d.type, account_id: d.account_id, date: d.date }));
        setAgain(true);
      } else onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors({ ...(err.fields ?? {}), _form: err.fields ? "" : err.message });
        if (err.fields && !Object.values(err.fields).some(Boolean))
          toast({ title: "Could not save", description: err.message, tone: "error" });
      } else toast({ title: "Could not save", description: "Check your connection and try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const typeMeta = TYPES.find((t) => t.v === d.type)!;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit transaction" : "Add a transaction"}
      description={typeMeta.hint}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!editing && (
            <Button variant="secondary" loading={busy} onClick={() => save(true)}>
              Save &amp; add another
            </Button>
          )}
          <Button variant="primary" loading={busy} onClick={() => save(false)}>
            {editing ? "Save changes" : "Save"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(false);
        }}
        className="space-y-5"
      >
        {!editing || !imported ? (
          <div
            role="radiogroup"
            aria-label="Transaction type"
            className="grid grid-cols-5 gap-1.5 rounded-2xl bg-sunken p-1"
          >
            {TYPES.map((t) => {
              const Icon = t.icon;
              const on = d.type === t.v;
              return (
                <button
                  type="button"
                  key={t.v}
                  role="radio"
                  aria-checked={on}
                  onClick={() =>
                    setD((x) => ({
                      ...x,
                      type: t.v,
                      category_id: "",
                      direction: t.v === "adjustment" ? "in" : x.direction,
                    }))
                  }
                  className={clsx(
                    "flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[12px] font-medium transition",
                    on ? "bg-raised text-ink shadow-sm" : "text-ink3 hover:text-ink2",
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                  {t.label}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="rounded-xl bg-infosoft px-3 py-2 text-[13px] text-info">
            This record was imported from {d.source}. Amount, date and account stay as imported; you can still change
            its category, payee and notes.
          </p>
        )}

        {errors._form && (
          <p role="alert" className="rounded-xl bg-negsoft px-3 py-2 text-sm text-neg">
            {errors._form}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" error={errors.amount} htmlFor="t-amount">
            <MoneyInput
              id="t-amount"
              value={d.amount}
              onChange={(v) => set("amount", v)}
              currency={currency}
              digits={digits}
              invalid={!!errors.amount}
              autoFocus
            />
          </Field>
          <Field label="Date" error={errors.date} htmlFor="t-date">
            <Input
              id="t-date"
              type="date"
              value={d.date}
              onChange={(e) => set("date", e.target.value)}
              invalid={!!errors.date}
              disabled={!!imported}
            />
            {!imported && (
              <div className="mt-2 flex gap-1.5">
                {[
                  ["Today", 0],
                  ["Yesterday", -1],
                ].map(([l, n]) => (
                  <button
                    type="button"
                    key={l as string}
                    onClick={() => set("date", addDaysStr(todayStr(), n as number))}
                    className="rounded-full bg-sunken px-2.5 py-1 text-xs text-ink2 hover:text-ink"
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={d.type === "transfer" ? "From account" : d.type === "adjustment" ? "Account" : "Account"}
            error={errors.account_id}
            htmlFor="t-account"
          >
            <Select
              id="t-account"
              value={d.account_id}
              onChange={(e) => set("account_id", e.target.value)}
              invalid={!!errors.account_id}
              disabled={!!imported}
            >
              <option value="">Choose…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.currency.trim()}
                </option>
              ))}
            </Select>
          </Field>
          {d.type === "transfer" ? (
            <Field label="To account" error={errors.to_account_id} htmlFor="t-to">
              <Select
                id="t-to"
                value={d.to_account_id}
                onChange={(e) => set("to_account_id", e.target.value)}
                invalid={!!errors.to_account_id}
              >
                <option value="">Choose…</option>
                {accounts
                  .filter((a) => a.id !== d.account_id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.currency.trim()}
                    </option>
                  ))}
              </Select>
            </Field>
          ) : d.type === "adjustment" ? (
            <Field label="Effect on cash" htmlFor="t-dir">
              <Select id="t-dir" value={d.direction} onChange={(e) => set("direction", e.target.value as "in" | "out")}>
                <option value="in">Adds cash</option>
                <option value="out">Removes cash</option>
              </Select>
            </Field>
          ) : (
            <Field
              label="Category"
              error={errors.category_id}
              htmlFor="t-cat"
              hint={
                d.type === "refund"
                  ? "Choose an income category for a customer refund, or an expense category for a supplier refund."
                  : undefined
              }
            >
              <Select
                id="t-cat"
                value={d.category_id}
                onChange={(e) => set("category_id", e.target.value)}
                invalid={!!errors.category_id}
              >
                <option value="">Uncategorized</option>
                {d.type === "refund"
                  ? (cats?.items ?? [])
                      .filter((c) => !c.archived)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.kind})
                        </option>
                      ))
                  : categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
              </Select>
            </Field>
          )}
        </div>

        {(d.type === "transfer" || d.type === "adjustment") && (
          <p className="flex items-start gap-2 rounded-xl bg-accentsoft px-3 py-2.5 text-[13px] text-accent">
            <Hint k={d.type === "transfer" ? "transfer" : "profit"} className="mt-0.5" />
            {d.type === "transfer"
              ? "Transfers move your own money between accounts. They never count as revenue or expenses."
              : "Adjustments change a balance only. They are excluded from revenue and profit."}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Description" htmlFor="t-desc">
            <Input
              id="t-desc"
              value={d.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder={d.type === "income" ? "e.g. Online store sales" : "e.g. Fabric from Delta"}
              maxLength={200}
            />
          </Field>
          <Field
            label={
              d.type === "income" || d.type === "refund"
                ? "Customer / source (optional)"
                : "Payee / supplier (optional)"
            }
            htmlFor="t-payee"
          >
            <Select id="t-payee" value={d.payee_id} onChange={(e) => set("payee_id", e.target.value)}>
              <option value="">None</option>
              {(payees?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Notes (optional)" htmlFor="t-notes">
          <Textarea
            id="t-notes"
            value={d.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={2}
            maxLength={1000}
          />
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        {again && <p className="text-[13px] text-pos">Saved. Ready for the next one.</p>}
      </form>
    </Modal>
  );
}
