import "server-only";
import { z } from "zod";
import { addMonths, startOfMonth } from "@/lib/finance/dates";
import type { Q as DbQ } from "../db";
import { api, ApiError, isoDate, notFound, params } from "../http";
import type { Route } from "./types";

/*
 * Bills & fixed costs, in three bands: salaries (one row per employee), fixed costs that repeat, and one-off bills.
 * An employee is a monthly schedule of kind "salary", so the forecast, the calendar and the reminders all include
 * salaries with no extra wiring, and paying someone is an ordinary expense linked to that schedule.
 */
type Q = DbQ;

const todayOf = async (q: Q, biz: string) =>
  (
    await q.query<{ d: string }>(
      "select (now() at time zone coalesce((select timezone from businesses where id=$1),'UTC'))::date::text d",
      [biz],
    )
  )[0].d;
const cashAccount = async (q: Q, biz: string, currency: string) => {
  const a = (
    await q.query<{ id: string }>(
      "select id from accounts where business_id=$1 and currency=$2 and archived=false and counts_as_cash is not false order by position, created_at limit 1",
      [biz, currency],
    )
  )[0];
  if (!a) throw new ApiError(422, "no_account", "Add an account first (Settings → Accounts).");
  return a.id;
};
const salaryCategory = async (q: Q, biz: string) =>
  (
    await q.query<{ id: string }>(
      "select id from categories where business_id=$1 and kind='expense' and (role='payroll' or name='Salaries') order by (role='payroll') desc, position limit 1",
      [biz],
    )
  )[0]?.id ?? null;

/* * This month's pay date for a pay day (1–28). */
const payDateIn = (today: string, payDay: number) => addMonths(startOfMonth(today), 0, payDay);
/* * The first pay date on or after today. */
const firstPayDate = (today: string, payDay: number) => {
  const here = payDateIn(today, payDay);
  return here >= today ? here : addMonths(here, 1, payDay);
};

interface Emp {
  id: string;
  name: string;
  notes: string | null;
  amount: string;
  next_due: string;
  last_paid: string | null;
}
function employeeView(r: Emp, today: string) {
  const payDay = Number(String(r.next_due).slice(8, 10));
  const next = String(r.next_due);
  const lastPaid = r.last_paid ? String(r.last_paid) : null;
  // Late if the pay date has passed; paid if a salary was recorded this calendar month; otherwise due on the next pay date.
  const status: "paid" | "due" | "late" =
    next < today ? "late" : lastPaid && lastPaid >= startOfMonth(today) ? "paid" : "due";
  // Paying moves the schedule a month on, so the payment covered the pay date one month before the next one.
  const covered = addMonths(next, -1, payDay);
  return {
    id: r.id,
    name: r.name,
    role: r.notes ?? "",
    salary: Number(r.amount),
    payDay,
    nextDue: next,
    status,
    lastPaid,
    early: status === "paid" && !!lastPaid && lastPaid < covered,
  };
}

async function loadEmployees(q: Q, biz: string, today: string) {
  const rows = await q.query<Emp>(
    `select r.id, r.name, r.notes, r.amount::text, r.next_due::text,
            (select max(t.date)::text from transactions t where t.business_id=r.business_id and t.recurring_id=r.id) last_paid
       from recurring r where r.business_id=$1 and r.kind='salary' and r.active order by r.created_at, r.name`,
    [biz],
  );
  return rows.map((r) => employeeView(r, today));
}

async function paySalary(
  q: Q,
  c: { biz: { id: string; currency: string }; user: { id: string } },
  id: string,
  date: string,
) {
  const r = (
    await q.query<any>("select * from recurring where id=$1 and business_id=$2 and kind='salary' and active", [
      id,
      c.biz.id,
    ])
  )[0];
  if (!r) throw notFound("Employee");
  const acc = await cashAccount(q, c.biz.id, r.currency);
  const t = await q.query<{ id: string }>(
    "insert into transactions(business_id,type,date,amount,currency,account_id,category_id,description,recurring_id,created_by,source) values ($1,'expense',$2,$3,$4,$5,$6,$7,$8,$9,'manual') returning id",
    [c.biz.id, date, r.amount, r.currency, acc, r.category_id, `Salary — ${r.name}`, r.id, c.user.id],
  );
  const payDay = Number(String(r.next_due).slice(8, 10));
  const next = addMonths(String(r.next_due), 1, payDay);
  await q.query("update recurring set next_due=$3 where id=$1 and business_id=$2", [r.id, c.biz.id, next]);
  return { transactionId: t[0].id, nextDue: next };
}

const payDayZ = z.number().int().min(1).max(28);

export const fixedRoutes: Route[] = [
  [
    "GET",
    "fixed",
    api(async (c) => {
      return c.db(async (q) => {
        const today = await todayOf(q, c.biz.id);
        const employees = await loadEmployees(q, c.biz.id, today);
        const fixed = await q.query<any>(
          `select r.id, r.name, r.direction, r.amount::text amount, r.frequency, r.next_due::text next_due, cat.name category
           from recurring r left join categories cat on cat.id=r.category_id and cat.business_id=r.business_id
          where r.business_id=$1 and r.active and r.kind<>'salary' order by r.next_due, r.name`,
          [c.biz.id],
        );
        const bills = await q.query<any>(
          `select i.id, i.direction, coalesce(nullif(i.description,''), i.number, 'Bill') label, i.due_date::text due,
                (i.amount - coalesce((select sum(p.amount) from invoice_payments p where p.invoice_id=i.id),0))::text left_amount
           from invoices i where i.business_id=$1 and i.status='open' and i.currency=$2 order by i.due_date limit 50`,
          [c.biz.id, c.biz.currency],
        );
        const counts = new Map<number, number>();
        for (const e of employees) counts.set(e.payDay, (counts.get(e.payDay) ?? 0) + 1);
        const payDay = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 1;
        const total = employees.reduce((a, e) => a + e.salary, 0);
        const left = employees.filter((e) => e.status !== "paid").reduce((a, e) => a + e.salary, 0);
        return {
          currency: c.biz.currency,
          today,
          salaries: { payDay, employees, total, left, paid: total - left, payDate: payDateIn(today, payDay) },
          fixed: fixed.map((r) => ({
            id: r.id,
            name: r.name,
            direction: r.direction,
            amount: Number(r.amount),
            frequency: r.frequency,
            nextDue: r.next_due,
            category: r.category,
          })),
          bills: bills
            .filter((b) => Number(b.left_amount) > 0)
            .map((b) => ({
              id: b.id,
              label: b.label,
              direction: b.direction,
              amount: Number(b.left_amount),
              due: b.due,
              late: b.due < today,
            })),
        };
      });
    }),
  ],

  [
    "POST",
    "fixed/employees",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1).max(80),
          role: z.string().trim().max(80).optional(),
          salary: z.number().int().min(1).max(9e13),
          payDay: payDayZ.optional(),
        }),
      );
      return c.db(async (q) => {
        const today = await todayOf(q, c.biz.id);
        // A new person joins the team's usual pay day unless another one is given.
        const usual = (
          await q.query<{ d: number }>(
            "select extract(day from next_due)::int d from recurring where business_id=$1 and kind='salary' and active group by 1 order by count(*) desc, 1 limit 1",
            [c.biz.id],
          )
        )[0]?.d;
        const payDay = b.payDay ?? usual ?? 1;
        const acc = await cashAccount(q, c.biz.id, c.biz.currency);
        const cat = await salaryCategory(q, c.biz.id);
        const next = firstPayDate(today, payDay);
        const r = await q.query<{ id: string }>(
          "insert into recurring(business_id,name,direction,kind,amount,currency,category_id,account_id,frequency,next_due,notes) values ($1,$2,'out','salary',$3,$4,$5,$6,'monthly',$7,$8) returning id",
          [c.biz.id, b.name, b.salary, c.biz.currency, cat, acc, next, b.role || null],
        );
        return { id: r[0].id, nextDue: next };
      });
    }),
  ],

  [
    "PATCH",
    "fixed/employees/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(
        z.object({
          name: z.string().trim().min(1).max(80).optional(),
          role: z.string().trim().max(80).optional(),
          salary: z.number().int().min(1).max(9e13).optional(),
          payDay: payDayZ.optional(),
        }),
      );
      return c.db(async (q) => {
        const r = (
          await q.query<any>(
            "select id, next_due::text next_due from recurring where id=$1 and business_id=$2 and kind='salary' and active",
            [id, c.biz.id],
          )
        )[0];
        if (!r) throw notFound("Employee");
        // A new pay day keeps the same month (the next salary just moves within it).
        const next = b.payDay ? addMonths(startOfMonth(r.next_due), 0, b.payDay) : r.next_due;
        await q.query(
          "update recurring set name=coalesce($3,name), notes=case when $4::boolean then $5 else notes end, amount=coalesce($6,amount), next_due=$7 where id=$1 and business_id=$2",
          [id, c.biz.id, b.name ?? null, b.role !== undefined, b.role || null, b.salary ?? null, next],
        );
        return { ok: true, nextDue: next };
      });
    }),
  ],

  // "Paid": one person got their salary, on the usual day or early. It is recorded and their next salary moves a month on.
  [
    "POST",
    "fixed/employees/:id/pay",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const b = await c.body(z.object({ date: isoDate.optional() }));
      return c.db(async (q) => {
        const today = await todayOf(q, c.biz.id);
        const date = b.date ?? today;
        if (date > today)
          throw new ApiError(422, "invalid", "A salary can be recorded today or on a past day, not in the future.", {
            date: "In the future",
          });
        return paySalary(q, c, id, date);
      });
    }),
  ],

  // Everyone not yet paid this month gets paid today (one tap on pay day).
  [
    "POST",
    "fixed/salaries/pay-all",
    api(async (c) => {
      c.requireWrite();
      return c.db(async (q) => {
        const today = await todayOf(q, c.biz.id);
        const due = (await loadEmployees(q, c.biz.id, today)).filter((e) => e.status !== "paid");
        for (const e of due) await paySalary(q, c, e.id, today);
        return { paid: due.length, total: due.reduce((a, e) => a + e.salary, 0) };
      });
    }),
  ],

  // Change everyone's pay day at once (e.g. "everyone gets paid on the 1st").
  [
    "PATCH",
    "fixed/salaries",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(z.object({ payDay: payDayZ }));
      return c.db(async (q) => {
        const rows = await q.query<{ id: string; next_due: string }>(
          "select id, next_due::text next_due from recurring where business_id=$1 and kind='salary' and active",
          [c.biz.id],
        );
        for (const r of rows)
          await q.query("update recurring set next_due=$3 where id=$1 and business_id=$2", [
            r.id,
            c.biz.id,
            addMonths(startOfMonth(r.next_due), 0, b.payDay),
          ]);
        return { updated: rows.length };
      });
    }),
  ],

  // Someone left, or a fixed cost stopped: the schedule ends. Past payments stay in the books.
  [
    "POST",
    "fixed/:id/stop",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      return c.db(async (q) => {
        const today = await todayOf(q, c.biz.id);
        const r = await q.query<{ id: string }>(
          "update recurring set active=false, end_date=$3 where id=$1 and business_id=$2 and active returning id",
          [id, c.biz.id, today],
        );
        if (!r[0]) throw notFound("Schedule");
        return { ok: true };
      });
    }),
  ],
];
