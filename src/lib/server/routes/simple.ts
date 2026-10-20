import "server-only";
import { z } from "zod";
import { addDays, addMonths, startOfMonth } from "@/lib/finance/dates";
import { invoiceOutstanding, summarize } from "@/lib/finance/engine";
import { moneyPlan } from "@/lib/finance/moneyplan";
import { baseForecast, cashBalance } from "@/lib/finance/planning";
import { api, ApiError, isoDate, notFound } from "../http";
import { readTaxSettings } from "../brain/workflows";
import { loadSnapshot } from "../workspace";
import type { Route } from "./types";

/*
 * The simple mode: one screen to see what you have, add money in or out, and see what is coming.
 * Each entry is stored with the normal ledger tables, so everything else (forecast, profit, checks) keeps working.
 */
const IN_CATS = ["Sales", "Services", "Other income"];
const OUT_CATS = [
  "Inventory & materials",
  "Shipping & delivery",
  "Social ads",
  "Rent",
  "Salaries",
  "Utilities",
  "Packaging",
  "Software & subscriptions",
  "Taxes",
  "Operations & other",
  "Owner's pay",
];

export const simpleRoutes: Route[] = [
  [
    "GET",
    "simple",
    api(async (c) => {
      const snap = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const biz = (
        await c.db((q) => q.query<{ settings: any }>("select settings from businesses where id=$1", [c.biz.id]))
      )[0];
      const top =
        (
          await c.db((q) =>
            q.query<{ title: string; kind: string }>(
              "select title, kind from recommendations where business_id=$1 and status='open' order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, case kind when 'cash_risk' then 0 else 1 end, updated_at desc limit 1",
              [c.biz.id],
            ),
          )
        )[0] ?? null;
      const cash = cashBalance(snap);
      const reserve = Number.isSafeInteger(biz?.settings?.safetyReserve) ? biz.settings.safetyReserve : null;
      const plan = moneyPlan(snap, {
        tax: readTaxSettings(biz?.settings),
        reserve,
        plan: biz?.settings?.moneyPlan ?? {},
      });
      const m = summarize(snap.txns, snap.cats, snap.currency, { from: startOfMonth(snap.today), to: snap.today });
      // What is coming in the next 30 days, plus anything already late.
      const f = baseForecast(snap, 30);
      const salaryIds = new Set(snap.recurring.filter((r) => r.kind === "salary").map((r) => r.id));
      const listed = f.events
        .filter((e) => e.kind !== "typical" && e.kind !== "scenario")
        .map((e) => ({
          date: e.date,
          label: e.label,
          amount: e.amount,
          kind: e.kind as string,
          refId: e.refId ?? null,
          late: false,
          people: 0,
        }));
      // Salaries are one line per pay day ("Salaries · 3 people"); each person is marked paid in Bills & fixed costs.
      const upcoming: typeof listed = [];
      for (const u of listed) {
        if (!(u.refId && salaryIds.has(u.refId))) {
          upcoming.push(u);
          continue;
        }
        const g = upcoming.find((x) => x.kind === "salaries" && x.date === u.date);
        if (g) {
          g.amount += u.amount;
          g.people += 1;
        } else upcoming.push({ ...u, label: "Salaries", kind: "salaries", refId: null, people: 1 });
      }
      const late = snap.invoices
        .filter(
          (i) =>
            i.status === "open" && invoiceOutstanding(i) > 0 && i.due_date < snap.today && i.currency === snap.currency,
        )
        .map((i) => ({
          date: i.due_date,
          label: i.description || i.number || "Invoice",
          amount: i.direction === "receivable" ? invoiceOutstanding(i) : -invoiceOutstanding(i),
          kind: i.direction,
          refId: i.id,
          late: true,
          people: 0,
        }));
      const catIds = Object.fromEntries(
        snap.cats.filter((x) => [...IN_CATS, ...OUT_CATS].includes(x.name)).map((x) => [x.name, x.id]),
      );
      const account = snap.accounts.find((a) => a.counts_as_cash !== false && a.currency === snap.currency) ?? null;
      return {
        currency: snap.currency,
        today: snap.today,
        hasData: snap.txns.length > 0,
        cash: cash.total,
        safeToSpend: Math.max(0, plan.business.canSpend + plan.owner.canTakeNow),
        reserve,
        // How "safe to spend" is worked out, so a 0 is never a mystery.
        safe: {
          cash: plan.safe.cash,
          taxes: plan.safe.taxes,
          bills30: plan.safe.bills30,
          reserve: plan.safe.reserve,
          free: plan.safe.free,
        },
        month: { income: m.revenue, spent: m.cogs + m.opex, kept: m.netProfit, ownerTook: m.ownerDraws },
        // A late invoice is listed once (as late), not again on its assumed future date.
        upcoming: [...late, ...upcoming.filter((u) => !late.some((l) => l.refId && l.refId === u.refId))].slice(0, 12),
        attention: top,
        categories: { in: IN_CATS.filter((n) => catIds[n]), out: OUT_CATS.filter((n) => catIds[n]) },
        hasAccount: !!account,
      };
    }),
  ],

  // One entry point for "I got money" / "I spent money", now, later, or every month/year.
  [
    "POST",
    "simple/entry",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          direction: z.enum(["in", "out"]),
          amount: z.number().int().min(1).max(9e13),
          category: z.string().max(80).nullable().optional(),
          note: z.string().trim().max(200).optional(),
          date: isoDate,
          repeat: z.enum(["once", "monthly", "yearly"]).default("once"),
        }),
      );
      return c.db(async (q) => {
        const today = (
          await q.query<{ d: string }>(
            "select (now() at time zone coalesce((select timezone from businesses where id=$1),'UTC'))::date::text d",
            [c.biz.id],
          )
        )[0].d;
        const acc = (
          await q.query<{ id: string }>(
            "select id from accounts where business_id=$1 and currency=$2 and archived=false and counts_as_cash is not false order by position, created_at limit 1",
            [c.biz.id, c.biz.currency],
          )
        )[0];
        if (!acc) throw new ApiError(422, "no_account", "Add an account first (Settings → Accounts).");
        const cat = b.category
          ? (
              await q.query<{ id: string; kind: string }>(
                "select id, kind from categories where business_id=$1 and name=$2 limit 1",
                [c.biz.id, b.category],
              )
            )[0]
          : undefined;
        if (cat && cat.kind !== (b.direction === "in" ? "income" : "expense"))
          throw new ApiError(422, "invalid", "That category does not match.", { category: "Wrong type" });
        const label = b.note || b.category || (b.direction === "in" ? "Money in" : "Money out");
        const type = b.direction === "in" ? "income" : "expense";
        const insertTxn = (date: string, recurringId: string | null = null) =>
          q.query<{ id: string }>(
            "insert into transactions(business_id,type,date,amount,currency,account_id,category_id,description,recurring_id,source) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual') returning id",
            [c.biz.id, type, date, b.amount, c.biz.currency, acc.id, cat?.id ?? null, label, recurringId],
          );
        if (b.repeat !== "once") {
          // Repeats: a schedule that reminds you. If the first one is today or earlier, it is recorded now too.
          const months = b.repeat === "monthly" ? 1 : 12;
          const day = Number(b.date.slice(8, 10));
          const first = b.date <= today ? addMonths(b.date, months, day) : b.date;
          const r = await q.query<{ id: string }>(
            `insert into recurring(business_id,name,direction,kind,amount,currency,category_id,account_id,frequency,next_due) values ($1,$2,$3,'other',$4,$5,$6,$7,$8,$9) returning id`,
            [c.biz.id, label, b.direction, b.amount, c.biz.currency, cat?.id ?? null, acc.id, b.repeat, first],
          );
          if (b.date <= today) await insertTxn(b.date, r[0].id);
          return { kind: "recurring", id: r[0].id, nextDue: first, recordedNow: b.date <= today };
        }
        if (b.date > today) {
          // A one-off in the future: a bill to pay or money to receive on that date (it appears in the calendar and reminders).
          const r = await q.query<{ id: string }>(
            "insert into invoices(business_id,direction,description,amount,currency,issue_date,due_date,category_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
            [
              c.biz.id,
              b.direction === "in" ? "receivable" : "payable",
              label,
              b.amount,
              c.biz.currency,
              today,
              b.date,
              cat?.id ?? null,
            ],
          );
          return { kind: "planned", id: r[0].id, due: b.date };
        }
        const t = await insertTxn(b.date);
        return { kind: "recorded", id: t[0].id };
      });
    }),
  ],

  // "It was paid": records the payment for a scheduled item from the upcoming list.
  [
    "POST",
    "simple/paid",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          kind: z.enum(["recurring_in", "recurring_out", "payable", "receivable"]),
          refId: z.string().uuid(),
        }),
      );
      return c.db(async (q) => {
        const today = (
          await q.query<{ d: string }>(
            "select (now() at time zone coalesce((select timezone from businesses where id=$1),'UTC'))::date::text d",
            [c.biz.id],
          )
        )[0].d;
        const acc = (
          await q.query<{ id: string }>(
            "select id from accounts where business_id=$1 and currency=$2 and archived=false and counts_as_cash is not false order by position, created_at limit 1",
            [c.biz.id, c.biz.currency],
          )
        )[0];
        if (!acc) throw new ApiError(422, "no_account", "Add an account first.");
        if (b.kind === "recurring_in" || b.kind === "recurring_out") {
          const r = (
            await q.query<any>("select * from recurring where id=$1 and business_id=$2", [b.refId, c.biz.id])
          )[0];
          if (!r) throw notFound("Schedule");
          await q.query(
            "insert into transactions(business_id,type,date,amount,currency,account_id,category_id,description,recurring_id,source) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual')",
            [
              c.biz.id,
              r.direction === "in" ? "income" : "expense",
              today,
              r.amount,
              r.currency,
              acc.id,
              r.category_id,
              r.name,
              r.id,
            ],
          );
          const step =
            r.frequency === "weekly" ? null : r.frequency === "monthly" ? 1 : r.frequency === "quarterly" ? 3 : 12;
          const next =
            step === null
              ? addDays(r.next_due, 7)
              : addMonths(r.next_due, step, Number(String(r.next_due).slice(8, 10)));
          await q.query("update recurring set next_due=$3 where id=$1 and business_id=$2", [r.id, c.biz.id, next]);
          return { ok: true, nextDue: next };
        }
        const inv = (
          await q.query<any>(
            "select i.*, coalesce((select sum(amount) from invoice_payments p where p.invoice_id=i.id),0)::bigint paid from invoices i where i.id=$1 and i.business_id=$2",
            [b.refId, c.biz.id],
          )
        )[0];
        if (!inv) throw notFound("Invoice");
        const left = Number(inv.amount) - Number(inv.paid);
        if (left <= 0) return { ok: true };
        const t = await q.query<{ id: string }>(
          "insert into transactions(business_id,type,date,amount,currency,account_id,category_id,description,invoice_id,created_by,source) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual') returning id",
          [
            c.biz.id,
            inv.direction === "receivable" ? "income" : "expense",
            today,
            left,
            inv.currency,
            acc.id,
            inv.category_id,
            inv.description,
            inv.id,
            c.user.id,
          ],
        );
        await q.query(
          "insert into invoice_payments(business_id,invoice_id,amount,paid_on,account_id,transaction_id) values ($1,$2,$3,$4,$5,$6)",
          [c.biz.id, inv.id, left, today, acc.id, t[0].id],
        );
        return { ok: true };
      });
    }),
  ],
];
