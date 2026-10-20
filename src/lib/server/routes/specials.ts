import "server-only";
import { z } from "zod";
import { codDescription, codSummary, type CodBatch } from "@/lib/finance/cod";
import { addDays } from "@/lib/finance/dates";
import { summarize } from "@/lib/finance/engine";
import { readTaxProfile, TAX_QUESTIONS, taxChecklist } from "@/lib/finance/taxsetup";
import { api, badRequest, isoDate, minor } from "../http";
import type { Q } from "../db";
import { loadSnapshot } from "../workspace";
import type { Route } from "./types";

/*
 * Two Egypt-specific helpers:
 *  - Taxes & papers: no tax is estimated until the owner says where their registration stands; then a checklist
 *    tells them exactly what to do next.
 *  - Money with couriers (cash on delivery): what Bosta, Mylerz and others are holding, and what is late.
 */

export async function loadCodBatches(q: Q, businessId: string): Promise<CodBatch[]> {
  const rows = await q.query<any>(
    `select i.id, i.courier, i.amount::text, i.cod_fees::text as fees, i.cod_orders as orders, i.issue_date::text as delivered_on, i.due_date::text as expected_on, i.status,
            coalesce((select sum(p.amount) from invoice_payments p where p.invoice_id=i.id),0)::text as paid
       from invoices i where i.business_id=$1 and i.courier is not null and i.direction='receivable'`,
    [businessId],
  );
  return rows.map((r) => ({
    id: r.id,
    courier: r.courier,
    amount: Number(r.amount),
    paid: Number(r.paid),
    fees: Number(r.fees ?? 0),
    orders: Number(r.orders ?? 1),
    deliveredOn: r.delivered_on,
    expectedOn: r.expected_on,
    status: r.status,
  }));
}

const ANSWER = z.enum(["yes", "no", "in_progress", "not_sure"]);

export const specialRoutes: Route[] = [
  [
    "GET",
    "tax-setup",
    api(async (c) => {
      const [biz, snap] = await Promise.all([
        c
          .db((q) => q.query<{ settings: any }>("select settings from businesses where id=$1", [c.biz.id]))
          .then((r) => r[0]),
        c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency)),
      ]);
      const year = summarize(snap.txns, snap.cats, snap.currency, { from: addDays(snap.today, -364), to: snap.today });
      const profile = readTaxProfile(biz?.settings);
      return {
        profile,
        questions: TAX_QUESTIONS,
        checklist: taxChecklist(profile, Math.max(0, year.revenue)),
        currency: snap.currency,
      };
    }),
  ],
  [
    "POST",
    "tax-setup",
    api(async (c) => {
      c.requireAdmin();
      const b = await c.body(
        z.object({
          commercialRegister: ANSWER,
          taxCard: ANSWER,
          etaPortal: ANSWER,
          vatRegistered: ANSWER,
          simplifiedRegime: ANSWER,
          eInvoicing: ANSWER,
        }),
      );
      const profile = { ...b, updatedAt: new Date().toISOString() };
      // VAT is only set aside once the owner says they are registered; "not sure" keeps it off until they check.
      await c.db((q) =>
        q.query("update businesses set settings = settings || $2::text::jsonb where id=$1", [
          c.biz.id,
          JSON.stringify({ taxProfile: profile, vatRegistered: b.vatRegistered === "yes" }),
        ]),
      );
      return { ok: true };
    }),
  ],

  [
    "GET",
    "cod",
    api(async (c) => {
      const [batches, snap] = await Promise.all([
        c.db((q) => loadCodBatches(q, c.biz.id)),
        c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency)),
      ]);
      const accounts = snap.accounts.filter((a: any) => !a.archived).map((a: any) => ({ id: a.id, name: a.name }));
      return { summary: codSummary(batches, snap.today), today: snap.today, currency: snap.currency, accounts };
    }),
  ],
  [
    "POST",
    "cod",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          courier: z.string().trim().min(1, "Choose the courier").max(40),
          collected: minor,
          fees: z.number().int().min(0).max(9_000_000_000_000_000).default(0),
          orders: z.number().int().min(1).max(100000),
          delivered_on: isoDate,
          expected_on: isoDate,
        }),
      );
      if (b.fees >= b.collected)
        throw badRequest("Fees must be less than what the courier collected.", { fees: "Fees are too high" });
      if (b.expected_on < b.delivered_on)
        throw badRequest("The payout date can't be before the delivery date.", { expected_on: "Before delivery" });
      const net = b.collected - b.fees;
      const row = await c.db((q) =>
        q.query<{ id: string }>(
          `insert into invoices(business_id,direction,description,amount,currency,issue_date,due_date,courier,cod_orders,cod_fees)
       values ($1,'receivable',$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
          [
            c.biz.id,
            codDescription(b.courier, b.orders, b.delivered_on),
            net,
            c.biz.currency,
            b.delivered_on,
            b.expected_on,
            b.courier,
            b.orders,
            b.fees,
          ],
        ),
      );
      return { id: row[0].id, net };
    }),
  ],
];
