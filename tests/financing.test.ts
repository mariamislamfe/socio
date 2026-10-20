import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/finance/dates";
import { analyzeOffers, effectiveApr, offerFlows, redFlags, type Offer } from "@/lib/finance/financing";
import { buildLenderPack } from "@/lib/finance/lenderpack";
import type { Snapshot } from "@/lib/finance/snapshot";

const TODAY = "2026-03-20";
const offer = (o: Partial<Offer>): Offer => ({
  id: "o",
  lender: "L",
  kind: "term_loan",
  amount: 1_000_000,
  upfrontFee: 0,
  ratePct: null,
  flatFee: null,
  termDays: 365,
  repayment: "bullet",
  revenueSharePct: null,
  flags: {},
  ...o,
});

describe("true cost of an offer", () => {
  it("a 1-year bullet loan at 20% simple interest has an effective rate of ~20%", () => {
    const apr = effectiveApr(offerFlows(offer({ ratePct: 20 }), TODAY, 0))!;
    expect(apr).toBeGreaterThan(0.199);
    expect(apr).toBeLessThan(0.201);
  });
  it("an upfront fee raises the effective rate above the quoted one", () => {
    const apr = effectiveApr(offerFlows(offer({ ratePct: 20, upfrontFee: 50_000 }), TODAY, 0))!;
    expect(apr).toBeGreaterThan(0.25);
  });
  it("a '15% fee' repaid from daily sales in ~2 months is far more than 15% a year, and is called out", () => {
    const o = offer({
      kind: "revenue_advance",
      flatFee: 150_000,
      repayment: "daily_sales",
      revenueSharePct: 20,
      termDays: 60,
    });
    const flows = offerFlows(o, TODAY, 100_000); // 20% of 100k a day = 20k/day → ~58 days
    const apr = effectiveApr(flows)!;
    expect(apr).toBeGreaterThan(1);
    expect(
      redFlags(o, apr)
        .map((f) => f.text)
        .join(" "),
    ).toMatch(/true annual cost/);
  });
  it("installments add up to exactly the total owed", () => {
    const flows = offerFlows(offer({ ratePct: 12, repayment: "monthly", termDays: 180 }), TODAY, 0);
    const repaid = -flows.slice(1).reduce((a, f) => a + f.amount, 0);
    expect(repaid).toBe(1_000_000 + Math.round((1_000_000 * 12 * 180) / 36500));
    expect(flows.length).toBe(7);
  });
  it("classic scam signs are dangers regardless of price", () => {
    const f = redFlags(
      offer({ ratePct: 10, flags: { upfrontPaymentRequested: true, personalAccountPayment: true } }),
      0.1,
    );
    expect(f.filter((x) => x.level === "danger").length).toBe(2);
  });
});

describe("choosing an offer", () => {
  const s: Snapshot = {
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
    accounts: [{ id: "a", name: "Bank", type: "bank", currency: "EGP", opening_balance: 500_000 }],
    invoices: [
      {
        id: "bill",
        direction: "payable",
        description: "Stock",
        amount: 800_000,
        paid: 0,
        currency: "EGP",
        issue_date: TODAY,
        due_date: addDays(TODAY, 10),
        category_id: null,
        status: "open",
      },
      {
        id: "rcv",
        direction: "receivable",
        description: "Big order",
        amount: 1_500_000,
        paid: 0,
        currency: "EGP",
        issue_date: TODAY,
        due_date: addDays(TODAY, 70),
        category_id: null,
        status: "open",
      },
    ],
  };
  it("finds the gap, and prefers the offer that stays safe after repayments over the cheapest one", () => {
    const r = analyzeOffers(
      s,
      [
        offer({ id: "cheap_early", lender: "Cheap but due in 30 days", amount: 400_000, ratePct: 10, termDays: 30 }),
        offer({ id: "safe", lender: "Due after the customer pays", amount: 400_000, ratePct: 25, termDays: 90 }),
        offer({
          id: "scam",
          lender: "Scam",
          amount: 400_000,
          ratePct: 5,
          termDays: 90,
          flags: { upfrontPaymentRequested: true },
        }),
      ],
      0,
    );
    expect(r.need.atRisk).toBe(true);
    expect(r.need.amount).toBe(300_000); // 500k − 800k on day 10
    const byId = Object.fromEntries(r.offers.map((o) => [o.offer.id, o]));
    expect(byId.cheap_early.covers).toBe(false); // repaying on day 30 creates a new dip before the receivable arrives
    expect(byId.safe.verdict).toBe("best");
    expect(byId.scam.verdict).toBe("avoid");
    expect(r.offers[0].offer.id).toBe("safe");
  });
  it("the lender pack is built from records, with a 13-week forecast and aging", () => {
    const p = buildLenderPack({
      s,
      business: { name: "B", type: null, country: "EG", currency: "EGP", timezone: "Africa/Cairo" },
      quality: { integrations: [] },
      sources: ["test"],
    });
    expect(p.weeks).toHaveLength(13);
    expect(p.cash.total).toBe(500_000);
    expect(p.payables.find((x) => x.bucket === "Not yet due")!.amount).toBe(800_000);
    expect(p.request).toBeNull();
  });
});
