import "server-only";
import { z } from "zod";
import { NextResponse } from "next/server";
import { addDays, addMonths, startOfMonth } from "@/lib/finance/dates";
import { essentialMonthly, runway, summarize } from "@/lib/finance/engine";
import {
  depreciate,
  DEFAULT_MULTIPLES,
  estimateValuation,
  monthStatement,
  netAssetsOf,
  readiness,
  verdict,
  type Asset,
} from "@/lib/finance/health";
import { baseForecast, cashBalance, goalProgress, monthlyBaseline } from "@/lib/finance/planning";
import {
  generateTodos,
  requirementByKey,
  supportedCountry,
  VAT_THRESHOLD_EGP,
  REVIEWED_ON,
} from "@/lib/compliance/egypt";
import { currencyDigits } from "@/lib/finance/money";
import { asService, type Q } from "../db";
import { api, ApiError, badRequest, isoDate, notFound, params, uuid } from "../http";
import { buildFacts } from "../boardroom/facts";
import { AGENTS } from "../boardroom/agents";
import { claude, llmConfigured, LlmUnavailable } from "../boardroom/llm";
import { runBoardroom, type BoardEvent, type Decision, type TranscriptItem } from "../boardroom/engine";
import { loadSnapshot } from "../workspace";
import type { Route } from "./types";

async function loadAssets(q: Q, bizId: string): Promise<Asset[]> {
  return q.query<Asset>(
    "select id,name,cost,purchase_date,useful_life_months,salvage_value,fair_value,disposed_on from assets where business_id=$1 order by purchase_date",
    [bizId],
  );
}

async function syncComplianceTodos(
  bizId: string,
  snapshot: Awaited<ReturnType<typeof loadSnapshot>>,
  biz: { country: string; type: string; channels: string[]; settings: any },
) {
  if (!supportedCountry(biz.country)) return { supported: false as const, reasons: {} as Record<string, string> };
  const digits = currencyDigits(snapshot.currency);
  const trailing = snapshot.txns
    .filter((t) => t.type === "income" && t.currency === snapshot.currency && t.date > addDays(snapshot.today, -365))
    .reduce((a, t) => a + t.amount, 0);
  const refunds = snapshot.txns
    .filter((t) => t.type === "refund" && t.currency === snapshot.currency && t.date > addDays(snapshot.today, -365))
    .reduce((a, t) => a + t.amount, 0);
  const hasEmployees =
    snapshot.recurring.some((r) => r.active && r.kind === "salary") ||
    snapshot.txns.some(
      (t) =>
        t.type === "expense" &&
        t.date > addDays(snapshot.today, -90) &&
        snapshot.cats.find((c) => c.id === t.category_id)?.name === "Salaries",
    );
  const vat = biz.settings?.vatRegistered;
  const { items, reasons } = generateTodos(
    {
      country: biz.country,
      businessType: biz.type,
      channels: biz.channels,
      hasEmployees,
      trailingRevenue12m: Math.max(0, trailing - refunds),
      vatRegistered: vat === true ? true : vat === false ? false : null,
      vatThresholdMinor: VAT_THRESHOLD_EGP * 10 ** digits,
    },
    snapshot.today,
  );
  await asService(async (q) => {
    for (const it of items) {
      await q.query(
        `insert into todos(business_id,source,catalog_key,period,title,detail,due_date) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (business_id, catalog_key, period) where catalog_key is not null do nothing`,
        [
          bizId,
          it.catalog_key.startsWith("sys.") ? "system" : "compliance",
          it.catalog_key,
          it.period,
          it.title,
          it.detail,
          it.due_date,
        ],
      );
    }
    // Items that no longer apply (e.g. VAT answered "no") and were never touched are removed.
    const keep = items.map((i) => `${i.catalog_key}|${i.period}`);
    const stale = await q.query<{ id: string; catalog_key: string; period: string }>(
      "select id,catalog_key,period from todos where business_id=$1 and catalog_key is not null and status='todo' and actual_cost is null and notes is null",
      [bizId],
    );
    for (const s of stale)
      if (!keep.includes(`${s.catalog_key}|${s.period}`)) await q.query("delete from todos where id=$1", [s.id]);
  });
  return { supported: true as const, reasons };
}

const zValuationInputs = z.object({
  earningsLow: z.number().min(0).max(30),
  earningsHigh: z.number().min(0).max(30),
  revenueLow: z.number().min(0).max(10),
  revenueHigh: z.number().min(0).max(10),
});

export const healthRoutes: Route[] = [
  // company health
  [
    "GET",
    "company-health",
    api(async (c) => {
      const { month } = c.query(
        z.object({
          month: z
            .string()
            .regex(/^\d{4}-\d{2}$/)
            .optional(),
        }),
      );
      const [snap, assets, bizRows] = await c.db(
        async (q) =>
          [
            await loadSnapshot(q, c.biz.id, c.biz.currency),
            await loadAssets(q, c.biz.id),
            await q.query<any>(
              "select business_type,country,channels,settings,stage,name from businesses where id=$1",
              [c.biz.id],
            ),
          ] as const,
      );
      const b = bizRows[0];
      const compl = await syncComplianceTodos(c.biz.id, snap, {
        country: b.country,
        type: b.business_type,
        channels: b.channels,
        settings: b.settings,
      });
      const todos = await c.db((q) =>
        q.query<any>(
          "select id,source,catalog_key,period,title,detail,due_date,status,actual_cost,notes,session_id,created_at,completed_at from todos where business_id=$1 and (status='todo' or completed_at > now() - interval '45 days') order by (status='todo') desc, due_date nulls last, created_at desc limit 80",
          [c.biz.id],
        ),
      );
      const open = todos.filter((t: any) => t.status === "todo");
      const required = (t: any) =>
        !!t.catalog_key && !t.catalog_key.startsWith("sys.") && requirementByKey(t.catalog_key)?.kind === "required";
      const requiredAll = await c.db((q) =>
        q.query<{ catalog_key: string; status: string; period: string }>(
          "select catalog_key,status,period from todos where business_id=$1 and catalog_key is not null and (period='once' or period=$2 or period=$3)",
          [c.biz.id, snap.today.slice(0, 7), snap.today.slice(0, 4)],
        ),
      );
      // Items that only apply "if you are VAT-registered" are not counted until the owner has answered.
      const reqItems = requiredAll.filter(
        (t) =>
          requirementByKey(t.catalog_key)?.kind === "required" &&
          !String(compl.reasons[t.catalog_key] ?? "").startsWith("Applies if"),
      );
      const requiredDone = reqItems.filter((t) => t.status === "done").length;

      const settings = b.settings ?? {};
      const mult = settings.valuation
        ? {
            earningsMultiple: [settings.valuation.earningsLow, settings.valuation.earningsHigh] as [number, number],
            revenueMultiple: [settings.valuation.revenueLow, settings.valuation.revenueHigh] as [number, number],
          }
        : DEFAULT_MULTIPLES;
      const val = estimateValuation(snap, assets, mult);
      const m = month ?? snap.today.slice(0, 7);
      const prevMonth = addMonths(`${m}-01`, -1, 1).slice(0, 7);
      const statement = monthStatement(snap, assets, m);
      const prevStatement = monthStatement(snap, assets, prevMonth);
      const ready = readiness(snap, { requiredDone, requiredTotal: reqItems.length });
      const f = baseForecast(snap, 90, { includeTypical: true });
      const base = monthlyBaseline(snap);
      const cash = cashBalance(snap).total;
      const three = summarize(snap.txns, snap.cats, snap.currency, { from: addDays(snap.today, -89), to: snap.today });
      const v = verdict({
        readiness: ready.score,
        shortfall: !!f.firstShortfallDate,
        profitable: three.netProfit > 0,
        hasData: snap.txns.length > 0,
      });
      const net = netAssetsOf(snap, assets);

      // Keep a monthly valuation history (one row per month).
      if (val.mid > 0 || val.high > 0) {
        await asService((q) =>
          q.query(
            `insert into valuation_snapshots(business_id,period,low,mid,high,basis) values ($1,$2,$3,$4,$5,$6::text::jsonb)
           on conflict (business_id,period) do update set low=excluded.low, mid=excluded.mid, high=excluded.high, basis=excluded.basis`,
            [
              c.biz.id,
              snap.today.slice(0, 7),
              val.low,
              val.mid,
              val.high,
              JSON.stringify({ confidence: val.confidence, months: val.windowMonths }),
            ],
          ),
        );
      }
      const history = await c.db((q) =>
        q.query<any>(
          "select period,low,mid,high from valuation_snapshots where business_id=$1 order by period desc limit 12",
          [c.biz.id],
        ),
      );

      // The three things that matter most this month, chosen from real signals.
      const priorities: { title: string; why: string; href: string }[] = [];
      if (f.firstShortfallDate)
        priorities.push({
          title: `Cover the cash gap before ${f.firstShortfallDate}`,
          why: `Scheduled payments take cash to ${f.minCash < 0 ? "below zero" : "its lowest point"}.`,
          href: "/app/cash-flow",
        });
      for (const c2 of ready.checks
        .filter((x) => !x.ok)
        .sort((a, z) => z.weight - a.weight)
        .slice(0, 3))
        priorities.push({ title: c2.label, why: c2.detail, href: c2.fixHref });
      const due = open
        .filter((t: any) => t.due_date)
        .sort((a: any, z: any) => String(a.due_date).localeCompare(String(z.due_date)))[0];
      if (due) priorities.push({ title: due.title, why: `Due ${due.due_date}.`, href: "#todo" });

      return {
        currency: snap.currency,
        today: snap.today,
        month: m,
        hasData: snap.txns.length > 0,
        verdict: v,
        score: ready.score,
        readiness: ready.checks,
        valuation: {
          ...val,
          history: history.reverse(),
          editable: {
            earningsLow: mult.earningsMultiple[0],
            earningsHigh: mult.earningsMultiple[1],
            revenueLow: mult.revenueMultiple[0],
            revenueHigh: mult.revenueMultiple[1],
          },
        },
        statements: { current: statement, previous: prevStatement, position: { ...net, equity: net.total } },
        outlook: {
          cash,
          days: f.days,
          endCash: f.endCash,
          minCash: f.minCash,
          minCashDate: f.minCashDate,
          firstShortfallDate: f.firstShortfallDate,
          points: f.points
            .filter((_, i) => i % 3 === 0 || i === f.points.length - 1)
            .map((p) => ({ date: p.date, balance: p.balance })),
          nextMonthProfit: base?.netProfit ?? null,
          basisDays: base?.basisDays ?? 0,
          assumptions: f.assumptions,
          runway: runway(cash, snap.txns, snap.cats, snap.currency, snap.today),
        },
        priorities: priorities.slice(0, 3),
        compliance: {
          supported: compl.supported,
          country: b.country,
          reviewedOn: REVIEWED_ON,
          vatRegistered: settings.vatRegistered ?? null,
          reasons: compl.reasons,
        },
        todos: todos.map((t: any) => {
          const r = t.catalog_key ? requirementByKey(t.catalog_key) : undefined;
          return {
            ...t,
            kind: r?.kind ?? "manual",
            req: r
              ? {
                  authority: r.authority,
                  titleAr: r.titleAr,
                  why: r.why,
                  steps: r.steps,
                  documents: r.documents,
                  feeNote: r.feeNote,
                  source: r.source,
                  confidence: r.confidence,
                  caveat: r.caveat ?? null,
                  planningDefault: r.due.planningDefault,
                }
              : null,
            reason: compl.reasons[t.catalog_key] ?? null,
          };
        }),
        assets: assets.map((a) => depreciate(a, snap.today)),
        essentialMonthly: essentialMonthly(snap.txns, snap.cats, snap.recurring, snap.currency, snap.today),
        requiredDone,
        requiredTotal: reqItems.length,
      };
    }),
  ],

  [
    "PATCH",
    "company-health/valuation",
    api(async (c) => {
      c.requireAdmin();
      const b = await c.body(zValuationInputs);
      if (b.earningsLow > b.earningsHigh || b.revenueLow > b.revenueHigh)
        throw badRequest("The low multiple must not exceed the high one.");
      await c.db((q) =>
        q.query("update businesses set settings = settings || $2::text::jsonb where id=$1", [
          c.biz.id,
          JSON.stringify({ valuation: b }),
        ]),
      );
      return { ok: true };
    }),
  ],

  // to-dos
  [
    "POST",
    "todos",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          title: z.string().trim().min(1).max(200),
          detail: z.string().max(1000).optional(),
          due_date: isoDate.nullable().optional(),
        }),
      );
      const r = await c.db((q) =>
        q.query<{ id: string }>(
          "insert into todos(business_id,source,title,detail,due_date) values ($1,'manual',$2,$3,$4) returning id",
          [c.biz.id, b.title, b.detail ?? null, b.due_date ?? null],
        ),
      );
      return { id: r[0].id };
    }),
  ],
  [
    "PATCH",
    "todos/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({
          status: z.enum(["todo", "done", "skipped"]).optional(),
          actual_cost: z.number().int().min(0).nullable().optional(),
          notes: z.string().max(1000).nullable().optional(),
          due_date: isoDate.nullable().optional(),
        }),
      );
      const r = await c.db((q) =>
        q.query(
          `update todos set status=coalesce($3,status), completed_at = case when $3 in ('done','skipped') then now() when $3 = 'todo' then null else completed_at end,
           actual_cost = case when $4=1 then $5::bigint else actual_cost end, notes = case when $6=1 then $7 else notes end, due_date = case when $8=1 then $9::date else due_date end
         where id=$1 and business_id=$2 returning id`,
          [
            id,
            c.biz.id,
            b.status ?? null,
            "actual_cost" in b ? 1 : 0,
            b.actual_cost ?? null,
            "notes" in b ? 1 : 0,
            b.notes ?? null,
            "due_date" in b ? 1 : 0,
            b.due_date ?? null,
          ],
        ),
      );
      if (!r[0]) throw notFound("To-do");
      return { ok: true };
    }),
  ],
  [
    "DELETE",
    "todos/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db((q) => q.query("delete from todos where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],

  // assets
  [
    "POST",
    "assets",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1).max(120),
          cost: z.number().int().positive(),
          purchase_date: isoDate,
          useful_life_months: z.number().int().min(1).max(600),
          salvage_value: z.number().int().min(0).default(0),
          fair_value: z.number().int().min(0).nullable().optional(),
        }),
      );
      if (b.salvage_value > b.cost)
        throw badRequest("Salvage value cannot exceed cost.", { salvage_value: "More than the cost" });
      const r = await c.db((q) =>
        q.query<{ id: string }>(
          "insert into assets(business_id,name,cost,purchase_date,useful_life_months,salvage_value,fair_value) values ($1,$2,$3,$4,$5,$6,$7) returning id",
          [c.biz.id, b.name, b.cost, b.purchase_date, b.useful_life_months, b.salvage_value, b.fair_value ?? null],
        ),
      );
      return { id: r[0].id };
    }),
  ],
  [
    "PATCH",
    "assets/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({
          fair_value: z.number().int().min(0).nullable().optional(),
          disposed_on: isoDate.nullable().optional(),
        }),
      );
      await c.db((q) =>
        q.query(
          "update assets set fair_value = case when $3=1 then $4::bigint else fair_value end, disposed_on = case when $5=1 then $6::date else disposed_on end where id=$1 and business_id=$2",
          [
            id,
            c.biz.id,
            "fair_value" in b ? 1 : 0,
            b.fair_value ?? null,
            "disposed_on" in b ? 1 : 0,
            b.disposed_on ?? null,
          ],
        ),
      );
      return { ok: true };
    }),
  ],
  [
    "DELETE",
    "assets/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db((q) => q.query("delete from assets where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],

  // investments (tracking only; Socio never places or recommends trades)
  [
    "GET",
    "investments",
    api(async (c) => {
      const snap = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const rows = await c.db((q) =>
        q.query<any>(
          `select i.id,i.name,i.kind,i.invested,i.started_on,i.closed_on,i.note,
           (select value from investment_marks m where m.investment_id=i.id order by marked_on desc, created_at desc limit 1) as current_value,
           (select marked_on from investment_marks m where m.investment_id=i.id order by marked_on desc, created_at desc limit 1) as marked_on
         from investments i where i.business_id=$1 order by i.started_on desc`,
          [c.biz.id],
        ),
      );
      const cash = cashBalance(snap).total;
      const f = baseForecast(snap, 60);
      const reserve = snap.goals.find((g) => g.type === "reserve");
      const reserveTarget = reserve
        ? goalProgress(reserve, snap).target
        : essentialMonthly(snap.txns, snap.cats, snap.recurring, snap.currency, snap.today) * 3;
      const safe = Math.max(0, Math.min(cash, f.minCash) - reserveTarget);
      const items = rows.map((r: any) => {
        const current = r.current_value === null ? Number(r.invested) : Number(r.current_value);
        const days = Math.max(1, (Date.parse(r.closed_on ?? snap.today) - Date.parse(r.started_on)) / 86400000);
        const ret = (current - Number(r.invested)) / Number(r.invested);
        const annualised = days >= 90 ? Math.pow(1 + ret, 365 / days) - 1 : null;
        return {
          ...r,
          invested: Number(r.invested),
          current,
          gain: current - Number(r.invested),
          returnPct: ret,
          annualisedPct: annualised,
          days: Math.round(days),
          marked: r.current_value !== null,
        };
      });
      return {
        currency: snap.currency,
        items,
        totals: {
          invested: items.reduce((a: number, i: any) => a + i.invested, 0),
          current: items.reduce((a: number, i: any) => a + i.current, 0),
        },
        safeToInvest: {
          amount: safe,
          cash,
          lowestCash60d: f.minCash,
          bufferHeld: reserveTarget,
          bufferBasis: reserve ? "your reserve goal" : "3 months of essential expenses (default)",
          firstShortfall: f.firstShortfallDate,
        },
      };
    }),
  ],
  [
    "POST",
    "investments",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1).max(120),
          kind: z.enum([
            "savings",
            "deposit",
            "certificate",
            "gold",
            "stocks",
            "fund",
            "real_estate",
            "business",
            "other",
          ]),
          invested: z.number().int().positive(),
          started_on: isoDate,
          note: z.string().max(500).optional(),
        }),
      );
      const r = await c.db((q) =>
        q.query<{ id: string }>(
          "insert into investments(business_id,name,kind,invested,started_on,note) values ($1,$2,$3,$4,$5,$6) returning id",
          [c.biz.id, b.name, b.kind, b.invested, b.started_on, b.note ?? null],
        ),
      );
      return { id: r[0].id };
    }),
  ],
  [
    "POST",
    "investments/:id/marks",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(z.object({ value: z.number().int().min(0), marked_on: isoDate }));
      await c.db(async (q) => {
        const ok = await q.query("select 1 from investments where id=$1 and business_id=$2", [id, c.biz.id]);
        if (!ok[0]) throw notFound("Investment");
        await q.query("insert into investment_marks(business_id,investment_id,value,marked_on) values ($1,$2,$3,$4)", [
          c.biz.id,
          id,
          b.value,
          b.marked_on,
        ]);
      });
      return { ok: true };
    }),
  ],
  [
    "PATCH",
    "investments/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(z.object({ closed_on: isoDate.nullable() }));
      await c.db((q) =>
        q.query("update investments set closed_on=$3 where id=$1 and business_id=$2", [id, c.biz.id, b.closed_on]),
      );
      return { ok: true };
    }),
  ],
  [
    "DELETE",
    "investments/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db((q) => q.query("delete from investments where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],

  // boardroom
  [
    "GET",
    "boardroom/status",
    api(async () => ({
      configured: llmConfigured(),
      model: process.env.BOARDROOM_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      agents: Object.values(AGENTS).map((a) => ({
        key: a.key,
        name: a.name,
        title: a.title,
        color: a.color,
        lane: a.lane,
      })),
    })),
  ],
  [
    "GET",
    "boardroom/sessions",
    api(async (c) => ({
      items: await c.db((q) =>
        q.query(
          "select id,topic,status,decision->>'decision' as decision,created_at from boardroom_sessions where business_id=$1 order by created_at desc limit 30",
          [c.biz.id],
        ),
      ),
    })),
  ],
  [
    "POST",
    "boardroom/sessions",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(z.object({ topic: z.string().trim().min(3, "Ask the board a question").max(600) }));
      const r = await c.db((q) =>
        q.query<{ id: string }>(
          "insert into boardroom_sessions(business_id,topic,created_by) values ($1,$2,$3) returning id",
          [c.biz.id, b.topic, c.user.id],
        ),
      );
      return { id: r[0].id };
    }),
  ],
  [
    "GET",
    "boardroom/sessions/:id",
    api(async (c) => {
      const { id } = params<{ id: string }>(c);
      const s = await c.db((q) =>
        q.query<any>(
          "select id,topic,status,decision,error,created_at from boardroom_sessions where id=$1 and business_id=$2",
          [id, c.biz.id],
        ),
      );
      if (!s[0]) throw notFound("Session");
      const msgs = await c.db((q) =>
        q.query(
          "select seq,agent,kind,stance,content,meta,created_at from boardroom_messages where session_id=$1 and business_id=$2 order by seq",
          [id, c.biz.id],
        ),
      );
      return { session: s[0], messages: msgs };
    }),
  ],
  [
    "DELETE",
    "boardroom/sessions/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db((q) => q.query("delete from boardroom_sessions where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],
  [
    "POST",
    "boardroom/sessions/:id/todos",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const s = await c.db((q) =>
        q.query<any>("select decision from boardroom_sessions where id=$1 and business_id=$2", [id, c.biz.id]),
      );
      const d = s[0]?.decision as Decision | null;
      if (!d) throw new ApiError(409, "no_decision", "This meeting has no decision yet.");
      const today = new Date().toISOString().slice(0, 10);
      let n = 0;
      await c.db(async (q) => {
        for (const st of d.nextSteps) {
          const exists = await q.query("select 1 from todos where business_id=$1 and session_id=$2 and title=$3", [
            c.biz.id,
            id,
            st.title,
          ]);
          if (exists[0]) continue;
          await q.query(
            "insert into todos(business_id,source,title,detail,due_date,session_id) values ($1,'boardroom',$2,$3,$4,$5)",
            [c.biz.id, st.title, `Board decision: ${d.decision}`, addDays(today, st.inDays), id],
          );
          n++;
        }
      });
      return { created: n };
    }),
  ],

  // Streams the meeting as server-sent events. Messages and the decision are persisted as they happen.
  [
    "POST",
    "boardroom/sessions/:id/run",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(z.object({ message: z.string().trim().max(600).optional() }).default({}));
      if (!llmConfigured())
        throw new ApiError(
          503,
          "not_configured",
          "The boardroom needs an AI provider. Set ANTHROPIC_API_KEY on the server.",
        );
      const sess = await c.db((q) =>
        q.query<any>("select id,topic,status,created_at from boardroom_sessions where id=$1 and business_id=$2", [
          id,
          c.biz.id,
        ]),
      );
      if (!sess[0]) throw notFound("Session");
      if (sess[0].status === "running" && Date.now() - new Date(sess[0].created_at).getTime() < 5 * 60_000) {
        const last = await c.db((q) =>
          q.query<{ n: number }>(
            "select count(*)::int n from boardroom_messages where session_id=$1 and created_at > now() - interval '3 minutes'",
            [id],
          ),
        );
        if (last[0].n > 0) throw new ApiError(409, "running", "This meeting is already in progress.");
      }
      const [snap, assets, bizRows, prior, todoRows] = await c.db(
        async (q) =>
          [
            await loadSnapshot(q, c.biz.id, c.biz.currency),
            await loadAssets(q, c.biz.id),
            await q.query<any>("select name,business_type,country,channels,stage from businesses where id=$1", [
              c.biz.id,
            ]),
            await q.query<any>(
              "select seq,agent,kind,stance,content from boardroom_messages where session_id=$1 and business_id=$2 order by seq",
              [id, c.biz.id],
            ),
            await q.query<any>(
              "select catalog_key,status,due_date from todos where business_id=$1 and catalog_key is not null and (period='once' or period=$2 or period=$3)",
              [c.biz.id, new Date().toISOString().slice(0, 7), new Date().getFullYear().toString()],
            ),
          ] as const,
      );
      const bz = bizRows[0];
      const reqs = todoRows.filter((t: any) => requirementByKey(t.catalog_key)?.kind === "required");
      const facts = buildFacts(
        snap,
        assets,
        { name: bz.name, type: bz.business_type, country: bz.country, stage: bz.stage, channels: bz.channels },
        {
          requiredDone: reqs.filter((t: any) => t.status === "done").length,
          requiredTotal: reqs.length,
          overdue: reqs
            .filter((t: any) => t.status === "todo" && t.due_date && t.due_date < snap.today)
            .map((t: any) => requirementByKey(t.catalog_key)!.title),
        },
      );
      const transcript: TranscriptItem[] = prior
        .filter((m: any) => m.kind !== "system")
        .map((m: any) => ({
          agent: m.kind === "user" ? "you" : m.agent,
          stance: m.stance ?? undefined,
          content: m.content,
        }));
      const topic = b.message ? b.message : sess[0].topic;
      let seq = prior.length;
      const bizId = c.biz.id;
      const enc = new TextEncoder();

      await asService(async (q) => {
        await q.query(
          "update boardroom_sessions set status='running', error=null, facts=$3::text::jsonb where id=$1 and business_id=$2",
          [id, bizId, JSON.stringify(facts)],
        );
        if (b.message || prior.length === 0)
          await q.query(
            "insert into boardroom_messages(business_id,session_id,seq,agent,kind,content) values ($1,$2,$3,'you','user',$4)",
            [bizId, id, ++seq, topic],
          );
      });

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // If the browser went away the meeting still finishes and is saved; only the live stream is skipped.
          const send = (e: BoardEvent | { type: "error"; message: string; code?: string } | { type: "done" }) => {
            try {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            } catch {
              /* client disconnected */
            }
          };
          try {
            const result = await runBoardroom({
              llm: claude,
              topic,
              facts,
              snapshot: snap,
              transcript: b.message || prior.length ? transcript : undefined,
              emit: async (e) => {
                if (e.type === "message") {
                  await asService((q) =>
                    q.query(
                      "insert into boardroom_messages(business_id,session_id,seq,agent,kind,stance,content) values ($1,$2,$3,$4,'message',$5,$6)",
                      [bizId, id, ++seq, e.agent, e.stance, e.content],
                    ),
                  );
                  send({ ...e, seq });
                  return;
                }
                if (e.type === "scenario") {
                  await asService((q) =>
                    q.query(
                      "insert into boardroom_messages(business_id,session_id,seq,agent,kind,content,meta) values ($1,$2,$3,'chair','system',$4,$5::text::jsonb)",
                      [bizId, id, ++seq, `Calculated: ${e.label}`, JSON.stringify({ lines: e.lines })],
                    ),
                  );
                }
                send(e);
              },
            });
            await asService((q) =>
              q.query(
                "update boardroom_sessions set status='decided', decision=$3::text::jsonb where id=$1 and business_id=$2",
                [id, bizId, JSON.stringify(result.decision)],
              ),
            );
            send({ type: "done" });
          } catch (err) {
            const msg = err instanceof LlmUnavailable ? err.message : "The meeting stopped unexpectedly.";
            await asService((q) =>
              q.query("update boardroom_sessions set status='failed', error=$3 where id=$1 and business_id=$2", [
                id,
                bizId,
                msg,
              ]),
            ).catch(() => {});
            send({ type: "error", message: msg, code: err instanceof LlmUnavailable ? err.code : "failed" });
          } finally {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        },
      });
      return new NextResponse(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      });
    }),
  ],
];

export { startOfMonth, uuid };
