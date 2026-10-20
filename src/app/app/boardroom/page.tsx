"use client";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CheckCheck, Gavel, History, ListPlus, Plus, Send, Settings2, Trash2 } from "lucide-react";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { useUi } from "@/components/providers";
import { Badge, Button, Card, clsx, EmptyState, Input, PageHeader, Skeleton } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll, useMe } from "@/lib/client/hooks";

type AgentKey = "cfo" | "cmo" | "coo" | "legal" | "skeptic";
interface AgentInfo {
  key: AgentKey;
  name: string;
  title: string;
  color: string;
  lane: string;
}
interface Decision {
  decision: string;
  why: string[];
  risks: string[];
  nextSteps: { title: string; inDays: number; owner: string }[];
  confidence: "low" | "medium" | "high";
  dissent: string | null;
  assumptions: string[];
  numbers: { label: string; value: string }[];
}
type Item =
  | { id: string; kind: "user"; content: string }
  | { id: string; kind: "agent"; agent: AgentKey; stance: string; content: string }
  | { id: string; kind: "scenario"; label: string; lines: { label: string; value: string }[] }
  | { id: string; kind: "note"; content: string };

const STANCE: Record<string, { label: string; tone: "pos" | "neg" | "warn" | "neutral" }> = {
  support: { label: "Agrees", tone: "pos" },
  oppose: { label: "Objects", tone: "neg" },
  conditional: { label: "Yes, if…", tone: "warn" },
  info: { label: "Adds context", tone: "neutral" },
};
const PROMPTS = [
  "هل أقدر أعيّن مصمم بـ 8000 جنيه في الشهر؟",
  "Should I increase my ad budget by 30%?",
  "هل أطلب شحنة بضاعة جديدة بـ 60 ألف؟",
  "What happens to us if our best customer pays 45 days late?",
  "Should I raise prices by 10%?",
];

function Avatar({ a, active, size = 44 }: { a: AgentInfo; active?: boolean; size?: number }) {
  return (
    <div className="relative" title={`${a.name} · ${a.title}`}>
      <motion.div
        animate={{ scale: active ? 1.08 : 1 }}
        className="flex items-center justify-center rounded-full font-semibold text-white shadow-sm"
        style={{
          width: size,
          height: size,
          background: a.color,
          outline: active ? `3px solid ${a.color}55` : "none",
          outlineOffset: 2,
        }}
      >
        {a.name.slice(0, 1)}
      </motion.div>
      {active && (
        <motion.span
          layoutId="typing-dot"
          className="absolute -bottom-0.5 -end-0.5 size-3 rounded-full border-2 border-surface bg-signal"
        />
      )}
    </div>
  );
}

function Inner() {
  const { biz } = useMe();
  const { toast } = useUi();
  const status = useSWR<{ configured: boolean; model: string; agents: AgentInfo[] }>("/api/boardroom/status");
  const sessions = useSWR<{
    items: { id: string; topic: string; status: string; decision: string | null; created_at: string }[];
  }>("/api/boardroom/sessions");
  const [sid, setSid] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [typing, setTyping] = useState<AgentKey | "chair" | null>(null);
  const [planned, setPlanned] = useState<AgentKey[]>([]);
  const [running, setRunning] = useState(false);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [tasksMade, setTasksMade] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const agents = status.data?.agents ?? [];
  const byKey = (k: string) => agents.find((a) => a.key === k);
  const canWrite = biz && biz.role !== "viewer";

  const scroll = () => setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 60);

  const load = useCallback(async (id: string) => {
    const r = await api.get<{
      session: { id: string; status: string; decision: Decision | null; error: string | null };
      messages: any[];
    }>(`/api/boardroom/sessions/${id}`);
    setSid(id);
    setDecision(r.session.decision);
    setErr(r.session.status === "failed" ? (r.session.error ?? "The meeting stopped.") : "");
    setTasksMade(false);
    setPlanned([]);
    setItems(
      r.messages.map((m) =>
        m.kind === "user"
          ? { id: `m${m.seq}`, kind: "user", content: m.content }
          : m.kind === "system"
            ? m.meta?.lines
              ? {
                  id: `m${m.seq}`,
                  kind: "scenario",
                  label: String(m.content).replace(/^Calculated: /, ""),
                  lines: m.meta.lines,
                }
              : { id: `m${m.seq}`, kind: "note", content: m.content }
            : { id: `m${m.seq}`, kind: "agent", agent: m.agent, stance: m.stance ?? "info", content: m.content },
      ),
    );
    scroll();
  }, []);

  const run = async (id: string, message?: string) => {
    setRunning(true);
    setErr("");
    setDecision(null);
    if (message) setItems((x) => [...x, { id: `u${Date.now()}`, kind: "user", content: message }]);
    try {
      const res = await fetch(`/api/boardroom/sessions/${id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message ? { message } : {}),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new ApiError(res.status, j?.error?.code ?? "error", j?.error?.message ?? "Could not start the meeting.");
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i).trim();
          buf = buf.slice(i + 2);
          if (!chunk.startsWith("data:")) continue;
          const e = JSON.parse(chunk.slice(5));
          if (e.type === "plan") setPlanned(e.agents.map((a: any) => a.key));
          else if (e.type === "typing") setTyping(e.agent);
          else if (e.type === "message") {
            setTyping(null);
            setItems((x) => [
              ...x,
              { id: `a${e.seq}`, kind: "agent", agent: e.agent, stance: e.stance, content: e.content },
            ]);
            scroll();
          } else if (e.type === "scenario")
            setItems((x) => [
              ...x,
              { id: `s${Date.now()}${Math.random()}`, kind: "scenario", label: e.label, lines: e.lines },
            ]);
          else if (e.type === "decision") {
            setTyping(null);
            setDecision(e.decision);
            scroll();
          } else if (e.type === "error") setErr(e.message);
        }
      }
    } catch (x) {
      setErr(
        x instanceof ApiError ? x.message : "The connection dropped. Open the meeting again to see what was saved.",
      );
    } finally {
      setRunning(false);
      setTyping(null);
      sessions.mutate();
    }
  };

  const start = async (topic: string) => {
    if (!topic.trim() || running) return;
    setQ("");
    try {
      const r = await api.post<{ id: string }>("/api/boardroom/sessions", { topic });
      setSid(r.id);
      setItems([]);
      setDecision(null);
      setTasksMade(false);
      await run(r.id);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Could not start.");
    }
  };

  const follow = async (m: string) => {
    if (!sid || !m.trim() || running) return;
    setQ("");
    await run(sid, m.trim());
  };

  if (status.isLoading) return <Skeleton className="h-[34rem]" />;
  const configured = status.data?.configured;

  return (
    <div className="space-y-6">
      <PageHeader
        title="The boardroom"
        subtitle="Bring a decision. Your CFO, CMO, operations and compliance advisors argue it out on your real numbers, then give you one answer."
        actions={
          sid ? (
            <Button onClick={() => (setSid(null), setItems([]), setDecision(null), setErr(""))}>
              <Plus className="size-4" aria-hidden /> New meeting
            </Button>
          ) : undefined
        }
      />

      {!configured && (
        <Card className="border-warn/30 bg-warnsoft/50 p-5">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <Settings2 className="size-5 text-warn" aria-hidden /> The boardroom needs an AI provider
          </p>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink2">
            The board members are language-model agents, so Socio cannot stage a real discussion without one — and it
            will not fake one. Set{" "}
            <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs">ANTHROPIC_API_KEY</code> in the server
            environment and restart. Everything else in Socio works without it.
          </p>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 space-y-4">
          {/* the table */}
          <Card className="p-4 sm:p-5">
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-3">
              {agents.map((a) => {
                const on = typing === a.key;
                const invited = planned.includes(a.key);
                return (
                  <li
                    key={a.key}
                    className={clsx(
                      "flex items-center gap-2.5 transition",
                      planned.length > 0 && !invited && "opacity-40",
                    )}
                  >
                    <Avatar a={a} active={on} />
                    <div>
                      <p className="text-sm font-semibold leading-tight text-ink">{a.name}</p>
                      <p className="text-xs text-ink3">{on ? "thinking…" : a.title}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          {/* meeting */}
          {!sid && !running ? (
            <Card className="p-6 sm:p-8">
              <h2 className="display text-2xl">What should the board decide?</h2>
              <p className="mt-1 text-sm text-ink2">
                Write it in Arabic or English. Include the amounts you have in mind.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {PROMPTS.map((p) => (
                  <button
                    key={p}
                    dir="auto"
                    onClick={() => setQ(p)}
                    className="rounded-full border border-line bg-raised px-3.5 py-1.5 text-[13px] text-ink2 transition hover:border-accent hover:text-accent"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </Card>
          ) : (
            <Card className="p-4 sm:p-6">
              <ul className="space-y-4" aria-live="polite">
                <AnimatePresence initial={false}>
                  {items.map((it) =>
                    it.kind === "user" ? (
                      <motion.li
                        key={it.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex justify-end"
                      >
                        <p
                          dir="auto"
                          className="max-w-[88%] rounded-2xl rounded-ee-md bg-accent px-4 py-2.5 text-[15px] text-accentink"
                        >
                          {it.content}
                        </p>
                      </motion.li>
                    ) : it.kind === "agent" ? (
                      (() => {
                        const a = byKey(it.agent);
                        const st = STANCE[it.stance] ?? STANCE.info;
                        return (
                          <motion.li
                            key={it.id}
                            initial={{ opacity: 0, y: 10, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            className="flex gap-3"
                          >
                            {a && <Avatar a={a} size={38} />}
                            <div className="min-w-0 max-w-[88%]">
                              <p className="flex flex-wrap items-center gap-2 text-xs text-ink3">
                                <span className="font-semibold text-ink">{a?.name}</span> {a?.title}{" "}
                                <Badge tone={st.tone}>{st.label}</Badge>
                              </p>
                              <p
                                dir="auto"
                                className="mt-1 rounded-2xl rounded-ss-md border border-line bg-raised px-4 py-2.5 text-[15px] leading-relaxed text-ink"
                                style={{ borderInlineStartColor: a?.color, borderInlineStartWidth: 3 }}
                              >
                                {it.content}
                              </p>
                            </div>
                          </motion.li>
                        );
                      })()
                    ) : it.kind === "scenario" ? (
                      <motion.li
                        key={it.id}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="rounded-2xl border border-dashed border-line2 bg-sunken/60 p-4"
                      >
                        <p className="eyebrow">Calculated from your records · 90 days</p>
                        <p className="mt-0.5 text-sm font-medium text-ink">{it.label}</p>
                        <dl className="mt-2 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
                          {it.lines.map((l) => (
                            <div key={l.label} className="flex justify-between gap-3">
                              <dt className="text-ink3">{l.label}</dt>
                              <dd className="num text-end font-medium text-ink">{l.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </motion.li>
                    ) : (
                      <li key={it.id} className="text-center text-xs text-ink3">
                        {it.content}
                      </li>
                    ),
                  )}
                </AnimatePresence>
                {typing && (
                  <li className="flex items-center gap-2 text-sm text-ink3">
                    <span className="flex gap-1">
                      {[0, 1, 2].map((i) => (
                        <motion.span
                          key={i}
                          className="size-1.5 rounded-full bg-ink3"
                          animate={{ opacity: [0.3, 1, 0.3] }}
                          transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }}
                        />
                      ))}
                    </span>
                    {typing === "chair"
                      ? "The chair is organising the discussion…"
                      : `${byKey(typing)?.name ?? "Someone"} is thinking…`}
                  </li>
                )}
              </ul>

              {decision && (
                <motion.section
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-6 overflow-hidden rounded-3xl border border-accent bg-accentsoft/50"
                >
                  <div className="flex items-center gap-2 bg-accent px-5 py-3 text-accentink">
                    <Gavel className="size-5" aria-hidden />
                    <p className="font-semibold">The board&rsquo;s answer</p>
                    <Badge tone="signal" className="ms-auto">
                      {decision.confidence} confidence
                    </Badge>
                  </div>
                  <div className="space-y-4 p-5">
                    <p dir="auto" className="display text-2xl leading-snug text-ink">
                      {decision.decision}
                    </p>
                    {decision.why.length > 0 && <Block title="Why" items={decision.why} />}
                    {decision.risks.length > 0 && <Block title="Watch out for" items={decision.risks} />}
                    {decision.dissent && (
                      <p dir="auto" className="rounded-xl bg-warnsoft px-3.5 py-2.5 text-sm text-ink">
                        <span className="font-medium">Still unresolved: </span>
                        {decision.dissent}
                      </p>
                    )}
                    {decision.numbers.length > 0 && (
                      <dl className="grid gap-x-6 gap-y-1 rounded-xl bg-raised p-3.5 text-[13px] sm:grid-cols-2">
                        {decision.numbers.map((n, i) => (
                          <div key={i} className="flex justify-between gap-3">
                            <dt className="text-ink3">{n.label}</dt>
                            <dd className="num font-medium">{n.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {decision.nextSteps.length > 0 && (
                      <div>
                        <p className="text-sm font-semibold text-ink">Next steps</p>
                        <ol className="mt-1.5 space-y-1.5">
                          {decision.nextSteps.map((s, i) => (
                            <li key={i} dir="auto" className="flex items-start gap-2 text-sm text-ink2">
                              <span className="fig text-accent">{i + 1}.</span>
                              <span>
                                {s.title}{" "}
                                <span className="text-ink3">
                                  · within {s.inDays} days · {s.owner === "you" ? "you" : byKey(s.owner)?.name}
                                </span>
                              </span>
                            </li>
                          ))}
                        </ol>
                        {canWrite && (
                          <Button
                            className="mt-3"
                            variant="primary"
                            size="sm"
                            disabled={tasksMade}
                            onClick={async () => {
                              const r = await api.post<{ created: number }>(`/api/boardroom/sessions/${sid}/todos`, {});
                              setTasksMade(true);
                              await refreshAll();
                              toast({
                                title: r.created
                                  ? `${r.created} step(s) added to your to-do list`
                                  : "Already in your to-do list",
                              });
                            }}
                          >
                            {tasksMade ? (
                              <>
                                <CheckCheck className="size-4" aria-hidden /> Added
                              </>
                            ) : (
                              <>
                                <ListPlus className="size-4" aria-hidden /> Add these to my to-do
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    )}
                    {decision.assumptions.length > 0 && (
                      <p className="text-xs text-ink3">Assumptions: {decision.assumptions.join(" · ")}</p>
                    )}
                    <p className="text-xs text-ink3">
                      Advice from AI advisors working from your recorded numbers. Forecasts are assumptions, not
                      promises, and this is not legal or financial advice.
                    </p>
                  </div>
                </motion.section>
              )}
              {err && (
                <p
                  role="alert"
                  className="mt-4 flex items-start gap-2 rounded-xl bg-negsoft px-3.5 py-3 text-sm text-neg"
                >
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {err}
                </p>
              )}
              <div ref={endRef} />
            </Card>
          )}

          {/* composer */}
          <form
            className="sticky bottom-20 z-10 flex gap-2 rounded-2xl border border-line bg-surface p-2 shadow-md md:bottom-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (sid && (items.length > 0 || running)) follow(q);
              else start(q);
            }}
          >
            <Input
              dir="auto"
              aria-label={sid ? "Reply to the board" : "Ask the board"}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={sid ? "Add information or push back…" : "What should the board decide?"}
              disabled={!configured || running || !canWrite}
              className="h-12 border-0 bg-transparent text-base focus:ring-0"
              maxLength={600}
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!configured || running || !canWrite || q.trim().length < 3}
              loading={running}
            >
              <Send className="size-4" aria-hidden />{" "}
              <span className="hidden sm:inline">{sid ? "Reply" : "Convene"}</span>
            </Button>
          </form>
        </div>

        {/* history */}
        <aside className="space-y-3">
          <p className="eyebrow flex items-center gap-1.5">
            <History className="size-3.5" aria-hidden /> Past meetings
          </p>
          {(sessions.data?.items ?? []).length === 0 ? (
            <p className="rounded-xl bg-sunken px-3.5 py-4 text-sm text-ink3">Your decisions will be kept here.</p>
          ) : (
            <ul className="space-y-2">
              {sessions.data!.items.map((s) => (
                <li key={s.id}>
                  <div
                    className={clsx(
                      "group relative rounded-xl border bg-raised transition hover:border-line2",
                      sid === s.id ? "border-accent" : "border-line",
                    )}
                  >
                    <button onClick={() => load(s.id)} className="block w-full px-3.5 py-3 text-start">
                      <span dir="auto" className="line-clamp-2 text-sm font-medium text-ink">
                        {s.topic}
                      </span>
                      <span className="mt-1 flex items-center gap-2 text-xs text-ink3">
                        <Badge tone={s.status === "decided" ? "pos" : s.status === "failed" ? "neg" : "neutral"}>
                          {s.status}
                        </Badge>
                        {new Date(s.created_at).toLocaleDateString()}
                      </span>
                    </button>
                    {canWrite && (
                      <button
                        aria-label="Delete meeting"
                        className="absolute end-2 top-2 hidden text-ink3 hover:text-neg group-hover:block"
                        onClick={async () => {
                          await api.del(`/api/boardroom/sessions/${s.id}`);
                          if (sid === s.id) setSid(null), setItems([]), setDecision(null);
                          sessions.mutate();
                        }}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs leading-relaxed text-ink3">
            Members only speak where it touches their lane, and every number comes from your records.{" "}
            <Link href="/app/health" className="text-accent underline">
              See your company health
            </Link>
            .
          </p>
        </aside>
      </div>
      {!sid && !running && items.length === 0 && (
        <EmptyState
          title="Ask about a real decision"
          body="A hire, a stock order, an ad budget, a price change, a supplier that wants you to pay upfront."
        />
      )}
    </div>
  );
}

function Block({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink">{title}</p>
      <ul className="mt-1 space-y-1">
        {items.map((x, i) => (
          <li key={i} dir="auto" className="flex gap-2 text-sm text-ink2">
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
            {x}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
