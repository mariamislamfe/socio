"use client";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, FileSpreadsheet, PencilLine, ShoppingBag, Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Wordmark } from "@/components/app/shell";
import { Button, clsx, Field, Input, MoneyInput, Select } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { currencyDigits } from "@/lib/finance/money";

const TYPES = [
  ["fashion", "Fashion & accessories"],
  ["cosmetics", "Cosmetics & beauty"],
  ["home", "Home & living"],
  ["food", "Food & beverage"],
  ["services", "Services / studio"],
  ["ecommerce", "Other e-commerce"],
  ["other", "Something else"],
] as const;
const COUNTRIES: [string, string, string][] = [
  ["EG", "Egypt", "EGP"],
  ["SA", "Saudi Arabia", "SAR"],
  ["AE", "United Arab Emirates", "AED"],
  ["KW", "Kuwait", "KWD"],
  ["QA", "Qatar", "QAR"],
  ["BH", "Bahrain", "BHD"],
  ["OM", "Oman", "OMR"],
  ["JO", "Jordan", "JOD"],
  ["MA", "Morocco", "MAD"],
  ["TR", "Türkiye", "TRY"],
  ["GB", "United Kingdom", "GBP"],
  ["US", "United States", "USD"],
  ["DE", "Germany", "EUR"],
  ["FR", "France", "EUR"],
  ["IN", "India", "INR"],
  ["PK", "Pakistan", "PKR"],
  ["NG", "Nigeria", "NGN"],
  ["KE", "Kenya", "KES"],
  ["ZA", "South Africa", "ZAR"],
];
const TIMEZONES = [
  "Africa/Cairo",
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Kuwait",
  "Asia/Qatar",
  "Asia/Bahrain",
  "Asia/Muscat",
  "Asia/Amman",
  "Africa/Casablanca",
  "Europe/Istanbul",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Asia/Karachi",
  "Africa/Lagos",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "UTC",
];
const CURRENCIES = [
  "EGP",
  "SAR",
  "AED",
  "KWD",
  "QAR",
  "BHD",
  "OMR",
  "JOD",
  "MAD",
  "TRY",
  "GBP",
  "USD",
  "EUR",
  "INR",
  "PKR",
  "NGN",
  "KES",
  "ZAR",
];
const STAGES = [
  ["idea", "Just starting", "Pre-launch or first sales"],
  ["early", "Early traction", "Selling regularly, finding my footing"],
  ["growing", "Growing", "Steady sales, hiring or scaling"],
  ["established", "Established", "Mature, optimising margins"],
] as const;
const CHANNELS = [
  ["online_store", "Online store"],
  ["marketplace", "Marketplaces"],
  ["social", "Social media / DMs"],
  ["retail", "Physical shop"],
  ["wholesale", "Wholesale"],
  ["services", "Services / bookings"],
] as const;

function Wizard() {
  const router = useRouter();
  const sp = useSearchParams();
  const { me } = useMe();
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [f, setF] = useState({
    name: "",
    business_type: "fashion",
    country: "EG",
    currency: "EGP",
    stage: "early",
    channels: ["online_store"] as string[],
    has_history: false,
    opening: null as number | null,
    reserve: null as number | null,
    timezone: (typeof Intl !== "undefined" && Intl.DateTimeFormat().resolvedOptions().timeZone) || "Africa/Cairo",
    mode: "manual" as "manual" | "csv" | "shopify",
  });

  useEffect(() => {
    // Returning users who already have a workspace can still add another with ?new=1.
    if (me?.active && !sp.get("new")) router.replace("/app");
  }, [me, sp, router]);

  const go = (n: number) => {
    setDir(n > step ? 1 : -1);
    setStep(n);
    setErr("");
  };
  const steps = ["Your business", "Where & how", "How to start"];

  const finish = async (mode: "manual" | "csv" | "shopify") => {
    setBusy(mode);
    setErr("");
    try {
      await api.post("/api/businesses", {
        name: f.name.trim(),
        business_type: f.business_type,
        country: f.country,
        currency: f.currency,
        stage: f.stage,
        channels: f.channels,
        has_history: f.has_history,
        setup_mode: mode,
        opening_balance: f.opening ?? 0,
        timezone: f.timezone,
        safety_reserve: f.reserve,
      });
      await refreshAll();
      router.replace(
        mode === "csv" ? "/app/settings/data" : mode === "shopify" ? "/app/settings/integrations" : "/app",
      );
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not reach the server.");
      setBusy(null);
    }
  };

  const demo = async () => {
    setBusy("demo");
    try {
      await api.post("/api/demo");
      await refreshAll();
      router.replace("/app");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not create the demo.");
      setBusy(null);
    }
  };

  const canNext0 = f.name.trim().length > 0;

  return (
    <div className="grain relative min-h-dvh">
      <header className="relative z-10 mx-auto flex max-w-3xl items-center justify-between px-6 py-6">
        <Wordmark />
        <p className="text-sm text-ink3">Step {step + 1} of 3</p>
      </header>
      <div className="relative z-10 mx-auto max-w-3xl px-6">
        <ol className="mb-8 flex gap-2" aria-label="Progress">
          {steps.map((s, i) => (
            <li key={s} className="flex-1">
              <div className={clsx("h-1.5 rounded-full transition-colors", i <= step ? "bg-accent" : "bg-line")} />
              <p className={clsx("mt-2 text-xs", i === step ? "font-medium text-ink" : "text-ink3")}>{s}</p>
            </li>
          ))}
        </ol>

        <div className="relative min-h-[28rem] pb-24">
          <AnimatePresence mode="wait" custom={dir} initial={false}>
            <motion.div
              key={step}
              custom={dir}
              initial={{ opacity: 0, x: dir * 32 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: dir * -32 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              {step === 0 && (
                <div className="space-y-7">
                  <div>
                    <h1 className="display text-[2.4rem] leading-tight">Let&rsquo;s set up your business.</h1>
                    <p className="mt-2 text-[15px] text-ink2">Just the essentials. You can change everything later.</p>
                  </div>
                  <Field label="Business name" htmlFor="bn">
                    <Input
                      id="bn"
                      autoFocus
                      value={f.name}
                      onChange={(e) => setF({ ...f, name: e.target.value })}
                      placeholder="e.g. Nile & Co."
                      maxLength={120}
                      onKeyDown={(e) => e.key === "Enter" && canNext0 && go(1)}
                    />
                  </Field>
                  <fieldset>
                    <legend className="mb-2 text-[13px] font-medium text-ink2">What kind of business is it?</legend>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {TYPES.map(([v, l]) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={f.business_type === v}
                          onClick={() => setF({ ...f, business_type: v })}
                          className={clsx(
                            "rounded-2xl border px-4 py-3 text-start text-sm font-medium transition",
                            f.business_type === v
                              ? "border-accent bg-accentsoft text-accent"
                              : "border-line bg-raised text-ink2 hover:border-line2",
                          )}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </div>
              )}

              {step === 1 && (
                <div className="space-y-7">
                  <div>
                    <h1 className="display text-[2.4rem] leading-tight">Where and how do you sell?</h1>
                    <p className="mt-2 text-[15px] text-ink2">Your base currency is what all totals are shown in.</p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Country" htmlFor="co">
                      <Select
                        id="co"
                        value={f.country}
                        onChange={(e) => {
                          const c = COUNTRIES.find((x) => x[0] === e.target.value);
                          setF({ ...f, country: e.target.value, currency: c?.[2] ?? f.currency });
                        }}
                      >
                        {COUNTRIES.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label="Timezone"
                      htmlFor="tz"
                      hint="Days, deadlines and the daily briefing follow this clock."
                    >
                      <Select id="tz" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
                        {[...new Set([f.timezone, ...TIMEZONES])].map((z) => (
                          <option key={z} value={z}>
                            {z.replace(/_/g, " ")}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label="Base currency"
                      htmlFor="cu"
                      hint="Amounts in other currencies are kept separate, never silently converted."
                    >
                      <Select
                        id="cu"
                        value={f.currency}
                        onChange={(e) => setF({ ...f, currency: e.target.value, opening: null })}
                      >
                        {CURRENCIES.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <fieldset>
                    <legend className="mb-2 text-[13px] font-medium text-ink2">Where do you sell? (pick any)</legend>
                    <div className="flex flex-wrap gap-2">
                      {CHANNELS.map(([v, l]) => {
                        const on = f.channels.includes(v);
                        return (
                          <button
                            key={v}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              setF({ ...f, channels: on ? f.channels.filter((x) => x !== v) : [...f.channels, v] })
                            }
                            className={clsx(
                              "rounded-full border px-4 py-2 text-sm font-medium transition",
                              on
                                ? "border-accent bg-accentsoft text-accent"
                                : "border-line bg-raised text-ink2 hover:border-line2",
                            )}
                          >
                            {l}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="mb-2 text-[13px] font-medium text-ink2">Where is the business today?</legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {STAGES.map(([v, l, d]) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={f.stage === v}
                          onClick={() => setF({ ...f, stage: v })}
                          className={clsx(
                            "rounded-2xl border px-4 py-3 text-start transition",
                            f.stage === v ? "border-accent bg-accentsoft" : "border-line bg-raised hover:border-line2",
                          )}
                        >
                          <span
                            className={clsx("block text-sm font-medium", f.stage === v ? "text-accent" : "text-ink")}
                          >
                            {l}
                          </span>
                          <span className="text-[13px] text-ink3">{d}</span>
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-7">
                  <div>
                    <h1 className="display text-[2.4rem] leading-tight">How would you like to start?</h1>
                    <p className="mt-2 text-[15px] text-ink2">
                      Socio works fully with records you enter yourself. Connections are optional.
                    </p>
                  </div>
                  <Field
                    label="Safety reserve — the least cash you want to keep (optional)"
                    htmlFor="rs"
                    hint="Socio warns you, explains why and suggests options before cash drops below this. You can set it later."
                  >
                    <MoneyInput
                      id="rs"
                      value={f.reserve}
                      onChange={(v) => setF({ ...f, reserve: v })}
                      currency={f.currency}
                      digits={currencyDigits(f.currency)}
                    />
                  </Field>
                  <Field
                    label="Money in your main account right now (optional)"
                    htmlFor="ob"
                    hint="Sets the opening balance so cash is accurate from day one. Skip if unsure."
                  >
                    <MoneyInput
                      id="ob"
                      value={f.opening}
                      onChange={(v) => setF({ ...f, opening: v })}
                      currency={f.currency}
                      digits={currencyDigits(f.currency)}
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {[
                      {
                        m: "manual" as const,
                        icon: PencilLine,
                        title: "Start fresh",
                        body: "Add income and expenses as they happen. Fast quick-add.",
                      },
                      {
                        m: "csv" as const,
                        icon: FileSpreadsheet,
                        title: "Import a CSV",
                        body: "Bring history from a bank export or spreadsheet.",
                      },
                      {
                        m: "shopify" as const,
                        icon: ShoppingBag,
                        title: "Connect Shopify",
                        body: "Import orders and refunds (needs store credentials).",
                      },
                    ].map((o) => (
                      <button
                        key={o.m}
                        disabled={!!busy}
                        onClick={() => finish(o.m)}
                        className="group rounded-2xl border border-line bg-raised p-5 text-start shadow-sm transition hover:-translate-y-0.5 hover:border-accent hover:shadow-md disabled:opacity-60"
                      >
                        <o.icon className="size-6 text-accent" aria-hidden />
                        <p className="mt-3 text-[15px] font-semibold text-ink">{o.title}</p>
                        <p className="mt-1 text-[13px] leading-snug text-ink2">
                          {busy === o.m ? "Setting up…" : o.body}
                        </p>
                      </button>
                    ))}
                  </div>
                  <div className="rounded-2xl border border-dashed border-line2 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                          <Sparkles className="size-4 text-accent" aria-hidden /> Just want to look around?
                        </p>
                        <p className="mt-0.5 text-[13px] text-ink2">
                          Explore a clearly labelled demo workspace. It is kept separate from your own records.
                        </p>
                      </div>
                      <Button onClick={demo} loading={busy === "demo"} disabled={!!busy && busy !== "demo"}>
                        Explore demo data
                      </Button>
                    </div>
                  </div>
                  {err && (
                    <p role="alert" className="rounded-xl bg-negsoft px-3 py-2.5 text-sm text-neg">
                      {err}
                    </p>
                  )}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Button variant="ghost" onClick={() => go(step - 1)} disabled={step === 0}>
            <ArrowLeft className="size-4" aria-hidden /> Back
          </Button>
          {step < 2 && (
            <Button variant="primary" onClick={() => go(step + 1)} disabled={step === 0 && !canNext0}>
              Continue <ArrowRight className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Wizard />
    </Suspense>
  );
}
