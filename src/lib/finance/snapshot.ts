import type { Account, Budget, Cat, Invoice, Recurring, Txn } from "./engine";
import type { ISODate } from "./dates";

export interface GoalRow {
  id: string;
  type: "reserve" | "revenue" | "profit" | "inventory" | "cash";
  name: string;
  target: number;
  target_date: ISODate | null;
  mode: "manual" | "essentials";
  coverage_months: number | null;
  period: "monthly" | "quarterly" | "yearly";
  contributed: number;
  achieved_at?: string | null;
}

export interface AdDay {
  provider: string;
  date: ISODate;
  campaign_id: string;
  campaign_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  attributed_revenue: number;
  currency: string;
}

/* * Everything the deterministic engines need, loaded for one business through RLS. */
export interface Snapshot {
  today: ISODate;
  currency: string;
  accounts: Account[];
  cats: Cat[];
  txns: Txn[];
  budgets: Budget[];
  recurring: Recurring[];
  invoices: Invoice[];
  goals: GoalRow[];
  ads: AdDay[];
  productsWithoutCost: number;
  productCount: number;
}
