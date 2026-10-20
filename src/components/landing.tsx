"use client";
import { MotionConfig, motion, useMotionValueEvent, useScroll, useSpring, useTransform } from "motion/react";
import { ArrowRight, Check, FileSpreadsheet, Megaphone, ShoppingBag } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { AreaLine } from "@/components/charts";
import { Wordmark } from "@/components/app/shell";
import { AnimatedNumber, Badge, Button, clsx, Hint } from "@/components/ui";
import { formatMoney } from "@/lib/finance/money";

const CUR = "EGP";
const E = (n: number) => Math.round(n * 100);

// Nav
function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-paper/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Link href="/" aria-label="Socio home">
          <Wordmark />
        </Link>
        <nav aria-label="Site" className="hidden items-center gap-8 text-sm font-medium text-ink2 md:flex">
          <a href="#how" className="hover:text-ink">
            How it works
          </a>
          <a href="#terms" className="hover:text-ink">
            Plain language
          </a>
          <a href="#who" className="hover:text-ink">
            Who it&rsquo;s for
          </a>
          <a href="#connect" className="hover:text-ink">
            Integrations
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="hidden h-10 items-center rounded-xl px-4 text-sm font-medium text-ink2 hover:text-ink sm:inline-flex"
          >
            Sign in
          </Link>
          <Button href="/register" variant="primary">
            Get started
          </Button>
        </div>
      </div>
    </header>
  );
}

// Interactive hero: the margin equation
function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  tone,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  tone?: string;
}) {
  const id = label.replace(/\s/g, "-");
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <label htmlFor={id} className="font-medium text-ink2">
          {label}
        </label>
        <span className="num font-medium text-ink">{formatMoney(E(value), CUR, { compact: true })}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={clsx(
          "mt-2 h-2 w-full cursor-pointer appearance-none rounded-full bg-sunken accent-[var(--accent)]",
          tone,
        )}
      />
    </div>
  );
}

function MarginMachine() {
  const [rev, setRev] = useState(150000);
  const [cogs, setCogs] = useState(52000);
  const [ads, setAds] = useState(30000);
  const [ops, setOps] = useState(34000);
  const [paidLate, setPaidLate] = useState(24000);
  const profit = rev - cogs - ads - ops;
  const margin = rev > 0 ? Math.round((profit / rev) * 100) : 0;
  const cashIn = rev - paidLate;
  const cash = cashIn - cogs - ads - ops;
  return (
    <div className="relative rounded-[28px] border border-line bg-surface p-5 shadow-lg sm:p-7">
      <div className="absolute -top-3 start-6">
        <Badge tone="signal">Try it — illustrative numbers</Badge>
      </div>
      <div className="grid gap-7 md:grid-cols-[1.1fr_1fr]">
        <div className="space-y-5">
          <Slider label="You sold" value={rev} onChange={setRev} min={20000} max={300000} step={1000} />
          <Slider label="Products cost" value={cogs} onChange={setCogs} min={0} max={200000} step={1000} />
          <Slider label="Advertising" value={ads} onChange={setAds} min={0} max={100000} step={1000} />
          <Slider label="Everything else" value={ops} onChange={setOps} min={0} max={100000} step={1000} />
          <Slider
            label="Customers still owe you"
            value={paidLate}
            onChange={setPaidLate}
            min={0}
            max={Math.max(1000, rev)}
            step={1000}
          />
        </div>
        <div className="flex flex-col justify-between rounded-2xl bg-accent p-6 text-accentink">
          <div>
            <p className="eyebrow text-accentink/70">Your business kept</p>
            <p className={clsx("fig mt-1 text-[2.7rem] leading-none", profit < 0 && "text-signal")}>
              <AnimatedNumber value={E(profit)} format={(v) => formatMoney(Math.round(v), CUR, { compact: true })} />
            </p>
            <p className="mt-2 text-sm text-accentink/80">
              {rev <= 0
                ? "Sell something to see a margin."
                : profit >= 0
                  ? `About ${margin} out of every 100 you sold.`
                  : `A loss of about ${Math.abs(margin)} for every 100 sold.`}
            </p>
          </div>
          <div className="mt-6 space-y-3 border-t border-accentink/20 pt-4 text-sm">
            <div className="flex justify-between">
              <span className="text-accentink/75">Cash that actually arrived</span>
              <AnimatedNumber
                className="num font-medium"
                value={E(cash)}
                format={(v) => formatMoney(Math.round(v), CUR, { compact: true })}
              />
            </div>
            <p className="text-[13px] leading-snug text-accentink/70">
              {paidLate > 0
                ? `Profit and cash are different things: ${formatMoney(E(paidLate), CUR, { compact: true })} you sold has not been paid yet.`
                : "Everything you sold has been paid, so profit and cash move together."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// Scroll story
const STEPS = [
  {
    k: "understand",
    title: "Understand",
    q: "How much did you actually earn?",
    body: "Revenue, costs and profit side by side, with every term explained where it appears. Missing costs are called out instead of hidden.",
  },
  {
    k: "track",
    title: "Track",
    q: "Where is the money going?",
    body: "Quick-add income and expenses, import a CSV, or connect Shopify. Transfers and refunds are handled correctly so totals stay honest.",
  },
  {
    k: "detect",
    title: "Detect",
    q: "What is coming that could hurt?",
    body: "Bills, salaries and unpaid invoices laid out day by day, so a cash shortfall shows up weeks before it happens.",
  },
  {
    k: "decide",
    title: "Decide",
    q: "Can you afford it?",
    body: "Test a hire, a stock order or a sales dip on a copy of your numbers. Compare cash and profit before you commit.",
  },
];
const SAMPLE = Array.from({ length: 46 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  const base =
    92000 + Math.sin(i / 5) * 6000 - (i > 12 ? 14000 : 0) - (i > 27 ? 52000 : 0) + (i > 20 && i < 24 ? 18000 : 0);
  return { date: d, value: E(base) };
});
const SAMPLE_SIM = SAMPLE.map((p, i) => ({
  ...p,
  value: p.value - (i > 8 ? E(9000) : 0) - (i > 20 ? E((i - 20) * 600) : 0),
}));

function Story() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const smooth = useSpring(scrollYProgress, { stiffness: 120, damping: 26, mass: 0.4 });
  const [active, setActive] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (v) =>
    setActive(Math.min(STEPS.length - 1, Math.max(0, Math.floor(v * STEPS.length * 0.999)))),
  );
  const bar = useTransform(smooth, [0, 1], ["0%", "100%"]);
  return (
    <section id="how" ref={ref} className="relative" style={{ height: `${STEPS.length * 85}vh` }}>
      <div className="sticky top-16 mx-auto grid h-[calc(100dvh-4rem)] max-w-6xl items-center gap-10 px-5 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <p className="eyebrow">How it works</p>
          <h2 className="display mt-2 text-[2.2rem] leading-[1.05] sm:text-5xl">
            One loop, from numbers to decisions.
          </h2>
          <ol className="mt-8 space-y-1">
            {STEPS.map((s, i) => (
              <li key={s.k}>
                <button
                  onClick={() => document.getElementById("how")?.scrollIntoView()}
                  className={clsx(
                    "w-full rounded-2xl border px-5 py-4 text-start transition",
                    active === i ? "border-line bg-raised shadow-sm" : "border-transparent opacity-50",
                  )}
                >
                  <span className="flex items-baseline gap-3">
                    <span className="eyebrow">0{i + 1}</span>
                    <span className="display text-2xl">{s.title}</span>
                  </span>
                  <motion.span
                    initial={false}
                    animate={{ height: active === i ? "auto" : 0, opacity: active === i ? 1 : 0 }}
                    className="block overflow-hidden"
                  >
                    <span className="mt-1 block text-[15px] font-medium text-accent">“{s.q}”</span>
                    <span className="mt-1 block text-[15px] leading-relaxed text-ink2">{s.body}</span>
                  </motion.span>
                </button>
              </li>
            ))}
          </ol>
          <div className="mt-6 h-1 w-full overflow-hidden rounded-full bg-sunken">
            <motion.div className="h-full rounded-full bg-accent" style={{ width: bar }} />
          </div>
        </div>
        <div className="relative hidden aspect-[4/3.3] lg:block" aria-hidden>
          {STEPS.map((s, i) => (
            <motion.div
              key={s.k}
              initial={false}
              animate={{ opacity: active === i ? 1 : 0, y: active === i ? 0 : 24, scale: active === i ? 1 : 0.97 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0 rounded-[28px] border border-line bg-surface p-7 shadow-lg"
              style={{ pointerEvents: active === i ? "auto" : "none" }}
            >
              <Preview k={s.k} />
              <p className="absolute bottom-4 end-6 text-[11px] text-ink3">Illustrative sample, not real data</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Preview({ k }: { k: string }) {
  if (k === "understand")
    return (
      <div className="flex h-full flex-col">
        <p className="eyebrow">Profit this month</p>
        <p className="fig mt-1 text-6xl">EGP 38,400</p>
        <p className="mt-1 text-sm text-ink2">About 26 out of every 100 you sold.</p>
        <div className="mt-8 grid grid-cols-3 gap-px overflow-hidden rounded-2xl bg-line">
          {[
            ["Revenue", "EGP 148K"],
            ["− Cost of goods", "EGP 52K"],
            ["− Expenses", "EGP 58K"],
          ].map(([a, b]) => (
            <div key={a} className="bg-surface p-4">
              <p className="eyebrow">{a}</p>
              <p className="fig mt-1 text-xl">{b}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 flex-1 rounded-2xl bg-sunken p-4">
          <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
            Gross profit <Hint k="gross_profit" />
          </p>
          <p className="mt-1 text-sm text-ink2">“How much was left after paying for what you sold?”</p>
        </div>
      </div>
    );
  if (k === "track")
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between">
          <p className="display text-xl">Add a transaction</p>
          <Badge>⌘K · N</Badge>
        </div>
        <div className="mt-5 grid grid-cols-5 gap-1.5 rounded-2xl bg-sunken p-1 text-center text-[12px] font-medium">
          {["Expense", "Income", "Transfer", "Refund", "Adjust"].map((t, i) => (
            <span key={t} className={clsx("rounded-xl py-2", i === 0 ? "bg-raised shadow-sm" : "text-ink3")}>
              {t}
            </span>
          ))}
        </div>
        <div className="mt-5 space-y-3">
          <div className="rounded-xl border border-line bg-raised px-4 py-3 text-sm">
            <span className="text-ink3">Amount</span> <span className="fig float-end text-xl">EGP 4,200</span>
          </div>
          <div className="rounded-xl border border-line bg-raised px-4 py-3 text-sm">
            <span className="text-ink3">Category</span> <span className="float-end">Marketing → Social ads</span>
          </div>
          <div className="rounded-xl border border-line bg-raised px-4 py-3 text-sm">
            <span className="text-ink3">Account</span> <span className="float-end">Bank — CIB</span>
          </div>
        </div>
        <p className="mt-5 flex items-start gap-2 rounded-xl bg-accentsoft px-3.5 py-3 text-[13px] text-accent">
          <Check className="mt-0.5 size-4 shrink-0" /> Transfers never count as revenue. Refunds reduce revenue instead
          of hiding in expenses.
        </p>
      </div>
    );
  if (k === "detect")
    return (
      <div className="flex h-full flex-col">
        <p className="eyebrow">Cash outlook · projected</p>
        <p className="display mt-1 text-2xl">
          Low point on 3 Feb: <span className="text-neg">−EGP 43K</span>
        </p>
        <div className="mt-3 flex-1">
          <AreaLine series={SAMPLE} currency={CUR} height={250} label="Illustrative cash timeline" />
        </div>
        <ul className="mt-2 space-y-1.5 text-sm">
          <li className="flex justify-between">
            <span>Fabric supplier · 28 Jan</span>
            <span className="num text-neg">−EGP 118K</span>
          </li>
          <li className="flex justify-between">
            <span>Wholesale invoice · 22 Jan</span>
            <span className="num text-pos">+EGP 38K</span>
          </li>
        </ul>
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      <p className="eyebrow">What if — hire a designer at EGP 12,000 / month</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-sunken p-4">
          <p className="eyebrow">Baseline cash · 90d</p>
          <p className="fig mt-1 text-2xl">EGP 71K</p>
        </div>
        <div className="rounded-2xl bg-accent p-4 text-accentink">
          <p className="eyebrow text-accentink/70">With the hire</p>
          <p className="fig mt-1 text-2xl">EGP 33K</p>
        </div>
      </div>
      <div className="mt-3 flex-1">
        <AreaLine
          series={SAMPLE}
          compare={SAMPLE_SIM}
          currency={CUR}
          height={220}
          label="Illustrative scenario comparison"
        />
      </div>
      <p className="text-[13px] text-ink2">Your real transactions are never changed by a simulation.</p>
    </div>
  );
}

// Page
const WORDS = [
  { k: "profit", t: "Profit" },
  { k: "cash_flow", t: "Cash flow" },
  { k: "roas", t: "ROAS" },
  { k: "runway", t: "Runway" },
  { k: "gross_profit", t: "Gross profit" },
  { k: "receivable", t: "Receivables" },
];
const WHO = [
  {
    t: "Fashion & accessories",
    q: "“I sold 200 pieces — why is my account empty?”",
    d: "Stock bought up front, sales spread over weeks. See profit and cash side by side.",
  },
  {
    t: "Cosmetics & beauty",
    q: "“Are my ads actually paying for themselves?”",
    d: "Compare ROAS with your real margin to see the break-even point.",
  },
  {
    t: "Home & living",
    q: "“Can I afford another inventory batch?”",
    d: "Test the order against upcoming bills and your reserve.",
  },
  {
    t: "Founders & early-stage",
    q: "“How long can this keep going?”",
    d: "Runway, reserve targets and goals — in words, not accounting jargon.",
  },
];

export function Landing() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="grain relative">
        <Nav />
        <main className="relative z-10">
          {/* Hero */}
          <section className="mx-auto max-w-6xl px-5 pb-20 pt-14 sm:pt-20">
            <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="eyebrow">
              Business finance for people who run businesses
            </motion.p>
            <motion.h1
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              className="display mt-4 max-w-4xl text-[2.9rem] leading-[0.98] sm:text-[5.2rem]"
            >
              You know what you sold.
              <br />
              Now see what you{" "}
              <span className="relative inline-block">
                <span className="relative z-10">keep</span>
                <motion.span
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ delay: 0.6, duration: 0.6 }}
                  style={{ originX: 0 }}
                  className="absolute inset-x-[-0.1em] bottom-[0.08em] top-[0.45em] -z-0 -skew-x-6 rounded-sm bg-signal"
                />
              </span>
              .
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="mt-6 max-w-2xl text-lg leading-relaxed text-ink2"
            >
              Socio is a calm financial copilot for small brands and founders. It turns your sales, costs and bills into
              profit, cash and clear next steps — and explains every term as you go.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="mt-8 flex flex-wrap items-center gap-3"
            >
              <Button href="/register" variant="primary" size="lg">
                Create your workspace <ArrowRight className="size-4" />
              </Button>
              <Button href="/login" size="lg">
                Sign in
              </Button>
              <span className="text-sm text-ink3">Start manually, import a CSV, or explore a labelled demo.</span>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.8 }}
              className="mt-14"
            >
              <MarginMachine />
            </motion.div>
          </section>

          <Story />

          {/* Plain language */}
          <section id="terms" className="mx-auto max-w-6xl px-5 py-24">
            <div className="grid items-center gap-12 lg:grid-cols-2">
              <div>
                <p className="eyebrow">Plain language, professional terms</p>
                <h2 className="display mt-2 text-4xl leading-tight sm:text-5xl">
                  Learn finance without feeling behind.
                </h2>
                <p className="mt-4 text-lg leading-relaxed text-ink2">
                  Socio never hides the proper word for something. It shows it, then asks the question you actually
                  have: “How much did your business actually earn?” Tap or hover any ⓘ to see the definition, why it
                  matters and exactly how it is calculated.
                </p>
              </div>
              <motion.ul
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, margin: "-80px" }}
                variants={{ show: { transition: { staggerChildren: 0.07 } } }}
                className="grid grid-cols-2 gap-3"
              >
                {WORDS.map((w) => (
                  <motion.li
                    key={w.k}
                    variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } }}
                    className="flex items-center justify-between rounded-2xl border border-line bg-surface px-5 py-5 shadow-sm"
                  >
                    <span className="display text-xl">{w.t}</span>
                    <Hint k={w.k} className="size-8" />
                  </motion.li>
                ))}
              </motion.ul>
            </div>
          </section>

          {/* Who */}
          <section id="who" className="border-y border-line bg-surface/60">
            <div className="mx-auto max-w-6xl px-5 py-24">
              <p className="eyebrow">Who it&rsquo;s for</p>
              <h2 className="display mt-2 max-w-3xl text-4xl leading-tight sm:text-5xl">
                Built for the questions founders actually ask.
              </h2>
              <ul className="mt-12 grid gap-4 sm:grid-cols-2">
                {WHO.map((w, i) => (
                  <motion.li
                    key={w.t}
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-60px" }}
                    transition={{ delay: (i % 2) * 0.08 }}
                    className="rounded-3xl border border-line bg-raised p-7"
                  >
                    <p className="eyebrow">{w.t}</p>
                    <p className="display mt-3 text-2xl leading-snug">{w.q}</p>
                    <p className="mt-3 text-[15px] leading-relaxed text-ink2">{w.d}</p>
                  </motion.li>
                ))}
              </ul>
            </div>
          </section>

          {/* Integrations - honest */}
          <section id="connect" className="mx-auto max-w-6xl px-5 py-24">
            <p className="eyebrow">Integrations</p>
            <h2 className="display mt-2 max-w-3xl text-4xl leading-tight sm:text-5xl">
              Connect what you have. Not required to start.
            </h2>
            <p className="mt-4 max-w-2xl text-lg text-ink2">
              Socio is fully useful with records you enter or import. Connections are read-only and shown with their
              real status.
            </p>
            <ul className="mt-10 grid gap-4 md:grid-cols-3">
              {[
                {
                  i: FileSpreadsheet,
                  n: "CSV import & export",
                  s: "Available now",
                  d: "Bank exports and spreadsheets, with preview and duplicate protection.",
                  tone: "pos" as const,
                },
                {
                  i: ShoppingBag,
                  n: "Shopify",
                  s: "Real OAuth flow built",
                  d: "Orders, refunds, products and unit costs. Needs your Shopify app credentials on the server.",
                  tone: "info" as const,
                },
                {
                  i: Megaphone,
                  n: "Meta Ads & Google Ads",
                  s: "Adapters built",
                  d: "Spend, clicks and attributed revenue, kept apart from your ledger. Needs developer credentials and provider approval.",
                  tone: "info" as const,
                },
              ].map((c) => (
                <li key={c.n} className="rounded-3xl border border-line bg-surface p-6">
                  <c.i className="size-7 text-accent" aria-hidden />
                  <p className="display mt-4 text-xl">{c.n}</p>
                  <div className="mt-2">
                    <Badge tone={c.tone}>{c.s}</Badge>
                  </div>
                  <p className="mt-3 text-[15px] leading-relaxed text-ink2">{c.d}</p>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm text-ink3">
              Socio never moves money, and an integration is only ever shown as connected after the provider has
              authorised it.
            </p>
          </section>

          {/* CTA */}
          <section className="mx-auto max-w-6xl px-5 pb-24">
            <div className="relative overflow-hidden rounded-[36px] bg-accent px-8 py-16 text-center text-accentink sm:px-16">
              <div
                className="absolute inset-0 opacity-30"
                style={{ backgroundImage: "radial-gradient(circle at 15% 0%, rgba(216,242,90,.7), transparent 45%)" }}
              />
              <h2 className="display relative text-4xl leading-tight sm:text-6xl">See your margin.</h2>
              <p className="relative mx-auto mt-4 max-w-xl text-lg text-accentink/85">
                Set up takes about two minutes. Start with nothing but a business name.
              </p>
              <div className="relative mt-8 flex flex-wrap justify-center gap-3">
                <Button href="/register" variant="signal" size="lg">
                  Create your workspace
                </Button>
                <Link
                  href="/login"
                  className="inline-flex h-12 items-center rounded-xl border border-accentink/30 px-6 text-[15px] font-medium text-accentink hover:bg-accentink/10"
                >
                  Sign in
                </Link>
              </div>
            </div>
          </section>
        </main>
        <footer className="relative z-10 border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm text-ink3">
            <Wordmark className="text-xl" />
            <p>Socio provides financial information, not financial, tax or legal advice.</p>
            <nav aria-label="Footer" className="flex gap-5">
              <Link href="/login" className="hover:text-ink">
                Sign in
              </Link>
              <Link href="/register" className="hover:text-ink">
                Register
              </Link>
            </nav>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}
