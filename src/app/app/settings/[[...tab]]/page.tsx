"use client";
import { WhatsAppCard } from "@/components/app/whatsapp-card";
import {
  AlertTriangle,
  Bell,
  Building2,
  CreditCard,
  Database,
  KeyRound,
  Plug,
  Settings2,
  ShieldAlert,
  Tags,
  User,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import { useUi } from "@/components/providers";
import { IntegrationsPanel } from "@/components/app/integrations-panel";
import {
  Badge,
  Button,
  Card,
  clsx,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useAccounts, useCategories, useMe } from "@/lib/client/hooks";
import { formatMoney } from "@/lib/finance/money";

const TABS = [
  { id: "profile", label: "Profile", icon: User },
  { id: "business", label: "Business", icon: Building2 },
  { id: "preferences", label: "Preferences", icon: Settings2 },
  { id: "categories", label: "Categories", icon: Tags },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "data", label: "Import & export", icon: Database },
  { id: "security", label: "Security", icon: KeyRound },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "account", label: "Account", icon: ShieldAlert },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Inner() {
  const params = useParams<{ tab?: string[] }>();
  const router = useRouter();
  const tab = (params.tab?.[0] as TabId) ?? "profile";
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="Your profile, your business, and how Socio connects to everything else." />
      <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav
          aria-label="Settings sections"
          className="scroll-thin -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
        >
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={`/app/settings/${t.id}`}
              aria-current={tab === t.id ? "page" : undefined}
              className={clsx(
                "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition",
                tab === t.id
                  ? "bg-raised text-ink shadow-sm ring-1 ring-line"
                  : "text-ink2 hover:bg-sunken hover:text-ink",
              )}
            >
              <t.icon className={clsx("size-4", tab === t.id && "text-accent")} aria-hidden /> {t.label}
            </Link>
          ))}
        </nav>
        <div className="min-w-0 space-y-5">
          {tab === "profile" && <ProfileTab />}
          {tab === "business" && <BusinessTab />}
          {tab === "preferences" && <PreferencesTab />}
          {tab === "categories" && <CategoriesTab />}
          {tab === "notifications" && <NotificationsTab />}
          {tab === "integrations" && <IntegrationsPanel />}
          {tab === "data" && <DataTab />}
          {tab === "security" && <SecurityTab />}
          {tab === "billing" && <BillingTab />}
          {tab === "account" && <AccountTab onDone={() => router.replace("/login")} />}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  desc,
  children,
  footer,
}: {
  title: string;
  desc?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="p-5 sm:p-7">
      <h2 className="display text-xl">{title}</h2>
      {desc && <p className="mt-1 max-w-xl text-sm leading-relaxed text-ink2">{desc}</p>}
      <div className="mt-5">{children}</div>
      {footer && <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">{footer}</div>}
    </Card>
  );
}

function useSaver() {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return {
    busy,
    err,
    async run(fn: () => Promise<unknown>, ok = "Saved") {
      setBusy(true);
      setErr("");
      try {
        await fn();
        await refreshAll();
        toast({ title: ok });
      } catch (x) {
        setErr(x instanceof ApiError ? x.message : "Could not save. Check your connection.");
      } finally {
        setBusy(false);
      }
    },
  };
}

// Profile
function ProfileTab() {
  const { me } = useMe();
  const [name, setName] = useState("");
  const s = useSaver();
  useEffect(() => me && setName(me.profile.name), [me]);
  if (!me) return <Skeleton className="h-48" />;
  return (
    <Section
      title="Your profile"
      footer={
        <>
          <Button
            variant="primary"
            loading={s.busy}
            disabled={!name.trim() || name === me.profile.name}
            onClick={() => s.run(() => api.patch("/api/profile", { name }))}
          >
            Save
          </Button>
          {s.err && (
            <p role="alert" className="text-sm text-neg">
              {s.err}
            </p>
          )}
        </>
      }
    >
      <div className="grid gap-4 sm:max-w-md">
        <Field label="Name" htmlFor="pn">
          <Input id="pn" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Email" htmlFor="pe" hint="Your sign-in email.">
          <Input id="pe" value={me.user.email} readOnly disabled />
        </Field>
      </div>
    </Section>
  );
}

// Business
const TYPES = ["fashion", "cosmetics", "home", "food", "services", "ecommerce", "other"];
const STAGES = ["idea", "early", "growing", "established"];
function BusinessTab() {
  const { biz } = useMe();
  const { data, mutate } = useSWR<{ business: any; role: string }>("/api/business");
  const [f, setF] = useState<any>(null);
  const s = useSaver();
  useEffect(
    () =>
      data &&
      setF({
        name: data.business.name,
        business_type: data.business.business_type,
        country: data.business.country,
        stage: data.business.stage,
        timezone: data.business.timezone,
      }),
    [data],
  );
  if (!data || !f) return <Skeleton className="h-64" />;
  const admin = biz && (biz.role === "owner" || biz.role === "admin");
  return (
    <>
      <Section
        title="Business profile"
        footer={
          <>
            <Button
              variant="primary"
              disabled={!admin}
              loading={s.busy}
              onClick={() =>
                s.run(async () => {
                  await api.patch("/api/business", f);
                  await mutate();
                })
              }
            >
              Save changes
            </Button>
            {!admin && <p className="text-sm text-ink3">Only owners and admins can edit this.</p>}
            {s.err && (
              <p role="alert" className="text-sm text-neg">
                {s.err}
              </p>
            )}
          </>
        }
      >
        <div className="grid gap-4 sm:max-w-xl sm:grid-cols-2">
          <Field label="Business name" htmlFor="bn" className="sm:col-span-2">
            <Input id="bn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!admin} />
          </Field>
          <Field label="Type" htmlFor="bt">
            <Select
              id="bt"
              value={f.business_type}
              onChange={(e) => setF({ ...f, business_type: e.target.value })}
              disabled={!admin}
            >
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="Stage" htmlFor="bs">
            <Select id="bs" value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })} disabled={!admin}>
              {STAGES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="Country" htmlFor="bc" hint="Two-letter country code.">
            <Input
              id="bc"
              value={f.country}
              maxLength={2}
              onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })}
              disabled={!admin}
            />
          </Field>
          <Field
            label="Base currency"
            htmlFor="bcur"
            hint="Fixed after creation so historical totals stay trustworthy."
          >
            <Input id="bcur" value={data.business.currency} disabled />
          </Field>
          <Field
            label="Timezone"
            htmlFor="btz"
            hint="IANA name, e.g. Africa/Cairo. Controls what “today” means for reports and deadlines."
            className="sm:col-span-2"
          >
            <Input
              id="btz"
              value={f.timezone ?? ""}
              onChange={(e) => setF({ ...f, timezone: e.target.value })}
              disabled={!admin}
            />
          </Field>
        </div>
      </Section>
      <AccountsSection />
    </>
  );
}

function AccountsSection() {
  const { data, mutate } = useAccounts();
  const { biz } = useMe();
  const { toast } = useUi();
  const [name, setName] = useState("");
  const [type, setType] = useState("bank");
  const [open, setOpen] = useState<string | null>(null);
  const [val, setVal] = useState("");
  const s = useSaver();
  const canWrite = biz && biz.role !== "viewer";
  return (
    <Section
      title="Accounts"
      desc="Where your money sits. Opening balances set your starting cash; transactions move it from there."
    >
      <ul className="divide-y divide-line rounded-xl border border-line">
        {(data?.items ?? []).map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">
                {a.name} {a.archived && <Badge tone="warn">Archived</Badge>}
              </p>
              <p className="text-xs text-ink3">
                {a.type} · {a.currency.trim()} · opening {formatMoney(a.opening_balance, a.currency.trim())}
              </p>
            </div>
            {canWrite && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setOpen(a.id);
                    setVal(String(a.opening_balance / 100));
                  }}
                >
                  Edit opening
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api.patch(`/api/accounts/${a.id}`, { archived: !a.archived });
                    mutate();
                    refreshAll();
                  }}
                >
                  {a.archived ? "Restore" : "Archive"}
                </Button>
              </>
            )}
            {open === a.id && (
              <div className="flex w-full items-center gap-2">
                <Input
                  aria-label="Opening balance"
                  inputMode="decimal"
                  value={val}
                  onChange={(e) => setVal(e.target.value)}
                  className="max-w-[10rem]"
                />
                <Button
                  size="sm"
                  variant="primary"
                  onClick={async () => {
                    const n = Math.round(Number(val.replace(/,/g, "")) * 100);
                    if (Number.isFinite(n)) {
                      await api.patch(`/api/accounts/${a.id}`, { opening_balance: n });
                      setOpen(null);
                      mutate();
                      refreshAll();
                      toast({ title: "Opening balance updated", description: "Cash totals have been recalculated." });
                    }
                  }}
                >
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                  Cancel
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {canWrite && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <Field label="New account" htmlFor="an">
            <Input id="an" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Wallet" />
          </Field>
          <Field label="Type" htmlFor="at">
            <Select id="at" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="bank">Bank</option>
              <option value="cash">Cash</option>
              <option value="wallet">Wallet</option>
              <option value="card">Card</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Button
            variant="secondary"
            loading={s.busy}
            disabled={!name.trim()}
            onClick={() =>
              s.run(async () => {
                await api.post("/api/accounts", { name: name.trim(), type, opening_balance: 0 });
                setName("");
                mutate();
              }, "Account added")
            }
          >
            Add account
          </Button>
        </div>
      )}
      {s.err && (
        <p role="alert" className="mt-2 text-sm text-neg">
          {s.err}
        </p>
      )}
    </Section>
  );
}

// Preferences
function PreferencesTab() {
  const { theme, setTheme, locale, setLocale } = useUi();
  const { data, mutate } = useSWR<{ business: any }>("/api/business");
  const { biz } = useMe();
  const s = useSaver();
  const settings = data?.business.settings ?? {};
  const admin = biz && (biz.role === "owner" || biz.role === "admin");
  const set = (k: string, v: unknown) =>
    s.run(async () => {
      await api.patch("/api/business", { settings: { [k]: v } });
      await mutate();
    });
  return (
    <>
      <Section title="Appearance & language" desc="Stored on this device.">
        <div className="grid gap-4 sm:max-w-md sm:grid-cols-2">
          <Field label="Theme" htmlFor="th">
            <Select id="th" value={theme} onChange={(e) => setTheme(e.target.value as any)}>
              <option value="system">Match my device</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </Field>
          <Field label="Language" htmlFor="lg" hint="Egyptian Arabic or English. You can also switch from the top bar.">
            <Select
              id="lg"
              value={locale}
              onChange={(e) => {
                setLocale(e.target.value as any);
                api.patch("/api/profile", { locale: e.target.value }).catch(() => {});
              }}
            >
              <option value="en">English</option>
              <option value="ar">مصري (العربية)</option>
            </Select>
          </Field>
        </div>
      </Section>
      <Section
        title="Financial preferences"
        desc="These shape how periods and projections are shown for this business."
      >
        <div className="grid gap-4 sm:max-w-xl sm:grid-cols-2">
          <Field label="Default dashboard period" htmlFor="dp">
            <Select
              id="dp"
              disabled={!admin}
              value={settings.defaultPeriod ?? "month"}
              onChange={(e) => set("defaultPeriod", e.target.value)}
            >
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
            </Select>
          </Field>
          <Field label="Forecast horizon" htmlFor="fh">
            <Select
              id="fh"
              disabled={!admin}
              value={String(settings.forecastDays ?? 60)}
              onChange={(e) => set("forecastDays", Number(e.target.value))}
            >
              <option value="30">30 days</option>
              <option value="60">60 days</option>
              <option value="90">90 days</option>
            </Select>
          </Field>
          <Field
            label="Reminder lead time for bills"
            htmlFor="rl"
            hint="How many days before a due date a bill is flagged."
          >
            <Select
              id="rl"
              disabled={!admin}
              value={String(settings.billLeadDays ?? 7)}
              onChange={(e) => set("billLeadDays", Number(e.target.value))}
            >
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
            </Select>
          </Field>
        </div>
        <p className="mt-4 text-[13px] text-ink3">
          Currency conversion: Socio does not convert between currencies. Records in another currency are kept separate
          and clearly flagged rather than silently added.
        </p>
      </Section>
    </>
  );
}

// Categories
function CategoriesTab() {
  const { data, mutate } = useCategories();
  const { biz } = useMe();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", kind: "expense", cost_type: "opex", parent_id: "", essential: false });
  const [del, setDel] = useState<{ id: string; name: string } | null>(null);
  const s = useSaver();
  const canWrite = biz && biz.role !== "viewer";
  const items = data?.items ?? [];
  const parents = items.filter((c) => !c.parent_id && !c.archived);
  return (
    <Section
      title="Categories"
      desc="How records are grouped in budgets and reports. “Cost of goods” categories feed gross profit; everything else counts as operating expenses. Essential categories drive your reserve target."
      footer={
        canWrite && (
          <Button variant="primary" onClick={() => setOpen(true)}>
            Add category
          </Button>
        )
      }
    >
      {["income", "expense"].map((kind) => (
        <div key={kind} className="mb-6 last:mb-0">
          <p className="eyebrow mb-2">{kind === "income" ? "Income" : "Expenses"}</p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {parents
              .filter((p) => p.kind === kind)
              .map((p) => (
                <li key={p.id}>
                  <CatRow
                    c={p}
                    canWrite={!!canWrite}
                    onChange={() => (mutate(), refreshAll())}
                    onDelete={() => setDel({ id: p.id, name: p.name })}
                  />
                  {items
                    .filter((c) => c.parent_id === p.id)
                    .map((c) => (
                      <div key={c.id} className="border-t border-line bg-sunken/40 ps-6">
                        <CatRow
                          c={c}
                          canWrite={!!canWrite}
                          onChange={() => (mutate(), refreshAll())}
                          onDelete={() => setDel({ id: c.id, name: c.name })}
                          sub
                        />
                      </div>
                    ))}
                </li>
              ))}
          </ul>
        </div>
      ))}
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Add a category"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={s.busy}
              disabled={!f.name.trim()}
              onClick={() =>
                s.run(async () => {
                  await api.post("/api/categories", {
                    name: f.name.trim(),
                    kind: f.kind,
                    cost_type: f.kind === "expense" ? f.cost_type : null,
                    parent_id: f.parent_id || null,
                    essential: f.essential,
                  });
                  setOpen(false);
                  setF({ ...f, name: "" });
                  mutate();
                }, "Category added")
              }
            >
              Add
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {s.err && (
            <p role="alert" className="text-sm text-neg">
              {s.err}
            </p>
          )}
          <Field label="Name" htmlFor="cn">
            <Input id="cn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Kind" htmlFor="ck">
            <Select id="ck" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, parent_id: "" })}>
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </Select>
          </Field>
          {f.kind === "expense" && (
            <Field label="Counts as" htmlFor="cc">
              <Select id="cc" value={f.cost_type} onChange={(e) => setF({ ...f, cost_type: e.target.value })}>
                <option value="opex">Operating expense</option>
                <option value="cogs">Cost of goods sold</option>
              </Select>
            </Field>
          )}
          <Field label="Inside (optional)" htmlFor="cp">
            <Select id="cp" value={f.parent_id} onChange={(e) => setF({ ...f, parent_id: e.target.value })}>
              <option value="">Top level</option>
              {parents
                .filter((p) => p.kind === f.kind)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </Field>
          {f.kind === "expense" && (
            <label className="flex items-center gap-2 text-sm text-ink2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={f.essential}
                onChange={(e) => setF({ ...f, essential: e.target.checked })}
              />{" "}
              Essential (needed to keep the business running)
            </label>
          )}
        </div>
      </Modal>
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete “${del?.name}”?`}
        body="Transactions in this category are kept and become uncategorized. Budgets for it are removed."
        onConfirm={async () => {
          await api.del(`/api/categories/${del!.id}`);
          mutate();
          refreshAll();
        }}
      />
    </Section>
  );
}
function CatRow({
  c,
  canWrite,
  onChange,
  onDelete,
  sub,
}: {
  c: any;
  canWrite: boolean;
  onChange: () => void;
  onDelete: () => void;
  sub?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 px-4 py-2.5">
      <span className="size-2.5 rounded-full" style={{ background: c.color }} />
      <span className={clsx("min-w-0 flex-1 truncate text-sm", sub ? "text-ink2" : "font-medium text-ink")}>
        {c.name}
      </span>
      {c.kind === "expense" && (
        <Badge tone={c.cost_type === "cogs" ? "warn" : "neutral"}>
          {c.cost_type === "cogs" ? "Cost of goods" : "Operating"}
        </Badge>
      )}
      {c.essential && <Badge tone="accent">Essential</Badge>}
      {canWrite && c.kind === "expense" && (
        <>
          <button
            className="text-xs text-ink3 underline hover:text-ink"
            onClick={async () => {
              await api.patch(`/api/categories/${c.id}`, { essential: !c.essential });
              onChange();
            }}
          >
            {c.essential ? "Not essential" : "Mark essential"}
          </button>
          <button
            className="text-xs text-ink3 underline hover:text-ink"
            onClick={async () => {
              await api.patch(`/api/categories/${c.id}`, { cost_type: c.cost_type === "cogs" ? "opex" : "cogs" });
              onChange();
            }}
          >
            {c.cost_type === "cogs" ? "Make operating" : "Make cost of goods"}
          </button>
        </>
      )}
      {canWrite && (
        <button className="text-xs text-neg underline" onClick={onDelete}>
          Delete
        </button>
      )}
    </div>
  );
}

// Notifications
function NotificationsTab() {
  const { data, mutate } = useSWR<{ business: any }>("/api/business");
  const s = useSaver();
  const n = data?.business.settings?.notifications ?? {};
  const rows: [string, string, string][] = [
    ["budgets", "Budget limits", "When a budget is over, or on pace to be exceeded."],
    ["payments", "Overdue and upcoming payments", "Bills past due or due this week."],
    ["cash", "Cash-flow risks", "When scheduled payments would push cash below zero."],
    ["integrations", "Integration problems", "Failed syncs or connections that need re-authorising."],
    ["goals", "Goals reached", "When a reserve or goal hits its target."],
    ["data", "Missing information", "When an important metric is unreliable because records are missing."],
  ];
  return (
    <Section
      title="Notifications"
      desc="Alerts appear in the bell at the top of every page. Each one says why it fired and what to do next."
    >
      <ul className="divide-y divide-line rounded-xl border border-line">
        {rows.map(([k, t, d]) => (
          <li key={k} className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div>
              <p className="text-sm font-medium text-ink">{t}</p>
              <p className="text-[13px] text-ink3">{d}</p>
            </div>
            <input
              type="checkbox"
              aria-label={t}
              className="size-5 accent-[var(--accent)]"
              checked={n[k] !== false}
              onChange={(e) =>
                s.run(async () => {
                  await api.patch("/api/business", { settings: { notifications: { ...n, [k]: e.target.checked } } });
                  await mutate();
                })
              }
            />
          </li>
        ))}
      </ul>
      <div className="mt-5">
        <WhatsAppCard />
      </div>
      <p className="mt-4 rounded-xl bg-sunken px-4 py-3 text-[13px] text-ink2">
        <strong className="text-ink">Alerts are in-app.</strong> The only outside channel is the WhatsApp morning
        briefing above, and only if you turn it on. Email is used only for payment reminders you approve.
      </p>
    </Section>
  );
}

// Integrations
// Data import / export
function DataTab() {
  const { data: accts } = useAccounts();
  const { toast } = useUi();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [account, setAccount] = useState("");
  const [dayFirst, setDayFirst] = useState(true);
  const [invert, setInvert] = useState(false);
  const [mapping, setMapping] = useState<Record<string, number | undefined>>({});
  const [preview, setPreview] = useState<any>(null);
  const [needs, setNeeds] = useState<{ header: string[]; sample: string[][] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<any>(null);
  const accounts = (accts?.items ?? []).filter((a) => !a.archived);
  useEffect(() => {
    if (!account && accounts[0]) setAccount(accounts[0].id);
  }, [account, accounts]);

  const run = async (commit: boolean, m = mapping) => {
    setBusy(true);
    setErr("");
    try {
      const mp =
        m.date !== undefined &&
        m.description !== undefined &&
        (m.amount !== undefined || (m.debit !== undefined && m.credit !== undefined))
          ? m
          : undefined;
      const r = await api.post<any>("/api/import/csv", {
        csv,
        account_id: account,
        commit,
        dayFirst,
        invertSign: invert,
        mapping: mp,
      });
      if (r.needsMapping) {
        setNeeds({ header: r.header, sample: r.sample });
        setMapping(r.detected ?? {});
        setPreview(null);
      } else if (commit) {
        setDone(r);
        setPreview(null);
        setCsv("");
        setFileName("");
        await refreshAll();
        toast({
          title: `${r.imported} transactions imported`,
          description: r.skippedDuplicates ? `${r.skippedDuplicates} duplicates were skipped.` : undefined,
        });
      } else {
        setNeeds(null);
        setPreview(r.preview);
      }
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Could not read the file.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Section
        title="Import transactions from CSV"
        desc="Works with bank exports and spreadsheets. Amounts can be one signed column (negative = expense) or separate debit/credit columns. Re-importing the same file never creates duplicates."
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:max-w-xl sm:grid-cols-2">
            <Field label="Import into account" htmlFor="ia">
              <Select id="ia" value={account} onChange={(e) => setAccount(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.currency.trim()}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="CSV file" htmlFor="if">
              <Input
                id="if"
                type="file"
                accept=".csv,text/csv"
                className="h-auto py-2"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setCsv(await f.text());
                    setFileName(f.name);
                    setPreview(null);
                    setNeeds(null);
                    setDone(null);
                  }
                }}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-5 text-sm text-ink2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={dayFirst}
                onChange={(e) => setDayFirst(e.target.checked)}
              />{" "}
              Dates are day/month/year
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={invert}
                onChange={(e) => setInvert(e.target.checked)}
              />{" "}
              Positive amounts are expenses
            </label>
          </div>
          {csv && (
            <Button variant="secondary" loading={busy} onClick={() => run(false)}>
              Preview {fileName}
            </Button>
          )}
          {err && (
            <p role="alert" className="rounded-xl bg-negsoft px-3.5 py-2.5 text-sm text-neg">
              {err}
            </p>
          )}

          {needs && (
            <div className="rounded-xl border border-line p-4">
              <p className="text-sm font-medium text-ink">Tell Socio which column is which</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {[
                  ["date", "Date"],
                  ["description", "Description"],
                  ["amount", "Amount (signed)"],
                  ["debit", "Debit / money out"],
                  ["credit", "Credit / money in"],
                  ["category", "Category (optional)"],
                ].map(([k, l]) => (
                  <Field key={k} label={l} htmlFor={`m-${k}`}>
                    <Select
                      id={`m-${k}`}
                      value={mapping[k] === undefined ? "" : String(mapping[k])}
                      onChange={(e) =>
                        setMapping({ ...mapping, [k]: e.target.value === "" ? undefined : Number(e.target.value) })
                      }
                    >
                      <option value="">—</option>
                      {needs.header.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `Column ${i + 1}`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ))}
              </div>
              <Button className="mt-4" variant="primary" onClick={() => run(false)}>
                Apply mapping &amp; preview
              </Button>
            </div>
          )}

          {preview && (
            <div className="rounded-xl border border-line p-4">
              <p className="text-sm text-ink">
                <strong>{preview.valid}</strong> of {preview.total} rows are valid · income{" "}
                {formatMoney(preview.income, "")} · expenses {formatMoney(preview.expenses, "")}
                {preview.errorCount > 0 && (
                  <span className="text-neg"> · {preview.errorCount} rows need attention</span>
                )}
              </p>
              {preview.errors.length > 0 && (
                <ul className="mt-2 space-y-1 text-[13px] text-neg">
                  {preview.errors.map((e: any) => (
                    <li key={e.line}>
                      Line {e.line}: {e.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="scroll-thin mt-3 overflow-x-auto rounded-lg bg-sunken">
                <table className="w-full min-w-[28rem] text-[13px]">
                  <tbody>
                    {preview.sample.map((r: any) => (
                      <tr key={r.line} className="border-b border-line last:border-0">
                        <td className="num px-3 py-2 text-ink2">{r.date}</td>
                        <td className="px-3 py-2">{r.description}</td>
                        <td className={clsx("num px-3 py-2 text-end", r.type === "income" ? "text-pos" : "text-ink")}>
                          {r.type === "income" ? "+" : "−"}
                          {(r.amount / 100).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex gap-2">
                <Button variant="primary" loading={busy} disabled={preview.valid === 0} onClick={() => run(true)}>
                  Import {preview.valid} transactions
                </Button>
                <Button variant="ghost" onClick={() => setPreview(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {done && (
            <p className="rounded-xl bg-possoft px-4 py-3 text-sm text-pos">
              Imported <strong>{done.imported}</strong> transactions
              {done.skippedDuplicates ? `, skipped ${done.skippedDuplicates} duplicates` : ""}
              {done.rejected ? `, ${done.rejected} rows rejected` : ""}. Uncategorized imports can be sorted from{" "}
              <Link href="/app/transactions?filter=uncategorized" className="font-medium underline">
                Transactions
              </Link>
              .
            </p>
          )}
        </div>
      </Section>
      <Section title="Export your data" desc="Your data is yours. Download it any time.">
        <div className="flex flex-wrap gap-3">
          <a
            href="/api/export/transactions"
            className="inline-flex h-10 items-center rounded-xl border border-line bg-raised px-4 text-sm font-medium shadow-sm hover:border-line2"
          >
            Transactions (CSV)
          </a>
          <a
            href="/api/export/all"
            className="inline-flex h-10 items-center rounded-xl border border-line bg-raised px-4 text-sm font-medium shadow-sm hover:border-line2"
          >
            Everything (JSON)
          </a>
        </div>
      </Section>
    </>
  );
}

// Security / billing / account
function SecurityTab() {
  const { me } = useMe();
  const [f, setF] = useState({ current: "", next: "" });
  const s = useSaver();
  return (
    <>
      <Section
        title="Change password"
        footer={
          <>
            <Button
              variant="primary"
              loading={s.busy}
              disabled={!f.current || f.next.length < 8}
              onClick={() =>
                s.run(async () => {
                  await api.post("/api/auth/password", f);
                  setF({ current: "", next: "" });
                }, "Password updated")
              }
            >
              Update password
            </Button>
            {s.err && (
              <p role="alert" className="text-sm text-neg">
                {s.err}
              </p>
            )}
          </>
        }
      >
        <div className="grid gap-4 sm:max-w-sm">
          <Field label="Current password" htmlFor="cp">
            <Input
              id="cp"
              type="password"
              autoComplete="current-password"
              value={f.current}
              onChange={(e) => setF({ ...f, current: e.target.value })}
            />
          </Field>
          <Field label="New password" htmlFor="np" hint="At least 8 characters.">
            <Input
              id="np"
              type="password"
              autoComplete="new-password"
              value={f.next}
              onChange={(e) => setF({ ...f, next: e.target.value })}
            />
          </Field>
        </div>
      </Section>
      <Section title="How your data is protected">
        <ul className="space-y-2.5 text-sm leading-relaxed text-ink2">
          <li>
            • Each business is a private workspace. The database enforces this with row-level security, so one account
            cannot read another&rsquo;s records even by guessing an ID.
          </li>
          <li>• Integration tokens are encrypted at rest and are never sent to your browser.</li>
          <li>• Socio connects with read-only permissions and never moves money.</li>
          <li>
            • Environment: sign-in via{" "}
            <strong className="text-ink">
              {me?.environment.auth === "supabase" ? "Supabase Auth" : "local development auth"}
            </strong>
            , data in{" "}
            <strong className="text-ink">
              {me?.environment.database === "supabase" ? "Supabase Postgres" : "a local development database"}
            </strong>
            .
          </li>
        </ul>
      </Section>
    </>
  );
}

function BillingTab() {
  return (
    <Section title="Billing" desc="Socio is not charging anything yet.">
      <div className="rounded-2xl border border-line bg-sunken/60 p-5">
        <p className="display text-2xl">Preview plan</p>
        <p className="mt-1 text-sm text-ink2">
          All features are available while Socio is in preview. No payment method is stored and no payment provider is
          connected, so there is nothing to invoice.
        </p>
        <p className="mt-3 text-[13px] text-ink3">
          Plans, invoices and payment methods will appear here once a billing provider is configured.
        </p>
      </div>
    </Section>
  );
}

function AccountTab({ onDone }: { onDone: () => void }) {
  const { me, biz } = useMe();
  const { toast } = useUi();
  const [delBiz, setDelBiz] = useState(false);
  const [delAcc, setDelAcc] = useState(false);
  const [text, setText] = useState("");
  return (
    <>
      <Section
        title="Delete this workspace"
        desc={`Permanently removes ${biz?.name ?? "this workspace"} and every record in it. Other workspaces are not affected.`}
        footer={
          <Button variant="danger" disabled={biz?.role !== "owner"} onClick={() => setDelBiz(true)}>
            Delete workspace…
          </Button>
        }
      >
        <p className="text-sm text-ink2">
          {biz?.role === "owner"
            ? "Export your data first if you may need it."
            : "Only the workspace owner can delete it."}
        </p>
      </Section>
      <Section
        title="Delete my account"
        desc="Removes your profile and every workspace you own exclusively. This cannot be undone."
        footer={
          <Button variant="danger" onClick={() => setDelAcc(true)}>
            Delete account…
          </Button>
        }
      >
        {me?.environment.auth === "supabase" && (
          <p className="text-[13px] text-ink3">
            Your sign-in record in Supabase Auth must be removed by the project owner from the Supabase dashboard; Socio
            cannot do this without a service-role key, which it deliberately does not hold.
          </p>
        )}
      </Section>
      <ConfirmDialog
        open={delBiz}
        onOpenChange={setDelBiz}
        title="Delete this workspace?"
        body={
          <>
            All transactions, budgets, goals and integrations for <strong>{biz?.name}</strong> will be permanently
            deleted.
          </>
        }
        confirmLabel="Delete workspace"
        onConfirm={async () => {
          await api.del(`/api/businesses/${biz!.id}`);
          await refreshAll();
          toast({ title: "Workspace deleted" });
          window.location.href = "/app";
        }}
      />
      <Modal
        open={delAcc}
        onOpenChange={setDelAcc}
        title="Delete your account"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDelAcc(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={text !== "DELETE"}
              onClick={async () => {
                await api.post("/api/account/delete", { confirm: "DELETE" });
                onDone();
              }}
            >
              Permanently delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink2">
          Type <strong className="text-ink">DELETE</strong> to confirm.
        </p>
        <Input
          className="mt-3"
          aria-label="Type DELETE to confirm"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Modal>
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
