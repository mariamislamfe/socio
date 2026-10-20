import { describe, expect, it } from "vitest";
import { parseCommand, parseEntry } from "@/lib/finance/messageparse";

describe("recording money by chat message", () => {
  it.each([
    ["دفعت 500 شحن", "expense", 50_000, "Shipping & delivery"],
    ["صرفت ١٢٠٠ على اعلانات فيسبوك", "expense", 120_000, "Social ads"],
    ["بعت ب 1,250", "income", 125_000, "Sales"],
    ["استلمت 3 الف من عميل", "income", 300_000, "Sales"],
    ["500 شحن", "expense", 50_000, "Shipping & delivery"],
    ["paid 2k for ads", "expense", 200_000, "Social ads"],
    ["sold 750.5", "income", 75_050, "Sales"],
    ["دفعت الايجار 25000", "expense", 2_500_000, "Rent"],
    ["اشتريت قماش ب 8000", "expense", 800_000, "Inventory & materials"],
  ])("%s", (text, kind, amount, category) => {
    const p = parseEntry(text)!;
    expect(p).not.toBeNull();
    expect(p.kind).toBe(kind);
    expect(p.amount).toBe(amount);
    expect(p.category).toBe(category);
  });

  it("refuses messages without a clear amount or direction", () => {
    expect(parseEntry("ازيك عامل ايه")).toBeNull();
    expect(parseEntry("دفعت كتير النهارده")).toBeNull();
    expect(parseEntry("1500")).toBeNull(); // income or expense? unclear
  });

  it("an expense with an unknown purpose is recorded without a category", () => {
    const p = parseEntry("دفعت 300")!;
    expect(p.kind).toBe("expense");
    expect(p.category).toBeNull();
  });

  it("understands undo, help and balance", () => {
    expect(parseCommand("الغي")).toEqual({ command: "undo" });
    expect(parseCommand("undo")).toEqual({ command: "undo" });
    expect(parseCommand("مساعدة")).toEqual({ command: "help" });
    expect(parseCommand("الرصيد")).toEqual({ command: "balance" });
    expect(parseCommand("دفعت 500 شحن")).toBeNull();
  });
});
