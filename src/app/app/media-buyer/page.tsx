"use client";
import {
  CheckCircle2,
  ChevronDown,
  Megaphone,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
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
  EmptyState,
  ErrorNote,
  Field,
  Input,
  MoneyInput,
  PageHeader,
  Segmented,
  Select,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll } from "@/lib/client/hooks";
import { currencyDigits, formatMoney } from "@/lib/finance/money";

type Dialect = "egyptian" | "gulf" | "msa" | "english";
interface Plan {
  affordable: { level: "ok" | "tight" | "no"; text: string };
  product: { key: string; title: string; price: number; contributionPerUnit: number; reason: string } | null;
  maxCostPerSale: number | null;
  targetCostPerSale: number | null;
  expected: {
    salesAtTarget: number | null;
    salesAtBreakEven: number | null;
    historicalRoas: number | null;
    text: string;
  };
  dailyBudget: number;
  audience: {
    countries: string[];
    ageMin: number;
    ageMax: number;
    summary: string;
    interests: string[];
    placements: string;
  };
  warnings: string[];
  copyEngine?: string;
}
interface Campaign {
  id: string;
  status: string;
  created_at: string;
  brief: { budget: number; days: number; country: string; dialect: Dialect; goal: string; link: string };
  plan: Plan;
  creative: {
    primaryText: string;
    headline: string;
    cta: string;
    link: string;
    imageUrl: string | null;
    priceText: string;
  };
  external: { campaignId?: string };
  metrics: {
    spend: number;
    sales: number | null;
    clicks: number;
    impressions: number;
    verdict: string;
    reason: string;
    costPerSale: number | null;
  } | null;
  actions: { id: string; tool: string; status: string }[];
  error: string | null;
}
interface Data {
  currency: string;
  connection: { ready: boolean; reason: string | null };
  countries: Record<string, { name: string; nameAr: string }>;
  dialects: Record<Dialect, string>;
  canSpend: number;
  cashRiskBreach: string | null;
  products: { key: string; title: string; perUnit: number; units: number }[];
  campaigns: Campaign[];
}

const DIALECTS: { value: Dialect; label: string }[] = [
  { value: "egyptian", label: "مصري" },
  { value: "gulf", label: "خليجي" },
  { value: "msa", label: "فصحى" },
  { value: "english", label: "English" },
];
const CTA: Record<string, string> = {
  SHOP_NOW: "Shop now",
  ORDER_NOW: "Order now",
  LEARN_MORE: "Learn more",
  SEND_MESSAGE: "Send message",
};
const STEPS = [
  { key: "draft", label: "You approve the ad" },
  { key: "created", label: "Created on Meta (paused)" },
  { key: "active", label: "Running" },
  { key: "watch", label: "Followed up daily" },
];

export default function MediaBuyerPage() {
  const { data, error, mutate } = useSWR<Data>("/api/media-buyer");
  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (!data) return <Skeleton className="h-96" />;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Media buyer"
        subtitle="Tell it your budget and who you want to reach. It checks you can afford it, picks a product that actually earns money, sets the most a sale may cost, writes the ad in your dialect — you approve exactly what people will see — then it runs the details and watches the results every day."
      />
      {!data.connection.ready && (
        <p className="rounded-2xl border border-line bg-sunken px-4 py-3 text-[13px] text-ink2">
          <strong className="text-ink">Planning works now.</strong> {data.connection.reason}{" "}
          <Link href="/app/settings/integrations" className="text-accent">
            Integrations →
          </Link>
        </p>
      )}
      <NewAd d={data} onPlanned={() => mutate()} />
      {data.campaigns.length === 0 ? (
        <EmptyState
          icon={<Megaphone className="size-6" />}
          title="No ads yet"
          body="Plan your first ad above. Nothing is created or spent until you approve it."
        />
      ) : (
        data.campaigns.map((c) => (
          <CampaignCard
            key={c.id}
            c={c}
            cur={data.currency}
            countries={data.countries}
            ready={data.connection.ready}
            onChanged={() => {
              mutate();
              refreshAll();
            }}
          />
        ))
      )}
    </div>
  );
}

function NewAd({ d, onPlanned }: { d: Data; onPlanned: () => void }) {
  const cur = d.currency;
  const [budget, setBudget] = useState<number | null>(100_000);
  const [days, setDays] = useState("5");
  const [country, setCountry] = useState("EG");
  const [dialect, setDialect] = useState<Dialect>("egyptian");
  const [goal, setGoal] = useState<"sales" | "messages">("sales");
  const [product, setProduct] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const { toast } = useUi();
  return (
    <Card className="p-5 sm:p-7">
      <div className="flex items-center gap-2">
        <Sparkles className="size-5 text-accent" aria-hidden />
        <h2 className="display text-2xl">Plan a new ad</h2>
      </div>
      <p className="mt-1 text-[13px] text-ink3">
        Free to spend on ads today: <strong className="text-ink">{formatMoney(Math.max(0, d.canSpend), cur)}</strong>
        {d.cashRiskBreach ? ` · cash dips below your reserve on ${d.cashRiskBreach}` : ""}.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Total budget">
          <MoneyInput value={budget} onChange={setBudget} currency={cur} digits={currencyDigits(cur)} />
        </Field>
        <Field label="For how long">
          <Select value={days} onChange={(e) => setDays(e.target.value)}>
            {["3", "5", "7", "10", "14"].map((x) => (
              <option key={x} value={x}>
                {x} days
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Who should see it (country)">
          <Select
            value={country}
            onChange={(e) => {
              setCountry(e.target.value);
              if (e.target.value !== "EG" && dialect === "egyptian") setDialect("gulf");
              if (e.target.value === "EG" && dialect === "gulf") setDialect("egyptian");
            }}
          >
            {Object.entries(d.countries).map(([k, v]) => (
              <option key={k} value={k}>
                {v.name} — {v.nameAr}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Product">
          <Select value={product} onChange={(e) => setProduct(e.target.value)}>
            <option value="">Let the co-pilot choose (best earner)</option>
            {d.products.map((p) => (
              <option key={p.key} value={p.key}>
                {p.title} — {p.perUnit > 0 ? `keeps ${formatMoney(p.perUnit, cur)}/sale` : "loses money"}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-[auto_auto_1fr]">
        <Field label="Language of the ad">
          <Segmented value={dialect} onChange={setDialect} options={DIALECTS} label="Language of the ad" />
        </Field>
        <Field label="Goal">
          <Segmented
            value={goal}
            onChange={setGoal}
            options={[
              { value: "sales", label: "Website sales" },
              { value: "messages", label: "Messages" },
            ]}
            label="Goal"
          />
        </Field>
        <Field label="Link people open" hint="Your store or product page">
          <Input
            dir="ltr"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://your-store.com/product"
          />
        </Field>
      </div>
      {err && <p className="mt-3 text-sm text-neg">{err}</p>}
      <div className="mt-4">
        <Button
          variant="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErr("");
            try {
              await api.post("/api/media-buyer/plan", {
                budget: budget ?? 0,
                days: Number(days),
                country,
                dialect,
                goal,
                link,
                productKey: product || null,
              });
              onPlanned();
              toast({
                title: "Ad planned",
                description: "Review it below. Nothing is created or spent until you approve.",
              });
            } catch (x) {
              setErr(x instanceof ApiError ? x.message : "Could not plan the ad.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Sparkles className="size-4" aria-hidden /> Plan my ad
        </Button>
      </div>
    </Card>
  );
}

function CampaignCard({
  c,
  cur,
  countries,
  ready,
  onChanged,
}: {
  c: Campaign;
  cur: string;
  countries: Data["countries"];
  ready: boolean;
  onChanged: () => void;
}) {
  const fm = (v: number) => formatMoney(v, cur);
  const p = c.plan;
  const { toast } = useUi();
  const [text, setText] = useState(c.creative.primaryText);
  const [headline, setHeadline] = useState(c.creative.headline);
  const [cta, setCta] = useState(c.creative.cta);
  const [link, setLink] = useState(c.creative.link);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [del, setDel] = useState(false);
  const editable = ["draft", "awaiting_approval"].includes(c.status);
  const dirty =
    text !== c.creative.primaryText ||
    headline !== c.creative.headline ||
    cta !== c.creative.cta ||
    link !== c.creative.link;
  const stepIndex =
    c.status === "active" ? (c.metrics ? 3 : 2) : ["created", "paused", "activating"].includes(c.status) ? 1 : 0;
  const rtl = c.brief.dialect !== "english";
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast({ title: done });
      onChanged();
    } catch (x) {
      toast({ title: "Not done", description: x instanceof ApiError ? x.message : undefined, tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const pendingApproval = c.actions.find((a) => a.status === "awaiting_approval");
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="overflow-hidden">
        <div
          className={clsx(
            "flex flex-wrap items-center gap-3 px-5 py-3 sm:px-7",
            p.affordable.level === "ok"
              ? "bg-possoft/40"
              : p.affordable.level === "tight"
                ? "bg-warnsoft/50"
                : "bg-negsoft/50",
          )}
        >
          {p.affordable.level === "ok" ? (
            <CheckCircle2 className="size-5 text-pos" aria-hidden />
          ) : (
            <TriangleAlert
              className={clsx("size-5", p.affordable.level === "tight" ? "text-warn" : "text-neg")}
              aria-hidden
            />
          )}
          <p className="min-w-[60%] flex-1 text-[14px] text-ink">{p.affordable.text}</p>
          <Badge>
            {fm(c.brief.budget)} · {c.brief.days} days · {countries[c.brief.country]?.name ?? c.brief.country}
          </Badge>
        </div>
        <ol className="flex flex-wrap gap-2 border-b border-line px-5 py-3 sm:px-7">
          {STEPS.map((s, i) => (
            <li
              key={s.key}
              className={clsx(
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px]",
                i < stepIndex
                  ? "bg-possoft text-pos"
                  : i === stepIndex
                    ? "bg-accentsoft font-medium text-accent"
                    : "bg-sunken text-ink3",
              )}
            >
              {i < stepIndex ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                <span className="grid size-4 place-items-center rounded-full bg-surface text-[10px]">{i + 1}</span>
              )}
              {s.label}
            </li>
          ))}
        </ol>
        <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[1fr_360px]">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Fact label="Advertise" value={p.product?.title ?? "—"} sub={p.product?.reason} />
              <Fact
                label="Most a sale may cost"
                value={p.maxCostPerSale ? fm(p.maxCostPerSale) : "—"}
                sub="Above this, each sale loses money"
              />
              <Fact
                label="Target cost per sale"
                value={p.targetCostPerSale ? fm(p.targetCostPerSale) : "—"}
                sub={
                  p.expected.salesAtTarget !== null
                    ? `≈ ${Math.max(1, p.expected.salesAtTarget)} sale${Math.max(1, p.expected.salesAtTarget) === 1 ? "" : "s"} if met`
                    : undefined
                }
              />
            </div>
            <p className="text-[13px] text-ink2">{p.expected.text}</p>
            {p.warnings.length > 0 && (
              <ul className="space-y-1">
                {p.warnings.map((w, i) => (
                  <li key={i} className="flex gap-2 text-[13px] text-warn">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={() => setOpen(!open)}
              className="flex items-center gap-1.5 text-[13px] font-medium text-accent"
            >
              <ChevronDown className={clsx("size-4 transition", open && "rotate-180")} aria-hidden /> What the co-pilot
              handles for you
            </button>
            {open && (
              <div className="rounded-xl bg-sunken p-4 text-[13px] text-ink2">
                <p>
                  <strong className="text-ink">Audience:</strong> {p.audience.summary}
                </p>
                <p className="mt-1">
                  <strong className="text-ink">Interests it targets:</strong> {p.audience.interests.join(", ")}
                </p>
                <p className="mt-1">
                  <strong className="text-ink">Placements:</strong> {p.audience.placements}
                </p>
                <p className="mt-1">
                  <strong className="text-ink">Daily budget:</strong> {fm(p.dailyBudget)} · lowest-cost bidding · stops
                  automatically after {c.brief.days} days
                </p>
              </div>
            )}
            {c.metrics && (
              <div className="rounded-2xl border border-line p-4">
                <p className="text-[13px] font-semibold text-ink">Results so far</p>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4 text-[13px]">
                  <Fact label="Spent" value={fm(c.metrics.spend)} />
                  <Fact label="Clicks" value={String(c.metrics.clicks)} />
                  <Fact label="Sales" value={c.metrics.sales === null ? "not measured" : String(c.metrics.sales)} />
                  <Fact
                    label="Cost per sale"
                    value={c.metrics.costPerSale === null ? "—" : fm(c.metrics.costPerSale)}
                  />
                </div>
                <p
                  className={clsx(
                    "mt-2 text-[13px]",
                    c.metrics.verdict === "pause"
                      ? "text-neg"
                      : c.metrics.verdict === "scale"
                        ? "text-pos"
                        : "text-ink2",
                  )}
                >
                  {c.metrics.reason}
                </p>
              </div>
            )}
            {c.error && <p className="text-sm text-neg">{c.error}</p>}
            <div className="flex flex-wrap gap-2">
              {editable && dirty && (
                <Button
                  loading={busy === "save"}
                  onClick={() =>
                    run(
                      "save",
                      () =>
                        api.patch(`/api/media-buyer/${c.id}`, {
                          primaryText: text,
                          headline,
                          cta,
                          ...(link ? { link } : {}),
                        }),
                      "Saved — your wording will guide future ads",
                    )
                  }
                >
                  Save my changes
                </Button>
              )}
              {editable && !dirty && !pendingApproval && (
                <Button
                  variant="primary"
                  loading={busy === "approve"}
                  onClick={() =>
                    run(
                      "approve",
                      () => api.post(`/api/media-buyer/${c.id}/approve`),
                      "Sent for approval in the Action Center",
                    )
                  }
                >
                  Approve this ad
                </Button>
              )}
              {pendingApproval && (
                <Link
                  href="/app/actions?tab=approvals"
                  className="inline-flex h-10 items-center rounded-xl bg-warnsoft px-4 text-sm font-medium text-ink"
                >
                  Waiting for approval → review
                </Link>
              )}
              {["created", "paused"].includes(c.status) && !pendingApproval && (
                <Button
                  variant="primary"
                  loading={busy === "start"}
                  onClick={() =>
                    run("start", () => api.post(`/api/media-buyer/${c.id}/activate`), "Start request sent for approval")
                  }
                >
                  <Play className="size-4" aria-hidden /> Start the ad
                </Button>
              )}
              {c.status === "active" && (
                <Button
                  loading={busy === "pause"}
                  onClick={() => run("pause", () => api.post(`/api/media-buyer/${c.id}/pause`), "Paused")}
                >
                  <Pause className="size-4" aria-hidden /> Pause now
                </Button>
              )}
              {c.external?.campaignId && (
                <Button
                  variant="ghost"
                  loading={busy === "check"}
                  onClick={() => run("check", () => api.post(`/api/media-buyer/${c.id}/check`), "Results updated")}
                >
                  <RefreshCw className="size-4" aria-hidden /> Check results
                </Button>
              )}
              {editable && (
                <Button variant="ghost" onClick={() => setDel(true)} aria-label="Delete draft">
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              )}
            </div>
            {!ready && editable && (
              <p className="text-xs text-ink3">
                Approving is possible now; creating on Meta needs the Meta connection with ad permissions.
              </p>
            )}
          </div>

          {/* What people will see: the owner edits it directly */}
          <div>
            <p className="eyebrow">What people will see {editable ? "· edit it" : ""}</p>
            <div className="mt-2 overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className="grid size-8 place-items-center rounded-full bg-accent text-[12px] font-semibold text-white">
                  {(p.product?.title ?? "A").slice(0, 1)}
                </span>
                <div className="leading-tight">
                  <p className="text-[13px] font-semibold text-ink">Your business</p>
                  <p className="text-[11px] text-ink3">Sponsored</p>
                </div>
              </div>
              {editable ? (
                <div className="px-3 pb-2">
                  <Textarea
                    dir={rtl ? "rtl" : "ltr"}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={4}
                    aria-label="Ad text"
                    className="text-[14px]"
                  />
                </div>
              ) : (
                <p dir={rtl ? "rtl" : "ltr"} className="whitespace-pre-line px-3 pb-2 text-[14px] text-ink">
                  {c.creative.primaryText}
                </p>
              )}
              <div className="grid aspect-[1.6] place-items-center bg-gradient-to-br from-accentsoft to-sunken text-[13px] text-ink3">
                {c.creative.imageUrl ? "Your image" : "Your product photo"}
              </div>
              <div className="flex items-center gap-2 bg-sunken/60 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  {editable ? (
                    <Input
                      dir={rtl ? "rtl" : "ltr"}
                      value={headline}
                      onChange={(e) => setHeadline(e.target.value)}
                      aria-label="Headline"
                      className="h-9 text-[13px] font-semibold"
                    />
                  ) : (
                    <p dir={rtl ? "rtl" : "ltr"} className="truncate text-[13px] font-semibold text-ink">
                      {c.creative.headline}
                    </p>
                  )}
                </div>
                {editable ? (
                  <div className="w-32 shrink-0">
                    <Select
                      value={cta}
                      onChange={(e) => setCta(e.target.value)}
                      aria-label="Button"
                      className="h-9 text-[12px]"
                    >
                      {Object.entries(CTA).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : (
                  <span className="rounded-lg bg-surface px-3 py-1.5 text-[12px] font-medium text-ink">
                    {CTA[c.creative.cta]}
                  </span>
                )}
              </div>
            </div>
            {editable && (
              <Field label="Link people open" className="mt-3">
                <Input dir="ltr" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" />
              </Field>
            )}
            <p className="mt-2 text-xs text-ink3">
              {p.copyEngine === "claude"
                ? "Written by Claude in your chosen dialect"
                : "Written from a template in your chosen dialect"}{" "}
              — change anything that doesn&apos;t sound like you. Your edits teach the next ads.
            </p>
          </div>
        </div>
      </Card>
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title="Delete this draft?"
        body="Nothing was created on Meta."
        confirmLabel="Delete"
        onConfirm={async () => {
          await api.del(`/api/media-buyer/${c.id}`);
          onChanged();
        }}
      />
    </motion.div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-ink3">{label}</p>
      <p className="text-[15px] font-semibold text-ink">{value}</p>
      {sub && <p className="text-xs text-ink3">{sub}</p>}
    </div>
  );
}
