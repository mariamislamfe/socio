// Screens a question before the agent (model or rule planner) sees it. Deterministic, so a request to move money,
// leak data or rewrite the rules gets the same answer every time, whether or not a model is configured.
// It only reads the text: it never runs tools, and anything it lets through still goes through the normal policy.

import { parseEntry, type ParsedEntry } from "./messageparse";

export type GuardKind =
  | "credentials" // asks for or offers a password / OTP / card number
  | "injection" // tries to replace the agent's instructions
  | "escalation" // asks for more rights, or to skip approvals
  | "impersonation" // "I'm from the bank / tax office…" asking for data
  | "data_request" // other businesses' data, or sending records to an outside address
  | "transfer" // asks the agent to move money
  | "record" // states a payment that already happened ("I paid 500 shipping")
  | "investment_tips" // which stock / coin / gold to buy
  | "out_of_scope" // weather, football, recipes…
  | "greeting"
  | "unclear" // too short or vague to act on, with no earlier question to lean on
  | "ok";

export interface Screen {
  kind: GuardKind;
  /* * The question with a correction prefix ("no, I meant…", "لا قصدي…") removed. */
  text: string;
  correction: boolean;
  /* * A short follow-up ("and last month?") that should be read together with the previous question. */
  followUp: boolean;
  entry?: ParsedEntry | null;
}

/* * Kinds the agent answers directly, without calling any tool or model. */
export const BLOCKING: ReadonlySet<GuardKind> = new Set<GuardKind>([
  "credentials",
  "injection",
  "escalation",
  "impersonation",
  "data_request",
  "transfer",
  "record",
  "investment_tips",
  "out_of_scope",
  "greeting",
  "unclear",
]);

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
};

export function normalize(text: string) {
  return text
    .replace(/[٠-٩]/g, (d) => AR_DIGITS[d] ?? d)
    .replace(/[ً-ْـ]/g, "") // diacritics and tatweel
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// JavaScript's \b does not work with Arabic letters, so Arabic words are matched between these boundaries.
const B = "(?:^|[\\s،؛؟?!.,:;\"'«»()\\-/])";
const E = "(?=$|[\\s،؛؟?!.,:;\"'«»()\\-/])";
const ar = (words: string[]) => new RegExp(`${B}(?:${words.join("|")})${E}`);
const any = (t: string, res: RegExp[]) => res.some((r) => r.test(t));

// Finance words also match with the article or a preposition in front ("الكاش", "بالفلوس", "للمورد").
const arWithArticle = (words: string[]) => new RegExp(`${B}(?:ال|بال|وال|لل|فال)?(?:${words.join("|")})${E}`);
const FINANCE_WORDS = arWithArticle([
  "فلوس",
  "كاش",
  "رصيد",
  "ربح",
  "الربح",
  "مكسب",
  "كسبت",
  "خساره",
  "خسرت",
  "مبيعات",
  "المبيعات",
  "مصاريف",
  "المصاريف",
  "مصروف",
  "فاتوره",
  "فواتير",
  "الفواتير",
  "قرض",
  "تمويل",
  "سلفه",
  "ضريبه",
  "ضرايب",
  "ضرائب",
  "اعلان",
  "اعلانات",
  "منتج",
  "منتجات",
  "مرتب",
  "مرتبات",
  "ايجار",
  "مورد",
  "الموردين",
  "زبون",
  "زباين",
  "عميل",
  "عملاء",
  "ميزانيه",
  "سعر",
  "اسعار",
  "بضاعه",
  "مخزون",
  "جنيه",
  "حساب",
  "شحن",
  "تحصيل",
  "ديون",
  "مديونيه",
  "دخل",
  "اوردر",
  "اوردرات",
  "طلبات",
]);
const FINANCE_EN =
  /\b(cash|money|balance|profit|loss|sales?|revenue|expenses?|costs?|spend|spent|bills?|invoices?|loans?|financ\w*|tax|vat|ads?|advertis\w*|products?|salar\w*|rent|suppliers?|customers?|budgets?|forecast|price|stock|inventory|egp|pounds?|runway|margin|orders?|shipping|reserve|debt|owe|paid|pay)\b/;

function hasFinance(t: string) {
  return FINANCE_EN.test(t) || FINANCE_WORDS.test(t);
}

// patterns

const CREDENTIALS = [
  /\b(password|passcode|passwords|otp|one[- ]time (code|password)|verification code|security code|pin( code)?|cvv|cvc|card (number|details)|login details|2fa code)\b/,
  ar([
    "كلمه السر",
    "كلمه المرور",
    "الباسورد",
    "باسورد",
    "الرقم السري",
    "رقم الكارت",
    "رقم البطاقه",
    "كود التحقق",
    "كود التفعيل",
    "الكود اللي جالك",
    "الكود اللي جالي",
    "الكود اللي وصلك",
    "الكود اللي وصلني",
    "otp",
  ]),
];

const INJECTION = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|rules|prompt|polic(y|ies)|previous|above|system|guidelines)\b/,
  /\bsystem prompt\b/,
  /\byou are now\b/,
  /\b(developer|god|admin|dan|debug|unrestricted) mode\b/,
  /\bjailbreak/,
  /\bpretend (you are|to be|you're)\b/,
  /\bact as (an? |the )?(admin|developer|system|root|bank|unrestricted)/,
  /\bnew instructions?\s*:/,
  /<\/?\s*(system|instructions?|assistant)\s*>/,
  /\b(reveal|show|print|repeat)\b.{0,20}\b(your|the) (prompt|instructions|rules|system message)/,
  ar([
    "تجاهل التعليمات",
    "تجاهل القواعد",
    "تجاهل كل اللي فات",
    "تجاهل الكلام اللي فات",
    "انسي التعليمات",
    "انسي القواعد",
    "انسي كل اللي فات",
    "التعليمات اللي فاتت",
    "التعليمات السابقه",
    "برومبت السيستم",
    "انت دلوقتي",
    "اعتبر نفسك",
    "من النهارده انت",
    "اكسر القواعد",
    "تخطي القواعد",
    "طلعلي التعليمات",
  ]),
];

const ESCALATION = [
  /\bmake (me|him|her|them|this user) (an? )?(admin|owner)\b/,
  /\b(give|grant) (me|him|her|them|this user) (admin|owner|full|more|extra) (access|rights|role|permissions?)\b/,
  /\bchange (my|his|her|their|the user'?s?) role\b/,
  /\b(turn off|disable|remove|skip|bypass|switch off)\b.{0,30}\b(approvals?|kill switch|limits?|polic(y|ies)|security|confirmations?|checks?)\b/,
  /\bapprove\b.{0,40}\b(yourself|on my behalf|for me|automatically|without)\b/,
  /\bwithout (my |the owner'?s? |any )?(approval|confirmation|permission|asking)\b/,
  /\b(raise|increase|change|remove) (the |my )?(automation|auto[- ]?run|approval) limits?\b/,
  ar([
    "خليني ادمن",
    "خليني مالك",
    "خليني اونر",
    "اديني صلاحيه",
    "اديني صلاحيات",
    "صلاحيات ادمن",
    "صلاحيات كامله",
    "غير الدور",
    "غير صلاحيتي",
    "من غير موافقه",
    "من غير موافقتي",
    "من غير ما اوافق",
    "من غير ما تسالني",
    "وافق انت",
    "وافق بدالي",
    "وافق عني",
    "وافق لوحدك",
    "اعتمد انت",
    "اعتمد بدالي",
    "اعتمدها انت",
    "اقفل الموافقات",
    "شيل الموافقه",
    "الغي الموافقه",
    "الغي الحمايه",
    "اقفل الحمايه",
    "زود الحد",
  ]),
];

const IMPERSONATION = [
  /\b(i am|i'm|im|this is|we are|we're)\b.{0,25}\b(from the bank|the bank|bank manager|tax (office|authority)|police|your developer|the developer|support team|customer support|anthropic|the owner'?s? accountant|an? auditor|the government|central bank)\b/,
  ar([
    "انا من البنك",
    "معاك من البنك",
    "احنا من البنك",
    "انا من الضرايب",
    "انا من الضرائب",
    "انا من مصلحه الضرائب",
    "معاك من مصلحه الضرائب",
    "انا من المباحث",
    "انا من الشرطه",
    "انا من الدعم الفني",
    "معاك الدعم الفني",
    "انا المطور",
    "انا محاسب صاحب",
    "انا المحاسب بتاع",
  ]),
];

const DATA_REQUEST = [
  /\b(other|another|all|every) (business(es)?|users?|shops?|companies|stores?|workspaces?)\b/,
  /\b(send|email|forward|share|export|upload|post|give)\b.{0,60}(@|https?:|www\.|\b\d{8,}\b)/,
  /\b(dump|export|download|list)\b.{0,20}\b(all )?(customers?'? (data|phones?|numbers|emails|list)|user (data|list)|database|tables?)\b/,
  ar([
    "محل تاني",
    "محلات تانيه",
    "بيزنس تاني",
    "شركه تانيه",
    "حساب تاني",
    "كل المحلات",
    "كل المستخدمين",
    "كل الحسابات",
    "بيانات الناس التانيين",
    "ارقام الزباين كلها",
    "ارقام العملاء كلها",
    "الداتابيز",
    "قاعده البيانات",
  ]),
];
const AR_SEND = /(ابعت|ابعتلي|ابعتها|ابعته|ارسل|شارك|صدر|حمل)/;

const ADVISORY_EN =
  /\b(should|can|could|when|how much|how many|do i|shall|afford|is it (ok|okay|safe|wise)|what if|which|better to|need to|whether)\b/;
const ADVISORY_AR = ar([
  "اقدر",
  "ينفع",
  "امتي",
  "امته",
  "ازاي",
  "المفروض",
  "هل",
  "لازم",
  "اعمل ايه",
  "كام",
  "ولا لا",
  "ولا لأ",
  "ولا",
  "افضل",
  "احسن",
  "لو",
]);
const TRANSFER_EN = [
  /\b(transfer|wire|remit)\b.{0,40}(\d|money|funds|cash|egp|pounds|to )/,
  /\bsend\b.{0,30}(\d|money|cash|funds|egp|pounds)/,
  /^(please )?pay\b/,
  /\bpay\b.{0,40}\b(now|for me|right away|immediately|from my|on my behalf)\b/,
  /\bpay\b.{0,30}\bto (his|her|their|this|that|my|the) (account|wallet|number|card|iban)\b/,
  /\b(withdraw|move)\b.{0,25}(\d|money|cash|funds)/,
  /\b(instapay|vodafone cash|fawry|wallet|iban)\b.{0,40}\b(send|transfer|pay)\b/,
];
const AR_SECOND_PERSON = ar([
  "تحول",
  "تحولي",
  "تحوللي",
  "تحوله",
  "تبعت",
  "تبعتلي",
  "تبعتله",
  "تدفع",
  "تدفعلي",
  "تدفعله",
  "تسدد",
  "تسددلي",
  "تسحب",
  "تسحبلي",
]);
const AR_IMPERATIVE = ar([
  "حول",
  "حولي",
  "حوللي",
  "حوله",
  "حولها",
  "ابعت",
  "ابعتلي",
  "ابعتله",
  "ابعتلها",
  "ارسل",
  "اسحب",
  "اسحبلي",
  "ادفع",
  "ادفعلي",
  "ادفعله",
  "سدد",
  "سددلي",
  "سددله",
]);
const AR_MONEY = /\d|فلوس|جنيه|مبلغ|حساب|محفظه|انستا ?باي|فودافون كاش|فوري|كاش|رصيد/;

const RECORD_EN = /^(i )?(just )?(paid|spent|bought|received|got paid|sold)\b/;
const RECORD_AR = new RegExp(
  `^(?:انا )?(?:لسه )?(?:دفعت|صرفت|اشتريت|شريت|سددت|حولت|استلمت|قبضت|بعت ب|بعت بـ|بيعت|جالي|دخلي)${E}`,
);

const INVEST = [
  /\b(bitcoin|btc|crypto|cryptocurrenc\w*|ethereum|forex|which stocks?|stock tips?|stocks? to buy|gold price|buy gold|invest in gold)\b/,
  ar([
    "بيتكوين",
    "عمله رقميه",
    "عملات رقميه",
    "كريبتو",
    "البورصه",
    "اسهم",
    "سهم ايه",
    "اشتري دهب",
    "سعر الدهب",
    "الدهب",
  ]),
];

const OUT_OF_SCOPE = [
  /\b(weather|football|soccer|match|recipe|cook\w*|joke|poem|song|lyrics|movie|film|politic\w*|election|president|religio\w*|prayer|medical|doctor|medicine|homework|essay|translate|horoscope|girlfriend|boyfriend|write (me )?(a |an |some )?(code|program|script|story))\b/,
  ar([
    "الجو",
    "الطقس",
    "ماتش",
    "الماتش",
    "الكوره",
    "الاهلي",
    "الزمالك",
    "اكله",
    "وصفه",
    "نكته",
    "شعر",
    "اغنيه",
    "فيلم",
    "سياسه",
    "انتخابات",
    "الرئيس",
    "دين",
    "صلاه",
    "دكتور",
    "دوا",
    "علاج",
    "واجب",
    "مذاكره",
    "ترجم",
    "ترجملي",
    "اكتبلي كود",
    "برج",
  ]),
];

const GREETING =
  /^(hi|hello|hey|salam|good (morning|evening|afternoon)|السلام عليكم|سلام عليكم|سلام|اهلا|اهلا بيك|ازيك|صباح الخير|مساء الخير|هاي|هلو)[\s!.؟?]*$/;

const VAGUE_EN =
  /^(how much|how many|and|and then|what about it|what now|ok|okay|why|is it ok|is it okay|really|so|hmm+|more|explain|details)[\s?!.]*$/;
const VAGUE_AR = /^(كام|بكام|طب|طب و|وبعدين|ليه|ينفع|بجد|يعني|يعني ايه|اشرح|تفاصيل|ازاي|تمام|ماشي|اوك)[\s؟?!.]*$/;
const FOLLOW_UP_EN = /^(and|what about|how about|same for|and for|for)\b/;
const FOLLOW_UP_AR = /^(طب|و|وال|والشهر|والاسبوع|طيب|وبالنسبه)/;

const CORRECTION_EN =
  /^(no|nope|not that|wrong|i meant|i mean|sorry,? i meant|actually)\b[\s,.:-]*(i meant\b[\s,:-]*)?/;
const CORRECTION_AR = /^(لا|لأ|مش ده|مش كده|غلط|قصدي|انا قصدي|اقصد)(?=$|[\s،,.:-])[\s،,.:-]*(قصدي|اقصد)?[\s،,.:-]*/;

// screening

export function screen(message: string, opts: { hasHistory?: boolean } = {}): Screen {
  const raw = message.trim();
  let t = normalize(raw);
  let correction = false;
  const c = t.match(CORRECTION_EN) ?? t.match(CORRECTION_AR);
  if (c && c[0].length < t.length) {
    const rest = t.slice(c[0].length).trim();
    // "no, I meant profit" → "profit". A bare "no" stays as it is.
    if (rest.length >= 2) {
      correction = true;
      t = rest;
    }
  }
  const text = correction ? t : raw;
  const out = (kind: GuardKind, extra: Partial<Screen> = {}): Screen => ({
    kind,
    text,
    correction,
    followUp: false,
    ...extra,
  });

  if (any(t, CREDENTIALS)) return out("credentials");
  if (any(t, INJECTION)) return out("injection");
  if (any(t, ESCALATION)) return out("escalation");
  if (any(t, IMPERSONATION)) return out("impersonation");
  if (any(t, DATA_REQUEST) || (AR_SEND.test(t) && /@|https?:|\d{8,}/.test(t))) return out("data_request");

  const advisory = ADVISORY_EN.test(t) || ADVISORY_AR.test(t);
  const transferEn = !advisory && any(t, TRANSFER_EN);
  const transferAr = AR_MONEY.test(t) && (AR_SECOND_PERSON.test(t) || (!advisory && AR_IMPERATIVE.test(t)));
  if (transferEn || transferAr) return out("transfer");

  if ((RECORD_EN.test(t) || RECORD_AR.test(t)) && /\d/.test(t) && !/[?؟]/.test(t)) {
    return out("record", { entry: parseEntry(raw) });
  }

  if (any(t, INVEST)) return out("investment_tips");
  if (!hasFinance(t) && any(t, OUT_OF_SCOPE)) return out("out_of_scope");
  if (GREETING.test(t)) return out("greeting");

  const words = t.split(" ").filter(Boolean);
  if (
    opts.hasHistory &&
    (FOLLOW_UP_EN.test(t) ||
      FOLLOW_UP_AR.test(t) ||
      VAGUE_EN.test(t) ||
      VAGUE_AR.test(t) ||
      (words.length <= 4 && !hasFinance(t)))
  ) {
    return out("ok", { followUp: true });
  }
  if (!correction && (VAGUE_EN.test(t) || VAGUE_AR.test(t) || (words.length <= 2 && !hasFinance(t))))
    return out("unclear");
  return out("ok");
}

// fixed answers

const EXAMPLES_EN =
  "• How much can I safely spend this week?\n• Do I need a loan, and which offer is cheapest?\n• Which product makes the most profit?\n• What should I focus on today?";
const EXAMPLES_AR =
  "• أقدر أصرف قد إيه الأسبوع ده من غير ما أتزنق؟\n• محتاج تمويل؟ وأنهي عرض أرخص؟\n• أنهي منتج بيكسبني أكتر؟\n• أركز في إيه النهارده؟";

export function guardAnswer(
  s: Screen,
  lang: "en" | "ar",
  fm?: (minor: number) => string,
): { intent: string; answer: string } {
  const A = lang === "ar";
  switch (s.kind) {
    case "credentials":
      return A
        ? {
            intent: "طلب كلمة سر أو كود",
            answer:
              "عمري ما هطلب منك كلمة سر، ولا كود OTP، ولا رقم كارت، ومتكتبهمش هنا خالص.\nلو حد كلمك وطلب منك كود جالك على الموبايل، ده غالبًا نصب: اقفل معاه ومتديلوش أي حاجة.\nلو محتاج تغيّر كلمة السر بتاعتك، من الإعدادات ← الأمان.",
          }
        : {
            intent: "Password or code request",
            answer:
              "I will never ask for a password, an OTP code or a card number, so please don't type them here.\nIf someone contacted you asking for a code you received, it is almost certainly a scam: don't share it.\nTo change your own password, go to Settings → Security.",
          };
    case "injection":
      return A
        ? {
            intent: "محاولة تغيير تعليمات المساعد",
            answer:
              "مقدرش أغيّر القواعد بتاعتي ولا أوريك تعليماتي الداخلية. القواعد دي ثابتة علشان تحمي فلوسك وبياناتك.\nلو عندك سؤال عن مشروعك، اسألني عادي:\n" +
              EXAMPLES_AR,
          }
        : {
            intent: "Attempt to change the assistant's rules",
            answer:
              "I can't change my rules or share my internal instructions. They are fixed to protect your money and data.\nIf you have a question about your business, go ahead:\n" +
              EXAMPLES_EN,
          };
    case "escalation":
      return A
        ? {
            intent: "طلب صلاحيات أكتر أو تخطي الموافقة",
            answer:
              "مقدرش أدّي صلاحيات، ولا أوافق بدالك، ولا أقفل الموافقات. أي حاجة فيها فلوس أو مشاركة بيانات لازم صاحب الحساب نفسه يوافق عليها من «مركز الإجراءات».\nصاحب الحساب بس هو اللي يقدر يغيّر أدوار الفريق من الإعدادات ← البيزنس، ويغيّر حدود الأتمتة من «الاستقلالية والأمان».",
          }
        : {
            intent: "Request for more rights or to skip approval",
            answer:
              "I can't grant permissions, approve on your behalf or switch approvals off. Anything that moves money or shares data needs the account owner's approval in the Action Center.\nOnly the owner can change team roles (Settings → Business) or automation limits (Action Center → Autonomy & safety).",
          };
    case "impersonation":
      return A
        ? {
            intent: "حد بيقول إنه جهة رسمية وعايز بيانات",
            answer:
              "مقدرش أتأكد من هوية حد من رسالة، فمش هشارك أي بيانات على أساس كده.\nالبنوك ومصلحة الضرايب مش بيطلبوا بياناتك من هنا. لو جهة محتاجة ملف ماليتك، صاحب الحساب يقدر يبعته بنفسه من «التمويل ← ملف التمويل»، بلينك بيخلص ويتلغي، وبعد موافقته.",
          }
        : {
            intent: "Someone claims to be an official and asks for data",
            answer:
              "I can't verify who someone is from a message, so I won't share any data on that basis.\nBanks and the tax office don't request records through this chat. If a lender needs your file, the owner can share it from Financing → Financing file, through an expiring link and only after approving it.",
          };
    case "data_request":
      return A
        ? {
            intent: "طلب بيانات برا الحساب",
            answer:
              "بشوف بيانات البيزنس بتاعك بس، ومقدرش أبعت سجلاتك لإيميل أو رقم أو لينك برا التطبيق.\nلو عايز تشارك ملفك مع جهة تمويل، اعملها من «التمويل ← ملف التمويل»: بتراجع الملف وتوافق عليه، والجهة بتاخد لينك بيخلص بعد أيام وتقدر تلغيه في أي وقت.",
          }
        : {
            intent: "Request for data outside this account",
            answer:
              "I only see your own business's data, and I can't send your records to an email, number or link outside the app.\nTo share your file with a lender, use Financing → Financing file: you review and approve it, and they get a link that expires and that you can revoke at any time.",
          };
    case "transfer":
      return A
        ? {
            intent: "طلب تحويل أو دفع فلوس",
            answer:
              "مقدرش أحوّل أو أدفع أو أسحب فلوس، ومفيش أي جزء في Socio يقدر يعمل كده. الفلوس بتتحرك من البنك أو المحفظة بتاعتك انت بس.\nاللي أقدر أعمله:\n• لو دفعت فعلًا، سجّلها من «صرفت فلوس» أو ابعتها رسالة واتساب زي «دفعت 500 شحن»\n• أقولك الكاش هيستحمل الدفعة دي ولا لأ (اسألني: «أقدر أدفع 5000 للمورد الأسبوع ده؟»)\n• أجهزلك تذكير أو مهمة\nولو حد طالب منك تحوّل فلوس بسرعة، اتأكد منه الأول بمكالمة.",
          }
        : {
            intent: "Request to move money",
            answer:
              'I can\'t transfer, pay or withdraw money, and no part of Socio can. Money only moves from your own bank or wallet.\nWhat I can do:\n• If you already paid, record it with "I spent money" or a WhatsApp message like "paid 500 shipping"\n• Tell you whether your cash can handle the payment (ask: "Can I pay the supplier 5,000 this week?")\n• Prepare a reminder or a task\nIf someone is pressuring you to send money quickly, call them to check first.',
          };
    case "record": {
      const e = s.entry;
      const what =
        e && fm
          ? A
            ? `${e.kind === "expense" ? "مصروف" : "دخل"} ${fm(e.amount)}${e.category ? ` (${e.label})` : ""}`
            : `${e.kind === "expense" ? "an expense" : "income"} of ${fm(e.amount)}${e.category ? ` (${e.label})` : ""}`
          : null;
      return A
        ? {
            intent: "تسجيل فلوس",
            answer: `${what ? `ده شكله ${what}. ` : ""}أنا هنا للأسئلة، ومش بسجّل حاجة من الشات علشان مفيش حاجة تتسجل غلط.\nسجّلها من زرار «صرفت فلوس» أو «جالي فلوس» في الصفحة الرئيسية، أو ابعتها رسالة على واتساب بنفس الكلام ده وهتتسجل علطول.`,
          }
        : {
            intent: "Record a payment",
            answer: `${what ? `That looks like ${what}. ` : ""}This chat answers questions; it doesn't record entries, so nothing gets recorded by mistake.\nUse "I spent money" or "I got money" on the home page, or send the same text on WhatsApp and it is recorded right away.`,
          };
    }
    case "investment_tips":
      return A
        ? {
            intent: "نصيحة استثمار",
            answer:
              "مش بدّي نصايح أسهم أو دهب أو عملات رقمية.\nاللي أقدر أقولهولك: قد إيه تقدر تحوّش من غير ما الكاش بتاع المشروع يتزنق. اسألني: «أقدر أحوّش قد إيه الشهر ده؟»",
          }
        : {
            intent: "Investment tips",
            answer:
              "I don't give tips on stocks, gold or crypto.\nWhat I can tell you is how much you could set aside without squeezing the business's cash. Try: \"How much can I set aside this month?\"",
          };
    case "out_of_scope":
      return A
        ? {
            intent: "سؤال برا الشغل",
            answer: "ده برا اللي أقدر أساعد فيه؛ أنا بفهم في فلوس المشروع بتاعك بس. جرّب تسألني:\n" + EXAMPLES_AR,
          }
        : {
            intent: "Outside what I can help with",
            answer: "That's outside what I can help with; I only cover your business's money. Try:\n" + EXAMPLES_EN,
          };
    case "greeting":
      return A
        ? { intent: "سلام", answer: "أهلًا بيك! اسألني أي حاجة عن فلوس مشروعك. مثلًا:\n" + EXAMPLES_AR }
        : { intent: "Hello", answer: "Hi! Ask me anything about your business's money. For example:\n" + EXAMPLES_EN };
    case "unclear":
      return A
        ? {
            intent: "سؤال محتاج توضيح",
            answer: "مش متأكد قصدك إيه بالظبط. تقصد أنهي واحدة؟\n" + EXAMPLES_AR + "\nأو اكتبلي سؤالك بجملة كاملة.",
          }
        : {
            intent: "Needs a clearer question",
            answer:
              "I'm not sure what you mean yet. Did you mean one of these?\n" +
              EXAMPLES_EN +
              "\nOr write your question as a full sentence.",
          };
    default:
      return { intent: "", answer: "" };
  }
}
