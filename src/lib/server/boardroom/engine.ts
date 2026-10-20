// The boardroom: a moderator plans who should speak, deterministic scenarios supply the numbers,
// agents answer in turn (reading each other), and the moderator synthesises one decision.
// The LLM never calculates: figures come only from FACTS and SCENARIO RESULTS produced by the finance engine.
import { z } from "zod";
import { addDays } from "@/lib/finance/dates";
import { currencyDigits, formatMoney } from "@/lib/finance/money";
import { simulate, type Adjustment } from "@/lib/finance/scenarios";
import type { Snapshot } from "@/lib/finance/snapshot";
import { AGENTS, AGENT_KEYS, type AgentKey } from "./agents";
import { extractJson, type LlmFn } from "./llm";

export type Stance = "support" | "oppose" | "conditional" | "info";

export type BoardEvent =
  | { type: "plan"; agents: { key: AgentKey; why: string }[]; scenarios: string[]; summary: string }
  | { type: "typing"; agent: AgentKey | "chair" }
  | { type: "message"; seq: number; agent: AgentKey; stance: Stance; content: string; replyTo?: AgentKey[] }
  | { type: "system"; content: string }
  | { type: "scenario"; label: string; lines: { label: string; value: string }[] }
  | { type: "decision"; decision: Decision };

export interface Decision {
  decision: string;
  why: string[];
  risks: string[];
  nextSteps: { title: string; inDays: number; owner: AgentKey | "you" }[];
  confidence: "low" | "medium" | "high";
  dissent: string | null;
  assumptions: string[];
  numbers: { label: string; value: string }[];
}

export interface TranscriptItem {
  agent: AgentKey | "you";
  stance?: Stance;
  content: string;
}

// scenario spec the moderator may request (major units, relative dates)
const zScenario = z.object({
  label: z.string().max(120),
  type: z.enum([
    "ad_spend",
    "inventory",
    "hire",
    "price",
    "sales_drop",
    "late_payment",
    "shipping",
    "new_product",
    "supplier_cost",
  ]),
  pct: z.number().min(-90).max(500).optional(),
  amount: z.number().min(0).optional(),
  monthlyCost: z.number().min(0).optional(),
  oneTime: z.number().min(0).optional(),
  expectedRevenue: z.number().min(0).optional(),
  assumedRoas: z.number().min(0).max(50).optional(),
  volumePct: z.number().min(-90).max(500).optional(),
  delayDays: z.number().int().min(1).max(180).optional(),
  launchCost: z.number().min(0).optional(),
  monthlyRevenue: z.number().min(0).optional(),
  marginPct: z.number().min(0).max(100).optional(),
  inDays: z.number().int().min(0).max(120).optional(),
  sellDays: z.number().int().min(7).max(180).optional(),
});
type ScenarioSpec = z.infer<typeof zScenario>;

const zPlan = z.object({
  summary: z.string().max(400).default(""),
  agents: z
    .array(z.object({ key: z.enum(["cfo", "cmo", "coo", "legal", "skeptic"]), why: z.string().max(200).default("") }))
    .max(5)
    .default([]),
  scenarios: z.array(zScenario).max(3).default([]),
});

const zTurn = z.object({
  say: z.string().max(1200).default(""),
  stance: z.enum(["support", "oppose", "conditional", "info"]).default("info"),
  pass: z.boolean().optional(),
  asks: z
    .array(z.enum(["cfo", "cmo", "coo", "legal", "skeptic"]))
    .max(2)
    .optional(),
});

const zCheckpoint = z.object({
  consensus: z.boolean().default(true),
  open: z.string().max(300).default(""),
  next: z
    .array(z.enum(["cfo", "cmo", "coo", "legal", "skeptic"]))
    .max(3)
    .default([]),
});

const zDecision = z.object({
  decision: z.string().max(500),
  why: z.array(z.string().max(300)).max(5).default([]),
  risks: z.array(z.string().max(300)).max(5).default([]),
  nextSteps: z
    .array(
      z.object({
        title: z.string().max(160),
        inDays: z.number().int().min(0).max(120).default(7),
        owner: z.enum(["cfo", "cmo", "coo", "legal", "skeptic", "you"]).default("you"),
      }),
    )
    .max(5)
    .default([]),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  dissent: z.string().max(400).nullable().default(null),
  assumptions: z.array(z.string().max(250)).max(5).default([]),
});

export function toAdjustment(s: ScenarioSpec, today: string, digits: number): Adjustment | null {
  const M = (n: number | undefined) => Math.round((n ?? 0) * 10 ** digits);
  const date = addDays(today, s.inDays ?? 7);
  switch (s.type) {
    case "ad_spend":
      return { type: "ad_spend", pct: s.pct ?? 0, assumedRoas: s.assumedRoas };
    case "inventory":
      return s.amount
        ? {
            type: "inventory",
            amount: M(s.amount),
            date,
            expectedRevenue: s.expectedRevenue ? M(s.expectedRevenue) : undefined,
            sellDays: s.sellDays,
          }
        : null;
    case "hire":
      return s.monthlyCost
        ? {
            type: "hire",
            monthlyCost: M(s.monthlyCost),
            startDate: date,
            oneTime: s.oneTime ? M(s.oneTime) : undefined,
          }
        : null;
    case "price":
      return { type: "price", pct: s.pct ?? 0, volumePct: s.volumePct ?? 0 };
    case "sales_drop":
      return { type: "sales_drop", pct: s.pct ?? 20 };
    case "late_payment":
      return { type: "late_payment", delayDays: s.delayDays ?? 30 };
    case "shipping":
      return { type: "shipping", pct: s.pct ?? 0 };
    case "supplier_cost":
      return { type: "supplier_cost", pct: s.pct ?? 0 };
    case "new_product":
      return s.launchCost !== undefined && s.monthlyRevenue
        ? {
            type: "new_product",
            launchCost: M(s.launchCost),
            monthlyRevenue: M(s.monthlyRevenue),
            marginPct: s.marginPct ?? 40,
            startDate: date,
          }
        : null;
  }
}

function lang(topic: string): string {
  return /[؀-ۿ]/.test(topic)
    ? "Reply in natural Egyptian Arabic (Arabic script), simple words, the way a friendly colleague talks. Keep numbers and currency codes as given."
    : "Reply in clear, simple English.";
}

const RULES = `Hard rules:
- Use ONLY figures that appear in FACTS or SCENARIO RESULTS. If a number you need is not there, say it is unknown. Never invent or estimate figures.
- Stay in your lane. If the topic does not touch it, set "pass": true and say nothing.
- 2–4 short sentences. Plain words, no jargon without a one-line explanation. No bullet lists.
- You may address a colleague by name and answer what they said. Do not repeat what was already said.
- Never promise outcomes. Forecasts are assumptions.`;

export interface RunArgs {
  llm: LlmFn;
  topic: string;
  facts: unknown;
  snapshot: Snapshot;
  transcript?: TranscriptItem[];
  emit: (e: BoardEvent) => void | Promise<void>;
  maxSpeakers?: number;
}

export interface RunResult {
  transcript: TranscriptItem[];
  decision: Decision;
  scenarioLines: { label: string; lines: { label: string; value: string }[] }[];
  calls: number;
}

export async function runBoardroom(a: RunArgs): Promise<RunResult> {
  const { llm, topic, snapshot, emit } = a;
  const transcript: TranscriptItem[] = [...(a.transcript ?? [])];
  const digits = currencyDigits(snapshot.currency);
  const fm = (v: number) => formatMoney(v, snapshot.currency);
  const L = lang(topic);
  const maxSpeakers = a.maxSpeakers ?? 6;
  let calls = 0;
  let seq = transcript.length;
  const factsJson = JSON.stringify(a.facts);
  const call = async (system: string, user: string, maxTokens = 600) => {
    calls++;
    return llm({ system, user, maxTokens });
  };
  const parse = async <T>(
    schema: z.ZodType<T>,
    system: string,
    user: string,
    maxTokens?: number,
  ): Promise<T | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await call(
        system,
        attempt ? `${user}\n\nYour previous answer was not valid JSON. Answer with ONLY the JSON object.` : user,
        maxTokens,
      );
      const j = extractJson(raw);
      const r = j ? schema.safeParse(j) : null;
      if (r?.success) return r.data;
    }
    return null;
  };
  const board = AGENT_KEYS.map((k) => `${AGENTS[k].name} (${AGENTS[k].title}): ${AGENTS[k].lane}`).join("\n");
  const history = () =>
    transcript.length
      ? transcript
          .filter((t) => t.agent === "you" || AGENTS[t.agent])
          .map(
            (t) =>
              `${t.agent === "you" ? "OWNER" : `${AGENTS[t.agent].name} (${AGENTS[t.agent].title})`}${t.stance ? ` [${t.stance}]` : ""}: ${t.content}`,
          )
          .join("\n")
      : "(nobody has spoken yet)";

  /* 1. moderator plans */
  await emit({ type: "typing", agent: "chair" });
  const plan = await parse(
    zPlan,
    `You chair a small-business board meeting. Decide which board members should weigh in on the owner's question and which what-if scenarios (if any) should be calculated so people argue from numbers.
Board:\n${board}
Only pick people whose lane the question really touches (usually 2–4). Include "skeptic" when a plan or promise needs stress-testing. Order them so the most relevant speaks first.
Scenario types and fields (money in whole currency units, dates as inDays from today):
ad_spend{pct,assumedRoas?}, inventory{amount,inDays,expectedRevenue?,sellDays?}, hire{monthlyCost,inDays,oneTime?}, price{pct,volumePct}, sales_drop{pct}, late_payment{delayDays}, shipping{pct}, new_product{launchCost,monthlyRevenue,marginPct,inDays}.
Only request a scenario when the owner's question implies concrete numbers; never invent amounts the owner did not give or that FACTS do not support.
Return ONLY JSON: {"summary":"one line restating the question","agents":[{"key":"cfo","why":"short reason"}],"scenarios":[{"label":"...","type":"hire",...}]}`,
    `FACTS:\n${factsJson}\n\nPREVIOUS DISCUSSION:\n${history()}\n\nOWNER'S QUESTION:\n${topic}`,
    700,
  );
  const picked = (plan?.agents ?? []).filter((x, i, arr) => arr.findIndex((y) => y.key === x.key) === i);
  if (!picked.length) picked.push({ key: "cfo", why: "Money question" });
  await emit({
    type: "plan",
    agents: picked,
    scenarios: (plan?.scenarios ?? []).map((s) => s.label),
    summary: plan?.summary ?? topic,
  });

  /* 2. numbers from the deterministic engine */
  const scenarioLines: RunResult["scenarioLines"] = [];
  for (const spec of plan?.scenarios ?? []) {
    const adj = toAdjustment(spec, snapshot.today, digits);
    if (!adj) continue;
    const r = simulate(snapshot, [adj], 90);
    const lines = [
      { label: "Cash in 90 days", value: `${fm(r.baseline.endCash)} → ${fm(r.scenario.endCash)}` },
      { label: "Lowest cash", value: `${fm(r.baseline.minCash)} → ${fm(r.scenario.minCash)}` },
      { label: "Est. monthly profit", value: `${fm(r.baseline.monthlyProfit)} → ${fm(r.scenario.monthlyProfit)}` },
      { label: "Shortfall date", value: r.scenario.firstShortfallDate ?? "none in 90 days" },
      ...(r.warnings.length ? [{ label: "Warnings", value: r.warnings.join(" ") }] : []),
    ];
    scenarioLines.push({ label: spec.label, lines });
    await emit({ type: "scenario", label: spec.label, lines });
  }
  const scenarioText = scenarioLines.length
    ? scenarioLines.map((s) => `• ${s.label}\n${s.lines.map((l) => `   ${l.label}: ${l.value}`).join("\n")}`).join("\n")
    : "(none calculated)";

  /* 3. turns */
  if (a.transcript === undefined || !transcript.some((t) => t.agent === "you"))
    transcript.push({ agent: "you", content: topic });
  const spoken = new Set<AgentKey>();
  const queue: AgentKey[] = picked.map((p) => p.key);
  let speakers = 0;

  const turn = async (key: AgentKey, purpose: string) => {
    const ag = AGENTS[key];
    await emit({ type: "typing", agent: key });
    const t = await parse(
      zTurn,
      `${ag.persona}\nYour lane: ${ag.lane}.\n${L}\n${RULES}\nReturn ONLY JSON: {"say":"...","stance":"support|oppose|conditional|info","pass":false,"asks":["cfo"]}. "asks" is optional: colleagues whose input you need before a decision.`,
      `FACTS:\n${factsJson}\n\nSCENARIO RESULTS (calculated, 90 days):\n${scenarioText}\n\nDISCUSSION SO FAR:\n${history()}\n\n${purpose}`,
      500,
    );
    if (!t || t.pass || !t.say.trim()) return null;
    const item: TranscriptItem = { agent: key, stance: t.stance, content: t.say.trim() };
    transcript.push(item);
    spoken.add(key);
    speakers++;
    await emit({ type: "message", seq: ++seq, agent: key, stance: t.stance, content: item.content });
    return t;
  };

  while (queue.length && speakers < maxSpeakers) {
    const key = queue.shift()!;
    if (spoken.has(key)) continue;
    const t = await turn(
      key,
      "Give your view on the owner's question now, from your lane. React to colleagues if relevant.",
    );
    // A colleague who is asked a question answers next, like in a real conversation.
    for (const asked of [...(t?.asks ?? [])].reverse()) {
      if (spoken.has(asked) || speakers + queue.length >= maxSpeakers) continue;
      const at = queue.indexOf(asked);
      if (at >= 0) queue.splice(at, 1);
      queue.unshift(asked);
    }
  }

  /* 4. one rebuttal round if there is real disagreement */
  if (speakers < maxSpeakers) {
    await emit({ type: "typing", agent: "chair" });
    const cp = await parse(
      zCheckpoint,
      `You chair the meeting. Decide if the board has converged. If people disagree or a key question is open, name up to 2 members who should respond to each other once more. Return ONLY JSON: {"consensus":true|false,"open":"what is unresolved","next":["cfo"]}`,
      `DISCUSSION:\n${history()}\n\nOWNER'S QUESTION:\n${topic}`,
      300,
    );
    if (cp && !cp.consensus) {
      for (const key of cp.next.slice(0, 2)) {
        if (speakers >= maxSpeakers) break;
        // A member may speak a second time here, specifically to answer the open point.
        spoken.delete(key);
        await turn(
          key,
          `Open point: ${cp.open || "the disagreement above"}. Answer it directly and briefly; change your stance if the argument convinced you.`,
        );
      }
    }
  }

  /* 5. synthesis */
  await emit({ type: "typing", agent: "chair" });
  const dec = await parse(
    zDecision,
    `You chair the board and must close with ONE answer for the owner. ${L}
Be decisive but honest: if the board is split or data is missing, say what would change the answer. Do not add numbers that are not in FACTS or SCENARIO RESULTS. Next steps must be small, concrete actions the owner can do (inDays from today; owner is a board role or "you").
Return ONLY JSON: {"decision":"one clear sentence","why":["..."],"risks":["..."],"nextSteps":[{"title":"...","inDays":7,"owner":"you"}],"confidence":"low|medium|high","dissent":"remaining objection or null","assumptions":["..."]}`,
    `FACTS:\n${factsJson}\n\nSCENARIO RESULTS:\n${scenarioText}\n\nDISCUSSION:\n${history()}\n\nOWNER'S QUESTION:\n${topic}`,
    900,
  );
  const decision: Decision = dec
    ? {
        ...dec,
        numbers: scenarioLines.flatMap((s) =>
          s.lines
            .filter((l) => l.label !== "Warnings")
            .slice(0, 3)
            .map((l) => ({ label: `${s.label} — ${l.label}`, value: l.value })),
        ),
      }
    : {
        decision: "The board could not reach a written conclusion. Read the discussion above and decide.",
        why: [],
        risks: [],
        nextSteps: [],
        confidence: "low",
        dissent: null,
        assumptions: [],
        numbers: scenarioLines.flatMap((s) =>
          s.lines.slice(0, 3).map((l) => ({ label: `${s.label} — ${l.label}`, value: l.value })),
        ),
      };
  await emit({ type: "decision", decision });
  return { transcript, decision, scenarioLines, calls };
}
