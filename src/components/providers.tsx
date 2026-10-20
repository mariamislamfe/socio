"use client";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { fetcher } from "@/lib/client/api";
import { translate, type Locale, type MessageKey } from "@/lib/i18n";

type Tone = "success" | "error" | "info" | "warning";
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: Tone;
}
interface UiCtx {
  toast: (t: { title: string; description?: string; tone?: Tone }) => void;
  theme: "light" | "dark" | "system";
  setTheme: (t: "light" | "dark" | "system") => void;
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (k: MessageKey) => string;
}
const Ctx = createContext<UiCtx | null>(null);
export const useUi = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useUi outside Providers");
  return c;
};

const ICON = { success: CheckCircle2, error: XCircle, info: Info, warning: TriangleAlert };
const TONE = { success: "text-pos", error: "text-neg", info: "text-info", warning: "text-warn" };

export function Providers({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [theme, setThemeState] = useState<UiCtx["theme"]>("system");
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    try {
      const t = localStorage.getItem("margin-theme");
      if (t === "light" || t === "dark") setThemeState(t);
      if (localStorage.getItem("margin-locale") === "ar") setLocaleState("ar");
    } catch {
      /* storage unavailable: defaults apply */
    }
  }, []);

  const setTheme = useCallback((t: UiCtx["theme"]) => {
    setThemeState(t);
    try {
      if (t === "system") {
        localStorage.removeItem("margin-theme");
        delete document.documentElement.dataset.theme;
      } else {
        localStorage.setItem("margin-theme", t);
        document.documentElement.dataset.theme = t;
      }
    } catch {
      /* ignore */
    }
  }, []);

  const setLocale = useCallback((l: Locale) => {
    // Leaving Egyptian Arabic: reload so every translated text returns to its original English.
    const leaving = document.documentElement.lang === "ar" && l !== "ar";
    setLocaleState(l);
    document.documentElement.lang = l;
    document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
    try {
      localStorage.setItem("margin-locale", l);
    } catch {
      /* ignore */
    }
    if (leaving) location.reload();
  }, []);

  const toast = useCallback<UiCtx["toast"]>((t) => {
    const id = Date.now() + Math.random();
    setToasts((s) => [...s.slice(-3), { id, title: t.title, description: t.description, tone: t.tone ?? "success" }]);
    setTimeout(() => setToasts((s) => s.filter((x) => x.id !== id)), t.tone === "error" ? 7000 : 4200);
  }, []);

  const value = useMemo<UiCtx>(
    () => ({ toast, theme, setTheme, locale, setLocale, t: (k) => translate(locale, k) }),
    [toast, theme, setTheme, locale, setLocale],
  );

  return (
    <Ctx.Provider value={value}>
      <SWRConfig value={{ fetcher, revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 1500 }}>
        {children}
      </SWRConfig>
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[100] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:items-end sm:pe-6"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const I = ICON[t.tone];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-line bg-raised px-4 py-3 shadow-md"
              >
                <I className={`mt-0.5 size-5 shrink-0 ${TONE[t.tone]}`} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{t.title}</p>
                  {t.description && <p className="mt-0.5 text-[13px] text-ink2">{t.description}</p>}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}
