import { describe, it, expect } from "vitest";
import {
  accountBalances,
  budgetStatuses,
  forecast,
  summarize,
  summaryIssues,
  runway,
  typicalRates,
  type Account,
  type Cat,
  type Invoice,
  type Recurring,
  type Txn,
} from "@/lib/finance/engine";
import { formatMoney, toMinor, pct } from "@/lib/finance/money";
import { periodInfo, occurrences, addMonths } from "@/lib/finance/dates";

const cats: Cat[] = [
  { id: "sales", name: "Sales", kind: "income", cost_type: null, parent_id: null },
  { id: "inv", name: "Inventory", kind: "expense", cost_type: "cogs", parent_id: null },
  { id: "ads", name: "Advertising", kind: "expense", cost_type: "opex", parent_id: null, role: "ads" },
  { id: "rent", name: "Rent", kind: "expense", cost_type: "opex", parent_id: null, essential: true },
];
const accounts: Account[] = [
  { id: "bank", name: "Bank", type: "bank", currency: "EGP", opening_balance: 100_000 },
  { id: "cash", name: "Cash", type: "cash", currency: "EGP", opening_balance: 0 },
];
let n = 0;
const t = (p: Partial<Txn> & Pick<Txn, "type" | "amount" | "date">): Txn => ({
  id: `t${++n}`,
  currency: "EGP",
  account_id: "bank",
  to_account_id: null,
  category_id: null,
  direction: null,
  ...p,
});

describe("summarize", () => {
  const range = { from: "2026-03-01", to: "2026-03-31" };
  const txns: Txn[] = [
    t({ type: "income", amount: 500_000, date: "2026-03-05", category_id: "sales" }),
    t({ type: "refund", amount: 50_000, date: "2026-03-06", category_id: "sales" }),
    t({ type: "expense", amount: 200_000, date: "2026-03-07", category_id: "inv" }),
    t({ type: "expense", amount: 100_000, date: "2026-03-08", category_id: "ads" }),
    t({ type: "transfer", amount: 300_000, date: "2026-03-09", to_account_id: "cash" }),
    t({ type: "adjustment", amount: 1_000, date: "2026-03-10", direction: "out" }),
    t({ type: "income", amount: 9_999, date: "2026-02-28", category_id: "sales" }), // out of range
  ];
  const s = summarize(txns, cats, "EGP", range);

  it("net revenue subtracts customer refunds (refunds do not inflate revenue)", () => {
    expect(s.revenueGross).toBe(500_000);
    expect(s.refunds).toBe(50_000);
    expect(s.revenue).toBe(450_000);
  });
  it("transfers are never revenue or expense", () => {
    expect(s.transferCount).toBe(1);
    expect(s.revenueGross).toBe(500_000);
    expect(s.opex + s.cogs).toBe(300_000);
  });
  it("profit is distinct from cash", () => {
    expect(s.grossProfit).toBe(250_000);
    expect(s.netProfit).toBe(150_000);
    expect(s.netCash).toBe(500_000 - 50_000 - 200_000 - 100_000 - 1_000);
    expect(s.netProfit).not.toBe(s.netCash);
    expect(s.margin).toBeCloseTo(150_000 / 450_000, 6);
  });
  it("flags missing costs instead of presenting overstated profit as reliable", () => {
    const noCost = summarize([t({ type: "income", amount: 10_000, date: "2026-03-02" })], cats, "EGP", range);
    expect(noCost.incomplete).toBe(true);
    expect(summaryIssues(noCost).some((i) => i.code === "no_cogs")).toBe(true);
    expect(s.incomplete).toBe(false);
  });
  it("excludes other currencies rather than silently adding them", () => {
    const x = summarize(
      [t({ type: "income", amount: 5_000, currency: "USD", date: "2026-03-02" })],
      cats,
      "EGP",
      range,
    );
    expect(x.revenue).toBe(0);
    expect(x.excludedForeignCount).toBe(1);
  });
  it("supplier refunds reduce expenses and bring cash in", () => {
    const r = summarize(
      [
        t({ type: "expense", amount: 1000, date: "2026-03-02", category_id: "inv" }),
        t({ type: "refund", amount: 400, date: "2026-03-03", category_id: "inv" }),
      ],
      cats,
      "EGP",
      range,
    );
    expect(r.cogs).toBe(600);
    expect(r.refunds).toBe(0);
    expect(r.cashIn).toBe(400);
  });
});

describe("accountBalances", () => {
  it("transfers move money between accounts without changing the total", () => {
    const txns = [
      t({ type: "income", amount: 50_000, date: "2026-03-01", category_id: "sales" }),
      t({ type: "transfer", amount: 20_000, date: "2026-03-02", to_account_id: "cash" }),
      t({ type: "refund", amount: 5_000, date: "2026-03-03", category_id: "sales" }),
    ];
    const b = accountBalances(accounts, txns, cats, "2026-03-31");
    expect(b.find((x) => x.id === "bank")!.balance).toBe(100_000 + 50_000 - 20_000 - 5_000);
    expect(b.find((x) => x.id === "cash")!.balance).toBe(20_000);
    expect(b.reduce((a, x) => a + x.balance, 0)).toBe(100_000 + 50_000 - 5_000);
  });
  it("future-dated records are not yet in the balance", () => {
    const b = accountBalances(
      accounts,
      [t({ type: "expense", amount: 1_000, date: "2026-04-10" })],
      cats,
      "2026-03-31",
    );
    expect(b[0].balance).toBe(100_000);
  });
});

describe("budgets", () => {
  const today = "2026-03-12"; // 12 of 31 days elapsed
  const budgets = [{ id: "b1", category_id: "ads", period: "monthly" as const, amount: 100_000, position: 0 }];
  it("projects overspend from pace and flags risk", () => {
    const txns = [t({ type: "expense", amount: 60_000, date: "2026-03-05", category_id: "ads" })];
    const [s] = budgetStatuses({ budgets, cats, txns, recurring: [], invoices: [], currency: "EGP", today });
    expect(s.spent).toBe(60_000);
    expect(s.remaining).toBe(40_000);
    expect(s.projectedByPace).toBe(Math.round(60_000 / (12 / 31)));
    expect(s.status).toBe("at_risk");
  });
  it("counts scheduled payments in the same category as upcoming commitments", () => {
    const rec: Recurring[] = [
      {
        id: "r",
        name: "Agency",
        direction: "out",
        kind: "other",
        amount: 50_000,
        currency: "EGP",
        category_id: "ads",
        frequency: "monthly",
        next_due: "2026-03-20",
        end_date: null,
        active: true,
      },
    ];
    const [s] = budgetStatuses({
      budgets,
      cats,
      txns: [t({ type: "expense", amount: 10_000, date: "2026-03-02", category_id: "ads" })],
      recurring: rec,
      invoices: [],
      currency: "EGP",
      today,
    });
    expect(s.committed).toBe(60_000);
    expect(s.upcoming).toHaveLength(1);
  });
  it("marks over budget", () => {
    const [s] = budgetStatuses({
      budgets,
      cats,
      txns: [t({ type: "expense", amount: 120_000, date: "2026-03-02", category_id: "ads" })],
      recurring: [],
      invoices: [],
      currency: "EGP",
      today,
    });
    expect(s.status).toBe("over");
  });
});

describe("forecast", () => {
  const today = "2026-03-10";
  const rec: Recurring[] = [
    {
      id: "rent",
      name: "Rent",
      direction: "out",
      kind: "rent",
      amount: 30_000,
      currency: "EGP",
      category_id: "rent",
      frequency: "monthly",
      next_due: "2026-03-25",
      end_date: null,
      active: true,
    },
  ];
  const inv = (p: Partial<Invoice>): Invoice => ({
    id: "i",
    direction: "payable",
    description: "x",
    amount: 10_000,
    paid: 0,
    currency: "EGP",
    issue_date: "2026-03-01",
    due_date: "2026-03-15",
    category_id: null,
    status: "open",
    ...p,
  });
  it("applies scheduled outflows and detects the first shortfall with contributors", () => {
    const f = forecast({
      today,
      days: 60,
      startCash: 50_000,
      currency: "EGP",
      recurring: rec,
      invoices: [inv({ id: "p1", amount: 40_000, due_date: "2026-03-20", description: "Supplier" })],
    });
    expect(f.points[0].balance).toBe(50_000);
    expect(f.firstShortfallDate).toBe("2026-03-25");
    expect(f.shortfallContributors.map((c) => c.label)).toEqual(expect.arrayContaining(["Supplier", "Rent"]));
    expect(f.endCash).toBe(50_000 - 40_000 - 30_000 - 30_000); // rent Mar 25 and Apr 25
  });
  it("does not treat unpaid invoices as received cash", () => {
    const f = forecast({
      today,
      days: 5,
      startCash: 1_000,
      currency: "EGP",
      recurring: [],
      invoices: [inv({ id: "r1", direction: "receivable", amount: 90_000, due_date: "2026-03-30" })],
    });
    expect(f.endCash).toBe(1_000); // due after the horizon
  });
  it("partial payments only count the outstanding balance", () => {
    const f = forecast({
      today,
      days: 30,
      startCash: 0,
      currency: "EGP",
      recurring: [],
      invoices: [inv({ id: "r1", direction: "receivable", amount: 90_000, paid: 60_000, due_date: "2026-03-20" })],
    });
    expect(f.endCash).toBe(30_000);
  });
  it("does not double count a recurring bill that is already an open payable", () => {
    const f = forecast({
      today,
      days: 30,
      startCash: 100_000,
      currency: "EGP",
      recurring: [{ ...rec[0], payee_id: "landlord" }],
      invoices: [inv({ id: "p", amount: 30_000, due_date: "2026-03-26", payee_id: "landlord" })],
    });
    expect(f.suppressedDuplicates).toBe(1);
    expect(f.endCash).toBe(100_000 - 30_000);
  });
  it("is deterministic and does not mutate its inputs", () => {
    const frozen = JSON.stringify(rec);
    forecast({ today, days: 30, startCash: 0, currency: "EGP", recurring: rec, invoices: [] });
    expect(JSON.stringify(rec)).toBe(frozen);
  });
});

describe("rates and runway", () => {
  it("returns null with too little history instead of inventing a rate", () => {
    expect(
      typicalRates([t({ type: "income", amount: 100, date: "2026-03-09" })], cats, "EGP", "2026-03-10"),
    ).toBeNull();
  });
  it("computes runway only when cash is being consumed", () => {
    const burn = [
      t({ type: "income", amount: 100_000, date: "2026-01-12" }),
      t({ type: "expense", amount: 400_000, date: "2026-03-10" }),
    ];
    const r = runway(300_000, burn, cats, "EGP", "2026-03-10");
    expect(r.monthlyBurn).not.toBeNull();
    expect(r.months).toBeGreaterThan(0);
    const profit = runway(
      300_000,
      [t({ type: "income", amount: 500_000, date: "2026-01-12" })],
      cats,
      "EGP",
      "2026-03-10",
    );
    expect(profit.months).toBeNull();
  });
});

describe("money & dates", () => {
  it("parses decimals exactly without float error", () => {
    expect(toMinor("0.1", "EGP")).toBe(10);
    expect(toMinor("1,234.56", "EGP")).toBe(123_456);
    expect(toMinor("19.999", "EGP")).toBeNull();
    expect(toMinor("abc", "EGP")).toBeNull();
    expect(toMinor("1000", "JPY")).toBe(1000);
    expect(0.1 + 0.2).not.toBe(0.3); // why we do not use floats
  });
  it("formats and applies percentages in integers", () => {
    expect(formatMoney(123_456, "EGP")).toBe("EGP 1,235");
    expect(pct(100_000, 30)).toBe(130_000 - 100_000);
    expect(pct(100_000, -20)).toBe(-20_000);
  });
  it("handles month ends and period bounds", () => {
    expect(addMonths("2026-01-31", 1, 31)).toBe("2026-02-28");
    expect(occurrences("2026-01-31", "monthly", "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    const p = periodInfo("month", "2026-03-12");
    expect(p.totalDays).toBe(31);
    expect(p.elapsedDays).toBe(12);
    expect(p.previous).toEqual({ from: "2026-02-01", to: "2026-02-12" });
    expect(periodInfo("week", "2026-03-12").full.from).toBe("2026-03-09");
  });
});
