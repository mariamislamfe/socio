import "server-only";
import { formatMoney } from "@/lib/finance/money";
import { asService } from "./db";
import { auditLog } from "./jobs";
import type { Briefing } from "./brain/workflows";

/*
 * Daily briefing on WhatsApp (Meta WhatsApp Cloud API). Business-initiated messages must use a template approved in
 * WhatsApp Manager; we send the four variables below. Only to the owner's own number, only after explicit opt-in.
 */

export interface WhatsAppSettings {
  optIn: boolean;
  phone: string | null; // E.164, e.g. +201001234567
  lang: "en" | "ar";
}

export const TEMPLATE_TEXT = {
  en: "Good morning, {{1}} ☀️\n{{2}}\n💰 {{3}}\n👉 {{4}}\nOpen the app for the details.",
  ar: "صباح الخير يا {{1}} ☀️\n{{2}}\n💰 {{3}}\n👉 {{4}}\nافتح التطبيق للتفاصيل.",
};

export function readWhatsApp(settings: any): WhatsAppSettings {
  const w = settings?.whatsapp ?? {};
  return {
    optIn: w.optIn === true,
    phone: typeof w.phone === "string" && /^\+[1-9]\d{7,14}$/.test(w.phone) ? w.phone : null,
    lang: w.lang === "ar" ? "ar" : "en",
  };
}

export function whatsappMissing(): string[] {
  return ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"].filter((k) => !process.env[k]);
}

export const maskPhone = (p: string) => `${p.slice(0, 4)}•••••${p.slice(-3)}`;

const KIND_AR: Record<string, string> = {
  cash_risk: "الكاش ممكن ينزل تحت حد الأمان قريب",
  product_loss: "فيه منتج بيخسّرك فلوس مع كل بيعة",
  ads_burn: "الإعلانات الزيادة مش جايبة تمنها",
  tax_setaside: "جزء من الكاش بتاع الضرايب، متصرفوش",
};

// Template parameters cannot contain new lines, tabs or long runs of spaces.
const clean = (s: string, max = 180) =>
  s
    .replace(/[\n\t]+/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim()
    .slice(0, max);

export function briefingMessage(
  b: Briefing & { riskKinds?: string[] },
  bizName: string,
  lang: "en" | "ar",
): { params: string[]; preview: string } {
  const fm = (v: number) => formatMoney(v, b.currency);
  const n = b.risks.length;
  const top = b.risks[0];
  const prio = b.priorities[0];
  let params: string[];
  if (lang === "ar") {
    const headline = n
      ? `${n === 1 ? "حاجة واحدة محتاجة" : `${n} حاجات محتاجة`} انتباهك النهارده.`
      : prio
        ? "مفيش حاجة عاجلة، بس فيه كام حاجة تستاهل نظرة."
        : "كله تمام النهارده.";
    const focus = top
      ? (KIND_AR[b.riskKinds?.[0] ?? ""] ?? top.title)
      : prio
        ? prio.title
        : "مفيش مطلوب منك حاجة النهارده";
    params = [bizName, headline, `الكاش المتاح: ${fm(b.cash)}`, focus];
  } else {
    params = [
      bizName,
      b.headline,
      `Cash available: ${fm(b.cash)}`,
      top ? top.title : prio ? prio.title : "Nothing needs you today",
    ];
  }
  params = params.map((p) => clean(p));
  const preview = TEMPLATE_TEXT[lang].replace(/\{\{(\d)\}\}/g, (_, i) => params[Number(i) - 1] ?? "");
  return { params, preview };
}

export async function sendTemplate(to: string, lang: "en" | "ar", params: string[]): Promise<string> {
  const base = (process.env.WHATSAPP_API_BASE || "https://graph.facebook.com").replace(/\/+$/, "");
  const version = process.env.WHATSAPP_API_VERSION || "v23.0";
  const template = process.env.WHATSAPP_TEMPLATE || "daily_briefing";
  const res = await fetch(`${base}/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to.replace(/^\+/, ""),
      type: "template",
      template: {
        name: template,
        language: { code: lang },
        components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
      },
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j?.messages?.[0]?.id)
    throw new Error(
      `WhatsApp rejected the message (HTTP ${res.status}${j?.error?.message ? `: ${String(j.error.message).slice(0, 160)}` : ""}).`,
    );
  return String(j.messages[0].id);
}

/* * Sends the briefing once per day (dedupe key); records the outcome without ever storing the full number. */
export async function deliverBriefing(
  businessId: string,
  b: Briefing & { riskKinds?: string[] },
  opts: { dedupeKey?: string } = {},
) {
  const row = (
    await asService((q) =>
      q.query<{ name: string; settings: any }>("select name, settings from businesses where id=$1", [businessId]),
    )
  )[0];
  const w = readWhatsApp(row?.settings);
  if (!w.optIn || !w.phone) return { status: "skipped" as const, reason: "WhatsApp briefing is not turned on." };
  const { params, preview } = briefingMessage(b, row.name.replace(/\s*\(demo data\)\s*/i, ""), w.lang);
  const key = opts.dedupeKey ?? `briefing:${b.date}`;
  const already = await asService((q) =>
    q.query("select 1 from message_deliveries where business_id=$1 and dedupe_key=$2 and status='sent'", [
      businessId,
      key,
    ]),
  );
  if (already.length) return { status: "skipped" as const, reason: "Already sent." };
  const missing = whatsappMissing();
  let status: "sent" | "failed" | "skipped" = "sent";
  let providerId: string | null = null;
  let error: string | null = null;
  if (missing.length) {
    status = "skipped";
    error = `Not configured on the server (${missing.join(", ")}).`;
  } else {
    try {
      providerId = await sendTemplate(w.phone, w.lang, params);
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : "send failed";
    }
  }
  await asService(async (q) => {
    await q.query(
      `insert into message_deliveries(business_id,channel,kind,to_masked,status,provider_message_id,error,preview,dedupe_key) values ($1,'whatsapp','daily_briefing',$2,$3,$4,$5,$6,$7)
       on conflict (business_id,dedupe_key) do update set status=excluded.status, provider_message_id=excluded.provider_message_id, error=excluded.error, preview=excluded.preview, created_at=now()`,
      [businessId, maskPhone(w.phone!), status, providerId, error, preview, key],
    );
    await auditLog(q, {
      businessId,
      actorType: "system",
      action: `whatsapp.${status}`,
      detail: { to: maskPhone(w.phone!), error },
    });
  });
  return { status, providerId, error, preview };
}

// Recording money by message ("دفعت 500 شحن")

export async function sendText(to: string, body: string): Promise<string | null> {
  if (whatsappMissing().length) return null;
  const base = (process.env.WHATSAPP_API_BASE || "https://graph.facebook.com").replace(/\/+$/, "");
  const version = process.env.WHATSAPP_API_VERSION || "v23.0";
  // Free-form replies are allowed within 24 hours of the owner's own message.
  const res = await fetch(`${base}/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to.replace(/^\+/, ""),
      type: "text",
      text: { body: body.slice(0, 1000) },
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  return res.ok ? String(j?.messages?.[0]?.id ?? "") || null : null;
}

const HELP = {
  ar: "ابعتلي زي:\n• دفعت 500 شحن\n• بعت ب 1200\n• صرفت 2 ألف إعلانات\n• الرصيد — يقولك الكاش\n• الغي — يلغي آخر حاجة سجلتها",
  en: "Send me things like:\n• paid 500 shipping\n• sold 1200\n• spent 2k on ads\n• balance — your cash\n• undo — removes the last entry",
};

export async function recordFromMessage(
  businessId: string,
  text: string,
): Promise<{
  reply: string;
  recorded: { id: string; kind: string; amount: number; category: string | null } | null;
  action: "recorded" | "undone" | "help" | "balance" | "not_understood";
}> {
  const { parseCommand, parseEntry } = await import("@/lib/finance/messageparse");
  const { loadSnapshot } = await import("./workspace");
  const { cashBalance } = await import("@/lib/finance/planning");
  const { emitEvent } = await import("./jobs");
  const biz = (
    await asService((q) =>
      q.query<{ currency: string; settings: any }>("select currency, settings from businesses where id=$1", [
        businessId,
      ]),
    )
  )[0];
  if (!biz) throw new Error("Business not found");
  const cur = biz.currency.trim();
  const ar = /[؀-ۿ]/.test(text) || readWhatsApp(biz.settings).lang === "ar";
  const fm = (v: number) => formatMoney(v, cur);
  const cmd = parseCommand(text);
  if (cmd?.command === "help") return { reply: ar ? HELP.ar : HELP.en, recorded: null, action: "help" };
  if (cmd?.command === "balance") {
    const snap = await asService((q) => loadSnapshot(q, businessId, cur));
    const c = cashBalance(snap);
    return {
      reply: ar
        ? `💰 الكاش المسجل: ${fm(c.total)}${c.pending ? `\n(+ ${fm(c.pending)} لسه موصلوش البنك)` : ""}`
        : `💰 Recorded cash: ${fm(c.total)}${c.pending ? `\n(+ ${fm(c.pending)} awaiting payout)` : ""}`,
      recorded: null,
      action: "balance",
    };
  }
  if (cmd?.command === "undo") {
    const r = await asService(async (q) => {
      const last = (
        await q.query<{ id: string; amount: string; description: string }>(
          "select id, amount::text, description from transactions where business_id=$1 and source='whatsapp' and created_at > now() - interval '30 minutes' order by created_at desc limit 1",
          [businessId],
        )
      )[0];
      if (!last) return null;
      await q.query("delete from transactions where id=$1 and business_id=$2", [last.id, businessId]);
      await auditLog(q, { businessId, actorType: "user", action: "whatsapp.entry_undone", target: last.id });
      return last;
    });
    if (r)
      await emitEvent({
        businessId,
        source: "whatsapp",
        type: "ledger.changed",
        payload: { undo: r.id },
        idempotencyKey: `wa-undo:${r.id}`,
      });
    return {
      reply: r
        ? ar
          ? `↩️ لغيت: ${r.description} (${fm(Number(r.amount))})`
          : `↩️ Removed: ${r.description} (${fm(Number(r.amount))})`
        : ar
          ? "مفيش حاجة اتسجلت من الواتساب في آخر نص ساعة عشان ألغيها."
          : "Nothing recorded from WhatsApp in the last 30 minutes to undo.",
      recorded: null,
      action: "undone",
    };
  }
  const p = parseEntry(text);
  if (!p)
    return {
      reply: ar
        ? `مفهمتش المبلغ أو هو مصروف ولا بيع 🤔\n${HELP.ar}`
        : `I couldn't tell the amount or whether it's a sale or a cost 🤔\n${HELP.en}`,
      recorded: null,
      action: "not_understood",
    };
  const rec = await asService(async (q) => {
    const acc = (
      await q.query<{ id: string }>(
        "select id from accounts where business_id=$1 and currency=$2 and counts_as_cash is not false and archived = false order by position, created_at limit 1",
        [businessId, cur],
      )
    )[0];
    if (!acc) throw new Error("No cash account in the business currency.");
    const cat = p.category
      ? (
          await q.query<{ id: string }>("select id from categories where business_id=$1 and name=$2 limit 1", [
            businessId,
            p.category,
          ])
        )[0]
      : undefined;
    const desc = `${p.label} (WhatsApp)`;
    const r = await q.query<{ id: string }>(
      "insert into transactions(business_id,type,date,amount,currency,account_id,category_id,description,source) values ($1,$2,current_date,$3,$4,$5,$6,$7,'whatsapp') returning id",
      [businessId, p.kind, p.amount, cur, acc.id, cat?.id ?? null, desc],
    );
    await auditLog(q, {
      businessId,
      actorType: "user",
      action: "whatsapp.entry_recorded",
      target: r[0].id,
      detail: { kind: p.kind, amount: p.amount, category: p.category },
    });
    return { id: r[0].id, kind: p.kind, amount: p.amount, category: p.category };
  });
  await emitEvent({
    businessId,
    source: "whatsapp",
    type: "ledger.changed",
    payload: { txn: rec.id },
    idempotencyKey: `wa-txn:${rec.id}`,
  });
  const what = p.kind === "income" ? (ar ? "بيع" : "sale") : ar ? "مصروف" : "expense";
  return {
    reply: ar
      ? `✅ سجّلت ${what} ${fm(p.amount)} — ${p.label}${p.category ? "" : " (من غير تصنيف، صنّفه من التطبيق)"}.\nلو غلط ابعت «الغي».`
      : `✅ Recorded ${what} ${fm(p.amount)} — ${p.label}${p.category ? "" : " (no category yet)"}.\nIf that's wrong, send "undo".`,
    recorded: rec,
    action: "recorded",
  };
}
