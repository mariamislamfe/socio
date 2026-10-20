"use client";
import { ArrowDownLeft, ArrowUpRight, CalendarDays, Check, ChevronRight, Lightbulb, Repeat } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { useUi } from "@/components/providers";
import {
  Button,
  Card,
  clsx,
  ErrorNote,
  Field,
  Hint,
  Input,
  Modal,
  MoneyInput,
  Segmented,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

interface Upcoming {
  date: string;
  label: string;
  amount: number;
  kind: string;
  refId: string | null;
  late: boolean;
  people?: number;
}
export interface SimpleData {
  currency: string;
  today: string;
  hasData: boolean;
  cash: number;
  safeToSpend: number;
  reserve: number | null;
  safe: { cash: number; taxes: number; bills30: number; reserve: number; free: number };
  month: { income: number; spent: number; kept: number; ownerTook: number };
  upcoming: Upcoming[];
  attention: { title: string; kind: string } | null;
  categories: { in: string[]; out: string[] };
  hasAccount: boolean;
}
type Data = SimpleData;
export type EntryTarget = { dir: "in" | "out"; repeat?: "monthly"; date?: string; pickDir?: boolean };

/* The beginner's home: what you have, add money in or out, and what is coming. Nothing else. */
export function SimpleHome() {
  const { data, error, mutate } = useSWR<Data>("/api/simple");
  const [entry, setEntry] = useState<EntryTarget | null>(null);
  const [why, setWhy] = useState(false);
  const { toast } = useUi();
  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (!data) return <Skeleton className="h-96" />;
  const cur = data.currency;
  const fm = (v: number) => formatMoney(v, cur);
  const paid = async (u: Upcoming) => {
    if (!u.refId) return;
    try {
      await api.post("/api/simple/paid", { kind: u.kind, refId: u.refId });
      toast({ title: u.amount > 0 ? "Marked as received" : "Marked as paid", description: "Your cash is updated." });
      mutate();
      refreshAll();
    } catch (x) {
      toast({ title: "Not saved", description: x instanceof ApiError ? x.message : undefined, tone: "error" });
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {/* What you have */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="overflow-hidden p-6 text-center sm:p-8">
          <p className="text-[15px] text-ink2">Money you have now</p>
          <p className="display mt-1 text-5xl sm:text-6xl">{fm(data.cash)}</p>
          {data.hasData && (
            <p className="mt-3 inline-flex flex-wrap items-center justify-center gap-1 rounded-full bg-possoft px-4 py-1.5 text-[14px] text-pos">
              You can safely spend <strong className="num">{fm(data.safeToSpend)}</strong>
              <Hint k="safe_to_spend" />
              <button
                onClick={() => setWhy(!why)}
                aria-expanded={why}
                className="ms-1 underline decoration-dotted underline-offset-2"
              >
                {why ? "Hide" : "Why this number?"}
              </button>
            </p>
          )}
          <AnimatePresence>
            {why && data.hasData && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <SafeBreakdown s={data.safe} safe={data.safeToSpend} fm={fm} />
              </motion.div>
            )}
          </AnimatePresence>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <button
              onClick={() => setEntry({ dir: "in" })}
              className="flex items-center justify-center gap-2 rounded-2xl bg-pos px-4 py-5 text-lg font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[.98]"
            >
              <ArrowDownLeft className="size-6" aria-hidden /> I got money
            </button>
            <button
              onClick={() => setEntry({ dir: "out" })}
              className="flex items-center justify-center gap-2 rounded-2xl bg-ink px-4 py-5 text-lg font-semibold text-paper shadow-sm transition hover:brightness-125 active:scale-[.98]"
            >
              <ArrowUpRight className="size-6" aria-hidden /> I spent money
            </button>
          </div>
        </Card>
      </motion.div>

      {/* One thing to watch, never a wall of warnings */}
      {data.attention && (
        <Link
          href="/app/actions"
          className="flex items-center gap-3 rounded-2xl border border-warn/40 bg-warnsoft/50 px-4 py-3 text-[14px] text-ink transition hover:border-warn"
        >
          <Lightbulb className="size-5 shrink-0 text-warn" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="text-ink3">Worth a look: </span>
            {data.attention.title}
          </span>
          <ChevronRight className="size-4 shrink-0 text-ink3 rtl:rotate-180" aria-hidden />
        </Link>
      )}

      {/* What is coming */}
      <Card className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="display text-xl">Coming up</h2>
          <Link href="/app/calendar" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent">
            <CalendarDays className="size-4" aria-hidden /> See the calendar
          </Link>
        </div>
        {data.upcoming.length === 0 ? (
          <div className="mt-3 rounded-2xl bg-sunken px-4 py-6 text-center">
            <p className="text-[14px] text-ink2">Nothing coming up yet.</p>
            <p className="mt-1 text-[13px] text-ink3">
              Add your fixed costs (rent, salaries, subscriptions) and we will remind you before each one.
            </p>
            <Button className="mt-3" onClick={() => setEntry({ dir: "out", repeat: "monthly" })}>
              <Repeat className="size-4" aria-hidden /> Add a fixed cost
            </Button>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {data.upcoming.map((u, i) => (
              <motion.li
                key={`${u.kind}:${u.refId}:${u.date}:${i}`}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.03 * i }}
                className="flex items-center gap-3 py-3"
              >
                <div
                  className={clsx(
                    "w-14 shrink-0 rounded-xl py-1 text-center",
                    u.late ? "bg-negsoft text-neg" : "bg-sunken text-ink2",
                  )}
                >
                  <p className="text-[11px]">
                    {new Date(u.date + "T00:00:00Z").toLocaleDateString("en", { month: "short", timeZone: "UTC" })}
                  </p>
                  <p className="text-lg font-semibold leading-none">{u.date.slice(8)}</p>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium text-ink">{u.label}</p>
                  <p className="text-xs text-ink3">
                    {u.kind === "salaries"
                      ? u.people === 1
                        ? "1 person"
                        : `${u.people} people`
                      : u.late
                        ? "Late"
                        : u.kind.startsWith("recurring")
                          ? "Repeats"
                          : u.amount > 0
                            ? "Money coming in"
                            : "To pay"}
                  </p>
                </div>
                <p className={clsx("num shrink-0 text-[15px] font-semibold", u.amount > 0 ? "text-pos" : "text-ink")}>
                  {formatMoney(u.amount, cur, { sign: true })}
                </p>
                {u.kind === "salaries" && (
                  <Link
                    href="/app/fixed"
                    className="shrink-0 rounded-xl border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink2 transition hover:border-accent hover:text-accent"
                  >
                    See who
                  </Link>
                )}
                {u.refId && (
                  <button
                    onClick={() => paid(u)}
                    className="shrink-0 rounded-xl border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink2 transition hover:border-pos hover:text-pos"
                    aria-label={u.amount > 0 ? "Mark as received" : "Mark as paid"}
                  >
                    <Check className="inline size-3.5" aria-hidden /> {u.amount > 0 ? "Received" : "Paid"}
                  </button>
                )}
              </motion.li>
            ))}
          </ul>
        )}
      </Card>

      {/* This month in plain words, with the proper term to learn */}
      <Card className="p-5 sm:p-6">
        <h2 className="display text-xl">This month</h2>
        <div className="mt-3 grid grid-cols-3 gap-3 text-center">
          <Stat label="Came in" value={fm(data.month.income)} tone="pos" />
          <Stat label="Went out" value={fm(data.month.spent)} />
          <Stat
            label="You kept"
            value={fm(data.month.kept)}
            tone={data.month.kept < 0 ? "neg" : undefined}
            hint="net_profit"
          />
        </div>
        <p className="mt-3 text-center text-xs text-ink3">
          “You kept” is what accountants call <strong>net profit</strong>. Tap ⓘ to learn what it means.
        </p>
      </Card>

      <p className="text-center text-xs text-ink3">Need more? Switch to the full view from the menu.</p>

      <EntrySheet
        target={entry}
        onClose={() => setEntry(null)}
        d={data}
        onSaved={(msg) => {
          toast({ title: msg });
          mutate();
          refreshAll();
        }}
      />
    </div>
  );
}

function SafeBreakdown({ s, safe, fm }: { s: SimpleData["safe"]; safe: number; fm: (v: number) => string }) {
  const rows: [string, number, string][] = [
    ["Money you have now", s.cash, ""],
    ["Taxes you owe (not yours to spend)", -s.taxes, "−"],
    ["Bills and salaries in the next 30 days", -s.bills30, "−"],
    ["Your safety cushion", -s.reserve, "−"],
  ];
  return (
    <div className="mx-auto mt-4 max-w-md rounded-2xl border border-line bg-sunken/60 p-4 text-start text-[14px]">
      <ul className="space-y-1.5">
        {rows.map(([l, v, sign]) => (
          <li key={l} className="flex items-center justify-between gap-3">
            <span className="text-ink2">
              {sign && (
                <span aria-hidden className="me-1 text-ink3">
                  {sign}
                </span>
              )}
              {l}
            </span>
            <span className="num font-medium text-ink">{fm(Math.abs(v))}</span>
          </li>
        ))}
        <li className="flex items-center justify-between gap-3 border-t border-line pt-2 font-semibold">
          <span>= Safe to spend</span>
          <span className={clsx("num", safe > 0 ? "text-pos" : "text-ink")}>{fm(safe)}</span>
        </li>
      </ul>
      {s.free <= 0 ? (
        <p className="mt-3 text-[13px] text-ink2">
          It is 0 because what you have now is all needed for what is coming ({fm(-s.free)} short). Sales that come in
          will raise it. You can also collect money customers owe you, or lower your safety cushion in the full view
          (Plan).
        </p>
      ) : (
        <p className="mt-3 text-[13px] text-ink2">
          Money coming in later is not counted, so this number is careful on purpose.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: "pos" | "neg"; hint?: string }) {
  return (
    <div className="rounded-2xl bg-sunken px-2 py-3">
      <p className="flex items-center justify-center gap-1 text-[12px] text-ink3">
        {label}
        {hint && <Hint k={hint} />}
      </p>
      <p
        className={clsx(
          "num mt-0.5 text-[16px] font-semibold sm:text-lg",
          tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-ink",
        )}
      >
        {value}
      </p>
    </div>
  );
}

const ICON: Record<string, string> = {
  Sales: "🛍️",
  Services: "🧾",
  "Other income": "💵",
  "Inventory & materials": "📦",
  "Shipping & delivery": "🚚",
  "Social ads": "📣",
  Rent: "🏠",
  Salaries: "👥",
  Utilities: "💡",
  Packaging: "🎁",
  "Software & subscriptions": "💻",
  Taxes: "🏛️",
  "Operations & other": "🧰",
  "Owner's pay": "🙋",
};

export function EntrySheet({
  target,
  onClose,
  d,
  onSaved,
}: {
  target: EntryTarget | null;
  onClose: () => void;
  d: Pick<Data, "today" | "currency" | "categories">;
  onSaved: (msg: string) => void;
}) {
  const [dirSel, setDirSel] = useState<"in" | "out">("out");
  const [amount, setAmount] = useState<number | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [when, setWhen] = useState<"today" | "other">("today");
  const [date, setDate] = useState(d.today);
  const [repeat, setRepeat] = useState<"once" | "monthly" | "yearly">("once");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const key = target ? `${target.dir}:${target.repeat ?? ""}:${target.date ?? ""}` : null;
  if (key !== shown) {
    // Reset the form each time it opens (a day tapped in the calendar comes pre-filled).
    setShown(key);
    const preset = target?.date && target.date !== d.today ? target.date : null;
    setAmount(null);
    setCat(null);
    setWhen(target?.repeat || preset ? "other" : "today");
    setDate(preset ?? d.today);
    setRepeat(target?.repeat ?? "once");
    setNote("");
    setErr("");
    setDirSel(target?.dir ?? "out");
  }
  const dir = target?.pickDir ? dirSel : (target?.dir ?? "out");
  const cats = dir === "in" ? d.categories.in : d.categories.out;
  const day = when === "today" ? d.today : date;
  const future = day > d.today;
  const explain =
    repeat !== "once"
      ? `Repeats every ${repeat === "monthly" ? "month" : "year"} from ${day}. We will remind you before each one.`
      : future
        ? `Planned for ${day}. It shows in your calendar and we will remind you.`
        : "Recorded now. Your cash is updated.";
  return (
    <Modal
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      title={target?.pickDir ? "Add to this day" : dir === "in" ? "I got money" : "I spent money"}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!amount}
            onClick={async () => {
              setBusy(true);
              setErr("");
              try {
                const r = await api.post<{ kind: string }>("/api/simple/entry", {
                  direction: dir,
                  amount: amount ?? 0,
                  category: cat,
                  note: note || undefined,
                  date: day,
                  repeat,
                });
                onSaved(
                  r.kind === "recurring"
                    ? "Saved — we will remind you"
                    : r.kind === "planned"
                      ? "Planned — it is in your calendar"
                      : "Saved",
                );
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
        {target?.pickDir && (
          <Segmented
            value={dirSel}
            onChange={(v) => {
              setDirSel(v);
              setCat(null);
            }}
            options={[
              { value: "out", label: "Money going out" },
              { value: "in", label: "Money coming in" },
            ]}
            label="Direction"
          />
        )}
        <Field label="How much?">
          <MoneyInput
            value={amount}
            onChange={setAmount}
            currency={d.currency}
            digits={currencyDigits(d.currency)}
            autoFocus
          />
        </Field>
        <div>
          <p className="text-sm font-medium text-ink">{dir === "in" ? "From what?" : "On what?"}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {cats.map((c) => (
              <button
                key={c}
                onClick={() => setCat(cat === c ? null : c)}
                className={clsx(
                  "rounded-full border px-3 py-1.5 text-[13px] transition",
                  cat === c ? "border-accent bg-accentsoft text-ink" : "border-line text-ink2 hover:border-line2",
                )}
              >
                <span aria-hidden>{ICON[c] ?? "•"}</span> {c}
              </button>
            ))}
          </div>
        </div>
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
            <AnimatePresence>
              {when === "other" && (
                <motion.div
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  exit={{ opacity: 0, width: 0 }}
                >
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </Field>
        <Field label="Does it repeat?">
          <Segmented
            value={repeat}
            onChange={setRepeat}
            options={[
              { value: "once", label: "Once" },
              { value: "monthly", label: "Every month" },
              { value: "yearly", label: "Every year" },
            ]}
            label="Does it repeat?"
          />
        </Field>
        <Field label="Note (optional)">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={dir === "in" ? "e.g. 3 orders from Instagram" : "e.g. Courier for this week"}
          />
        </Field>
        <p className="flex items-center gap-1.5 rounded-xl bg-sunken px-3 py-2 text-[13px] text-ink2">
          {repeat !== "once" ? (
            <Repeat className="size-4 text-accent" aria-hidden />
          ) : future ? (
            <CalendarDays className="size-4 text-accent" aria-hidden />
          ) : (
            <Check className="size-4 text-pos" aria-hidden />
          )}
          {explain}
        </p>
        {err && <p className="text-sm text-neg">{err}</p>}
      </div>
    </Modal>
  );
}
