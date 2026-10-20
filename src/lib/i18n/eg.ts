// Egyptian Arabic: exact phrases from the dictionary, then patterns for sentences that carry numbers and dates.
import { DICT } from "./eg-dict";

const KIND_AR: Record<string, string> = {
  "Supplier credit (pay a bill later)": "تأجيل من المورد (تدفع الفاتورة بعدين)",
  "Invoice financing (advance on what customers owe)": "تمويل فواتير (سلفة على فلوس العملا)",
  "Overdraft / credit line": "حساب على المكشوف / خط ائتمان",
  "Short-term loan": "قرض قصير",
  "Revenue advance (repaid from daily sales)": "سلفة على المبيعات (بتتسدد من المبيعات اليومية)",
  "Owner or family funds": "فلوس منك أو من العيلة",
};

const FRAGMENTS: Record<string, string> = {
  ...KIND_AR,
  "· repaid": "· بيتسدد",
  "in one payment": "مرة واحدة",
  monthly: "شهري",
  weekly: "أسبوعي",
  "from daily sales": "من المبيعات اليومية",
  days: "يوم",
  day: "يوم",
  "Your share (": "نصيبك (",
  "%)": "%)",
  "/mo": "/شهر",
  "a month": "في الشهر",
  "per month": "في الشهر",
  "· dips on": "· بينزل يوم",
  "Prepared for": "متجهز لـ",
  "Lowest in 30 days:": "أقل كاش في 30 يوم:",
  reserve: "حد الأمان",
  "Recorded across 3 account(s). Not the same as profit.": "متسجل في 3 حسابات. مش زي الربح.",
  of: "من",
  sold: "اتباعوا",
  "in the period": "في الفترة",
};

// Money: "EGP 1,234.50" / "−EGP 12K" → "1,234.50 جنيه" / "−12 ألف جنيه"
function money(s: string): string {
  return s.replace(
    /([−+-]?)EGP\s?([\d,]+(?:\.\d+)?)(K|M)?/g,
    (_m, sign: string, n: string, unit?: string) =>
      `${sign}${n}${unit === "K" ? " ألف" : unit === "M" ? " مليون" : ""} جنيه`,
  );
}

const D = "(\\d{4}-\\d{2}-\\d{2})";
const M = "([−+-]?EGP\\s?[\\d,]+(?:\\.\\d+)?[KM]?)";
const N = "([\\d.,]+)";
const P: [RegExp, (...g: string[]) => string][] = [
  // home
  [
    new RegExp(`^Here is how the business is doing this month — ${N} of ${N} days in\\.$`),
    (a, b) => `ده وضع البيزنس الشهر ده — عدّى ${a} يوم من ${b}.`,
  ],
  [new RegExp(`^Lowest in 30 days: ${M} on ${D}$`), (m, d) => `أقل كاش في 30 يوم: ${m} يوم ${d}`],
  [
    new RegExp(
      `^Your business kept this much after the costs recorded this month — about ${N} out of every 100 you sold\\.$`,
    ),
    (n) => `ده اللي فضل للبيزنس بعد مصاريف الشهر — حوالي ${n} من كل 100 بعتهم.`,
  ],
  [new RegExp(`^${N} of every 100 sold kept$`), (n) => `بيفضل ${n} من كل 100`],
  [
    new RegExp(`^With the payments you have scheduled, your lowest balance over the next 45 days is$`),
    () => "بالمدفوعات المجدولة، أقل رصيد في الـ 45 يوم الجايين هيبقى",
  ],
  // findings titles & summaries
  [new RegExp(`^Cash may dip below your safety reserve on ${D}$`), (d) => `الكاش ممكن ينزل تحت حد الأمان يوم ${d}`],
  [new RegExp(`^Cash may run out around ${D}$`), (d) => `الكاش ممكن يخلص حوالي ${d}`],
  [new RegExp(`^(.+) loses about ${M} on every sale$`), (p, m) => `${tr(p) ?? p} بيخسّرك حوالي ${m} في كل بيعة`],
  [
    new RegExp(`^Extra ad spend is costing about ${M} a month more than it earns$`),
    (m) => `الإعلانات الزيادة بتكلفك حوالي ${m} في الشهر أكتر من اللي بتجيبه`,
  ],
  [new RegExp(`^Put ${M} aside for taxes$`), (m) => `حط ${m} على جنب للضرايب`],
  [/^After taxes and bills, cash is thinner than it looks$/, () => "بعد الضرايب والفواتير، الكاش أقل من ما هو باين"],
  [
    new RegExp(`^Part of the tax money has already been spent \\(${M} short\\)$`),
    (m) => `جزء من فلوس الضرايب اتصرف خلاص (ناقص ${m})`,
  ],
  [
    new RegExp(`^About ${M} of your cash belongs to the tax office\\. (.*)$`),
    (m, rest) => `حوالي ${m} من الكاش بتاع الضرايب. ${tr(rest) ?? rest}`,
  ],
  [/^Keeping it separate stops it from being spent by accident\.$/, () => "لو حطيتها لوحدها مش هتتصرف بالغلط."],
  [
    new RegExp(`^Once it is paid and the next 30 days of bills go out, you are left with ${M}\\.$`),
    (m) => `بعد ما تتدفع وتطلع فواتير الـ 30 يوم، هيفضل معاك ${m}.`,
  ],
  [new RegExp(`^Put ${M} into a tax reserve$`), (m) => `حط ${m} في احتياطي الضرايب`],
  [new RegExp(`^Plan the VAT payment before ${D}$`), (d) => `خطط لدفع القيمة المضافة قبل ${d}`],
  [new RegExp(`^Raise the price of (.+) by ${M} \\(${N}%\\)$`), (p, m, n) => `زوّد سعر ${tr(p) ?? p} ${m} (${n}%)`],
  [new RegExp(`^Stop selling (.+)$`), (p) => `وقّف بيع ${tr(p) ?? p}`],
  [
    new RegExp(`^Sell (.+) only with other items \\(bundle or minimum order\\)$`),
    (p) => `بيع ${tr(p) ?? p} مع حاجات تانية بس (باكدج أو حد أدنى للطلب)`,
  ],
  [new RegExp(`^Ask the supplier for ${M} less per unit$`), (m) => `اطلب من المورد يقلل ${m} في القطعة`],
  [new RegExp(`^Bring ad spend back to about ${M} a month$`), (m) => `رجّع صرف الإعلانات لحوالي ${m} في الشهر`],
  [/^Cut ad spend by 30% and watch sales for two weeks$/, () => "قلل الإعلانات 30% وراقب المبيعات أسبوعين"],
  [/^Cut ad spend by 30% until cash recovers$/, () => "قلل الإعلانات 30% لحد ما الكاش يتحسن"],
  [/^Pause the weakest campaign first$/, () => "وقّف أضعف حملة الأول"],
  [new RegExp(`^Collect ${M} owed to you this week$`), (m) => `حصّل ${m} ليك عند الناس الأسبوع ده`],
  [new RegExp(`^Ask to pay (.+) 30 days later$`), (p) => `اطلب تأجيل دفع ${tr(p) ?? p} 30 يوم`],
  [new RegExp(`^Pause (.+) once$`), (p) => `وقّف ${tr(p) ?? p} مرة واحدة`],
  // financing
  [new RegExp(`^by ${D}$`), (d) => `قبل ${d}`],
  [
    new RegExp(
      `^Without it, cash falls to ${M} on ${D}, below your safety reserve of ${M}\\.(?: The best offer below covers it for ${M} in total cost\\.)?(?: None of the offers you added covers it safely yet\\.)?$`,
    ),
    (a, d, r, c) =>
      `من غيره الكاش هينزل لـ ${a} يوم ${d}، تحت حد الأمان (${r}).${c ? ` أحسن عرض تحت بيغطيه بتكلفة ${c}.` : ""}`,
  ],
  [
    new RegExp(`^Keeps cash above ${M} for the next ${N} days, including the repayments\\.$`),
    (m, n) => `بيخلي الكاش فوق ${m} طول الـ ${n} يوم الجايين، حتى مع الأقساط.`,
  ],
  [
    new RegExp(`^Not enough on its own, or the repayments create a new dip: cash falls below ${M} on ${D}\\.$`),
    (m, d) => `مش كفاية لوحده، أو الأقساط بتعمل أزمة جديدة: الكاش بينزل تحت ${m} يوم ${d}.`,
  ],
  [
    new RegExp(`^Repayments start too early: cash falls below ${M} on ${D}\\.$`),
    (m, d) => `الأقساط بتبدأ بدري: الكاش بينزل تحت ${m} يوم ${d}.`,
  ],
  [
    new RegExp(`^Costs ${N}% a year: you would pay back more than double over a year\\.$`),
    (n) => `بيكلف ${n}% في السنة: هترجّع أكتر من الضعف في سنة.`,
  ],
  [new RegExp(`^Costs ${N}% a year, which is very expensive\\.$`), (n) => `بيكلف ${n}% في السنة، وده غالي جدًا.`],
  [
    new RegExp(`^Advertised as a ${N}% fee, but because it is repaid quickly the true annual cost is ${N}%\\.$`),
    (a, b) => `بيقولوا رسوم ${a}% بس، لكن عشان بيتسدد بسرعة التكلفة السنوية الحقيقية ${b}%.`,
  ],
  [
    new RegExp(
      `^Repayments would take ${N}% of what the business earns each month, leaving little room for a bad month\\.$`,
    ),
    (n) => `الأقساط هتاخد ${n}% من مكسب الشركة كل شهر، ومش هيفضل مجال لشهر وحش.`,
  ],
  [
    new RegExp(
      `^Repayments of about ${M} a month are more than the business earns \\(${M} a month\\)\\. This loan could sink the business\\.$`,
    ),
    (a, b) => `القسط حوالي ${a} في الشهر، أكتر من مكسب الشركة (${b} في الشهر). القرض ده ممكن يغرّق المشروع.`,
  ],
  [
    new RegExp(`^An upfront fee of ${N}% means you receive noticeably less than the headline amount\\.$`),
    (n) => `رسوم مقدمة ${n}% معناها إنك هتستلم أقل بكتير من المبلغ المعلن.`,
  ],
  [new RegExp(`^${N} months? of records$`), (n) => `${n} شهور حسابات`],
  [new RegExp(`^${M} a month on average$`), (m) => `${m} في الشهر في المتوسط`],
  [new RegExp(`^Data completeness ${N}/100(.*)$`), (n, rest) => `اكتمال البيانات ${n}/100${rest}`],
  [new RegExp(`^${N}% of what customers owe is late$`), (n) => `${n}% من فلوسك عند العملا متأخرة`],
  [new RegExp(`^Cash covers about ${N} months? of costs$`), (n) => `الكاش بيغطي حوالي ${n} شهر مصاريف`],
  [/^No losing month in the last 3$/, () => "مفيش شهر خسران في آخر 3 شهور"],
  [new RegExp(`^${N} of the last 3 months lost money$`), (n) => `${n} من آخر 3 شهور كانوا خسرانين`],
  [new RegExp(`^${N} of ${N} required papers done$`), (a, b) => `${a} من ${b} أوراق مطلوبة خلصت`],
  [/^Getting there\. Biggest gain: (.+)\.$/, (x) => `قرّبت. أكبر فرق هيعمله: ${tr(cap(x)) ?? x}.`],
  [/^Not ready yet\. Start with: (.+)\.$/, (x) => `لسه مش جاهز. ابدأ بـ: ${tr(cap(x)) ?? x}.`],
  [/^→ (.+)$/, (x) => `← ${tr(x) ?? x}`],
  [
    /^Keep recording every sale and cost; lenders usually want 6\+ months\.$/,
    () => "كمّل سجّل كل بيعة ومصروف؛ البنوك عادة عايزة 6 شهور أو أكتر.",
  ],
  [
    /^Collect overdue invoices \(the co-pilot can draft the reminders\)\.$/,
    () => "حصّل الفواتير المتأخرة (المساعد يقدر يكتبلك التذكيرات).",
  ],
  [
    /^Finish the required papers in Company health \(commercial register, tax card\)\.$/,
    () => "خلّص الورق المطلوب في صحة الشركة (سجل تجاري، بطاقة ضريبية).",
  ],
  [
    /^Build a reserve of at least one month of costs before borrowing\.$/,
    () => "اعمل احتياطي يغطي شهر مصاريف على الأقل قبل ما تقترض.",
  ],
  [
    /^Fix losing products and costs first \(see the Action Center\); a loan does not fix a loss\.$/,
    () => "صلّح المنتجات والمصاريف الخسرانة الأول (شوف مركز الأفعال)؛ القرض مبيصلحش خسارة.",
  ],
  // money plan
  [new RegExp(`^${M}/mo$`), (m) => `${m}/شهر`],
  [new RegExp(`^${D} → ${D}$`), (a, b) => `${a} ← ${b}`],
  [
    /^Taxes = the VAT inside your sales \(estimated\), which you collect for the tax office\. Your pay and what stays in the business are split from the profit using your share \((\d+)%\)\.$/,
    (n) =>
      `الضرايب = القيمة المضافة اللي جوه مبيعاتك (تقديرية)، اللي بتجمعها لمصلحة الضرايب. مرتبك واللي بيفضل في الشركة بيتقسموا من الربح بنصيبك (${n}%).`,
  ],
  // media buyer
  [
    new RegExp(
      `^Cash is already expected to dip below your safety reserve on ${D}\\. Spending ${M} on ads now makes that worse — fix the cash gap first, or spend less\\.$`,
    ),
    (d, m) =>
      `الكاش متوقع ينزل تحت حد الأمان يوم ${d}. صرف ${m} على الإعلانات دلوقتي هيخليها أوحش — صلّح فجوة الكاش الأول، أو اصرف أقل.`,
  ],
  [
    new RegExp(`^You can afford it: ${M} is within the ${M} the business can spend today\\.$`),
    (a, b) => `تقدر عليها: ${a} في حدود الـ ${b} اللي الشركة تقدر تصرفهم النهارده.`,
  ],
  [
    new RegExp(
      `^It keeps the most per sale \\(${M} after its cost, fees and shipping\\) and already sells \\(${N} in the period\\)\\.$`,
    ),
    (m, n) => `بيكسّب أكتر في البيعة (${m} بعد تكلفته والرسوم والشحن) وبيتباع فعلًا (${n} في الفترة).`,
  ],
  [
    new RegExp(
      `^To be worth it, ${M} must bring at least ${N} sales? \\(one per ${M}\\); the goal is ${N}\\+\\. (.*)$`,
    ),
    (a, n, c, g, rest) =>
      `عشان يستاهل، الـ ${a} لازم تجيب ${n} بيعة على الأقل (بيعة لكل ${c})؛ والهدف ${g}+. ${tr(rest) ?? rest}`,
  ],
  [
    new RegExp(
      `^One sale may cost up to ${M} — more than this whole budget — so even one sale makes it worth it; a bigger budget gives a clearer answer\\. (.*)$`,
    ),
    (m, rest) =>
      `البيعة ممكن تكلف لحد ${m} — أكتر من الميزانية كلها — فبيعة واحدة كفاية عشان يستاهل؛ وميزانية أكبر بتدي إجابة أوضح. ${tr(rest) ?? rest}`,
  ],
  [
    new RegExp(`^Your past ads returned ${N}× their cost \\(as reported by the platform\\)\\.$`),
    (n) => `إعلاناتك اللي فاتت رجّعت ${n}× تكلفتها (حسب المنصة).`,
  ],
  [
    /^There is no ad history yet, so results are not predicted — they will be measured\.$/,
    () => "لسه مفيش تاريخ إعلانات، فالنتايج مش متوقعة — هتتقاس.",
  ],
  [new RegExp(`^≈ ${N} sales? if met$`), (n) => `≈ ${n} بيعة لو اتحقق`],
  [
    new RegExp(
      `^Your prices are in EGP but people in (.+) pay in (\\w+)\\. Type the local price in the ad yourself — it is never converted automatically\\.$`,
    ),
    (c, cur) =>
      `أسعارك بالجنيه بس الناس في ${tr(c) ?? c} بيدفعوا بـ ${cur}. اكتب السعر المحلي في الإعلان بنفسك — مش بيتحوّل لوحده.`,
  ],
  [
    new RegExp(`^People aged 18–45 in (.+) interested in (.+)\\.$`),
    (c, i) => `ناس من 18 لـ 45 سنة في ${tr(c) ?? c} مهتمين بـ ${i}.`,
  ],
  [new RegExp(`^${M} · ${N} days · (.+)$`), (m, n, c) => `${m} · ${n} يوم · ${tr(c) ?? c}`],
  [new RegExp(`^(.+) — keeps ${M}/sale$`), (p, m) => `${p} — بيكسّب ${m} في البيعة`],
  [/^(.+) — loses money$/, (p) => `${p} — بيخسّر`],
  // whatsapp / misc
  [new RegExp(`^Saved: (.+)$`), (x) => `محفوظ: ${x}`],
  [new RegExp(`^${N} days$`), (n) => `${n} يوم`],
  [new RegExp(`^(\\d+) (?:thing|things) worth your attention$`), (n) => `${n} حاجات تستاهل انتباهك`],
  [/^All checks passed$/, () => "كل الفحوصات تمام"],
  [
    new RegExp(`^Repeats every (month|year) from ${D}\\. We will remind you before each one\\.$`),
    (p, d) => `بيتكرر كل ${p === "month" ? "شهر" : "سنة"} من ${d}. هنفكرك قبل كل مرة.`,
  ],
  [
    new RegExp(`^Planned for ${D}\\. It shows in your calendar and we will remind you\\.$`),
    (d) => `متخطط ليوم ${d}. هيظهر في التقويم وهنفكرك.`,
  ],
  [new RegExp(`^${M} is overdue$`), (m) => `${m} متأخرة`],
  [new RegExp(`^after ${M} refunds$`), (m) => `بعد مرتجعات ${m}`],
  [new RegExp(`^On pace for ${M} — may exceed this budget$`), (m) => `بالسرعة دي هيوصل ${m} — ممكن يعدّي الميزانية`],
  [new RegExp(`^On pace for ${M}$`), (m) => `بالسرعة دي هيوصل ${m}`],
  [/^(\d+) waiting for approval$/, (n) => `${n} مستني موافقة`],
  // agent tool summaries and answers
  [
    new RegExp(`^Cash may fall below ${M} on ${D}; lowest ${M} on ${D}\\.$`),
    (a, d, b, d2) => `الكاش ممكن ينزل تحت ${a} يوم ${d}؛ وأقل رصيد ${b} يوم ${d2}.`,
  ],
  [
    new RegExp(`^No dip below ${M} in the next ${N} days; lowest ${M}\\.$`),
    (a, n, b) => `مفيش نزول تحت ${a} في الـ ${n} يوم الجايين؛ وأقل رصيد ${b}.`,
  ],
  [
    new RegExp(`^Need about ${M} by ${D}(?:; best offer: (.+) \\(cost ${M}\\)|; no safe offer recorded)\\.$`),
    (m, d, l, c) =>
      `محتاج حوالي ${m} قبل ${d}${l ? `؛ أحسن عرض: ${tr(l) ?? l} (تكلفته ${c})` : "؛ مفيش عرض آمن متسجل"}.`,
  ],
  [
    new RegExp(`^About ${M} belongs to the tax office \\(plan to pay by ${D}\\)\\.$`),
    (m, d) => `حوالي ${m} بتاع الضرايب (خطط تدفعها قبل ${d}).`,
  ],
  [
    new RegExp(`^Operating profit ${M} over ${N} days(?:; best product (.+))?\\.$`),
    (m, n, p) => `ربح التشغيل ${m} في ${n} يوم${p ? `؛ أحسن منتج ${tr(p) ?? p}` : ""}.`,
  ],
  [
    /^(\d+) open findings?: (.+)\.$/,
    (n, list) =>
      `${n} ملاحظات مفتوحة: ${list
        .split("; ")
        .map((x) => tr(x) ?? x)
        .join("؛ ")}.`,
  ],
  [/^Not allowed: (.+)$/, (r) => `مش مسموح: ${tr(r) ?? r}`],
  [
    /^The AI model was unavailable \((.+)\); answered with the built-in planner instead\.$/,
    () => "الذكاء الاصطناعي مكانش متاح؛ جاوب المخطط الداخلي بدل كده.",
  ],
  [
    new RegExp(
      `^You need about ${M} by ${D} to stay above your safety reserve\\.(?: The best option is (.+?): you receive ${M}, repay ${M} \\(true cost ${M}, (n\\/a|\\d+% a year)\\), and cash stays safe including the repayments\\.)?(?: None of the recorded offers keeps cash safe; add the offers you received to compare them\\.)?(?: Avoid: (.+)\\.)?$`,
      "s",
    ),
    (m, d, best, rec, rep, cost, apr, avoid) => {
      let out = `محتاج حوالي ${m} قبل ${d} عشان تفضل فوق حد الأمان.`;
      if (best)
        out += ` أحسن اختيار ${tr(best) ?? best}: هتستلم ${rec} وهترجّع ${rep} (التكلفة الحقيقية ${cost}، ${apr === "n/a" ? "مش محسوبة" : apr.replace(" a year", " في السنة")})، والكاش هيفضل في الأمان حتى مع الأقساط.`;
      else out += " ولا عرض من المسجلين بيحافظ على الكاش؛ ضيف العروض اللي جاتلك عشان نقارنها.";
      if (avoid)
        out += ` ابعد عن: ${avoid
          .split("; ")
          .map((x) => {
            const mm = x.match(/^(.+?) \((.+)\)$/);
            return mm ? `${tr(mm[1]) ?? mm[1]} (${tr(mm[2]) ?? mm[2]})` : x;
          })
          .join("؛ ")}.`;
      return out;
    },
  ],
  [
    new RegExp(
      `^About ${M} of your cash belongs to the tax office \\(VAT ${M}(?:, income-tax reserve ${M})?\\)\\. Plan to pay last month's VAT by ${D}\\. I marked it as a tax reserve so it is not counted as spendable\\.$`,
    ),
    (a, v, i, d) =>
      `حوالي ${a} من الكاش بتاع الضرايب (قيمة مضافة ${v}${i ? `، واحتياطي ضريبة دخل ${i}` : ""}). خطط تدفع قيمة الشهر اللي فات قبل ${d}. وحجزتها كاحتياطي ضرايب عشان متتحسبش فلوس متاحة.`,
  ],
  [
    new RegExp(
      `^The largest unpaid invoice is “(.+)” for ${M}, due ${D}\\. (Email is not set up, so I prepared a draft you can send yourself\\.|The reminder is waiting for your approval\\.)$`,
    ),
    (desc, m, d, tail) =>
      `أكبر فاتورة لسه متدفعتش «${tr(desc) ?? desc}» بـ ${m}، ميعادها ${d}. ${tail.startsWith("Email") ? "الإيميل مش متوصل، فجهزتلك مسودة تبعتها بنفسك." : "التذكير مستني موافقتك."}`,
  ],
  [
    new RegExp(
      `^(.+): the lowest cash becomes ${M}\\. Only record it after the supplier agrees; the change is waiting for your approval\\.$`,
    ),
    (o, m) => `${tr(o) ?? o}: أقل كاش هيبقى ${m}. سجّلها بس بعد ما المورد يوافق؛ والتغيير مستني موافقتك.`,
  ],
  [
    /^Start with: (.+?)\. (?:Best first step: (.+?)\. )?(.+)$/,
    (t1, step, rest) =>
      `ابدأ بـ: ${tr(t1) ?? t1}.${step ? ` أول خطوة: ${tr(step) ?? step}.` : ""} ${tr(rest.trim()) ?? rest}`,
  ],
  [/^Nothing needs attention\. (.+)$/, (rest) => `مفيش حاجة محتاجة انتباه. ${tr(rest) ?? rest}`],
  [/^About (\d+) out of every 100 you sold\.$/, (n) => `حوالي ${n} من كل 100 بعتهم.`],
  [
    /^Illustrative (?:cash timeline|scenario comparison)\. From (.+) to (.+)\. Use arrow keys to inspect values\.$/,
    (a, b) => `مثال توضيحي. من ${a} لـ ${b}. استخدم الأسهم عشان تشوف القيم.`,
  ],
  [
    /^Profit and cash are different things: (.+) you sold has not been paid yet\.$/,
    (m) => `الربح والكاش حاجتين مختلفين: ${m} من اللي بعته لسه متدفعش.`,
  ],
  [/^What if — hire a designer at (.+) \/ month$/, (m) => `لو — عيّنت مصمم بـ ${m} في الشهر`],
  [/^(.+) · projected$/, (x) => `${tr(x) ?? x} · متوقع`],
  [
    /^(Fabric supplier|Wholesale invoice) · (\d+) (\w+)$/,
    (w, d, m) => `${w === "Fabric supplier" ? "مورد القماش" : "فاتورة جملة"} · ${d} ${MONTHS[m] ?? m}`,
  ],
  [/^Delete (.+)$/, (x) => `امسح ${tr(x) ?? x}`],
  [/^Unit cost for (.+)$/, (x) => `تكلفة ${tr(x) ?? x}`],
  [/^(Locked up|Risk): (\d) of 4$/, (k, n) => `${k === "Risk" ? "المخاطرة" : "محبوسة"}: ${n} من 4`],
  [
    /^Permanently removes (.+) and every record in it\. Other workspaces are not affected\.$/,
    (x) => `بيمسح ${tr(x) ?? x} وكل حساباته نهائيًا. باقي المساحات مش هتتأثر.`,
  ],
  [new RegExp(`^${M} is set aside against a target of ${M}\\.$`), (a, b) => `${a} على جنب من هدف ${b}.`],
  [/^Online store — (\d+) orders$/, (n) => `المتجر الأونلاين — ${n} طلب`],
  [/^Select (.+)$/, (x) => `اختار ${tr(x) ?? x}`],
  [/^Remove (.+)$/, (x) => `شيل ${tr(x) ?? x}`],
  [new RegExp(`^${M} overdue$`), (m) => `${m} متأخرة`],
  [
    new RegExp(`^On the costs recorded, the business kept ${M} in this period\\.$`),
    (m) => `على حسب المصاريف المسجلة، البيزنس فضله ${m} في الفترة دي.`,
  ],
  [/^(.+) → (.+)$/, (a, b) => `${tr(a) ?? a} ← ${tr(b) ?? b}`],
  [/^(.+) ·$/, (a) => `${tr(a) ?? a} ·`],
  [new RegExp(`^${D}, (\\d+) item\\(s\\)$`), (d, n) => `${d}، ${n} حاجة`],
  [/^Notifications, (\d+) unread$/, (n) => `الإشعارات، ${n} مش مقروءة`],
  [new RegExp(`^${M} paid · ${M} still open$`), (a, b) => `اتدفع ${a} · فاضل ${b}`],
  [new RegExp(`^· cash dips below your reserve on ${D}$`), (d) => `· الكاش بينزل تحت حد الأمان يوم ${d}`],
  [new RegExp(`^· reserve ${M}$`), (m) => `· حد الأمان ${m}`],
  [new RegExp(`^— (\\d+) recent expenses have no category\\.$`), (n) => `— ${n} مصاريف حديثة من غير تصنيف.`],
  [new RegExp(`^Add “(.+)” to your to-do list$`), (t) => `إضافة «${tr(t) ?? t}» لقايمة المهام`],
  [/^Alert: (.+)$/, (t) => `تنبيه: ${tr(t) ?? t}`],
  [/^Mark (.+) as reserved for taxes \(“(.+)”\)$/, (m, l) => `اعتبر ${m} محجوزين للضرايب («${tr(l) ?? l}»)`],
  [
    new RegExp(`^A price of about ${M} covers its cost, fees, shipping and ad share at today's volume\\.$`),
    (m) => `سعر حوالي ${m} بيغطي التكلفة والرسوم والشحن ونصيب الإعلانات بنفس الكمية الحالية.`,
  ],
  [
    new RegExp(
      `^Ads went up ${N}% but sales (?:only rose ${N}%|fell)\\. Going back to the previous level would keep about ${M} more cash over the next 60 days\\.$`,
    ),
    (a, b, m) =>
      `الإعلانات زادت ${a}% بس المبيعات ${b ? `زادت ${b}% بس` : "قلّت"}. لو رجعت للمستوى اللي قبله هتوفر حوالي ${m} كاش زيادة في الـ 60 يوم الجايين.`,
  ],
  [
    new RegExp(`^Advertising: ${M} in the last 28 days, up ${N}% from ${M} the 28 days before\\.$`),
    (a, n, b) => `الإعلانات: ${a} في آخر 28 يوم، زيادة ${n}% عن ${b} في الـ 28 يوم اللي قبلهم.`,
  ],
  [new RegExp(`^At this pace that is about ${M} lost per month\\.$`), (m) => `بالشكل ده الخسارة حوالي ${m} في الشهر.`],
  [
    new RegExp(`^Before any advertising it already loses ${M} per unit\\.$`),
    (m) => `حتى من غير إعلانات بيخسر ${m} في القطعة.`,
  ],
  [
    new RegExp(
      `^Before advertising it earns ${M} per unit; its share of ad spend \\(${M} per unit\\) turns that into a loss of ${M}\\.$`,
    ),
    (a, b, c) => `من غير إعلانات بيكسب ${a} في القطعة؛ ونصيبه من الإعلانات (${b} في القطعة) بيقلبها خسارة ${c}.`,
  ],
  [
    new RegExp(`^${M} is due ${D}\\. Moving it to ${D} changes the lowest balance to ${M}\\.(.*)$`),
    (m, d, d2, l, rest) =>
      `${m} مستحقة يوم ${d}. لو اتأجلت لـ ${d2} أقل رصيد هيبقى ${l}.${rest ? ` ${tr(rest) ?? rest}` : ""}`,
  ],
  [
    new RegExp(`^${M} is scheduled on ${D}\\. Skipping it once changes the lowest balance to ${M}\\.$`),
    (m, d, l) => `${m} مجدولة يوم ${d}. لو اتلغت مرة واحدة أقل رصيد هيبقى ${l}.`,
  ],
  [
    new RegExp(
      `^Each extra 1 spent on ads brought about ${N} in sales\\. With a ${N}% gross margin you need at least ${N} just to break even\\.$`,
    ),
    (a, b, c) =>
      `كل جنيه زيادة في الإعلانات جاب حوالي ${a} مبيعات. وبهامش ربح إجمالي ${b}% محتاج ${c} على الأقل عشان متخسرش.`,
  ],
  [
    new RegExp(`^Each unit costs about ${M} to buy or make, plus about ${M} in fees, shipping and packaging\\.$`),
    (a, b) => `القطعة بتكلف حوالي ${a} شرا أو تصنيع، وحوالي ${b} رسوم وشحن وتغليف.`,
  ],
  [
    new RegExp(
      `^(Even before advertising|After its share of advertising), (.+) costs more to sell than it brings in — about ${M} a month\\. The simplest fix: raise its price by ${N}%\\.$`,
    ),
    (w, p, m, n) =>
      `${w.startsWith("Even") ? "حتى من غير إعلانات" : "بعد نصيبه من الإعلانات"}، بيع ${tr(p) ?? p} بيكلف أكتر من اللي بيجيبه — حوالي ${m} في الشهر. أسهل حل: زوّد سعره ${n}%.`,
  ],
  [
    new RegExp(`^Last month's sales carried about ${M} of VAT; plan to pay it by ${D}\\.$`),
    (m, d) => `مبيعات الشهر اللي فات فيها حوالي ${m} قيمة مضافة؛ خطط تدفعها قبل ${d}.`,
  ],
  [
    new RegExp(`^(.+) sold ${N} units? for ${M} in the last 30 days \\(about ${M} each\\)\\.$`),
    (p, n, m, e) => `${tr(p) ?? p} اتباع منه ${n} قطعة بـ ${m} في آخر 30 يوم (حوالي ${e} للقطعة).`,
  ],
  [
    new RegExp(
      `^Recorded cash is ${M}; after taxes, about ${M} is really yours\\. Scheduled payments in the next 30 days: ${M}\\.$`,
    ),
    (a, b, c) =>
      `الكاش المسجل ${a}؛ بعد الضرايب حوالي ${b} بتوعك فعلًا. المدفوعات المجدولة في الـ 30 يوم الجايين: ${c}.`,
  ],
  [new RegExp(`^Removes a loss of about ${M} a month\\.$`), (m) => `بيشيل خسارة حوالي ${m} في الشهر.`],
  [
    new RegExp(`^Sales this month include about ${M} of VAT \\(${N}%\\) that you collected for the tax office\\.$`),
    (m, n) => `مبيعات الشهر فيها حوالي ${m} قيمة مضافة (${n}%) جمعتها لمصلحة الضرايب.`,
  ],
  [
    new RegExp(`^Sales: ${M}, (up|down) ${N}% \\(${M}\\)\\.$`),
    (a, ud, n, d) => `المبيعات: ${a}، ${ud === "up" ? "زيادة" : "نقص"} ${n}% (${d}).`,
  ],
  [
    new RegExp(`^Saves about ${M} a month in spend; check sales before cutting more\\.$`),
    (m) => `بيوفر حوالي ${m} في الشهر؛ راجع المبيعات قبل ما تقلل أكتر.`,
  ],
  [
    new RegExp(`^So the extra spend cost about ${M} more than it earned — about ${M} a month\\.$`),
    (a, b) => `يعني الصرف الزيادة كلّف حوالي ${a} أكتر من اللي جابه — حوالي ${b} في الشهر.`,
  ],
  [
    new RegExp(
      `^Stops the extra spend that did not pay for itself\\. Lowest cash in the next 60 days rises from ${M} to about ${M}\\.$`,
    ),
    (a, b) => `بيوقف الصرف الزيادة اللي مجابش تمنه. أقل كاش في الـ 60 يوم الجايين هيعلى من ${a} لحوالي ${b}.`,
  ],
  [
    /^The ad platform credits "(.+)" with the lowest return \(([\d.]+) per 1 spent\); platforms tend to over-credit themselves\.$/,
    (c, n) => `المنصة بتقول إن حملة "${c}" هي الأقل عائد (${n} لكل جنيه)؛ والمنصات عادة بتبالغ في نتايجها.`,
  ],
  [new RegExp(`^You have already put ${M} aside in a tax reserve\\.$`), (m) => `حطيت ${m} على جنب في احتياطي الضرايب.`],
  [
    new RegExp(
      `^You spend about ${M} a month on ads\\. Cutting 30% saves roughly ${M} a week; the lowest balance becomes ${M}\\.$`,
    ),
    (a, b, c) =>
      `بتصرف حوالي ${a} في الشهر على الإعلانات. تقليل 30% بيوفر حوالي ${b} في الأسبوع؛ وأقل رصيد هيبقى ${c}.`,
  ],
  [
    /^Projected cash: (.+)\. From (.+) to (.+)\. Use arrow keys to inspect values\.$/,
    (_l, a, b) => `الكاش المتوقع. من ${a} لـ ${b}. استخدم الأسهم عشان تشوف القيم.`,
  ],
  // home & today
  [
    new RegExp(`^Lowest in 30 days: ${M} on ${D}(?: · reserve ${M})?$`),
    (m, d, r) => `أقل كاش في 30 يوم: ${m} يوم ${d}${r ? ` · حد الأمان ${r}` : ""}`,
  ],
  [
    new RegExp(`^Recorded across ${N} account\\(s\\)\\. Not the same as profit\\.$`),
    (n) => `متسجل في ${n} حساب. ده مش الربح.`,
  ],
  [
    new RegExp(
      `^With the payments you have scheduled, your lowest balance over the next ${N} days is ${M} on ${D}\\.$`,
    ),
    (n, m, d) => `بالمدفوعات المجدولة، أقل رصيد في الـ ${n} يوم الجايين هيبقى ${m} يوم ${d}.`,
  ],
  [new RegExp(`^You need about ${M} by ${D}$`), (m, d) => `محتاج حوالي ${m} قبل ${d}`],
  [
    new RegExp(`^Without it, cash falls to ${M} on ${D}, below your safety reserve of ${M}\\.$`),
    (a, d, r) => `من غيره الكاش هينزل لـ ${a} يوم ${d}، تحت حد الأمان (${r}).`,
  ],
  [new RegExp(`^The best offer below covers it for ${M} in total cost\\.$`), (m) => `أحسن عرض تحت بيغطيه بتكلفة ${m}.`],
  [/^None of the offers you added covers it safely yet\.$/, () => "ولا عرض من اللي ضفتهم بيغطيه بأمان لسه."],
  [new RegExp(`^No financing needed in the next ${N} days$`), (n) => `مش محتاج تمويل في الـ ${n} يوم الجايين`],
  [new RegExp(`^· dips on ${D}$`), (d) => `· بينزل يوم ${d}`],
  [new RegExp(`^(\\d+) waiting for approval$`), (n) => `${n} مستني موافقة`],
  [
    new RegExp(
      `^Scheduled payments and invoices, plus typical daily sales \\(at ${N}% of your last ${N} days, to stay on the safe side\\) and typical spending\\.$`,
    ),
    (a, b) =>
      `المدفوعات والفواتير المجدولة، والمبيعات اليومية المعتادة (${a}% من متوسط آخر ${b} يوم، عشان نبقى في الأمان) والمصاريف المعتادة.`,
  ],
  // cash risk
  [
    new RegExp(
      `^(?:Expected payments and income|Scheduled payments) take cash to ${M} on ${D}, below your safety reserve of ${M}\\. It first drops below the reserve on ${D}\\.(?: The most effective option: (.+?)(, which would keep you above the line)?\\.)?$`,
    ),
    (m, d, r, d2, opt, keeps) =>
      `الكاش هيوصل لـ ${m} يوم ${d}، تحت حد الأمان (${r}). أول مرة بينزل تحته يوم ${d2}.${opt ? ` أحسن حل: ${tr(cap(opt)) ?? opt}${keeps ? "، وده هيخليك فوق الحد" : ""}.` : ""}`,
  ],
  [new RegExp(`^Recorded cash today is ${M}\\.$`), (m) => `الكاش المسجل النهارده ${m}.`],
  [new RegExp(`^(.+) \\(${M}\\) is due ${D}\\.$`), (l, m, d) => `${l} (${m}) مستحقة يوم ${d}.`],
  [
    new RegExp(`^Sales over the last 30 days were ${M} versus ${M} in the 30 days before\\.$`),
    (a, b) => `المبيعات في آخر 30 يوم ${a} مقابل ${b} في الـ 30 يوم اللي قبلهم.`,
  ],
  [
    new RegExp(
      `^Future sales are estimated at ${N}% of your average over the last ${N} days, to stay on the safe side\\. If sales fall further, the dip is deeper\\.$`,
    ),
    (a, b) =>
      `المبيعات الجاية محسوبة بـ ${a}% من متوسط آخر ${b} يوم، عشان نبقى في الأمان. لو المبيعات قلّت أكتر، الأزمة هتبقى أكبر.`,
  ],
  [
    /^Socio has no bank connection; cash comes from the balances and transactions you recorded\.$/,
    () => "النظام مش متوصل بالبنك؛ الكاش محسوب من الأرصدة والحركات اللي سجلتها.",
  ],
  [
    new RegExp(`^Refunds rose to ${M} from ${M}; returns may be draining cash\\.$`),
    (a, b) => `المرتجعات زادت لـ ${a} بعد ما كانت ${b}؛ المرتجعات ممكن تكون بتسحب الكاش.`,
  ],
  [
    new RegExp(`^Data completeness: ${N}/100(?: — (.*))?$`),
    (n, rest) => `اكتمال البيانات: ${n}/100${rest ? ` — ${tr(rest) ?? rest}` : ""}`,
  ],
  [new RegExp(`^${N} recent expenses have no category\\.$`), (n) => `${n} مصاريف حديثة من غير تصنيف.`],
  // insights
  [/^(.+) is over budget$/, (c) => `${tr(c) ?? c} عدّى الميزانية`],
  [/^(.+) may exceed its budget$/, (c) => `${tr(c) ?? c} ممكن يعدّي الميزانية`],
  [/^(.+) spending is up (\d+)%$/, (c, n) => `مصاريف ${tr(c) ?? c} زادت ${n}%`],
  [/^(.+) is your largest cost$/, (c) => `${tr(c) ?? c} أكبر مصروف عندك`],
  [/^(\d+) overdue invoices?$/, (n) => `${n} فاتورة متأخرة`],
  [new RegExp(`^Cash may run short on ${D}$`), (d) => `الكاش ممكن يخلص يوم ${d}`],
  [
    new RegExp(`^You have spent ${M} against a ${M} (\\w+) budget \\(${N}% used\\)\\.$`),
    (a, b, p, n) => `صرفت ${a} من ميزانية ${b} (${n}% اتصرف).`,
  ],
  [
    new RegExp(`^${N}% of the (.+) budget is used with ${N}% of the period remaining\\.$`),
    (a, c, b) => `اتصرف ${a}% من ميزانية ${tr(c) ?? c} وفاضل ${b}% من الفترة.`,
  ],
  [
    new RegExp(`^(.+) is ${M} so far this month versus ${M} over the same days last month\\.$`),
    (c, a, b) => `${tr(c) ?? c}: ${a} الشهر ده لحد دلوقتي مقابل ${b} في نفس الأيام الشهر اللي فات.`,
  ],
  [new RegExp(`^${M} is past its due date and still unpaid\\.$`), (m) => `${m} عدّى ميعادها ولسه متدفعتش.`],
  [
    new RegExp(`^${N} of ${N} products have no cost, so their profit cannot be estimated\\.$`),
    (a, b) => `${a} من ${b} منتجات من غير تكلفة، فربحهم مش معروف.`,
  ],
  [
    new RegExp(`^${N} expenses have no category and are counted as operating expenses\\.$`),
    (n) => `${n} مصاريف من غير تصنيف ومتحسوبة مصاريف تشغيل.`,
  ],
  [
    new RegExp(`^Net profit is ${M} versus ${M} over the same days last month\\.$`),
    (a, b) => `صافي الربح ${a} مقابل ${b} في نفس الأيام الشهر اللي فات.`,
  ],
  [
    new RegExp(`^(.+) makes up ${N}% of this month's spending \\(${M} of ${M}\\)\\.$`),
    (c, n, a, b) => `${tr(c) ?? c} ${n}% من مصاريف الشهر (${a} من ${b}).`,
  ],
  [new RegExp(`^${M} of ${M} is set aside \\(${N}%\\)\\.$`), (a, b, n) => `${a} من ${b} اتحطوا على جنب (${n}%).`],
  [
    new RegExp(`^Scheduled payments bring your balance down to ${M} on ${D}\\.$`),
    (m, d) => `المدفوعات المجدولة هتنزّل رصيدك لـ ${m} يوم ${d}.`,
  ],
  // bills, salaries & health
  [/^(\d+) people$/, (n) => `${n} أشخاص`],
  [/^Mark (.+) as paid$/, (x) => `سجّل إن ${x} قبض`],
  [/^Edit (.+)$/, (x) => `تعديل ${x}`],
  [/^Stop (.+)$/, (x) => `وقّف ${tr(x) ?? x}`],
  [/^(.+) got paid$/, (x) => `${x} قبض`],
  [/^Salary — (.+)$/, (x) => `مرتب ${x}`],
  [/^Mark “(.+)” as done$/, (x) => `علّم «${tr(x) ?? x}» إنها خلصت`],
  [new RegExp(`^${M} – ${M}$`), (a, b) => `${a} – ${b}`],
  [new RegExp(`^Net profit over 90 days: ${M}\\.$`), (m) => `صافي الربح في 90 يوم: ${m}.`],
  [
    /^(\d+) month\(s\) recorded\. Buyers and lenders want a track record\.$/,
    (n) => `${n} شهور متسجلة. المشترين والمقرضين عايزين تاريخ.`,
  ],
  [/^(\d+)% of what you are owed is overdue\.$/, (n) => `${n}% من الفلوس اللي ليك متأخرة.`],
  [/^(\d+)% of the last 90 days' expenses have a category\.$/, (n) => `${n}% من مصاريف آخر 90 يوم متصنفة.`],
  [/^(\d+) of (\d+) required items done\.$/, (a, b) => `${a} من ${b} حاجات مطلوبة خلصت.`],
  [
    new RegExp(`^Projected cash for the next ${N} days\\. From ${M} to ${M}\\. Use arrow keys to inspect values\\.$`),
    (n, a, b) => `الكاش المتوقع للـ ${n} يوم الجايين. من ${a} لـ ${b}. استخدم الأسهم علشان تشوف القيم.`,
  ],
];

const MONTHS: Record<string, string> = {
  Jan: "يناير",
  Feb: "فبراير",
  Mar: "مارس",
  Apr: "أبريل",
  May: "مايو",
  Jun: "يونيو",
  Jul: "يوليو",
  Aug: "أغسطس",
  Sep: "سبتمبر",
  Oct: "أكتوبر",
  Nov: "نوفمبر",
  Dec: "ديسمبر",
  January: "يناير",
  February: "فبراير",
  March: "مارس",
  April: "أبريل",
  June: "يونيو",
  July: "يوليو",
  August: "أغسطس",
  September: "سبتمبر",
  October: "أكتوبر",
  November: "نوفمبر",
  December: "ديسمبر",
};

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function tr(key: string): string | null {
  const k = key.replace(/\s+/g, " ").trim();
  if (!k) return null;
  const hit = DICT[k] ?? FRAGMENTS[k] ?? DICT[k.replace(/→/g, "←")];
  if (hit) return hit;
  for (const [re, fn] of P) {
    const m = k.match(re);
    if (m) return money(fn(...m.slice(1)));
  }
  // Month labels on charts and calendars.
  const mo = k.match(/^([A-Z][a-z]+)(?: (\d{1,4}))?$/);
  if (mo && MONTHS[mo[1]])
    return mo[2] ? (mo[2].length === 4 ? `${MONTHS[mo[1]]} ${mo[2]}` : `${mo[2]} ${MONTHS[mo[1]]}`) : MONTHS[mo[1]];
  // "Label: 12.3" (chart legends) and composite strings joined with " · ".
  const lv = k.match(/^(.+): ([\d.,%]+)$/);
  if (lv && DICT[lv[1]]) return `${DICT[lv[1]]}: ${lv[2]}`;
  if (k.includes(" · ")) {
    const parts = k.split(" · ");
    const t = parts.map((x) => tr(x));
    if (t.some((x) => x !== null)) return parts.map((x, i) => t[i] ?? x).join(" · ");
  }
  // A bare amount, or a short label with an amount.
  if (/EGP\s?[\d,]/.test(k) && /^[−+\-]?EGP\s?[\d,.]+[KM]?$/.test(k)) return money(k);
  return null;
}

/* * Translates one text node's value, keeping its surrounding whitespace. Returns null when there is nothing to do. */
export function translateText(value: string): string | null {
  if (!/[A-Za-z]/.test(value)) return null;
  const lead = value.match(/^\s*/)?.[0] ?? "";
  const trail = value.match(/\s*$/)?.[0] ?? "";
  const r = tr(value);
  if (r !== null) return lead + r + trail;
  return null;
}
