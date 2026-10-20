import "server-only";
import { z } from "zod";
import { COUNTRIES, DIALECT_LABEL, judgeCampaign, planAd, type AdPlan, type Dialect } from "@/lib/finance/adplan";
import { analyzeCashRisk } from "@/lib/finance/cashrisk";
import { addDays } from "@/lib/finance/dates";
import { moneyPlan } from "@/lib/finance/moneyplan";
import { profitReport, type LineRow, type OrderRow, type ProductCost } from "@/lib/finance/profit";
import { asService, type Q } from "../db";
import { api, ApiError, notFound, params, rateLimit } from "../http";
import { auditLog } from "../jobs";
import { proposeAction } from "../brain/actions";
import { readTaxSettings } from "../brain/workflows";
import { financingContext } from "../financing";
import {
  generateCopy,
  MetaNotReady,
  metaContext,
  metaInsights,
  priceTextFor,
  COUNTRY_CURRENCY,
  type Brief,
  type Creative,
} from "../mediabuyer";
import type { Route } from "./types";

const zDialect = z.enum(["egyptian", "gulf", "msa", "english"]);

async function planInputs(q: Q, businessId: string) {
  const { b, snap, reserve } = await financingContext(q, businessId);
  const range = { from: addDays(snap.today, -89), to: snap.today };
  const [orders, lines, products] = [
    await q.query<OrderRow>(
      "select id,local_date::text,currency,cancelled_at,is_test,total,tax,shipping,discounts,refunded from orders where business_id=$1 and local_date between $2 and $3",
      [businessId, range.from, range.to],
    ),
    await q.query<LineRow>(
      "select l.order_id,l.variant_external_id,l.title,l.sku,l.quantity,l.current_quantity,l.discounted_total,l.unit_cost from order_lines l join orders o on o.id=l.order_id where l.business_id=$1 and o.local_date between $2 and $3",
      [businessId, range.from, range.to],
    ),
    await q.query<ProductCost>("select external_id,name,unit_cost from products where business_id=$1", [businessId]),
  ];
  const report = profitReport({
    range,
    currency: snap.currency,
    txns: snap.txns,
    cats: snap.cats,
    orders,
    lines,
    products,
    ads: snap.ads,
    assumptions: b.settings?.costAssumptions ?? {},
  });
  const mp = moneyPlan(snap, { tax: readTaxSettings(b.settings), reserve, plan: b.settings?.moneyPlan ?? {} });
  const risk = analyzeCashRisk(snap, { reserve, horizonDays: 60, quality: { integrations: [] } });
  const ads90 = snap.ads.filter((a) => a.currency === snap.currency && a.date >= range.from);
  const history = ads90.length
    ? { spend: ads90.reduce((x, a) => x + a.spend, 0), revenue: ads90.reduce((x, a) => x + a.attributed_revenue, 0) }
    : null;
  return { b, snap, report, canSpend: mp.business.canSpend, breach: risk.breachDate, history };
}

async function connection(q: Q, businessId: string) {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET)
    return {
      ready: false,
      reason:
        "Meta is not configured on this server (META_APP_ID, META_APP_SECRET). You can still plan and approve ads here.",
    };
  try {
    await metaContext(q, businessId);
    return { ready: true, reason: null as string | null };
  } catch (e) {
    return {
      ready: false,
      reason: e instanceof MetaNotReady ? e.message : `Meta check failed: ${e instanceof Error ? e.message : "error"}`,
    };
  }
}

export const mediaBuyerRoutes: Route[] = [
  [
    "GET",
    "media-buyer",
    api(async (c) => {
      const [campaigns, conn, inputs] = await asService(
        async (q) =>
          [
            await q.query<any>(
              "select id,status,brief,plan,creative,external,metrics,last_checked_at,error,created_at,updated_at from ad_campaigns where business_id=$1 order by created_at desc limit 20",
              [c.biz.id],
            ),
            await connection(q, c.biz.id),
            await planInputs(q, c.biz.id),
          ] as const,
      );
      const acts = await c.db((q) =>
        q.query<any>(
          "select id,tool,status,params,params_hash,summary from actions where business_id=$1 and tool like '%meta_campaign' order by created_at desc limit 40",
          [c.biz.id],
        ),
      );
      return {
        currency: c.biz.currency,
        connection: conn,
        countries: COUNTRIES,
        dialects: DIALECT_LABEL,
        canSpend: inputs.canSpend,
        cashRiskBreach: inputs.breach,
        products: inputs.report.products
          .filter((p) => p.costKnown && p.contribution !== null)
          .map((p) => ({
            key: p.key,
            title: p.title,
            perUnit: Math.round((p.contribution as number) / Math.max(1, p.units)),
            units: p.units,
          })),
        campaigns: campaigns.map((x: any) => ({
          ...x,
          actions: acts.filter((a: any) => a.params?.campaignId === x.id),
        })),
      };
    }),
  ],

  [
    "POST",
    "media-buyer/plan",
    api(async (c) => {
      c.requireWrite();
      rateLimit(`adplan:${c.biz.id}`, 15, 60_000);
      const b = await c.body(
        z.object({
          budget: z.number().int().min(1000).max(9e13),
          days: z.number().int().min(1).max(30),
          country: z.string().length(2),
          dialect: zDialect,
          goal: z.enum(["sales", "messages"]).default("sales"),
          link: z.string().url().max(500).or(z.literal("")).default(""),
          imageUrl: z.string().url().max(500).nullable().optional(),
          productKey: z.string().max(200).nullable().optional(),
        }),
      );
      if (!COUNTRIES[b.country])
        throw new ApiError(422, "invalid", "Choose a supported country.", { country: "Unsupported" });
      const { b: biz, snap, report, canSpend, breach, history } = await asService((q) => planInputs(q, c.biz.id));
      const plan = planAd({
        currency: snap.currency,
        budget: b.budget,
        days: b.days,
        country: b.country,
        dialect: b.dialect as Dialect,
        goal: b.goal,
        businessType: biz.business_type,
        products: report.products,
        productKey: b.productKey ?? null,
        canSpend,
        cashRiskBreach: breach,
        history,
      });
      const priceText = priceTextFor(plan.product?.price ?? null, snap.currency, b.country, b.dialect as Dialect);
      if (!priceText && plan.product && (COUNTRY_CURRENCY[b.country] ?? snap.currency) !== snap.currency)
        plan.warnings.push(
          `Your prices are in ${snap.currency} but people in ${COUNTRIES[b.country].name} pay in ${COUNTRY_CURRENCY[b.country]}. Type the local price in the ad yourself — it is never converted automatically.`,
        );
      const examples = await asService((q) =>
        q.query<{ text: string }>(
          "select text from ad_copy_examples where business_id=$1 and dialect=$2 order by created_at desc limit 4",
          [c.biz.id, b.dialect],
        ),
      );
      const copy = await generateCopy({
        dialect: b.dialect as Dialect,
        product: plan.product,
        businessName: biz.name.replace(/\s*\(demo data\)\s*/i, ""),
        country: COUNTRIES[b.country].name,
        goal: b.goal,
        examples: examples.map((e) => e.text),
        priceText: priceText || "",
      });
      const brief: Brief = {
        budget: b.budget,
        days: b.days,
        country: b.country,
        dialect: b.dialect as Dialect,
        goal: b.goal,
        link: b.link,
        imageUrl: b.imageUrl ?? null,
        productKey: plan.product?.key ?? null,
      };
      const creative: Creative = {
        primaryText: copy.primaryText,
        headline: copy.headline,
        cta: copy.cta,
        link: b.link,
        imageUrl: b.imageUrl ?? null,
        priceText,
      };
      const row = await asService(async (q) => {
        const r = await q.query<{ id: string }>(
          "insert into ad_campaigns(business_id,brief,plan,creative,created_by) values ($1,$2::text::jsonb,$3::text::jsonb,$4::text::jsonb,$5) returning id",
          [
            c.biz.id,
            JSON.stringify(brief),
            JSON.stringify({ ...plan, copyEngine: copy.engine }),
            JSON.stringify(creative),
            c.user.id,
          ],
        );
        await auditLog(q, {
          businessId: c.biz.id,
          actorType: "user",
          actorId: c.user.id,
          action: "ad.planned",
          target: r[0].id,
          detail: { budget: b.budget, country: b.country, dialect: b.dialect, affordable: plan.affordable.level },
        });
        return r[0];
      });
      return { id: row.id, plan, creative, engine: copy.engine };
    }),
  ],

  // The owner edits what people will see. Their wording is kept as a style example for the next ads.
  [
    "PATCH",
    "media-buyer/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({
          primaryText: z.string().min(1).max(600).optional(),
          headline: z.string().min(1).max(80).optional(),
          cta: z.enum(["SHOP_NOW", "ORDER_NOW", "LEARN_MORE", "SEND_MESSAGE"]).optional(),
          link: z.string().url().max(500).optional(),
          imageUrl: z.string().url().max(500).nullable().optional(),
        }),
      );
      await asService(async (q) => {
        const cur = (
          await q.query<any>("select status, brief, creative from ad_campaigns where id=$1 and business_id=$2", [
            id,
            c.biz.id,
          ])
        )[0];
        if (!cur) throw notFound("Ad");
        if (!["draft", "awaiting_approval"].includes(cur.status))
          throw new ApiError(409, "locked", "This ad is already on Meta; create a new one to change what people see.");
        const creative = { ...cur.creative, ...b };
        const brief = {
          ...cur.brief,
          ...(b.link ? { link: b.link } : {}),
          ...(b.imageUrl !== undefined ? { imageUrl: b.imageUrl } : {}),
        };
        await q.query(
          "update ad_campaigns set creative=$3::text::jsonb, brief=$4::text::jsonb, status='draft', updated_at=now() where id=$1 and business_id=$2",
          [id, c.biz.id, JSON.stringify(creative), JSON.stringify(brief)],
        );
        // Editing invalidates any pending approval for the old wording.
        await q.query(
          "update actions set status='cancelled' where business_id=$1 and tool='create_meta_campaign' and status='awaiting_approval' and params->>'campaignId'=$2",
          [c.biz.id, id],
        );
        if (b.primaryText && b.primaryText !== cur.creative.primaryText)
          await q.query("insert into ad_copy_examples(business_id,dialect,text) values ($1,$2,$3)", [
            c.biz.id,
            cur.brief.dialect,
            b.primaryText,
          ]);
      });
      return { ok: true };
    }),
  ],

  [
    "POST",
    "media-buyer/:id/approve",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const row = (
        await asService((q) =>
          q.query<any>("select status, brief, creative from ad_campaigns where id=$1 and business_id=$2", [
            id,
            c.biz.id,
          ]),
        )
      )[0];
      if (!row) throw notFound("Ad");
      if (!row.creative.link)
        throw new ApiError(422, "invalid", "Add the link people should open (your store or product page).", {
          link: "Required",
        });
      const r = await proposeAction({
        businessId: c.biz.id,
        tool: "create_meta_campaign",
        origin: "user",
        role: c.biz.role,
        actorId: c.user.id,
        params: {
          campaignId: id,
          budget: row.brief.budget,
          days: row.brief.days,
          country: row.brief.country,
          headline: row.creative.headline,
          primaryText: row.creative.primaryText,
          link: row.creative.link,
        },
        idempotencyKey: `adcreate:${id}:${row.creative.headline.length}:${row.creative.primaryText.length}:${Math.floor(Date.now() / 60_000)}`,
      });
      if (r.mode === "prohibited") throw new ApiError(409, "prohibited", r.reason);
      await asService((q) =>
        q.query(
          "update ad_campaigns set status='awaiting_approval', updated_at=now() where id=$1 and business_id=$2 and status='draft'",
          [id, c.biz.id],
        ),
      );
      return r;
    }),
  ],

  [
    "POST",
    "media-buyer/:id/activate",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const row = (
        await asService((q) =>
          q.query<any>("select status, brief from ad_campaigns where id=$1 and business_id=$2", [id, c.biz.id]),
        )
      )[0];
      if (!row) throw notFound("Ad");
      if (!["created", "paused"].includes(row.status))
        throw new ApiError(409, "not_ready", "Create the ad on Meta first.");
      const r = await proposeAction({
        businessId: c.biz.id,
        tool: "activate_meta_campaign",
        origin: "user",
        role: c.biz.role,
        actorId: c.user.id,
        params: { campaignId: id, budget: row.brief.budget, days: row.brief.days },
        idempotencyKey: `adact:${id}:${Math.floor(Date.now() / 60_000)}`,
      });
      if (r.mode === "prohibited") throw new ApiError(409, "prohibited", r.reason);
      return r;
    }),
  ],

  [
    "POST",
    "media-buyer/:id/pause",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const r = await proposeAction({
        businessId: c.biz.id,
        tool: "pause_meta_campaign",
        origin: "user",
        role: c.biz.role,
        actorId: c.user.id,
        params: { campaignId: id, reason: "Paused by the owner" },
        idempotencyKey: `adpause:${id}:${Math.floor(Date.now() / 60_000)}`,
      });
      if (r.mode === "prohibited") throw new ApiError(409, "prohibited", r.reason);
      return r;
    }),
  ],

  [
    "POST",
    "media-buyer/:id/check",
    api(async (c) => {
      const { id } = params<{ id: string }>(c);
      rateLimit(`adcheck:${c.biz.id}`, 20, 60_000);
      return monitorCampaign(c.biz.id, id);
    }),
  ],

  [
    "DELETE",
    "media-buyer/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const r = await asService((q) =>
        q.query(
          "delete from ad_campaigns where id=$1 and business_id=$2 and status in ('draft','awaiting_approval') returning id",
          [id, c.biz.id],
        ),
      );
      if (!r.length)
        throw new ApiError(409, "locked", "Only drafts can be deleted; pause ads that are on Meta instead.");
      return { ok: true };
    }),
  ],
];

/* * Daily follow-up: measure, judge against the break-even cost per sale, pause losers automatically, suggest scaling winners. */
export async function monitorCampaign(businessId: string, id: string) {
  const row = (
    await asService((q) =>
      q.query<any>("select id,status,brief,plan,external from ad_campaigns where id=$1 and business_id=$2", [
        id,
        businessId,
      ]),
    )
  )[0];
  if (!row) throw notFound("Ad");
  if (!row.external?.campaignId) return { verdict: "unknown", reason: "This ad is not on Meta yet." };
  const m = await asService((q) => metaInsights(q, businessId, row.external.campaignId));
  const j = judgeCampaign(m, row.plan as AdPlan, row.brief.budget);
  await asService((q) =>
    q.query(
      "update ad_campaigns set metrics=$3::text::jsonb, last_checked_at=now(), updated_at=now() where id=$1 and business_id=$2",
      [id, businessId, JSON.stringify({ ...m, verdict: j.verdict, reason: j.reason, costPerSale: j.costPerSale })],
    ),
  );
  let action: unknown = null;
  if (j.verdict === "pause" && row.status === "active") {
    action = await proposeAction({
      businessId,
      tool: "pause_meta_campaign",
      origin: "system",
      role: "system",
      params: { campaignId: id, reason: j.reason },
      idempotencyKey: `adguard:${id}:pause`,
    });
  } else if (j.verdict === "scale" && row.status === "active") {
    action = await proposeAction({
      businessId,
      tool: "scale_meta_campaign",
      origin: "system",
      role: "system",
      params: { campaignId: id, newDailyBudget: Math.round((row.plan.dailyBudget ?? 0) * 1.2) },
      idempotencyKey: `adguard:${id}:scale:${row.plan.dailyBudget}`,
      summary: "Raise the daily budget by 20%: sales cost well below target",
    });
  }
  return { ...j, metrics: m, action };
}

export async function monitorActiveCampaigns(businessId: string) {
  const rows = await asService((q) =>
    q.query<{ id: string }>("select id from ad_campaigns where business_id=$1 and status='active'", [businessId]),
  );
  const out = [];
  for (const r of rows)
    out.push(
      await monitorCampaign(businessId, r.id).catch((e) => ({
        verdict: "unknown",
        reason: e instanceof Error ? e.message : "failed",
      })),
    );
  return { checked: rows.length, results: out };
}
