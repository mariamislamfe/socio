"use client";
import {
  ArrowUp,
  Bot,
  CheckCircle2,
  CircleSlash,
  Clock,
  Cpu,
  ListChecks,
  ShieldCheck,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, clsx, Input, PageHeader } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll } from "@/lib/client/hooks";

interface Step {
  tool: string;
  label: string;
  input: unknown;
  summary: string;
  ok: boolean;
}
interface Proposal {
  actionId: string | null;
  tool: string;
  mode: "auto" | "approval" | "prohibited";
  status?: string;
  reason: string;
  summary: string;
}
interface Reply {
  engine: "claude" | "rules" | "guard";
  intent: string;
  plan: string[];
  steps: Step[];
  answer: string;
  proposals: Proposal[];
  note?: string;
  aiConfigured: boolean;
}
type Msg = { role: "user"; text: string } | { role: "assistant"; reply: Reply };

const SUGGESTIONS = [
  "Do I need a loan, and which offer is safest?",
  "How much of my cash belongs to the tax office?",
  "What should I focus on today?",
  "Help me collect money customers owe",
  "Which product makes the most profit?",
  "محتاج تمويل؟ وأنهي عرض أأمن؟",
];

const TOOL_NAME: Record<string, string> = {
  send_payment_reminder: "Email reminder",
  draft_email: "Email draft",
  create_task: "Task",
  create_tax_reserve: "Tax reserve",
  reschedule_payable: "New bill date",
  share_lender_pack: "Share lender file",
};

export default function AskPage() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs, busy]);

  const ask = async (text: string) => {
    const message = text.trim();
    if (message.length < 2 || busy) return;
    setErr("");
    setQ("");
    const history = msgs
      .slice(-6)
      .map((m) =>
        m.role === "user"
          ? { role: "user" as const, content: m.text }
          : { role: "assistant" as const, content: m.reply.answer },
      );
    setMsgs((m) => [...m, { role: "user", text: message }]);
    setBusy(true);
    try {
      let lang: "en" | "ar" = "en";
      try {
        lang = localStorage.getItem("margin-locale") === "ar" ? "ar" : "en";
      } catch {
        /* default */
      }
      const reply = await api.post<Reply>("/api/agent", { message, history, lang });
      setMsgs((m) => [...m, { role: "assistant", reply }]);
      if (reply.proposals.length) refreshAll();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  // Questions typed in the command palette arrive as ?q=…
  const asked = useRef(false);
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial && !asked.current) {
      asked.current = true;
      void ask(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <PageHeader
        title="Ask your business"
        subtitle="Ask in plain words, Arabic or English. It shows what it understood, its plan and every step it took. Facts come only from your records; anything sensitive waits for your approval."
        actions={
          <Link href="/app/insights" className="text-sm text-accent">
            Insights →
          </Link>
        }
      />

      {msgs.length === 0 && (
        <Card className="p-5 sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accentsoft text-accent">
              <Bot className="size-5" aria-hidden />
            </span>
            <div>
              <p className="text-[15px] font-medium text-ink">
                Your finance co-pilot can check, calculate and prepare — not just chat.
              </p>
              <p className="mt-1 text-[13px] text-ink2">
                It can compare loans, estimate taxes, find losing products, simulate decisions, prepare reminders and
                lender files. It never moves money, never invents numbers and cannot approve its own proposals.
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => ask(s)}
                className="rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] text-ink2 transition hover:border-accent hover:text-ink"
              >
                {s}
              </button>
            ))}
          </div>
        </Card>
      )}

      <div className="space-y-4" aria-live="polite">
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex justify-end"
            >
              <p
                dir="auto"
                className="max-w-[85%] rounded-2xl rounded-ee-md bg-accent px-4 py-2.5 text-[15px] text-white"
              >
                {m.text}
              </p>
            </motion.div>
          ) : (
            <AgentReply key={i} r={m.reply} />
          ),
        )}
        <AnimatePresence>
          {busy && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 text-[13px] text-ink3"
            >
              <span className="flex gap-1">
                {[0, 1, 2].map((k) => (
                  <motion.span
                    key={k}
                    className="size-1.5 rounded-full bg-accent"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1, repeat: Infinity, delay: k * 0.15 }}
                  />
                ))}
              </span>
              Understanding, planning and checking your records…
            </motion.div>
          )}
        </AnimatePresence>
        <div ref={end} />
      </div>

      <form
        className="sticky bottom-20 z-10 sm:bottom-4"
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <Card className="flex items-center gap-2 p-2 shadow-lg">
          <Input
            dir="auto"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. Can I afford to hire someone next month?"
            aria-label="Your question"
            className="h-11 flex-1 border-0 bg-transparent shadow-none focus:ring-0"
          />
          <Button type="submit" variant="primary" loading={busy} aria-label="Ask">
            <ArrowUp className="size-4" aria-hidden />
          </Button>
        </Card>
        {err && <p className="mt-2 text-sm text-neg">{err}</p>}
      </form>
    </div>
  );
}

function AgentReply({ r }: { r: Reply }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken/60 px-4 py-2.5 text-[12px]">
          <Sparkles className="size-4 text-accent" aria-hidden />
          <span className="text-ink3">Understood:</span>
          <span dir="auto" className="font-medium text-ink">
            {r.intent}
          </span>
          <span className="flex-1" />
          <Badge tone={r.engine === "claude" ? "accent" : "neutral"}>
            {r.engine === "claude" ? (
              <>
                <Cpu className="size-3" /> Claude + your data
              </>
            ) : r.engine === "guard" ? (
              <>
                <ShieldCheck className="size-3" /> Safety check
              </>
            ) : (
              "Built-in planner"
            )}
          </Badge>
        </div>
        <div className="grid gap-5 p-4 sm:p-5 md:grid-cols-[1fr_1.4fr]">
          <div>
            <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink3">
              <ListChecks className="size-4" aria-hidden /> Plan
            </p>
            <ol className="mt-2 space-y-1.5">
              {r.plan.map((p, i) => (
                <motion.li
                  key={i}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.12 * i }}
                  className="flex gap-2 text-[13px] text-ink2"
                >
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accentsoft text-[11px] font-semibold text-accent">
                    {i + 1}
                  </span>
                  <span dir="auto">{p}</span>
                </motion.li>
              ))}
            </ol>
            {r.steps.length > 0 && (
              <>
                <p className="mt-4 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink3">
                  <Wrench className="size-4" aria-hidden /> What it did
                </p>
                <ul className="mt-2 space-y-2">
                  {r.steps.map((s, i) => (
                    <motion.li
                      key={i}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.2 + 0.15 * i }}
                      className="flex gap-2 text-[13px]"
                    >
                      {s.ok ? (
                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-pos" aria-hidden />
                      ) : (
                        <XCircle className="mt-0.5 size-4 shrink-0 text-neg" aria-hidden />
                      )}
                      <span>
                        <span className="font-medium text-ink">{s.label}</span>
                        <span className="block text-ink3">{s.summary}</span>
                      </span>
                    </motion.li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <div>
            <p dir="auto" className="whitespace-pre-line text-[15px] leading-relaxed text-ink">
              {r.answer}
            </p>
            {r.proposals.length > 0 && (
              <div className="mt-4 space-y-2">
                {r.proposals.map((p, i) => (
                  <div
                    key={i}
                    className={clsx(
                      "flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-[13px]",
                      p.mode === "approval"
                        ? "border-warn/40 bg-warnsoft/40"
                        : p.mode === "auto"
                          ? "border-pos/30 bg-possoft/40"
                          : "border-line bg-sunken",
                    )}
                  >
                    {p.mode === "approval" ? (
                      <Clock className="size-4 text-warn" aria-hidden />
                    ) : p.mode === "auto" ? (
                      <CheckCircle2 className="size-4 text-pos" aria-hidden />
                    ) : (
                      <CircleSlash className="size-4 text-ink3" aria-hidden />
                    )}
                    <span className="font-medium text-ink">{TOOL_NAME[p.tool] ?? p.tool}</span>
                    <span className="min-w-0 flex-1 text-ink2">
                      {p.mode === "approval"
                        ? "waiting for your approval"
                        : p.mode === "auto"
                          ? "done (internal, low-risk)"
                          : p.reason}
                    </span>
                    {p.mode === "approval" && (
                      <Link href="/app/actions?tab=approvals" className="font-medium text-accent">
                        Review →
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}
            {r.note && <p className="mt-3 text-xs text-ink3">{r.note}</p>}
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
