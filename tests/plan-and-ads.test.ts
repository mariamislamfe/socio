import { describe, expect, it } from "vitest";
import { judgeCampaign, planAd } from "@/lib/finance/adplan";
import { addDays } from "@/lib/finance/dates";
import type { Cat, Txn } from "@/lib/finance/engine";
import { financingReadiness } from "@/lib/finance/financing";
import { moneyPlan } from "@/lib/finance/moneyplan";
import type { ProductEconomics } from "@/lib/finance/profit";
import type { Snapshot } from "@/lib/finance/snapshot";

const TODAY = "2026-03-20";
const cats: Cat[] = [
  { id: "sales", name: "Sales", kind: "income", cost_type: null, parent_id: null },
  { id: "inv", name: "Inventory", kind: "expense", cost_type: "cogs", parent_id: null, role: "inventory" },
  { id: "rent", name: "Rent", kind: "expense", cost_type: "opex", parent_id: null, role: "rent" },
  { id: "own", name: "Owner's pay", kind: "expense", cost_type: null, parent_id: null, role: "owner_draw" },
];
const base = { currency: "EGP", account_id: "a", to_account_id: null, direction: null } as const;
function history(days = 120, draw = 0): Txn[] {
  const t: Txn[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(TODAY, -i);
    t.push({ ...base, id: `s${i}`, type: "income", date: d, amount: 100_000, category_id: "sales" }); // 1,000/day
    if (i % 10 === 0) t.push({ ...base, id: `c${i}`, type: "expense", date: d, amount: 300_000, category_id: "inv" });
    if (i % 30 === 0) t.push({ ...base, id: `r${i}`, type: "expense", date: d, amount: 500_000, category_id: "rent" });
  }
  if (draw) t.push({ ...base, id: "draw", type: "expense", date: TODAY, amount: draw, category_id: "own" });
  return t;
}
const snap = (txns: Txn[], opening = 5_000_000): Snapshot => ({
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
  accounts: [{ id: "a", name: "Bank", type: "bank", currency: "EGP", opening_balance: opening }],
});

describe("money plan", () => {
  it("owner pay is a share of real profit and never counted as a business cost", () => {
    const p = moneyPlan(snap(history(120, 400_000)), { tax: {}, reserve: 0, plan: { ownerPayPct: 50 } });
    expect(p.numbers.ownerTook).toBe(400_000);
    // Profit is unchanged by the owner's draw.
    const p0 = moneyPlan(snap(history(120)), { tax: {}, reserve: 0, plan: { ownerPayPct: 50 } });
    expect(p.numbers.profit).toBe(p0.numbers.profit);
    expect(p.owner.status).toBe("ok");
    expect(p.owner.suggestedMonthly).toBe(Math.round((p.owner.avgMonthlyProfit as number) * 0.5));
    expect(p.owner.canTakeNow).toBe(Math.max(0, p.owner.suggestedMonthly - 400_000));
  });
  it("when cash is needed for the reserve, the owner is told to wait even if the business is profitable", () => {
    const p = moneyPlan(snap(history(120), -2_000_000), { tax: {}, reserve: 50_000_000, plan: {} });
    expect(p.owner.status).toBe("wait");
    expect(p.owner.canTakeNow).toBe(0);
    expect(p.business.canSpend).toBe(0);
  });
  it("every 100 of sales splits into costs, taxes, owner pay and what stays (sums to ~100)", () => {
    const p = moneyPlan(snap(history(120)), { tax: { vatRegistered: true }, reserve: 0, plan: {} });
    const total = p.slices.reduce((a, s) => a + s.per100, 0);
    expect(Math.abs(total - 100)).toBeLessThan(0.5);
    expect(p.slices.find((s) => s.key === "tax")!.per100).toBeCloseTo(12.3, 0); // 14/114 of sales
  });
});

describe("media buyer plan", () => {
  const prods: ProductEconomics[] = [
    {
      key: "good",
      title: "Shirt",
      sku: null,
      units: 50,
      revenue: 5_000_000,
      cogs: 2_000_000,
      variableCosts: 500_000,
      contribution: 2_500_000,
      margin: 0.5,
      costKnown: true,
    },
    {
      key: "bad",
      title: "Keychain",
      sku: null,
      units: 30,
      revenue: 360_000,
      cogs: 210_000,
      variableCosts: 300_000,
      contribution: -150_000,
      margin: -0.4,
      costKnown: true,
    },
  ];
  const input = {
    currency: "EGP",
    budget: 200_000,
    days: 5,
    country: "EG",
    dialect: "egyptian" as const,
    goal: "sales" as const,
    businessType: "fashion",
    products: prods,
    canSpend: 1_000_000,
    cashRiskBreach: null,
    history: null,
  };
  it("advertises a product that earns money, with the break-even cost per sale from its margin", () => {
    const p = planAd(input);
    expect(p.product?.key).toBe("good");
    expect(p.maxCostPerSale).toBe(50_000);
    expect(p.targetCostPerSale).toBe(35_000);
    expect(p.affordable.level).toBe("ok");
    expect(p.dailyBudget).toBe(40_000);
  });
  it("warns when the business cannot afford it, or the chosen product loses money", () => {
    expect(planAd({ ...input, canSpend: 50_000 }).affordable.level).toBe("tight");
    expect(planAd({ ...input, cashRiskBreach: "2026-04-01" }).affordable.level).toBe("no");
    expect(planAd({ ...input, productKey: "bad" }).warnings.join(" ")).toMatch(/loses money/);
  });
  it("follow-up: learns first, pauses losers, suggests scaling winners", () => {
    const plan = { maxCostPerSale: 50_000, targetCostPerSale: 35_000 };
    expect(judgeCampaign({ spend: 20_000, sales: 0, clicks: 10 }, plan, 200_000).verdict).toBe("learning");
    expect(judgeCampaign({ spend: 120_000, sales: 0, clicks: 90 }, plan, 200_000).verdict).toBe("pause");
    expect(judgeCampaign({ spend: 140_000, sales: 2, clicks: 90 }, plan, 200_000).verdict).toBe("pause"); // 70k per sale > 60k
    expect(judgeCampaign({ spend: 150_000, sales: 6, clicks: 200 }, plan, 200_000).verdict).toBe("scale"); // 25k per sale
    expect(judgeCampaign({ spend: 150_000, sales: null, clicks: 200 }, plan, 200_000).verdict).toBe("unknown");
  });
});

describe("financing readiness", () => {
  it("scores track record, profit, data, collections, cushion and legal basics — with what to improve", () => {
    const r = financingReadiness(snap(history(200)), { reserve: 0, legalDone: 1, legalTotal: 2, integrations: [] });
    expect(r.score).toBeGreaterThan(60);
    expect(r.checks.find((c) => c.key === "profit")!.ok).toBe(true);
    expect(r.checks.find((c) => c.key === "legal")!.how).toMatch(/papers/);
    const young = financingReadiness(snap(history(40)), { reserve: 0, legalDone: 0, legalTotal: 0, integrations: [] });
    expect(young.checks.find((c) => c.key === "history")!.ok).toBe(false);
    expect(young.score).toBeLessThan(r.score);
  });
});
