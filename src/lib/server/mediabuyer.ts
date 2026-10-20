import "server-only";
import type { AdPlan, Dialect } from "@/lib/finance/adplan";
import { formatMoney } from "@/lib/finance/money";
import { claude, extractJson, llmConfigured } from "./boardroom/llm";
import { decrypt } from "./crypto";
import type { Q } from "./db";
import { metaGraph } from "./integrations/ads";

export interface Creative {
  primaryText: string;
  headline: string;
  cta: "SHOP_NOW" | "ORDER_NOW" | "LEARN_MORE" | "SEND_MESSAGE";
  link: string;
  imageUrl: string | null;
  priceText: string;
}
export interface Brief {
  budget: number;
  days: number;
  country: string;
  dialect: Dialect;
  goal: "sales" | "messages";
  link: string;
  imageUrl: string | null;
  productKey: string | null;
}

export const COUNTRY_CURRENCY: Record<string, string> = {
  EG: "EGP",
  SA: "SAR",
  AE: "AED",
  KW: "KWD",
  QA: "QAR",
  JO: "JOD",
};

// ad copy: in the owner's chosen dialect, learning from their edits

function template(d: Dialect, title: string, price: string): Pick<Creative, "primaryText" | "headline"> {
  // Without a price in the audience's own currency, the ad does not mention a price at all.
  if (!price) {
    switch (d) {
      case "egyptian":
        return {
          primaryText: `${title} 🔥\nخامة حلوة وهتفرق معاك، والتوصيل لحد باب البيت.\nاطلب دلوقتي قبل ما يخلص!`,
          headline: `${title} — اطلبه دلوقتي`,
        };
      case "gulf":
        return {
          primaryText: `${title} ✨\nجودة تستاهل، والتوصيل لين باب بيتك.\nاطلبه الحين قبل لا يخلص!`,
          headline: `${title} — اطلبه الحين`,
        };
      case "msa":
        return {
          primaryText: `${title}\nجودة عالية وتوصيل حتى باب منزلك.\nاطلب الآن قبل نفاد الكمية.`,
          headline: `${title} — اطلب الآن`,
        };
      default:
        return {
          primaryText: `${title} ✨\nQuality you can feel, delivered to your door.\nOrder now before it sells out!`,
          headline: `${title} — order now`,
        };
    }
  }
  switch (d) {
    case "egyptian":
      return {
        primaryText: `${title} بـ ${price} بس 🔥\nخامة حلوة وهتفرق معاك، والتوصيل لحد باب البيت.\nاطلب دلوقتي قبل ما يخلص!`,
        headline: `${title} — اطلبه دلوقتي`,
      };
    case "gulf":
      return {
        primaryText: `${title} بـ ${price} فقط ✨\nجودة تستاهل، والتوصيل لين باب بيتك.\nاطلبه الحين قبل لا يخلص!`,
        headline: `${title} — اطلبه الحين`,
      };
    case "msa":
      return {
        primaryText: `${title} بسعر ${price} فقط.\nجودة عالية وتوصيل حتى باب منزلك.\nاطلب الآن قبل نفاد الكمية.`,
        headline: `${title} — اطلب الآن`,
      };
    default:
      return {
        primaryText: `${title} for just ${price} ✨\nQuality you can feel, delivered to your door.\nOrder now before it sells out!`,
        headline: `${title} — order now`,
      };
  }
}

export async function generateCopy(args: {
  dialect: Dialect;
  product: AdPlan["product"];
  businessName: string;
  country: string;
  goal: "sales" | "messages";
  examples: string[];
  priceText: string;
}): Promise<{ primaryText: string; headline: string; cta: Creative["cta"]; engine: "claude" | "template" }> {
  const title = args.product?.title ?? args.businessName;
  const cta: Creative["cta"] = args.goal === "messages" ? "SEND_MESSAGE" : "SHOP_NOW";
  if (llmConfigured()) {
    try {
      const dialectRule = {
        egyptian:
          "Egyptian colloquial Arabic, the way a young Cairo shop owner writes on Instagram — not formal, not translated.",
        gulf: "Saudi/Gulf colloquial Arabic (e.g. الحين، لين، وش، يستاهل) as a Riyadh shop would write — not Egyptian, not formal.",
        msa: "Simple, warm Modern Standard Arabic understood across the Arab world.",
        english: "Plain, friendly English.",
      }[args.dialect];
      const text = await claude({
        system: `You write short Meta (Facebook/Instagram) ads for a small business. Language: ${dialectRule}
Rules: no invented discounts, guarantees or claims; mention only the price given; 1–3 short lines plus a call to action; max 280 characters; at most 2 emoji.
Return ONLY JSON: {"primaryText": string, "headline": string (max 40 chars)}.`,
        user: `Business: ${args.businessName}\nProduct: ${title}\nPrice to show: ${args.priceText}\nAudience country: ${args.country}\nGoal: ${args.goal === "messages" ? "get people to send a message" : "get people to buy on the website"}\n${
          args.examples.length
            ? `The owner's own wording from earlier ads (match this style):\n${args.examples
                .slice(0, 4)
                .map((e) => `- ${e}`)
                .join("\n")}`
            : ""
        }`,
        maxTokens: 400,
      });
      const j = extractJson<{ primaryText?: string; headline?: string }>(text);
      if (j?.primaryText && j.headline)
        return { primaryText: j.primaryText.slice(0, 500), headline: j.headline.slice(0, 60), cta, engine: "claude" };
    } catch {
      /* fall back to the template */
    }
  }
  return { ...template(args.dialect, title, args.priceText), cta, engine: "template" };
}

export function priceTextFor(price: number | null, businessCurrency: string, country: string, dialect: Dialect) {
  if (price === null) return "";
  const target = COUNTRY_CURRENCY[country] ?? businessCurrency;
  if (target !== businessCurrency) return ""; // never convert silently: the owner types the local price
  return dialect === "english"
    ? formatMoney(price, businessCurrency, { compact: false })
    : `${Math.round(price / 100)} ${businessCurrency === "EGP" ? "جنيه" : businessCurrency}`;
}

// Meta Marketing API (write)

export class MetaNotReady extends Error {}

const graph = () => metaGraph();

export async function metaCall(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const url = `${graph()}/${path.replace(/^\//, "")}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j?.error) throw new Error(`Meta: ${j?.error?.message ?? `HTTP ${res.status}`}`.slice(0, 300));
  return j;
}

/* * The connected Meta ad account, token and Page; explains exactly what is missing otherwise. */
export async function metaContext(
  q: Q,
  businessId: string,
): Promise<{ token: string; account: string; pageId: string; currency: string }> {
  const r = (
    await q.query<any>(
      `select i.status, i.external_account, i.scopes, i.meta, s.access_token_enc, b.settings from integrations i join businesses b on b.id=i.business_id
     left join integration_secrets s on s.integration_id=i.id where i.business_id=$1 and i.provider='meta_ads'`,
      [businessId],
    )
  )[0];
  if (!r || r.status === "disconnected" || !r.access_token_enc)
    throw new MetaNotReady("Connect your Meta ad account in Settings → Integrations.");
  if (!String(r.scopes ?? "").includes("ads_management"))
    throw new MetaNotReady(
      "The Meta connection is read-only. Reconnect it with ad-management permission (ads_management, pages_manage_ads).",
    );
  const token = decrypt(r.access_token_enc);
  let account: string | null = r.external_account;
  if (!account) {
    const a = await metaCall(token, "GET", "me/adaccounts?fields=id,currency&limit=5");
    account = a?.data?.[0]?.id ?? null;
  }
  if (!account) throw new MetaNotReady("No ad account is accessible with this Meta login.");
  let pageId: string | null = r.settings?.mediaBuyer?.pageId ?? null;
  if (!pageId) {
    const p = await metaCall(token, "GET", "me/accounts?fields=id,name&limit=5");
    pageId = p?.data?.[0]?.id ?? null;
  }
  if (!pageId) throw new MetaNotReady("No Facebook Page is available for ads; create a Page or grant access to one.");
  return { token, account, pageId, currency: r.meta?.currency ?? "" };
}

export async function createOnMeta(
  q: Q,
  businessId: string,
  c: { id: string; brief: Brief; plan: AdPlan; creative: Creative },
) {
  const ctx = await metaContext(q, businessId);
  const name = `${c.plan.product?.title ?? "Ad"} · ${c.brief.country} · ${new Date().toISOString().slice(0, 10)}`;
  // Interests are resolved to Meta ids; unknown ones are skipped rather than guessed.
  const interests: { id: string; name: string }[] = [];
  for (const n of c.plan.audience.interests.slice(0, 4)) {
    const s = await metaCall(ctx.token, "GET", `search?type=adinterest&q=${encodeURIComponent(n)}&limit=1`).catch(
      () => null,
    );
    if (s?.data?.[0]?.id) interests.push({ id: String(s.data[0].id), name: String(s.data[0].name ?? n) });
  }
  const start = new Date(Date.now() + 10 * 60_000);
  const end = new Date(start.getTime() + c.brief.days * 86_400_000);
  const campaign = await metaCall(ctx.token, "POST", `${ctx.account}/campaigns`, {
    name,
    objective: c.brief.goal === "messages" ? "OUTCOME_ENGAGEMENT" : "OUTCOME_TRAFFIC",
    status: "PAUSED",
    special_ad_categories: [],
  });
  const adset = await metaCall(ctx.token, "POST", `${ctx.account}/adsets`, {
    name: `${name} · audience`,
    campaign_id: campaign.id,
    daily_budget: c.plan.dailyBudget,
    billing_event: "IMPRESSIONS",
    optimization_goal: c.brief.goal === "messages" ? "CONVERSATIONS" : "LINK_CLICKS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: {
      geo_locations: { countries: c.plan.audience.countries },
      age_min: c.plan.audience.ageMin,
      age_max: c.plan.audience.ageMax,
      ...(interests.length ? { flexible_spec: [{ interests }] } : {}),
    },
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    status: "PAUSED",
  });
  const creative = await metaCall(ctx.token, "POST", `${ctx.account}/adcreatives`, {
    name: `${name} · creative`,
    object_story_spec: {
      page_id: ctx.pageId,
      link_data: {
        link: c.creative.link,
        message: c.creative.primaryText,
        name: c.creative.headline,
        call_to_action: { type: c.creative.cta, value: { link: c.creative.link } },
        ...(c.creative.imageUrl ? { picture: c.creative.imageUrl } : {}),
      },
    },
  });
  const ad = await metaCall(ctx.token, "POST", `${ctx.account}/ads`, {
    name: `${name} · ad`,
    adset_id: adset.id,
    creative: { creative_id: creative.id },
    status: "PAUSED",
  });
  return {
    account: ctx.account,
    campaignId: String(campaign.id),
    adsetId: String(adset.id),
    creativeId: String(creative.id),
    adId: String(ad.id),
    interests: interests.map((x) => x.name),
  };
}

export async function setMetaStatus(
  q: Q,
  businessId: string,
  ext: { campaignId: string; adsetId: string; adId: string },
  status: "ACTIVE" | "PAUSED",
) {
  const ctx = await metaContext(q, businessId);
  for (const id of status === "ACTIVE" ? [ext.campaignId, ext.adsetId, ext.adId] : [ext.campaignId])
    await metaCall(ctx.token, "POST", id, { status });
  const check = await metaCall(ctx.token, "GET", `${ext.campaignId}?fields=status`);
  return String(check?.status ?? "");
}

export async function setMetaDailyBudget(q: Q, businessId: string, adsetId: string, dailyBudget: number) {
  const ctx = await metaContext(q, businessId);
  await metaCall(ctx.token, "POST", adsetId, { daily_budget: dailyBudget });
  const check = await metaCall(ctx.token, "GET", `${adsetId}?fields=daily_budget`);
  return Number(check?.daily_budget ?? 0);
}

export async function metaInsights(
  q: Q,
  businessId: string,
  campaignId: string,
): Promise<{ spend: number; clicks: number; impressions: number; sales: number | null; salesValue: number | null }> {
  const ctx = await metaContext(q, businessId);
  const j = await metaCall(
    ctx.token,
    "GET",
    `${campaignId}/insights?fields=spend,clicks,impressions,actions,action_values&date_preset=maximum`,
  );
  const row = j?.data?.[0] ?? {};
  const act = (arr: any[] | undefined, type: string) => arr?.find((a) => a.action_type === type)?.value;
  const purchases = act(row.actions, "purchase") ?? act(row.actions, "offsite_conversion.fb_pixel_purchase");
  const value = act(row.action_values, "purchase") ?? act(row.action_values, "offsite_conversion.fb_pixel_purchase");
  // Meta reports spend as a decimal string in the account currency; convert to minor units.
  return {
    spend: Math.round(Number(row.spend ?? 0) * 100),
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    sales: purchases === undefined ? null : Number(purchases),
    salesValue: value === undefined ? null : Math.round(Number(value) * 100),
  };
}
