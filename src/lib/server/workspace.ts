import "server-only";
import { addDays, todayIn } from "@/lib/finance/dates";
import type { Account, Budget, Cat, Invoice, Recurring, Txn } from "@/lib/finance/engine";
import type { AdDay, GoalRow, Snapshot } from "@/lib/finance/snapshot";
import { asService, type Q } from "./db";

type SeedCat = {
  name: string;
  kind: "income" | "expense";
  cost_type?: "cogs" | "opex";
  role?: string;
  essential?: boolean;
  color: string;
  children?: string[];
};

const SEED_CATEGORIES: SeedCat[] = [
  { name: "Sales", kind: "income", color: "#2f7d5b", children: ["Online store", "Marketplace", "Wholesale"] },
  { name: "Services", kind: "income", color: "#3d8f7a" },
  { name: "Other income", kind: "income", color: "#7aa393" },
  { name: "Inventory & materials", kind: "expense", cost_type: "cogs", role: "inventory", color: "#a8742b" },
  { name: "Packaging", kind: "expense", cost_type: "cogs", color: "#c29a4b" },
  {
    name: "Marketing & advertising",
    kind: "expense",
    cost_type: "opex",
    role: "ads",
    color: "#b4513a",
    children: ["Social ads", "Search ads", "Influencers", "Content"],
  },
  { name: "Shipping & delivery", kind: "expense", cost_type: "opex", role: "shipping", color: "#4f6d8a" },
  { name: "Salaries", kind: "expense", cost_type: "opex", role: "payroll", essential: true, color: "#5b4f8a" },
  { name: "Freelancers", kind: "expense", cost_type: "opex", role: "payroll", color: "#7d6fb0" },
  { name: "Rent", kind: "expense", cost_type: "opex", role: "rent", essential: true, color: "#8a6a4f" },
  { name: "Utilities", kind: "expense", cost_type: "opex", essential: true, color: "#6d8a8a" },
  { name: "Software & subscriptions", kind: "expense", cost_type: "opex", role: "software", color: "#4a7f9c" },
  { name: "Payment & platform fees", kind: "expense", cost_type: "opex", color: "#8a8a4f" },
  { name: "Taxes", kind: "expense", cost_type: "opex", role: "tax", color: "#7a4f4f" },
  { name: "Operations & other", kind: "expense", cost_type: "opex", color: "#6b7a72" },
  { name: "Owner's pay", kind: "expense", role: "owner_draw", color: "#2f5d7d" },
];

export async function seedCategories(q: Q, businessId: string) {
  let pos = 0;
  for (const c of SEED_CATEGORIES) {
    const r = await q.query<{ id: string }>(
      `insert into categories(business_id,name,kind,cost_type,role,essential,color,is_system,position)
       values ($1,$2,$3,$4,$5,$6,$7,true,$8) returning id`,
      [businessId, c.name, c.kind, c.cost_type ?? null, c.role ?? null, c.essential ?? false, c.color, pos++],
    );
    for (const child of c.children ?? []) {
      await q.query(
        `insert into categories(business_id,name,kind,cost_type,color,parent_id,is_system,position)
         values ($1,$2,$3,$4,$5,$6,true,$7)`,
        [businessId, child, c.kind, c.cost_type ?? null, c.color, r[0].id, pos++],
      );
    }
  }
}

export interface NewBusiness {
  name: string;
  business_type: string;
  country: string;
  currency: string;
  stage: string;
  channels: string[];
  has_history: boolean;
  setup_mode: "manual" | "csv" | "shopify" | "demo";
  is_demo?: boolean;
  locale?: string;
}

/* * Creates a workspace, its owner membership, starter categories and a first account. Server-side only. */
export async function createBusiness(userId: string, b: NewBusiness): Promise<string> {
  return asService(async (q) => {
    const r = await q.query<{ id: string }>(
      `insert into businesses(name,business_type,country,currency,stage,channels,has_history,setup_mode,is_demo,locale,created_by,onboarding)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::jsonb) returning id`,
      [
        b.name,
        b.business_type,
        b.country,
        b.currency,
        b.stage,
        b.channels,
        b.has_history,
        b.setup_mode,
        b.is_demo ?? false,
        b.locale ?? "en",
        userId,
        JSON.stringify({ done: [] }),
      ],
    );
    const id = r[0].id;
    await q.query("insert into memberships(business_id,user_id,role) values ($1,$2,'owner')", [id, userId]);
    await seedCategories(q, id);
    return id;
  });
}

const DAYS_BACK = 760;

/* * Loads everything the deterministic engines need, through RLS as the signed-in user. */
export async function loadSnapshot(q: Q, businessId: string, currency: string, todayArg?: string): Promise<Snapshot> {
  // "Today" is the business's own calendar day, in its timezone.
  const today =
    todayArg ??
    todayIn(
      (await q.query<{ timezone: string }>("select timezone from businesses where id=$1", [businessId]))[0]?.timezone ??
        "UTC",
    );
  const since = addDays(today, -DAYS_BACK);
  const [accounts, cats, txns, budgets, recurring, invoices, goals, ads, prod] = await Promise.all([
    q.query<Account>(
      "select id,name,type,currency,opening_balance,archived,counts_as_cash from accounts where business_id=$1 order by position, created_at",
      [businessId],
    ),
    q.query<Cat>(
      "select id,name,kind,cost_type,parent_id,essential,role,color from categories where business_id=$1 and not archived order by position",
      [businessId],
    ),
    q.query<Txn>(
      `select id,type,date,amount,currency,account_id,to_account_id,category_id,payee_id,direction,description,source,recurring_id,invoice_id,cogs_estimate,cost_missing
       from transactions where business_id=$1 and date >= $2 order by date`,
      [businessId, since],
    ),
    q.query<Budget>(
      "select id,category_id,period,amount,position from budgets where business_id=$1 order by position",
      [businessId],
    ),
    q.query<Recurring>(
      "select id,name,direction,kind,amount,currency,category_id,payee_id,frequency,next_due,end_date,active from recurring where business_id=$1",
      [businessId],
    ),
    q.query<any>(
      `select i.id,i.direction,i.payee_id,p.name as payee_name,i.number,i.description,i.amount,i.currency,i.issue_date,i.due_date,i.category_id,i.status,
              coalesce((select sum(ip.amount) from invoice_payments ip where ip.invoice_id = i.id),0)::bigint as paid
       from invoices i left join payees p on p.id = i.payee_id where i.business_id=$1`,
      [businessId],
    ),
    q.query<GoalRow>(
      `select g.id,g.type,g.name,g.target,g.target_date,g.mode,g.coverage_months,g.period,g.achieved_at,
              coalesce((select sum(c.amount) from goal_contributions c where c.goal_id = g.id),0)::bigint as contributed
       from goals g where g.business_id=$1 order by g.position, g.created_at`,
      [businessId],
    ),
    q.query<AdDay>(
      "select provider,date,campaign_id,campaign_name,spend,impressions,clicks,conversions,attributed_revenue,currency from ad_metrics where business_id=$1 and date >= $2",
      [businessId, since],
    ),
    q.query<{ n: number; nocost: number }>(
      "select count(*)::int n, count(*) filter (where unit_cost is null)::int nocost from products where business_id=$1",
      [businessId],
    ),
  ]);
  return {
    today,
    currency,
    accounts,
    cats,
    txns,
    budgets,
    recurring: recurring as Recurring[],
    invoices: invoices as Invoice[],
    goals,
    ads,
    productCount: prod[0]?.n ?? 0,
    productsWithoutCost: prod[0]?.nocost ?? 0,
  };
}
