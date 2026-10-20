"use client";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";
import { AnimatePresence, animate, motion } from "motion/react";
import { Info, Loader2, X } from "lucide-react";
import Link from "next/link";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { GLOSSARY } from "@/lib/glossary";
import { formatMoney } from "@/lib/finance/money";

export { clsx };

// Button
type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "signal";
type BtnSize = "sm" | "md" | "lg";
const BTN: Record<BtnVariant, string> = {
  primary: "bg-accent text-accentink hover:brightness-110 shadow-sm",
  secondary: "bg-raised text-ink border border-line hover:border-line2 hover:bg-surface shadow-sm",
  ghost: "text-ink2 hover:bg-sunken hover:text-ink",
  danger: "bg-negsoft text-neg border border-transparent hover:brightness-95",
  signal: "bg-signal text-signalink hover:brightness-105 shadow-sm font-semibold",
};
const SZ: Record<BtnSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-[15px] gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: BtnSize;
  loading?: boolean;
  href?: string;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, className, children, href, disabled, ...rest },
  ref,
) {
  const cls = clsx(
    "relative inline-flex select-none items-center justify-center whitespace-nowrap rounded-xl font-medium transition active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
    BTN[variant],
    SZ[size],
    className,
  );
  if (href && !disabled) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button ref={ref} className={cls} disabled={disabled || loading} {...rest}>
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={clsx(
        "inline-flex size-9 items-center justify-center rounded-xl text-ink2 transition hover:bg-sunken hover:text-ink active:scale-95",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// Fields
const fieldBase =
  "w-full rounded-xl border bg-raised px-3.5 text-[15px] text-ink placeholder:text-ink3 transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={clsx("block", className)}>
      {label && (
        <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-ink2">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p role="alert" className="mt-1.5 text-[13px] text-neg">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-[13px] text-ink3">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={clsx(fieldBase, "h-11", invalid ? "border-neg" : "border-line", className)}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ className, invalid, children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={clsx(
          fieldBase,
          "h-11 appearance-none bg-[length:16px] bg-[right_12px_center] bg-no-repeat pe-9",
          invalid ? "border-neg" : "border-line",
          className,
        )}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2378837c' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>\")",
        }}
        {...rest}
      >
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={clsx(fieldBase, "min-h-20 border-line py-2.5", className)} {...rest} />;
});

/* * Amount input that works in major units (what people type) and reports integer minor units. */
export function MoneyInput({
  value,
  onChange,
  currency,
  digits = 2,
  id,
  invalid,
  placeholder = "0.00",
  autoFocus,
}: {
  value: number | null;
  onChange: (minor: number | null) => void;
  currency: string;
  digits?: number;
  id?: string;
  invalid?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(() => (value ? String(value / 10 ** digits) : ""));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value ? String(value / 10 ** digits) : "");
    }
  }, [value, digits]);
  return (
    <div
      className={clsx(
        "flex h-11 items-center overflow-hidden rounded-xl border bg-raised transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20",
        invalid ? "border-neg" : "border-line",
      )}
    >
      <span className="select-none ps-3.5 pe-2 text-sm font-medium text-ink3">{currency}</span>
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        value={text}
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d.,]/g, "");
          setText(v);
          const clean = v.replace(/,/g, "");
          if (clean === "" || clean === ".") {
            last.current = null;
            onChange(null);
            return;
          }
          const [w, f = ""] = clean.split(".");
          if (f.length > digits) return;
          const minor = Number(w + f.padEnd(digits, "0"));
          last.current = Number.isSafeInteger(minor) ? minor : null;
          onChange(Number.isSafeInteger(minor) ? minor : null);
        }}
        className="num h-full min-w-0 flex-1 bg-transparent pe-3.5 text-[15px] text-ink outline-none placeholder:text-ink3"
      />
    </div>
  );
}

// Surfaces
export function Card({
  className,
  children,
  ...rest
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx("min-w-0 rounded-2xl border border-line bg-surface shadow-sm", className)} {...rest}>
      {children}
    </div>
  );
}

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: "neutral" | "pos" | "neg" | "warn" | "info" | "accent" | "signal";
  children: ReactNode;
  className?: string;
}) {
  const t = {
    neutral: "bg-sunken text-ink2",
    pos: "bg-possoft text-pos",
    neg: "bg-negsoft text-neg",
    warn: "bg-warnsoft text-warn",
    info: "bg-infosoft text-info",
    accent: "bg-accentsoft text-accent",
    signal: "bg-signal text-signalink",
  }[tone];
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium",
        t,
        className,
      )}
    >
      {children}
    </span>
  );
}

/* * Marks a figure as actual / projected / estimated / incomplete so users never mistake one for another. */
export function DataLabel({ kind }: { kind: "actual" | "projected" | "estimated" | "incomplete" }) {
  const m = {
    actual: { tone: "neutral" as const, text: "Actual" },
    projected: { tone: "info" as const, text: "Projected" },
    estimated: { tone: "warn" as const, text: "Estimated" },
    incomplete: { tone: "warn" as const, text: "Incomplete" },
  }[kind];
  return <Badge tone={m.tone}>{m.text}</Badge>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx("skeleton", className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-label="Loading" className={clsx("animate-spin text-ink3", className)} />;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line2 px-6 py-12 text-center">
      {icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-accentsoft text-accent">
          {icon}
        </div>
      )}
      <h3 className="display text-xl text-ink">{title}</h3>
      <p className="mt-2 max-w-md text-[15px] leading-relaxed text-ink2">{body}</p>
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Progress({
  value,
  tone = "accent",
  className,
  label,
}: {
  value: number;
  tone?: "accent" | "warn" | "neg" | "pos";
  className?: string;
  label?: string;
}) {
  const v = Math.max(0, Math.min(1, value));
  const bg = { accent: "bg-accent", warn: "bg-warn", neg: "bg-neg", pos: "bg-pos" }[tone];
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(v * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={clsx("h-2 w-full overflow-hidden rounded-full bg-sunken", className)}
    >
      <motion.div
        className={clsx("h-full rounded-full", bg)}
        initial={{ width: 0 }}
        animate={{ width: `${v * 100}%` }}
        transition={{ type: "spring", stiffness: 120, damping: 24 }}
      />
    </div>
  );
}

// Segmented / Tabs
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  label: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div
      role="tablist"
      aria-label={label}
      className={clsx("relative inline-flex rounded-xl border border-line bg-sunken p-1", className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={clsx(
              "relative z-10 h-8 rounded-lg px-3 text-[13px] font-medium transition-colors",
              active ? "text-ink" : "text-ink3 hover:text-ink2",
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 -z-10 rounded-lg bg-raised shadow-sm"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: string; count?: number }[];
}) {
  const id = useId();
  return (
    <div role="tablist" className="scroll-thin flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={clsx(
              "relative whitespace-nowrap px-3.5 py-2.5 text-sm font-medium transition-colors",
              active ? "text-ink" : "text-ink3 hover:text-ink2",
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="ms-1.5 rounded-full bg-sunken px-1.5 py-0.5 text-[11px] text-ink2">{t.count}</span>
            )}
            {active && (
              <motion.span
                layoutId={`tab-${id}`}
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// Modal
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  size = "md",
  footer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
  footer?: ReactNode;
}) {
  const w = { sm: "sm:max-w-md", md: "sm:max-w-xl", lg: "sm:max-w-3xl" }[size];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-[3px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={description ? undefined : undefined}>
              <motion.div
                className={clsx(
                  "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-3xl border border-line bg-surface shadow-lg sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[calc(100%-2rem)] sm:rounded-3xl",
                  w,
                )}
                initial={{ opacity: 0, y: 32, scale: 0.98, x: 0 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 380, damping: 34 }}
              >
                <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
                  <div>
                    <Dialog.Title className="display text-xl text-ink">{title}</Dialog.Title>
                    {description ? (
                      <Dialog.Description className="mt-1 text-sm text-ink2">{description}</Dialog.Description>
                    ) : (
                      <Dialog.Description className="sr-only">{title}</Dialog.Description>
                    )}
                  </div>
                  <Dialog.Close asChild>
                    <IconButton label="Close" className="-me-2 -mt-1">
                      <X className="size-5" />
                    </IconButton>
                  </Dialog.Close>
                </div>
                <div className="scroll-thin overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
                {footer && (
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4 sm:px-6">
                    {footer}
                  </div>
                )}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = "Delete",
  onConfirm,
  tone = "danger",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
  tone?: "danger" | "primary";
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-[15px] leading-relaxed text-ink2">{body}</p>
    </Modal>
  );
}

// Numbers
export function useReducedMotion(): boolean {
  const [r, setR] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setR(m.matches);
    const f = () => setR(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return r;
}

/* * Smoothly tweens between numeric values. Text is rendered from the real value, so it is accessible and SSR-safe. */
export function AnimatedNumber({
  value,
  format,
  className,
  duration = 0.8,
}: {
  value: number;
  format: (v: number) => string;
  className?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);
  const fmt = useRef(format);
  fmt.current = format;
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced || prev.current === value) {
      el.textContent = fmt.current(value);
      prev.current = value;
      return;
    }
    const ctl = animate(prev.current, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => (el.textContent = fmt.current(v)),
    });
    prev.current = value;
    return () => ctl.stop();
  }, [value, duration, reduced]);
  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  );
}

export function Money({
  value,
  currency,
  compact,
  sign,
  className,
  animate: anim = true,
  hideCurrency,
}: {
  value: number;
  currency: string;
  compact?: boolean;
  sign?: boolean;
  className?: string;
  animate?: boolean;
  hideCurrency?: boolean;
}) {
  const f = useCallback(
    (v: number) => formatMoney(Math.round(v), currency, { compact, sign, hideCurrency }),
    [currency, compact, sign, hideCurrency],
  );
  if (!anim) return <span className={clsx("num", className)}>{f(value)}</span>;
  return <AnimatedNumber value={value} format={f} className={clsx("num", className)} />;
}

// Glossary hint
/* * Info icon beside a metric. Opens on hover, keyboard focus and tap. */
export function Hint({ k, className, label }: { k: string; className?: string; label?: string }) {
  const e = GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => timer.current && clearTimeout(timer.current);
  if (!e) return null;
  const hoverOpen = () => {
    clear();
    timer.current = setTimeout(() => setOpen(true), 120);
  };
  const hoverClose = () => {
    clear();
    timer.current = setTimeout(() => setOpen(false), 160);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label ?? `What is ${e.term.toLowerCase()}?`}
          onPointerEnter={(ev) => ev.pointerType === "mouse" && hoverOpen()}
          onPointerLeave={(ev) => ev.pointerType === "mouse" && hoverClose()}
          className={clsx(
            "inline-flex size-[18px] shrink-0 items-center justify-center rounded-full text-ink3 transition hover:bg-sunken hover:text-accent",
            className,
          )}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onPointerEnter={clear}
          onPointerLeave={hoverClose}
          onOpenAutoFocus={(ev) => ev.preventDefault()}
          className="z-[60] w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl border border-line bg-raised p-4 text-left shadow-lg data-[state=open]:animate-in"
        >
          <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
            <p className="eyebrow">{e.term}</p>
            <p className="display mt-1 text-lg leading-snug text-ink">“{e.question}”</p>
            <dl className="mt-3 space-y-2.5 text-[13px] leading-relaxed">
              <div>
                <dt className="font-medium text-ink">What it is</dt>
                <dd className="text-ink2">{e.definition}</dd>
              </div>
              <div>
                <dt className="font-medium text-ink">Why it matters</dt>
                <dd className="text-ink2">{e.why}</dd>
              </div>
              <div>
                <dt className="font-medium text-ink">How Socio calculates it</dt>
                <dd className="text-ink2">{e.how}</dd>
              </div>
              {e.example && (
                <div>
                  <dt className="font-medium text-ink">Example</dt>
                  <dd className="text-ink2">{e.example}</dd>
                </div>
              )}
            </dl>
            <Link
              href={`/app/learn#${k}`}
              className="mt-3 inline-block text-[13px] font-medium text-accent hover:underline"
              onClick={() => setOpen(false)}
            >
              Learn more →
            </Link>
          </motion.div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/* * Metric label with its professional term, info hint and the friendly question underneath. */
export function MetricLabel({
  k,
  question = true,
  className,
  term,
}: {
  k: string;
  question?: boolean;
  className?: string;
  term?: string;
}) {
  const e = GLOSSARY[k];
  return (
    <div className={className}>
      <div className="flex items-center gap-1">
        <span className="eyebrow">{term ?? e?.term ?? k}</span>
        <Hint k={k} />
      </div>
      {question && e && <p className="mt-0.5 text-[13px] text-ink3">{e.question}</p>}
    </div>
  );
}

// Misc
export function Delta({
  now,
  before,
  currency,
  invert,
  className,
}: {
  now: number;
  before: number;
  currency?: string;
  invert?: boolean;
  className?: string;
}) {
  if (before === 0 && now === 0) return null;
  const diff = now - before;
  const up = diff > 0;
  const good = invert ? !up : up;
  const pct = before !== 0 ? Math.round((diff / Math.abs(before)) * 100) : null;
  if (diff === 0) return <span className={clsx("text-xs text-ink3", className)}>No change vs. last period</span>;
  return (
    <span
      className={clsx("inline-flex items-center gap-1 text-xs font-medium", good ? "text-pos" : "text-neg", className)}
    >
      <span aria-hidden>{up ? "▲" : "▼"}</span>
      {pct !== null ? `${Math.abs(pct)}%` : currency ? formatMoney(Math.abs(diff), currency, { compact: true }) : ""}
      <span className="font-normal text-ink3">vs. same days last period</span>
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
        <h1 className="display text-[2rem] leading-tight text-ink sm:text-[2.4rem]">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-ink2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-neg/30 bg-negsoft px-4 py-3 text-sm text-neg"
    >
      <span>{msg}</span>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
