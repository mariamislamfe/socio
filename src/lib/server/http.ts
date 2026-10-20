import "server-only";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { asUser, type Q } from "./db";
import { AuthError, currentUser, type AuthUser } from "./auth";
import { emitEvent } from "./jobs";

// Writes to these resources change the money picture: the brain re-checks cash risk (debounced).
const LEDGER_WRITE =
  /^\/api\/(transactions|invoices|recurring|import|accounts|goals|budgets|business|automation|money-plan|simple|fixed)(\/|$)/;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}
export const notFound = (what = "Record") => new ApiError(404, "not_found", `${what} not found.`);
export const forbidden = (m = "You do not have permission to do that.") => new ApiError(403, "forbidden", m);
export const badRequest = (m: string, fields?: Record<string, string>) => new ApiError(422, "invalid", m, fields);

export interface BizCtx {
  id: string;
  role: "owner" | "admin" | "member" | "viewer";
  name: string;
  currency: string;
  isDemo: boolean;
  country: string;
  locale: string;
}

export interface Ctx {
  req: Request;
  user: AuthUser;
  biz: BizCtx;
  url: URL;
  /* * Run SQL as the signed-in user; Postgres RLS is the tenant boundary. */
  db<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  body<T extends z.ZodTypeAny>(schema: T): Promise<z.infer<T>>;
  query<T extends z.ZodTypeAny>(schema: T): z.infer<T>;
  requireWrite(): void;
  requireAdmin(): void;
}

const BIZ_COOKIE = "margin_biz";

export async function resolveBusiness(userId: string, preferred?: string | null): Promise<BizCtx | null> {
  const rows = await asUser(userId, (q) =>
    q.query<any>(
      `select b.id, b.name, b.currency, b.is_demo, b.country, b.locale, m.role
       from memberships m join businesses b on b.id = m.business_id
       where m.user_id = $1 order by b.created_at asc`,
      [userId],
    ),
  );
  if (!rows.length) return null;
  const pick = rows.find((r) => r.id === preferred) ?? rows[0];
  return {
    id: pick.id,
    role: pick.role,
    name: pick.name,
    currency: pick.currency.trim(),
    isDemo: pick.is_demo,
    country: pick.country,
    locale: pick.locale,
  };
}

function sameOrigin(req: Request, h: Headers): boolean {
  const origin = req.headers.get("origin");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!origin) return req.headers.get("sec-fetch-site") === "same-origin" || req.headers.get("sec-fetch-site") === null;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

type Opts = { business?: boolean; csrf?: boolean; public?: boolean };

/* * Wraps a route handler: auth, tenant resolution, CSRF origin check, uniform JSON errors. */
function make(opts: Opts, fn: (ctx: Ctx) => Promise<unknown>) {
  const needBiz = opts.business !== false;
  return async (req: Request, routeCtx?: { params: Promise<Record<string, string>> }) => {
    try {
      const h = await headers();
      if (opts.csrf !== false && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req, h)) {
        throw new ApiError(403, "csrf", "Cross-origin request blocked.");
      }
      const user = opts.public ? ((await currentUser()) ?? ({ id: "", email: "" } as AuthUser)) : await currentUser();
      if (!user) throw new ApiError(401, "unauthenticated", "Please sign in.");
      let biz: BizCtx | null = null;
      if (!opts.public) {
        const preferred = (await cookies()).get(BIZ_COOKIE)?.value;
        biz = await resolveBusiness(user.id, preferred);
        if (needBiz && !biz) throw new ApiError(409, "no_business", "Set up a business first.");
      }
      const url = new URL(req.url);
      const params = routeCtx ? await routeCtx.params : {};
      const ctx: Ctx = {
        req,
        user,
        biz: biz as any,
        url,
        db: (f) => asUser(user.id, f),
        async body(schema) {
          let json: unknown;
          try {
            json = await req.json();
          } catch {
            throw badRequest("Request body must be valid JSON.");
          }
          return parse(schema, json);
        },
        query(schema) {
          return parse(schema, Object.fromEntries(url.searchParams));
        },
        requireWrite() {
          if (!biz || biz.role === "viewer") throw forbidden("Your role is read-only in this workspace.");
        },
        requireAdmin() {
          if (!biz || (biz.role !== "owner" && biz.role !== "admin"))
            throw forbidden("Only workspace owners and admins can do that.");
        },
      };
      (ctx as any).params = params;
      const out = await fn(ctx);
      if (biz && !opts.public && !["GET", "HEAD"].includes(req.method) && LEDGER_WRITE.test(url.pathname)) {
        void emitEvent({
          businessId: biz.id,
          source: "user",
          type: "ledger.changed",
          entityId: url.pathname,
          idempotencyKey: `ledger:${crypto.randomUUID()}`,
          payload: { path: url.pathname, method: req.method },
        }).catch(() => {});
      }
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function params<T extends Record<string, string>>(ctx: unknown): T {
  return ((ctx as any).params ?? {}) as T;
}

/* * Authenticated route scoped to the active business. */
export const api = (fn: (ctx: Ctx) => Promise<unknown>) => make({ business: true }, fn);
/* * Unauthenticated route (sign-in, sign-up, reset). Still CSRF-checked. */
export const apiPublic = (fn: (ctx: Ctx) => Promise<unknown>) => make({ business: false, public: true }, fn);
/* * Authenticated route that does not need a business (account, onboarding). `ctx.biz` may be null. */
export const apiUser = (fn: (ctx: Ctx) => Promise<unknown>) => make({ business: false }, fn);
/* * Authenticated route without the CSRF origin check (provider callbacks). */
export const apiCallback = (fn: (ctx: Ctx) => Promise<unknown>) => make({ business: false, csrf: false }, fn);

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw zodToApi(r.error);
}

function zodToApi(err: ZodError): ApiError {
  const fields: Record<string, string> = {};
  for (const i of err.issues) {
    const k = i.path.join(".") || "_";
    if (!fields[k]) fields[k] = i.message;
  }
  return new ApiError(422, "invalid", Object.values(fields)[0] ?? "Some fields are invalid.", fields);
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof ApiError)
    return NextResponse.json({ error: { code: e.code, message: e.message, fields: e.fields } }, { status: e.status });
  if (e instanceof AuthError)
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  if (e instanceof ZodError) {
    const a = zodToApi(e);
    return NextResponse.json({ error: { code: a.code, message: a.message, fields: a.fields } }, { status: 422 });
  }
  const msg = e instanceof Error ? e.message : String(e);
  // Constraint violations from Postgres are user-facing validation, not server faults.
  if (/violates foreign key|violates check constraint|violates unique|row-level security|new row violates/.test(msg)) {
    const unique = /unique/.test(msg);
    return NextResponse.json(
      {
        error: {
          code: unique ? "conflict" : "invalid",
          message: unique ? "That record already exists." : "That change is not allowed for this workspace.",
        },
      },
      { status: unique ? 409 : 422 },
    );
  }
  console.error("[api] unexpected error:", e);
  return NextResponse.json(
    { error: { code: "server_error", message: "Something went wrong on our side. Please try again." } },
    { status: 500 },
  );
}

export async function setActiveBusiness(id: string) {
  (await cookies()).set(BIZ_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 365 * 86400,
  });
}

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date")
  .refine((d) => !Number.isNaN(Date.parse(d)), "Use a valid date");
export const uuid = z.string().uuid("Invalid id");
export const minor = z
  .number({ error: "Enter an amount" })
  .int("Amount must be a whole number of minor units")
  .positive("Amount must be greater than zero")
  .max(9_000_000_000_000_000);

// Simple per-process fixed-window rate limiter for expensive or sensitive endpoints.
const rl = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const b = rl.get(key);
  if (!b || b.reset < now) {
    rl.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  if (++b.n > limit)
    throw new ApiError(
      429,
      "rate_limited",
      `Too many requests. Try again in ${Math.ceil((b.reset - now) / 1000)} seconds.`,
    );
}
