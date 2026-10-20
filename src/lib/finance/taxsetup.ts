// Where the owner stands with tax paperwork in Egypt, and what to do next. Socio does not estimate any tax until the
// owner has told us this, because the right numbers depend on it (VAT or not, simplified regime or not).
// The steps are general guidance written for beginners; amounts and rules should be confirmed with the Egyptian
// Tax Authority (ETA) or an accountant, and the UI says so.

export type Answer = "yes" | "no" | "in_progress" | "not_sure";

export interface TaxProfile {
  commercialRegister: Answer;
  taxCard: Answer;
  etaPortal: Answer; // has an account on the ETA online portal
  vatRegistered: Answer;
  simplifiedRegime: Answer; // Law No. 6 of 2025, turnover up to EGP 20 million
  eInvoicing: Answer; // issues e-invoices / e-receipts
  updatedAt?: string;
}

export const TAX_QUESTIONS: { key: keyof Omit<TaxProfile, "updatedAt">; en: string; ar: string; options: Answer[] }[] =
  [
    {
      key: "commercialRegister",
      en: "Do you have a commercial register?",
      ar: "عندك سجل تجاري؟",
      options: ["yes", "in_progress", "no"],
    },
    { key: "taxCard", en: "Do you have a tax card?", ar: "عندك بطاقة ضريبية؟", options: ["yes", "in_progress", "no"] },
    {
      key: "etaPortal",
      en: "Do you have an account on the Tax Authority's online portal?",
      ar: "عندك حساب على بوابة مصلحة الضرائب؟",
      options: ["yes", "no", "not_sure"],
    },
    {
      key: "vatRegistered",
      en: "Are you registered for VAT?",
      ar: "انت مسجّل في ضريبة القيمة المضافة؟",
      options: ["yes", "no", "not_sure"],
    },
    {
      key: "simplifiedRegime",
      en: "Did you join the simplified tax regime for small businesses?",
      ar: "اشتركت في النظام الضريبي المبسّط للمشروعات الصغيرة؟",
      options: ["yes", "no", "not_sure"],
    },
    {
      key: "eInvoicing",
      en: "Do you issue e-invoices or e-receipts?",
      ar: "بتطلّع فواتير أو إيصالات إلكترونية؟",
      options: ["yes", "no", "not_sure"],
    },
  ];

export const ANSWER_LABEL: Record<Answer, { en: string; ar: string }> = {
  yes: { en: "Yes", ar: "أيوه" },
  no: { en: "No", ar: "لأ" },
  in_progress: { en: "In progress", ar: "لسه بخلّصه" },
  not_sure: { en: "Not sure", ar: "مش متأكد" },
};

const ANSWERS = new Set<Answer>(["yes", "no", "in_progress", "not_sure"]);

export function readTaxProfile(settings: any): TaxProfile | null {
  const p = settings?.taxProfile;
  if (!p || typeof p !== "object") return null;
  const a = (v: unknown): Answer => (ANSWERS.has(v as Answer) ? (v as Answer) : "not_sure");
  return {
    commercialRegister: a(p.commercialRegister),
    taxCard: a(p.taxCard),
    etaPortal: a(p.etaPortal),
    vatRegistered: a(p.vatRegistered),
    simplifiedRegime: a(p.simplifiedRegime),
    eInvoicing: a(p.eInvoicing),
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : undefined,
  };
}

/* * VAT registration threshold used for guidance (annual sales). Shown with a "confirm with the ETA" note. */
export const VAT_THRESHOLD_EGP = 500_000;
/* * Simplified regime ceiling (annual turnover), Law No. 6 of 2025. */
export const SIMPLIFIED_CEILING_EGP = 20_000_000;

export type StepStatus = "done" | "in_progress" | "todo" | "not_needed" | "check";
export interface TaxStep {
  id: "commercial_register" | "tax_card" | "eta_portal" | "simplified_regime" | "e_invoicing" | "vat" | "returns";
  status: StepStatus;
  next: boolean;
  title: { en: string; ar: string };
  why: { en: string; ar: string };
  how: { en: string[]; ar: string[] };
}

export interface TaxChecklist {
  known: boolean; // false until the owner has answered
  steps: TaxStep[];
  next: TaxStep | null;
  annualSales: number; // minor units, last 365 days
  progress: { done: number; total: number };
}

const st = (a: Answer): StepStatus =>
  a === "yes" ? "done" : a === "in_progress" ? "in_progress" : a === "not_sure" ? "check" : "todo";

/* * annualSales in minor units (piastres). */
export function taxChecklist(profile: TaxProfile | null, annualSales: number): TaxChecklist {
  const p: TaxProfile = profile ?? {
    commercialRegister: "not_sure",
    taxCard: "not_sure",
    etaPortal: "not_sure",
    vatRegistered: "not_sure",
    simplifiedRegime: "not_sure",
    eInvoicing: "not_sure",
  };
  const salesEgp = annualSales / 100;
  const overVat = salesEgp >= VAT_THRESHOLD_EGP;
  const underCeiling = salesEgp <= SIMPLIFIED_CEILING_EGP;
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

  const steps: TaxStep[] = [
    {
      id: "commercial_register",
      status: st(p.commercialRegister),
      next: false,
      title: { en: "Get a commercial register", ar: "طلّع سجل تجاري" },
      why: {
        en: "It makes the business official. You need it for the tax card, a business bank account and most payment gateways.",
        ar: "ده اللي بيخلّي المشروع رسمي. هتحتاجه للبطاقة الضريبية، ولحساب بنك باسم المشروع، ولمعظم بوابات الدفع.",
      },
      how: {
        en: [
          "Go to the commercial registry office for your area (or start online through the Digital Egypt platform).",
          "Bring your national ID and a lease or ownership contract for the business address.",
          "Choose the business form: most small shops start as a sole proprietorship.",
        ],
        ar: [
          "روح مكتب السجل التجاري التابع ليه عنوانك (أو ابدأ أونلاين من منصة مصر الرقمية).",
          "خد معاك بطاقة الرقم القومي وعقد إيجار أو تمليك لعنوان النشاط.",
          "اختار شكل النشاط: أغلب المحلات الصغيرة بتبدأ كمنشأة فردية.",
        ],
      },
    },
    {
      id: "tax_card",
      status: st(p.taxCard),
      next: false,
      title: { en: "Get a tax card", ar: "طلّع بطاقة ضريبية" },
      why: {
        en: "It gives the business a tax registration number. You need it to file returns and to invoice companies.",
        ar: "بتدّي المشروع رقم تسجيل ضريبي. هتحتاجها علشان تقدّم إقراراتك وتتعامل بفواتير مع الشركات.",
      },
      how: {
        en: [
          "Go to the tax office (مأمورية الضرائب) responsible for your business address.",
          "Bring the commercial register, your national ID and the lease contract.",
          "Keep the tax registration number: Socio will ask for it later for invoices.",
        ],
        ar: [
          "روح مأمورية الضرائب التابع ليها عنوان النشاط.",
          "خد معاك السجل التجاري وبطاقة الرقم القومي وعقد الإيجار.",
          "احتفظ برقم التسجيل الضريبي، هتحتاجه في الفواتير بعد كده.",
        ],
      },
    },
    {
      id: "eta_portal",
      status: st(p.etaPortal),
      next: false,
      title: { en: "Open an account on the Tax Authority portal", ar: "افتح حساب على بوابة مصلحة الضرائب" },
      why: {
        en: "Returns and registrations are done online, so you need access before your first deadline.",
        ar: "الإقرارات والتسجيلات بقت أونلاين، فلازم يبقى عندك حساب قبل أول ميعاد إقرار.",
      },
      how: {
        en: [
          "Register on the ETA online portal with your tax registration number.",
          "Save the login somewhere safe. Never share it in a chat, including with Socio.",
        ],
        ar: [
          "سجّل على بوابة مصلحة الضرائب برقم التسجيل الضريبي بتاعك.",
          "احفظ بيانات الدخول في مكان آمن، ومتبعتهاش في أي شات، ولا حتى لـ Socio.",
        ],
      },
    },
    {
      id: "simplified_regime",
      status:
        p.simplifiedRegime === "yes"
          ? "done"
          : !underCeiling
            ? "not_needed"
            : p.simplifiedRegime === "no"
              ? "todo"
              : "check",
      next: false,
      title: { en: "Check the simplified tax regime", ar: "شوف النظام الضريبي المبسّط" },
      why: {
        en: `Under Law No. 6 of 2025, businesses with turnover up to EGP ${fmt(SIMPLIFIED_CEILING_EGP)} can pay a small percentage of turnover (0.4% to 1.5%) instead of tax on profit, if they use e-invoices or e-receipts. Your sales in the last 12 months: about EGP ${fmt(salesEgp)}.`,
        ar: `قانون رقم 6 لسنة 2025 بيسمح للمشروعات اللي حجم أعمالها لحد ${fmt(SIMPLIFIED_CEILING_EGP)} جنيه تدفع نسبة صغيرة من المبيعات (من 0.4% لـ 1.5%) بدل الضريبة على الربح، بشرط الفاتورة أو الإيصال الإلكتروني. مبيعاتك في آخر 12 شهر حوالي ${fmt(salesEgp)} جنيه.`,
      },
      how: {
        en: [
          "Ask your tax office or an accountant whether you qualify and which rate applies to your turnover.",
          "Apply through the ETA portal.",
          "Once you join, tell Socio here so it reserves the right amount.",
        ],
        ar: [
          "اسأل المأمورية أو محاسب: انت تنفع ولا لأ، وأنهي نسبة على حجم مبيعاتك.",
          "قدّم من بوابة مصلحة الضرائب.",
          "أول ما تشترك، عرّف Socio هنا علشان يحجزلك المبلغ الصح.",
        ],
      },
    },
    {
      id: "e_invoicing",
      status:
        p.eInvoicing === "yes"
          ? "done"
          : p.vatRegistered === "yes" || p.simplifiedRegime === "yes"
            ? st(p.eInvoicing)
            : "not_needed",
      next: false,
      title: { en: "Set up e-invoices / e-receipts", ar: "جهّز الفاتورة والإيصال الإلكتروني" },
      why: {
        en: "Required with VAT or the simplified regime, and for businesses named in the ETA's e-receipt waves.",
        ar: "مطلوب لو انت مسجّل قيمة مضافة أو في النظام المبسّط، وللمشروعات اللي اسمها نزل في مراحل الإيصال الإلكتروني.",
      },
      how: {
        en: [
          "Register on the e-invoice / e-receipt system from the ETA portal.",
          "Pick an approved provider or the ETA's own tools to issue them.",
        ],
        ar: [
          "سجّل على منظومة الفاتورة / الإيصال الإلكتروني من بوابة الضرائب.",
          "اختار مقدم خدمة معتمد أو أدوات المصلحة نفسها علشان تطلّعهم.",
        ],
      },
    },
    {
      id: "vat",
      status:
        p.vatRegistered === "yes"
          ? "done"
          : overVat
            ? p.vatRegistered === "in_progress"
              ? "in_progress"
              : "todo"
            : p.vatRegistered === "not_sure"
              ? "check"
              : "not_needed",
      next: false,
      title: { en: "VAT registration", ar: "التسجيل في القيمة المضافة" },
      why:
        p.vatRegistered === "yes"
          ? {
              en: "You're registered, so Socio sets aside the VAT inside your sales and reminds you of the monthly return.",
              ar: "انت مسجّل، فـ Socio بيحجز ضريبة القيمة المضافة اللي جوه مبيعاتك وبيفكّرك بالإقرار الشهري.",
            }
          : {
              en: overVat
                ? `Your sales in the last 12 months (about EGP ${fmt(salesEgp)}) are above the EGP ${fmt(VAT_THRESHOLD_EGP)} registration threshold, so you likely need to register. Confirm the current threshold with the ETA.`
                : `Registration is required once yearly sales pass about EGP ${fmt(VAT_THRESHOLD_EGP)} (confirm the current threshold with the ETA). You're at about EGP ${fmt(salesEgp)}.`,
              ar: overVat
                ? `مبيعاتك في آخر 12 شهر (حوالي ${fmt(salesEgp)} جنيه) عدّت حد التسجيل (${fmt(VAT_THRESHOLD_EGP)} جنيه)، فغالبًا لازم تتسجّل. اتأكد من الحد الحالي من مصلحة الضرائب.`
                : `التسجيل بيبقى إجباري لما المبيعات السنوية تعدّي حوالي ${fmt(VAT_THRESHOLD_EGP)} جنيه (اتأكد من الحد الحالي من المصلحة). انت دلوقتي حوالي ${fmt(salesEgp)} جنيه.`,
            },
      how: {
        en: [
          "Register for VAT through the ETA portal.",
          "After registering, a monthly VAT return is due. Socio will then start setting aside the VAT inside your sales.",
        ],
        ar: [
          "سجّل في القيمة المضافة من بوابة الضرائب.",
          "بعد التسجيل فيه إقرار شهري. Socio هيبدأ ساعتها يحجز ضريبة القيمة المضافة اللي جوه مبيعاتك.",
        ],
      },
    },
    {
      id: "returns",
      status: p.taxCard === "yes" && p.etaPortal === "yes" ? "check" : "todo",
      next: false,
      title: { en: "File your returns on time", ar: "قدّم إقراراتك في ميعادها" },
      why: {
        en: "Even a small business files an annual income tax return, and a monthly one if it is VAT-registered. Late filing brings fines.",
        ar: "حتى المشروع الصغير بيقدّم إقرار ضريبة دخل سنوي، وإقرار شهري لو مسجّل قيمة مضافة. التأخير عليه غرامات.",
      },
      how: {
        en: [
          "Ask your accountant or tax office for the deadline that applies to your business form.",
          "Add it to the money calendar so Socio reminds you.",
        ],
        ar: ["اسأل المحاسب أو المأمورية عن الميعاد اللي يخص شكل نشاطك.", "ضيفه في تقويم الفلوس علشان Socio يفكّرك."],
      },
    },
  ];

  const order: StepStatus[] = ["in_progress", "todo", "check"];
  const next = order.map((s) => steps.find((x) => x.status === s)).find(Boolean) ?? null;
  if (next) next.next = true;
  const counted = steps.filter((s) => s.status !== "not_needed");
  return {
    known: !!profile,
    steps,
    next,
    annualSales,
    progress: { done: counted.filter((s) => s.status === "done").length, total: counted.length },
  };
}

/* * One line for the agent and the home page. */
export function taxStatusLine(c: TaxChecklist, lang: "en" | "ar"): string {
  if (!c.known)
    return lang === "ar"
      ? "لسه مش عارفين وضعك الضريبي، فمش بحسب أي ضرايب دلوقتي. جاوب على 6 أسئلة في صفحة «الضرايب والأوراق» وهقولك تعمل إيه بالظبط."
      : "I don't know your tax situation yet, so I'm not estimating any tax. Answer 6 quick questions on the Taxes & papers page and I'll tell you exactly what to do next.";
  if (!c.next)
    return lang === "ar"
      ? "أوراقك الضريبية كلها تمام حسب اللي قلته."
      : "Your tax papers are all in order, based on what you told me.";
  return lang === "ar"
    ? `خلّصت ${c.progress.done} من ${c.progress.total} خطوات. الخطوة الجاية: ${c.next.title.ar}. ${c.next.how.ar[0]}`
    : `${c.progress.done} of ${c.progress.total} steps done. Next: ${c.next.title.en}. ${c.next.how.en[0]}`;
}
