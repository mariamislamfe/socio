import "server-only";
import type { Offer } from "@/lib/finance/financing";
import { analyzeOffers } from "@/lib/finance/financing";
import { buildLenderPack, type LenderPack } from "@/lib/finance/lenderpack";
import type { Q } from "./db";
import { sha256 } from "./crypto";
import { loadSnapshot } from "./workspace";

export async function loadOffers(q: Q, businessId: string): Promise<Offer[]> {
  const rows = await q.query<any>("select * from financing_offers where business_id=$1 order by created_at", [
    businessId,
  ]);
  return rows.map((r) => ({
    id: r.id,
    lender: r.lender,
    kind: r.kind,
    amount: Number(r.amount),
    upfrontFee: Number(r.upfront_fee),
    ratePct: r.rate_pct === null ? null : Number(r.rate_pct),
    flatFee: r.flat_fee === null ? null : Number(r.flat_fee),
    termDays: r.term_days,
    repayment: r.repayment,
    revenueSharePct: r.revenue_share_pct === null ? null : Number(r.revenue_share_pct),
    flags: r.flags ?? {},
    source: r.source,
  }));
}

export async function financingContext(q: Q, businessId: string) {
  const b = (
    await q.query<{
      name: string;
      business_type: string | null;
      country: string | null;
      currency: string;
      timezone: string;
      settings: any;
    }>("select name,business_type,country,currency,timezone,settings from businesses where id=$1", [businessId])
  )[0];
  if (!b) throw new Error("Business not found");
  const snap = await loadSnapshot(q, businessId, b.currency.trim());
  const integ = await q.query<{ provider: string; status: string; last_sync_at: string | null }>(
    "select provider,status,last_sync_at::text from integrations where business_id=$1 and status <> 'disconnected'",
    [businessId],
  );
  const offers = await loadOffers(q, businessId);
  const reserve = Number.isSafeInteger(b.settings?.safetyReserve) ? (b.settings.safetyReserve as number) : null;
  return { b, snap, integ, offers, reserve };
}

/* * Builds the lender pack and its fingerprint (sha256 of the canonical JSON). */
export async function buildPackFor(
  q: Q,
  businessId: string,
  req: { amount: number; purpose: string; offerId?: string | null } | null,
): Promise<{ pack: LenderPack; fingerprint: string }> {
  const { b, snap, integ, offers, reserve } = await financingContext(q, businessId);
  const analysis = req?.offerId
    ? (analyzeOffers(
        snap,
        offers.filter((o) => o.id === req.offerId),
        reserve,
      ).offers[0] ?? null)
    : null;
  const sources = [
    `${snap.txns.length} recorded transactions, ${snap.invoices.length} invoices and bills, ${snap.recurring.length} recurring schedules`,
    ...integ.map(
      (i) =>
        `${i.provider} (${i.status}${i.last_sync_at ? `, last sync ${i.last_sync_at.slice(0, 16).replace("T", " ")}` : ""})`,
    ),
  ];
  const pack = buildLenderPack({
    s: snap,
    business: {
      name: b.name,
      type: b.business_type,
      country: b.country,
      currency: snap.currency,
      timezone: b.timezone,
    },
    quality: {
      integrations: integ.map((i) => ({ provider: i.provider, status: i.status, lastSyncAt: i.last_sync_at })),
    },
    sources,
    request: req ? { amount: req.amount, purpose: req.purpose, offer: analysis } : undefined,
  });
  return { pack, fingerprint: fingerprintOf(pack) };
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  return v;
}

/* * Fingerprint over canonical JSON, so it survives storage in jsonb (which reorders keys). */
export function fingerprintOf(payload: unknown): string {
  return sha256(JSON.stringify(canonical(payload)));
}
