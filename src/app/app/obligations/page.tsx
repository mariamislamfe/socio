"use client";
import { CheckCircle2, Pause, Pencil, Play, Plus, Trash2, Users } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
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
  Tabs,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useAccounts, useCategories, useMe, usePayees } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

interface Inv {
  id: string;
  direction: "receivable" | "payable";
  payee_id: string | null;
  payee_name: string | null;
  number: string | null;
  description: string;
  amount: number;
  paid: number;
  outstanding: number;
  currency: string;
  issue_date: string;
  due_date: string;
  category_id: string | null;
  status: string;
  state: "paid" | "partial" | "overdue" | "due_soon" | "open" | "void";
}
interface Rec {
  id: string;
  name: string;
  direction: "in" | "out";
  kind: string;
  amount: number;
  currency: string;
  category_id: string | null;
  category_name: string | null;
  payee_name: string | null;
  frequency: string;
  next_due: string;
  end_date: string | null;
  active: boolean;
}
type Tab = "payables" | "receivables" | "recurring" | "people";
const STATE: Record<Inv["state"], { tone: "pos" | "neg" | "warn" | "info" | "neutral"; label: string }> = {
  paid: { tone: "pos", label: "Paid" },
  partial: { tone: "info", label: "Partly paid" },
  overdue: { tone: "neg", label: "Overdue" },
  due_soon: { tone: "warn", label: "Due soon" },
  open: { tone: "neutral", label: "Open" },
  void: { tone: "neutral", label: "Void" },
};
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function Inner() {
  const sp = useSearchParams();
  const router = useRouter();
  const { biz } = useMe();
  const [tab, setTab] = useState<Tab>((sp.get("tab") as Tab) || "payables");
  const canWrite = biz && biz.role !== "viewer";
  const cur = biz?.currency.trim() ?? "EGP";
  const inv = useSWR<{ items: Inv[]; today: string }>("/api/invoices");
  const rec = useSWR<{ items: Rec[] }>("/api/recurring");
  const payees = usePayees();
  const [invModal, setInvModal] = useState<{ open: boolean; direction: "payable" | "receivable" }>({
    open: false,
    direction: "payable",
  });
  const [payFor, setPayFor] = useState<Inv | null>(null);
  const [recModal, setRecModal] = useState<{ open: boolean; edit?: Rec }>({ open: false });
  const [recordFor, setRecordFor] = useState<Rec | null>(null);
  const [delInv, setDelInv] = useState<Inv | null>(null);
  const [delRec, setDelRec] = useState<Rec | null>(null);
  const [personModal, setPersonModal] = useState(false);
  const { toast } = useUi();

  useEffect(() => {
    const t = sp.get("tab");
    if (t === "payables" || t === "receivables" || t === "recurring" || t === "people") setTab(t);
  }, [sp]);
  const choose = (t: Tab) => {
    setTab(t);
    router.replace(`/app/obligations?tab=${t}`);
  };

  const items = inv.data?.items ?? [];
  const payables = items.filter((i) => i.direction === "payable");
  const receivables = items.filter((i) => i.direction === "receivable");
  const sumOpen = (a: Inv[]) => a.filter((i) => i.status === "open").reduce((s, i) => s + i.outstanding, 0);
  const sumOverdue = (a: Inv[]) => a.filter((i) => i.state === "overdue").reduce((s, i) => s + i.outstanding, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bills & invoices"
        subtitle="Money you still owe, money you are still waiting for, and the payments that repeat. Everything open here feeds your cash forecast. Recording a payment updates your books — Socio never moves money."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <div className="flex items-center gap-1">
            <span className="eyebrow">You owe</span>
            <Hint k="payable" />
          </div>
          <p className="fig mt-1 text-3xl">
            <Money value={sumOpen(payables)} currency={cur} />
          </p>
          <p className="mt-0.5 text-xs text-ink3">
            {sumOverdue(payables) > 0 ? `${formatMoney(sumOverdue(payables), cur)} overdue` : "Nothing overdue"}
          </p>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-1">
            <span className="eyebrow">Owed to you</span>
            <Hint k="receivable" />
          </div>
          <p className="fig mt-1 text-3xl">
            <Money value={sumOpen(receivables)} currency={cur} />
          </p>
          <p className="mt-0.5 text-xs text-ink3">
            {sumOverdue(receivables) > 0 ? `${formatMoney(sumOverdue(receivables), cur)} overdue` : "Nothing overdue"}
          </p>
        </Card>
        <Card className="p-5">
          <span className="eyebrow">Recurring commitments</span>
          <p className="fig mt-1 text-3xl">
            {(rec.data?.items ?? []).filter((r) => r.active && r.direction === "out").length}
          </p>
          <p className="mt-0.5 text-xs text-ink3">active schedules</p>
        </Card>
      </div>

      <Tabs
        value={tab}
        onChange={choose}
        tabs={[
          {
            value: "payables",
            label: "Bills you owe",
            count: payables.filter((i) => i.status === "open" && i.outstanding > 0).length,
          },
          {
            value: "receivables",
            label: "Invoices to collect",
            count: receivables.filter((i) => i.status === "open" && i.outstanding > 0).length,
          },
          { value: "recurring", label: "Recurring", count: rec.data?.items.length },
          { value: "people", label: "Suppliers & customers", count: payees.data?.items.length },
        ]}
      />

      {(tab === "payables" || tab === "receivables") && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!canWrite}
              onClick={() => setInvModal({ open: true, direction: tab === "payables" ? "payable" : "receivable" })}
            >
              <Plus className="size-4" aria-hidden /> {tab === "payables" ? "Add a bill" : "Add an invoice"}
            </Button>
          </div>
          {inv.error ? (
            <ErrorNote error={inv.error} onRetry={() => inv.mutate()} />
          ) : !inv.data ? (
            <Skeleton className="h-40" />
          ) : (tab === "payables" ? payables : receivables).length === 0 ? (
            <EmptyState
              icon={<Users className="size-6" />}
              title={tab === "payables" ? "No bills recorded" : "No invoices recorded"}
              body={
                tab === "payables"
                  ? "Add supplier bills with their due dates so your cash forecast knows what is coming."
                  : "Add invoices you are waiting on. They appear in your forecast on their due date — never as cash already received."
              }
              action={
                canWrite && (
                  <Button
                    variant="primary"
                    onClick={() =>
                      setInvModal({ open: true, direction: tab === "payables" ? "payable" : "receivable" })
                    }
                  >
                    {tab === "payables" ? "Add a bill" : "Add an invoice"}
                  </Button>
                )
              }
            />
          ) : (
            <ul className="space-y-3">
              {(tab === "payables" ? payables : receivables).map((i) => {
                const st = STATE[i.state];
                return (
                  <li key={i.id}>
                    <Card className="p-4 sm:p-5">
                      <div className="flex flex-wrap items-start gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-[15px] font-semibold text-ink">{i.description}</h3>
                            <Badge tone={st.tone}>{st.label}</Badge>
                            {i.number && <span className="text-xs text-ink3">#{i.number}</span>}
                          </div>
                          <p className="mt-0.5 text-[13px] text-ink3">
                            {i.payee_name ? `${i.payee_name} · ` : ""}issued {i.issue_date} · due{" "}
                            <span className={clsx(i.state === "overdue" && "font-medium text-neg")}>{i.due_date}</span>
                          </p>
                          {i.paid > 0 && i.state !== "paid" && (
                            <Progress
                              className="mt-3 max-w-xs"
                              value={i.paid / i.amount}
                              tone="accent"
                              label="Paid so far"
                            />
                          )}
                        </div>
                        <div className="text-end">
                          <p className="fig text-2xl">
                            <Money
                              value={i.state === "paid" ? i.amount : i.outstanding}
                              currency={i.currency.trim()}
                              animate={false}
                            />
                          </p>
                          <p className="text-xs text-ink3">
                            {i.state === "paid"
                              ? "settled"
                              : i.paid > 0
                                ? `of ${formatMoney(i.amount, i.currency.trim())}`
                                : "outstanding"}
                          </p>
                        </div>
                      </div>
                      {canWrite && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                          {i.outstanding > 0 && i.status === "open" && (
                            <Button size="sm" variant="primary" onClick={() => setPayFor(i)}>
                              <CheckCircle2 className="size-4" aria-hidden />{" "}
                              {i.direction === "payable" ? "Record payment made" : "Record payment received"}
                            </Button>
                          )}
                          {i.status === "open" && i.paid === 0 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={async () => {
                                await api.patch(`/api/invoices/${i.id}`, { status: "void" });
                                await refreshAll();
                                toast({ title: "Marked as void" });
                              }}
                            >
                              Void
                            </Button>
                          )}
                          {i.paid === 0 && (
                            <IconButton label="Delete" className="ms-auto" onClick={() => setDelInv(i)}>
                              <Trash2 className="size-4" />
                            </IconButton>
                          )}
                        </div>
                      )}
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {tab === "recurring" && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button variant="primary" disabled={!canWrite} onClick={() => setRecModal({ open: true })}>
              <Plus className="size-4" aria-hidden /> Add recurring payment
            </Button>
          </div>
          {!rec.data ? (
            <Skeleton className="h-40" />
          ) : rec.data.items.length === 0 ? (
            <EmptyState
              title="No recurring payments"
              body="Rent, salaries, freelancers, subscriptions — add them once and they appear in every forecast and budget projection."
              action={
                canWrite && (
                  <Button variant="primary" onClick={() => setRecModal({ open: true })}>
                    Add one
                  </Button>
                )
              }
            />
          ) : (
            <ul className="space-y-3">
              {rec.data.items.map((r) => (
                <li key={r.id}>
                  <Card className={clsx("p-4 sm:p-5", !r.active && "opacity-60")}>
                    <div className="flex flex-wrap items-start gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[15px] font-semibold text-ink">{r.name}</h3>
                          <Badge>{r.kind}</Badge>
                          <Badge tone={r.direction === "in" ? "pos" : "neutral"}>{r.frequency}</Badge>
                          {!r.active && <Badge tone="warn">Paused</Badge>}
                        </div>
                        <p className="mt-0.5 text-[13px] text-ink3">
                          Next {r.direction === "in" ? "receipt" : "payment"}{" "}
                          <strong className="text-ink2">{r.next_due}</strong>
                          {r.category_name ? ` · ${r.category_name}` : ""}
                          {r.payee_name ? ` · ${r.payee_name}` : ""}
                        </p>
                      </div>
                      <p className="fig text-2xl">
                        <Money value={r.amount} currency={r.currency.trim()} animate={false} />
                      </p>
                    </div>
                    {canWrite && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                        {r.active && (
                          <Button size="sm" variant="primary" onClick={() => setRecordFor(r)}>
                            <CheckCircle2 className="size-4" aria-hidden />{" "}
                            {r.direction === "in" ? "Record as received" : "Record as paid"}
                          </Button>
                        )}
                        <IconButton label="Edit" onClick={() => setRecModal({ open: true, edit: r })}>
                          <Pencil className="size-4" />
                        </IconButton>
                        <IconButton
                          label={r.active ? "Pause" : "Resume"}
                          onClick={async () => {
                            await api.patch(`/api/recurring/${r.id}`, { active: !r.active });
                            await refreshAll();
                          }}
                        >
                          {r.active ? <Pause className="size-4" /> : <Play className="size-4" />}
                        </IconButton>
                        <IconButton label="Delete" className="ms-auto" onClick={() => setDelRec(r)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "people" && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button variant="primary" disabled={!canWrite} onClick={() => setPersonModal(true)}>
              <Plus className="size-4" aria-hidden /> Add supplier or customer
            </Button>
          </div>
          {(payees.data?.items ?? []).length === 0 ? (
            <EmptyState
              title="No suppliers or customers yet"
              body="Add the people and companies you pay or invoice so bills and transactions can be attributed to them."
            />
          ) : (
            <Card>
              <ul className="divide-y divide-line">
                {payees.data!.items.map((p) => (
                  <li key={p.id} className="flex items-center justify-between px-5 py-3.5">
                    <span className="text-[15px] text-ink">{p.name}</span>
                    <span className="flex items-center gap-2">
                      <Badge>{p.kind}</Badge>
                      {canWrite && (
                        <IconButton
                          label={`Delete ${p.name}`}
                          onClick={async () => {
                            await api.del(`/api/payees/${p.id}`);
                            await refreshAll();
                          }}
                        >
                          <Trash2 className="size-4" />
                        </IconButton>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      <InvoiceModal state={invModal} onClose={() => setInvModal({ ...invModal, open: false })} currency={cur} />
      <PaymentModal inv={payFor} onClose={() => setPayFor(null)} />
      <RecurringModal state={recModal} onClose={() => setRecModal({ open: false })} currency={cur} />
      <RecordRecurring rec={recordFor} onClose={() => setRecordFor(null)} />
      <PersonModal open={personModal} onClose={() => setPersonModal(false)} />
      <ConfirmDialog
        open={!!delInv}
        onOpenChange={(o) => !o && setDelInv(null)}
        title="Delete this record?"
        body="It will no longer count in your cash forecast."
        onConfirm={async () => {
          await api.del(`/api/invoices/${delInv!.id}`);
          await refreshAll();
          toast({ title: "Deleted" });
        }}
      />
      <ConfirmDialog
        open={!!delRec}
        onOpenChange={(o) => !o && setDelRec(null)}
        title="Delete this schedule?"
        body="Past transactions stay. Future payments will no longer appear in forecasts."
        onConfirm={async () => {
          await api.del(`/api/recurring/${delRec!.id}`);
          await refreshAll();
          toast({ title: "Schedule deleted" });
        }}
      />
    </div>
  );
}

function useSave(onClose: () => void, okMsg: string) {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr({});
    try {
      await fn();
      await refreshAll();
      toast({ title: okMsg });
      onClose();
    } catch (x) {
      setErr(
        x instanceof ApiError
          ? { ...(x.fields ?? {}), _: x.fields ? "" : x.message }
          : { _: "Could not save. Check your connection." },
      );
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run, setErr };
}

function InvoiceModal({
  state,
  onClose,
  currency,
}: {
  state: { open: boolean; direction: "payable" | "receivable" };
  onClose: () => void;
  currency: string;
}) {
  const { data: payees } = usePayees();
  const { data: cats } = useCategories();
  const [f, setF] = useState({
    payee_id: "",
    description: "",
    number: "",
    amount: null as number | null,
    issue_date: today(),
    due_date: today(),
    category_id: "",
  });
  const { busy, err, run } = useSave(onClose, state.direction === "payable" ? "Bill added" : "Invoice added");
  useEffect(() => {
    if (state.open)
      setF({
        payee_id: "",
        description: "",
        number: "",
        amount: null,
        issue_date: today(),
        due_date: today(),
        category_id: "",
      });
  }, [state.open]);
  const payable = state.direction === "payable";
  return (
    <Modal
      open={state.open}
      onOpenChange={(o) => !o && onClose()}
      title={payable ? "Add a bill you owe" : "Add an invoice to collect"}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              run(() =>
                api.post("/api/invoices", {
                  direction: state.direction,
                  payee_id: f.payee_id || null,
                  description: f.description,
                  number: f.number || undefined,
                  amount: f.amount,
                  issue_date: f.issue_date,
                  due_date: f.due_date,
                  category_id: f.category_id || null,
                }),
              )
            }
          >
            Save
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
        <Field label="What is it for?" error={err.description} htmlFor="i-d">
          <Input
            id="i-d"
            value={f.description}
            onChange={(e) => setF({ ...f, description: e.target.value })}
            placeholder={payable ? "e.g. Fabric order — autumn batch" : "e.g. Wholesale order"}
            invalid={!!err.description}
          />
        </Field>
        <Field label={payable ? "Supplier" : "Customer"} htmlFor="i-p">
          <Select id="i-p" value={f.payee_id} onChange={(e) => setF({ ...f, payee_id: e.target.value })}>
            <option value="">None</option>
            {(payees?.items ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" error={err.amount} htmlFor="i-a">
            <MoneyInput
              id="i-a"
              value={f.amount}
              onChange={(v) => setF({ ...f, amount: v })}
              currency={currency}
              digits={currencyDigits(currency)}
              invalid={!!err.amount}
            />
          </Field>
          <Field label="Reference (optional)" htmlFor="i-n">
            <Input id="i-n" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
          </Field>
          <Field label="Issued" htmlFor="i-is">
            <Input
              id="i-is"
              type="date"
              value={f.issue_date}
              onChange={(e) => setF({ ...f, issue_date: e.target.value })}
            />
          </Field>
          <Field label="Due" error={err.due_date} htmlFor="i-du">
            <Input
              id="i-du"
              type="date"
              value={f.due_date}
              onChange={(e) => setF({ ...f, due_date: e.target.value })}
              invalid={!!err.due_date}
            />
          </Field>
        </div>
        <Field
          label="Category (optional)"
          htmlFor="i-c"
          hint={payable ? "Used by budgets when the bill is paid." : undefined}
        >
          <Select id="i-c" value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>
            <option value="">Choose…</option>
            {(cats?.items ?? [])
              .filter((c) => !c.archived && c.kind === (payable ? "expense" : "income"))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.parent_id ? "— " : ""}
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function AccountSelect({
  value,
  onChange,
  currency,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  currency?: string;
  error?: string;
}) {
  const { data } = useAccounts();
  const list = (data?.items ?? []).filter((a) => !a.archived && (!currency || a.currency.trim() === currency.trim()));
  useEffect(() => {
    if (!value && list[0]) onChange(list[0].id);
  }, [value, list, onChange]);
  return (
    <Field label="Account" error={error} htmlFor="acct">
      <Select id="acct" value={value} onChange={(e) => onChange(e.target.value)} invalid={!!error}>
        <option value="">Choose…</option>
        {list.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.currency.trim()}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function PaymentModal({ inv, onClose }: { inv: Inv | null; onClose: () => void }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(today());
  const [account, setAccount] = useState("");
  const { busy, err, run } = useSave(onClose, "Payment recorded");
  useEffect(() => {
    if (inv) setAmount(inv.outstanding), setDate(today());
  }, [inv]);
  return (
    <Modal
      open={!!inv}
      onOpenChange={(o) => !o && onClose()}
      title={inv?.direction === "payable" ? "Record a payment you made" : "Record a payment you received"}
      description="This updates your records and cash. Socio does not transfer any money."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              run(() => api.post(`/api/invoices/${inv!.id}/payments`, { amount, paid_on: date, account_id: account }))
            }
          >
            Record payment
          </Button>
        </>
      }
    >
      {inv && (
        <div className="space-y-4">
          <p className="rounded-xl bg-sunken px-3.5 py-3 text-sm text-ink2">
            <strong className="text-ink">{inv.description}</strong> —{" "}
            {formatMoney(inv.outstanding, inv.currency.trim())} outstanding. Enter less for a partial payment.
          </p>
          {err._ && (
            <p role="alert" className="rounded-xl bg-negsoft px-3 py-2 text-sm text-neg">
              {err._}
            </p>
          )}
          <Field label="Amount" error={err.amount} htmlFor="p-a">
            <MoneyInput
              id="p-a"
              value={amount}
              onChange={setAmount}
              currency={inv.currency.trim()}
              digits={currencyDigits(inv.currency.trim())}
              invalid={!!err.amount}
              autoFocus
            />
          </Field>
          <Field label="Date" htmlFor="p-d">
            <Input id="p-d" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <AccountSelect value={account} onChange={setAccount} currency={inv.currency} error={err.account_id} />
        </div>
      )}
    </Modal>
  );
}

function RecordRecurring({ rec, onClose }: { rec: Rec | null; onClose: () => void }) {
  const [account, setAccount] = useState("");
  const [date, setDate] = useState(today());
  const { busy, err, run } = useSave(onClose, "Recorded — next due date moved forward");
  return (
    <Modal
      open={!!rec}
      onOpenChange={(o) => !o && onClose()}
      title={rec?.direction === "in" ? "Record as received" : "Record as paid"}
      description="Creates a transaction and moves the next due date forward. No money is transferred by Socio."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => run(() => api.post(`/api/recurring/${rec!.id}/record`, { account_id: account, date }))}
          >
            Record
          </Button>
        </>
      }
    >
      {rec && (
        <div className="space-y-4">
          <p className="rounded-xl bg-sunken px-3.5 py-3 text-sm text-ink2">
            <strong className="text-ink">{rec.name}</strong> — {formatMoney(rec.amount, rec.currency.trim())}, due{" "}
            {rec.next_due}.
          </p>
          {err._ && (
            <p role="alert" className="rounded-xl bg-negsoft px-3 py-2 text-sm text-neg">
              {err._}
            </p>
          )}
          <Field label="Date" htmlFor="r-d">
            <Input id="r-d" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <AccountSelect value={account} onChange={setAccount} currency={rec.currency} error={err.account_id} />
        </div>
      )}
    </Modal>
  );
}

function RecurringModal({
  state,
  onClose,
  currency,
}: {
  state: { open: boolean; edit?: Rec };
  onClose: () => void;
  currency: string;
}) {
  const { data: cats } = useCategories();
  const e = state.edit;
  const [f, setF] = useState({
    name: "",
    direction: "out" as "in" | "out",
    kind: "other",
    amount: null as number | null,
    frequency: "monthly",
    next_due: today(),
    category_id: "",
  });
  const { busy, err, run } = useSave(onClose, e ? "Schedule updated" : "Schedule added");
  useEffect(() => {
    if (state.open)
      setF(
        e
          ? {
              name: e.name,
              direction: e.direction,
              kind: e.kind,
              amount: e.amount,
              frequency: e.frequency,
              next_due: e.next_due,
              category_id: e.category_id ?? "",
            }
          : {
              name: "",
              direction: "out",
              kind: "other",
              amount: null,
              frequency: "monthly",
              next_due: today(),
              category_id: "",
            },
      );
  }, [state.open, e]);
  return (
    <Modal
      open={state.open}
      onOpenChange={(o) => !o && onClose()}
      title={e ? "Edit recurring payment" : "Add a recurring payment"}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              run(() =>
                e
                  ? api.patch(`/api/recurring/${e.id}`, {
                      name: f.name,
                      amount: f.amount,
                      frequency: f.frequency,
                      next_due: f.next_due,
                      category_id: f.category_id || null,
                    })
                  : api.post("/api/recurring", { ...f, category_id: f.category_id || null }),
              )
            }
          >
            Save
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
        <Field label="Name" error={err.name} htmlFor="rc-n">
          <Input
            id="rc-n"
            value={f.name}
            onChange={(x) => setF({ ...f, name: x.target.value })}
            placeholder="e.g. Studio rent"
            invalid={!!err.name}
          />
        </Field>
        {!e && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type" htmlFor="rc-dir">
              <Select
                id="rc-dir"
                value={f.direction}
                onChange={(x) => setF({ ...f, direction: x.target.value as "in" | "out" })}
              >
                <option value="out">Money out</option>
                <option value="in">Money in</option>
              </Select>
            </Field>
            <Field label="Kind" htmlFor="rc-k">
              <Select id="rc-k" value={f.kind} onChange={(x) => setF({ ...f, kind: x.target.value })}>
                {[
                  "rent",
                  "utilities",
                  "salary",
                  "freelancer",
                  "subscription",
                  "supplier",
                  "shipping",
                  "tax",
                  "other",
                ].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" error={err.amount} htmlFor="rc-a">
            <MoneyInput
              id="rc-a"
              value={f.amount}
              onChange={(v) => setF({ ...f, amount: v })}
              currency={currency}
              digits={currencyDigits(currency)}
              invalid={!!err.amount}
            />
          </Field>
          <Field label="Repeats" htmlFor="rc-f">
            <Select id="rc-f" value={f.frequency} onChange={(x) => setF({ ...f, frequency: x.target.value })}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </Select>
          </Field>
        </div>
        <Field label="Next due" error={err.next_due} htmlFor="rc-d">
          <Input id="rc-d" type="date" value={f.next_due} onChange={(x) => setF({ ...f, next_due: x.target.value })} />
        </Field>
        <Field label="Category" htmlFor="rc-c" hint="Lets budgets count this payment before it happens.">
          <Select id="rc-c" value={f.category_id} onChange={(x) => setF({ ...f, category_id: x.target.value })}>
            <option value="">Choose…</option>
            {(cats?.items ?? [])
              .filter((c) => !c.archived && c.kind === (f.direction === "in" ? "income" : "expense"))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.parent_id ? "— " : ""}
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function PersonModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("supplier");
  const [email, setEmail] = useState("");
  const { busy, err, run } = useSave(onClose, "Added");
  useEffect(() => {
    if (open) setName("");
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add a supplier or customer"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => run(() => api.post("/api/payees", { name, kind, email }))}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" error={err.name} htmlFor="pp-n">
          <Input id="pp-n" value={name} onChange={(e) => setName(e.target.value)} invalid={!!err.name} />
        </Field>
        <Field
          label="Email (optional)"
          error={err.email}
          htmlFor="pp-e"
          hint="Only used for payment reminders you allow."
        >
          <Input
            id="pp-e"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            invalid={!!err.email}
          />
        </Field>
        <Field label="Kind" htmlFor="pp-k">
          <Select id="pp-k" value={kind} onChange={(e) => setKind(e.target.value)}>
            {["supplier", "customer", "contractor", "employee", "landlord", "platform", "other"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
