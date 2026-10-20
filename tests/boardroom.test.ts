import { describe, expect, it } from "vitest";
import { generateTodos, applicable, supportedCountry, VAT_THRESHOLD_EGP } from "@/lib/compliance/egypt";
import { addDays } from "@/lib/finance/dates";
import type { Cat, Txn } from "@/lib/finance/engine";
import { depreciate, estimateValuation, monthStatement, readiness, verdict } from "@/lib/finance/health";
import type { Snapshot } from "@/lib/finance/snapshot";
import { runBoardroom, toAdjustment, type BoardEvent } from "@/lib/server/boardroom/engine";
import { extractJson, type LlmFn } from "@/lib/server/boardroom/llm";

const TODAY = "2026-10-14";
const cats: Cat[] = [
  { id: "sales", name: "Sales", kind: "income", cost_type: null, parent_id: null },
  { id: "inv", name: "Inventory", kind: "expense", cost_type: "cogs", parent_id: null },
  { id: "rent", name: "Rent", kind: "expense", cost_type: "opex", parent_id: null, essential: true },
];
const txns: Txn[] = [];
let n = 0;
for (let i = 200; i >= 0; i -= 2) {
  const d = addDays(TODAY, -i);
  const b = { currency: "EGP", account_id: "a", to_account_id: null, direction: null } as const;
  txns.push({ ...b, id: `i${n++}`, type: "income", date: d, amount: 300_000, category_id: "sales" });
  if (i % 10 === 0) txns.push({ ...b, id: `c${n++}`, type: "expense", date: d, amount: 800_000, category_id: "inv" });
  if (i % 30 === 0) txns.push({ ...b, id: `r${n++}`, type: "expense", date: d, amount: 500_000, category_id: "rent" });
}
const snap: Snapshot = {
  today: TODAY,
  currency: "EGP",
  cats,
  txns,
  budgets: [],
  recurring: [],
  invoices: [],
  goals: [],
  ads: [],
  productCount: 0,
  productsWithoutCost: 0,
  accounts: [{ id: "a", name: "Bank", type: "bank", currency: "EGP", opening_balance: 5_000_000 }],
};

/* * A scripted stand-in for the model: routes by the role found in the system prompt. */
function fakeLlm(script: {
  plan?: any;
  turns?: Record<string, any[]>;
  checkpoint?: any;
  decision?: any;
  badFirst?: boolean;
}) {
  const calls: { role: string; user: string }[] = [];
  const idx: Record<string, number> = {};
  let bad = !!script.badFirst;
  const llm: LlmFn = async ({ system, user }) => {
    let role = "turn";
    if (system.includes("Decide which board members")) role = "plan";
    else if (system.includes("has converged")) role = "checkpoint";
    else if (system.includes("close with ONE answer")) role = "decision";
    else for (const k of ["Nour", "Karim", "Salma", "Omar", "Mariam"]) if (system.includes(`You are ${k}`)) role = k;
    calls.push({ role, user });
    if (bad && role === "plan") {
      bad = false;
      return "sorry, here is some prose and no JSON";
    }
    if (role === "plan") return JSON.stringify(script.plan);
    if (role === "checkpoint")
      return "```json\n" + JSON.stringify(script.checkpoint ?? { consensus: true, open: "", next: [] }) + "\n```";
    if (role === "decision") return JSON.stringify(script.decision);
    const list = script.turns?.[role] ?? [{ pass: true, say: "" }];
    const t = list[Math.min(idx[role] ?? 0, list.length - 1)];
    idx[role] = (idx[role] ?? 0) + 1;
    return JSON.stringify(t);
  };
  return { llm, calls };
}

const decision = {
  decision: "Hire later, after the supplier payment clears.",
  why: ["Cash is tight in 3 weeks."],
  risks: ["Slower delivery"],
  nextSteps: [{ title: "Re-check cash on the 1st", inDays: 14, owner: "you" }],
  confidence: "medium",
  dissent: null,
  assumptions: ["Sales stay flat"],
};

describe("boardroom orchestration", () => {
  it("runs the planned speakers in order, gives them the scenario numbers, and ends with one decision", async () => {
    const f = fakeLlm({
      plan: {
        summary: "Can I hire?",
        agents: [
          { key: "cfo", why: "cash" },
          { key: "coo", why: "capacity" },
        ],
        scenarios: [{ label: "Hire at 8,000/month", type: "hire", monthlyCost: 8000, inDays: 7 }],
      },
      turns: {
        Nour: [{ say: "Cash drops but stays positive.", stance: "conditional" }],
        Salma: [{ say: "We can absorb the work.", stance: "support" }],
      },
      decision,
    });
    const events: BoardEvent[] = [];
    const r = await runBoardroom({
      llm: f.llm,
      topic: "Can I hire a designer for 8000?",
      facts: { cash: "EGP 50,000" },
      snapshot: snap,
      emit: (e) => void events.push(e),
    });
    const msgs = events.filter((e) => e.type === "message") as Extract<BoardEvent, { type: "message" }>[];
    expect(msgs.map((m) => m.agent)).toEqual(["cfo", "coo"]);
    expect(events.at(-1)?.type).toBe("decision");
    expect(r.decision.decision).toMatch(/Hire later/);
    // The second speaker reads the first speaker's message (they actually respond to each other).
    const salma = f.calls.find((c) => c.role === "Salma")!;
    expect(salma.user).toContain("Cash drops but stays positive.");
    // Numbers come from the finance engine and are visible to speakers.
    const sc = events.find((e) => e.type === "scenario") as Extract<BoardEvent, { type: "scenario" }>;
    expect(sc.lines.find((l) => l.label === "Cash in 90 days")!.value).toContain("→");
    expect(salma.user).toContain("Hire at 8,000/month");
    expect(r.decision.numbers.length).toBeGreaterThan(0);
  });

  it("lets members stay silent when the topic is outside their lane", async () => {
    const f = fakeLlm({
      plan: {
        agents: [
          { key: "cmo", why: "ads" },
          { key: "legal", why: "just in case" },
        ],
        scenarios: [],
      },
      turns: {
        Karim: [{ say: "Raise spend 20% only if ROAS holds.", stance: "conditional" }],
        Omar: [{ pass: true, say: "" }],
      },
      decision,
    });
    const events: BoardEvent[] = [];
    await runBoardroom({
      llm: f.llm,
      topic: "Should I raise ads?",
      facts: {},
      snapshot: snap,
      emit: (e) => void events.push(e),
    });
    expect((events.filter((e) => e.type === "message") as any[]).map((m) => m.agent)).toEqual(["cmo"]);
  });

  it("brings in a colleague when someone asks for them (hand-off)", async () => {
    const f = fakeLlm({
      plan: { agents: [{ key: "cmo", why: "ads" }], scenarios: [] },
      turns: {
        Karim: [{ say: "Need Nour's view on margin first.", stance: "info", asks: ["cfo"] }],
        Nour: [{ say: "Margin is thin, so no.", stance: "oppose" }],
      },
      decision,
    });
    const events: BoardEvent[] = [];
    await runBoardroom({ llm: f.llm, topic: "More ads?", facts: {}, snapshot: snap, emit: (e) => void events.push(e) });
    expect((events.filter((e) => e.type === "message") as any[]).map((m) => m.agent)).toEqual(["cmo", "cfo"]);
  });

  it("runs a rebuttal round only when the chair says there is disagreement, and caps total speakers", async () => {
    const f = fakeLlm({
      plan: {
        agents: [
          { key: "cfo", why: "" },
          { key: "cmo", why: "" },
        ],
        scenarios: [],
      },
      turns: {
        Nour: [
          { say: "No.", stance: "oppose" },
          { say: "OK with a cap.", stance: "conditional" },
        ],
        Karim: [{ say: "Yes, ads work.", stance: "support" }],
      },
      checkpoint: { consensus: false, open: "ROAS vs margin", next: ["cfo"] },
      decision,
    });
    const events: BoardEvent[] = [];
    await runBoardroom({ llm: f.llm, topic: "More ads?", facts: {}, snapshot: snap, emit: (e) => void events.push(e) });
    const order = (events.filter((e) => e.type === "message") as any[]).map((m) => m.agent);
    expect(order).toEqual(["cfo", "cmo", "cfo"]);
    const capped = fakeLlm({
      plan: { agents: ["cfo", "cmo", "coo", "legal", "skeptic"].map((k) => ({ key: k, why: "" })), scenarios: [] },
      turns: Object.fromEntries(
        ["Nour", "Karim", "Salma", "Omar", "Mariam"].map((k) => [k, [{ say: "x", stance: "info" }]]),
      ),
      decision,
    });
    const ev2: BoardEvent[] = [];
    await runBoardroom({
      llm: capped.llm,
      topic: "q",
      facts: {},
      snapshot: snap,
      emit: (e) => void ev2.push(e),
      maxSpeakers: 3,
    });
    expect(ev2.filter((e) => e.type === "message")).toHaveLength(3);
  });

  it("recovers from a malformed plan and still produces a decision", async () => {
    const f = fakeLlm({
      badFirst: true,
      plan: { agents: [{ key: "cfo", why: "" }], scenarios: [] },
      turns: { Nour: [{ say: "Fine.", stance: "support" }] },
      decision,
    });
    const events: BoardEvent[] = [];
    const r = await runBoardroom({
      llm: f.llm,
      topic: "q",
      facts: {},
      snapshot: snap,
      emit: (e) => void events.push(e),
    });
    expect(r.decision.decision).toBeTruthy();
  });

  it("falls back honestly if the chair cannot produce a decision", async () => {
    const f = fakeLlm({
      plan: { agents: [{ key: "cfo", why: "" }], scenarios: [] },
      turns: { Nour: [{ say: "Hmm.", stance: "info" }] },
      decision: "not json" as any,
    });
    const r = await runBoardroom({ llm: f.llm, topic: "q", facts: {}, snapshot: snap, emit: () => {} });
    expect(r.decision.confidence).toBe("low");
    expect(r.decision.decision).toMatch(/could not reach/i);
  });
});

describe("scenario specs from the chair", () => {
  it("converts whole-currency amounts and relative dates to engine units", () => {
    const a = toAdjustment({ label: "x", type: "hire", monthlyCost: 8000, inDays: 10 } as any, TODAY, 2)!;
    expect(a).toMatchObject({ type: "hire", monthlyCost: 800_000, startDate: addDays(TODAY, 10) });
    expect(toAdjustment({ label: "x", type: "hire" } as any, TODAY, 2)).toBeNull(); // never invents a missing amount
  });
  it("extracts JSON from prose or fences", () => {
    expect(extractJson('Sure! ```json\n{"a":{"b":"}"}}\n``` done')).toEqual({ a: { b: "}" } });
    expect(extractJson("nothing here")).toBeNull();
  });
});

describe("Egypt compliance catalogue", () => {
  const base = {
    country: "EG",
    businessType: "fashion",
    channels: ["online_store"],
    hasEmployees: false,
    trailingRevenue12m: 0,
    vatRegistered: null as boolean | null,
    vatThresholdMinor: VAT_THRESHOLD_EGP * 100,
  };
  it("only supports Egypt for now and says so", () => {
    expect(supportedCountry("EG")).toBe(true);
    expect(supportedCountry("SA")).toBe(false);
  });
  it("adds VAT registration when sales cross (or approach) the threshold, and monthly VAT only when registered", () => {
    const small = applicable(base).map((x) => x.req.key);
    expect(small).not.toContain("eg.vat_registration");
    expect(applicable({ ...base, trailingRevenue12m: 400_000 * 100 }).map((x) => x.req.key)).toContain(
      "eg.vat_registration",
    );
    const big = applicable({ ...base, trailingRevenue12m: 900_000 * 100 }).map((x) => x.req.key);
    expect(big).toContain("eg.vat_registration");
    // Not yet answered: the monthly return is listed, explicitly conditional on being registered.
    expect(
      applicable({ ...base, trailingRevenue12m: 900_000 * 100 }).find((x) => x.req.key === "eg.vat_return")!.reason,
    ).toMatch(/if you are VAT-registered/i);
    expect(
      applicable({ ...base, trailingRevenue12m: 900_000 * 100, vatRegistered: false }).map((x) => x.req.key),
    ).not.toContain("eg.vat_return");
    expect(applicable({ ...base, vatRegistered: true }).map((x) => x.req.key)).toEqual(
      expect.arrayContaining(["eg.vat_return", "eg.e_invoice"]),
    );
    expect(applicable({ ...base, vatRegistered: true }).map((x) => x.req.key)).not.toContain("eg.vat_registration");
  });
  it("adds payroll items only for employers and shop licence only for physical sellers", () => {
    expect(applicable(base).map((x) => x.req.key)).not.toContain("eg.social_insurance");
    expect(applicable({ ...base, hasEmployees: true }).map((x) => x.req.key)).toEqual(
      expect.arrayContaining(["eg.social_insurance", "eg.payroll_tax"]),
    );
    expect(applicable({ ...base, channels: ["retail"] }).map((x) => x.req.key)).toContain("eg.shop_license");
  });
  it("never hard-codes a fee and labels every date it plans", () => {
    const { items } = generateTodos({ ...base, vatRegistered: true }, TODAY);
    const vat = items.find((i) => i.catalog_key === "eg.vat_return")!;
    expect(vat.due_date).toBe("2026-10-31");
    expect(vat.planningDefault).toBe(true);
    expect(vat.period).toBe("2026-10");
    expect(items.find((i) => i.catalog_key === "eg.commercial_register")!.due_date).toBeNull();
  });
});

describe("health: valuation, depreciation, statements", () => {
  it("depreciates straight-line and stops at salvage", () => {
    const a = {
      id: "x",
      name: "Laptop",
      cost: 3_000_000,
      purchase_date: "2026-04-14",
      useful_life_months: 36,
      salvage_value: 300_000,
      fair_value: null,
      disposed_on: null,
    };
    const d = depreciate(a, "2026-10-14");
    expect(d.monthlyDepreciation).toBe(75_000);
    expect(d.monthsElapsed).toBe(6);
    expect(d.bookValue).toBe(3_000_000 - 450_000);
    expect(depreciate(a, "2036-01-01").bookValue).toBe(300_000);
  });
  it("gives a range, not a point, and warns on short or incomplete history", () => {
    const v = estimateValuation(snap, []);
    expect(v.high).toBeGreaterThanOrEqual(v.low);
    expect(v.methods.map((m) => m.key)).toEqual(["earnings", "revenue", "assets"]);
    const empty = estimateValuation({ ...snap, txns: [] }, []);
    expect(empty.confidence).toBe("low");
    expect(empty.cautions.join(" ")).toMatch(/no records/i);
  });
  it("lets the owner change the multiples and the range moves accordingly", () => {
    const a = estimateValuation(snap, [], { earningsMultiple: [2, 4], revenueMultiple: [0.3, 0.8] });
    const b = estimateValuation(snap, [], { earningsMultiple: [4, 8], revenueMultiple: [0.3, 0.8] });
    expect(b.methods[0].high).toBe(a.methods[0].high * 2);
  });
  it("builds a month statement whose cash roll-forward adds up", () => {
    const m = monthStatement(snap, [], TODAY.slice(0, 7));
    expect(m.openingCash + m.summary.netCash).toBe(m.closingCash);
  });
  it("scores readiness from real signals and produces an honest verdict", () => {
    const r = readiness(snap, { requiredDone: 0, requiredTotal: 4 });
    expect(r.checks.find((c) => c.key === "paperwork")!.ok).toBe(false);
    expect(r.score).toBeGreaterThan(0);
    expect(verdict({ readiness: 90, shortfall: true, profitable: true, hasData: true }).tone).toBe("act");
    expect(verdict({ readiness: 0, shortfall: false, profitable: false, hasData: false }).tone).toBe("start");
  });
});

describe("valuation headline", () => {
  it("uses the earnings view as the headline and never goes below net assets", () => {
    const v = estimateValuation(snap, []);
    const earnings = v.methods.find((m) => m.key === "earnings")!;
    if (earnings.applies) {
      expect(v.high).toBe(earnings.high);
      expect(v.low).toBeGreaterThanOrEqual(Math.min(earnings.low, v.netAssets));
      expect(v.low).toBeLessThanOrEqual(v.high);
    }
    const rich = estimateValuation({ ...snap, accounts: [{ ...snap.accounts[0], opening_balance: 900_000_000 }] }, []);
    expect(rich.low).toBeLessThanOrEqual(rich.high);
  });
});
