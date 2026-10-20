import "server-only";
import { z } from "zod";
import { formatMoney } from "@/lib/finance/money";
import type { Q } from "../db";
import { encrypt, randomToken, sha256 } from "../crypto";
import { buildPackFor } from "../financing";
import { createOnMeta, metaContext, setMetaDailyBudget, setMetaStatus } from "../mediabuyer";
import type { Risk } from "./policy";

/*
 * Tool registry: the only way the system acts. Every tool declares its schema, risk, idempotency and how its
 * outcome is verified. Models never get SQL, shell or raw HTTP access - only these tools, with validated input.
 */
export interface ToolCtx {
  businessId: string;
  q: Q; // privileged connection, always scoped by businessId explicitly
  actionId: string;
}

export interface Tool<I = any> {
  name: string;
  label: string;
  risk: Risk;
  input: z.ZodType<I>;
  /* * Mutates financial records (forecasts must be recalculated afterwards). */
  touchesLedger: boolean;
  external: boolean;
  timeoutMs: number;
  available: () => { ok: boolean; reason?: string };
  describe: (input: I, currency: string) => string;
  execute: (ctx: ToolCtx, input: I) => Promise<unknown>;
  /* * Independent check that the effect really happened. */
  verify: (ctx: ToolCtx, input: I, result: any) => Promise<{ ok: boolean; detail: string }>;
}

const uuid = z.string().uuid();
const ok = () => ({ ok: true });

const createTask: Tool<{ title: string; detail?: string; dueInDays?: number }> = {
  name: "create_task",
  label: "Create a task",
  risk: 1,
  touchesLedger: false,
  external: false,
  timeoutMs: 5_000,
  available: ok,
  input: z.object({
    title: z.string().min(1).max(200),
    detail: z.string().max(1000).optional(),
    dueInDays: z.number().int().min(0).max(120).optional(),
  }),
  describe: (i) => `Add “${i.title}” to your to-do list`,
  async execute({ q, businessId, actionId }, i) {
    const r = await q.query<{ id: string }>(
      "insert into todos(business_id,source,title,detail,due_date) values ($1,'system',$2,$3, case when $4::int is null then null else current_date + $4::int end) returning id",
      [
        businessId,
        i.title,
        `${i.detail ?? ""}${i.detail ? "\n" : ""}(Created by Socio, action ${actionId.slice(0, 8)})`,
        i.dueInDays ?? null,
      ],
    );
    return { todoId: r[0].id };
  },
  async verify({ q, businessId }, _i, res) {
    const r = await q.query("select 1 from todos where id=$1 and business_id=$2", [res.todoId, businessId]);
    return r.length
      ? { ok: true, detail: "Task is in the to-do list." }
      : { ok: false, detail: "Task was not found after creation." };
  },
};

const sendAlert: Tool<{
  key: string;
  title: string;
  body: string;
  href?: string;
  severity?: "info" | "warning" | "critical";
}> = {
  name: "send_internal_alert",
  label: "Send an in-app alert",
  risk: 1,
  touchesLedger: false,
  external: false,
  timeoutMs: 5_000,
  available: ok,
  input: z.object({
    key: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(1000),
    href: z.string().max(300).optional(),
    severity: z.enum(["info", "warning", "critical"]).optional(),
  }),
  describe: (i) => `Alert: ${i.title}`,
  async execute({ q, businessId }, i) {
    const r = await q.query<{ id: string }>(
      `insert into notifications(business_id,dedupe_key,severity,title,body,href) values ($1,$2,$3,$4,$5,$6)
       on conflict (business_id,dedupe_key) do update set title=excluded.title, body=excluded.body, severity=excluded.severity, href=excluded.href, resolved_at=null returning id`,
      [businessId, i.key, i.severity ?? "warning", i.title, i.body, i.href ?? "/app/actions"],
    );
    return { notificationId: r[0].id };
  },
  async verify({ q, businessId }, _i, res) {
    const r = await q.query("select 1 from notifications where id=$1 and business_id=$2 and resolved_at is null", [
      res.notificationId,
      businessId,
    ]);
    return r.length
      ? { ok: true, detail: "Alert is visible in notifications." }
      : { ok: false, detail: "Alert not found." };
  },
};

const draftEmail: Tool<{ toName: string; toEmail?: string | null; subject: string; body: string }> = {
  name: "draft_email",
  label: "Draft an email (not sent)",
  risk: 1,
  touchesLedger: false,
  external: false,
  timeoutMs: 5_000,
  available: ok,
  input: z.object({
    toName: z.string().max(120),
    toEmail: z.string().email().nullable().optional(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(4000),
  }),
  describe: (i) => `Draft “${i.subject}” for ${i.toName || "a contact"}`,
  async execute({ q, businessId, actionId }, i) {
    const r = await q.query<{ id: string }>(
      "insert into email_drafts(business_id,to_name,to_email,subject,body,action_id) values ($1,$2,$3,$4,$5,$6) returning id",
      [businessId, i.toName, i.toEmail ?? null, i.subject, i.body, actionId],
    );
    return { draftId: r[0].id };
  },
  async verify({ q, businessId }, _i, res) {
    const r = await q.query("select 1 from email_drafts where id=$1 and business_id=$2", [res.draftId, businessId]);
    return r.length
      ? { ok: true, detail: "Draft saved. Nothing was sent." }
      : { ok: false, detail: "Draft not found." };
  },
};

const emailConfigured = () =>
  process.env.RESEND_API_KEY && process.env.EMAIL_FROM
    ? { ok: true }
    : { ok: false, reason: "No email provider is configured (RESEND_API_KEY and EMAIL_FROM). Use the draft instead." };

async function sendViaResend(to: string, subject: string, text: string): Promise<string> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.id) throw new Error(`Email provider rejected the message (HTTP ${res.status}).`);
  return j.id as string;
}

const reminder: Tool<{ invoiceId: string }> = {
  name: "send_payment_reminder",
  label: "Email a payment reminder",
  risk: 2,
  touchesLedger: false,
  external: true,
  timeoutMs: 15_000,
  available: emailConfigured,
  input: z.object({ invoiceId: uuid }),
  describe: () => "Email the customer a polite reminder about an unpaid invoice",
  async execute({ q, businessId, actionId }, i) {
    const inv = await q.query<any>(
      `select i.*, p.name as payee_name, p.email, b.name as biz, coalesce((select sum(amount) from invoice_payments ip where ip.invoice_id=i.id),0)::bigint paid
       from invoices i join businesses b on b.id=i.business_id left join payees p on p.id=i.payee_id and p.business_id=i.business_id where i.id=$1 and i.business_id=$2 and i.direction='receivable'`,
      [i.invoiceId, businessId],
    );
    const v = inv[0];
    if (!v) throw new Error("Invoice not found in this workspace.");
    if (!v.email) throw new Error("This customer has no email address on file.");
    const owed = Number(v.amount) - Number(v.paid);
    if (owed <= 0) throw new Error("Nothing is outstanding on this invoice.");
    const subject = `Payment reminder: ${v.number ?? v.description}`;
    const body = `Hello ${v.payee_name ?? ""},\n\nThis is a friendly reminder that ${formatMoney(owed, v.currency.trim())} for “${v.description}” was due on ${v.due_date}.\nIf you have already paid, thank you and please ignore this message.\n\n${v.biz}`;
    const id = await sendViaResend(v.email, subject, body);
    await q.query(
      "insert into email_drafts(business_id,to_name,to_email,subject,body,status,provider_message_id,action_id) values ($1,$2,$3,$4,$5,'sent',$6,$7)",
      [businessId, v.payee_name ?? "", v.email, subject, body, id, actionId],
    );
    return { providerMessageId: id, to: v.email };
  },
  async verify(_c, _i, res) {
    // The provider accepted the message; delivery to the inbox cannot be confirmed from here.
    return res?.providerMessageId
      ? { ok: true, detail: `Accepted by the email provider (id ${res.providerMessageId}). Delivery is not confirmed.` }
      : { ok: false, detail: "No provider message id." };
  },
};

const reschedulePayable: Tool<{ invoiceId: string; newDueDate: string }> = {
  name: "reschedule_payable",
  label: "Record a new due date for a bill",
  risk: 3,
  touchesLedger: true,
  external: false,
  timeoutMs: 5_000,
  available: ok,
  input: z.object({ invoiceId: uuid, newDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  describe: (i) => `Change the bill's due date to ${i.newDueDate} (only after the supplier agreed)`,
  async execute({ q, businessId }, i) {
    const r = await q.query<{ due_date: string }>(
      "select due_date::text from invoices where id=$1 and business_id=$2 and direction='payable' and status='open'",
      [i.invoiceId, businessId],
    );
    if (!r[0]) throw new Error("Open bill not found in this workspace.");
    await q.query("update invoices set due_date=$3 where id=$1 and business_id=$2", [
      i.invoiceId,
      businessId,
      i.newDueDate,
    ]);
    return { previousDueDate: r[0].due_date, newDueDate: i.newDueDate };
  },
  async verify({ q, businessId }, i) {
    const r = await q.query<{ due_date: string }>(
      "select due_date::text from invoices where id=$1 and business_id=$2",
      [i.invoiceId, businessId],
    );
    return r[0]?.due_date === i.newDueDate
      ? { ok: true, detail: `Due date is now ${i.newDueDate}; the forecast has been recalculated.` }
      : { ok: false, detail: "Due date did not change." };
  },
};

/* * Internal bookkeeping: marks money as reserved for taxes so it is not treated as spendable. Moves no money. */
const createTaxReserve: Tool<{ amount: number; label: string }> = {
  name: "create_tax_reserve",
  label: "Reserve money for taxes",
  risk: 1,
  touchesLedger: false,
  external: false,
  timeoutMs: 5_000,
  available: ok,
  input: z.object({ amount: z.number().int().min(1).max(9e15), label: z.string().min(1).max(80) }),
  describe: (i, cur) => `Mark ${formatMoney(i.amount, cur)} as reserved for taxes (“${i.label}”)`,
  async execute({ q, businessId }, i) {
    let g = (
      await q.query<{ id: string }>(
        "select id from goals where business_id=$1 and type='reserve' and name=$2 order by created_at limit 1",
        [businessId, i.label],
      )
    )[0];
    if (!g)
      g = (
        await q.query<{ id: string }>(
          "insert into goals(business_id,type,name,target,mode) values ($1,'reserve',$2,$3,'manual') returning id",
          [businessId, i.label, i.amount],
        )
      )[0];
    else await q.query("update goals set target=$3 where id=$1 and business_id=$2", [g.id, businessId, i.amount]);
    const cur = Number(
      (
        await q.query<{ s: string }>(
          "select coalesce(sum(amount),0)::text s from goal_contributions where business_id=$1 and goal_id=$2",
          [businessId, g.id],
        )
      )[0].s,
    );
    const add = i.amount - cur;
    if (add !== 0)
      await q.query(
        "insert into goal_contributions(business_id,goal_id,amount,made_on,note) values ($1,$2,$3,current_date,'Tax set-aside (estimated)')",
        [businessId, g.id, add],
      );
    return { goalId: g.id, added: add };
  },
  async verify({ q, businessId }, i, res) {
    const cur = Number(
      (
        await q.query<{ s: string }>(
          "select coalesce(sum(amount),0)::text s from goal_contributions where business_id=$1 and goal_id=$2",
          [businessId, res.goalId],
        )
      )[0].s,
    );
    return cur === i.amount
      ? { ok: true, detail: `The tax reserve now holds the estimated amount.` }
      : { ok: false, detail: "The reserve does not match the requested amount." };
  },
};

/**
 * Shares a frozen, read-only lender pack through an expiring link. Financial data leaves the business, so this is
 * level 3: always approved by an owner/admin, bound to the exact recipient, amount, purpose and expiry.
 */
const shareLenderPack: Tool<{
  recipient: string;
  amount: number;
  purpose: string;
  offerId?: string | null;
  expiresInDays: number;
}> = {
  name: "share_lender_pack",
  label: "Share a lender-ready file",
  risk: 3,
  touchesLedger: false,
  external: true,
  timeoutMs: 15_000,
  available: ok,
  input: z.object({
    recipient: z.string().min(1).max(120),
    amount: z.number().int().min(1).max(9e15),
    purpose: z.string().min(1).max(300),
    offerId: uuid.nullable().optional(),
    expiresInDays: z.number().int().min(1).max(14),
  }),
  describe: (i, cur) =>
    `Share a read-only financing file with ${i.recipient} for ${formatMoney(i.amount, cur)} (link expires in ${i.expiresInDays} day${i.expiresInDays > 1 ? "s" : ""})`,
  async execute({ q, businessId, actionId }, i) {
    const { pack, fingerprint } = await buildPackFor(q, businessId, {
      amount: i.amount,
      purpose: i.purpose,
      offerId: i.offerId ?? null,
    });
    const token = randomToken(24);
    const r = await q.query<{ id: string; expires_at: string }>(
      `insert into share_links(business_id,token_hash,scope,payload,fingerprint,recipient,expires_at,action_id)
       values ($1,$2,'lender_pack',$3::text::jsonb,$4,$5, now() + ($6::int * interval '1 day'),$7) returning id, expires_at::text`,
      [businessId, sha256(token), JSON.stringify(pack), fingerprint, i.recipient, i.expiresInDays, actionId],
    );
    // Only a hash is stored in share_links; the owner can see the link again through this encrypted copy.
    return { linkId: r[0].id, tokenEnc: encrypt(token), fingerprint, expiresAt: r[0].expires_at };
  },
  async verify({ q, businessId }, _i, res) {
    const r = await q.query<{ payload: unknown; fingerprint: string }>(
      "select payload, fingerprint from share_links where id=$1 and business_id=$2 and revoked_at is null",
      [res.linkId, businessId],
    );
    if (!r[0]) return { ok: false, detail: "Share link not found." };
    return r[0].fingerprint === res.fingerprint
      ? {
          ok: true,
          detail: `Read-only link created; it expires ${String(res.expiresAt).slice(0, 16).replace("T", " ")}. Fingerprint ${res.fingerprint.slice(0, 12)}…`,
        }
      : { ok: false, detail: "Fingerprint mismatch." };
  },
};

// Media buyer (Meta). Spending money is level 3; stopping spend is always allowed.

const metaReady = () =>
  process.env.META_APP_ID && process.env.META_APP_SECRET
    ? { ok: true }
    : { ok: false, reason: "Meta is not configured on this server (META_APP_ID, META_APP_SECRET)." };

async function loadCampaign(q: Q, businessId: string, id: string) {
  const r = await q.query<any>("select * from ad_campaigns where id=$1 and business_id=$2", [id, businessId]);
  if (!r[0]) throw new Error("Campaign not found in this workspace.");
  return r[0];
}

/* * Creates the approved ad on Meta, PAUSED: nothing is spent until a separate approval activates it. */
const createMetaCampaign: Tool<{
  campaignId: string;
  budget: number;
  days: number;
  country: string;
  headline: string;
  primaryText: string;
  link: string;
}> = {
  name: "create_meta_campaign",
  label: "Create the ad on Meta (paused)",
  risk: 3,
  touchesLedger: false,
  external: true,
  timeoutMs: 60_000,
  available: metaReady,
  input: z.object({
    campaignId: uuid,
    budget: z.number().int().min(100).max(9e13),
    days: z.number().int().min(1).max(30),
    country: z.string().length(2),
    headline: z.string().min(1).max(80),
    primaryText: z.string().min(1).max(600),
    link: z.string().url().max(500),
  }),
  describe: (i, cur) =>
    `Create a paused Meta ad: ${formatMoney(i.budget, cur)} over ${i.days} day${i.days > 1 ? "s" : ""} in ${i.country} — “${i.headline}”`,
  async execute({ q, businessId }, i) {
    const c = await loadCampaign(q, businessId, i.campaignId);
    // The approval covers exactly this ad: if anything changed since, refuse.
    if (
      c.brief.budget !== i.budget ||
      c.brief.days !== i.days ||
      c.brief.country !== i.country ||
      c.creative.headline !== i.headline ||
      c.creative.primaryText !== i.primaryText ||
      c.creative.link !== i.link
    )
      throw new Error("The ad changed after it was approved. Review and approve it again.");
    if (c.external?.campaignId) return { ...c.external, already: true };
    const ext = await createOnMeta(q, businessId, { id: c.id, brief: c.brief, plan: c.plan, creative: c.creative });
    await q.query(
      "update ad_campaigns set status='created', external=$3::text::jsonb, error=null, updated_at=now() where id=$1 and business_id=$2",
      [c.id, businessId, JSON.stringify(ext)],
    );
    return ext;
  },
  async verify({ q, businessId }, i) {
    const c = await loadCampaign(q, businessId, i.campaignId);
    return c.external?.adId
      ? {
          ok: true,
          detail: `Created on Meta (campaign ${c.external.campaignId}), paused — nothing is spent until you activate it.`,
        }
      : { ok: false, detail: "No Meta ids were stored." };
  },
};

const activateMetaCampaign: Tool<{ campaignId: string; budget: number; days: number }> = {
  name: "activate_meta_campaign",
  label: "Start the ad (spends money)",
  risk: 3,
  touchesLedger: false,
  external: true,
  timeoutMs: 30_000,
  available: metaReady,
  input: z.object({
    campaignId: uuid,
    budget: z.number().int().min(100).max(9e13),
    days: z.number().int().min(1).max(30),
  }),
  describe: (i, cur) =>
    `Start the ad: spend up to ${formatMoney(i.budget, cur)} over ${i.days} day${i.days > 1 ? "s" : ""}`,
  async execute({ q, businessId }, i) {
    const c = await loadCampaign(q, businessId, i.campaignId);
    if (!c.external?.campaignId) throw new Error("The ad has not been created on Meta yet.");
    if (c.brief.budget !== i.budget || c.brief.days !== i.days)
      throw new Error("The budget changed after approval. Approve again.");
    const status = await setMetaStatus(q, businessId, c.external, "ACTIVE");
    await q.query("update ad_campaigns set status='active', updated_at=now() where id=$1 and business_id=$2", [
      c.id,
      businessId,
    ]);
    return { status };
  },
  async verify(_c, _i, res) {
    return res?.status === "ACTIVE"
      ? { ok: true, detail: "Meta reports the campaign as active." }
      : { ok: false, detail: `Meta reports status ${res?.status ?? "unknown"}.` };
  },
};

/* * Stopping spend only reduces risk, so it may run automatically (unless automation is paused). */
const pauseMetaCampaign: Tool<{ campaignId: string; reason: string }> = {
  name: "pause_meta_campaign",
  label: "Pause an ad (stops spending)",
  risk: 1,
  touchesLedger: false,
  external: true,
  timeoutMs: 30_000,
  available: metaReady,
  input: z.object({ campaignId: uuid, reason: z.string().min(1).max(300) }),
  describe: (i) => `Pause the ad: ${i.reason}`,
  async execute({ q, businessId }, i) {
    const c = await loadCampaign(q, businessId, i.campaignId);
    if (!c.external?.campaignId) throw new Error("This ad is not on Meta.");
    const status = await setMetaStatus(q, businessId, c.external, "PAUSED");
    await q.query("update ad_campaigns set status='paused', updated_at=now() where id=$1 and business_id=$2", [
      c.id,
      businessId,
    ]);
    return { status };
  },
  async verify(_c, _i, res) {
    return res?.status === "PAUSED"
      ? { ok: true, detail: "Meta reports the campaign as paused; spending has stopped." }
      : { ok: false, detail: `Meta reports status ${res?.status ?? "unknown"}.` };
  },
};

const scaleMetaCampaign: Tool<{ campaignId: string; newDailyBudget: number }> = {
  name: "scale_meta_campaign",
  label: "Raise an ad's daily budget",
  risk: 3,
  touchesLedger: false,
  external: true,
  timeoutMs: 30_000,
  available: metaReady,
  input: z.object({ campaignId: uuid, newDailyBudget: z.number().int().min(100).max(9e13) }),
  describe: (i, cur) => `Raise the ad's daily budget to ${formatMoney(i.newDailyBudget, cur)}`,
  async execute({ q, businessId }, i) {
    const c = await loadCampaign(q, businessId, i.campaignId);
    if (!c.external?.adsetId) throw new Error("This ad is not on Meta.");
    if (i.newDailyBudget > (c.plan.dailyBudget ?? 0) * 2)
      throw new Error("A raise above double the original daily budget needs a new plan.");
    const budget = await setMetaDailyBudget(q, businessId, c.external.adsetId, i.newDailyBudget);
    await q.query(
      "update ad_campaigns set plan = jsonb_set(plan, '{dailyBudget}', to_jsonb($3::bigint)), updated_at=now() where id=$1 and business_id=$2",
      [c.id, businessId, i.newDailyBudget],
    );
    return { dailyBudget: budget };
  },
  async verify(_c, i, res) {
    return Number(res?.dailyBudget) === i.newDailyBudget
      ? { ok: true, detail: "Meta confirms the new daily budget." }
      : { ok: false, detail: "Meta did not confirm the new budget." };
  },
};

export const TOOLS: Record<string, Tool> = Object.fromEntries(
  [
    createTask,
    sendAlert,
    draftEmail,
    reminder,
    reschedulePayable,
    createTaxReserve,
    shareLenderPack,
    createMetaCampaign,
    activateMetaCampaign,
    pauseMetaCampaign,
    scaleMetaCampaign,
  ].map((t) => [t.name, t]),
);
export { metaContext };

export function getTool(name: string): Tool | undefined {
  return TOOLS[name];
}
