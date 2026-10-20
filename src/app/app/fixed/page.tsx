"use client";
import { Check, Pencil, Plus, Repeat, UserMinus, UsersRound, X } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import useSWR from "swr";
import { EntrySheet, type EntryTarget, type SimpleData } from "@/components/app/simple-home";
import { useUi } from "@/components/providers";
import {
  Badge,
  Button,
  Card,
  clsx,
  ErrorNote,
  Field,
  Input,
  Modal,
  MoneyInput,
  PageHeader,
  Segmented,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

interface Employee {
  id: string;
  name: string;
  role: string;
  salary: number;
  payDay: number;
  nextDue: string;
  status: "paid" | "due" | "late";
  lastPaid: string | null;
  early: boolean;
}
interface Data {
  currency: string;
  today: string;
  salaries: { payDay: number; employees: Employee[]; total: number; left: number; paid: number; payDate: string };
  fixed: {
    id: string;
    name: string;
    direction: "in" | "out";
    amount: number;
    frequency: string;
    nextDue: string;
    category: string | null;
  }[];
  bills: {
    id: string;
    label: string;
    direction: "payable" | "receivable";
    amount: number;
    due: string;
    late: boolean;
  }[];
}

const dayMonth = (d: string) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });
const FREQ: Record<string, string> = {
  weekly: "Every week",
  monthly: "Every month",
  quarterly: "Every 3 months",
  yearly: "Every year",
};

/* Bills & fixed costs: salaries (one row per person), costs that repeat, and one-off bills. */
export default function FixedPage() {
  const { data, error, mutate } = useSWR<Data>("/api/fixed");
  const { data: simple } = useSWR<SimpleData>("/api/simple");
  const { toast } = useUi();
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [paying, setPaying] = useState<Employee | null>(null);
  const [payDayOpen, setPayDayOpen] = useState(false);
  const [entry, setEntry] = useState<EntryTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (!data) return <Skeleton className="h-96" />;
  const cur = data.currency;
  const fm = (v: number) => formatMoney(v, cur);
  const done = (title: string, description?: string) => {
    toast({ title, description });
    mutate();
    refreshAll();
  };
  const run = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try {
      await fn();
      done(ok, "Your cash is updated.");
    } catch (x) {
      toast({ title: "Not saved", description: x instanceof ApiError ? x.message : undefined, tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const s = data.salaries;
  const unpaid = s.employees.filter((e) => e.status !== "paid");

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Bills & fixed costs"
        subtitle="Everything you pay regularly, in one place. Tap “Paid” when it is paid, and we remind you of the rest."
      />

      {/* Salaries */}
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="display flex items-center gap-2 text-xl">
              <UsersRound className="size-5 text-accent" aria-hidden /> Salaries
            </h2>
            <p className="mt-1 text-[13px] text-ink3">
              {s.employees.length === 0 ? (
                "Add the people you pay every month."
              ) : (
                <>
                  {s.employees.length === 1 ? "1 person" : `${s.employees.length} people`} ·{" "}
                  <span className="num">{fm(s.total)}</span> a month · paid on day {s.payDay}{" "}
                  <button onClick={() => setPayDayOpen(true)} className="font-medium text-accent">
                    Change
                  </button>
                </>
              )}
            </p>
          </div>
          <Button onClick={() => setEditing("new")}>
            <Plus className="size-4" aria-hidden /> Add employee
          </Button>
        </div>

        {s.employees.length > 0 && (
          <>
            <div className="mt-4">
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-ink2">Paid this month</span>
                <span className="num text-ink">
                  {fm(s.paid)} of {fm(s.total)}
                </span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sunken">
                <motion.div
                  className="h-full rounded-full bg-pos"
                  initial={{ width: 0 }}
                  animate={{ width: `${s.total ? (s.paid / s.total) * 100 : 0}%` }}
                />
              </div>
            </div>
            <ul className="mt-4 divide-y divide-line">
              {s.employees.map((e) => (
                <li key={e.id} className="flex items-center gap-3 py-3">
                  <span
                    aria-hidden
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accentsoft text-[15px] font-semibold text-ink"
                  >
                    {e.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium text-ink" data-no-translate>
                      {e.name}
                    </p>
                    <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink3">
                      {e.role && <span>{e.role}</span>}
                      {e.status === "paid" ? (
                        <Badge tone="pos">{e.early ? "Paid early" : "Paid"}</Badge>
                      ) : e.status === "late" ? (
                        <Badge tone="neg">Late</Badge>
                      ) : (
                        <Badge tone="info">Due {dayMonth(e.nextDue)}</Badge>
                      )}
                      {e.status === "paid" && e.lastPaid && (
                        <span>
                          on {dayMonth(e.lastPaid)} · next {dayMonth(e.nextDue)}
                        </span>
                      )}
                    </p>
                  </div>
                  <p className="num shrink-0 text-[15px] font-semibold text-ink">{fm(e.salary)}</p>
                  {e.status !== "paid" && (
                    <button
                      onClick={() => setPaying(e)}
                      className="shrink-0 rounded-xl border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink2 transition hover:border-pos hover:text-pos"
                      aria-label={`Mark ${e.name} as paid`}
                    >
                      <Check className="inline size-3.5" aria-hidden /> Got paid
                    </button>
                  )}
                  <button
                    onClick={() => setEditing(e)}
                    className="shrink-0 rounded-lg p-1.5 text-ink3 hover:bg-sunken hover:text-ink"
                    aria-label={`Edit ${e.name}`}
                  >
                    <Pencil className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            {unpaid.length > 1 && (
              <Button
                className="mt-2 w-full"
                variant="primary"
                loading={busy === "all"}
                onClick={() =>
                  run("all", () => api.post("/api/fixed/salaries/pay-all", {}), "Everyone is marked as paid")
                }
              >
                <Check className="size-4" aria-hidden /> Pay everyone now ({fm(s.left)})
              </Button>
            )}
          </>
        )}
      </Card>

      {/* Fixed costs that repeat */}
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="display flex items-center gap-2 text-xl">
              <Repeat className="size-5 text-accent" aria-hidden /> Fixed costs
            </h2>
            <p className="mt-1 text-[13px] text-ink3">
              Rent, subscriptions, internet: the same amount every month or year.
            </p>
          </div>
          <Button disabled={!simple} onClick={() => setEntry({ dir: "out", repeat: "monthly" })}>
            <Plus className="size-4" aria-hidden /> Add a fixed cost
          </Button>
        </div>
        {data.fixed.length === 0 ? (
          <p className="mt-4 rounded-2xl bg-sunken px-4 py-6 text-center text-[14px] text-ink3">Nothing yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {data.fixed.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium text-ink">{r.name}</p>
                  <p className="text-xs text-ink3">
                    {FREQ[r.frequency] ?? r.frequency} · next {dayMonth(r.nextDue)}
                    {r.nextDue < data.today ? " · late" : ""}
                  </p>
                </div>
                <p
                  className={clsx(
                    "num shrink-0 text-[15px] font-semibold",
                    r.direction === "in" ? "text-pos" : "text-ink",
                  )}
                >
                  {fm(r.amount)}
                </p>
                <button
                  disabled={busy === r.id}
                  onClick={() =>
                    run(
                      r.id,
                      () =>
                        api.post("/api/simple/paid", {
                          kind: r.direction === "in" ? "recurring_in" : "recurring_out",
                          refId: r.id,
                        }),
                      r.direction === "in" ? "Marked as received" : "Marked as paid",
                    )
                  }
                  className="shrink-0 rounded-xl border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink2 transition hover:border-pos hover:text-pos disabled:opacity-50"
                >
                  <Check className="inline size-3.5" aria-hidden /> {r.direction === "in" ? "Received" : "Paid"}
                </button>
                <button
                  onClick={() =>
                    run(
                      r.id,
                      () => api.post(`/api/fixed/${r.id}/stop`, {}),
                      "Stopped. Past payments stay in your books.",
                    )
                  }
                  className="shrink-0 rounded-lg p-1.5 text-ink3 hover:bg-sunken hover:text-neg"
                  aria-label={`Stop ${r.name}`}
                  title="It stopped (no more reminders)"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* One-off bills and money owed to you */}
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="display text-xl">Bills and money owed to you</h2>
            <p className="mt-1 text-[13px] text-ink3">
              One-off amounts with a date: a supplier bill to pay, or a customer who will pay you later.
            </p>
          </div>
          <Button disabled={!simple} onClick={() => setEntry({ dir: "out", date: addDay(data.today), pickDir: true })}>
            <Plus className="size-4" aria-hidden /> Add one
          </Button>
        </div>
        {data.bills.length === 0 ? (
          <p className="mt-4 rounded-2xl bg-sunken px-4 py-6 text-center text-[14px] text-ink3">Nothing open.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {data.bills.map((b) => (
              <li key={b.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium text-ink">{b.label}</p>
                  <p className={clsx("text-xs", b.late ? "text-neg" : "text-ink3")}>
                    {b.direction === "receivable" ? "Money coming in" : "To pay"} · {dayMonth(b.due)}
                    {b.late ? " · late" : ""}
                  </p>
                </div>
                <p
                  className={clsx(
                    "num shrink-0 text-[15px] font-semibold",
                    b.direction === "receivable" ? "text-pos" : "text-ink",
                  )}
                >
                  {fm(b.amount)}
                </p>
                <button
                  disabled={busy === b.id}
                  onClick={() =>
                    run(
                      b.id,
                      () => api.post("/api/simple/paid", { kind: b.direction, refId: b.id }),
                      b.direction === "receivable" ? "Marked as received" : "Marked as paid",
                    )
                  }
                  className="shrink-0 rounded-xl border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink2 transition hover:border-pos hover:text-pos disabled:opacity-50"
                >
                  <Check className="inline size-3.5" aria-hidden /> {b.direction === "receivable" ? "Received" : "Paid"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <EmployeeSheet
        target={editing}
        cur={cur}
        defaultPayDay={s.payDay}
        onClose={() => setEditing(null)}
        onSaved={(t) => done(t)}
      />
      <PaySheet
        emp={paying}
        today={data.today}
        cur={cur}
        onClose={() => setPaying(null)}
        onSaved={(t) => done(t, "Your cash is updated.")}
      />
      <PayDaySheet open={payDayOpen} current={s.payDay} onClose={() => setPayDayOpen(false)} onSaved={(t) => done(t)} />
      {simple && <EntrySheet target={entry} onClose={() => setEntry(null)} d={simple} onSaved={(msg) => done(msg)} />}
    </div>
  );
}

function addDay(d: string) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + 7);
  return x.toISOString().slice(0, 10);
}

function EmployeeSheet({
  target,
  cur,
  defaultPayDay,
  onClose,
  onSaved,
}: {
  target: Employee | "new" | null;
  cur: string;
  defaultPayDay: number;
  onClose: () => void;
  onSaved: (t: string) => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [salary, setSalary] = useState<number | null>(null);
  const [payDay, setPayDay] = useState(String(defaultPayDay));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const key = target === null ? null : target === "new" ? "new" : target.id;
  if (key !== shown) {
    setShown(key);
    const e = target && target !== "new" ? target : null;
    setName(e?.name ?? "");
    setRole(e?.role ?? "");
    setSalary(e?.salary ?? null);
    setPayDay(String(e?.payDay ?? defaultPayDay));
    setErr("");
  }
  const isNew = target === "new";
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const body = { name, role, salary: salary ?? 0, payDay: Number(payDay) };
      if (isNew) await api.post("/api/fixed/employees", body);
      else if (target) await api.patch(`/api/fixed/employees/${target.id}`, body);
      onSaved(isNew ? "Employee added — we will remind you on pay day" : "Saved");
      onClose();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!target || target === "new") return;
    setBusy(true);
    try {
      await api.post(`/api/fixed/${target.id}/stop`, {});
      onSaved("Removed. Their past salaries stay in your books.");
      onClose();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={target !== null}
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? "Add employee" : "Edit employee"}
      size="sm"
      footer={
        <>
          {!isNew && (
            <Button variant="ghost" className="me-auto text-neg" onClick={remove} disabled={busy}>
              <UserMinus className="size-4" aria-hidden /> Left the team
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !salary} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ahmed" autoFocus />
        </Field>
        <Field label="Job (optional)">
          <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Packing & delivery" />
        </Field>
        <Field label="Monthly salary">
          <MoneyInput value={salary} onChange={setSalary} currency={cur} digits={currencyDigits(cur)} />
        </Field>
        <Field
          label="Pay day (day of the month)"
          hint="Everyone usually gets paid on the same day. You can still mark someone as paid early."
        >
          <Input type="number" min={1} max={28} value={payDay} onChange={(e) => setPayDay(e.target.value)} />
        </Field>
        {err && <p className="text-sm text-neg">{err}</p>}
      </div>
    </Modal>
  );
}

function PaySheet({
  emp,
  today,
  cur,
  onClose,
  onSaved,
}: {
  emp: Employee | null;
  today: string;
  cur: string;
  onClose: () => void;
  onSaved: (t: string) => void;
}) {
  const [when, setWhen] = useState<"today" | "other">("today");
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  if ((emp?.id ?? null) !== shown) {
    setShown(emp?.id ?? null);
    setWhen("today");
    setDate(today);
    setErr("");
  }
  if (!emp) return null;
  const day = when === "today" ? today : date;
  const early = day < emp.nextDue;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${emp.name} got paid`}
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
                await api.post(`/api/fixed/employees/${emp.id}/pay`, { date: day });
                onSaved(early ? "Recorded — paid early" : "Recorded as paid");
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
        <p className="text-[15px] text-ink2">
          Salary <strong className="num text-ink">{formatMoney(emp.salary, cur)}</strong>, due on{" "}
          {dayMonth(emp.nextDue)}.
        </p>
        <Field label="When?">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={when}
              onChange={setWhen}
              options={[
                { value: "today", label: "Today" },
                { value: "other", label: "Another day" },
              ]}
              label="When?"
            />
            {when === "other" && (
              <Input type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
            )}
          </div>
        </Field>
        {early && (
          <p className="rounded-xl bg-sunken px-3 py-2 text-[13px] text-ink2">
            Paid early: it is recorded today, and their next salary moves to next month.
          </p>
        )}
        {err && <p className="text-sm text-neg">{err}</p>}
      </div>
    </Modal>
  );
}

function PayDaySheet({
  open,
  current,
  onClose,
  onSaved,
}: {
  open: boolean;
  current: number;
  onClose: () => void;
  onSaved: (t: string) => void;
}) {
  const [v, setV] = useState(String(current));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Everyone's pay day"
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
                await api.patch("/api/fixed/salaries", { payDay: Number(v) });
                onSaved("Pay day changed for everyone");
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
      <Field label="Day of the month (1–28)">
        <Input type="number" min={1} max={28} value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      </Field>
      {err && <p className="mt-2 text-sm text-neg">{err}</p>}
    </Modal>
  );
}
