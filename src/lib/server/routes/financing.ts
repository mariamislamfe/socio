import "server-only";
import { z } from "zod";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { analyzeOffers, financingReadiness, KIND_LABEL } from "@/lib/finance/financing";
import { moneyPlan } from "@/lib/finance/moneyplan";
import { requirementByKey } from "@/lib/compliance/egypt";
import { readTaxSettings } from "../brain/workflows";
import { asService } from "../db";
import { decrypt, sha256 } from "../crypto";
import { api, apiPublic, ApiError, notFound, params, rateLimit } from "../http";
import { auditLog, runDue } from "../jobs";
import { proposeAction } from "../brain/actions";
import { buildPackFor, financingContext, fingerprintOf } from "../financing";
import type { Route } from "./types";

async function origin() {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
}

const money = z.number().int().min(0).max(9e15);
const zOffer = z.object({
  lender: z.string().trim().min(1).max(120),
  kind: z.enum([
    "supplier_credit",
    "invoice_financing",
    "overdraft",
    "term_loan",
    "revenue_advance",
    "owner_funds",
    "other",
  ]),
  amount: money.min(1),
  upfrontFee: money.default(0),
  ratePct: z.number().min(0).max(1000).nullable().default(null),
  flatFee: money.nullable().default(null),
  termDays: z.number().int().min(1).max(3650),
  repayment: z.enum(["bullet", "monthly", "weekly", "daily_sales"]),
  revenueSharePct: z.number().gt(0).max(100).nullable().default(null),
  flags: z
    .object({
      upfrontPaymentRequested: z.boolean().optional(),
      pressureToSignToday: z.boolean().optional(),
      guaranteedApproval: z.boolean().optional(),
      notLicensed: z.boolean().optional(),
      personalAccountPayment: z.boolean().optional(),
    })
    .default({}),
  notes: z.string().max(1000).nullable().optional(),
});

export const financingRoutes: Route[] = [
  [
    "GET",
    "financing",
    api(async (c) => {
      const { snap, offers, reserve, integ } = await c.db((q) => financingContext(q, c.biz.id));
      const r = analyzeOffers(snap, offers, reserve);
      const todos = await c.db((q) =>
        q.query<{ catalog_key: string; status: string }>(
          "select catalog_key,status from todos where business_id=$1 and catalog_key is not null and period='once'",
          [c.biz.id],
        ),
      );
      const req = todos.filter((t) => requirementByKey(t.catalog_key)?.kind === "required");
      const readiness = financingReadiness(snap, {
        reserve,
        legalDone: req.filter((t) => t.status === "done").length,
        legalTotal: req.length,
        integrations: integ.map((i) => ({ provider: i.provider, status: i.status, lastSyncAt: i.last_sync_at })),
      });
      const shares = await c.db((q) =>
        q.query<any>(
          `select s.id, s.recipient, s.fingerprint, s.expires_at, s.revoked_at, s.views, s.last_viewed_at, s.created_at, a.result
         from share_links s left join actions a on a.id = s.action_id and a.business_id = s.business_id where s.business_id=$1 order by s.created_at desc limit 20`,
          [c.biz.id],
        ),
      );
      const base = await origin();
      const admin = c.biz.role === "owner" || c.biz.role === "admin";
      return {
        currency: snap.currency,
        today: snap.today,
        reserve,
        need: r.need,
        baseLowest: r.baseLowest,
        kinds: KIND_LABEL,
        readiness,
        offers: r.offers.map((a) => ({ ...a, flows: a.flows.slice(0, 60) })),
        shares: shares.map((s: any) => {
          let url: string | null = null;
          // The link itself is only shown to owners/admins, and only while it is usable.
          if (admin && !s.revoked_at && new Date(s.expires_at) > new Date() && s.result?.tokenEnc) {
            try {
              url = `${base}/share/${decrypt(s.result.tokenEnc)}`;
            } catch {
              url = null;
            }
          }
          return {
            id: s.id,
            recipient: s.recipient,
            fingerprint: s.fingerprint,
            expiresAt: s.expires_at,
            revokedAt: s.revoked_at,
            views: s.views,
            lastViewedAt: s.last_viewed_at,
            createdAt: s.created_at,
            url,
          };
        }),
      };
    }),
  ],
  // money plan: owner pay, what the business can spend, where every 100 of sales goes
  [
    "GET",
    "money-plan",
    api(async (c) => {
      const { snap, b, reserve } = await c.db((q) => financingContext(q, c.biz.id));
      const plan = moneyPlan(snap, { tax: readTaxSettings(b.settings), reserve, plan: b.settings?.moneyPlan ?? {} });
      const accounts = snap.accounts
        .filter((a) => a.counts_as_cash !== false && a.currency === snap.currency)
        .map((a) => ({ id: a.id, name: a.name }));
      return {
        currency: snap.currency,
        today: snap.today,
        plan,
        accounts,
        vatRegistered: b.settings?.vatRegistered === true,
      };
    }),
  ],
  [
    "PATCH",
    "money-plan",
    api(async (c) => {
      c.requireAdmin();
      const body = await c.body(z.object({ ownerPayPct: z.number().int().min(0).max(100) }));
      await c.db((q) =>
        q.query(
          "update businesses set settings = jsonb_set(settings, '{moneyPlan}', coalesce(settings->'moneyPlan','{}'::jsonb) || $2::text::jsonb) where id=$1",
          [c.biz.id, JSON.stringify(body)],
        ),
      );
      return { ok: true };
    }),
  ],
  // Records money the owner took for themselves (cash goes down; profit does not).
  [
    "POST",
    "money-plan/owner-pay",
    api(async (c) => {
      c.requireWrite();
      const body = await c.body(
        z.object({
          amount: money.min(1),
          accountId: z.string().uuid(),
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        }),
      );
      const id = await c.db(async (q) => {
        let cat = (
          await q.query<{ id: string }>(
            "select id from categories where business_id=$1 and role='owner_draw' limit 1",
            [c.biz.id],
          )
        )[0];
        if (!cat)
          cat = (
            await q.query<{ id: string }>(
              "insert into categories(business_id,name,kind,role,color,is_system,position) values ($1,'Owner''s pay','expense','owner_draw','#2f5d7d',true,999) returning id",
              [c.biz.id],
            )
          )[0];
        const acc = await q.query("select 1 from accounts where id=$1 and business_id=$2", [body.accountId, c.biz.id]);
        if (!acc.length)
          throw new ApiError(422, "invalid", "Choose one of your accounts.", { accountId: "Unknown account" });
        const r = await q.query<{ id: string }>(
          "insert into transactions(business_id,type,date,amount,currency,account_id,category_id,description,source) values ($1,'expense',coalesce($2::date,current_date),$3,$4,$5,$6,'Owner''s pay','manual') returning id",
          [c.biz.id, body.date ?? null, body.amount, c.biz.currency, body.accountId, cat.id],
        );
        return r[0].id;
      });
      return { id };
    }),
  ],
  [
    "POST",
    "financing/offers",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(zOffer);
      if (b.repayment === "daily_sales" && !b.revenueSharePct)
        throw new ApiError(422, "invalid", "Enter the share of daily sales that is withheld.", {
          revenueSharePct: "Required for repayment from sales",
        });
      const r = await c.db((q) =>
        q.query<{ id: string }>(
          `insert into financing_offers(business_id,lender,kind,amount,upfront_fee,rate_pct,flat_fee,term_days,repayment,revenue_share_pct,flags,notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12) returning id`,
          [
            c.biz.id,
            b.lender,
            b.kind,
            b.amount,
            b.upfrontFee,
            b.ratePct,
            b.flatFee,
            b.termDays,
            b.repayment,
            b.revenueSharePct,
            JSON.stringify(b.flags),
            b.notes ?? null,
          ],
        ),
      );
      return { id: r[0].id };
    }),
  ],
  [
    "DELETE",
    "financing/offers/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const r = await c.db((q) =>
        q.query("delete from financing_offers where id=$1 and business_id=$2 returning id", [id, c.biz.id]),
      );
      if (!r.length) throw notFound("Offer");
      return { ok: true };
    }),
  ],
  // Owner preview of the lender pack (not shared).
  [
    "GET",
    "financing/pack",
    api(async (c) => {
      const qy = c.query(
        z.object({
          amount: z.coerce.number().int().min(0).max(9e15).optional(),
          purpose: z.string().max(300).optional(),
          offerId: z.union([z.string().uuid(), z.literal("")]).optional(),
        }),
      );
      const req = qy.amount
        ? { amount: qy.amount, purpose: qy.purpose || "Working capital", offerId: qy.offerId || null }
        : null;
      return c.db((q) => buildPackFor(q, c.biz.id, req));
    }),
  ],
  // Sharing goes through the policy engine as a level-3 action: it always waits for an owner/admin approval.
  [
    "POST",
    "financing/share",
    api(async (c) => {
      c.requireWrite();
      rateLimit(`share:${c.biz.id}`, 10, 60_000);
      const b = await c.body(
        z.object({
          recipient: z.string().trim().min(1).max(120),
          amount: money.min(1),
          purpose: z.string().trim().min(1).max(300),
          offerId: z.string().uuid().nullable().optional(),
          expiresInDays: z.number().int().min(1).max(14).default(7),
        }),
      );
      const r = await proposeAction({
        businessId: c.biz.id,
        tool: "share_lender_pack",
        origin: "user",
        role: c.biz.role,
        actorId: c.user.id,
        params: {
          recipient: b.recipient,
          amount: b.amount,
          purpose: b.purpose,
          offerId: b.offerId ?? null,
          expiresInDays: b.expiresInDays,
        },
        idempotencyKey: `share:${c.user.id}:${sha256(JSON.stringify(b))}:${Math.floor(Date.now() / 60_000)}`,
      });
      if (r.mode === "prohibited") throw new ApiError(409, "prohibited", r.reason);
      return r;
    }),
  ],
  [
    "POST",
    "financing/shares/:id/revoke",
    api(async (c) => {
      c.requireAdmin();
      const { id } = params<{ id: string }>(c);
      await asService(async (q) => {
        const r = await q.query(
          "update share_links set revoked_at=now() where id=$1 and business_id=$2 and revoked_at is null returning id",
          [id, c.biz.id],
        );
        if (!r.length) throw notFound("Share link");
        await auditLog(q, {
          businessId: c.biz.id,
          actorType: "user",
          actorId: c.user.id,
          action: "share_link.revoked",
          target: id,
        });
      });
      return { ok: true };
    }),
  ],
  // Public, read-only view for the recipient. Token is compared by hash; expired or revoked links reveal nothing.
  [
    "GET",
    "share/:token",
    apiPublic(async (c) => {
      const { token } = params<{ token: string }>(c);
      rateLimit(`share-view:${c.req.headers.get("x-forwarded-for") ?? "local"}`, 60, 60_000);
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(token))
        return NextResponse.json({ error: { code: "not_found", message: "This link is not valid." } }, { status: 404 });
      const r = await asService((q) =>
        q.query<any>(
          `update share_links set views = views + 1, last_viewed_at = now() where token_hash=$1 and revoked_at is null and expires_at > now()
         returning business_id, payload, fingerprint, recipient, expires_at, created_at`,
          [sha256(token)],
        ),
      );
      if (!r[0])
        return NextResponse.json(
          { error: { code: "not_found", message: "This link has expired, was revoked, or is not valid." } },
          { status: 404 },
        );
      await asService((q) =>
        auditLog(q, {
          businessId: r[0].business_id,
          actorType: "system",
          action: "share_link.viewed",
          detail: { recipient: r[0].recipient },
        }),
      );
      return {
        pack: r[0].payload,
        fingerprint: r[0].fingerprint,
        verified: fingerprintOf(r[0].payload) === r[0].fingerprint,
        recipient: r[0].recipient,
        expiresAt: r[0].expires_at,
        createdAt: r[0].created_at,
      };
    }),
  ],
];

export { runDue };
