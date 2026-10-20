import "server-only";
import { analyzeCashRisk, cashOn } from "@/lib/finance/cashrisk";
import {
  detectAdsBurn,
  detectProductLoss,
  detectTaxSetAside,
  type Finding,
  type TaxSettings,
} from "@/lib/finance/detectors";
import { profitReport, type LineRow, type OrderRow, type ProductCost } from "@/lib/finance/profit";
import { addDays } from "@/lib/finance/dates";
import { summarize } from "@/lib/finance/engine";
import { generateInsights } from "@/lib/finance/insights";
import { formatMoney } from "@/lib/finance/money";
import { baseForecast, cashBalance } from "@/lib/finance/planning";
import { asService } from "../db";
import { auditLog } from "../jobs";
import { loadSnapshot } from "../workspace";
import { proposeAction } from "./actions";
import { paramsHash } from "./policy";
import { deliverBriefing } from "../whatsapp";

async function context(businessId: string) {
  return asService(async (q) => {
    const b = await q.query<{ currency: string; settings: any; timezone: string; name: string }>(
      "select currency, settings, timezone, name from businesses where id=$1",
      [businessId],
    );
    if (!b[0]) throw new Error("Business not found");
    const snap = await loadSnapshot(q, businessId, b[0].currency.trim());
    const integrations = await q.query<{ provider: string; status: string; last_sync_at: string | null }>(
      "select provider,status,last_sync_at::text from integrations where business_id=$1 and status <> 'disconnected'",
      [businessId],
    );
    return {
      biz: b[0],
      snap,
      integrations: integrations.map((i) => ({ provider: i.provider, status: i.status, lastSyncAt: i.last_sync_at })),
    };
  });
}

export function safetyReserveOf(settings: any): number | null {
  const v = settings?.safetyReserve;
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * Cash-risk response workflow:
 * validate data → re-forecast → find breach → diagnose → options with computed impact → recommendation →
 * automatic internal actions (per policy) → approval requests for sensitive ones → prediction for later comparison.
 */
export async function evaluateCashRisk(businessId: string, trigger = "manual") {
  const { biz, snap, integrations } = await context(businessId);
  const fm = (v: number) => formatMoney(v, snap.currency);
  const reserve = safetyReserveOf(biz.settings);
  const a = analyzeCashRisk(snap, { reserve, horizonDays: 60, quality: { integrations } });

  if (!a.atRisk) {
    const resolved = await asService(async (q) => {
      const r = await q.query(
        "update recommendations set status='resolved', resolved_at=now(), updated_at=now() where business_id=$1 and kind='cash_risk' and status='open' returning id",
        [businessId],
      );
      if (r.length)
        await auditLog(q, {
          businessId,
          actorType: "system",
          action: "cash_risk.cleared",
          detail: { trigger, lowest: a.lowest },
        });
      return r.length;
    });
    return { atRisk: false, resolved, lowest: a.lowest, dataQuality: a.dataQuality };
  }

  const severity = a.lowest < 0 ? "critical" : "warning";
  const title =
    a.lowest < 0
      ? `Cash may run out around ${a.breachDate}`
      : `Cash may dip below your safety reserve on ${a.breachDate}`;
  const summary =
    `${a.facts[1] ?? ""} ${a.options[0] ? `The most effective option: ${a.options[0].title.toLowerCase()}${a.options[0].resolves ? ", which would keep you above the line." : "."}` : "No automatic options were found; review your upcoming payments."}`.trim();
  const dedupe = `cash_risk:${a.breachDate}`;

  const rec = await asService(async (q) => {
    // Any older open cash-risk recommendation for a different date is superseded by this one.
    await q.query(
      "update recommendations set status='resolved', resolved_at=now(), updated_at=now() where business_id=$1 and kind='cash_risk' and status='open' and dedupe_key <> $2",
      [businessId, dedupe],
    );
    const r = await q.query<{ id: string; created: boolean }>(
      `insert into recommendations(business_id,kind,severity,title,summary,evidence,options,data_quality,dedupe_key)
       values ($1,'cash_risk',$2,$3,$4,$5::text::jsonb,$6::text::jsonb,$7::text::jsonb,$8)
       on conflict (business_id,dedupe_key) do update set severity=excluded.severity, title=excluded.title, summary=excluded.summary, evidence=excluded.evidence,
         options=excluded.options, data_quality=excluded.data_quality, status='open', resolved_at=null, updated_at=now()
       returning id, (xmax = 0) as created`,
      [
        businessId,
        severity,
        title,
        summary,
        JSON.stringify({
          facts: a.facts,
          hypotheses: a.hypotheses,
          unknowns: a.unknowns,
          contributors: a.contributors,
          collections: a.collections,
          reserve: a.reserve,
          reserveSource: a.reserveSource,
          lowest: a.lowest,
          lowestDate: a.lowestDate,
          breachDate: a.breachDate,
          startCash: a.startCash,
          points: a.points.filter((_, i) => i % 2 === 0),
        }),
        JSON.stringify(a.options),
        JSON.stringify(a.dataQuality),
        dedupe,
      ],
    );
    await auditLog(q, {
      businessId,
      actorType: "system",
      action: "cash_risk.detected",
      target: r[0].id,
      detail: { trigger, breachDate: a.breachDate, lowest: a.lowest, reserve: a.reserve },
    });
    // Record the prediction so it can be compared with what actually happens.
    await q.query(
      `insert into predictions(business_id,recommendation_id,metric,made_on,target_date,predicted,data_quality,note) values ($1,$2,'cash_balance',$3,$4,$5,$6,$7)
       on conflict (business_id,metric,made_on,target_date) do update set predicted=excluded.predicted`,
      [
        businessId,
        r[0].id,
        snap.today,
        a.lowestDate,
        a.lowest,
        String(a.dataQuality.score),
        "Lowest projected cash (scheduled items only), before any action",
      ],
    );
    return r[0];
  });

  // Level 1 (automatic unless paused): an in-app alert and a task for the best option.
  const actions = [];
  actions.push(
    await proposeAction({
      businessId,
      tool: "send_internal_alert",
      origin: "system",
      role: "system",
      recommendationId: rec.id,
      idempotencyKey: `alert:${rec.id}:${a.breachDate}`,
      params: {
        key: `cash_risk:${businessId}`,
        title,
        body: `${a.facts[1] ?? ""} Open the Action Center to see why and what you can do.`,
        href: "/app/actions",
        severity,
      },
    }),
  );
  const top = a.options[0];
  if (top) {
    actions.push(
      await proposeAction({
        businessId,
        tool: "create_task",
        origin: "system",
        role: "system",
        recommendationId: rec.id,
        idempotencyKey: `task:${rec.id}:${top.key}`,
        params: { title: top.title, detail: `${top.description} ${top.assumptions.join(" ")}`, dueInDays: 2 },
      }),
    );
  }
  // Sensitive/external options become approval requests bound to their exact parameters.
  for (const o of a.options) {
    if (o.execution.tool === "manual") continue;
    const r = await proposeAction({
      businessId,
      tool: o.execution.tool,
      params: o.execution.params,
      origin: "system",
      role: "system",
      recommendationId: rec.id,
      idempotencyKey: `opt:${rec.id}:${o.key}:${JSON.stringify(o.execution.params)}`,
      summary: o.title,
    });
    // Reminders without an email provider are not possible: offer a draft instead (internal, automatic).
    if (r.mode === "prohibited" && o.execution.tool === "send_payment_reminder") {
      const inv = snap.invoices.find((i) => i.id === (o.execution as any).params.invoiceId);
      if (inv) {
        actions.push(
          await proposeAction({
            businessId,
            tool: "draft_email",
            origin: "system",
            role: "system",
            recommendationId: rec.id,
            idempotencyKey: `draft:${rec.id}:${inv.id}`,
            params: {
              toName: inv.payee_name ?? "",
              subject: `Payment reminder: ${inv.number ?? inv.description}`,
              body: `Hello ${inv.payee_name ?? ""},\n\nThis is a friendly reminder that ${fm(inv.amount - inv.paid)} for “${inv.description}” was due on ${inv.due_date}.\nIf you have already paid, thank you and please ignore this message.\n\n${biz.name}`,
            },
          }),
        );
      }
    } else actions.push(r);
  }
  return {
    atRisk: true,
    recommendationId: rec.id,
    created: rec.created,
    breachDate: a.breachDate,
    lowest: a.lowest,
    options: a.options.length,
    actions,
  };
}

/* * Compares past predictions with recorded reality once their date has passed. */
export async function measureOutcomes(businessId: string) {
  const { snap } = await context(businessId);
  return asService(async (q) => {
    const due = await q.query<{ id: string; target_date: string; predicted: number }>(
      "select id,target_date::text,predicted from predictions where business_id=$1 and actual is null and target_date <= $2",
      [businessId, snap.today],
    );
    for (const p of due)
      await q.query("update predictions set actual=$2, measured_at=now() where id=$1", [
        p.id,
        cashOn(snap, p.target_date),
      ]);
    return { measured: due.length };
  });
}

export interface Briefing {
  date: string;
  headline: string;
  change: string | null;
  risks: { title: string; href: string }[];
  riskKinds?: string[];
  upcoming: { date: string; label: string; amount: number }[];
  priorities: { title: string; why: string; href: string }[];
  cash: number;
  pendingNonCash: number;
  currency: string;
}

export async function buildBriefing(businessId: string): Promise<Briefing> {
  const { snap } = await context(businessId);
  const fm = (v: number) => formatMoney(v, snap.currency);
  const w = summarize(snap.txns, snap.cats, snap.currency, { from: addDays(snap.today, -6), to: snap.today });
  const pw = summarize(snap.txns, snap.cats, snap.currency, {
    from: addDays(snap.today, -13),
    to: addDays(snap.today, -7),
  });
  let change: string | null = null;
  if (pw.revenue > 0 || w.revenue > 0) {
    const d = w.revenue - pw.revenue;
    change = `Sales in the last 7 days were ${fm(w.revenue)}, ${d === 0 ? "the same as" : d > 0 ? `${fm(d)} more than` : `${fm(-d)} less than`} the week before. What you kept: ${fm(w.netProfit)}${w.incomplete ? " (incomplete: costs missing)" : ""}.`;
  }
  const recs = await asService((q) =>
    q.query<{ title: string; kind: string }>(
      "select title, kind from recommendations where business_id=$1 and status='open' order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, case kind when 'cash_risk' then 0 when 'tax_setaside' then 1 when 'product_loss' then 2 else 3 end, created_at desc limit 3",
      [businessId],
    ),
  );
  const f = baseForecast(snap, 7);
  const upcoming = f.events.slice(0, 6).map((e) => ({ date: e.date, label: e.label, amount: e.amount }));
  const priorities = generateInsights(snap)
    .filter((i) => i.severity !== "positive")
    .slice(0, 3)
    .map((i) => ({ title: i.title, why: i.observed, href: i.action.href }));
  const cash = cashBalance(snap);
  const headline = recs.length
    ? `${recs.length} thing${recs.length > 1 ? "s" : ""} need${recs.length > 1 ? "" : "s"} your attention today.`
    : priorities.length
      ? "Nothing urgent. A few things are worth a look."
      : snap.txns.length
        ? "All clear today."
        : "Add a few records and your briefing will fill in.";
  return {
    date: snap.today,
    headline,
    change,
    risks: recs.map((r) => ({ title: r.title, href: "/app/actions" })),
    riskKinds: recs.map((r) => r.kind),
    upcoming,
    priorities,
    cash: cash.total,
    pendingNonCash: cash.pending,
    currency: snap.currency,
  };
}

export async function createDailyBriefing(businessId: string) {
  const b = await buildBriefing(businessId);
  await asService(async (q) => {
    await q.query(
      "insert into briefings(business_id,local_date,content) values ($1,$2,$3::text::jsonb) on conflict (business_id,local_date) do update set content=excluded.content",
      [businessId, b.date, JSON.stringify(b)],
    );
    await q.query(
      `insert into notifications(business_id,dedupe_key,severity,title,body,href) values ($1,$2,'info',$3,$4,'/app')
       on conflict (business_id,dedupe_key) do nothing`,
      [businessId, `briefing:${b.date}`, "Your daily briefing is ready", b.headline],
    );
  });
  // WhatsApp delivery is best-effort: a failure is recorded, never retried in a loop, and never blocks the briefing.
  const wa = await deliverBriefing(businessId, b).catch((e) => ({
    status: "failed" as const,
    error: e instanceof Error ? e.message : "failed",
  }));
  return { date: b.date, whatsapp: wa.status };
}

/**
 * Business-health workflow: losing products, advertising that does not pay for itself, and money owed to the tax
 * office. Each finding becomes (or updates) one recommendation; the best manual option becomes a task, tax money is
 * reserved automatically (internal, level 1), and warnings raise an in-app alert. Findings that disappear are resolved.
 */
export async function evaluateFindings(businessId: string, trigger = "manual") {
  const { biz, snap } = await context(businessId);
  const range = { from: addDays(snap.today, -29), to: snap.today };
  const [orders, lines, products, taxGoal] = await asService(
    async (q) =>
      [
        await q.query<OrderRow>(
          "select id,local_date::text,currency,cancelled_at,is_test,total,tax,shipping,discounts,refunded from orders where business_id=$1 and local_date between $2 and $3",
          [businessId, range.from, range.to],
        ),
        await q.query<LineRow>(
          "select l.order_id,l.variant_external_id,l.title,l.sku,l.quantity,l.current_quantity,l.discounted_total,l.unit_cost from order_lines l join orders o on o.id=l.order_id where l.business_id=$1 and o.local_date between $2 and $3",
          [businessId, range.from, range.to],
        ),
        await q.query<ProductCost>("select external_id,name,unit_cost from products where business_id=$1", [
          businessId,
        ]),
        await q.query<{ s: string }>(
          "select coalesce(sum(c.amount),0)::text s from goal_contributions c join goals g on g.id=c.goal_id where g.business_id=$1 and g.type='reserve' and g.name='Tax set-aside'",
          [businessId],
        ),
      ] as const,
  );
  const report = profitReport({
    range,
    currency: snap.currency,
    txns: snap.txns,
    cats: snap.cats,
    orders,
    lines,
    products,
    ads: snap.ads,
    assumptions: biz.settings?.costAssumptions ?? {},
  });
  const ladder = (k: string) => report.ladder.find((l) => l.key === k)?.amount ?? 0;
  const findings = [
    detectProductLoss({
      currency: snap.currency,
      products: report.products,
      revenue: ladder("revenue") ?? 0,
      ads: ladder("ads") ?? 0,
      rangeDays: 30,
    }),
    detectAdsBurn(snap),
    detectTaxSetAside(snap, readTaxSettings(biz.settings), safetyReserveOf(biz.settings), Number(taxGoal[0].s)),
  ].filter((f): f is Finding => !!f);

  const kinds: Finding["kind"][] = ["product_loss", "ads_burn", "tax_setaside"];
  const out: { kind: string; recommendationId: string; created: boolean }[] = [];
  for (const f of findings) {
    const rec = await asService(async (q) => {
      await q.query(
        "update recommendations set status='resolved', resolved_at=now(), updated_at=now() where business_id=$1 and kind=$2 and status='open' and dedupe_key <> $3",
        [businessId, f.kind, f.dedupeKey],
      );
      const r = await q.query<{ id: string; created: boolean }>(
        `insert into recommendations(business_id,kind,severity,title,summary,evidence,options,data_quality,dedupe_key)
         values ($1,$2,$3,$4,$5,$6::text::jsonb,$7::text::jsonb,'{}'::jsonb,$8)
         on conflict (business_id,dedupe_key) do update set severity=excluded.severity, title=excluded.title, summary=excluded.summary, evidence=excluded.evidence,
           options=excluded.options, updated_at=now(), status = case when recommendations.status='dismissed' then 'dismissed' else 'open' end,
           resolved_at = case when recommendations.status='dismissed' then recommendations.resolved_at else null end
         returning id, (xmax = 0) as created, status`,
        [
          businessId,
          f.kind,
          f.severity,
          f.title,
          f.summary,
          JSON.stringify({ facts: f.facts, hypotheses: f.hypotheses, unknowns: f.unknowns, metrics: f.metrics }),
          JSON.stringify(f.options),
          f.dedupeKey,
        ],
      );
      if (r[0].created)
        await auditLog(q, {
          businessId,
          actorType: "system",
          action: `${f.kind}.detected`,
          target: r[0].id,
          detail: { trigger, title: f.title },
        });
      return r[0] as { id: string; created: boolean; status?: string };
    });
    out.push({ kind: f.kind, recommendationId: rec.id, created: rec.created });
    if ((rec as any).status === "dismissed") continue;

    // Level 1, automatic unless paused: a task for the best manual option, the tax reserve, and an alert for warnings.
    const top = f.options.find((o) => o.execution.tool === "manual");
    if (top) {
      await proposeAction({
        businessId,
        tool: "create_task",
        origin: "system",
        role: "system",
        recommendationId: rec.id,
        idempotencyKey: `task:${rec.id}:${top.key}`,
        params: { title: top.title, detail: `${top.description} ${top.assumptions.join(" ")}`.trim(), dueInDays: 3 },
      });
    }
    for (const o of f.options) {
      if (o.execution.tool !== "create_tax_reserve") continue;
      await proposeAction({
        businessId,
        tool: "create_tax_reserve",
        origin: "system",
        role: "system",
        recommendationId: rec.id,
        idempotencyKey: `taxres:${rec.id}:${snap.today}`,
        params: o.execution.params,
        summary: o.title,
      });
    }
    if (f.severity !== "info") {
      await proposeAction({
        businessId,
        tool: "send_internal_alert",
        origin: "system",
        role: "system",
        recommendationId: rec.id,
        idempotencyKey: `alert:${rec.id}`,
        params: {
          key: `${f.kind}:${businessId}`,
          title: f.title,
          body: f.summary.slice(0, 900),
          href: "/app/actions",
          severity: f.severity,
        },
      });
    }
  }
  // Anything no longer detected is resolved.
  const live = new Set(findings.map((f) => f.kind));
  await asService(async (q) => {
    for (const k of kinds)
      if (!live.has(k))
        await q.query(
          "update recommendations set status='resolved', resolved_at=now(), updated_at=now() where business_id=$1 and kind=$2 and status='open'",
          [businessId, k],
        );
  });
  return { findings: out };
}

export function readTaxSettings(settings: any): TaxSettings {
  const t = settings?.tax ?? {};
  return {
    vatRegistered: settings?.vatRegistered === true,
    vatRatePct: typeof t.vatRatePct === "number" ? t.vatRatePct : 14,
    pricesIncludeVat: t.pricesIncludeVat !== false,
    incomeTaxReservePct: typeof t.incomeTaxReservePct === "number" ? t.incomeTaxReservePct : null,
  };
}

/**
 * Demo workspace only: a short, clearly labelled track record so the trust ladder and "forecast vs reality" have
 * something to show. Actual values come from the demo ledger; predictions are set a few percent off them.
 */
export async function seedDemoHistory(businessId: string) {
  const { snap } = await context(businessId);
  // The demo story needs a real (small) dip below the safety reserve whatever day it is created: set the reserve a
  // little above the lowest projected cash, rounded to 10,000.
  // It also stays below today's cash, so the dip is in the future and there is still time to act on it.
  const risk = analyzeCashRisk(snap, { reserve: 0, horizonDays: 60, quality: { integrations: [] } });
  const reserve = Math.min(
    Math.ceil((risk.lowest * 1.06) / 1_000_000) * 1_000_000,
    Math.floor(risk.startCash / 1_000_000) * 1_000_000,
  );
  await asService((q) =>
    q.query("update businesses set settings = settings || $2::text::jsonb where id=$1", [
      businessId,
      JSON.stringify({ safetyReserve: reserve }),
    ]),
  );

  const errs = [0.04, -0.03, 0.05, -0.02];
  await asService(async (q) => {
    for (let k = 0; k < errs.length; k++) {
      const target = addDays(snap.today, -7 * (k + 1));
      const actual = cashOn(snap, target);
      await q.query(
        `insert into predictions(business_id,metric,made_on,target_date,predicted,actual,measured_at,data_quality,note) values ($1,'cash_balance',$2,$3,$4,$5,now(),'96','Demo history: lowest-cash forecast made 30 days earlier')
         on conflict (business_id,metric,made_on,target_date) do nothing`,
        [businessId, addDays(target, -30), target, Math.round(actual * (1 + errs[k])), actual],
      );
    }
    const past = [
      {
        tool: "reschedule_payable",
        risk: 3,
        summary: "Demo history: moved the packaging bill by 2 weeks after the supplier agreed",
        params: { invoiceId: "00000000-0000-4000-8000-000000000001", newDueDate: addDays(snap.today, -20) },
      },
      {
        tool: "send_payment_reminder",
        risk: 2,
        summary: "Demo history: reminded Boutique Alex about an overdue invoice",
        params: { invoiceId: "00000000-0000-4000-8000-000000000002" },
      },
      {
        tool: "share_lender_pack",
        risk: 3,
        summary: "Demo history: shared a financing file with the bank (link expired)",
        params: {
          recipient: "Bank SME desk",
          amount: 5_000_000,
          purpose: "Eid stock",
          offerId: null,
          expiresInDays: 7,
        },
      },
    ];
    for (let i = 0; i < past.length; i++) {
      const p = past[i];
      const at = new Date(Date.now() - (40 - i * 9) * 86_400_000).toISOString();
      await q.query(
        `insert into actions(business_id,tool,params,params_hash,risk_level,summary,status,requires_approval,approved_at,approved_hash,executed_at,verification,origin,idempotency_key,created_at)
         values ($1,$2,$3::text::jsonb,$4,$5,$6,'succeeded',true,$7,$4,$7,$8::text::jsonb,'system',$9,$7) on conflict (idempotency_key) do nothing`,
        [
          businessId,
          p.tool,
          JSON.stringify(p.params),
          paramsHash(p.tool, p.params),
          p.risk,
          p.summary,
          at,
          JSON.stringify({ ok: true, detail: "Demo history." }),
          `demo-history:${businessId}:${i}`,
        ],
      );
    }
  });
}
