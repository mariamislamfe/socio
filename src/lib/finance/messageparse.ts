// Turns a short chat message ("دفعت 500 شحن", "بعت ب 1200", "paid 2k ads") into a ledger entry. Deterministic: no AI,
// so the same message always records the same thing. Returns null when the amount or direction is unclear.

export type ParsedKind = "expense" | "income";
export interface ParsedEntry {
  kind: ParsedKind;
  amount: number; // minor units
  category: string | null; // seed category name
  label: string; // human description, in the language of the message
  lang: "ar" | "en";
}
export type ParsedCommand = { command: "undo" } | { command: "help" } | { command: "balance" };

const AR_DIGITS: Record<string, string> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
  "٫": ".",
  "٬": "",
};

const EXPENSE = [
  "دفعت",
  "صرفت",
  "اشتريت",
  "شريت",
  "دفع",
  "مصروف",
  "مصاريف",
  "سددت",
  "حولت ل",
  "paid",
  "spent",
  "bought",
  "pay ",
  "expense",
];
const INCOME = [
  "بعت",
  "بيعت",
  "استلمت",
  "قبضت",
  "دخلي",
  "دخل",
  "جالي",
  "حصلت",
  "اتحصل",
  "مبيعات",
  "بيعة",
  "sold",
  "received",
  "got paid",
  "income",
  "sale",
];

const CATEGORIES: [string[], string, string, string][] = [
  // keywords, seed category, Arabic label, English label
  [["شحن", "مندوب", "توصيل", "بوسطة", "shipping", "delivery", "courier"], "Shipping & delivery", "شحن", "shipping"],
  [
    [
      "اعلان",
      "إعلان",
      "اعلانات",
      "إعلانات",
      "فيسبوك",
      "فيس",
      "ميتا",
      "انستا",
      "تيك توك",
      "تيكتوك",
      "ads",
      "ad ",
      "facebook",
      "meta",
      "instagram",
      "tiktok",
    ],
    "Social ads",
    "إعلانات",
    "ads",
  ],
  [["ايجار", "إيجار", "rent"], "Rent", "إيجار", "rent"],
  [["مرتب", "مرتبات", "رواتب", "مرتّب", "salary", "salaries", "wages"], "Salaries", "مرتبات", "salaries"],
  [["فريلانسر", "مصمم", "مصممة", "freelancer", "designer"], "Freelancers", "فريلانسر", "freelancer"],
  [
    ["خامات", "خامة", "قماش", "بضاعة", "بضاعه", "مخزون", "stock", "inventory", "materials", "fabric"],
    "Inventory & materials",
    "بضاعة وخامات",
    "stock & materials",
  ],
  [["تغليف", "علب", "كراتين", "باكدج", "packaging", "boxes"], "Packaging", "تغليف", "packaging"],
  [
    ["كهربا", "كهرباء", "نت ", "انترنت", "إنترنت", "مياه", "utilities", "electricity", "internet"],
    "Utilities",
    "كهربا ونت",
    "utilities",
  ],
  [
    ["اشتراك", "شوبيفاي", "subscription", "software", "shopify"],
    "Software & subscriptions",
    "اشتراكات",
    "subscriptions",
  ],
  [["ضريبة", "ضرايب", "ضرائب", "tax", "vat"], "Taxes", "ضرايب", "taxes"],
  [["عمولة", "رسوم", "فوري", "fee", "fees", "commission"], "Payment & platform fees", "رسوم وعمولات", "fees"],
];

function normalize(text: string) {
  return text
    .replace(/[٠-٩٫٬]/g, (d) => AR_DIGITS[d] ?? d)
    .replace(/[أإآ]/g, "ا")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function parseCommand(text: string): ParsedCommand | null {
  const t = normalize(text);
  // (\s|$) instead of \b: JavaScript word boundaries do not work with Arabic letters.
  if (/^(الغي|الغى|امسح|undo|cancel|delete)(\s|$)/.test(t)) return { command: "undo" };
  if (/^(مساعدة|ساعدني|help|\?|؟)$/.test(t)) return { command: "help" };
  if (/^(رصيد|الرصيد|كام معايا|معايا كام|balance|cash)\??$/.test(t)) return { command: "balance" };
  return null;
}

export function parseEntry(text: string, digits = 2): ParsedEntry | null {
  const raw = text.trim();
  const t = normalize(raw);
  const lang: "ar" | "en" = /[؀-ۿ]/.test(raw) ? "ar" : "en";
  // Amount: first number, with optional thousands separators, decimals, and "k" / "الف" / "ألف" multiplier.
  const m = t.match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k|الف|آلاف|الاف|ألف)?/);
  if (!m) return null;
  let value = Number(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""));
  if (m[3]) value *= 1000;
  if (!Number.isFinite(value) || value <= 0 || value > 1e10) return null;
  const amount = Math.round(value * 10 ** digits);
  const has = (words: string[]) =>
    words.some((w) => t.includes(normalize(w)) || ` ${t} `.includes(` ${normalize(w).trim()} `));
  const isIncome = has(INCOME);
  const isExpense = has(EXPENSE);
  let cat: [string[], string, string, string] | undefined = CATEGORIES.find(([words]) => has(words));
  let kind: ParsedKind | null = isIncome && !isExpense ? "income" : isExpense && !isIncome ? "expense" : null;
  // No verb but a cost category ("500 شحن") → an expense.
  if (!kind && cat) kind = "expense";
  if (!kind) return null;
  if (kind === "income") cat = undefined;
  const label =
    kind === "income"
      ? lang === "ar"
        ? "مبيعات"
        : "sales"
      : cat
        ? lang === "ar"
          ? cat[2]
          : cat[3]
        : lang === "ar"
          ? "مصروف"
          : "expense";
  return { kind, amount, category: kind === "income" ? "Sales" : cat ? cat[1] : null, label, lang };
}
