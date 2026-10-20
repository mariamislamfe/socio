"use client";
import { AlertTriangle, CheckCircle2, ChevronDown, Info, OctagonAlert, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@/lib/client/api";
import { refreshAll } from "@/lib/client/hooks";
import { clsx } from "../ui";

export interface InsightData {
  key: string;
  severity: "info" | "warning" | "critical" | "positive";
  topic: string;
  title: string;
  observed: string;
  evidence: { label: string; value: string }[];
  why: string;
  action: { label: string; href: string };
  assumptions: string[];
}

const SEV = {
  critical: { icon: OctagonAlert, bar: "bg-neg", tint: "text-neg", label: "Needs attention" },
  warning: { icon: AlertTriangle, bar: "bg-warn", tint: "text-warn", label: "Worth a look" },
  info: { icon: Info, bar: "bg-info", tint: "text-info", label: "Good to know" },
  positive: { icon: CheckCircle2, bar: "bg-pos", tint: "text-pos", label: "On track" },
};

/* * An insight always shows what was observed, the supporting figures, why it matters, and what to do. */
export function InsightItem({ i, compact }: { i: InsightData; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);
  const s = SEV[i.severity];
  const Icon = s.icon;
  return (
    <AnimatePresence initial={false}>
      {!gone && (
        <motion.li
          layout
          exit={{ opacity: 0, height: 0, marginTop: 0 }}
          transition={{ duration: 0.22 }}
          className="relative overflow-hidden rounded-2xl border border-line bg-raised"
        >
          <span aria-hidden className={clsx("absolute inset-y-0 start-0 w-1", s.bar)} />
          <div className="py-4 ps-5 pe-4">
            <div className="flex items-start gap-3">
              <Icon className={clsx("mt-0.5 size-5 shrink-0", s.tint)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="eyebrow">{s.label}</p>
                <h3 className="mt-0.5 text-[15px] font-semibold leading-snug text-ink">{i.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink2">{i.observed}</p>
                {!compact && (
                  <>
                    <button
                      onClick={() => setOpen((o) => !o)}
                      aria-expanded={open}
                      className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-accent"
                    >
                      {open ? "Hide the details" : "Show the numbers behind this"}
                      <ChevronDown className={clsx("size-4 transition", open && "rotate-180")} aria-hidden />
                    </button>
                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="mt-3 space-y-3 rounded-xl bg-sunken p-3.5 text-[13px]">
                            {i.evidence.length > 0 && (
                              <dl className="space-y-1.5">
                                {i.evidence.map((e, k) => (
                                  <div key={k} className="flex justify-between gap-4">
                                    <dt className="text-ink2">{e.label}</dt>
                                    <dd className="num text-end font-medium text-ink">{e.value}</dd>
                                  </div>
                                ))}
                              </dl>
                            )}
                            <p>
                              <span className="font-medium text-ink">Why it matters. </span>
                              <span className="text-ink2">{i.why}</span>
                            </p>
                            {i.assumptions.length > 0 && (
                              <p>
                                <span className="font-medium text-ink">Assumptions &amp; limits. </span>
                                <span className="text-ink2">{i.assumptions.join(" ")}</span>
                              </p>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Link
                    href={i.action.href}
                    className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[13px] font-medium text-accentink transition hover:brightness-110 active:scale-[0.97]"
                  >
                    {i.action.label}
                  </Link>
                  <button
                    onClick={async () => {
                      setGone(true);
                      await api.post("/api/insights/dismiss", { key: i.key });
                      refreshAll();
                    }}
                    className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[13px] text-ink3 transition hover:bg-sunken hover:text-ink"
                  >
                    <X className="size-3.5" aria-hidden /> Dismiss
                  </button>
                </div>
              </div>
            </div>
          </div>
        </motion.li>
      )}
    </AnimatePresence>
  );
}
