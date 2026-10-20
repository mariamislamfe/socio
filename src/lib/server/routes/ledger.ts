import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { NextResponse } from "next/server";
import type { Q } from "../db";
import { api, ApiError, badRequest, isoDate, minor, notFound, params, uuid } from "../http";
import { parseCsv, parseDateCell, toCsv, detectMapping, type CsvMapping } from "@/lib/csv";
import { currencyDigits, toMinor } from "@/lib/finance/money";
import type { Route } from "./types";

const txnBase = z.object({
  type: z.enum(["income", "expense", "transfer", "refund", "adjustment"]),
  date: isoDate,
  amount: minor,
  account_id: uuid,
  to_account_id: uuid.nullable().optional(),
  category_id: uuid.nullable().optional(),
  payee_id: uuid.nullable().optional(),
  description: z.string().trim().max(200).default(""),
  notes: z.string().trim().max(1000).nullable().optional(),
  direction: z.enum(["in", "out"]).nullable().optional(),
  reconciled: z.boolean().optional(),
  recurring_id: uuid.nullable().optional(),
});
type TxnInput = z.infer<typeof txnBase>;

/* * Business rules that the database cannot express. Returns the currency derived from the account. */
async function validateTxn(q: Q, bizId: string, t: TxnInput): Promise<string> {
  const acc = await q.query<{ id: string; currency: string; archived: boolean }>(
    "select id,currency,archived from accounts where business_id=$1 and id = any($2::uuid[])",
    [bizId, [t.account_id, ...(t.to_account_id ? [t.to_account_id] : [])]],
  );
  const from = acc.find((a) => a.id === t.account_id);
  if (!from) throw badRequest("Choose one of your accounts.", { account_id: "Choose an account" });
  const fields: Record<string, string> = {};
  if (t.type === "transfer") {
    if (!t.to_account_id) fields.to_account_id = "Choose the account receiving the money";
    else if (t.to_account_id === t.account_id) fields.to_account_id = "Choose a different account";
    else {
      const to = acc.find((a) => a.id === t.to_account_id);
      if (!to) fields.to_account_id = "Choose one of your accounts";
      else if (to.currency !== from.currency)
        fields.to_account_id =
          "Accounts use different currencies. Socio does not assume an exchange rate, so record each side as an adjustment.";
    }
    if (t.category_id) fields.category_id = "Transfers between your own accounts have no category";
  } else if (t.to_account_id) fields.to_account_id = "Only transfers have a destination account";
  if (t.type === "adjustment" && !t.direction) fields.direction = "Say whether the adjustment adds or removes cash";
  if (t.type !== "adjustment" && t.direction) fields.direction = "Direction only applies to adjustments";
  if (t.category_id) {
    const c = await q.query<{ kind: string }>("select kind from categories where business_id=$1 and id=$2", [
      bizId,
      t.category_id,
    ]);
    if (!c[0]) fields.category_id = "Choose one of your categories";
    else if (t.type === "income" && c[0].kind !== "income") fields.category_id = "Income needs an income category";
    else if (t.type === "expense" && c[0].kind !== "expense") fields.category_id = "Expenses need an expense category";
    else if (t.type === "adjustment") fields.category_id = "Adjustments have no category";
  }
  if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], fields);
  return from.currency.trim();
}

const SORTS: Record<string, string> = {
  date: "t.date",
  amount: "t.amount",
  description: "t.description",
  created: "t.created_at",
};

const listQuery = z.object({
  q: z.string().max(100).optional(),
  type: z.enum(["income", "expense", "transfer", "refund", "adjustment"]).optional(),
  account: uuid.optional(),
  category: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  source: z.string().max(30).optional(),
  uncategorized: z.enum(["1"]).optional(),
  reconciled: z.enum(["0", "1"]).optional(),
  min: z.coerce.number().int().nonnegative().optional(),
  max: z.coerce.number().int().nonnegative().optional(),
  sort: z.enum(["date", "amount", "description", "created"]).default("date"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function filterSql(f: z.infer<typeof listQuery>, bizId: string) {
  const where = ["t.business_id = $1"];
  const p: unknown[] = [bizId];
  const add = (sql: string, v: unknown) => {
    p.push(v);
    where.push(sql.replaceAll("?", "$" + String(p.length)));
  };
  if (f.q) add("(t.description ilike ? or t.notes ilike ? or pa.name ilike ?)", `%${f.q.replace(/[%_]/g, "\\$&")}%`);
  if (f.type) add("t.type = ?", f.type);
  if (f.account) add("(t.account_id = ? or t.to_account_id = ?)", f.account);
  if (f.category)
    add(
      "t.category_id in (with recursive d as (select id from categories where id = ? and business_id = $1 union all select c.id from categories c join d on c.parent_id = d.id where c.business_id = $1) select id from d)",
      f.category,
    );
  if (f.from) add("t.date >= ?", f.from);
  if (f.to) add("t.date <= ?", f.to);
  if (f.source) add("t.source = ?", f.source);
  if (f.uncategorized) where.push("t.category_id is null and t.type in ('income','expense','refund')");
  if (f.reconciled) add("t.reconciled = ?", f.reconciled === "1");
  if (f.min !== undefined) add("t.amount >= ?", f.min);
  if (f.max !== undefined) add("t.amount <= ?", f.max);
  return { where: where.join(" and "), p };
}

async function invoiceFor(q: Q, bizId: string, id: string) {
  const r = await q.query<any>("select id,direction from invoices where id=$1 and business_id=$2", [id, bizId]);
  return r[0];
}

export const ledgerRoutes: Route[] = [
  [
    "GET",
    "transactions",
    api(async (c) => {
      const f = c.query(listQuery);
      const { where, p } = filterSql(f, c.biz.id);
      const sql = where;
      const rows = await c.db((q) =>
        q.query(
          `select t.id,t.type,t.date,t.amount,t.currency,t.account_id,a.name as account_name,t.to_account_id,ta.name as to_account_name,
                t.category_id,ca.name as category_name,ca.color as category_color,t.payee_id,pa.name as payee_name,t.description,t.notes,t.direction,
                t.source,t.external_id,t.reconciled,t.recurring_id,t.invoice_id,t.cost_missing,t.created_at
         from transactions t
         join accounts a on a.id = t.account_id and a.business_id = t.business_id
         left join accounts ta on ta.id = t.to_account_id and ta.business_id = t.business_id
         left join categories ca on ca.id = t.category_id and ca.business_id = t.business_id
         left join payees pa on pa.id = t.payee_id and pa.business_id = t.business_id
         where ${sql}
         order by ${SORTS[f.sort]} ${f.dir === "asc" ? "asc" : "desc"}, t.created_at desc, t.id
         limit ${f.limit} offset ${f.offset}`,
          p,
        ),
      );
      const totals = await c.db((q) =>
        q.query<{ n: number }>(
          `select count(*)::int n from transactions t left join payees pa on pa.id = t.payee_id and pa.business_id = t.business_id where ${sql}`,
          p,
        ),
      );
      return { items: rows, total: totals[0]?.n ?? 0, limit: f.limit, offset: f.offset };
    }),
  ],

  [
    "POST",
    "transactions",
    api(async (c) => {
      c.requireWrite();
      const t = await c.body(txnBase);
      const row = await c.db(async (q) => {
        const currency = await validateTxn(q, c.biz.id, t);
        const r = await q.query<{ id: string }>(
          `insert into transactions(business_id,type,date,amount,currency,account_id,to_account_id,category_id,payee_id,description,notes,direction,reconciled,recurring_id,created_by,source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'manual') returning id`,
          [
            c.biz.id,
            t.type,
            t.date,
            t.amount,
            currency,
            t.account_id,
            t.to_account_id ?? null,
            t.category_id ?? null,
            t.payee_id ?? null,
            t.description,
            t.notes ?? null,
            t.direction ?? null,
            t.reconciled ?? false,
            t.recurring_id ?? null,
            c.user.id,
          ],
        );
        return r[0];
      });
      return { id: row.id };
    }),
  ],

  [
    "GET",
    "transactions/:id",
    api(async (c) => {
      const { id } = params<{ id: string }>(c);
      const r = await c.db((q) => q.query("select * from transactions where id=$1 and business_id=$2", [id, c.biz.id]));
      if (!r[0]) throw notFound("Transaction");
      return { item: r[0] };
    }),
  ],

  [
    "PATCH",
    "transactions/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      const patch = await c.body(txnBase.partial());
      await c.db(async (q) => {
        const cur = await q.query<any>("select * from transactions where id=$1 and business_id=$2", [id, c.biz.id]);
        if (!cur[0]) throw notFound("Transaction");
        if (
          cur[0].source !== "manual" &&
          (patch.amount !== undefined ||
            patch.date !== undefined ||
            patch.type !== undefined ||
            patch.account_id !== undefined)
        ) {
          throw new ApiError(
            409,
            "imported_record",
            "Imported records keep their original amount, date and account so they stay in sync with the source. You can still change the category, payee and notes.",
          );
        }
        const merged: TxnInput = {
          type: patch.type ?? cur[0].type,
          date: patch.date ?? cur[0].date,
          amount: patch.amount ?? Number(cur[0].amount),
          account_id: patch.account_id ?? cur[0].account_id,
          to_account_id: "to_account_id" in patch ? patch.to_account_id : cur[0].to_account_id,
          category_id: "category_id" in patch ? patch.category_id : cur[0].category_id,
          payee_id: "payee_id" in patch ? patch.payee_id : cur[0].payee_id,
          description: patch.description ?? cur[0].description,
          notes: "notes" in patch ? patch.notes : cur[0].notes,
          direction: "direction" in patch ? patch.direction : cur[0].direction,
          reconciled: patch.reconciled ?? cur[0].reconciled,
        };
        if (merged.type === "transfer") merged.category_id = null;
        if (merged.type !== "transfer") merged.to_account_id = null;
        if (merged.type !== "adjustment") merged.direction = null;
        const currency = await validateTxn(q, c.biz.id, merged);
        await q.query(
          `update transactions set type=$3,date=$4,amount=$5,currency=$6,account_id=$7,to_account_id=$8,category_id=$9,payee_id=$10,description=$11,notes=$12,direction=$13,reconciled=$14,updated_at=now()
         where id=$1 and business_id=$2`,
          [
            id,
            c.biz.id,
            merged.type,
            merged.date,
            merged.amount,
            currency,
            merged.account_id,
            merged.to_account_id ?? null,
            merged.category_id ?? null,
            merged.payee_id ?? null,
            merged.description,
            merged.notes ?? null,
            merged.direction ?? null,
            merged.reconciled ?? false,
          ],
        );
      });
      return { ok: true };
    }),
  ],

  [
    "DELETE",
    "transactions/:id",
    api(async (c) => {
      c.requireWrite();
      const { id } = params<{ id: string }>(c);
      await c.db(async (q) => {
        const cur = await q.query<any>("select id, source from transactions where id=$1 and business_id=$2", [
          id,
          c.biz.id,
        ]);
        if (!cur[0]) throw notFound("Transaction");
        // A payment recorded against an invoice goes with its transaction so the amount becomes outstanding again.
        await q.query("delete from invoice_payments where transaction_id=$1 and business_id=$2", [id, c.biz.id]);
        await q.query("delete from transactions where id=$1 and business_id=$2", [id, c.biz.id]);
      });
      return { ok: true };
    }),
  ],

  [
    "POST",
    "transactions/bulk",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          ids: z.array(uuid).min(1).max(500),
          action: z.enum(["categorize", "delete", "reconcile"]),
          category_id: uuid.nullable().optional(),
          reconciled: z.boolean().optional(),
        }),
      );
      const n = await c.db(async (q) => {
        if (b.action === "delete") {
          await q.query("delete from invoice_payments where business_id=$1 and transaction_id = any($2::uuid[])", [
            c.biz.id,
            b.ids,
          ]);
          const r = await q.query(
            "delete from transactions where business_id=$1 and id = any($2::uuid[]) returning id",
            [c.biz.id, b.ids],
          );
          return r.length;
        }
        if (b.action === "reconcile") {
          const r = await q.query(
            "update transactions set reconciled=$3 where business_id=$1 and id = any($2::uuid[]) returning id",
            [c.biz.id, b.ids, b.reconciled ?? true],
          );
          return r.length;
        }
        if (b.category_id) {
          const cat = await q.query<{ kind: string }>("select kind from categories where id=$1 and business_id=$2", [
            b.category_id,
            c.biz.id,
          ]);
          if (!cat[0]) throw badRequest("Choose one of your categories.");
          const okType = cat[0].kind === "income" ? "('income','refund')" : "('expense','refund')";
          const r = await q.query(
            `update transactions set category_id=$3 where business_id=$1 and id = any($2::uuid[]) and type in ${okType} returning id`,
            [c.biz.id, b.ids, b.category_id],
          );
          return r.length;
        }
        const r = await q.query(
          "update transactions set category_id=null where business_id=$1 and id = any($2::uuid[]) returning id",
          [c.biz.id, b.ids],
        );
        return r.length;
      });
      return { updated: n };
    }),
  ],

  // CSV import
  [
    "POST",
    "import/csv",
    api(async (c) => {
      c.requireWrite();
      const b = await c.body(
        z.object({
          csv: z.string().min(1, "The file is empty").max(5_000_000, "File is too large (5 MB max)"),
          account_id: uuid,
          commit: z.boolean().default(false),
          dayFirst: z.boolean().default(true),
          invertSign: z.boolean().default(false),
          mapping: z
            .object({
              date: z.number().int().min(0),
              description: z.number().int().min(0),
              amount: z.number().int().min(0).optional(),
              debit: z.number().int().min(0).optional(),
              credit: z.number().int().min(0).optional(),
              category: z.number().int().min(0).optional(),
            })
            .optional(),
        }),
      );
      const rows = parseCsv(b.csv);
      if (rows.length < 2) throw badRequest("The file needs a header row and at least one record.");
      if (rows.length > 20_001) throw badRequest("Please import up to 20,000 rows at a time.");
      const header = rows[0];
      const detected = detectMapping(header);
      const mapping =
        b.mapping ??
        (detected.date !== undefined &&
        detected.description !== undefined &&
        (detected.amount !== undefined || (detected.debit !== undefined && detected.credit !== undefined))
          ? (detected as CsvMapping)
          : null);
      if (!mapping) return { needsMapping: true, header, detected, sample: rows.slice(1, 6) };
      const acct = await c.db((q) =>
        q.query<{ id: string; currency: string }>("select id,currency from accounts where id=$1 and business_id=$2", [
          b.account_id,
          c.biz.id,
        ]),
      );
      if (!acct[0]) throw badRequest("Choose one of your accounts.");
      const currency = acct[0].currency.trim();
      const cats = await c.db((q) =>
        q.query<{ id: string; name: string; kind: string }>(
          "select id,name,kind from categories where business_id=$1 and not archived",
          [c.biz.id],
        ),
      );
      const catBy = new Map(cats.map((x) => [`${x.kind}:${x.name.toLowerCase()}`, x.id]));

      type Parsed = {
        line: number;
        date: string;
        amount: number;
        type: "income" | "expense";
        description: string;
        category_id: string | null;
        key: string;
      };
      const ok: Parsed[] = [];
      const errors: { line: number; message: string }[] = [];
      const seen = new Map<string, number>();
      rows.slice(1).forEach((r, idx) => {
        const line = idx + 2;
        const date = parseDateCell(r[mapping.date] ?? "", b.dayFirst);
        if (!date) return errors.push({ line, message: `Unrecognised date "${r[mapping.date] ?? ""}"` });
        let signed: number | null = null;
        if (mapping.amount !== undefined) signed = toMinor(r[mapping.amount] ?? "", currency);
        else {
          const d = toMinor(r[mapping.debit!] ?? "0", currency) ?? 0;
          const cr = toMinor(r[mapping.credit!] ?? "0", currency) ?? 0;
          signed = cr - d;
        }
        if (signed === null || signed === 0)
          return errors.push({
            line,
            message: `Missing or invalid amount "${r[mapping.amount ?? mapping.credit!] ?? ""}"`,
          });
        if (b.invertSign) signed = -signed;
        const type = signed > 0 ? "income" : "expense";
        const description = (r[mapping.description] ?? "").trim().slice(0, 200);
        const catName = mapping.category !== undefined ? (r[mapping.category] ?? "").trim().toLowerCase() : "";
        const base = `${b.account_id}|${date}|${signed}|${description}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        ok.push({
          line,
          date,
          amount: Math.abs(signed),
          type,
          description,
          category_id: catName ? (catBy.get(`${type}:${catName}`) ?? null) : null,
          key: crypto.createHash("sha256").update(`${base}|${n}`).digest("hex").slice(0, 40),
        });
      });
      const preview = {
        total: rows.length - 1,
        valid: ok.length,
        errors: errors.slice(0, 20),
        errorCount: errors.length,
        income: ok.filter((x) => x.type === "income").reduce((a, x) => a + x.amount, 0),
        expenses: ok.filter((x) => x.type === "expense").reduce((a, x) => a + x.amount, 0),
        sample: ok.slice(0, 8),
        mapping,
        header,
      };
      if (!b.commit) return { preview };
      if (!ok.length) throw badRequest("No valid rows to import.");
      const batch = crypto.randomUUID();
      let inserted = 0;
      await c.db(async (q) => {
        for (let i = 0; i < ok.length; i += 200) {
          const chunk = ok.slice(i, i + 200);
          const params: unknown[] = [c.biz.id, b.account_id, currency, batch, c.user.id];
          const vals = chunk.map((x) => {
            const o = params.length;
            params.push(x.type, x.date, x.amount, x.description, x.category_id, x.key);
            return `($1,$${o + 1},$${o + 2},$${o + 3},$3,$2,$${o + 5},$${o + 4},'csv',$${o + 6},$4,$5)`;
          });
          const r = await q.query(
            `insert into transactions(business_id,type,date,amount,currency,account_id,category_id,description,source,external_id,import_batch_id,created_by)
           values ${vals.join(",")} on conflict (business_id, source, external_id) where external_id is not null do nothing returning id`,
            params,
          );
          inserted += r.length;
        }
      });
      return {
        imported: inserted,
        skippedDuplicates: ok.length - inserted,
        rejected: errors.length,
        batch,
        digits: currencyDigits(currency),
      };
    }),
  ],

  // export
  [
    "GET",
    "export/transactions",
    api(async (c) => {
      const rows = await c.db((q) =>
        q.query<any>(
          `select t.date,t.type,t.amount,t.currency,a.name account,ta.name to_account,ca.name category,pa.name payee,t.description,t.notes,t.source,t.reconciled
         from transactions t join accounts a on a.id=t.account_id and a.business_id=t.business_id
         left join accounts ta on ta.id=t.to_account_id and ta.business_id=t.business_id
         left join categories ca on ca.id=t.category_id and ca.business_id=t.business_id
         left join payees pa on pa.id=t.payee_id and pa.business_id=t.business_id
         where t.business_id=$1 order by t.date, t.created_at`,
          [c.biz.id],
        ),
      );
      const d = currencyDigits(c.biz.currency);
      const csv = toCsv([
        [
          "date",
          "type",
          "amount",
          "currency",
          "account",
          "to_account",
          "category",
          "payee",
          "description",
          "notes",
          "source",
          "reconciled",
        ],
        ...rows.map((r) => [
          r.date,
          r.type,
          (Number(r.amount) / 10 ** d).toFixed(d),
          r.currency.trim(),
          r.account,
          r.to_account,
          r.category,
          r.payee,
          r.description,
          r.notes,
          r.source,
          r.reconciled ? "yes" : "no",
        ]),
      ]);
      return new NextResponse(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="margin-transactions.csv"`,
        },
      });
    }),
  ],
  [
    "GET",
    "export/all",
    api(async (c) => {
      const tables = [
        "accounts",
        "categories",
        "payees",
        "transactions",
        "budgets",
        "recurring",
        "invoices",
        "invoice_payments",
        "goals",
        "goal_contributions",
        "products",
      ];
      const out: Record<string, unknown> = {
        exported_at: new Date().toISOString(),
        business: { id: c.biz.id, name: c.biz.name, currency: c.biz.currency },
      };
      for (const t of tables)
        out[t] = await c.db((q) => q.query(`select * from ${t} where business_id=$1`, [c.biz.id]));
      return new NextResponse(JSON.stringify(out, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="margin-export.json"`,
        },
      });
    }),
  ],
];

export { invoiceFor };
