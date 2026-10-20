import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/finance/dates";
import { detectAdsBurn, detectProductLoss, detectTaxSetAside, taxPosition } from "@/lib/finance/detectors";
import type { Cat, Txn } from "@/lib/finance/engine";
import type { ProductEconomics } from "@/lib/finance/profit";
import type { Snapshot } from "@/lib/finance/snapshot";

const TODAY = "2026-03-20";
const cats: Cat[] = [
  { id: "sales", name: "Sales", kind: "income", cost_type: null, parent_id: null },
  { id: "inv", name: "Inventory", kind: "expense", cost_type: "cogs", parent_id: null, role: "inventory" },
  { id: "ads", name: "Ads", kind: "expense", cost_type: "opex", parent_id: null, role: "ads" },
  { id: "tax", name: "Taxes", kind: "expense", cost_type: "opex", parent_id: null },
];
const base = { currency: "EGP", account_id: "a", to_account_id: null, direction: null } as const;
function snap(txns: Txn[], opening = 1_000_000): Snapshot {
  return {
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
  };
}
const p = (o: Partial<ProductEconomics> & { key: string }): ProductEconomics => ({
  title: o.key,
  sku: null,
  units: 10,
  revenue: 100_000,
  cogs: 40_000,
  variableCosts: 10_000,
  contribution: 50_000,
  margin: 0.5,
  costKnown: true,
  ...o,
});

describe("product loss", () => {
  it("flags a product that loses money before advertising, with a break-even price", () => {
    const f = detectProductLoss({
      currency: "EGP",
      rangeDays: 30,
      revenue: 1_000_000,
      ads: 0,
      products: [
        p({ key: "good" }),
        p({
          key: "keychain",
          units: 20,
          revenue: 240_000,
          cogs: 140_000,
          variableCosts: 200_000,
          contribution: -100_000,
        }),
      ],
    });
    expect(f?.kind).toBe("product_loss");
    expect(f?.severity).toBe("warning"); // certain: loses before ads
    expect(f?.title).toContain("keychain");
    const raise = f!.options.find((o) => o.key === "raise_price")!;
    expect(raise.monthlyProfitImpact).toBe(100_000); // removes the monthly loss at today's volume
  });

  it("does not flag products with unknown costs or tiny volumes, and nothing when all products earn", () => {
    expect(
      detectProductLoss({
        currency: "EGP",
        rangeDays: 30,
        revenue: 500_000,
        ads: 0,
        products: [p({ key: "a" }), p({ key: "b", costKnown: false, cogs: null, contribution: null })],
      }),
    ).toBeNull();
    expect(
      detectProductLoss({
        currency: "EGP",
        rangeDays: 30,
        revenue: 500_000,
        ads: 0,
        products: [p({ key: "tiny", units: 2, contribution: -5_000 })],
      }),
    ).toBeNull();
  });

  it("an ad share can turn a thin product into a loss, flagged as an allocation (info, not certain)", () => {
    const f = detectProductLoss({
      currency: "EGP",
      rangeDays: 30,
      revenue: 200_000,
      ads: 100_000,
      products: [
        p({ key: "thin", revenue: 100_000, contribution: 10_000 }),
        p({ key: "ok", revenue: 100_000, contribution: 90_000 }),
      ],
    });
    expect(f?.severity).toBe("info");
    expect(f?.unknowns.join(" ")).toMatch(/share of sales/);
  });
});

describe("ad spend that does not pay off", () => {
  const history = (adBoost: number, salesBoost: number) => {
    const t: Txn[] = [];
    let n = 0;
    for (let i = 89; i >= 0; i--) {
      const d = addDays(TODAY, -i);
      const recent = i < 28;
      t.push({
        ...base,
        id: `s${n++}`,
        type: "income",
        date: d,
        amount: Math.round(100_000 * (recent ? salesBoost : 1)),
        category_id: "sales",
      });
      if (i % 7 === 0)
        t.push({
          ...base,
          id: `a${n++}`,
          type: "expense",
          date: d,
          amount: Math.round(200_000 * (recent ? adBoost : 1)),
          category_id: "ads",
        });
      if (i % 10 === 0)
        t.push({ ...base, id: `c${n++}`, type: "expense", date: d, amount: 300_000, category_id: "inv" });
    }
    return t;
  };
  it("flags spend that rose without enough extra sales to pay for it", () => {
    const f = detectAdsBurn(snap(history(1.8, 1.02)));
    expect(f?.kind).toBe("ads_burn");
    expect(f!.metrics.find((m) => m.label === "Return on extra spend")!.value).toBeLessThan(
      f!.metrics.find((m) => m.label === "Needed to break even")!.value,
    );
    expect(f!.options[0].monthlyProfitImpact).toBeGreaterThan(0);
  });
  it("stays quiet when the extra spend paid for itself, or spend did not rise", () => {
    expect(detectAdsBurn(snap(history(1.5, 1.6)))).toBeNull();
    expect(detectAdsBurn(snap(history(1, 1)))).toBeNull();
  });
});

describe("tax set-aside", () => {
  const sales = (amountPerDay: number, extra: Txn[] = []) => {
    const t: Txn[] = [...extra];
    for (let i = 49; i >= 0; i--)
      t.push({
        ...base,
        id: `s${i}`,
        type: "income",
        date: addDays(TODAY, -i),
        amount: amountPerDay,
        category_id: "sales",
      });
    return t;
  };
  it("computes VAT inside VAT-inclusive sales: 14/114 of this month plus unpaid last month", () => {
    const pos = taxPosition(snap(sales(114_000)), { vatRegistered: true })!;
    expect(pos.vatThisMonth).toBe(20 * 14_000); // 20 days of March so far
    expect(pos.vatLastMonth).toBe(28 * 14_000); // February
    expect(pos.vatOwed).toBe(pos.vatThisMonth + pos.vatLastMonth);
  });
  it("treats last month as paid once a tax payment is recorded this month", () => {
    const paid: Txn = { ...base, id: "t", type: "expense", date: "2026-03-10", amount: 392_000, category_id: "tax" };
    const pos = taxPosition(snap(sales(114_000, [paid])), { vatRegistered: true })!;
    expect(pos.lastMonthPaid).toBe(true);
    expect(pos.vatOwed).toBe(pos.vatThisMonth);
  });
  it("warns critically when the tax money has effectively been spent", () => {
    const f = detectTaxSetAside(snap(sales(114_000), -5_200_000), { vatRegistered: true }, null, 0)!;
    expect(f.severity).toBe("critical");
    expect(f.options.find((o) => o.key === "set_aside")?.execution.tool).toBe("create_tax_reserve");
  });
  it("says nothing for a business that is not VAT-registered and set no income-tax reserve", () => {
    expect(detectTaxSetAside(snap(sales(114_000)), { vatRegistered: false }, null, 0)).toBeNull();
  });
});
