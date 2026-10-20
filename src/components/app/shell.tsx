"use client";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "motion/react";
import {
  Coins,
  HandCoins,
  HeartPulse,
  MessagesSquare,
  Sprout,
  UsersRound,
  BarChart3,
  Zap,
  CalendarDays,
  Scale,
  BookOpen,
  Check,
  ChevronsUpDown,
  CircleDollarSign,
  FlaskConical,
  Gauge,
  Landmark,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Moon,
  Package,
  PiggyBank,
  Plus,
  ReceiptText,
  Search,
  Settings,
  Sparkles,
  Sun,
  Wallet,
  X,
  Bell,
  ArrowUpRight,
  ArrowDownLeft,
  ArrowLeftRight,
  WandSparkles,
  Truck,
  MessageCircle,
  FileCheck2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import { api } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";
import { GLOSSARY } from "@/lib/glossary";
import { useUi } from "../providers";
import { useMode } from "@/lib/client/mode";
import { Badge, Button, clsx, IconButton, Modal, Skeleton } from "../ui";
import { blankDraft, TransactionModal, type TxnDraft } from "./transaction-form";

interface ShellCtx {
  openAdd: (draft?: Partial<TxnDraft>) => void;
  openPalette: () => void;
}
const Ctx = createContext<ShellCtx>({ openAdd: () => {}, openPalette: () => {} });
export const useShell = () => useContext(Ctx);

const NAV = [
  { href: "/app", key: "nav.dashboard", icon: LayoutDashboard, exact: true },
  { href: "/app/actions", key: "nav.actions", icon: Zap },
  { href: "/app/plan", key: "nav.plan", icon: Coins },
  { href: "/app/health", key: "nav.health", icon: HeartPulse },
  { group: "nav.group.egypt" },
  { href: "/app/settings/notifications", key: "nav.whatsapp", icon: MessageCircle },
  { href: "/app/cod", key: "nav.cod", icon: Truck },
  { href: "/app/media-buyer", key: "nav.mediabuyer", icon: Megaphone },
  { group: "nav.group.money" },
  { href: "/app/transactions", key: "nav.transactions", icon: ReceiptText },
  { href: "/app/cash-flow", key: "nav.cashflow", icon: Wallet },
  { href: "/app/calendar", key: "nav.calendar", icon: CalendarDays },
  { href: "/app/profit", key: "nav.profit", icon: Scale },
  { href: "/app/financing", key: "nav.financing", icon: HandCoins },
  { href: "/app/fixed", key: "nav.fixed", icon: Landmark },
  { href: "/app/tax", key: "nav.tax", icon: FileCheck2 },
  { href: "/app/obligations", key: "nav.obligations", icon: Landmark },
  { group: "nav.group.plan" },
  { href: "/app/budgets", key: "nav.budgets", icon: Gauge },
  { href: "/app/goals", key: "nav.goals", icon: PiggyBank },
  { href: "/app/scenarios", key: "nav.scenarios", icon: FlaskConical },
  { href: "/app/investments", key: "nav.investments", icon: Sprout },
  { group: "nav.group.understand" },
  { href: "/app/ask", key: "nav.ask", icon: MessagesSquare },
  { href: "/app/boardroom", key: "nav.boardroom", icon: UsersRound },
  { href: "/app/products", key: "nav.products", icon: Package },
  { href: "/app/learn", key: "nav.learn", icon: BookOpen },
] as const;

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={clsx("display relative inline-block text-[1.65rem] leading-none tracking-tight text-ink", className)}
    >
      <span data-no-translate>socio</span>
      <span
        aria-hidden
        className="absolute -bottom-0.5 start-0 h-[7px] w-full -skew-x-6 rounded-[2px] bg-signal opacity-90 mix-blend-multiply dark:mix-blend-screen"
        style={{ zIndex: -1 }}
      />
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, biz, isLoading, error } = useMe();
  const { t, theme, setTheme } = useUi();
  const pathname = usePathname();
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState<TxnDraft | undefined>();
  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);

  const openAdd = useCallback((p?: Partial<TxnDraft>) => {
    setDraft(blankDraft(p));
    setAddOpen(true);
  }, []);

  useEffect(() => {
    if (error && (error as any).status === 401) router.replace("/login");
    if (me && !me.active) router.replace("/onboarding");
  }, [error, me, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openAdd();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openAdd]);

  useEffect(() => setMore(false), [pathname]);

  const ctx = useMemo(() => ({ openAdd, openPalette: () => setPalette(true) }), [openAdd]);
  const canWrite = biz && biz.role !== "viewer";

  if (isLoading || !me || !biz) {
    return (
      <div className="grid min-h-dvh place-items-center bg-paper">
        <div className="w-72 space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="grain relative min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[200] focus:rounded-lg focus:bg-ink focus:px-3 focus:py-2 focus:text-paper"
        >
          Skip to content
        </a>
        <aside className="fixed inset-y-0 start-0 z-30 hidden w-64 flex-col border-e border-line bg-surface/80 backdrop-blur md:flex">
          <div className="px-5 pb-3 pt-6">
            <Link href="/app" aria-label="Socio home">
              <Wordmark />
            </Link>
          </div>
          <WorkspaceSwitcher />
          <nav aria-label="Main" className="scroll-thin mt-3 flex-1 overflow-y-auto px-3 pb-4">
            <NavList pathname={pathname} />
          </nav>
          <div className="space-y-1 border-t border-line p-3">
            <Link
              href="/app/settings"
              className={clsx(
                "flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition",
                pathname.startsWith("/app/settings")
                  ? "bg-raised text-ink shadow-sm"
                  : "text-ink2 hover:bg-sunken hover:text-ink",
              )}
            >
              <Settings className="size-[18px]" aria-hidden />
              {t("nav.settings")}
            </Link>
            <button
              onClick={() =>
                setTheme(
                  document.documentElement.dataset.theme === "dark" ||
                    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches)
                    ? "light"
                    : "dark",
                )
              }
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-ink2 transition hover:bg-sunken hover:text-ink"
            >
              <Sun className="size-[18px] dark:hidden" aria-hidden />
              <Moon className="hidden size-[18px] dark:block" aria-hidden />
              <span className="dark:hidden">Dark mode</span>
              <span className="hidden dark:inline">Light mode</span>
            </button>
          </div>
        </aside>

        <div className="relative z-10 md:ps-64">
          <TopBar
            onSearch={() => setPalette(true)}
            onAdd={() => openAdd()}
            canWrite={!!canWrite}
            email={me.user.email}
            name={me.profile.name}
          />
          {biz.is_demo && (
            <div
              role="note"
              className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-signal/60 bg-signal/25 px-4 py-2.5 text-sm text-ink md:mx-8"
            >
              <span>
                <strong className="font-semibold">Demonstration workspace.</strong> {t("demo.banner")} Nothing here is
                mixed with your own records.
              </span>
              <Link href="/onboarding?new=1" className="font-medium text-accent underline underline-offset-2">
                Create my own workspace
              </Link>
            </div>
          )}
          <main id="main" className="mx-auto w-full max-w-[1280px] px-4 pb-28 pt-6 md:px-8 md:pb-16 md:pt-8">
            <motion.div
              key={pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              {children}
            </motion.div>
          </main>
        </div>

        {/* Mobile bottom navigation */}
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        >
          <ul className="mx-auto grid max-w-md grid-cols-5 items-end px-2 pt-1.5">
            <MobileTab href="/app" icon={LayoutDashboard} label="Overview" active={pathname === "/app"} />
            <MobileTab
              href="/app/transactions"
              icon={ReceiptText}
              label="Activity"
              active={pathname.startsWith("/app/transactions")}
            />
            <li className="flex justify-center pb-2">
              <button
                onClick={() => openAdd()}
                disabled={!canWrite}
                aria-label="Add transaction"
                className="-mt-6 flex size-14 items-center justify-center rounded-full bg-accent text-accentink shadow-md transition active:scale-95 disabled:opacity-50"
              >
                <Plus className="size-6" />
              </button>
            </li>
            <MobileTab
              href="/app/calendar"
              icon={CalendarDays}
              label="Calendar"
              active={pathname.startsWith("/app/calendar")}
            />
            <li>
              <button
                onClick={() => setMore(true)}
                className="flex w-full flex-col items-center gap-0.5 py-1.5 text-[11px] font-medium text-ink3"
              >
                <Menu className="size-5" aria-hidden />
                More
              </button>
            </li>
          </ul>
        </nav>

        <Modal open={more} onOpenChange={setMore} title="Menu" size="sm">
          <nav aria-label="All pages" className="grid grid-cols-2 gap-2">
            {[
              ...NAV.filter((n): n is Extract<(typeof NAV)[number], { href: string }> => "href" in n),
              { href: "/app/settings", key: "nav.settings" as const, icon: Settings },
            ].map((n) => {
              const I = n.icon;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className="flex items-center gap-3 rounded-2xl border border-line bg-raised px-3 py-3 text-sm font-medium text-ink"
                >
                  <I className="size-[18px] text-accent" aria-hidden />
                  {t(n.key)}
                </Link>
              );
            })}
          </nav>
        </Modal>

        <TransactionModal open={addOpen} onOpenChange={setAddOpen} initial={draft} />
        <CommandPalette open={palette} onOpenChange={setPalette} onAdd={openAdd} />
      </div>
    </Ctx.Provider>
  );
}

const SIMPLE_NAV = [
  { href: "/app", key: "nav.dashboard", icon: LayoutDashboard, exact: true },
  { href: "/app/calendar", key: "nav.calendar", icon: CalendarDays },
  { href: "/app/transactions", key: "nav.transactions", icon: ReceiptText },
  { href: "/app/fixed", key: "nav.fixed", icon: Landmark },
  { href: "/app/profit", key: "nav.profit", icon: Scale },
  { href: "/app/financing", key: "nav.financing", icon: HandCoins },
  { href: "/app/tax", key: "nav.tax", icon: FileCheck2 },
  { href: "/app/ask", key: "nav.ask", icon: MessagesSquare },
] as const;

// What makes Socio more than a dashboard: shown on its own in both views.
const SPECIAL_NAV = [
  { href: "/app/settings/notifications", key: "nav.whatsapp", icon: MessageCircle },
  { href: "/app/cod", key: "nav.cod", icon: Truck },
  { href: "/app/media-buyer", key: "nav.mediabuyer", icon: Megaphone },
] as const;

function NavList({ pathname }: { pathname: string }) {
  const { t } = useUi();
  const [mode, setMode] = useMode();
  const [open, setOpen] = useState(false);
  const item = (n: { href: string; key: string; icon: typeof Wallet; exact?: boolean }) => {
    const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
    const I = n.icon;
    return (
      <li key={n.href}>
        <Link
          href={n.href}
          aria-current={active ? "page" : undefined}
          className={clsx(
            "relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition",
            active ? "text-ink" : "text-ink2 hover:bg-sunken hover:text-ink",
          )}
        >
          {active && (
            <motion.span
              layoutId="nav-active"
              className="absolute inset-0 -z-0 rounded-xl bg-raised shadow-sm ring-1 ring-line"
              transition={{ type: "spring", stiffness: 520, damping: 40 }}
            />
          )}
          <I className={clsx("relative size-[18px]", active && "text-accent")} aria-hidden />
          <span className="relative">{t(n.key as Parameters<typeof t>[0])}</span>
        </Link>
      </li>
    );
  };
  if (mode === "simple") {
    const simpleHrefs = new Set<string>([...SIMPLE_NAV, ...SPECIAL_NAV].map((n) => n.href));
    return (
      <ul className="space-y-0.5">
        {SIMPLE_NAV.map((n) => item(n as never))}
        <li className="eyebrow px-3 pb-1 pt-5">{t("nav.group.egypt")}</li>
        {SPECIAL_NAV.map((n) => item(n as never))}
        <li className="pt-4">
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium text-ink3 hover:bg-sunken hover:text-ink"
          >
            <ChevronsUpDown className="size-4" aria-hidden /> Advanced tools
          </button>
        </li>
        {open && NAV.filter((n) => !("group" in n) && !simpleHrefs.has(n.href)).map((n) => item(n as never))}
        <li className="pt-4">
          <button
            onClick={() => setMode("full")}
            className="w-full rounded-xl border border-dashed border-line px-3 py-2 text-start text-[12px] text-ink3 hover:border-accent hover:text-ink"
          >
            Switch to the full view
          </button>
        </li>
      </ul>
    );
  }
  return (
    <ul className="space-y-0.5">
      <li className="pb-2">
        <button
          onClick={() => setMode("simple")}
          className="w-full rounded-xl border border-dashed border-line px-3 py-2 text-start text-[12px] text-ink3 hover:border-accent hover:text-ink"
        >
          Switch to the simple view
        </button>
      </li>
      {NAV.map((n, i) => {
        if ("group" in n)
          return (
            <li key={i} className="eyebrow px-3 pb-1 pt-5">
              {t(n.group)}
            </li>
          );
        const active = "exact" in n && n.exact ? pathname === n.href : pathname.startsWith(n.href);
        const I = n.icon;
        return (
          <li key={n.href}>
            <Link
              href={n.href}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition",
                active ? "text-ink" : "text-ink2 hover:bg-sunken hover:text-ink",
              )}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 -z-0 rounded-xl bg-raised shadow-sm ring-1 ring-line"
                  transition={{ type: "spring", stiffness: 520, damping: 40 }}
                />
              )}
              <I className={clsx("relative size-[18px]", active && "text-accent")} aria-hidden />
              <span className="relative">{t(n.key)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function MobileTab({
  href,
  icon: I,
  label,
  active,
}: {
  href: string;
  icon: typeof Wallet;
  label: string;
  active: boolean;
}) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={clsx(
          "flex flex-col items-center gap-0.5 py-1.5 text-[11px] font-medium",
          active ? "text-accent" : "text-ink3",
        )}
      >
        <I className="size-5" aria-hidden />
        {label}
      </Link>
    </li>
  );
}

function WorkspaceSwitcher() {
  const { me, biz } = useMe();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { toast } = useUi();
  if (!me || !biz) return null;
  const switchTo = async (id: string) => {
    await api.post("/api/businesses/switch", { id });
    setOpen(false);
    await refreshAll();
    router.push("/app");
  };
  return (
    <div className="px-3">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button className="flex w-full items-center gap-3 rounded-xl border border-line bg-raised px-3 py-2.5 text-start shadow-sm transition hover:border-line2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-sm font-semibold text-accentink">
              {biz.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{biz.name}</span>
              <span className="block text-xs text-ink3">{biz.is_demo ? "Demo data" : biz.currency.trim()}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-ink3" aria-hidden />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={8}
            className="z-50 w-64 rounded-2xl border border-line bg-raised p-1.5 shadow-lg"
          >
            <p className="eyebrow px-2.5 pb-1 pt-2">Workspaces</p>
            {me.businesses.map((b) => (
              <button
                key={b.id}
                onClick={() => switchTo(b.id)}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-sm hover:bg-sunken"
              >
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                {b.is_demo && <Badge tone="signal">Demo</Badge>}
                {b.id === biz.id && <Check className="size-4 text-accent" aria-label="Current" />}
              </button>
            ))}
            <div className="my-1.5 h-px bg-line" />
            <Link
              href="/onboarding?new=1"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm hover:bg-sunken"
            >
              <Plus className="size-4 text-accent" aria-hidden /> New business
            </Link>
            {!me.businesses.some((b) => b.is_demo) && (
              <button
                onClick={async () => {
                  try {
                    await api.post("/api/demo");
                    await refreshAll();
                    setOpen(false);
                    router.push("/app");
                  } catch {
                    toast({ title: "Could not create the demo workspace", tone: "error" });
                  }
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-sm hover:bg-sunken"
              >
                <WandSparkles className="size-4 text-accent" aria-hidden /> Explore a demo workspace
              </button>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/* * English ⇄ Egyptian Arabic. Remembered on this device and saved to the profile. */
export function LangToggle({ className }: { className?: string }) {
  const { locale, setLocale } = useUi();
  return (
    <button
      data-no-translate
      onClick={() => {
        const next = locale === "ar" ? "en" : "ar";
        setLocale(next);
        api.patch("/api/profile", { locale: next }).catch(() => {});
      }}
      className={clsx(
        "flex h-10 items-center rounded-xl border border-line bg-surface px-3 text-[13px] font-semibold text-ink2 transition hover:border-accent hover:text-ink",
        className,
      )}
      aria-label={locale === "ar" ? "Switch to English" : "التحويل للمصري"}
    >
      {locale === "ar" ? "English" : "مصري"}
    </button>
  );
}

function TopBar({
  onSearch,
  onAdd,
  canWrite,
  email,
  name,
}: {
  onSearch: () => void;
  onAdd: () => void;
  canWrite: boolean;
  email: string;
  name: string;
}) {
  const { me, biz } = useMe();
  const router = useRouter();
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-line bg-paper/85 px-4 backdrop-blur md:px-8">
      <Link href="/app" className="md:hidden" aria-label="Socio home">
        <Wordmark className="text-[1.4rem]" />
      </Link>
      <button
        onClick={onSearch}
        className="ms-auto flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm text-ink3 transition hover:border-line2 md:ms-0 md:w-80"
        aria-label="Search or jump to"
      >
        <Search className="size-4" aria-hidden />
        <span className="hidden md:inline">Search or jump to…</span>
        <kbd className="ms-auto hidden rounded-md border border-line bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink3 md:inline">
          ⌘K
        </kbd>
      </button>
      <div className="ms-auto hidden items-center gap-2 md:flex">
        <Button variant="primary" onClick={onAdd} disabled={!canWrite} title="Add transaction (N)">
          <Plus className="size-4" aria-hidden /> Add
        </Button>
      </div>
      <LangToggle />
      <Notifications />
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            aria-label="Account menu"
            className="flex size-10 items-center justify-center rounded-full bg-sunken text-sm font-semibold text-ink2 transition hover:ring-2 hover:ring-line2"
          >
            {(name || email).slice(0, 1).toUpperCase()}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={8}
            className="z-50 w-64 rounded-2xl border border-line bg-raised p-1.5 shadow-lg"
          >
            <div className="px-3 py-2">
              <p className="truncate text-sm font-medium text-ink">{name || "Your account"}</p>
              <p className="truncate text-xs text-ink3">{email}</p>
              {me && biz && <p className="mt-1 text-xs text-ink3">Role: {biz.role}</p>}
            </div>
            <div className="my-1 h-px bg-line" />
            <Link href="/app/settings" className="block rounded-xl px-3 py-2 text-sm hover:bg-sunken">
              Settings
            </Link>
            <Link href="/app/settings/integrations" className="block rounded-xl px-3 py-2 text-sm hover:bg-sunken">
              Integrations
            </Link>
            <button
              onClick={async () => {
                await api.post("/api/auth/logout");
                await refreshAll();
                router.replace("/login");
              }}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-start text-sm text-neg hover:bg-negsoft"
            >
              <LogOut className="size-4" aria-hidden /> Sign out
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </header>
  );
}

function Notifications() {
  const { data, mutate } = useSWR<{
    items: {
      id: string;
      severity: string;
      title: string;
      body: string;
      href: string | null;
      read_at: string | null;
      created_at: string;
    }[];
    unread: number;
  }>("/api/notifications", { refreshInterval: 60_000 });
  const router = useRouter();
  const unread = data?.unread ?? 0;
  const tone: Record<string, string> = { critical: "bg-neg", warning: "bg-warn", info: "bg-info", success: "bg-pos" };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
          className="relative flex size-10 items-center justify-center rounded-xl text-ink2 transition hover:bg-sunken hover:text-ink"
        >
          <Bell className="size-5" aria-hidden />
          {unread > 0 && (
            <span className="absolute end-1.5 top-1.5 flex min-w-4 items-center justify-center rounded-full bg-neg px-1 text-[10px] font-semibold leading-4 text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[min(24rem,calc(100vw-1.5rem))] rounded-2xl border border-line bg-raised shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="display text-lg">Notifications</p>
            {unread > 0 && (
              <button
                className="text-[13px] font-medium text-accent hover:underline"
                onClick={async () => {
                  await api.post("/api/notifications/read", { all: true });
                  mutate();
                }}
              >
                Mark all read
              </button>
            )}
          </div>
          <ul className="scroll-thin max-h-[26rem] overflow-y-auto p-1.5">
            {(data?.items ?? []).length === 0 && (
              <li className="px-3 py-8 text-center text-sm text-ink3">
                You are all caught up. Socio will flag budget, payment and cash risks here.
              </li>
            )}
            {(data?.items ?? []).map((n) => (
              <li key={n.id}>
                <button
                  className="flex w-full gap-3 rounded-xl px-3 py-2.5 text-start hover:bg-sunken"
                  onClick={async () => {
                    if (!n.read_at) await api.post("/api/notifications/read", { id: n.id });
                    mutate();
                    if (n.href) router.push(n.href);
                  }}
                >
                  <span
                    className={clsx(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      n.read_at ? "bg-line2" : (tone[n.severity] ?? "bg-info"),
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className={clsx("block text-sm", n.read_at ? "text-ink2" : "font-medium text-ink")}>
                      {n.title}
                    </span>
                    <span className="mt-0.5 block text-[13px] leading-snug text-ink3">{n.body}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CommandPalette({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdd: (p?: Partial<TxnDraft>) => void;
}) {
  const router = useRouter();
  const { t } = useUi();
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  const pages = NAV.filter((n): n is Extract<(typeof NAV)[number], { href: string }> => "href" in n);
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[90]">
          <motion.div
            className="absolute inset-0 bg-ink/40 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="absolute inset-x-3 top-[12vh] mx-auto max-w-xl overflow-hidden rounded-3xl border border-line bg-raised shadow-lg"
          >
            <Command label="Command menu" loop onKeyDown={(e) => e.key === "Escape" && onOpenChange(false)}>
              <div className="flex items-center gap-3 border-b border-line px-4">
                <Search className="size-4 text-ink3" aria-hidden />
                <Command.Input
                  autoFocus
                  value={q}
                  onValueChange={setQ}
                  placeholder="Jump to a page, add a record, look up a term…"
                  className="h-14 w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink3"
                />
                <button aria-label="Close" onClick={() => onOpenChange(false)} className="text-ink3">
                  <X className="size-4" />
                </button>
              </div>
              <Command.List className="scroll-thin max-h-[55vh] overflow-y-auto p-2">
                <Command.Empty className="px-3 py-8 text-center text-sm text-ink3">
                  No matches. Try asking the copilot below.
                </Command.Empty>
                <Command.Group
                  heading="Quick actions"
                  className="[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5"
                >
                  {[
                    { l: "Add an expense", i: ArrowUpRight, p: { type: "expense" as const } },
                    { l: "Add income", i: ArrowDownLeft, p: { type: "income" as const } },
                    { l: "Record a transfer", i: ArrowLeftRight, p: { type: "transfer" as const } },
                  ].map((a) => (
                    <Item
                      key={a.l}
                      onSelect={() => (onOpenChange(false), onAdd(a.p))}
                      icon={<a.i className="size-4" />}
                    >
                      {a.l}
                    </Item>
                  ))}
                </Command.Group>
                <Command.Group
                  heading="Go to"
                  className="[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5"
                >
                  {pages.map((p) => (
                    <Item key={p.href} onSelect={() => go(p.href)} icon={<p.icon className="size-4" />}>
                      {t(p.key)}
                    </Item>
                  ))}
                  <Item onSelect={() => go("/app/settings")} icon={<Settings className="size-4" />}>
                    {t("nav.settings")}
                  </Item>
                  <Item
                    onSelect={() => go("/app/settings/integrations")}
                    icon={<CircleDollarSign className="size-4" />}
                  >
                    Integrations
                  </Item>
                </Command.Group>
                <Command.Group
                  heading="Learn a term"
                  className="[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5"
                >
                  {Object.entries(GLOSSARY).map(([k, e]) => (
                    <Item
                      key={k}
                      value={`${e.term} ${e.question}`}
                      onSelect={() => go(`/app/learn#${k}`)}
                      icon={<BookOpen className="size-4" />}
                    >
                      <span>{e.term}</span> <span className="text-ink3">— {e.question}</span>
                    </Item>
                  ))}
                </Command.Group>
                {q.trim().length > 2 && (
                  <Command.Group
                    heading="Ask the copilot"
                    className="[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5"
                  >
                    <Item
                      forceMount
                      value={`ask ${q}`}
                      onSelect={() => go(`/app/ask?q=${encodeURIComponent(q)}`)}
                      icon={<Sparkles className="size-4" />}
                    >
                      Ask: “{q}”
                    </Item>
                  </Command.Group>
                )}
              </Command.List>
            </Command>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function Item({
  children,
  icon,
  onSelect,
  value,
  forceMount,
}: {
  children: ReactNode;
  icon: ReactNode;
  onSelect: () => void;
  value?: string;
  forceMount?: boolean;
}) {
  return (
    <Command.Item
      value={value}
      forceMount={forceMount}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink data-[selected=true]:bg-sunken"
    >
      <span className="text-accent">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Command.Item>
  );
}

export function SuspenseBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
export { useSearchParams, BarChart3 };
