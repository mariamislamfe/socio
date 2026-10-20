import "server-only";
import { z } from "zod";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { asService } from "../db";
import {
  authMode,
  changePassword,
  deleteAccount,
  requestPasswordReset,
  resetPassword,
  signIn,
  signOut,
  signUp,
} from "../auth";
import {
  api,
  apiPublic,
  apiUser,
  badRequest,
  ApiError,
  forbidden,
  notFound,
  params,
  resolveBusiness,
  setActiveBusiness,
  uuid,
} from "../http";
import { createBusiness } from "../workspace";
import { createDemoWorkspace } from "../demo";
import { enqueue } from "../jobs";
import { seedDemoHistory } from "../brain/workflows";
import { dbMode } from "../db";
import { isValidTimeZone, todayISO } from "@/lib/finance/dates";
import { currencyDigits } from "@/lib/finance/money";
import type { Route } from "./types";

const email = z.string().trim().toLowerCase().email("Enter a valid email address");
const currencyCode = z
  .string()
  .length(3, "Use a 3-letter currency code")
  .transform((s) => s.toUpperCase());

async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return process.env.NEXT_PUBLIC_APP_URL || `${proto}://${host}`;
}

export const coreRoutes: Route[] = [
  // auth
  [
    "POST",
    "auth/register",
    apiPublic(async (c) => {
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1, "Enter your name").max(80),
          email,
          password: z.string().min(8, "Use at least 8 characters").max(200),
        }),
      );
      const r = await signUp(b.email, b.password, b.name);
      return r;
    }),
  ],
  [
    "POST",
    "auth/login",
    apiPublic(async (c) => {
      const b = await c.body(z.object({ email, password: z.string().min(1, "Enter your password") }));
      await signIn(b.email, b.password);
      return { ok: true };
    }),
  ],
  [
    "POST",
    "auth/logout",
    apiPublic(async () => {
      await signOut();
      return { ok: true };
    }),
  ],
  [
    "POST",
    "auth/forgot",
    apiPublic(async (c) => {
      const b = await c.body(z.object({ email }));
      const r = await requestPasswordReset(b.email, await origin());
      // Same response whether or not the account exists. A link is returned only when no mail service exists (local dev).
      return { ok: true, devLink: r.devLink, delivery: authMode === "supabase" ? "email" : "none" };
    }),
  ],
  [
    "POST",
    "auth/reset",
    apiPublic(async (c) => {
      const b = await c.body(
        z.object({ password: z.string().min(8, "Use at least 8 characters"), token: z.string().optional() }),
      );
      await resetPassword(b.password, b.token);
      return { ok: true };
    }),
  ],
  [
    "POST",
    "auth/password",
    apiUser(async (c) => {
      const b = await c.body(
        z.object({ current: z.string().min(1), next: z.string().min(8, "Use at least 8 characters") }),
      );
      await changePassword(c.user.id, c.user.email, b.current, b.next);
      return { ok: true };
    }),
  ],

  // session / workspaces
  [
    "GET",
    "me",
    apiUser(async (c) => {
      const [profile, businesses] = await Promise.all([
        c.db((q) => q.query("select id,email,name,locale,theme from profiles where id=$1", [c.user.id])),
        c.db((q) =>
          q.query(
            `select b.id,b.name,b.currency,b.is_demo,b.country,b.setup_mode,m.role from memberships m join businesses b on b.id=m.business_id
           where m.user_id=$1 order by b.created_at`,
            [c.user.id],
          ),
        ),
      ]);
      return {
        user: c.user,
        profile: profile[0] ?? { name: "", locale: "en", theme: "system", email: c.user.email },
        businesses,
        active: c.biz?.id ?? null,
        environment: { auth: authMode, database: dbMode },
      };
    }),
  ],
  [
    "PATCH",
    "profile",
    apiUser(async (c) => {
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1).max(80).optional(),
          locale: z.enum(["en", "ar"]).optional(),
          theme: z.enum(["light", "dark", "system"]).optional(),
        }),
      );
      await c.db((q) =>
        q.query(
          "update profiles set name = coalesce($2,name), locale = coalesce($3,locale), theme = coalesce($4,theme) where id=$1",
          [c.user.id, b.name ?? null, b.locale ?? null, b.theme ?? null],
        ),
      );
      return { ok: true };
    }),
  ],
  [
    "POST",
    "businesses",
    apiUser(async (c) => {
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1, "Enter a business name").max(120),
          business_type: z.string().max(40).default("ecommerce"),
          country: z
            .string()
            .length(2)
            .transform((s) => s.toUpperCase())
            .default("EG"),
          currency: currencyCode.default("EGP"),
          stage: z.string().max(40).default("early"),
          channels: z.array(z.string().max(40)).max(12).default([]),
          has_history: z.boolean().default(false),
          setup_mode: z.enum(["manual", "csv", "shopify"]).default("manual"),
          opening_balance: z.number().int().min(0).max(9e15).default(0),
          timezone: z.string().max(64).refine(isValidTimeZone, "Unknown timezone").default("Africa/Cairo"),
          safety_reserve: z.number().int().min(0).max(9e15).nullable().optional(),
        }),
      );
      try {
        currencyDigits(b.currency);
      } catch {
        throw badRequest("Unknown currency code", { currency: "Unknown currency" });
      }
      const id = await createBusiness(c.user.id, b);
      await asService((q) =>
        q.query("update businesses set timezone=$2, settings = settings || $3::text::jsonb where id=$1", [
          id,
          b.timezone,
          JSON.stringify(b.safety_reserve != null ? { safetyReserve: b.safety_reserve } : {}),
        ]),
      );
      await asService((q) =>
        q.query(
          "insert into accounts(business_id,name,type,currency,opening_balance) values ($1,'Main account','bank',$2,$3)",
          [id, b.currency, b.opening_balance],
        ),
      );
      await setActiveBusiness(id);
      return { id };
    }),
  ],
  [
    "POST",
    "demo",
    apiUser(async (c) => {
      const id = await createDemoWorkspace(c.user.id, todayISO());
      await setActiveBusiness(id);
      await seedDemoHistory(id);
      await enqueue({
        businessId: id,
        kind: "findings.evaluate",
        payload: { trigger: "demo" },
        idempotencyKey: `findings_demo:${id}`,
      });
      await enqueue({
        businessId: id,
        kind: "cash_risk.evaluate",
        payload: { trigger: "demo" },
        idempotencyKey: `cash_demo:${id}`,
      });
      return { id };
    }),
  ],
  [
    "POST",
    "businesses/switch",
    apiUser(async (c) => {
      const b = await c.body(z.object({ id: uuid }));
      const biz = await resolveBusiness(c.user.id, b.id);
      if (!biz || biz.id !== b.id) throw notFound("Workspace");
      await setActiveBusiness(b.id);
      return { ok: true };
    }),
  ],
  [
    "DELETE",
    "businesses/:id",
    apiUser(async (c) => {
      const { id } = params<{ id: string }>(c);
      const rows = await c.db((q) =>
        q.query<{ role: string; is_demo: boolean }>(
          "select m.role, b.is_demo from memberships m join businesses b on b.id=m.business_id where m.business_id=$1 and m.user_id=$2",
          [id, c.user.id],
        ),
      );
      if (!rows[0]) throw notFound("Workspace");
      if (rows[0].role !== "owner") throw forbidden("Only the owner can delete a workspace.");
      await asService((q) => q.query("delete from businesses where id=$1", [id]));
      return { ok: true };
    }),
  ],
  [
    "GET",
    "business",
    api(async (c) => {
      const rows = await c.db((q) =>
        q.query(
          "select id,name,business_type,country,currency,stage,channels,has_history,setup_mode,is_demo,locale,timezone,settings,onboarding,created_at from businesses where id=$1",
          [c.biz.id],
        ),
      );
      return { business: rows[0], role: c.biz.role };
    }),
  ],
  [
    "PATCH",
    "business",
    api(async (c) => {
      c.requireAdmin();
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1).max(120).optional(),
          business_type: z.string().max(40).optional(),
          country: z.string().length(2).optional(),
          stage: z.string().max(40).optional(),
          channels: z.array(z.string().max(40)).max(12).optional(),
          has_history: z.boolean().optional(),
          locale: z.enum(["en", "ar"]).optional(),
          timezone: z.string().max(64).refine(isValidTimeZone, "Unknown timezone").optional(),
          settings: z.record(z.string(), z.unknown()).optional(),
          onboarding: z.record(z.string(), z.unknown()).optional(),
        }),
      );
      await c.db((q) =>
        q.query(
          `update businesses set name=coalesce($2,name), business_type=coalesce($3,business_type), country=coalesce($4,country), stage=coalesce($5,stage),
           channels=coalesce($6,channels), has_history=coalesce($7,has_history), locale=coalesce($8,locale), timezone=coalesce($11,timezone),
           settings = settings || coalesce($9::text::jsonb,'{}'::jsonb), onboarding = onboarding || coalesce($10::text::jsonb,'{}'::jsonb)
         where id=$1`,
          [
            c.biz.id,
            b.name ?? null,
            b.business_type ?? null,
            b.country?.toUpperCase() ?? null,
            b.stage ?? null,
            b.channels ?? null,
            b.has_history ?? null,
            b.locale ?? null,
            b.settings ? JSON.stringify(b.settings) : null,
            b.onboarding ? JSON.stringify(b.onboarding) : null,
            b.timezone ?? null,
          ],
        ),
      );
      return { ok: true };
    }),
  ],
  [
    "POST",
    "account/delete",
    apiUser(async (c) => {
      const b = await c.body(z.object({ confirm: z.literal("DELETE") }));
      void b;
      await deleteAccount(c.user.id);
      return { ok: true };
    }),
  ],

  // accounts
  [
    "GET",
    "accounts",
    api(async (c) => {
      const rows = await c.db((q) =>
        q.query(
          "select id,name,type,currency,opening_balance,archived,position from accounts where business_id=$1 order by position, created_at",
          [c.biz.id],
        ),
      );
      return { items: rows };
    }),
  ],
  [
    "POST",
    "accounts",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1, "Enter a name").max(80),
          type: z.enum(["bank", "cash", "wallet", "card", "other"]),
          currency: currencyCode.optional(),
          opening_balance: z.number().int().default(0),
        }),
      );
      const rows = await c.db((q) =>
        q.query(
          "insert into accounts(business_id,name,type,currency,opening_balance) values ($1,$2,$3,$4,$5) returning id",
          [c.biz.id, b.name, b.type, b.currency ?? c.biz.currency, b.opening_balance],
        ),
      );
      return { id: rows[0].id };
    }),
  ],
  [
    "PATCH",
    "accounts/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1).max(80).optional(),
          opening_balance: z.number().int().optional(),
          archived: z.boolean().optional(),
        }),
      );
      const r = await c.db((q) =>
        q.query(
          "update accounts set name=coalesce($3,name), opening_balance=coalesce($4,opening_balance), archived=coalesce($5,archived) where id=$1 and business_id=$2 returning id",
          [id, c.biz.id, b.name ?? null, b.opening_balance ?? null, b.archived ?? null],
        ),
      );
      if (!r[0]) throw notFound("Account");
      return { ok: true };
    }),
  ],
  [
    "DELETE",
    "accounts/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const used = await c.db((q) =>
        q.query("select 1 from transactions where business_id=$1 and (account_id=$2 or to_account_id=$2) limit 1", [
          c.biz.id,
          id,
        ]),
      );
      if (used.length)
        throw new ApiError(409, "in_use", "This account has transactions. Archive it instead of deleting it.");
      await c.db((q) => q.query("delete from accounts where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],

  // categories
  [
    "GET",
    "categories",
    api(async (c) => {
      const rows = await c.db((q) =>
        q.query(
          "select id,name,kind,cost_type,parent_id,color,essential,role,is_system,archived,position from categories where business_id=$1 order by position, name",
          [c.biz.id],
        ),
      );
      return { items: rows };
    }),
  ],
  [
    "POST",
    "categories",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1, "Enter a name").max(80),
          kind: z.enum(["income", "expense"]),
          cost_type: z.enum(["cogs", "opex"]).nullable().optional(),
          parent_id: uuid.nullable().optional(),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .default("#6b7a72"),
          essential: z.boolean().default(false),
        }),
      );
      const rows = await c.db((q) =>
        q.query(
          "insert into categories(business_id,name,kind,cost_type,parent_id,color,essential,position) values ($1,$2,$3,$4,$5,$6,$7,(select coalesce(max(position),0)+1 from categories where business_id=$1)) returning id",
          [
            c.biz.id,
            b.name,
            b.kind,
            b.kind === "expense" ? (b.cost_type ?? "opex") : null,
            b.parent_id ?? null,
            b.color,
            b.essential,
          ],
        ),
      );
      return { id: rows[0].id };
    }),
  ],
  [
    "PATCH",
    "categories/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1).max(80).optional(),
          cost_type: z.enum(["cogs", "opex"]).optional(),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .optional(),
          essential: z.boolean().optional(),
          archived: z.boolean().optional(),
        }),
      );
      const r = await c.db((q) =>
        q.query(
          "update categories set name=coalesce($3,name), cost_type=case when kind='expense' then coalesce($4,cost_type) else null end, color=coalesce($5,color), essential=coalesce($6,essential), archived=coalesce($7,archived) where id=$1 and business_id=$2 returning id",
          [id, c.biz.id, b.name ?? null, b.cost_type ?? null, b.color ?? null, b.essential ?? null, b.archived ?? null],
        ),
      );
      if (!r[0]) throw notFound("Category");
      return { ok: true };
    }),
  ],
  [
    "DELETE",
    "categories/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const rows = await c.db((q) =>
        q.query<{ is_system: boolean }>("select is_system from categories where id=$1 and business_id=$2", [
          id,
          c.biz.id,
        ]),
      );
      if (!rows[0]) throw notFound("Category");
      // Transactions keep their history: the category reference is cleared (they become "uncategorized").
      await c.db((q) => q.query("delete from categories where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],

  // payees
  [
    "GET",
    "payees",
    api(async (c) => ({
      items: await c.db((q) =>
        q.query("select id,name,kind,notes,email from payees where business_id=$1 order by name", [c.biz.id]),
      ),
    })),
  ],
  [
    "POST",
    "payees",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1, "Enter a name").max(120),
          kind: z
            .enum(["supplier", "customer", "contractor", "employee", "landlord", "platform", "other"])
            .default("supplier"),
          notes: z.string().max(500).optional(),
          email: z.string().trim().email("Enter a valid email").max(200).optional().or(z.literal("")),
        }),
      );
      const rows = await c.db((q) =>
        q.query("insert into payees(business_id,name,kind,notes,email) values ($1,$2,$3,$4,$5) returning id", [
          c.biz.id,
          b.name,
          b.kind,
          b.notes ?? null,
          b.email || null,
        ]),
      );
      return { id: rows[0].id };
    }),
  ],
  [
    "DELETE",
    "payees/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db((q) => q.query("delete from payees where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],

  // products
  [
    "GET",
    "products",
    api(async (c) => ({
      items: await c.db((q) =>
        q.query("select id,name,sku,price,unit_cost,stock,source from products where business_id=$1 order by name", [
          c.biz.id,
        ]),
      ),
    })),
  ],
  [
    "POST",
    "products",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1, "Enter a name").max(120),
          sku: z.string().max(60).optional(),
          price: z.number().int().min(0).nullable().optional(),
          unit_cost: z.number().int().min(0).nullable().optional(),
          stock: z.number().int().min(0).nullable().optional(),
        }),
      );
      const rows = await c.db((q) =>
        q.query(
          "insert into products(business_id,name,sku,price,unit_cost,stock) values ($1,$2,$3,$4,$5,$6) returning id",
          [c.biz.id, b.name, b.sku ?? null, b.price ?? null, b.unit_cost ?? null, b.stock ?? null],
        ),
      );
      return { id: rows[0].id };
    }),
  ],
  [
    "PATCH",
    "products/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1).max(120).optional(),
          price: z.number().int().min(0).nullable().optional(),
          unit_cost: z.number().int().min(0).nullable().optional(),
          stock: z.number().int().min(0).nullable().optional(),
        }),
      );
      const has = (k: keyof typeof b) => (k in b ? 1 : 0);
      const r = await c.db((q) =>
        q.query(
          `update products set name=coalesce($3,name), price=case when $4=1 then $5 else price end, unit_cost=case when $6=1 then $7 else unit_cost end, stock=case when $8=1 then $9 else stock end
         where id=$1 and business_id=$2 returning id`,
          [
            id,
            c.biz.id,
            b.name ?? null,
            has("price"),
            b.price ?? null,
            has("unit_cost"),
            b.unit_cost ?? null,
            has("stock"),
            b.stock ?? null,
          ],
        ),
      );
      if (!r[0]) throw notFound("Product");
      return { ok: true };
    }),
  ],
  [
    "DELETE",
    "products/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db((q) => q.query("delete from products where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],

  ["GET", "health", apiPublic(async () => NextResponse.json({ ok: true, auth: authMode, database: dbMode }))],
];
