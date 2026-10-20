"use client";
import { motion } from "motion/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "./shell";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grain relative grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="relative z-10 flex flex-col px-6 py-8 sm:px-12">
        <Link href="/" aria-label="Socio home" className="w-fit">
          <Wordmark />
        </Link>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <h1 className="display text-[2.4rem] leading-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-[15px] leading-relaxed text-ink2">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-6 text-sm text-ink2">{footer}</div>}
        </div>
        <p className="text-xs text-ink3">© {new Date().getFullYear()} Socio</p>
      </div>
      <div className="relative z-10 hidden overflow-hidden bg-accent text-accentink lg:block">
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 10%, rgba(216,242,90,.55), transparent 40%), radial-gradient(circle at 90% 90%, rgba(255,255,255,.25), transparent 45%)",
          }}
        />
        <div className="relative flex h-full flex-col justify-between p-14">
          <p className="eyebrow text-accentink/70">Know what your business keeps</p>
          <div>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7 }}
              className="display text-[3.4rem] leading-[1.02]"
            >
              Sales are a number.
              <br />
              <span className="bg-signal px-2 text-signalink">Margin</span> is the truth.
            </motion.p>
            <ul className="mt-10 space-y-4 text-[15px] text-accentink/85">
              {[
                "Profit, cash and budgets in plain language",
                "Every figure traced to your own records",
                "Test a hire or an order before you commit",
              ].map((t, i) => (
                <motion.li
                  key={t}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3 + i * 0.12 }}
                  className="flex items-center gap-3"
                >
                  <span className="size-1.5 rounded-full bg-signal" /> {t}
                </motion.li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-accentink/60">Socio never moves money. It helps you understand it.</p>
        </div>
      </div>
    </div>
  );
}
