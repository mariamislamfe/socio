import "server-only";
import { z } from "zod";
import { NextResponse } from "next/server";
import { addDays, addMonths, endOfMonth, periodInfo, type PeriodKind } from "@/lib/finance/dates";
import { invoiceOutstanding, invoiceState } from "@/lib/finance/engine";
import { assessDataQuality } from "@/lib/finance/cashrisk";
import { baseForecast, cashBalance } from "@/lib/finance/planning";
import { profitReport, type LineRow, type OrderRow, type ProductCost } from "@/lib/finance/profit";
import { asService } from "../db";
import { api, apiPublic, ApiError, isoDate, notFound, params, rateLimit } from "../http";
import { auditLog, retryJob, runDue } from "../jobs";
import { approveAction, executeAction, proposeAction, rejectAction } from "../brain/actions";
import { readAutomation, trustLadder } from "../brain/policy";
import { TOOLS } from "../brain/tools";
import { buildBriefing, evaluateCashRisk, evaluateFindings, safetyReserveOf } from "../brain/workflows";
import { registerHandlers, scheduleTick } from "../worker";
import { loadSnapshot } from "../workspace";
import { safeEqual } from "../crypto";
import { runAgent } from "../agent";
import {
  briefingMessage,
  deliverBriefing,
  maskPhone,
  readWhatsApp,
  recordFromMessage,
  sendText,
  TEMPLATE_TEXT,
  whatsappMissing,
} from "../whatsapp";
import crypto from "node:crypto";
import type { Route } from "./types";

export const brainRoutes: Route[] = [
  // intelligent home
  [
    "GET",
    "home",
    api(async (c) => {
      const snap = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const [biz, recs, approvals, integ, brief] = await c.db(
        async (q) =>
          [
            (await q.query<any>("select settings, timezone from businesses where id=$1", [c.biz.id]))[0],
            await q.query<any>(
              "select id,title,summary,severity,options,created_at from recommendations where business_id=$1 and status='open' order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, created_at desc limit 3",
              [c.biz.id],
            ),
            await q.query<{ n: number }>(
              "select count(*)::int n from actions where business_id=$1 and status='awaiting_approval'",
              [c.biz.id],
            ),
            await q.query<any>(
              "select provider,status,last_sync_at::text as last_sync_at,display_name from integrations where business_id=$1 and status <> 'disconnected'",
              [c.biz.id],
            ),
            await q.query<any>("select content from briefings where business_id=$1 order by local_date desc limit 1", [
              c.biz.id,
            ]),
          ] as const,
      );
      const cash = cashBalance(snap);
      const reserve = safetyReserveOf(biz.settings);
      const f = baseForecast(snap, 30);
      const next = f.events[0] ?? null;
      const quality = assessDataQuality(snap, {
        integrations: integ.map((i: any) => ({ provider: i.provider, status: i.status, lastSyncAt: i.last_sync_at })),
      });
      const top = recs[0];
      const nextAction = top
        ? { title: top.options?.[0]?.title ?? top.title, why: top.summary, href: "/app/actions" }
        : snap.txns.length === 0
          ? {
              title: "Record your first sale or expense",
              why: "Everything else is built from your records.",
              href: "/app/transactions?new=income",
            }
          : reserve === null
            ? {
                title: "Set a safety reserve",
                why: "Tell Socio the minimum cash you want to keep, so it can warn you early.",
                href: "/app/actions?tab=settings",
              }
            : null;
      const status = recs.some((r: any) => r.severity === "critical")
        ? "act"
        : recs.length
          ? "watch"
          : snap.txns.length
            ? "good"
            : "start";
      return {
        currency: snap.currency,
        today: snap.today,
        timezone: biz.timezone,
        status,
        cash: {
          recorded: cash.total,
          pendingNonCash: cash.pending,
          accounts: cash.accounts.length,
          lowest30: f.minCash,
          lowestDate: f.minCashDate,
        },
        reserve,
        nextEvent: next,
        attention: { recommendations: recs, approvals: approvals[0].n },
        nextAction,
        integrations: integ,
        dataQuality: quality,
        briefing: brief[0]?.content ?? null,
      };
    }),
  ],

  // action center
  [
    "GET",
    "actions",
    api(async (c) => {
      const [biz, recs, acts, jobs, preds, audit, drafts] = await c.db(
        async (q) =>
          [
            (await q.query<any>("select settings from businesses where id=$1", [c.biz.id]))[0],
            await q.query<any>(
              "select * from recommendations where business_id=$1 order by (status='open') desc, updated_at desc limit 20",
              [c.biz.id],
            ),
            await q.query<any>(
              "select id,recommendation_id,tool,params,params_hash,risk_level,summary,status,requires_approval,approved_at,executed_at,result,verification,error,origin,created_at from actions where business_id=$1 order by created_at desc limit 60",
              [c.biz.id],
            ),
            await q.query<any>(
              "select id,kind,status,attempts,max_attempts,run_after,last_error,created_at,finished_at,payload from jobs where business_id=$1 order by created_at desc limit 40",
              [c.biz.id],
            ),
            await q.query<any>(
              "select id,metric,made_on::text,target_date::text,predicted,actual,measured_at,data_quality,note from predictions where business_id=$1 order by target_date desc limit 30",
              [c.biz.id],
            ),
            await q.query<any>(
              "select actor_type,action,target,detail,created_at from audit_log where business_id=$1 order by created_at desc limit 40",
              [c.biz.id],
            ),
            await q.query<any>(
              "select id,to_name,to_email,subject,body,status,created_at from email_drafts where business_id=$1 order by created_at desc limit 20",
              [c.biz.id],
            ),
          ] as const,
      );
      const [allPreds, history, recv] = await c.db(
        async (q) =>
          [
            await q.query<{ predicted: string; actual: string | null }>(
              "select predicted::text, actual::text from predictions where business_id=$1 and actual is not null order by target_date desc limit 12",
              [c.biz.id],
            ),
            await q.query<any>(
              "select tool,status,origin,requires_approval from actions where business_id=$1 order by created_at desc limit 100",
              [c.biz.id],
            ),
            await q.query<{ o: string }>(
              "select (i.amount - coalesce((select sum(p.amount) from invoice_payments p where p.invoice_id=i.id),0))::text o from invoices i where i.business_id=$1 and i.direction='receivable' and i.status='open'",
              [c.biz.id],
            ),
          ] as const,
      );
      const trust = trustLadder({
        predictions: allPreds.map((p) => ({
          predicted: Number(p.predicted),
          actual: p.actual === null ? null : Number(p.actual),
        })),
        actions: history,
        automation: readAutomation(biz.settings),
        receivables: recv.map((r) => Number(r.o)).filter((v) => v > 0),
        emailConfigured: !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
      });
      const measured = preds.filter((p: any) => p.actual !== null);
      const accuracy = measured.length
        ? {
            count: measured.length,
            meanAbsError: Math.round(
              measured.reduce((a: number, p: any) => a + Math.abs(Number(p.actual) - Number(p.predicted)), 0) /
                measured.length,
            ),
          }
        : null;
      return {
        currency: c.biz.currency,
        automation: readAutomation(biz.settings),
        safetyReserve: safetyReserveOf(biz.settings),
        recommendations: recs,
        approvals: acts.filter((a: any) => a.status === "awaiting_approval"),
        actions: acts,
        jobs,
        predictions: preds,
        accuracy,
        audit,
        drafts,
        tools: Object.values(TOOLS).map((t) => ({
          name: t.name,
          label: t.label,
          risk: t.risk,
          available: t.available(),
        })),
        trust,
        emailConfigured: !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
      };
    }),
  ],

  [
    "POST",
    "actions/:id/approve",
    api(async (c) => {
      const { id } = params<{ id: string }>(c);
      const b = await c.body(z.object({ hash: z.string().length(64) }));
      const r = await approveAction({
        businessId: c.biz.id,
        actionId: id,
        userId: c.user.id,
        hash: b.hash,
        role: c.biz.role,
      });
      if (!r.ok) throw new ApiError(409, "not_approved", r.reason ?? "Could not approve.");
      // Execute now rather than waiting for the worker tick; the job keeps it durable if this request dies.
      await runDue({ kinds: ["action.execute"], max: 3 });
      const a = await c.db((q) =>
        q.query<any>("select status,error,verification from actions where id=$1 and business_id=$2", [id, c.biz.id]),
      );
      return { ok: true, ...a[0] };
    }),
  ],
  [
    "POST",
    "actions/:id/reject",
    api(async (c) => {
      c.requireAdmin();
      const { id } = params<{ id: string }>(c);
      if (!(await rejectAction({ businessId: c.biz.id, actionId: id, userId: c.user.id })))
        throw new ApiError(409, "not_pending", "This action is not waiting for approval.");
      return { ok: true };
    }),
  ],
  // User-originated action from a draft or recommendation, still governed by the same policy.
  [
    "POST",
    "actions/propose",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          tool: z.string().max(60),
          params: z.record(z.string(), z.unknown()),
          recommendationId: z.string().uuid().nullable().optional(),
        }),
      );
      const r = await proposeAction({
        businessId: c.biz.id,
        tool: b.tool,
        params: b.params,
        origin: "user",
        role: c.biz.role,
        actorId: c.user.id,
        recommendationId: b.recommendationId ?? null,
        idempotencyKey: `user:${c.user.id}:${b.tool}:${JSON.stringify(b.params)}:${Math.floor(Date.now() / 60_000)}`,
      });
      if (r.mode === "prohibited") throw new ApiError(409, "prohibited", r.reason);
      return r;
    }),
  ],
  [
    "POST",
    "recommendations/:id/dismiss",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await asService(async (q) => {
        const r = await q.query(
          "update recommendations set status='dismissed', resolved_at=now(), updated_at=now() where id=$1 and business_id=$2 and status='open' returning id",
          [id, c.biz.id],
        );
        if (!r.length) throw notFound("Recommendation");
        await q.query(
          "update actions set status='cancelled' where recommendation_id=$1 and business_id=$2 and status='awaiting_approval'",
          [id, c.biz.id],
        );
        await auditLog(q, {
          businessId: c.biz.id,
          actorType: "user",
          actorId: c.user.id,
          action: "recommendation.dismissed",
          target: id,
        });
      });
      return { ok: true };
    }),
  ],
  [
    "POST",
    "cash-risk/run",
    api(async (c) => {
      c.requireWrite();
      rateLimit(`cashrisk:${c.biz.id}`, 10, 60_000);
      registerHandlers();
      const r = await evaluateCashRisk(c.biz.id, "manual");
      return r;
    }),
  ],
  [
    "POST",
    "checks/run",
    api(async (c) => {
      c.requireWrite();
      rateLimit(`checks:${c.biz.id}`, 10, 60_000);
      registerHandlers();
      const cash = await evaluateCashRisk(c.biz.id, "manual");
      const health = await evaluateFindings(c.biz.id, "manual");
      return { cash, findings: health.findings };
    }),
  ],
  [
    "PATCH",
    "automation",
    api(async (c) => {
      c.requireAdmin();
      const b = await c.body(
        z.object({
          paused: z.boolean().optional(),
          paymentReminders: z
            .object({
              enabled: z.boolean(),
              maxAmount: z.number().int().min(0).max(9e15),
              minDaysBetween: z.number().int().min(1).max(60),
            })
            .optional(),
          safetyReserve: z.number().int().min(0).max(9e15).nullable().optional(),
        }),
      );
      await asService(async (q) => {
        const cur = (await q.query<any>("select settings from businesses where id=$1", [c.biz.id]))[0]?.settings ?? {};
        const automation = {
          ...(cur.automation ?? {}),
          ...(b.paused !== undefined ? { paused: b.paused } : {}),
          ...(b.paymentReminders ? { paymentReminders: b.paymentReminders } : {}),
        };
        const patch: any = { automation };
        if ("safetyReserve" in b) patch.safetyReserve = b.safetyReserve;
        await q.query("update businesses set settings = settings || $2::text::jsonb where id=$1", [
          c.biz.id,
          JSON.stringify(patch),
        ]);
        if ("safetyReserve" in b && b.safetyReserve === null)
          await q.query("update businesses set settings = settings - 'safetyReserve' where id=$1", [c.biz.id]);
        await auditLog(q, {
          businessId: c.biz.id,
          actorType: "user",
          actorId: c.user.id,
          action: "automation.updated",
          detail: b,
        });
      });
      return { ok: true };
    }),
  ],
  [
    "POST",
    "jobs/:id/retry",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      if (!(await retryJob(c.biz.id, id)))
        throw new ApiError(409, "not_retryable", "Only finished or failed jobs can be retried.");
      registerHandlers();
      void runDue({ max: 3 }).catch(() => {});
      return { ok: true };
    }),
  ],
  [
    "POST",
    "drafts/:id/discard",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db((q) =>
        q.query("update email_drafts set status='discarded' where id=$1 and business_id=$2 and status='draft'", [
          id,
          c.biz.id,
        ]),
      );
      return { ok: true };
    }),
  ],

  // "Ask your business": intent → plan → tools → answer; actions only as policy-checked proposals
  [
    "POST",
    "agent",
    api(async (c) => {
      rateLimit(`agent:${c.user.id}`, 20, 60_000);
      const b = await c.body(
        z.object({
          message: z.string().trim().min(2, "Ask a question").max(600),
          history: z
            .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
            .max(10)
            .default([]),
          lang: z.enum(["en", "ar"]).optional(),
        }),
      );
      const snap = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const settings =
        (await c.db((q) => q.query<any>("select settings from businesses where id=$1", [c.biz.id])))[0]?.settings ?? {};
      registerHandlers();
      const r = await runAgent({
        businessId: c.biz.id,
        userId: c.user.id,
        role: c.biz.role as "owner" | "admin" | "member" | "viewer",
        message: b.message,
        history: b.history,
        snap,
        settings,
        db: c.db,
        lang: b.lang,
      });
      return { ...r, aiConfigured: !!process.env.ANTHROPIC_API_KEY };
    }),
  ],

  // daily briefing on WhatsApp (owner's own number, explicit opt-in)
  [
    "GET",
    "whatsapp",
    api(async (c) => {
      const biz = (
        await c.db((q) =>
          q.query<{ name: string; settings: any }>("select name, settings from businesses where id=$1", [c.biz.id]),
        )
      )[0];
      const w = readWhatsApp(biz.settings);
      const b = await buildBriefing(c.biz.id);
      const name = biz.name.replace(/\s*\(demo data\)\s*/i, "");
      const deliveries = await c.db((q) =>
        q.query<any>(
          "select kind,to_masked,status,provider_message_id,error,preview,created_at from message_deliveries where business_id=$1 order by created_at desc limit 10",
          [c.biz.id],
        ),
      );
      return {
        configured: whatsappMissing().length === 0,
        missingEnv: whatsappMissing(),
        template: process.env.WHATSAPP_TEMPLATE || "daily_briefing",
        templateText: TEMPLATE_TEXT,
        settings: { optIn: w.optIn, lang: w.lang, phone: w.phone ? maskPhone(w.phone) : null },
        preview: { en: briefingMessage(b, name, "en").preview, ar: briefingMessage(b, name, "ar").preview },
        deliveries,
      };
    }),
  ],
  [
    "PATCH",
    "whatsapp",
    api(async (c) => {
      c.requireAdmin();
      const b = await c.body(
        z.object({
          optIn: z.boolean(),
          phone: z
            .string()
            .trim()
            .regex(/^\+[1-9]\d{7,14}$/, "Use the international format, e.g. +201001234567")
            .nullable()
            .optional(),
          lang: z.enum(["en", "ar"]).default("en"),
        }),
      );
      await asService(async (q) => {
        const cur = readWhatsApp(
          (await q.query<any>("select settings from businesses where id=$1", [c.biz.id]))[0]?.settings,
        );
        const phone = b.phone === undefined ? cur.phone : b.phone;
        if (b.optIn && !phone)
          throw new ApiError(422, "invalid", "Add your WhatsApp number first.", { phone: "Required to turn this on" });
        await q.query("update businesses set settings = settings || $2::text::jsonb where id=$1", [
          c.biz.id,
          JSON.stringify({ whatsapp: { optIn: b.optIn, phone, lang: b.lang } }),
        ]);
        await auditLog(q, {
          businessId: c.biz.id,
          actorType: "user",
          actorId: c.user.id,
          action: b.optIn ? "whatsapp.opted_in" : "whatsapp.opted_out",
          detail: { to: phone ? maskPhone(phone) : null, lang: b.lang },
        });
      });
      return { ok: true };
    }),
  ],
  [
    "POST",
    "whatsapp/test",
    api(async (c) => {
      c.requireAdmin();
      rateLimit(`wa-test:${c.biz.id}`, 3, 60_000);
      const b = await buildBriefing(c.biz.id);
      return deliverBriefing(c.biz.id, b, { dedupeKey: `test:${Date.now()}` });
    }),
  ],

  // Try "record by message" from inside the app (same parser and recorder as real WhatsApp messages).
  [
    "POST",
    "whatsapp/simulate",
    api(async (c) => {
      c.requireWrite();
      rateLimit(`wa-sim:${c.user.id}`, 30, 60_000);
      const b = await c.body(z.object({ text: z.string().trim().min(1).max(300) }));
      return recordFromMessage(c.biz.id, b.text);
    }),
  ],
  // Meta webhook verification handshake.
  [
    "GET",
    "webhooks/whatsapp",
    async (req) => {
      const u = new URL(req.url);
      const token = process.env.WHATSAPP_VERIFY_TOKEN;
      if (
        token &&
        u.searchParams.get("hub.mode") === "subscribe" &&
        safeEqual(u.searchParams.get("hub.verify_token") ?? "", token)
      )
        return new NextResponse(u.searchParams.get("hub.challenge") ?? "", { status: 200 });
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    },
  ],
  // Incoming messages: signature-verified, de-duplicated, and accepted only from an owner's opted-in number.
  [
    "POST",
    "webhooks/whatsapp",
    async (req) => {
      const raw = await req.text();
      const secret = process.env.WHATSAPP_APP_SECRET;
      if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
      const sig = (req.headers.get("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
      const digest = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
      if (!sig || !safeEqual(sig, digest)) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: "bad_json" }, { status: 400 });
      }
      const messages = (body?.entry ?? []).flatMap((e: any) =>
        (e?.changes ?? []).flatMap((ch: any) => ch?.value?.messages ?? []),
      );
      for (const m of messages) {
        if (m?.type !== "text" || !m?.id || !m?.from) continue;
        const fresh = await asService((q) =>
          q.query(
            "insert into webhook_events(provider,event_id,topic) values ('whatsapp',$1,'message') on conflict do nothing returning id",
            [String(m.id)],
          ),
        );
        if (!fresh.length) continue;
        const phone = `+${String(m.from).replace(/\D/g, "")}`;
        const biz = await asService((q) =>
          q.query<{ id: string }>(
            "select id from businesses where settings->'whatsapp'->>'phone' = $1 and (settings->'whatsapp'->>'optIn')::boolean is true order by is_demo asc, created_at desc limit 1",
            [phone],
          ),
        );
        // Unknown numbers get no reply and nothing is recorded.
        if (!biz[0]) continue;
        const r = await recordFromMessage(biz[0].id, String(m.text?.body ?? "")).catch((e) => ({
          reply: e instanceof Error ? e.message : "Could not record that.",
          recorded: null,
          action: "not_understood" as const,
        }));
        await sendText(phone, r.reply).catch(() => null);
      }
      void runDue({ kinds: ["cash_risk.evaluate", "findings.evaluate"], max: 2 }).catch(() => {});
      return NextResponse.json({ ok: true });
    },
  ],

  // daily briefing
  [
    "GET",
    "briefing",
    api(async (c) => {
      const r = await c.db((q) =>
        q.query<any>(
          "select local_date::text, content, created_at from briefings where business_id=$1 order by local_date desc limit 1",
          [c.biz.id],
        ),
      );
      return { stored: r[0] ?? null, live: await buildBriefing(c.biz.id) };
    }),
  ],

  // true profit
  [
    "GET",
    "profit",
    api(async (c) => {
      const qy = c.query(z.object({ period: z.enum(["week", "month", "quarter", "year"]).default("month") }));
      const snap = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const info = periodInfo(qy.period as PeriodKind, snap.today);
      const [orders, lines, products, biz] = await c.db(
        async (q) =>
          [
            await q.query<OrderRow>(
              "select id,local_date::text,currency,cancelled_at,is_test,total,tax,shipping,discounts,refunded from orders where business_id=$1 and local_date between $2 and $3",
              [c.biz.id, info.current.from, info.current.to],
            ),
            await q.query<LineRow>(
              "select l.order_id,l.variant_external_id,l.title,l.sku,l.quantity,l.current_quantity,l.discounted_total,l.unit_cost from order_lines l join orders o on o.id=l.order_id where l.business_id=$1 and o.local_date between $2 and $3",
              [c.biz.id, info.current.from, info.current.to],
            ),
            await q.query<ProductCost>("select external_id,name,unit_cost from products where business_id=$1", [
              c.biz.id,
            ]),
            (await q.query<any>("select settings from businesses where id=$1", [c.biz.id]))[0],
            await q.query<{ n: number }>("select count(*)::int n from orders where business_id=$1", [c.biz.id]),
          ] as const,
      );
      const a = biz.settings?.costAssumptions ?? {};
      const report = profitReport({
        range: info.current,
        currency: snap.currency,
        txns: snap.txns,
        cats: snap.cats,
        orders,
        lines,
        products,
        ads: snap.ads,
        assumptions: a,
      });
      return {
        period: info,
        report,
        assumptions: a,
        productsWithoutCost: snap.productsWithoutCost,
        productCount: snap.productCount,
      };
    }),
  ],
  [
    "PATCH",
    "profit/assumptions",
    api(async (c) => {
      c.requireAdmin();
      const n = z.number().int().min(0).max(9e15).nullable().optional();
      const b = await c.body(
        z.object({
          paymentFeeBps: z.number().int().min(0).max(5000).nullable().optional(),
          paymentFeeFixed: n,
          packagingPerOrder: n,
          shippingPerOrder: n,
        }),
      );
      await c.db((q) =>
        q.query(
          "update businesses set settings = jsonb_set(settings, '{costAssumptions}', coalesce(settings->'costAssumptions','{}'::jsonb) || $2::text::jsonb) where id=$1",
          [c.biz.id, JSON.stringify(b)],
        ),
      );
      return { ok: true };
    }),
  ],

  // money calendar
  [
    "GET",
    "calendar",
    api(async (c) => {
      const qy = c.query(
        z.object({
          month: z
            .string()
            .regex(/^\d{4}-\d{2}$/)
            .optional(),
        }),
      );
      const snap = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const biz = await c.db((q) => q.query<any>("select settings from businesses where id=$1", [c.biz.id]));
      const month = qy.month ?? snap.today.slice(0, 7);
      const from = `${month}-01`;
      const to = endOfMonth(from);
      const horizon = Math.max(1, Math.min(400, Math.round((Date.parse(to) - Date.parse(snap.today)) / 86_400_000)));
      const f = baseForecast(snap, horizon);
      const balanceOn = new Map(f.points.map((p) => [p.date, p.balance]));
      // Future: scheduled movements with projected cash after each day. Past: bills/invoices due this month with their real status.
      const future = f.events
        .filter((e) => e.date >= from && e.date <= to)
        .map((e) => ({ ...e, status: "scheduled", cashAfter: balanceOn.get(e.date) ?? null }));
      const past = snap.invoices
        .filter(
          (i) =>
            i.due_date >= from &&
            i.due_date <= to &&
            (i.due_date <= snap.today || i.status === "void" || i.paid >= i.amount),
        )
        .map((i) => {
          const st = invoiceState(i, snap.today);
          // Paid or partly paid: show what actually moved. Unpaid: the full amount, flagged as not moved (its expected date is in the future list).
          const moved = st === "paid" || i.paid > 0 ? Math.min(i.paid, i.amount) : i.amount;
          return {
            date: i.due_date,
            amount: i.direction === "receivable" ? moved : -moved,
            label: i.description || i.number || "Invoice",
            kind: i.direction === "receivable" ? "receivable" : "payable",
            status:
              st === "void"
                ? "cancelled"
                : st === "paid"
                  ? "paid"
                  : i.paid > 0
                    ? "partially_paid"
                    : st === "overdue"
                      ? "overdue"
                      : "pending",
            outstanding: invoiceOutstanding(i),
            cashAfter: null as number | null,
            refId: i.id,
          };
        });
      return {
        currency: snap.currency,
        today: snap.today,
        month,
        prev: addMonths(from, -1, 1).slice(0, 7),
        next: addMonths(from, 1, 1).slice(0, 7),
        startCash: cashBalance(snap).total,
        reserve: safetyReserveOf(biz[0]?.settings),
        events: [...past, ...future].sort((a, b) => a.date.localeCompare(b.date)),
        lowest: f.minCash,
        lowestDate: f.minCashDate,
        assumptions: f.assumptions,
        horizonEnd: addDays(snap.today, horizon),
      };
    }),
  ],

  // scheduler entry point for serverless hosts (Vercel Cron, etc.)
  ["POST", "cron/tick", apiPublic(async (c) => tick(c.req))],
  ["GET", "cron/tick", apiPublic(async (c) => tick(c.req))],
];

async function tick(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: { code: "not_configured", message: "Set CRON_SECRET to enable the scheduler endpoint." } },
      { status: 503 },
    );
  const auth = req.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${secret}`))
    return NextResponse.json({ error: { code: "unauthorized", message: "Bad cron secret." } }, { status: 401 });
  const scheduled = await scheduleTick();
  const ran = await runDue({ max: 50 });
  return { scheduled, ran };
}

export { executeAction, isoDate };
