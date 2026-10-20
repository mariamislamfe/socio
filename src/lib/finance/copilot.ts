// Deterministic financial Q&A. Every number comes from the engine; text only arranges and explains it.
import { normalize } from "./agentguard";
import { addDays, periodInfo } from "./dates";
import { invoiceOutstanding, spendByCategory, summarize } from "./engine";
import { adsSummary, generateInsights } from "./insights";
import { formatMoney } from "./money";
import { baseForecast, budgetView, cashBalance, goalProgress, monthlyBaseline } from "./planning";
import { simulate, type Adjustment } from "./scenarios";
import type { Snapshot } from "./snapshot";

export interface CopilotAnswer {
  intent: string;
  title: string;
  answer: string;
  facts: { label: string; value: string }[];
  actions: { label: string; href: string }[];
  assumptions: string[];
  needs?: { field: "amount" | "percent"; label: string; hint: string };
  verdict?: "ok" | "caution" | "no";
}

interface Parsed {
  intent: string;
  amount?: number; // minor
  percent?: number;
}

const MONEY = /(?:egp|usd|eur|sar|aed|£|\$|€)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m)?/i;

export function parseQuestion(q: string, currencyDigits = 2): Parsed {
  const s = q.toLowerCase().replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const pctMatch = s.match(/(\d+(?:\.\d+)?)\s*%/);
  const percent = pctMatch ? Number(pctMatch[1]) : undefined;
  let amount: number | undefined;
  const withoutPct = s.replace(/\d+(?:\.\d+)?\s*%/g, "");
  const m = withoutPct.match(MONEY);
  if (m) {
    let v = Number(m[1].replace(/,/g, ""));
    if (m[2] === "k") v *= 1000;
    if (m[2] === "m") v *= 1_000_000;
    if (v > 0) amount = Math.round(v * 10 ** currencyDigits);
  }
  // Arabic is normalised (alef forms, ة/ه, ى/ي, diacritics) so "الضريبة" and "الضريبه" match the same keyword.
  const n = normalize(q);
  const has = (...w: string[]) => w.some((x) => s.includes(x) || n.includes(normalize(x)));
  let intent = "unknown";
  if (
    has("hire", "employee", "designer", "salary", "freelancer", "اعين", "موظف جديد", "اشغل حد", "توظيف", "اجيب حد") &&
    has("afford", "can i", "should i", "hire", "اقدر", "ينفع", "استحمل", "اعين")
  )
    intent = "afford_hire";
  else if (
    has("inventory", "stock", "restock", "بضاعه", "مخزون", "استوك") &&
    has("afford", "can i", "order", "buy", "اقدر", "ينفع", "اشتري", "اجيب")
  )
    intent = "afford_inventory";
  else if (
    has("sales", "المبيعات", "البيع") &&
    has("decrease", "drop", "fall", "lower", "down", "what happens", "what if", "قلت", "نزلت", "وقعت")
  )
    intent = "sales_drop";
  else if (
    has("profit", "الربح", "المكسب") &&
    has("decrease", "down", "drop", "lower", "why", "fell", "less", "قل", "نزل", "ليه", "وقع")
  )
    intent = "why_profit";
  else if (
    has("largest", "biggest", "top", "most", "اكبر", "اكتر") &&
    has("expense", "cost", "spend", "مصروف", "مصاريف", "بصرف", "صرف")
  )
    intent = "top_expenses";
  else if (
    has(
      "which product",
      "best product",
      "best-selling",
      "products make",
      "product is",
      "making me money",
      "most profitable",
      "منتج",
    )
  )
    intent = "product_profit";
  else if (has("advertis", "ads", "ad spend", "marketing", "roas", "اعلان", "ماركتنج", "فيسبوك", "تيك توك", "انستجرام"))
    intent = "ads";
  else if (
    has(
      "due",
      "payment",
      "upcoming",
      "bills",
      "owe",
      "pay soon",
      "فواتير",
      "مستحق",
      "عليا",
      "هدفع",
      "المدفوعات",
      "مواعيد الدفع",
    )
  )
    intent = "payments_due";
  else if (has("reserve", "emergency", "safety", "احتياطي", "طوارئ", "تحويش", "احوش")) intent = "reserve";
  else if (has("budget", "ميزانيه")) intent = "budget_risk";
  else if (has("cash", "runway", "money do i have", "balance", "كاش", "رصيد", "معايا", "عندي كام", "فلوسي", "اصرف"))
    intent = "cash";
  else if (has("profit", "earn", "margin", "ربح", "مكسب", "كسبت", "بكسب")) intent = "profit";
  else if (has("revenue", "sold", "sales", "مبيعات", "بعت كام", "بيعت")) intent = "revenue";
  // Only when nothing more specific matched: "what should I focus on today?"
  if (intent === "unknown" && has("focus", "today", "priorit", "what should i do", "ركز", "النهارده", "اعمل ايه"))
    intent = "focus_today";
  return { intent, amount, percent };
}

export interface AnswerExtra {
  products?: { title: string; units: number; revenue: number; contribution: number | null; margin: number | null }[];
  openRecommendations?: { title: string }[];
}

export function answer(
  s: Snapshot,
  question: string,
  overrides: { amount?: number; percent?: number } = {},
  extra: AnswerExtra = {},
  lang: "en" | "ar" = "en",
): CopilotAnswer {
  // In Egyptian Arabic the sentences are written in Arabic (not machine-translated); numbers and dates stay the same.
  const ar = lang === "ar";
  const fm = (v: number) =>
    ar
      ? `${formatMoney(v, s.currency, { hideCurrency: true })} ${s.currency === "EGP" ? "جنيه" : s.currency}`
      : formatMoney(v, s.currency);
  const parsed = parseQuestion(question, s.currency === "JPY" ? 0 : 2);
  const amount = overrides.amount ?? parsed.amount;
  const percent = overrides.percent ?? parsed.percent;
  const month = periodInfo("month", s.today);
  const cur = summarize(s.txns, s.cats, s.currency, month.current);
  const prev = summarize(s.txns, s.cats, s.currency, month.previous);
  const cash = cashBalance(s).total;
  const empty = s.txns.length === 0;

  if (empty && parsed.intent !== "unknown")
    return {
      intent: parsed.intent,
      title: "I need some records first",
      answer: ar
        ? "لسه مفيش أي حركات متسجلة، فأي إجابة هتبقى تخمين. سجّل شوية فلوس داخلة وخارجة (أو ارفع ملف CSV) واسألني تاني."
        : "There are no transactions in this workspace yet, so any answer would be a guess. Add a few income and expense records (or import a CSV) and ask again.",
      facts: [],
      actions: [
        { label: "Add a transaction", href: "/app/transactions?new=expense" },
        { label: "Import CSV", href: "/app/settings/data" },
      ],
      assumptions: [],
    };

  switch (parsed.intent) {
    case "why_profit": {
      if (cur.revenue === 0 && prev.revenue === 0) break;
      const dRev = cur.revenue - prev.revenue;
      const dCogs = cur.cogs - prev.cogs;
      const dOpex = cur.opex - prev.opex;
      const dProfit = cur.netProfit - prev.netProfit;
      const drivers = [
        { n: "Revenue", v: dRev, impact: dRev },
        { n: "Cost of goods", v: dCogs, impact: -dCogs },
        { n: "Operating expenses", v: dOpex, impact: -dOpex },
      ].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
      const now = spendByCategory(s.txns, s.cats, s.currency, month.current);
      const was = spendByCategory(s.txns, s.cats, s.currency, month.previous);
      const cat = [...now.entries()]
        .filter(([id]) => id)
        .map(([id, v]) => ({ id: id!, d: v - (was.get(id) ?? 0) }))
        .sort((a, b) => b.d - a.d)[0];
      const cname = cat ? s.cats.find((c) => c.id === cat.id)?.name : undefined;
      const arDriver = (
        { Revenue: "المبيعات", "Cost of goods": "تكلفة البضاعة", "Operating expenses": "مصاريف التشغيل" } as Record<
          string,
          string
        >
      )[drivers[0].n];
      const text = ar
        ? dProfit >= 0
          ? `الربح ما قلّش: صافي الربح ${fm(cur.netProfit)} مقابل ${fm(prev.netProfit)} في نفس الأيام الشهر اللي فات.`
          : `صافي الربح ${fm(cur.netProfit)}، يعني أقل بـ ${fm(-dProfit)} عن نفس الأيام الشهر اللي فات (${fm(prev.netProfit)}). أكبر سبب هو ${arDriver} (أثره على الربح ${drivers[0].impact >= 0 ? "+" : "−"}${fm(Math.abs(drivers[0].impact))}).${cname && cat.d > 0 ? ` وأكتر مصروف زاد هو ${cname}، زاد ${fm(cat.d)}.` : ""}`
        : dProfit >= 0
          ? `Profit has not decreased: net profit is ${fm(cur.netProfit)} versus ${fm(prev.netProfit)} over the same days last month.`
          : `Net profit is ${fm(cur.netProfit)}, ${fm(-dProfit)} lower than the same days last month (${fm(prev.netProfit)}). The biggest driver is ${drivers[0].n.toLowerCase()} (${drivers[0].impact >= 0 ? "+" : "−"}${fm(Math.abs(drivers[0].impact))} effect on profit).${cname && cat.d > 0 ? ` Your largest rise in spending is ${cname}, up ${fm(cat.d)}.` : ""}`;
      return {
        intent: "why_profit",
        title: "Why profit changed",
        answer: text,
        facts: [
          { label: "Revenue (now vs. last month)", value: `${fm(cur.revenue)} vs ${fm(prev.revenue)}` },
          { label: "Cost of goods", value: `${fm(cur.cogs)} vs ${fm(prev.cogs)}` },
          { label: "Operating expenses", value: `${fm(cur.opex)} vs ${fm(prev.opex)}` },
          { label: "Net profit", value: `${fm(cur.netProfit)} vs ${fm(prev.netProfit)}` },
        ],
        actions: [{ label: "Open transactions", href: "/app/transactions" }],
        assumptions: [
          "Compares the same number of elapsed days in this and the previous month.",
          ...(cur.incomplete ? ["Profit is incomplete: product costs are missing."] : []),
        ],
      };
    }
    case "top_expenses": {
      const now = spendByCategory(s.txns, s.cats, s.currency, month.current);
      const top = [...now.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const total = [...now.values()].reduce((a, b) => a + b, 0);
      if (!top.length) break;
      return {
        intent: "top_expenses",
        title: "Largest expenses this month",
        answer: ar
          ? `صرفت ${fm(total)} لحد دلوقتي الشهر ده. أكبر بند هو ${s.cats.find((c) => c.id === top[0][0])?.name ?? "مصاريف من غير تصنيف"} بـ ${fm(top[0][1])} (${Math.round((top[0][1] / total) * 100)}%).`
          : `You have spent ${fm(total)} so far this month. ${s.cats.find((c) => c.id === top[0][0])?.name ?? "Uncategorized spending"} is the biggest at ${fm(top[0][1])} (${Math.round((top[0][1] / total) * 100)}%).`,
        facts: top.map(([id, v]) => ({
          label: s.cats.find((c) => c.id === id)?.name ?? "Uncategorized",
          value: `${fm(v)} · ${Math.round((v / total) * 100)}%`,
        })),
        actions: [{ label: "See all transactions", href: "/app/transactions" }],
        assumptions: ["Shows the category each expense was recorded under, not rolled-up parents."],
      };
    }
    case "ads": {
      const a = adsSummary(s.ads, s.currency, month.current);
      const recorded = s.cats.filter((c) => c.role === "ads").map((c) => c.id);
      const spendTx = [...spendByCategory(s.txns, s.cats, s.currency, month.current).entries()]
        .filter(
          ([id]) =>
            id &&
            (recorded.includes(id) || s.cats.find((c) => c.id === id && c.parent_id && recorded.includes(c.parent_id))),
        )
        .reduce((x, [, v]) => x + v, 0);
      const facts = [{ label: "Advertising recorded as expenses", value: fm(spendTx) }];
      if (a.spend > 0)
        facts.push(
          { label: "Ad platform spend", value: fm(a.spend) },
          { label: "Attributed revenue", value: fm(a.attributedRevenue) },
          { label: "ROAS", value: a.roas ? a.roas.toFixed(2) : "—" },
        );
      return {
        intent: "ads",
        title: "Advertising",
        answer: ar
          ? spendTx > 0
            ? `سجلت ${fm(spendTx)} مصاريف إعلانات الشهر ده${cur.revenue > 0 ? `، يعني حوالي ${Math.round((spendTx / cur.revenue) * 100)}% من صافي المبيعات` : ""}.${a.roas ? ` المنصة بتقول إن العائد على الإعلان (ROAS) ${a.roas.toFixed(2)}، ودي مبيعات منسوبة للإعلان مقابل كل 1 اتصرف، مش ربح.` : ""}`
            : "مفيش مصاريف إعلانات متسجلة الشهر ده."
          : spendTx > 0
            ? `You have recorded ${fm(spendTx)} of advertising expenses this month${cur.revenue > 0 ? `, about ${Math.round((spendTx / cur.revenue) * 100)}% of net revenue` : ""}.${a.roas ? ` Platform data shows ROAS of ${a.roas.toFixed(2)} — that is attributed revenue per 1 spent, not profit.` : ""}`
            : "No advertising expenses are recorded this month.",
        facts,
        actions: [{ label: "Open advertising", href: "/app/ads" }],
        assumptions: ["ROAS comes from ad-platform attribution, which can differ from your actual sales."],
      };
    }
    case "payments_due": {
      const f = baseForecast(s, 14);
      const out = f.events.filter((e) => e.amount < 0).slice(0, 8);
      const total = out.reduce((a, e) => a + -e.amount, 0);
      return {
        intent: "payments_due",
        title: "Payments due in the next 14 days",
        answer: ar
          ? out.length
            ? `عندك ${out.length} مدفوعات مجموعها ${fm(total)} في الـ 14 يوم الجايين. الكاش المتسجل معاك ${fm(cash)}.`
            : "مفيش حاجة مطلوب تدفعها في الـ 14 يوم الجايين."
          : out.length
            ? `${out.length} payment${out.length > 1 ? "s" : ""} totalling ${fm(total)} are scheduled in the next 14 days. Your recorded cash is ${fm(cash)}.`
            : "Nothing is scheduled to be paid in the next 14 days.",
        facts: out.map((e) => ({ label: `${e.label} · ${e.date}`, value: fm(-e.amount) })),
        actions: [
          { label: "Open cash flow", href: "/app/cash-flow" },
          { label: "Bills & invoices", href: "/app/obligations" },
        ],
        assumptions: ["Includes recurring schedules and open bills. Overdue bills are assumed paid tomorrow."],
      };
    }
    case "cash": {
      const f = baseForecast(s, 60);
      return {
        intent: "cash",
        title: "Your cash position",
        answer: ar
          ? `معاك ${fm(cash)} متسجلين في حساباتك. ${f.firstShortfallDate ? `المدفوعات المتجدولة هتنزّل الرصيد تحت الصفر يوم ${f.firstShortfallDate}.` : `مع المدفوعات المتجدولة الرصيد مش هيقل عن ${fm(f.minCash)} في الـ 60 يوم الجايين.`}`
          : `You have ${fm(cash)} recorded across your accounts. ${f.firstShortfallDate ? `Scheduled payments push this below zero on ${f.firstShortfallDate}.` : `Scheduled payments keep you at or above ${fm(f.minCash)} for the next 60 days.`}`,
        facts: [
          { label: "Recorded cash", value: fm(cash) },
          { label: "Lowest point (60 days)", value: `${fm(f.minCash)} · ${f.minCashDate}` },
        ],
        actions: [{ label: "Open cash flow", href: "/app/cash-flow" }],
        assumptions: f.assumptions.slice(0, 2),
      };
    }
    case "reserve": {
      const g = s.goals.find((x) => x.type === "reserve");
      if (!g)
        return {
          intent: "reserve",
          title: "Emergency reserve",
          answer: ar
            ? "لسه ما حددتش هدف للاحتياطي. حدد مبلغ على أساس كام شهر من المصاريف الأساسية عايز تغطيهم."
            : "You have not set a reserve goal yet. Set a target based on how many months of essential expenses you want to cover.",
          facts: [],
          actions: [{ label: "Set a reserve goal", href: "/app/goals" }],
          assumptions: [],
        };
      const p = goalProgress(g, s);
      return {
        intent: "reserve",
        title: "Emergency reserve",
        answer: ar
          ? `محوّش ${fm(p.current)} من ${fm(p.target)} (${Math.round(p.pct * 100)}%). ${p.safeNow !== undefined ? `من غير ما تعرّض مدفوعاتك للخطر، تقدر تحوّش لحد ${fm(p.safeNow)} دلوقتي.` : ""}`
          : `${fm(p.current)} of ${fm(p.target)} is set aside (${Math.round(p.pct * 100)}%). ${p.safeNow !== undefined ? `Without putting your scheduled payments at risk you could set aside up to ${fm(p.safeNow)} now.` : ""}`,
        facts: [
          { label: "Target", value: fm(p.target) },
          { label: "Basis", value: p.basis },
          ...(p.suggestedMonthly ? [{ label: "Suggested monthly contribution", value: fm(p.suggestedMonthly) }] : []),
        ],
        actions: [{ label: "Open goals", href: "/app/goals" }],
        assumptions: ["A reserve is a planning figure in Socio — no money is moved.", ...p.warnings],
      };
    }
    case "budget_risk": {
      const b = budgetView(s)
        .filter((x) => x.status !== "ok")
        .sort((a, c) => c.usedPct - a.usedPct);
      if (!budgetView(s).length)
        return {
          intent: "budget_risk",
          title: "Budgets",
          answer: ar ? "لسه ما عملتش ميزانيات." : "You have no budgets yet.",
          facts: [],
          actions: [{ label: "Create a budget", href: "/app/budgets" }],
          assumptions: [],
        };
      if (!b.length)
        return {
          intent: "budget_risk",
          title: "Budgets",
          answer: ar
            ? "كل الميزانيات ماشية تمام الفترة دي."
            : "All of your budgets are on track for the current period.",
          facts: [],
          actions: [{ label: "Open budgets", href: "/app/budgets" }],
          assumptions: [],
        };
      return {
        intent: "budget_risk",
        title: "Budgets at risk",
        answer: ar
          ? `${b[0].categoryName} هو الأقرب إنه يعدّي: اتصرف ${Math.round(Math.min(b[0].usedPct, 9.99) * 100)}% وفاضل ${Math.round((1 - b[0].timeElapsedPct) * 100)}% من الفترة.`
          : `${b[0].categoryName} is the most at risk: ${Math.round(Math.min(b[0].usedPct, 9.99) * 100)}% used with ${Math.round((1 - b[0].timeElapsedPct) * 100)}% of the period left.`,
        facts: b.map((x) => ({
          label: x.categoryName,
          value: `${fm(x.spent)} of ${fm(x.planned)} · ${x.status.replace("_", " ")}`,
        })),
        actions: [{ label: "Open budgets", href: "/app/budgets" }],
        assumptions: ["Pace-based projection assumes spending continues at the same daily rate."],
      };
    }
    case "profit":
    case "revenue": {
      return {
        intent: parsed.intent,
        title: parsed.intent === "profit" ? "Profit this month" : "Revenue this month",
        answer: ar
          ? `لحد دلوقتي الشهر ده بعت بـ ${fm(cur.revenue)} (بعد المرتجعات)، والمشروع فضله ${fm(cur.netProfit)} بعد المصاريف المتسجلة${cur.margin !== null ? `، يعني حوالي ${Math.round(cur.margin * 100)} من كل 100 بعتهم` : ""}.${cur.incomplete ? " الربح ممكن يكون ناقص لأن تكلفة المنتجات مش متسجلة." : ""}`
          : `So far this month you sold ${fm(cur.revenue)} (net of refunds) and your business kept ${fm(cur.netProfit)} after recorded costs${cur.margin !== null ? ` — about ${Math.round(cur.margin * 100)} out of every 100 sold` : ""}.${cur.incomplete ? " Profit looks incomplete because no product costs are recorded." : ""}`,
        facts: [
          { label: "Revenue", value: fm(cur.revenue) },
          { label: "Cost of goods", value: fm(cur.cogs) },
          { label: "Operating expenses", value: fm(cur.opex) },
          { label: "Net profit", value: fm(cur.netProfit) },
        ],
        actions: [{ label: "Open dashboard", href: "/app" }],
        assumptions: ["Costs are counted when recorded (cash basis)."],
      };
    }
    case "sales_drop": {
      const pc = percent ?? 20;
      const r = simulate(s, [{ type: "sales_drop", pct: pc }]);
      return {
        intent: "sales_drop",
        title: `If sales fall ${pc}%`,
        answer: ar
          ? `لو المبيعات قلّت ${pc}%، الربح الشهري المتوقع هيبقى ${fm(r.scenario.monthlyProfit)} بدل ${fm(r.baseline.monthlyProfit)}، والكاش بعد ${r.horizonDays} يوم هيبقى ${fm(r.scenario.endCash)} بدل ${fm(r.baseline.endCash)}.${r.scenario.firstShortfallDate ? ` الكاش هيخلص حوالي ${r.scenario.firstShortfallDate}.` : " الكاش هيفضل فوق الصفر."}`
          : `With ${pc}% lower sales, estimated monthly profit moves from ${fm(r.baseline.monthlyProfit)} to ${fm(r.scenario.monthlyProfit)}, and cash after ${r.horizonDays} days from ${fm(r.baseline.endCash)} to ${fm(r.scenario.endCash)}.${r.scenario.firstShortfallDate ? ` Cash would run short around ${r.scenario.firstShortfallDate}.` : " Cash would stay above zero."}`,
        facts: [
          { label: "Monthly profit", value: `${fm(r.baseline.monthlyProfit)} → ${fm(r.scenario.monthlyProfit)}` },
          { label: `Cash in ${r.horizonDays} days`, value: `${fm(r.baseline.endCash)} → ${fm(r.scenario.endCash)}` },
          { label: "Lowest cash", value: fm(r.scenario.minCash) },
        ],
        actions: [{ label: "Open the simulator", href: "/app/scenarios" }],
        assumptions: r.assumptions.concat(r.warnings),
      };
    }
    case "afford_hire":
    case "afford_inventory": {
      if (!amount) {
        return {
          intent: parsed.intent,
          title: parsed.intent === "afford_hire" ? "Can you afford a hire?" : "Can you afford more inventory?",
          answer: ar
            ? parsed.intent === "afford_hire"
              ? "أقدر أجرّبها على الكاش والمدفوعات والاحتياطي بتاعك. الموظف ده هيكلفك كام في الشهر؟"
              : "أقدر أجرّبها على الكاش والمدفوعات بتاعتك. طلبية البضاعة هتكلف كام؟"
            : parsed.intent === "afford_hire"
              ? "I can test this against your cash, scheduled payments and reserve. What would the monthly cost of this person be?"
              : "I can test this against your cash and scheduled payments. How much would the inventory order cost?",
          facts: [],
          actions: [],
          assumptions: [],
          needs: {
            field: "amount",
            label: parsed.intent === "afford_hire" ? "Monthly cost" : "Order cost",
            hint: "Enter the amount in your business currency",
          },
        };
      }
      const adj: Adjustment =
        parsed.intent === "afford_hire"
          ? { type: "hire", monthlyCost: amount, startDate: addDays(s.today, 7) }
          : { type: "inventory", amount, date: addDays(s.today, 7) };
      const r = simulate(s, [adj]);
      const base = r.baseline;
      const sc = r.scenario;
      const verdict: CopilotAnswer["verdict"] = sc.firstShortfallDate
        ? "no"
        : sc.minCash < r.reserved
          ? "caution"
          : "ok";
      const leadAr =
        verdict === "no"
          ? "مش بأمان دلوقتي."
          : verdict === "caution"
            ? "ممكن، بس هتاكل من الاحتياطي."
            : "أيوه، على حسب الأرقام المتسجلة.";
      const lead =
        verdict === "no"
          ? "Not safely right now."
          : verdict === "caution"
            ? "Possible, but it would eat into your reserve."
            : "Yes, on the numbers you have recorded.";
      const mb = monthlyBaseline(s);
      return {
        intent: parsed.intent,
        verdict,
        title: parsed.intent === "afford_hire" ? `Hiring at ${fm(amount)}/month` : `Inventory order of ${fm(amount)}`,
        answer: ar
          ? `${leadAr} بعد ${r.horizonDays} يوم الكاش هيبقى ${fm(sc.endCash)} (بدل ${fm(base.endCash)} من غيرها)، وأقل نقطة ${fm(sc.minCash)} يوم ${sc.minCashDate}.${sc.firstShortfallDate ? ` الرصيد هينزل تحت الصفر يوم ${sc.firstShortfallDate}.` : ""}${r.reserved > 0 ? ` الاحتياطي بتاعك ${fm(r.reserved)}.` : ""}${mb && parsed.intent === "afford_hire" ? ` الربح الشهري المتوقع هيبقى ${fm(sc.monthlyProfit)} بدل ${fm(base.monthlyProfit)}.` : ""}`
          : `${lead} After ${r.horizonDays} days your cash would be ${fm(sc.endCash)} (versus ${fm(base.endCash)} without it), with a low point of ${fm(sc.minCash)} on ${sc.minCashDate}.${sc.firstShortfallDate ? ` Your balance would go below zero on ${sc.firstShortfallDate}.` : ""}${r.reserved > 0 ? ` Your reserve is ${fm(r.reserved)}.` : ""}${mb && parsed.intent === "afford_hire" ? ` Your estimated monthly profit would move from ${fm(base.monthlyProfit)} to ${fm(sc.monthlyProfit)}.` : ""}`,
        facts: [
          { label: `Cash in ${r.horizonDays} days`, value: `${fm(base.endCash)} → ${fm(sc.endCash)}` },
          { label: "Lowest cash", value: `${fm(base.minCash)} → ${fm(sc.minCash)}` },
          { label: "Reserve set aside", value: fm(r.reserved) },
        ],
        actions: [{ label: "Fine-tune in the simulator", href: "/app/scenarios" }],
        assumptions: r.assumptions.concat(r.warnings),
      };
    }
  }

  if (parsed.intent === "product_profit") {
    const ps = extra.products ?? [];
    if (!ps.length)
      return {
        intent: "product_profit",
        title: "Product profit",
        answer: ar
          ? "محتاج الطلبات نفسها علشان أجاوب. اربط Shopify (أو ارفع الطلبات) علشان أشوف إيه اللي اتباع وبكام تكلفته."
          : "I need individual orders to answer this. Connect Shopify (or import orders) so I can see which products were sold and at what cost.",
        facts: [],
        actions: [{ label: "Connect Shopify", href: "/app/settings/integrations" }],
        assumptions: [],
      };
    const known = ps.filter((p) => p.contribution !== null);
    const top = [...known].sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0))[0];
    const worst = [...known].sort((a, b) => (a.contribution ?? 0) - (b.contribution ?? 0))[0];
    const unknown = ps.length - known.length;
    return {
      intent: "product_profit",
      title: "Which products make you money (last 90 days)",
      answer: ar
        ? top
          ? `${top.title} هو اللي كسّبك أكتر: ${fm(top.contribution!)} من ${top.units} قطعة${top.margin !== null ? ` (فضل منها ${Math.round(top.margin * 100)}%)` : ""}.${worst && worst !== top && (worst.contribution ?? 0) < 0 ? ` و${worst.title} خسّرك ${fm(-(worst.contribution ?? 0))} بعد تكاليفه.` : ""}${unknown ? ` فيه ${unknown} منتج من غير تكلفة متسجلة، فربحهم مش معروف.` : ""}`
          : "مفيش منتج من اللي اتباعوا ليه تكلفة متسجلة، فمش هينفع نحسب ربحهم لسه."
        : top
          ? `${top.title} contributed the most: ${fm(top.contribution!)} from ${top.units} units${top.margin !== null ? ` (${Math.round(top.margin * 100)}% kept)` : ""}.${worst && worst !== top && (worst.contribution ?? 0) < 0 ? ` ${worst.title} lost ${fm(-(worst.contribution ?? 0))} after its costs.` : ""}${unknown ? ` ${unknown} product(s) have no cost recorded, so their profit is unknown.` : ""}`
          : "None of the products sold have a unit cost recorded, so their profit cannot be calculated yet.",
      facts: known.slice(0, 5).map((p) => ({ label: p.title, value: `${fm(p.contribution!)} · ${p.units} units` })),
      actions: [
        { label: "Open True profit", href: "/app/profit" },
        ...(unknown ? [{ label: "Add product costs", href: "/app/products" }] : []),
      ],
      assumptions: [
        "Contribution = product revenue − product cost − its share of fees and shipping. Ads and fixed costs are not split per product.",
      ],
    };
  }
  if (parsed.intent === "focus_today") {
    const recs = extra.openRecommendations ?? [];
    const ins = generateInsights(s)
      .filter((i) => i.severity !== "positive")
      .slice(0, 3);
    const items = [
      ...recs.map((r) => ({ label: r.title, value: "open recommendation" })),
      ...ins.map((i) => ({ label: i.title, value: i.action.label })),
    ].slice(0, 3);
    return {
      intent: "focus_today",
      title: "What to focus on today",
      answer: ar
        ? items.length
          ? `ابدأ بـ «${items[0].label}».${
              items.length > 1
                ? ` وبعدها ${items
                    .slice(1)
                    .map((x) => `«${x.label}»`)
                    .join(" و")}.`
                : ""
            }`
          : "مفيش حاجة مستعجلة النهارده. كمّل سجّل أول بأول."
        : items.length
          ? `Start with “${items[0].label}”.${
              items.length > 1
                ? ` Then ${items
                    .slice(1)
                    .map((x) => `“${x.label}”`)
                    .join(" and ")}.`
                : ""
            }`
          : "Nothing urgent in your records today. Keep recording as you go.",
      facts: items,
      actions: [{ label: "Open the Action Center", href: "/app/actions" }],
      assumptions: ["Chosen from open recommendations and checks on your recorded data, most urgent first."],
    };
  }

  const suggestions = generateInsights(s).slice(0, 2);
  return {
    intent: "unknown",
    title: "I can help with these",
    answer: ar
      ? "أنا بجاوب من أرقامك المتسجلة. جرّب تسأل عن الربح، المصاريف، المدفوعات الجاية، الميزانيات، الاحتياطي، أو «لو» زي تعيين موظف أو المبيعات قلّت."
      : "I answer from your recorded numbers. Try asking about profit, expenses, upcoming payments, budgets, your reserve, or a what-if like hiring or a sales drop.",
    facts: suggestions.map((i) => ({ label: i.title, value: i.severity })),
    actions: [{ label: "Browse insights", href: "/app/insights" }],
    assumptions: [],
  };
}

export { invoiceOutstanding };
