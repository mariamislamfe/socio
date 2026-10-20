import "server-only";
import { asService } from "../db";
import { auditLog, emitEvent, enqueue, redact } from "../jobs";
import { decide, paramsHash, readAutomation, type Mode } from "./policy";
import { getTool } from "./tools";

export interface ProposeArgs {
  businessId: string;
  tool: string;
  params: unknown;
  summary?: string;
  recommendationId?: string | null;
  origin: "system" | "user" | "agent";
  role: "owner" | "admin" | "member" | "viewer" | "system";
  actorId?: string | null;
  idempotencyKey: string;
}

export interface ProposeResult {
  actionId: string | null;
  mode: Mode;
  reason: string;
  status?: string;
  duplicate?: boolean;
}

/* * Validates, applies policy, records the action, and runs it immediately when policy allows. */
export async function proposeAction(a: ProposeArgs): Promise<ProposeResult> {
  const tool = getTool(a.tool);
  if (!tool) return { actionId: null, mode: "prohibited", reason: `Unknown tool ${a.tool}.` };
  const parsed = tool.input.safeParse(a.params);
  if (!parsed.success)
    return {
      actionId: null,
      mode: "prohibited",
      reason: `Invalid parameters: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  const avail = tool.available();
  if (!avail.ok) return { actionId: null, mode: "prohibited", reason: avail.reason ?? "Not available." };

  const ctx = await asService(async (q) => {
    const b = await q.query<{ settings: any; currency: string }>(
      "select settings, currency from businesses where id=$1",
      [a.businessId],
    );
    let bounded: { amount: number; daysSinceLast: number | null } | undefined;
    if (a.tool === "send_payment_reminder") {
      const inv = await q.query<{ owed: number }>(
        "select (i.amount - coalesce((select sum(amount) from invoice_payments p where p.invoice_id=i.id),0))::bigint owed from invoices i where i.id=$1 and i.business_id=$2",
        [(parsed.data as any).invoiceId, a.businessId],
      );
      const last = await q.query<{ d: number | null }>(
        "select (current_date - max(created_at)::date)::int d from actions where business_id=$1 and tool='send_payment_reminder' and status='succeeded' and params->>'invoiceId'=$2",
        [a.businessId, (parsed.data as any).invoiceId],
      );
      bounded = { amount: Number(inv[0]?.owed ?? Number.MAX_SAFE_INTEGER), daysSinceLast: last[0]?.d ?? null };
    }
    return { automation: readAutomation(b[0]?.settings), currency: (b[0]?.currency ?? "EGP").trim(), bounded };
  });
  const d = decide({
    tool: tool.name,
    risk: tool.risk,
    role: a.role,
    automation: ctx.automation,
    bounded: ctx.bounded,
  });
  if (d.mode === "prohibited") return { actionId: null, mode: d.mode, reason: d.reason };

  const hash = paramsHash(tool.name, parsed.data);
  const inserted = await asService(async (q) => {
    const r = await q.query<{ id: string }>(
      `insert into actions(business_id,recommendation_id,tool,params,params_hash,risk_level,summary,status,requires_approval,origin,idempotency_key)
       values ($1,$2,$3,$4::text::jsonb,$5,$6,$7,$8,$9,$10,$11) on conflict (idempotency_key) do nothing returning id`,
      [
        a.businessId,
        a.recommendationId ?? null,
        tool.name,
        JSON.stringify(parsed.data),
        hash,
        tool.risk,
        a.summary ?? tool.describe(parsed.data, ctx.currency),
        d.mode === "auto" ? "approved" : "awaiting_approval",
        d.mode !== "auto",
        a.origin,
        a.idempotencyKey,
      ],
    );
    if (r[0])
      await auditLog(q, {
        businessId: a.businessId,
        actorType: a.origin === "system" ? "system" : a.origin,
        actorId: a.actorId,
        action: "action.proposed",
        target: r[0].id,
        detail: { tool: tool.name, mode: d.mode, reason: d.reason },
      });
    return r[0]?.id ?? null;
  });
  if (!inserted) {
    const ex = await asService((q) =>
      q.query<{ id: string; status: string }>("select id,status from actions where idempotency_key=$1", [
        a.idempotencyKey,
      ]),
    );
    return { actionId: ex[0]?.id ?? null, mode: d.mode, reason: d.reason, status: ex[0]?.status, duplicate: true };
  }
  if (d.mode === "auto") {
    const res = await executeAction(inserted);
    return { actionId: inserted, mode: d.mode, reason: d.reason, status: res.status };
  }
  return { actionId: inserted, mode: d.mode, reason: d.reason, status: "awaiting_approval" };
}

/* * Approval is bound to the exact parameters the user saw (hash). Any mismatch is refused. */
export async function approveAction(a: {
  businessId: string;
  actionId: string;
  userId: string;
  hash: string;
  role: string;
}): Promise<{ ok: boolean; reason?: string }> {
  if (a.role !== "owner" && a.role !== "admin")
    return { ok: false, reason: "Only owners and admins can approve actions." };
  const res = await asService(async (q) => {
    const r = await q.query<any>(
      "select id,tool,params,params_hash,status from actions where id=$1 and business_id=$2 for update",
      [a.actionId, a.businessId],
    );
    const act = r[0];
    if (!act) return { ok: false, reason: "Action not found." };
    if (act.status !== "awaiting_approval")
      return { ok: false, reason: `This action is ${act.status.replace("_", " ")}.` };
    if (paramsHash(act.tool, act.params) !== act.params_hash)
      return { ok: false, reason: "Stored parameters were altered; approval refused." };
    if (a.hash !== act.params_hash)
      return { ok: false, reason: "The details changed since you reviewed them. Review the action again." };
    const auto = readAutomation(
      (await q.query<any>("select settings from businesses where id=$1", [a.businessId]))[0]?.settings,
    );
    void auto;
    await q.query(
      "update actions set status='approved', approved_by=$3, approved_at=now(), approved_hash=$4 where id=$1 and business_id=$2",
      [a.actionId, a.businessId, a.userId, a.hash],
    );
    await auditLog(q, {
      businessId: a.businessId,
      actorType: "user",
      actorId: a.userId,
      action: "action.approved",
      target: a.actionId,
      detail: { tool: act.tool, params: act.params },
    });
    return { ok: true };
  });
  if (res.ok)
    await enqueue({
      businessId: a.businessId,
      kind: "action.execute",
      payload: { actionId: a.actionId },
      idempotencyKey: `exec:${a.actionId}`,
      maxAttempts: 1,
    });
  return res;
}

export async function rejectAction(a: { businessId: string; actionId: string; userId: string }): Promise<boolean> {
  return asService(async (q) => {
    const r = await q.query(
      "update actions set status='rejected' where id=$1 and business_id=$2 and status='awaiting_approval' returning id",
      [a.actionId, a.businessId],
    );
    if (r.length)
      await auditLog(q, {
        businessId: a.businessId,
        actorType: "user",
        actorId: a.userId,
        action: "action.rejected",
        target: a.actionId,
      });
    return r.length > 0;
  });
}

/* * Executes an approved action exactly once, then verifies the outcome independently. */
export async function executeAction(actionId: string): Promise<{ status: string; error?: string }> {
  const act = await asService(async (q) => {
    const r = await q.query<any>(
      "update actions set status='executing', executed_at=now() where id=$1 and status='approved' returning *",
      [actionId],
    );
    return r[0];
  });
  if (!act) {
    const cur = await asService((q) =>
      q.query<{ status: string }>("select status from actions where id=$1", [actionId]),
    );
    return { status: cur[0]?.status ?? "missing" };
  }
  const tool = getTool(act.tool)!;
  // Defence in depth: re-check the binding right before acting.
  if (act.requires_approval && act.approved_hash !== act.params_hash) {
    await asService((q) =>
      q.query(
        "update actions set status='failed', error='Approval does not match the action parameters.' where id=$1",
        [actionId],
      ),
    );
    return { status: "failed", error: "approval mismatch" };
  }
  try {
    const input = tool.input.parse(act.params);
    const result = await Promise.race([
      asService((q) => tool.execute({ businessId: act.business_id, q, actionId }, input)),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Timed out after ${tool.timeoutMs} ms`)), tool.timeoutMs)),
    ]);
    const verification = await asService((q) =>
      tool.verify({ businessId: act.business_id, q, actionId }, input, result),
    );
    await asService(async (q) => {
      await q.query(
        "update actions set status=$2, result=$3::text::jsonb, verification=$4::text::jsonb, error=$5 where id=$1",
        [
          actionId,
          verification.ok ? "succeeded" : "failed",
          JSON.stringify(result ?? null),
          JSON.stringify(verification),
          verification.ok ? null : `Verification failed: ${verification.detail}`,
        ],
      );
      await auditLog(q, {
        businessId: act.business_id,
        actorType: "system",
        action: verification.ok ? "action.succeeded" : "action.verification_failed",
        target: actionId,
        detail: { tool: act.tool, verification },
      });
    });
    if (tool.touchesLedger)
      await emitEvent({
        businessId: act.business_id,
        source: "action",
        type: "ledger.changed",
        entityId: actionId,
        idempotencyKey: `ledger:action:${actionId}`,
      });
    return { status: verification.ok ? "succeeded" : "failed" };
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e));
    await asService(async (q) => {
      await q.query("update actions set status='failed', error=$2 where id=$1", [actionId, msg]);
      await auditLog(q, {
        businessId: act.business_id,
        actorType: "system",
        action: "action.failed",
        target: actionId,
        detail: { tool: act.tool, error: msg },
      });
    });
    return { status: "failed", error: msg };
  }
}
