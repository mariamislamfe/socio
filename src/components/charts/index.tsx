"use client";
import clsx from "clsx";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatMoney } from "@/lib/finance/money";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((e) => setW(Math.floor(e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceTicks(min: number, max: number, n = 4): number[] {
  if (min === max) {
    max = min + 1;
  }
  const span = max - min;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  // Always end on a tick at or above the maximum, otherwise the top of the line is drawn outside the plot.
  for (let v = start; ; v += step) {
    out.push(Math.round(v * 1e6) / 1e6);
    if (v >= max - step * 1e-9) break;
  }
  return out;
}

const shortDate = (d: string) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });

// Line / area (balances over time)
export interface Pt {
  date: string;
  value: number;
}
export function AreaLine({
  series,
  compare,
  currency,
  height = 260,
  markers = [],
  label,
  projectedFrom,
  compareLabel = "Scenario",
  seriesLabel = "Baseline",
  threshold,
}: {
  series: Pt[];
  compare?: Pt[];
  currency: string;
  height?: number;
  markers?: { date: string; label: string; amount: number }[];
  label: string;
  projectedFrom?: string;
  /* * Draws a dashed line, e.g. the safety reserve. */
  threshold?: number;
  compareLabel?: string;
  seriesLabel?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 56, r: 12, t: 12, b: 26 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const all = [...series, ...(compare ?? [])].map((p) => p.value).concat(threshold !== undefined ? [threshold] : []);
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const ticks = niceTicks(lo, hi, 4);
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const x = (i: number) => pad.l + (series.length <= 1 ? 0 : (i / (series.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  const path = (pts: Pt[]) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${path(series)} L${x(series.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const idxToDate = (i: number) => series[Math.max(0, Math.min(series.length - 1, i))]?.date;
  const gid = useMemo(() => `g${Math.random().toString(36).slice(2, 8)}`, []);

  const onMove = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect();
    const rel = (clientX - r.left - pad.l) / iw;
    setHover(Math.max(0, Math.min(series.length - 1, Math.round(rel * (series.length - 1)))));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") setHover((h) => Math.min(series.length - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? series.length) - 1));
    else if (e.key === "Escape") setHover(null);
  };
  const h = hover !== null ? series[hover] : null;
  const hc = hover !== null && compare ? compare[hover] : null;
  const dayMarkers = markers.filter((m) => h && m.date === h.date);
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (series.length - 1)));
  const projX = projectedFrom ? series.findIndex((p) => p.date > projectedFrom) : -1;

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {w > 0 && (
        <svg
          width={w}
          height={height}
          role="img"
          aria-label={`${label}. ${series.length ? `From ${formatMoney(series[0].value, currency)} to ${formatMoney(series[series.length - 1].value, currency)}.` : "No data."} Use arrow keys to inspect values.`}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          onPointerMove={(e) => onMove(e.clientX, e.currentTarget)}
          onPointerLeave={() => setHover(null)}
          className="touch-pan-y overflow-visible rounded-lg outline-offset-4"
        >
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.26" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
            <clipPath id={`${gid}-neg`}>
              <rect x={pad.l} y={y(0)} width={iw} height={Math.max(0, pad.t + ih - y(0))} />
            </clipPath>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.l}
                x2={pad.l + iw}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--line)"
                strokeDasharray={t === 0 ? undefined : "2 4"}
                strokeWidth={t === 0 ? 1.25 : 1}
              />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="num fill-ink3 text-[11px]">
                {formatMoney(t, currency, { compact: true, hideCurrency: true })}
              </text>
            </g>
          ))}
          {threshold !== undefined && (
            <g>
              <line
                x1={pad.l}
                x2={pad.l + iw}
                y1={y(threshold)}
                y2={y(threshold)}
                stroke="var(--warn)"
                strokeDasharray="6 4"
                strokeWidth={1.5}
              />
              <text x={pad.l + iw} y={y(threshold) - 5} textAnchor="end" className="fill-warn text-[11px]">
                Safety reserve
              </text>
            </g>
          )}
          {y0 < 0 && (
            <rect
              x={pad.l}
              y={y(0)}
              width={iw}
              height={Math.max(0, pad.t + ih - y(0))}
              fill="var(--neg)"
              opacity={0.06}
            />
          )}
          {xLabels.map((i, k) => (
            <text
              key={i}
              x={x(i)}
              y={height - 6}
              textAnchor={k === 0 ? "start" : k === xLabels.length - 1 ? "end" : "middle"}
              className="fill-ink3 text-[11px]"
            >
              {idxToDate(i) ? shortDate(idxToDate(i)) : ""}
            </text>
          ))}
          {projX > 0 && (
            <rect
              x={x(projX)}
              y={pad.t}
              width={Math.max(0, pad.l + iw - x(projX))}
              height={ih}
              fill="var(--info)"
              opacity={0.045}
            />
          )}
          <motion.path
            d={area}
            fill={`url(#${gid})`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6 }}
          />
          <motion.path
            d={path(series)}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2.25}
            strokeLinejoin="round"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, ease: "easeOut" }}
          />
          {series.length > 1 && (
            <path
              d={path(series)}
              fill="none"
              stroke="var(--neg)"
              strokeWidth={2.25}
              strokeLinejoin="round"
              clipPath={`url(#${gid}-neg)`}
            />
          )}
          {compare && compare.length > 1 && (
            <motion.path
              d={path(compare)}
              fill="none"
              stroke="var(--signal)"
              strokeWidth={2.25}
              strokeDasharray="6 5"
              strokeLinecap="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.9 }}
              style={{ filter: "drop-shadow(0 0 0 var(--signal-ink))" }}
            />
          )}
          {markers.map((m, i) => {
            const idx = series.findIndex((p) => p.date === m.date);
            if (idx < 0) return null;
            return (
              <circle
                key={i}
                cx={x(idx)}
                cy={y(series[idx].value)}
                r={3.5}
                fill={m.amount < 0 ? "var(--neg)" : "var(--pos)"}
                stroke="var(--surface)"
                strokeWidth={1.5}
              />
            );
          })}
          {h && hover !== null && (
            <g pointerEvents="none">
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={pad.t}
                y2={pad.t + ih}
                stroke="var(--ink-3)"
                strokeDasharray="3 3"
              />
              <circle
                cx={x(hover)}
                cy={y(h.value)}
                r={5}
                fill="var(--accent)"
                stroke="var(--surface)"
                strokeWidth={2}
              />
              {hc && (
                <circle
                  cx={x(hover)}
                  cy={y(hc.value)}
                  r={5}
                  fill="var(--signal)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              )}
            </g>
          )}
        </svg>
      )}
      {h && hover !== null && w > 0 && (
        <div
          className="pointer-events-none absolute z-10 w-52 rounded-xl border border-line bg-raised px-3 py-2 text-xs shadow-md"
          style={{ left: Math.min(Math.max(8, x(hover) - 104), Math.max(8, w - 216)), top: 4 }}
        >
          <p className="eyebrow">
            {shortDate(h.date)}
            {projectedFrom && h.date > projectedFrom ? " · projected" : ""}
          </p>
          <p className="mt-1 flex items-center justify-between gap-2">
            <span className="text-ink2">{compare ? seriesLabel : "Balance"}</span>
            <span className={clsx("num font-medium", h.value < 0 ? "text-neg" : "text-ink")}>
              {formatMoney(h.value, currency)}
            </span>
          </p>
          {hc && (
            <p className="flex items-center justify-between gap-2">
              <span className="text-ink2">{compareLabel}</span>
              <span className={clsx("num font-medium", hc.value < 0 ? "text-neg" : "text-ink")}>
                {formatMoney(hc.value, currency)}
              </span>
            </p>
          )}
          {dayMarkers.map((m, i) => (
            <p key={i} className="mt-1 flex justify-between gap-2 border-t border-line pt-1 text-ink2">
              <span className="truncate">{m.label}</span>
              <span className={clsx("num", m.amount < 0 ? "text-neg" : "text-pos")}>
                {formatMoney(m.amount, currency, { sign: true })}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// Grouped bars (revenue vs expenses)
export interface BarDatum {
  label: string;
  from: string;
  revenue: number;
  expenses: number;
  profit: number;
  future?: boolean;
}
export function RevenueBars({
  data,
  currency,
  height = 240,
  label,
}: {
  data: BarDatum[];
  currency: string;
  height?: number;
  label: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 50, r: 6, t: 10, b: 24 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const max = Math.max(1, ...data.map((d) => Math.max(d.revenue, d.expenses)));
  const ticks = niceTicks(0, max, 3);
  const top = ticks[ticks.length - 1];
  const band = iw / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(18, band * 0.34));
  const y = (v: number) => pad.t + ih - (Math.max(0, v) / top) * ih;
  const every = Math.ceil(data.length / Math.max(2, Math.floor(iw / 44)));
  const hd = hover !== null ? data[hover] : null;
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {w > 0 && (
        <svg
          width={w}
          height={height}
          role="img"
          aria-label={label}
          onPointerLeave={() => setHover(null)}
          className="overflow-visible"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.l}
                x2={pad.l + iw}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--line)"
                strokeDasharray={t === 0 ? undefined : "2 4"}
              />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="num fill-ink3 text-[11px]">
                {formatMoney(t, currency, { compact: true, hideCurrency: true })}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = pad.l + band * i + band / 2;
            return (
              <g key={i} onPointerEnter={() => setHover(i)} onPointerMove={() => setHover(i)}>
                <rect x={pad.l + band * i} y={pad.t} width={band} height={ih + 4} fill="transparent" />
                {hover === i && (
                  <rect
                    x={pad.l + band * i + 1}
                    y={pad.t}
                    width={band - 2}
                    height={ih}
                    rx={6}
                    fill="var(--sunken)"
                    opacity={0.7}
                  />
                )}
                <motion.rect
                  x={cx - bw - 1}
                  width={bw}
                  rx={Math.min(4, bw / 2)}
                  fill={d.future ? "var(--line-strong)" : "var(--accent)"}
                  initial={{ y: y(0), height: 0 }}
                  animate={{ y: y(d.revenue), height: Math.max(0, y(0) - y(d.revenue)) }}
                  transition={{ type: "spring", stiffness: 140, damping: 22, delay: Math.min(i * 0.008, 0.3) }}
                />
                <motion.rect
                  x={cx + 1}
                  width={bw}
                  rx={Math.min(4, bw / 2)}
                  fill="var(--ink-3)"
                  opacity={0.55}
                  initial={{ y: y(0), height: 0 }}
                  animate={{ y: y(d.expenses), height: Math.max(0, y(0) - y(d.expenses)) }}
                  transition={{ type: "spring", stiffness: 140, damping: 22, delay: Math.min(i * 0.008 + 0.04, 0.34) }}
                />
                {i % every === 0 && (
                  <text x={cx} y={height - 6} textAnchor="middle" className="fill-ink3 text-[11px]">
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {hd && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 w-48 rounded-xl border border-line bg-raised px-3 py-2 text-xs shadow-md"
          style={{ left: Math.min(Math.max(4, pad.l + band * hover + band / 2 - 96), Math.max(4, w - 196)), top: 0 }}
        >
          <p className="eyebrow">{hd.from}</p>
          <p className="mt-1 flex justify-between">
            <span className="text-ink2">Revenue</span>
            <span className="num font-medium">{formatMoney(hd.revenue, currency)}</span>
          </p>
          <p className="flex justify-between">
            <span className="text-ink2">Expenses</span>
            <span className="num font-medium">{formatMoney(hd.expenses, currency)}</span>
          </p>
          <p className="mt-1 flex justify-between border-t border-line pt-1">
            <span className="text-ink2">Result</span>
            <span className={clsx("num font-medium", hd.profit < 0 ? "text-neg" : "text-pos")}>
              {formatMoney(hd.profit, currency, { sign: true })}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}

// Sparkline
export function Sparkline({
  values,
  className,
  tone = "accent",
}: {
  values: number[];
  className?: string;
  tone?: "accent" | "neg" | "ink";
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${100 - ((v - min) / (max - min || 1)) * 100}`);
  const c = { accent: "var(--accent)", neg: "var(--neg)", ink: "var(--ink-2)" }[tone];
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={clsx("h-8 w-24", className)} aria-hidden>
      <motion.polyline
        points={pts.join(" ")}
        fill="none"
        stroke={c}
        strokeWidth={3}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.8 }}
      />
    </svg>
  );
}

// Composition bar (expense breakdown)
export function CompositionBar({
  slices,
  total,
  currency,
}: {
  slices: { id: string; name: string; color: string; amount: number }[];
  total: number;
  currency: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  if (total <= 0 || !slices.length) return null;
  return (
    <div>
      <div
        className="flex h-3 w-full gap-[3px] overflow-hidden rounded-full"
        role="img"
        aria-label="Expense breakdown by category"
      >
        {slices.map((s, i) => (
          <motion.div
            key={s.id}
            onPointerEnter={() => setHover(s.id)}
            onPointerLeave={() => setHover(null)}
            className="h-full rounded-[3px] first:rounded-s-full last:rounded-e-full"
            style={{ background: s.color, opacity: hover && hover !== s.id ? 0.35 : 1 }}
            initial={{ width: 0 }}
            animate={{ width: `${(s.amount / total) * 100}%` }}
            transition={{ type: "spring", stiffness: 110, damping: 20, delay: i * 0.04 }}
          />
        ))}
      </div>
      <ul className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {slices.slice(0, 8).map((s) => (
          <li
            key={s.id}
            onPointerEnter={() => setHover(s.id)}
            onPointerLeave={() => setHover(null)}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="truncate text-ink2">{s.name}</span>
            </span>
            <span className="num shrink-0 text-ink">
              {formatMoney(s.amount, currency, { compact: true })}{" "}
              <span className="text-ink3">· {Math.round((s.amount / total) * 100)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
