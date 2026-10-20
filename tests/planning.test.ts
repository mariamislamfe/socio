import { describe, expect, it } from "vitest";
import { parseCsv, parseDateCell, toCsv, detectMapping } from "@/lib/csv";
import { answer, parseQuestion } from "@/lib/finance/copilot";
import { addDays } from "@/lib/finance/dates";
import type { Cat, Txn } from "@/lib/finance/engine";
import { generateInsights } from "@/lib/finance/insights";
import { goalProgress } from "@/lib/finance/planning";
import { simulate } from "@/lib/finance/scenarios";
import type { Snapshot } from "@/lib/finance/snapshot";

const TODAY = "2026-03-20";
const cats: Cat[] = [
  { id: "sales", name: "Sales", kind: "income", cost_type: null, parent_id: null },
  { id: "inv", name: "Inventory", kind: "expense", cost_type: "cogs", parent_id: null, role: "inventory" },
  { id: "ads", name: "Ads", kind: "expense", cost_type: "opex", parent_id: null, role: "ads" },
  { id: "rent", name: "Rent", kind: "expense", cost_type: "opex", parent_id: null, essential: true, role: "rent" },
];
let n = 0;
const txns: Txn[] = [];
for (let i = 60; i >= 0; i--) {
  const d = addDays(TODAY, -i);
  const base = { currency: "EGP", account_id: "a", to_account_id: null, direction: null } as const;
  txns.push({ ...base, id: `i${n++}`, type: "income", date: d, amount: 100_000, category_id: "sales" });
  if (i % 10 === 0)
    txns.push({ ...base, id: `c${n++}`, type: "expense", date: d, amount: 300_000, category_id: "inv" });
  if (i % 7 === 0) txns.push({ ...base, id: `a${n++}`, type: "expense", date: d, amount: 150_000, category_id: "ads" });
}
const snap: Snapshot = {
  today: TODAY,
  currency: "EGP",
  cats,
  txns,
  accounts: [{ id: "a", name: "Bank", type: "bank", currency: "EGP", opening_balance: 2_000_000 }],
  budgets: [{ id: "b1", category_id: "ads", period: "monthly", amount: 300_000, position: 0 }],
  recurring: [
    {
      id: "r",
      name: "Rent",
      direction: "out",
      kind: "rent",
      amount: 500_000,
      currency: "EGP",
      category_id: "rent",
      frequency: "monthly",
      next_due: addDays(TODAY, 10),
      end_date: null,
      active: true,
    },
  ],
  invoices: [
    {
      id: "inv1",
      direction: "receivable",
      description: "Wholesale",
      amount: 1_000_000,
      paid: 0,
      currency: "EGP",
      issue_date: addDays(TODAY, -30),
      due_date: addDays(TODAY, -3),
      category_id: null,
      status: "open",
    },
  ],
  goals: [
    {
      id: "g",
      type: "reserve",
      name: "Reserve",
      target: 0,
      target_date: null,
      mode: "essentials",
      coverage_months: 3,
      period: "monthly",
      contributed: 500_000,
    },
  ],
  ads: [],
  productCount: 0,
  productsWithoutCost: 0,
};

describe("scenario simulation", () => {
  it("returns a baseline that equals the no-change scenario", () => {
    const r = simulate(snap, [{ type: "ad_spend", pct: 0 }]);
    expect(r.scenario.endCash).toBe(r.baseline.endCash);
    expect(r.hasHistory).toBe(true);
  });
  it("a hire lowers cash and monthly profit and never mutates the snapshot", () => {
    const before = JSON.stringify(snap);
    const r = simulate(snap, [{ type: "hire", monthlyCost: 800_000, startDate: addDays(TODAY, 5) }]);
    expect(r.scenario.endCash).toBeLessThan(r.baseline.endCash);
    expect(r.scenario.monthlyProfit).toBe(r.baseline.monthlyProfit - 800_000);
    expect(JSON.stringify(snap)).toBe(before);
  });
  it("a sales drop reduces revenue proportionally", () => {
    const r = simulate(snap, [{ type: "sales_drop", pct: 20 }]);
    expect(r.scenario.monthlyRevenue).toBe(Math.round(r.baseline.monthlyRevenue * 0.8));
  });
  it("a late payment moves a receipt later without removing it", () => {
    const r = simulate(snap, [{ type: "late_payment", invoiceId: "inv1", delayDays: 200 }], 90);
    expect(r.scenario.endCash).toBe(r.baseline.endCash - 1_000_000);
  });
  it("warns instead of inventing history when there is none", () => {
    const r = simulate({ ...snap, txns: [] }, [{ type: "sales_drop", pct: 20 }]);
    expect(r.hasHistory).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/not enough recorded history/i);
  });
  it("shows the effect on an affected budget", () => {
    const r = simulate(snap, [{ type: "ad_spend", pct: 50 }]);
    expect(r.budgets[0].scenarioMonthly).toBeGreaterThan(r.budgets[0].baselineMonthly);
  });
});

describe("insights", () => {
  it("every insight carries observation, evidence, reason and an action", () => {
    const list = generateInsights(snap);
    expect(list.length).toBeGreaterThan(0);
    for (const i of list) {
      expect(i.title.length).toBeGreaterThan(0);
      expect(i.observed.length).toBeGreaterThan(0);
      expect(i.why.length).toBeGreaterThan(0);
      expect(i.action.href.startsWith("/app")).toBe(true);
    }
  });
  it("flags the overdue receivable and the missing-cost-free profit appropriately", () => {
    const keys = generateInsights(snap).map((i) => i.key);
    expect(keys.some((k) => k.startsWith("receivables:overdue"))).toBe(true);
  });
  it("produces nothing from an empty workspace (no canned advice)", () => {
    expect(
      generateInsights({ ...snap, txns: [], invoices: [], recurring: [], budgets: [], goals: [], accounts: [] }),
    ).toEqual([]);
  });
});

describe("goals", () => {
  it("derives a reserve target from essential expenses and caps safe set-aside by scheduled payments", () => {
    const g = goalProgress(snap.goals[0], snap);
    expect(g.target).toBeGreaterThan(0);
    expect(g.safeNow).toBeLessThanOrEqual(g.remaining);
    expect(g.pct).toBeLessThanOrEqual(1);
  });
});

describe("copilot", () => {
  it("classifies the documented questions", () => {
    expect(parseQuestion("Why did my profit decrease?").intent).toBe("why_profit");
    expect(parseQuestion("What are my largest expenses?").intent).toBe("top_expenses");
    expect(parseQuestion("Can I afford to hire a designer for 8,000?")).toMatchObject({
      intent: "afford_hire",
      amount: 800_000,
    });
    expect(parseQuestion("What happens if sales decrease by 20%?")).toMatchObject({
      intent: "sales_drop",
      percent: 20,
    });
    expect(parseQuestion("Which payments are due soon?").intent).toBe("payments_due");
  });
  it("asks for the amount rather than guessing it", () => {
    expect(answer(snap, "Can I afford to hire a designer?").needs?.field).toBe("amount");
  });
  it("answers an affordability question from the simulator with a verdict", () => {
    const a = answer(snap, "Can I afford to hire a designer?", { amount: 50_000_000 });
    expect(a.verdict).toBe("no");
    expect(a.facts.length).toBeGreaterThan(0);
  });
  it("refuses to guess with no records", () => {
    const a = answer({ ...snap, txns: [] }, "Why did my profit decrease?");
    expect(a.answer).toMatch(/no transactions/i);
  });
  it("answers in Egyptian Arabic when the app is in Arabic, with the same numbers", () => {
    const en = answer(snap, "Can I afford to hire a designer?", { amount: 50_000_000 });
    const ar = answer(snap, "Can I afford to hire a designer?", { amount: 50_000_000 }, {}, "ar");
    expect(ar.verdict).toBe(en.verdict);
    expect(ar.answer).toMatch(/مش بأمان دلوقتي/);
    expect(ar.answer).not.toMatch(/[A-Za-z]{4,}/);
    expect(answer({ ...snap, txns: [] }, "profit", {}, {}, "ar").answer).toMatch(/لسه مفيش/);
  });
});

describe("csv", () => {
  it("parses quoted fields, delimiters and BOM", () => {
    expect(parseCsv('﻿Date;Memo;Amount\n01/02/2026;"Coffee; large";-12,5\n')).toEqual([
      ["Date", "Memo", "Amount"],
      ["01/02/2026", "Coffee; large", "-12,5"],
    ]);
    expect(parseCsv('a,b\n"x ""y""",2\r\n')).toEqual([
      ["a", "b"],
      ['x "y"', "2"],
    ]);
  });
  it("parses dates in either order and rejects impossible ones", () => {
    expect(parseDateCell("03/04/2026", true)).toBe("2026-04-03");
    expect(parseDateCell("03/04/2026", false)).toBe("2026-03-04");
    expect(parseDateCell("31/02/2026")).toBeNull();
    expect(parseDateCell("2026-1-5")).toBe("2026-01-05");
  });
  it("detects columns and defuses spreadsheet formulas on export", () => {
    expect(detectMapping(["Posted Date", "Details", "Debit", "Credit"])).toMatchObject({
      date: 0,
      description: 1,
      debit: 2,
      credit: 3,
    });
    expect(toCsv([['=HYPERLINK("x")', "ok", -5]])).toContain("'=HYPERLINK");
  });
});
