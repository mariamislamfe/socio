import { describe, expect, it } from "vitest";
import { translateText } from "@/lib/i18n/eg";

describe("Egyptian Arabic", () => {
  it.each([
    ["Overview", "الرئيسية"],
    ["  Run all checks now ", "  افحص كل حاجة دلوقتي "],
    ["EGP 645,323", "645,323 جنيه"],
    ["−EGP 118K", "−118 ألف جنيه"],
    ["You need about EGP 31,333 by 2026-11-01", "محتاج حوالي 31,333 جنيه قبل 2026-11-01"],
    ["Cash may dip below your safety reserve on 2026-11-01", "الكاش ممكن ينزل تحت حد الأمان يوم 2026-11-01"],
    ["Mini keychain loses about EGP 93.16 on every sale", "ميدالية صغيرة بيخسّرك حوالي 93.16 جنيه في كل بيعة"],
    [
      "Costs 138% a year: you would pay back more than double over a year.",
      "بيكلف 138% في السنة: هترجّع أكتر من الضعف في سنة.",
    ],
    ["Inventory & materials may exceed its budget", "بضاعة وخامات ممكن يعدّي الميزانية"],
    ["2 overdue invoices", "2 فاتورة متأخرة"],
  ])("%s", (en, ar) => expect(translateText(en)).toBe(ar));

  it("leaves untranslated English intact (no half-translated sentences) and ignores non-English", () => {
    expect(translateText("Some brand new sentence with EGP 100 inside")).toBeNull();
    expect(translateText("مرحبا")).toBeNull();
    expect(translateText("2026-11-01")).toBeNull();
  });
});
