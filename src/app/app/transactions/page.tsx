"use client";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  Download,
  FileUp,
  Pencil,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { blankDraft, TransactionModal, type TxnDraft } from "@/components/app/transaction-form";
import { useShell } from "@/components/app/shell";
import { useUi } from "@/components/providers";
import {
  Badge,
  Button,
  Card,
  clsx,
  ConfirmDialog,
  EmptyState,
  ErrorNote,
  Hint,
  IconButton,
  Input,
  Money,
  PageHeader,
  Select,
  Segmented,
  Skeleton,
} from "@/components/ui";
import { api } from "@/lib/client/api";
import { refreshAll, useAccounts, useCategories, useMe } from "@/lib/client/hooks";

interface Row {
  id: string;
  type: "income" | "expense" | "transfer" | "refund" | "adjustment";
  date: string;
  amount: number;
  currency: string;
  account_id: string;
  account_name: string;
  to_account_id: string | null;
  to_account_name: string | null;
  category_id: string | null;
  category_name: string | null;
  category_color: string | null;
  payee_id: string | null;
  payee_name: string | null;
  description: string;
  notes: string | null;
  direction: "in" | "out" | null;
  source: string;
  reconciled: boolean;
  cost_missing: boolean;
  recurring_id: string | null;
  invoice_id: string | null;
}

const TYPE_META = {
  income: { label: "Income", icon: ArrowDownLeft, tone: "pos" as const },
  expense: { label: "Expense", icon: ArrowUpRight, tone: "neutral" as const },
  transfer: { label: "Transfer", icon: ArrowLeftRight, tone: "info" as const },
  refund: { label: "Refund", icon: RotateCcw, tone: "warn" as const },
  adjustment: { label: "Adjustment", icon: SlidersHorizontal, tone: "neutral" as const },
};
const PAGE = 40;

function Inner() {
  const { biz } = useMe();
  const router = useRouter();
  const sp = useSearchParams();
  const { openAdd } = useShell();
  const { toast } = useUi();
  const { data: accts } = useAccounts();
  const { data: cats } = useCategories();

  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [type, setType] = useState("");
  const [account, setAccount] = useState("");
  const [category, setCategory] = useState(sp.get("category") ?? "");
  const [uncat, setUncat] = useState(sp.get("filter") === "uncategorized");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState("date");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<TxnDraft | undefined>();
  const [editOpen, setEditOpen] = useState(false);
  const [del, setDel] = useState<Row | null>(null);
  const [bulkDel, setBulkDel] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(0), [dq, type, account, category, uncat, from, to, sort, dir]);
  useEffect(() => {
    const n = sp.get("new");
    if (n === "income" || n === "expense" || n === "transfer") {
      openAdd({ type: n });
      router.replace("/app/transactions");
    }
  }, [sp, openAdd, router]);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE), sort, dir });
    if (dq) p.set("q", dq);
    if (type) p.set("type", type);
    if (account) p.set("account", account);
    if (category) p.set("category", category);
    if (uncat) p.set("uncategorized", "1");
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p.toString();
  }, [dq, type, account, category, uncat, from, to, sort, dir, page]);

  const { data, error, isLoading, mutate } = useSWR<{ items: Row[]; total: number }>(`/api/transactions?${qs}`, {
    keepPreviousData: true,
  });
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const filtered = !!(dq || type || account || category || uncat || from || to);
  const canWrite = biz && biz.role !== "viewer";
  const cur = biz?.currency.trim() ?? "EGP";

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id));

  const openEdit = (r: Row) => {
    setEdit({
      id: r.id,
      type: r.type,
      date: r.date,
      amount: r.amount,
      account_id: r.account_id,
      to_account_id: r.to_account_id ?? "",
      category_id: r.category_id ?? "",
      payee_id: r.payee_id ?? "",
      description: r.description,
      notes: r.notes ?? "",
      direction: r.direction ?? "out",
      source: r.source,
    });
    setEditOpen(true);
  };

  const remove = async (id: string) => {
    await api.del(`/api/transactions/${id}`);
    await refreshAll();
    toast({ title: "Transaction deleted", description: "Totals have been recalculated." });
  };

  const bulk = async (action: "categorize" | "delete" | "reconcile", category_id?: string | null) => {
    const r = await api.post<{ updated: number }>("/api/transactions/bulk", {
      ids: [...sel],
      action,
      category_id,
      reconciled: true,
    });
    setSel(new Set());
    await refreshAll();
    toast({ title: `${r.updated} transaction${r.updated === 1 ? "" : "s"} updated` });
  };

  const catOptions = (cats?.items ?? []).filter((c) => !c.archived);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        subtitle="Every record behind your numbers. Edit or delete one and every total, budget and forecast follows."
        actions={
          <>
            <Button href="/app/settings/data" variant="secondary">
              <FileUp className="size-4" aria-hidden /> Import
            </Button>
            <a
              href="/api/export/transactions"
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-raised px-4 text-sm font-medium text-ink shadow-sm transition hover:border-line2 active:scale-[0.97]"
            >
              <Download className="size-4" aria-hidden /> Export
            </a>
            <Button variant="primary" onClick={() => openAdd()} disabled={!canWrite}>
              Add transaction
            </Button>
          </>
        }
      />

      <Card className="p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink3"
              aria-hidden
            />
            <Input
              aria-label="Search transactions"
              placeholder="Search description, notes or payee"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="ps-9"
            />
          </div>
          <Select
            aria-label="Account"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            className="w-auto max-w-[11rem]"
          >
            <option value="">All accounts</option>
            {(accts?.items ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Category"
            value={category}
            onChange={(e) => (setCategory(e.target.value), setUncat(false))}
            className="w-auto max-w-[12rem]"
          >
            <option value="">All categories</option>
            {catOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.parent_id ? "— " : ""}
                {c.name}
              </option>
            ))}
          </Select>
          <Input
            aria-label="From date"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-auto"
          />
          <Input
            aria-label="To date"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-auto"
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Type"
              value={type as "" | Row["type"]}
              onChange={(v) => setType(v)}
              options={[
                { value: "", label: "All" },
                { value: "income", label: "Income" },
                { value: "expense", label: "Expenses" },
                { value: "transfer", label: "Transfers" },
                { value: "refund", label: "Refunds" },
              ]}
            />
            <button
              onClick={() => setUncat((u) => !u)}
              aria-pressed={uncat}
              className={clsx(
                "h-8 rounded-lg border px-3 text-[13px] font-medium transition",
                uncat ? "border-accent bg-accentsoft text-accent" : "border-line text-ink2 hover:border-line2",
              )}
            >
              Uncategorized
            </button>
            {filtered && (
              <button
                onClick={() => (
                  setQ(""), setType(""), setAccount(""), setCategory(""), setUncat(false), setFrom(""), setTo("")
                )}
                className="h-8 rounded-lg px-2 text-[13px] text-ink3 underline underline-offset-2 hover:text-ink"
              >
                Clear filters
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 text-[13px] text-ink3">
            <label htmlFor="sort">Sort</label>
            <Select
              id="sort"
              value={`${sort}:${dir}`}
              onChange={(e) => (
                setSort(e.target.value.split(":")[0]), setDir(e.target.value.split(":")[1] as "asc" | "desc")
              )}
              className="h-9 w-auto text-[13px]"
            >
              <option value="date:desc">Newest first</option>
              <option value="date:asc">Oldest first</option>
              <option value="amount:desc">Largest amount</option>
              <option value="amount:asc">Smallest amount</option>
              <option value="description:asc">Description A–Z</option>
            </Select>
          </div>
        </div>
      </Card>

      <AnimatePresence>
        {sel.size > 0 && canWrite && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="sticky top-20 z-10 flex flex-wrap items-center gap-2 rounded-2xl border border-accent bg-accentsoft px-4 py-2.5 shadow-md"
          >
            <span className="text-sm font-medium text-accent">{sel.size} selected</span>
            <Select
              aria-label="Set category for selected"
              className="h-9 w-auto max-w-[14rem] text-[13px]"
              value=""
              onChange={(e) =>
                e.target.value && bulk("categorize", e.target.value === "__none" ? null : e.target.value)
              }
            >
              <option value="">Set category…</option>
              <option value="__none">Uncategorized</option>
              {catOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Button size="sm" onClick={() => bulk("reconcile")}>
              <Check className="size-4" aria-hidden /> Mark reconciled
            </Button>
            <Button size="sm" variant="danger" onClick={() => setBulkDel(true)}>
              <Trash2 className="size-4" aria-hidden /> Delete
            </Button>
            <button className="ms-auto text-[13px] text-ink2 underline" onClick={() => setSel(new Set())}>
              Clear
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {error ? (
        <ErrorNote error={error} onRetry={() => mutate()} />
      ) : isLoading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ArrowUpRight className="size-6" />}
          title={filtered ? "No transactions match these filters" : "No transactions yet"}
          body={
            filtered
              ? "Try removing a filter or widening the dates."
              : "Record your first sale or expense and watch your totals come alive. You can also import a CSV from your bank."
          }
          action={
            filtered ? (
              <Button
                onClick={() => (
                  setQ(""), setType(""), setAccount(""), setCategory(""), setUncat(false), setFrom(""), setTo("")
                )}
              >
                Clear filters
              </Button>
            ) : (
              <>
                <Button variant="primary" onClick={() => openAdd({ type: "income" })}>
                  Add income
                </Button>
                <Button onClick={() => openAdd({ type: "expense" })}>Add expense</Button>
                <Button href="/app/settings/data">Import CSV</Button>
              </>
            )
          }
        />
      ) : (
        <Card className="overflow-hidden">
          {/* Desktop table */}
          <table className="hidden w-full text-sm md:table">
            <thead>
              <tr className="border-b border-line text-start">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allOn}
                    onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.id)))}
                    className="size-4 accent-[var(--accent)]"
                  />
                </th>
                <th className="eyebrow px-2 py-3 text-start font-normal">Date</th>
                <th className="eyebrow px-2 py-3 text-start font-normal">Description</th>
                <th className="eyebrow px-2 py-3 text-start font-normal">Category</th>
                <th className="eyebrow px-2 py-3 text-start font-normal">Account</th>
                <th className="eyebrow px-4 py-3 text-end font-normal">Amount</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <TxnRow
                  key={r.id}
                  r={r}
                  cur={cur}
                  selected={sel.has(r.id)}
                  onToggle={() => toggle(r.id)}
                  onEdit={() => openEdit(r)}
                  onDelete={() => setDel(r)}
                  canWrite={!!canWrite}
                />
              ))}
            </tbody>
          </table>
          {/* Mobile list */}
          <ul className="divide-y divide-line md:hidden">
            {rows.map((r) => {
              const m = TYPE_META[r.type];
              const out =
                r.type === "expense" ||
                (r.type === "refund" &&
                  r.category_id &&
                  catOptions.find((c) => c.id === r.category_id)?.kind !== "expense") ||
                (r.type === "adjustment" && r.direction === "out");
              return (
                <li key={r.id}>
                  <button
                    className="flex w-full items-center gap-3 px-4 py-3.5 text-start active:bg-sunken"
                    onClick={() => openEdit(r)}
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sunken text-ink2">
                      <m.icon className="size-[18px]" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-ink">
                        {r.description || m.label}
                      </span>
                      <span className="block truncate text-xs text-ink3">
                        {r.date} ·{" "}
                        {r.type === "transfer"
                          ? `${r.account_name} → ${r.to_account_name}`
                          : (r.category_name ?? "Uncategorized")}
                      </span>
                    </span>
                    <Money
                      value={out ? -r.amount : r.type === "transfer" ? r.amount : r.amount}
                      currency={r.currency.trim()}
                      sign={r.type !== "transfer"}
                      animate={false}
                      className={clsx(
                        "shrink-0 text-[15px] font-medium",
                        r.type === "income" ? "text-pos" : "text-ink",
                      )}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-[13px] text-ink3">
            <span>
              {total.toLocaleString()} record{total === 1 ? "" : "s"}
              {filtered ? " match" : ""} · page {page + 1} of {pages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        </Card>
      )}

      <p className="flex items-center gap-1.5 text-[13px] text-ink3">
        <Hint k="reconciled" /> Reconciled records are ones you have checked against a statement. Transfers and
        adjustments never count as revenue or expenses.
      </p>

      <TransactionModal
        open={editOpen}
        onOpenChange={setEditOpen}
        initial={edit ?? blankDraft()}
        onSaved={() => mutate()}
      />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title="Delete this transaction?"
        body={
          <>
            This removes <strong>{del?.description || "the record"}</strong> and recalculates your totals, budgets and
            forecast. This cannot be undone.
          </>
        }
        onConfirm={async () => {
          if (del) await remove(del.id);
        }}
      />
      <ConfirmDialog
        open={bulkDel}
        onOpenChange={setBulkDel}
        title={`Delete ${sel.size} transactions?`}
        body="They will be removed and every total recalculated. This cannot be undone."
        onConfirm={() => bulk("delete")}
      />
    </div>
  );
}

function TxnRow({
  r,
  cur,
  selected,
  onToggle,
  onEdit,
  onDelete,
  canWrite,
}: {
  r: Row;
  cur: string;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  canWrite: boolean;
}) {
  const m = TYPE_META[r.type];
  const { data: cats } = useCategories();
  const vendorRefund =
    r.type === "refund" && r.category_id && cats?.items.find((c) => c.id === r.category_id)?.kind === "expense";
  const out =
    r.type === "expense" ||
    (r.type === "refund" && !vendorRefund) ||
    (r.type === "adjustment" && r.direction === "out");
  const signed = r.type === "transfer" ? r.amount : out ? -r.amount : r.amount;
  return (
    <tr
      className={clsx(
        "group border-b border-line last:border-0 transition hover:bg-sunken/60",
        selected && "bg-accentsoft/50",
      )}
    >
      <td className="px-4 py-3">
        <input
          type="checkbox"
          aria-label={`Select ${r.description || "transaction"}`}
          checked={selected}
          onChange={onToggle}
          className="size-4 accent-[var(--accent)]"
        />
      </td>
      <td className="num whitespace-nowrap px-2 py-3 text-ink2">{r.date}</td>
      <td className="max-w-[22rem] px-2 py-3">
        <div className="flex items-center gap-2">
          <m.icon className="size-4 shrink-0 text-ink3" aria-hidden />
          <span className="truncate font-medium text-ink">{r.description || m.label}</span>
          {r.source !== "manual" && <Badge tone="info">{r.source}</Badge>}
          {r.reconciled && <Check className="size-3.5 shrink-0 text-pos" aria-label="Reconciled" />}
        </div>
        {r.payee_name && <p className="ms-6 truncate text-xs text-ink3">{r.payee_name}</p>}
      </td>
      <td className="px-2 py-3">
        {r.type === "transfer" ? (
          <Badge tone="info">Transfer</Badge>
        ) : r.type === "adjustment" ? (
          <Badge>Adjustment</Badge>
        ) : r.category_name ? (
          <span className="inline-flex items-center gap-1.5 text-ink2">
            <span className="size-2 rounded-full" style={{ background: r.category_color ?? "var(--ink-3)" }} />
            {r.category_name}
          </span>
        ) : (
          <span className="text-ink3">Uncategorized</span>
        )}
      </td>
      <td className="px-2 py-3 text-ink2">
        {r.type === "transfer" ? `${r.account_name} → ${r.to_account_name}` : r.account_name}
      </td>
      <td className="px-4 py-3 text-end">
        <Money
          value={signed}
          currency={r.currency.trim() || cur}
          sign={r.type !== "transfer"}
          animate={false}
          className={clsx("font-medium", r.type === "income" || vendorRefund ? "text-pos" : "text-ink")}
        />
      </td>
      <td className="px-2 py-3">
        <div className="flex justify-end gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
          <IconButton label="Edit" onClick={onEdit} disabled={!canWrite}>
            <Pencil className="size-4" />
          </IconButton>
          <IconButton label="Delete" onClick={onDelete} disabled={!canWrite}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      </td>
    </tr>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
