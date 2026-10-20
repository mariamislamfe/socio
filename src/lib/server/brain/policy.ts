// Policy engine: decides whether an action may run automatically, needs approval, or is prohibited.
// Pure function so it can be unit-tested; the server always calls it before executing anything.
import crypto from "node:crypto";

export type Risk = 1 | 2 | 3;
export type Mode = "auto" | "approval" | "prohibited";

export interface AutomationSettings {
  paused: boolean;
  /* * Level 2: bounded, pre-authorised actions. Enforced on the server. */
  paymentReminders: { enabled: boolean; maxAmount: number; minDaysBetween: number };
}

export const DEFAULT_AUTOMATION: AutomationSettings = {
  paused: false,
  paymentReminders: { enabled: false, maxAmount: 0, minDaysBetween: 7 },
};

export function readAutomation(settings: any): AutomationSettings {
  const a = settings?.automation ?? {};
  return {
    paused: a.paused === true,
    paymentReminders: {
      enabled: a.paymentReminders?.enabled === true,
      maxAmount: Number.isSafeInteger(a.paymentReminders?.maxAmount) ? Math.max(0, a.paymentReminders.maxAmount) : 0,
      minDaysBetween: Number.isInteger(a.paymentReminders?.minDaysBetween)
        ? Math.max(1, a.paymentReminders.minDaysBetween)
        : 7,
    },
  };
}

export interface DecideInput {
  tool: string;
  risk: Risk;
  role: "owner" | "admin" | "member" | "viewer" | "system";
  automation: AutomationSettings;
  /* * Facts the server looked up for bounded (level 2) tools. */
  bounded?: { amount: number; daysSinceLast: number | null };
}

export function decide(i: DecideInput): { mode: Mode; reason: string } {
  if (i.role === "viewer") return { mode: "prohibited", reason: "Viewers cannot trigger actions." };
  if (i.risk === 3)
    return { mode: "approval", reason: "Sensitive or external action: always needs your explicit approval." };
  if (i.automation.paused) return { mode: "approval", reason: "Automation is paused, so nothing runs on its own." };
  if (i.risk === 1) return { mode: "auto", reason: "Internal, low-risk action." };
  // Level 2
  if (i.tool === "send_payment_reminder") {
    const p = i.automation.paymentReminders;
    if (!p.enabled) return { mode: "approval", reason: "Automatic payment reminders are turned off." };
    if (!i.bounded) return { mode: "approval", reason: "Could not check the limits for this reminder." };
    if (i.bounded.amount > p.maxAmount)
      return { mode: "approval", reason: "The invoice is above your automatic reminder limit." };
    if (i.bounded.daysSinceLast !== null && i.bounded.daysSinceLast < p.minDaysBetween)
      return { mode: "approval", reason: `A reminder was sent ${i.bounded.daysSinceLast} day(s) ago.` };
    return { mode: "auto", reason: "Within the limits you pre-authorised." };
  }
  return { mode: "approval", reason: "No automatic limits are configured for this action." };
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, canonical((v as any)[k])]),
    );
  return v;
}

/* * An approval is bound to this hash: the exact tool, target and parameters. Any change needs a new approval. */
export function paramsHash(tool: string, params: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([tool, canonical(params)]))
    .digest("hex");
}

// Trust ladder: autonomy is earned with evidence and granted only by the owner

export interface TrustInput {
  predictions: { predicted: number; actual: number | null }[];
  actions: { tool: string; status: string; origin: string; requires_approval: boolean }[];
  automation: AutomationSettings;
  receivables: number[]; // outstanding amounts of open customer invoices
  emailConfigured: boolean;
}

export interface TrustView {
  rung: 1 | 2 | 3;
  rungs: { level: 1 | 2 | 3; name: string; what: string; reached: boolean }[];
  evidence: { label: string; value: string; ok: boolean }[];
  progress: number; // 0–100 towards the next rung
  suggestion: {
    title: string;
    why: string;
    change: { paymentReminders: AutomationSettings["paymentReminders"] };
  } | null;
}

const NEED_FORECASTS = 3;
const NEED_APPROVALS = 3;
const MAX_ERROR = 0.1;

export function trustLadder(i: TrustInput): TrustView {
  const measured = i.predictions.filter((p) => p.actual !== null);
  const errors = measured.map((p) => Math.abs((p.actual as number) - p.predicted) / Math.max(1, Math.abs(p.predicted)));
  const meanErr = errors.length ? errors.reduce((a, e) => a + e, 0) / errors.length : null;
  const reviewed = i.actions.filter((a) => a.requires_approval && a.origin !== "user");
  const approved = reviewed.filter((a) => ["approved", "executing", "succeeded"].includes(a.status)).length;
  const rejected = reviewed.filter((a) => a.status === "rejected").length;
  const accurate = measured.length >= NEED_FORECASTS && meanErr !== null && meanErr <= MAX_ERROR;
  const trusted = approved >= NEED_APPROVALS && rejected <= Math.floor(approved / 4);
  const auto = i.automation.paymentReminders.enabled;
  const rung: 1 | 2 | 3 = auto ? 3 : accurate && trusted ? 2 : 1;
  const parts = [
    Math.min(1, measured.length / NEED_FORECASTS),
    meanErr === null ? 0 : meanErr <= MAX_ERROR ? 1 : Math.max(0, 1 - (meanErr - MAX_ERROR) / MAX_ERROR),
    Math.min(1, approved / NEED_APPROVALS),
  ];
  const progress = rung >= 2 ? 100 : Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100);

  let suggestion: TrustView["suggestion"] = null;
  if (rung === 2 && !i.automation.paused) {
    const sorted = [...i.receivables].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const cap = Math.max(median, 1);
    suggestion = {
      title: "Let me send polite payment reminders on my own, for small invoices",
      why: `My last ${measured.length} cash forecasts were within ${Math.round((meanErr ?? 0) * 100)}% of what really happened, and you approved ${approved} of ${approved + rejected} actions I proposed. Larger invoices would still need your approval.${i.emailConfigured ? "" : " (Email is not configured yet, so reminders would stay drafts until it is.)"}`,
      change: { paymentReminders: { enabled: true, maxAmount: cap, minDaysBetween: 7 } },
    };
  }
  return {
    rung,
    progress,
    suggestion,
    rungs: [
      {
        level: 1,
        name: "Advisor",
        what: "Watches, explains and proposes. Does only internal, reversible work on its own.",
        reached: true,
      },
      {
        level: 2,
        name: "Proven",
        what: `Its forecasts held up (≥${NEED_FORECASTS} checked, ≤${Math.round(MAX_ERROR * 100)}% off) and you approved most of its proposals. It may ask for more.`,
        reached: rung >= 2,
      },
      {
        level: 3,
        name: "Trusted assistant",
        what: "You let it handle small, bounded tasks (e.g. reminders under a limit). Everything sensitive still waits for you.",
        reached: rung >= 3,
      },
    ],
    evidence: [
      {
        label: "Forecasts checked against reality",
        value: `${measured.length} of ${NEED_FORECASTS}`,
        ok: measured.length >= NEED_FORECASTS,
      },
      {
        label: "Average forecast error",
        value: meanErr === null ? "not measured yet" : `${Math.round(meanErr * 100)}%`,
        ok: meanErr !== null && meanErr <= MAX_ERROR,
      },
      { label: "Proposals you approved", value: `${approved} approved · ${rejected} rejected`, ok: trusted },
    ],
  };
}
