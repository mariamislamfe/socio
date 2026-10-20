// Media-buyer planning: before any money is spent, check the business can afford it, pick a product that actually
// earns money, set the most a sale may cost (from real margins), and estimate results honestly. Pure; minor units.
import { formatMoney } from "./money";
import type { ProductEconomics } from "./profit";

export type Dialect = "egyptian" | "gulf" | "msa" | "english";
export type AdGoal = "sales" | "messages";

export const COUNTRIES: Record<string, { name: string; nameAr: string }> = {
  EG: { name: "Egypt", nameAr: "مصر" },
  SA: { name: "Saudi Arabia", nameAr: "السعودية" },
  AE: { name: "UAE", nameAr: "الإمارات" },
  KW: { name: "Kuwait", nameAr: "الكويت" },
  QA: { name: "Qatar", nameAr: "قطر" },
  JO: { name: "Jordan", nameAr: "الأردن" },
};

export const DIALECT_LABEL: Record<Dialect, string> = {
  egyptian: "Egyptian Arabic",
  gulf: "Saudi / Gulf Arabic",
  msa: "Simple Modern Standard Arabic",
  english: "English",
};

// Interests the co-pilot targets on its own (owner approves the audience in plain words, not the internals).
const INTERESTS: Record<string, string[]> = {
  fashion: ["Fashion", "Clothing", "Online shopping", "Boutiques"],
  beauty: ["Beauty", "Cosmetics", "Skin care", "Online shopping"],
  food: ["Food", "Restaurants", "Cooking", "Food delivery"],
  home: ["Home decor", "Interior design", "Furniture", "Online shopping"],
  electronics: ["Consumer electronics", "Gadgets", "Smartphones", "Online shopping"],
  services: ["Small business", "Entrepreneurship"],
};

export interface AdPlanInput {
  currency: string;
  budget: number; // total for the campaign
  days: number;
  country: string;
  dialect: Dialect;
  goal: AdGoal;
  businessType: string | null;
  products: ProductEconomics[]; // last 30–90 days
  productKey?: string | null;
  canSpend: number; // money plan: what the business can still spend today
  cashRiskBreach: string | null; // date cash dips below the reserve, if any
  history: { spend: number; revenue: number } | null; // own past ad results (platform-attributed), last 90 days
}

export interface AdPlan {
  affordable: { level: "ok" | "tight" | "no"; text: string };
  product: { key: string; title: string; price: number; contributionPerUnit: number; reason: string } | null;
  maxCostPerSale: number | null; // break-even: above this, each sale loses money
  targetCostPerSale: number | null; // the goal the co-pilot optimises for (70% of break-even)
  expected: {
    salesAtTarget: number | null;
    salesAtBreakEven: number | null;
    historicalRoas: number | null;
    text: string;
  };
  dailyBudget: number;
  audience: {
    countries: string[];
    ageMin: number;
    ageMax: number;
    summary: string;
    interests: string[];
    placements: string;
  };
  warnings: string[];
}

export function planAd(i: AdPlanInput): AdPlan {
  const fm = (v: number) => formatMoney(v, i.currency);
  const warnings: string[] = [];
  const days = Math.max(1, Math.min(30, i.days));
  const dailyBudget = Math.round(i.budget / days);

  // 1. Can the business afford it?
  let affordable: AdPlan["affordable"];
  if (i.cashRiskBreach)
    affordable = {
      level: "no",
      text: `Cash is already expected to dip below your safety reserve on ${i.cashRiskBreach}. Spending ${fm(i.budget)} on ads now makes that worse — fix the cash gap first, or spend less.`,
    };
  else if (i.budget > i.canSpend)
    affordable = {
      level: i.canSpend > 0 ? "tight" : "no",
      text: `Only ${fm(Math.max(0, i.canSpend))} is free to spend today after taxes, upcoming bills and your reserve. ${i.canSpend > 0 ? `Consider ${fm(i.canSpend)} instead.` : "Wait for more sales to come in."}`,
    };
  else
    affordable = {
      level: "ok",
      text: `You can afford it: ${fm(i.budget)} is within the ${fm(i.canSpend)} the business can spend today.`,
    };

  // 2. Which product to advertise: highest earnings per unit, never one that loses money.
  const known = i.products.filter((p) => p.costKnown && p.contribution !== null && p.units > 0);
  const scored = known.map((p) => ({
    p,
    perUnit: Math.round((p.contribution as number) / p.units),
    price: Math.round(p.revenue / p.units),
  }));
  let pick = i.productKey ? scored.find((x) => x.p.key === i.productKey) : undefined;
  if (pick && pick.perUnit <= 0)
    warnings.push(`${pick.p.title} already loses money on each sale; advertising it would lose more with every order.`);
  if (!pick)
    pick = [...scored]
      .filter((x) => x.perUnit > 0)
      .sort((a, b) => b.perUnit * Math.log(1 + b.p.units) - a.perUnit * Math.log(1 + a.p.units))[0];
  const product = pick
    ? {
        key: pick.p.key,
        title: pick.p.title,
        price: pick.price,
        contributionPerUnit: pick.perUnit,
        reason:
          i.productKey && pick.p.key === i.productKey
            ? "Your choice."
            : `It keeps the most per sale (${fm(pick.perUnit)} after its cost, fees and shipping) and already sells (${pick.p.units} in the period).`,
      }
    : null;
  if (!product)
    warnings.push(
      "No product with a known cost and positive earnings yet — add product costs so the most a sale may cost can be set.",
    );

  // 3. The most a sale may cost: what one sale earns before ads. Above it, every sale loses money.
  const maxCostPerSale = product ? product.contributionPerUnit : null;
  const targetCostPerSale = maxCostPerSale ? Math.round(maxCostPerSale * 0.7) : null;

  // 4. Honest expectations.
  const historicalRoas = i.history && i.history.spend > 0 ? i.history.revenue / i.history.spend : null;
  const salesAtTarget = targetCostPerSale ? Math.floor(i.budget / targetCostPerSale) : null;
  const salesAtBreakEven = maxCostPerSale ? Math.max(1, Math.ceil(i.budget / maxCostPerSale)) : null;
  const expected = {
    salesAtTarget,
    salesAtBreakEven,
    historicalRoas,
    text: maxCostPerSale
      ? `${i.budget < maxCostPerSale ? `One sale may cost up to ${fm(maxCostPerSale)} — more than this whole budget — so even one sale makes it worth it; a bigger budget gives a clearer answer. ` : `To be worth it, ${fm(i.budget)} must bring at least ${salesAtBreakEven} sale${salesAtBreakEven === 1 ? "" : "s"} (one per ${fm(maxCostPerSale)}); the goal is ${Math.max(1, salesAtTarget ?? 0)}+. `}${historicalRoas !== null ? `Your past ads returned ${historicalRoas.toFixed(1)}× their cost (as reported by the platform).` : "There is no ad history yet, so results are not predicted — they will be measured."}`
      : "Results cannot be judged without product costs.",
  };
  if (dailyBudget < 5000)
    warnings.push(
      `A daily budget of ${fm(dailyBudget)} is very small; delivery may be slow. Fewer days with the same total helps.`,
    );

  const type = (i.businessType ?? "").toLowerCase();
  const interests = INTERESTS[Object.keys(INTERESTS).find((k) => type.includes(k)) ?? "fashion"] ?? INTERESTS.fashion;
  const c = COUNTRIES[i.country]?.name ?? i.country;
  const audience = {
    countries: [i.country],
    ageMin: 18,
    ageMax: 45,
    interests,
    placements: "Facebook & Instagram feeds, Stories and Reels (automatic placements)",
    summary: `People aged 18–45 in ${c} interested in ${interests.slice(0, 3).join(", ").toLowerCase()}.`,
  };
  if (i.dialect === "egyptian" && i.country !== "EG")
    warnings.push(
      `The ad is in Egyptian Arabic but targets ${c}. That can work, but a ${i.country === "SA" || i.country === "AE" || i.country === "KW" || i.country === "QA" ? "Gulf" : "local"} dialect usually feels closer to the audience.`,
    );
  if (i.dialect === "gulf" && i.country === "EG")
    warnings.push("The ad is in Gulf Arabic but targets Egypt; Egyptian Arabic usually performs better there.");

  return { affordable, product, maxCostPerSale, targetCostPerSale, expected, dailyBudget, audience, warnings };
}

/* * Follow-up rules: pause when a sale costs too much, suggest scaling when it is clearly profitable. */
export function judgeCampaign(
  m: { spend: number; sales: number | null; clicks: number },
  plan: Pick<AdPlan, "maxCostPerSale" | "targetCostPerSale">,
  budget: number,
): { verdict: "learning" | "pause" | "scale" | "keep" | "unknown"; reason: string; costPerSale: number | null } {
  const max = plan.maxCostPerSale;
  if (!max)
    return {
      verdict: "unknown",
      reason: "No break-even cost per sale is set (product costs missing).",
      costPerSale: null,
    };
  if (m.sales === null)
    return {
      verdict: "unknown",
      reason: "Sales from this ad are not reported yet (add the Meta pixel to your store to measure them).",
      costPerSale: null,
    };
  const cps = m.sales > 0 ? Math.round(m.spend / m.sales) : null;
  // Judge after the cost of ~1.5 sales, or after 60% of the budget when one sale costs a large share of it.
  const enough = Math.min(max * 1.5, budget * 0.6);
  if (m.spend < enough)
    return {
      verdict: "learning",
      reason: "Too early to judge: it has spent less than the cost of one or two sales.",
      costPerSale: cps,
    };
  if (m.sales === 0 && (m.spend >= max * 2 || m.spend >= budget * 0.6))
    return {
      verdict: "pause",
      reason:
        m.spend >= max * 2
          ? "It has spent the cost of two sales without a single sale."
          : "It has used most of its budget without a single sale.",
      costPerSale: null,
    };
  if (cps !== null && cps > max * 1.2)
    return { verdict: "pause", reason: "Each sale is costing more than it earns.", costPerSale: cps };
  if (
    cps !== null &&
    plan.targetCostPerSale &&
    cps <= plan.targetCostPerSale &&
    m.spend >= Math.min(budget * 0.3, max * 3)
  )
    return {
      verdict: "scale",
      reason: "Sales cost well below the target; more budget is likely to bring more profitable sales.",
      costPerSale: cps,
    };
  return { verdict: "keep", reason: "Within the limits; keep running and keep watching.", costPerSale: cps };
}
