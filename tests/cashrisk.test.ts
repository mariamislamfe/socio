import { describe, expect, it } from "vitest";
import { analyzeCashRisk } from "@/lib/finance/cashrisk";
import { addDays } from "@/lib/finance/dates";
import type { Snapshot } from "@/lib/finance/snapshot";

const TODAY = "2026-03-20";
const base: Snapshot = {
  today: TODAY,
  currency: "EGP",
  cats: [],
  txns: [],
  budgets: [],
  recurring: [],
  goals: [],
  ads: [],
  productCount: 0,
  productsWithoutCost: 0,
  accounts: [{ id: "a", name: "Bank", type: "bank", currency: "EGP", opening_balance: 1_000_000 }],
  invoices: [
    {
      id: "bill",
      direction: "payable",
      description: "Supplier bill",
      amount: 1_500_000,
      paid: 0,
      currency: "EGP",
      issue_date: TODAY,
      due_date: addDays(TODAY, 10),
      category_id: null,
      status: "open",
    },
  ],
};
const quality = { integrations: [] };

describe("cash-risk options", () => {
  it("offers moving a bill when it delays the first dip, even if the lowest point is unchanged", () => {
    const a = analyzeCashRisk(base, { reserve: 0, horizonDays: 60, quality });
    expect(a.atRisk).toBe(true);
    expect(a.breachDate).toBe(addDays(TODAY, 10));
    const delay = a.options.find((o) => o.key === "delay_payable");
    expect(delay).toBeDefined();
    expect(delay!.impact).toBe(0);
    expect(delay!.buysTime).toBe(true);
    expect(delay!.newBreachDate).toBe(addDays(TODAY, 40));
    expect(delay!.execution.tool).toBe("reschedule_payable");
  });

  it("does not offer an option that neither raises the lowest point nor delays the dip", () => {
    // The customer already pays before the dip, so "collect it in 3 days" would only make things later, never better.
    const s: Snapshot = {
      ...base,
      invoices: [
        ...base.invoices,
        {
          id: "rcv",
          direction: "receivable",
          description: "Customer",
          amount: 100_000,
          paid: 0,
          currency: "EGP",
          issue_date: TODAY,
          due_date: addDays(TODAY, 2),
          category_id: null,
          status: "open",
        },
      ],
    };
    const a = analyzeCashRisk(s, { reserve: 0, horizonDays: 60, quality });
    expect(a.options.find((o) => o.key === "collect")).toBeUndefined();
    expect(a.options.every((o) => o.impact > 0 || o.buysTime)).toBe(true);
  });

  it("an option that lifts the lowest point is ranked by its real effect", () => {
    const s: Snapshot = {
      ...base,
      invoices: [
        ...base.invoices,
        {
          id: "rcv",
          direction: "receivable",
          description: "Customer",
          amount: 700_000,
          paid: 0,
          currency: "EGP",
          issue_date: TODAY,
          due_date: addDays(TODAY, 30),
          category_id: null,
          status: "open",
        },
      ],
    };
    const a = analyzeCashRisk(s, { reserve: 0, horizonDays: 60, quality });
    const collect = a.options.find((o) => o.key === "collect")!;
    expect(collect.impact).toBeGreaterThan(0);
    expect(collect.resolves).toBe(true); // 1.0M + 0.7M (in 3 days) − 1.5M stays above zero
    expect(a.options[0].key).toBe("collect");
  });
});
