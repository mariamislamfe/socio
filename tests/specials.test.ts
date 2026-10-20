import { describe, expect, it } from "vitest";
import { codLine, codSummary, type CodBatch } from "@/lib/finance/cod";
import { readTaxProfile, taxChecklist, taxStatusLine, type TaxProfile } from "@/lib/finance/taxsetup";

const EGP = (n: number) => n * 100;
const all = (a: TaxProfile[keyof Omit<TaxProfile, "updatedAt">]): TaxProfile => ({
  commercialRegister: a,
  taxCard: a,
  etaPortal: a,
  vatRegistered: a,
  simplifiedRegime: a,
  eInvoicing: a,
});

describe("taxes & papers", () => {
  it("nothing is known (and nothing estimated) until the owner answers", () => {
    const c = taxChecklist(null, EGP(300_000));
    expect(c.known).toBe(false);
    expect(taxStatusLine(c, "en")).toMatch(/not estimating any tax/);
    expect(taxStatusLine(c, "ar")).toMatch(/مش بحسب أي ضرايب/);
  });

  it("a beginner with no papers starts with the commercial register", () => {
    const c = taxChecklist(all("no"), EGP(200_000));
    expect(c.next?.id).toBe("commercial_register");
    expect(c.next?.how.ar.length).toBeGreaterThan(1);
    // under the VAT threshold and not registered: VAT is not needed yet
    expect(c.steps.find((s) => s.id === "vat")?.status).toBe("not_needed");
  });

  it("someone halfway continues from where they stopped", () => {
    const p: TaxProfile = { ...all("no"), commercialRegister: "yes", taxCard: "in_progress" };
    expect(taxChecklist(p, EGP(200_000)).next?.id).toBe("tax_card");
  });

  it("sales above the threshold make VAT registration a to-do", () => {
    const p: TaxProfile = { ...all("yes"), vatRegistered: "no", simplifiedRegime: "no", eInvoicing: "no" };
    const vat = taxChecklist(p, EGP(750_000)).steps.find((s) => s.id === "vat")!;
    expect(vat.status).toBe("todo");
    expect(vat.why.en).toMatch(/above the EGP 500,000/);
  });

  it("e-invoicing is needed once VAT-registered", () => {
    const p: TaxProfile = { ...all("yes"), eInvoicing: "no" };
    expect(taxChecklist(p, EGP(900_000)).steps.find((s) => s.id === "e_invoicing")?.status).toBe("todo");
  });

  it("the simplified regime does not apply above EGP 20 million", () => {
    const p: TaxProfile = { ...all("yes"), simplifiedRegime: "no" };
    expect(taxChecklist(p, EGP(25_000_000)).steps.find((s) => s.id === "simplified_regime")?.status).toBe("not_needed");
  });

  it("bad stored values are read as 'not sure'", () => {
    expect(readTaxProfile({ taxProfile: { commercialRegister: "maybe" } })?.commercialRegister).toBe("not_sure");
    expect(readTaxProfile({})).toBeNull();
  });
});

describe("money with couriers (COD)", () => {
  const b = (courier: string, amount: number, expectedOn: string, paid = 0): CodBatch => ({
    id: courier + expectedOn,
    courier,
    amount: EGP(amount),
    paid: EGP(paid),
    fees: EGP(50),
    orders: 5,
    deliveredOn: "2026-10-01",
    expectedOn,
    status: "open",
  });
  const today = "2026-10-20";
  const s = codSummary(
    [
      b("Mylerz", 8_960, "2026-10-11"),
      b("Bosta", 6_200, "2026-10-30"),
      b("J&T Express", 4_350, "2026-11-01"),
      b("Bosta", 1_000, "2026-10-05", 1_000),
    ],
    today,
  );

  it("totals what couriers still hold, ignoring paid batches", () => {
    expect(s.held).toBe(EGP(8_960 + 6_200 + 4_350));
    expect(s.open).toHaveLength(3);
  });
  it("flags the late courier first", () => {
    expect(s.late).toBe(EGP(8_960));
    expect(s.worst?.courier).toBe("Mylerz");
    expect(s.worst?.oldestLateDays).toBe(9);
    expect(s.couriers[0].courier).toBe("Mylerz");
  });
  it("knows the next payout", () =>
    expect(s.nextPayout).toMatchObject({ courier: "Bosta", date: "2026-10-30", amount: EGP(6_200) }));
  it("says what to do, in Egyptian Arabic too", () => {
    const fm = (v: number) => `${v / 100}`;
    expect(codLine(s, "en", fm)).toMatch(/Mylerz is late on 8960/);
    expect(codLine(s, "ar", fm)).toMatch(/Mylerz متأخرة في 8960 بقالها 9 يوم/);
    expect(codLine(codSummary([], today), "ar", fm)).toMatch(/مفيش فلوس/);
  });
});
