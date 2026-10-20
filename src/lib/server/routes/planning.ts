import "server-only";
import { z } from "zod";
import { nextOccurrence, todayISO } from "@/lib/finance/dates";
import { api, ApiError, badRequest, isoDate, minor, notFound, params, uuid } from "../http";
import { loadSnapshot } from "../workspace";
import { budgetView, goalProgress } from "@/lib/finance/planning";
import { invoiceOutstanding, invoiceState } from "@/lib/finance/engine";
import type { Route } from "./types";

const period = z.enum(["monthly", "quarterly", "yearly"]);

export const planningRoutes: Route[] = [
  // budgets
  [
    "GET",
    "budgets",
    api(async (c) => {
      const snap = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      return { items: budgetView(snap), today: snap.today, currency: snap.currency };
    }),
  ],
  // Data-based starting point for a new budget: average monthly spend over the last 90 days (no universal percentages).
  [
    "GET",
    "budgets/suggest",
    api(async (c) => {
      const { category } = c.query(z.object({ category: uuid }));
      const r = await c.db((q) =>
        q.query<{ s: number; first: string | null }>(
          `with recursive d as (select id from categories where id=$2 and business_id=$1 union all select c.id from categories c join d on c.parent_id=d.id where c.business_id=$1)
         select coalesce(sum(case when type='expense' then amount else -amount end),0)::bigint s, min(date)::text first
         from transactions where business_id=$1 and type in ('expense','refund') and currency=$3 and date > (current_date - 90) and category_id in (select id from d)`,
          [c.biz.id, category, c.biz.currency],
        ),
      );
      const total = Number(r[0]?.s ?? 0);
      return {
        monthlyAverage: Math.max(0, Math.round(total / 3)),
        basis: "Average monthly spend over the last 90 days",
        hasHistory: total > 0,
      };
    }),
  ],
  [
    "POST",
    "budgets",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({ category_id: uuid, period: period.default("monthly"), amount: z.number().int().min(0).max(9e15) }),
      );
      const cat = await c.db((q) =>
        q.query<{ kind: string }>("select kind from categories where id=$1 and business_id=$2", [
          b.category_id,
          c.biz.id,
        ]),
      );
      if (!cat[0]) throw badRequest("Choose one of your categories.", { category_id: "Choose a category" });
      if (cat[0].kind !== "expense")
        throw badRequest("Budgets apply to expense categories.", { category_id: "Choose an expense category" });
      const r = await c.db((q) =>
        q.query(
          `insert into budgets(business_id,category_id,period,amount,position) values ($1,$2,$3,$4,(select coalesce(max(position),-1)+1 from budgets where business_id=$1))
         on conflict (business_id, category_id, period) do update set amount = excluded.amount returning id`,
          [c.biz.id, b.category_id, b.period, b.amount],
        ),
      );
      return { id: r[0].id };
    }),
  ],
  [
    "PATCH",
    "budgets/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({ amount: z.number().int().min(0).max(9e15).optional(), period: period.optional() }),
      );
      const r = await c.db((q) =>
        q.query(
          "update budgets set amount=coalesce($3,amount), period=coalesce($4,period) where id=$1 and business_id=$2 returning id",
          [id, c.biz.id, b.amount ?? null, b.period ?? null],
        ),
      );
      if (!r[0]) throw notFound("Budget");
      return { ok: true };
    }),
  ],
  [
    "DELETE",
    "budgets/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db((q) => q.query("delete from budgets where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],
  [
    "POST",
    "budgets/reorder",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(z.object({ ids: z.array(uuid).min(1).max(100) }));
      await c.db(async (q) => {
        for (const [i, id] of b.ids.entries())
          await q.query("update budgets set position=$3 where id=$1 and business_id=$2", [id, c.biz.id, i]);
      });
      return { ok: true };
    }),
  ],

  // recurring schedules
  [
    "GET",
    "recurring",
    api(async (c) => {
      const rows = await c.db((q) =>
        q.query(
          `select r.id,r.name,r.direction,r.kind,r.amount,r.currency,r.category_id,ca.name as category_name,r.account_id,r.payee_id,pa.name as payee_name,r.frequency,r.next_due,r.end_date,r.active,r.notes
         from recurring r left join categories ca on ca.id=r.category_id and ca.business_id=r.business_id left join payees pa on pa.id=r.payee_id and pa.business_id=r.business_id
         where r.business_id=$1 order by r.next_due`,
          [c.biz.id],
        ),
      );
      return { items: rows };
    }),
  ],
  [
    "POST",
    "recurring",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1, "Enter a name").max(120),
          direction: z.enum(["in", "out"]).default("out"),
          kind: z
            .enum(["rent", "utilities", "salary", "freelancer", "subscription", "supplier", "shipping", "tax", "other"])
            .default("other"),
          amount: minor,
          category_id: uuid.nullable().optional(),
          account_id: uuid.nullable().optional(),
          payee_id: uuid.nullable().optional(),
          frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
          next_due: isoDate,
          end_date: isoDate.nullable().optional(),
          notes: z.string().max(500).optional(),
        }),
      );
      const r = await c.db((q) =>
        q.query(
          `insert into recurring(business_id,name,direction,kind,amount,currency,category_id,account_id,payee_id,frequency,next_due,end_date,notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
          [
            c.biz.id,
            b.name,
            b.direction,
            b.kind,
            b.amount,
            c.biz.currency,
            b.category_id ?? null,
            b.account_id ?? null,
            b.payee_id ?? null,
            b.frequency,
            b.next_due,
            b.end_date ?? null,
            b.notes ?? null,
          ],
        ),
      );
      return { id: r[0].id };
    }),
  ],
  [
    "PATCH",
    "recurring/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1).max(120).optional(),
          amount: minor.optional(),
          next_due: isoDate.optional(),
          frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
          active: z.boolean().optional(),
          category_id: uuid.nullable().optional(),
          end_date: isoDate.nullable().optional(),
        }),
      );
      const r = await c.db((q) =>
        q.query(
          `update recurring set name=coalesce($3,name), amount=coalesce($4,amount), next_due=coalesce($5,next_due), frequency=coalesce($6,frequency), active=coalesce($7,active),
           category_id = case when $8 = 1 then $9::uuid else category_id end, end_date = case when $10 = 1 then $11::date else end_date end
         where id=$1 and business_id=$2 returning id`,
          [
            id,
            c.biz.id,
            b.name ?? null,
            b.amount ?? null,
            b.next_due ?? null,
            b.frequency ?? null,
            b.active ?? null,
            "category_id" in b ? 1 : 0,
            b.category_id ?? null,
            "end_date" in b ? 1 : 0,
            b.end_date ?? null,
          ],
        ),
      );
      if (!r[0]) throw notFound("Schedule");
      return { ok: true };
    }),
  ],
  [
    "DELETE",
    "recurring/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db((q) => q.query("delete from recurring where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],
  // Records that this occurrence was paid/received. Socio does not move money.
  [
    "POST",
    "recurring/:id/record",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(z.object({ date: isoDate.optional(), amount: minor.optional(), account_id: uuid }));
      const out = await c.db(async (q) => {
        const r = await q.query<any>("select * from recurring where id=$1 and business_id=$2", [id, c.biz.id]);
        if (!r[0]) throw notFound("Schedule");
        const rec = r[0];
        const acc = await q.query<{ currency: string }>(
          "select currency from accounts where id=$1 and business_id=$2",
          [b.account_id, c.biz.id],
        );
        if (!acc[0]) throw badRequest("Choose one of your accounts.", { account_id: "Choose an account" });
        const date = b.date ?? todayISO();
        const t = await q.query<{ id: string }>(
          `insert into transactions(business_id,type,date,amount,currency,account_id,category_id,payee_id,description,recurring_id,created_by,source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual') returning id`,
          [
            c.biz.id,
            rec.direction === "in" ? "income" : "expense",
            date,
            b.amount ?? Number(rec.amount),
            acc[0].currency.trim(),
            b.account_id,
            rec.category_id,
            rec.payee_id,
            rec.name,
            id,
            c.user.id,
          ],
        );
        // Advance to the next occurrence so the forecast never counts this payment twice.
        const anchor = Number(String(rec.next_due).slice(8, 10));
        let next = nextOccurrence(rec.next_due, rec.frequency, anchor);
        const ended = rec.end_date && next > rec.end_date;
        await q.query("update recurring set next_due=$3, active = active and not $4 where id=$1 and business_id=$2", [
          id,
          c.biz.id,
          next,
          !!ended,
        ]);
        return { transaction_id: t[0].id, next_due: next };
      });
      return out;
    }),
  ],

  // invoices (receivables & payables)
  [
    "GET",
    "invoices",
    api(async (c) => {
      const snap = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      const items = snap.invoices
        .map((i) => ({
          ...i,
          paid: Number(i.paid),
          outstanding: invoiceOutstanding(i),
          state: invoiceState(i, snap.today),
        }))
        .sort((a, b) => a.due_date.localeCompare(b.due_date));
      return { items, today: snap.today };
    }),
  ],
  [
    "POST",
    "invoices",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          direction: z.enum(["receivable", "payable"]),
          payee_id: uuid.nullable().optional(),
          number: z.string().trim().max(60).optional(),
          description: z.string().trim().min(1, "Describe what this is for").max(200),
          amount: minor,
          issue_date: isoDate,
          due_date: isoDate,
          category_id: uuid.nullable().optional(),
        }),
      );
      if (b.due_date < b.issue_date)
        throw badRequest("The due date cannot be before the issue date.", {
          due_date: "Due date is before the issue date",
        });
      const r = await c.db((q) =>
        q.query(
          `insert into invoices(business_id,direction,payee_id,number,description,amount,currency,issue_date,due_date,category_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
          [
            c.biz.id,
            b.direction,
            b.payee_id ?? null,
            b.number ?? null,
            b.description,
            b.amount,
            c.biz.currency,
            b.issue_date,
            b.due_date,
            b.category_id ?? null,
          ],
        ),
      );
      return { id: r[0].id };
    }),
  ],
  [
    "PATCH",
    "invoices/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({
          description: z.string().trim().min(1).max(200).optional(),
          amount: minor.optional(),
          due_date: isoDate.optional(),
          status: z.enum(["open", "void"]).optional(),
        }),
      );
      await c.db(async (q) => {
        if (b.amount !== undefined) {
          const paid = await q.query<{ s: number }>(
            "select coalesce(sum(amount),0)::bigint s from invoice_payments where invoice_id=$1 and business_id=$2",
            [id, c.biz.id],
          );
          if (b.amount < Number(paid[0].s))
            throw badRequest("The amount cannot be less than what has already been paid.", {
              amount: "Less than the amount already paid",
            });
        }
        const r = await q.query(
          "update invoices set description=coalesce($3,description), amount=coalesce($4,amount), due_date=coalesce($5,due_date), status=coalesce($6,status) where id=$1 and business_id=$2 returning id",
          [id, c.biz.id, b.description ?? null, b.amount ?? null, b.due_date ?? null, b.status ?? null],
        );
        if (!r[0]) throw notFound("Invoice");
      });
      return { ok: true };
    }),
  ],
  [
    "DELETE",
    "invoices/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db(async (q) => {
        const pays = await q.query<{ transaction_id: string | null }>(
          "select transaction_id from invoice_payments where invoice_id=$1 and business_id=$2",
          [id, c.biz.id],
        );
        const tx = pays.map((p) => p.transaction_id).filter(Boolean);
        if (tx.length)
          throw new ApiError(
            409,
            "has_payments",
            "This invoice has recorded payments. Void it instead, or delete its payments first.",
          );
        await q.query("delete from invoices where id=$1 and business_id=$2", [id, c.biz.id]);
      });
      return { ok: true };
    }),
  ],
  // Records that a payment happened; creates the matching income/expense. Socio does not move money.
  [
    "POST",
    "invoices/:id/payments",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(z.object({ amount: minor, paid_on: isoDate, account_id: uuid }));
      return c.db(async (q) => {
        const inv = await q.query<any>(
          `select i.*, coalesce((select sum(amount) from invoice_payments p where p.invoice_id=i.id),0)::bigint as paid from invoices i where i.id=$1 and i.business_id=$2`,
          [id, c.biz.id],
        );
        if (!inv[0]) throw notFound("Invoice");
        const i = inv[0];
        if (i.status === "void") throw badRequest("This invoice is void.");
        const outstanding = Number(i.amount) - Number(i.paid);
        if (b.amount > outstanding)
          throw badRequest("That is more than the outstanding amount.", {
            amount: "More than the outstanding balance",
          });
        const acc = await q.query<{ currency: string }>(
          "select currency from accounts where id=$1 and business_id=$2",
          [b.account_id, c.biz.id],
        );
        if (!acc[0]) throw badRequest("Choose one of your accounts.", { account_id: "Choose an account" });
        if (acc[0].currency.trim() !== i.currency.trim())
          throw badRequest("The account uses a different currency from the invoice.", {
            account_id: "Different currency",
          });
        let categoryId: string | null = i.category_id;
        if (!categoryId && i.direction === "receivable") {
          const s = await q.query<{ id: string }>(
            "select id from categories where business_id=$1 and name='Sales' and kind='income' limit 1",
            [c.biz.id],
          );
          categoryId = s[0]?.id ?? null;
        }
        const t = await q.query<{ id: string }>(
          `insert into transactions(business_id,type,date,amount,currency,account_id,category_id,payee_id,description,invoice_id,created_by,source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual') returning id`,
          [
            c.biz.id,
            i.direction === "receivable" ? "income" : "expense",
            b.paid_on,
            b.amount,
            i.currency,
            b.account_id,
            categoryId,
            i.payee_id,
            i.description,
            id,
            c.user.id,
          ],
        );
        await q.query(
          "insert into invoice_payments(business_id,invoice_id,amount,paid_on,account_id,transaction_id) values ($1,$2,$3,$4,$5,$6)",
          [c.biz.id, id, b.amount, b.paid_on, b.account_id, t[0].id],
        );
        return { transaction_id: t[0].id, outstanding: outstanding - b.amount };
      });
    }),
  ],

  // goals
  [
    "GET",
    "goals",
    api(async (c) => {
      const snap = await c.db((q) => loadSnapshot(q, c.biz.id, c.biz.currency));
      return { items: snap.goals.map((g) => goalProgress(g, snap)), currency: snap.currency };
    }),
  ],
  [
    "POST",
    "goals",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          type: z.enum(["reserve", "revenue", "profit", "inventory", "cash"]),
          name: z.string().trim().min(1, "Name your goal").max(100),
          target: z.number().int().min(0).max(9e15).default(0),
          target_date: isoDate.nullable().optional(),
          mode: z.enum(["manual", "essentials"]).default("manual"),
          coverage_months: z.number().int().min(1).max(36).nullable().optional(),
          period: period.default("monthly"),
        }),
      );
      if (b.mode === "manual" && b.target <= 0)
        throw badRequest("Enter a target amount.", { target: "Enter a target amount" });
      if (b.mode === "essentials" && (b.type !== "reserve" || !b.coverage_months))
        throw badRequest("Choose how many months of essential expenses to cover.", {
          coverage_months: "Choose months of coverage",
        });
      const r = await c.db((q) =>
        q.query(
          `insert into goals(business_id,type,name,target,target_date,mode,coverage_months,period,position) values ($1,$2,$3,$4,$5,$6,$7,$8,(select coalesce(max(position),-1)+1 from goals where business_id=$1)) returning id`,
          [c.biz.id, b.type, b.name, b.target, b.target_date ?? null, b.mode, b.coverage_months ?? null, b.period],
        ),
      );
      return { id: r[0].id };
    }),
  ],
  [
    "PATCH",
    "goals/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1).max(100).optional(),
          target: z.number().int().min(0).max(9e15).optional(),
          target_date: isoDate.nullable().optional(),
          mode: z.enum(["manual", "essentials"]).optional(),
          coverage_months: z.number().int().min(1).max(36).nullable().optional(),
        }),
      );
      const r = await c.db((q) =>
        q.query(
          `update goals set name=coalesce($3,name), target=coalesce($4,target), mode=coalesce($5,mode),
           target_date = case when $6=1 then $7::date else target_date end, coverage_months = case when $8=1 then $9::int else coverage_months end
         where id=$1 and business_id=$2 returning id`,
          [
            id,
            c.biz.id,
            b.name ?? null,
            b.target ?? null,
            b.mode ?? null,
            "target_date" in b ? 1 : 0,
            b.target_date ?? null,
            "coverage_months" in b ? 1 : 0,
            b.coverage_months ?? null,
          ],
        ),
      );
      if (!r[0]) throw notFound("Goal");
      return { ok: true };
    }),
  ],
  [
    "DELETE",
    "goals/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db((q) => q.query("delete from goals where id=$1 and business_id=$2", [id, c.biz.id]));
      return { ok: true };
    }),
  ],
  // Reserve contributions are planning entries. They do not move money anywhere.
  [
    "POST",
    "goals/:id/contributions",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({
          amount: z
            .number()
            .int()
            .refine((n) => n !== 0, "Enter an amount"),
          made_on: isoDate.optional(),
          note: z.string().max(200).optional(),
        }),
      );
      await c.db(async (q) => {
        const g = await q.query<{ type: string }>("select type from goals where id=$1 and business_id=$2", [
          id,
          c.biz.id,
        ]);
        if (!g[0]) throw notFound("Goal");
        if (g[0].type !== "reserve") throw badRequest("Only reserve goals take contributions.");
        const cur = await q.query<{ s: number }>(
          "select coalesce(sum(amount),0)::bigint s from goal_contributions where goal_id=$1 and business_id=$2",
          [id, c.biz.id],
        );
        if (Number(cur[0].s) + b.amount < 0)
          throw badRequest("That would take the reserve below zero.", { amount: "More than is set aside" });
        await q.query(
          "insert into goal_contributions(business_id,goal_id,amount,made_on,note) values ($1,$2,$3,$4,$5)",
          [c.biz.id, id, b.amount, b.made_on ?? todayISO(), b.note ?? null],
        );
      });
      return { ok: true };
    }),
  ],
];
