// Egypt requirements catalogue.
//
// IMPORTANT: this is a guide, not legal advice, and it is deliberately conservative:
//  - every item carries a confidence level and an official source to check;
//  - no government fee is hard-coded (fees change and differ by governorate). Users record what they actually paid.
//  - "planningDefault" dates are Socio planning dates, not legal deadlines, and are labelled that way in the UI.
// Items last reviewed against public sources on `REVIEWED_ON`. Update the entries, not the engine, when rules change.

import { addDays, addMonths, endOfMonth, startOfMonth, type ISODate } from "../finance/dates";

export const REVIEWED_ON = "2026-10-14";

export type ReqKind = "required" | "check" | "recommended" | "internal";
export type Confidence = "official" | "indicative";

export interface Requirement {
  key: string;
  kind: ReqKind;
  title: string;
  titleAr: string;
  authority: string;
  cadence: "once" | "monthly" | "annual";
  /* * How the due date is placed in a period. `none` means the date depends on the entity and must be confirmed. */
  due: { rule: "end_of_next_month" | "day_of_next_month" | "none"; day?: number; planningDefault: boolean };
  what: string;
  why: string;
  steps: string[];
  documents: string[];
  feeNote: string;
  source: { label: string; url: string };
  confidence: Confidence;
  caveat?: string;
}

const FEE_NOTE = "Fees change and vary by office. Check the official page, then record what you actually paid here.";

export const EGYPT: Requirement[] = [
  {
    key: "eg.commercial_register",
    kind: "required",
    cadence: "once",
    authority: "Commercial Register office / GAFI (companies)",
    title: "Commercial register",
    titleAr: "السجل التجاري",
    due: { rule: "none", planningDefault: false },
    what: "The record that registers your trade or company. Most other registrations (tax card, e-invoicing, insurance) depend on it.",
    why: "Operating without it can block bank accounts, platform payouts, supplier credit and tax registration.",
    steps: [
      "Pick your legal form (individual trader or company).",
      "Reserve the trade name.",
      "Submit the application through the one-stop service or the commercial register office.",
      "Keep the certificate: you will need it for the tax card and your bank.",
    ],
    documents: [
      "National ID of owner/partners",
      "Proof of business address",
      "Trade name reservation",
      "Company articles (for companies)",
    ],
    feeNote: FEE_NOTE,
    source: { label: "GAFI — eServices", url: "https://www.gafi.gov.eg" },
    confidence: "indicative",
    caveat: "Requirements differ between an individual trader and a company, and by governorate.",
  },
  {
    key: "eg.tax_card",
    kind: "required",
    cadence: "once",
    authority: "Egyptian Tax Authority (ETA)",
    title: "Tax registration (tax card)",
    titleAr: "البطاقة الضريبية",
    due: { rule: "none", planningDefault: false },
    what: "Registers the business with the Egyptian Tax Authority so you can file and issue valid invoices.",
    why: "It is the base for income tax, VAT and e-invoicing, and many buyers and platforms ask for it.",
    steps: [
      "Complete the commercial register first.",
      "Register with the ETA (online portal or tax office).",
      "Keep your tax registration number on invoices.",
    ],
    documents: ["Commercial register extract", "National ID", "Lease or address proof"],
    feeNote: FEE_NOTE,
    source: { label: "Egyptian Tax Authority", url: "https://www.eta.gov.eg" },
    confidence: "indicative",
  },
  {
    key: "eg.msme_regime",
    kind: "check",
    cadence: "once",
    authority: "MSMEDA / Egyptian Tax Authority",
    title: "Check if the small-business tax regime fits you",
    titleAr: "هل نظام المشروعات الصغيرة مناسب لك؟",
    due: { rule: "none", planningDefault: false },
    what: "Law 152 of 2020 created a simplified regime for micro, small and medium enterprises, with turnover-based tax instead of full accounting.",
    why: "If you qualify it can mean simpler books and lower tax, and it offers a path to formalise.",
    steps: [
      "Confirm your annual turnover band with MSMEDA or the tax authority.",
      "Ask what tax rate and filing rhythm apply to your band.",
      "Decide with your accountant before your next filing.",
    ],
    documents: ["Last 12 months sales", "Commercial register / tax card"],
    feeNote: "No fee noted. Rates depend on your turnover band; confirm the current rate with the authority.",
    source: { label: "MSMEDA", url: "https://www.msmeda.org.eg" },
    confidence: "indicative",
    caveat:
      "Sources disagree on the exact thresholds and rates and they have been amended. Treat any figure you read as something to verify.",
  },
  {
    key: "eg.vat_registration",
    kind: "required",
    cadence: "once",
    authority: "Egyptian Tax Authority (ETA)",
    title: "VAT registration",
    titleAr: "التسجيل في ضريبة القيمة المضافة",
    due: { rule: "none", planningDefault: false },
    what: "Businesses selling taxable goods or services above the registration threshold must register for VAT. The widely cited threshold is EGP 500,000 of annual sales.",
    why: "Registering late can bring penalties, and once registered you must charge VAT and file monthly returns.",
    steps: [
      "Check your last 12 months of sales against the threshold.",
      "Apply on the ETA portal within the period the law gives you.",
      "Start issuing VAT-compliant invoices.",
    ],
    documents: ["Tax card", "Commercial register", "Sales records for the last 12 months"],
    feeNote: "No registration fee is typically charged; confirm with the ETA.",
    source: { label: "Egyptian Tax Authority", url: "https://www.eta.gov.eg" },
    confidence: "indicative",
    caveat: "Some activities have no threshold at all. Confirm yours.",
  },
  {
    key: "eg.vat_return",
    kind: "required",
    cadence: "monthly",
    authority: "Egyptian Tax Authority (ETA)",
    title: "Monthly VAT return",
    titleAr: "الإقرار الشهري لضريبة القيمة المضافة",
    due: { rule: "end_of_next_month", planningDefault: true },
    what: "File and pay VAT for last month's sales and purchases through the ETA portal.",
    why: "Late filing and payment attract penalties; this is one of the most common ways small businesses lose money.",
    steps: [
      "Total last month's taxable sales and VAT paid on purchases.",
      "Submit the return on the ETA portal.",
      "Pay any VAT due and keep the receipt.",
    ],
    documents: ["Sales invoices", "Purchase invoices with VAT", "Previous return"],
    feeNote: "VAT itself is the cost; penalties apply for lateness. Record the VAT you actually paid.",
    source: { label: "Egyptian Tax Authority", url: "https://www.eta.gov.eg" },
    confidence: "indicative",
    caveat:
      "Sources differ on whether the deadline is the last day of the following month or about 30 days after month end. Socio plans for the earlier reading; confirm the exact date on the portal.",
  },
  {
    key: "eg.e_invoice",
    kind: "check",
    cadence: "once",
    authority: "Egyptian Tax Authority (ETA)",
    title: "Electronic invoicing (e-invoice)",
    titleAr: "الفاتورة الإلكترونية",
    due: { rule: "none", planningDefault: false },
    what: "VAT-registered taxpayers are being brought into the ETA e-invoicing system in phases.",
    why: "Invoices that are not issued through the system may not be accepted for deductions by your customers.",
    steps: [
      "Check whether your registration group has been called into e-invoicing.",
      "Get a signing/ERP setup, or use the ETA's free portal tools.",
      "Test-issue a few invoices before going live.",
    ],
    documents: ["Tax card", "Electronic signature / token as required"],
    feeNote: FEE_NOTE,
    source: { label: "Egyptian Tax Authority — e-invoicing", url: "https://www.eta.gov.eg" },
    confidence: "indicative",
  },
  {
    key: "eg.social_insurance",
    kind: "required",
    cadence: "monthly",
    authority: "National Organization for Social Insurance",
    title: "Social insurance contributions (employees)",
    titleAr: "اشتراكات التأمينات الاجتماعية",
    due: { rule: "end_of_next_month", planningDefault: true },
    what: "If you have employees you must register them and pay monthly employer and employee contributions.",
    why: "Missing contributions create penalties and personal liability, and leave staff uncovered.",
    steps: [
      "Register the establishment and each employee.",
      "Calculate each month's contributions from insured wages.",
      "Pay on time and keep the receipts.",
    ],
    documents: ["Employee IDs", "Contracts and wages", "Establishment registration"],
    feeNote:
      "Contributions are a percentage of insured wages; confirm current rates and wage limits with the organisation.",
    source: { label: "Ministry of Social Solidarity / Social Insurance", url: "https://www.eta.gov.eg" },
    confidence: "indicative",
    caveat: "The payment day is a Socio planning date. Check the actual deadline with your insurance office.",
  },
  {
    key: "eg.payroll_tax",
    kind: "required",
    cadence: "monthly",
    authority: "Egyptian Tax Authority (ETA)",
    title: "Payroll tax withholding",
    titleAr: "ضريبة المرتبات",
    due: { rule: "end_of_next_month", planningDefault: true },
    what: "Employers withhold income tax from salaries and pay it to the tax authority.",
    why: "You are liable for the tax you should have withheld.",
    steps: [
      "Compute tax per employee from the current brackets.",
      "Withhold and pay to the ETA.",
      "File the periodic payroll return.",
    ],
    documents: ["Payroll sheet", "Employee tax data"],
    feeNote: "A tax, not a fee; amount depends on salaries.",
    source: { label: "Egyptian Tax Authority", url: "https://www.eta.gov.eg" },
    confidence: "indicative",
    caveat: "Deadline and form are a planning date here; confirm with your accountant.",
  },
  {
    key: "eg.annual_return",
    kind: "check",
    cadence: "annual",
    authority: "Egyptian Tax Authority (ETA)",
    title: "Annual income-tax return",
    titleAr: "الإقرار الضريبي السنوي",
    due: { rule: "none", planningDefault: false },
    what: "Annual declaration of income for your entity type.",
    why: "It closes the year, and late filing carries penalties.",
    steps: [
      "Close the year's books in Socio (categorise and reconcile).",
      "Export financial statements.",
      "File through the ETA or your accountant.",
    ],
    documents: ["Annual income statement", "Bank statements", "Fixed asset register"],
    feeNote: "Accountant fees vary; record what you pay.",
    source: { label: "Egyptian Tax Authority", url: "https://www.eta.gov.eg" },
    confidence: "indicative",
    caveat: "The deadline depends on your entity type and fiscal year, so no date is assumed. Ask your accountant.",
  },
  {
    key: "eg.shop_license",
    kind: "check",
    cadence: "annual",
    authority: "Local governorate / district office",
    title: "Shop or workshop licence",
    titleAr: "رخصة المحل",
    due: { rule: "none", planningDefault: false },
    what: "A physical shop or workshop usually needs an operating licence from the local authority.",
    why: "Inspections and closures are common for unlicensed premises.",
    steps: [
      "Ask your district office which licence your activity needs.",
      "Check renewal dates and keep it visible on premises.",
    ],
    documents: ["Lease contract", "Commercial register", "Tax card"],
    feeNote: FEE_NOTE,
    source: { label: "Ask your local authority", url: "https://www.gafi.gov.eg" },
    confidence: "indicative",
  },
  {
    key: "eg.trademark",
    kind: "recommended",
    cadence: "once",
    authority: "Egyptian Trademarks Office",
    title: "Protect your brand name",
    titleAr: "تسجيل العلامة التجارية",
    due: { rule: "none", planningDefault: false },
    what: "Registering your brand name and logo gives you legal ownership of the brand you are building.",
    why: "Without it, someone else can register a similar name, and marketplaces may side with the registered owner.",
    steps: [
      "Search the register for similar names.",
      "File an application in the right class.",
      "Keep proof of first use.",
    ],
    documents: ["Logo/name", "ID", "Commercial register"],
    feeNote: FEE_NOTE,
    source: { label: "Ministry of Trade and Industry", url: "https://www.gafi.gov.eg" },
    confidence: "indicative",
  },
  {
    key: "sys.close_month",
    kind: "internal",
    cadence: "monthly",
    authority: "You",
    title: "Close this month's books",
    titleAr: "اقفل حسابات الشهر",
    due: { rule: "day_of_next_month", day: 5, planningDefault: true },
    what: "Categorise this month's transactions, mark bank-matched ones as reconciled and record any missing costs. Aim to finish by the 5th of next month.",
    why: "Every number Socio shows is only as good as the records behind it. Ten minutes a month keeps profit honest.",
    steps: [
      "Open Transactions → Uncategorized and clear it.",
      "Add any missing bills and product costs.",
      "Mark what matches your bank statement as reconciled.",
    ],
    documents: ["Bank / wallet statements"],
    feeNote: "Free.",
    source: { label: "Socio best practice", url: "/app/transactions?filter=uncategorized" },
    confidence: "official",
  },
  {
    key: "sys.review_health",
    kind: "internal",
    cadence: "monthly",
    authority: "You",
    title: "Review your monthly health check",
    titleAr: "راجع صحة شركتك",
    due: { rule: "day_of_next_month", day: 7, planningDefault: true },
    what: "Look at valuation, profit, cash outlook and readiness once a month and decide one thing to improve. Aim to do it by the 7th of next month.",
    why: "Small monthly decisions compound; a skipped month is how problems grow unnoticed.",
    steps: [
      "Open Company health.",
      "Read the verdict and the three priorities.",
      "Pick one action and put it in your to-do list.",
    ],
    documents: [],
    feeNote: "Free.",
    source: { label: "Socio", url: "/app/health" },
    confidence: "official",
  },
];

export interface TodoProfile {
  country: string;
  businessType: string;
  channels: string[];
  hasEmployees: boolean;
  trailingRevenue12m: number; // minor units, base currency
  vatRegistered: boolean | null; // null = not answered
  vatThresholdMinor: number; // EGP 500,000 in minor units
}

export interface GeneratedTodo {
  catalog_key: string;
  period: string;
  title: string;
  detail: string;
  due_date: ISODate | null;
  kind: ReqKind;
  planningDefault: boolean;
}

export const VAT_THRESHOLD_EGP = 500_000;

function dueFor(r: Requirement, today: ISODate): ISODate | null {
  const nextMonthStart = addMonths(startOfMonth(today), 1, 1);
  switch (r.due.rule) {
    case "end_of_next_month":
      // Obligation for last month falls due at the end of this month.
      return endOfMonth(today);
    case "day_of_next_month":
      // A routine for this month is finished on the Nth day of the following month.
      return addDays(addMonths(startOfMonth(today), 1, 1), (r.due.day ?? 1) - 1);
    default:
      void nextMonthStart;
      return null;
  }
}

export function supportedCountry(country: string): boolean {
  return country.toUpperCase() === "EG";
}

/* * Which catalogue entries apply, with an explanation of why each one is on the list. */
export function applicable(p: TodoProfile): { req: Requirement; reason: string }[] {
  const out: { req: Requirement; reason: string }[] = [];
  const revenue = p.trailingRevenue12m;
  const nearVat = revenue >= p.vatThresholdMinor * 0.7;
  const overVat = revenue >= p.vatThresholdMinor;
  const registered = p.vatRegistered === true;
  for (const r of EGYPT) {
    switch (r.key) {
      case "eg.vat_registration":
        if (registered) continue;
        if (overVat)
          out.push({ req: r, reason: "Your last 12 months of sales are above the commonly cited VAT threshold." });
        else if (nearVat)
          out.push({ req: r, reason: "Your sales are approaching the commonly cited VAT threshold. Plan ahead." });
        break;
      case "eg.vat_return":
      case "eg.e_invoice":
        if (registered) out.push({ req: r, reason: "You said you are VAT-registered." });
        else if (p.vatRegistered === null && overVat)
          out.push({ req: r, reason: "Applies if you are VAT-registered. Your sales suggest you may need to be." });
        break;
      case "eg.social_insurance":
      case "eg.payroll_tax":
        if (p.hasEmployees) out.push({ req: r, reason: "You pay salaries, so you are likely an employer." });
        break;
      case "eg.shop_license":
        if (p.channels.includes("retail")) out.push({ req: r, reason: "You sell from a physical location." });
        break;
      case "eg.annual_return":
        out.push({ req: r, reason: "Every registered business files a yearly return." });
        break;
      default:
        out.push({
          req: r,
          reason:
            r.kind === "internal"
              ? "Keeps your numbers trustworthy."
              : r.kind === "recommended"
                ? "Not mandatory, but protects what you are building."
                : "Applies to most businesses operating in Egypt.",
        });
    }
  }
  return out;
}

export function generateTodos(
  p: TodoProfile,
  today: ISODate,
): { items: GeneratedTodo[]; reasons: Record<string, string> } {
  const month = today.slice(0, 7);
  const year = today.slice(0, 4);
  const items: GeneratedTodo[] = [];
  const reasons: Record<string, string> = {};
  for (const { req, reason } of applicable(p)) {
    const period = req.cadence === "monthly" ? month : req.cadence === "annual" ? year : "once";
    items.push({
      catalog_key: req.key,
      period,
      title: req.title,
      detail: req.what,
      due_date: dueFor(req, today),
      kind: req.kind,
      planningDefault: req.due.planningDefault,
    });
    reasons[req.key] = reason;
  }
  return { items, reasons };
}

export function requirementByKey(key: string): Requirement | undefined {
  return EGYPT.find((r) => r.key === key);
}
