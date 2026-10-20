// Cash on delivery: how much money couriers are holding for the business, what is late, and what to do about it.
// Pure: works on plain rows so it can be unit-tested and reused by the page, the agent and the briefing.

export const COURIERS = ["Bosta", "Mylerz", "J&T Express", "Aramex", "R2S", "Turbo", "Other"] as const;

export interface CodBatch {
  id: string;
  courier: string;
  amount: number; // net amount the courier should pay out (minor units)
  paid: number;
  fees: number; // courier fees already deducted
  orders: number;
  deliveredOn: string; // issue_date
  expectedOn: string; // due_date
  status: "open" | "void";
}

export interface CourierSummary {
  courier: string;
  held: number; // still with the courier
  late: number; // part of `held` past its expected payout date
  batches: number;
  lateBatches: number;
  oldestLateDays: number;
  nextPayout: { date: string; amount: number } | null;
  fees: number; // fees on the open batches
  orders: number;
}

export interface CodSummary {
  held: number;
  late: number;
  nextPayout: { date: string; courier: string; amount: number } | null;
  couriers: CourierSummary[];
  open: (CodBatch & { outstanding: number; daysLate: number })[];
  /* * Courier with the most late money, if any. */
  worst: CourierSummary | null;
}

const days = (from: string, to: string) =>
  Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);

export function codSummary(batches: CodBatch[], today: string): CodSummary {
  const open = batches
    .filter((b) => b.status === "open" && b.amount - b.paid > 0)
    .map((b) => ({ ...b, outstanding: b.amount - b.paid, daysLate: Math.max(0, days(b.expectedOn, today)) }))
    .sort((a, b) => a.expectedOn.localeCompare(b.expectedOn));
  const by = new Map<string, CourierSummary>();
  for (const b of open) {
    const s = by.get(b.courier) ?? {
      courier: b.courier,
      held: 0,
      late: 0,
      batches: 0,
      lateBatches: 0,
      oldestLateDays: 0,
      nextPayout: null,
      fees: 0,
      orders: 0,
    };
    s.held += b.outstanding;
    s.batches += 1;
    s.fees += b.fees;
    s.orders += b.orders;
    if (b.daysLate > 0) {
      s.late += b.outstanding;
      s.lateBatches += 1;
      s.oldestLateDays = Math.max(s.oldestLateDays, b.daysLate);
    } else if (!s.nextPayout || b.expectedOn < s.nextPayout.date)
      s.nextPayout = { date: b.expectedOn, amount: b.outstanding };
    else if (s.nextPayout.date === b.expectedOn) s.nextPayout.amount += b.outstanding;
    by.set(b.courier, s);
  }
  const couriers = [...by.values()].sort((a, b) => b.late - a.late || b.held - a.held);
  const upcoming = open.filter((b) => b.daysLate === 0);
  const first = upcoming[0];
  const nextPayout = first
    ? {
        date: first.expectedOn,
        courier: first.courier,
        amount: upcoming
          .filter((b) => b.expectedOn === first.expectedOn && b.courier === first.courier)
          .reduce((s, b) => s + b.outstanding, 0),
      }
    : null;
  const worst = couriers.find((c) => c.late > 0) ?? null;
  return {
    held: open.reduce((s, b) => s + b.outstanding, 0),
    late: open.filter((b) => b.daysLate > 0).reduce((s, b) => s + b.outstanding, 0),
    nextPayout,
    couriers,
    open,
    worst,
  };
}

export function codDescription(courier: string, orders: number, deliveredOn: string) {
  return `COD · ${courier} · ${orders} order${orders === 1 ? "" : "s"} delivered ${deliveredOn}`;
}

/* * Short plain-language status for the agent and the WhatsApp briefing. fm formats minor units. */
export function codLine(s: CodSummary, lang: "en" | "ar", fm: (minor: number) => string): string {
  if (!s.open.length)
    return lang === "ar" ? "مفيش فلوس محبوسة عند شركات الشحن دلوقتي." : "No money is waiting with couriers right now.";
  const parts: string[] = [];
  if (lang === "ar") {
    parts.push(`شركات الشحن ماسكة ${fm(s.held)} من فلوسك.`);
    if (s.worst)
      parts.push(
        `${s.worst.courier} متأخرة في ${fm(s.worst.late)} بقالها ${s.worst.oldestLateDays} يوم. كلّمهم واطلب كشف التحصيل والتحويل.`,
      );
    if (s.nextPayout)
      parts.push(`أقرب تحويل: ${fm(s.nextPayout.amount)} من ${s.nextPayout.courier} يوم ${s.nextPayout.date}.`);
  } else {
    parts.push(`Couriers are holding ${fm(s.held)} of your money.`);
    if (s.worst)
      parts.push(
        `${s.worst.courier} is late on ${fm(s.worst.late)} (oldest ${s.worst.oldestLateDays} days). Call them and ask for the collection statement and the transfer.`,
      );
    if (s.nextPayout)
      parts.push(`Next payout: ${fm(s.nextPayout.amount)} from ${s.nextPayout.courier} on ${s.nextPayout.date}.`);
  }
  return parts.join(" ");
}
