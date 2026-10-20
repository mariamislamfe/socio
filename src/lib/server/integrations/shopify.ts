import "server-only";
import crypto from "node:crypto";
import { localDateOf } from "@/lib/finance/dates";
import { toMinor } from "@/lib/finance/money";
import type { Q } from "../db";
import { safeEqual } from "../crypto";

/*
 * Shopify Admin GraphQL integration.
 * Auth (verified against shopify.dev, 2026):
 *  - Any merchant store: authorization code grant with expiring offline tokens (expiring=1 → 60-min access token +
 *    90-day refresh token, rotated on every refresh).
 *  - Stores in the app's own Shopify organization: client credentials grant (24-hour token, re-requested when expired).
 * Admin-created custom apps (paste-a-token) can no longer be created, so they are not supported.
 */

export const SHOPIFY_VERSION = () => process.env.SHOPIFY_API_VERSION || "2026-07";
export const SHOPIFY_SCOPES = () => process.env.SHOPIFY_SCOPES || "read_orders,read_products,read_inventory";
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "REFUNDS_CREATE",
  "PRODUCTS_UPDATE",
  "INVENTORY_LEVELS_UPDATE",
  "APP_UNINSTALLED",
] as const;

export class ProviderAuthError extends Error {}
export class ProviderError extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

/* * Local test double support: in non-production, all shop traffic can be pointed at a fake Shopify. */
export function shopOrigin(shop: string): string {
  const dev = process.env.NODE_ENV !== "production" ? process.env.SHOPIFY_DEV_API_ORIGIN : undefined;
  return dev ? `${dev.replace(/\/+$/, "")}/${shop}` : `https://${shop}`;
}

export function normalizeShop(input: string): string | null {
  let s = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  return SHOP_RE.test(s) ? s : null;
}

export function authorizeUrl(shop: string, state: string, redirectUri: string): string {
  const p = new URLSearchParams({
    client_id: process.env.SHOPIFY_CLIENT_ID!,
    scope: SHOPIFY_SCOPES(),
    redirect_uri: redirectUri,
    state,
  });
  return `${shopOrigin(shop)}/admin/oauth/authorize?${p}`;
}

/* * Validates Shopify's callback query: HMAC over all params except `hmac`, sorted, joined with &. */
export function verifyCallbackHmac(params: URLSearchParams, secret: string): boolean {
  const provided = params.get("hmac");
  if (!provided) return false;
  const msg = [...params.entries()]
    .filter(([k]) => k !== "hmac")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = crypto.createHmac("sha256", secret).update(msg).digest("hex");
  return safeEqual(digest, provided);
}

export function verifyWebhookHmac(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return safeEqual(digest, header);
}

export interface TokenSet {
  access_token: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

async function tokenRequest(shop: string, body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${shopOrigin(shop)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: process.env.SHOPIFY_CLIENT_ID!,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET!,
      ...body,
    }),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    const j: any = await res.json().catch(() => ({}));
    throw new ProviderAuthError(`Shopify refused the token request (${j.error ?? res.status}). Reconnect the store.`);
  }
  if (!res.ok) throw new ProviderError(`Shopify token endpoint returned HTTP ${res.status}`, res.status >= 500);
  const j = (await res.json()) as TokenSet;
  if (!j.access_token) throw new ProviderError("Shopify did not return an access token.");
  return j;
}

/* * Authorization code → expiring offline token pair. */
export const exchangeCode = (shop: string, code: string) => tokenRequest(shop, { code, expiring: "1" });
/* * Rotates the token pair. The previous refresh token stays usable until the new one is used. */
export const refreshAccessToken = (shop: string, refreshToken: string) =>
  tokenRequest(shop, { grant_type: "refresh_token", refresh_token: refreshToken });
/* * Client credentials grant: only for stores in the app's own Shopify organization. */
export const clientCredentialsToken = (shop: string) => tokenRequest(shop, { grant_type: "client_credentials" });

// GraphQL transport with retries

export type Gql = <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeGql(
  shop: string,
  token: string,
  opts: { sleepFn?: (ms: number) => Promise<void>; fetchFn?: typeof fetch } = {},
): Gql {
  const doFetch = opts.fetchFn ?? fetch;
  const wait = opts.sleepFn ?? sleep;
  const url = `${shopOrigin(shop)}/admin/api/${SHOPIFY_VERSION()}/graphql.json`;
  return async (query, variables) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-shopify-access-token": token },
          body: JSON.stringify({ query, variables }),
        });
      } catch (e) {
        lastErr = new ProviderError(`Could not reach Shopify: ${(e as Error).message}`, true);
        await wait(500 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 || res.status === 403)
        throw new ProviderAuthError("Shopify rejected the access token. Reconnect the store.");
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        await wait(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
        lastErr = new ProviderError(`Shopify returned HTTP ${res.status}`, true);
        continue;
      }
      if (!res.ok) throw new ProviderError(`Shopify returned HTTP ${res.status}`);
      const json: any = await res.json();
      if (json.errors?.some((e: any) => e.extensions?.code === "THROTTLED")) {
        await wait(1000 * 2 ** attempt);
        lastErr = new ProviderError("Shopify rate limit reached", true);
        continue;
      }
      if (json.errors?.length) {
        const msg = json.errors.map((e: any) => e.message).join("; ");
        if (/access denied|unauthorized|invalid api key|scope/i.test(msg)) throw new ProviderAuthError(msg);
        throw new ProviderError(msg);
      }
      const ts = json.extensions?.cost?.throttleStatus;
      if (ts && ts.currentlyAvailable < 200)
        await wait(Math.ceil((200 - ts.currentlyAvailable) / (ts.restoreRate || 50)) * 1000);
      return json.data;
    }
    throw lastErr instanceof Error ? lastErr : new ProviderError("Shopify request failed after retries", true);
  };
}

// store identity & webhooks

export interface ShopIdentity {
  id: string;
  name: string;
  myshopifyDomain: string;
  currencyCode: string;
  ianaTimezone: string;
}

export async function fetchShopIdentity(gql: Gql): Promise<ShopIdentity | null> {
  const d: any = await gql("query ShopIdentity { shop { id name myshopifyDomain currencyCode ianaTimezone } }");
  return d?.shop ?? null;
}

export async function listWebhooks(gql: Gql): Promise<{ id: string; topic: string; uri: string }[]> {
  const d: any = await gql("query Subs { webhookSubscriptions(first: 50) { nodes { id topic uri } } }");
  return d?.webhookSubscriptions?.nodes ?? [];
}

/* * Registers each topic once (existing subscriptions to the same URI are reused). */
export async function registerWebhooks(
  gql: Gql,
  uri: string,
): Promise<{ topic: string; ok: boolean; id?: string; error?: string }[]> {
  const existing = await listWebhooks(gql);
  const out: { topic: string; ok: boolean; id?: string; error?: string }[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    const found = existing.find((w) => w.topic === topic && w.uri === uri);
    if (found) {
      out.push({ topic, ok: true, id: found.id });
      continue;
    }
    try {
      const d: any = await gql(
        "mutation Sub($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) { webhookSubscription { id topic uri } userErrors { field message } } }",
        { topic, webhookSubscription: { uri } },
      );
      const errs = d?.webhookSubscriptionCreate?.userErrors ?? [];
      const sub = d?.webhookSubscriptionCreate?.webhookSubscription;
      out.push(
        sub && !errs.length
          ? { topic, ok: true, id: sub.id }
          : { topic, ok: false, error: errs.map((e: any) => e.message).join("; ") || "not created" },
      );
    } catch (e) {
      // A missing scope for one topic must not block the others.
      out.push({ topic, ok: false, error: (e as Error).message });
    }
  }
  return out;
}

export async function deleteWebhooks(gql: Gql, ids: string[]): Promise<{ id: string; ok: boolean; error?: string }[]> {
  const out: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      const d: any = await gql(
        "mutation Del($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } } }",
        { id },
      );
      const errs = d?.webhookSubscriptionDelete?.userErrors ?? [];
      out.push(errs.length ? { id, ok: false, error: errs.map((e: any) => e.message).join("; ") } : { id, ok: true });
    } catch (e) {
      out.push({ id, ok: false, error: (e as Error).message });
    }
  }
  return out;
}

/* * Irreversible: removes the app from the store. Shopify deletes its webhooks and invalidates its tokens. */
export async function uninstallApp(gql: Gql): Promise<{ ok: boolean; error?: string }> {
  const d: any = await gql("mutation Uninstall { appUninstall { app { id } userErrors { field message } } }");
  const errs = d?.appUninstall?.userErrors ?? [];
  return errs.length ? { ok: false, error: errs.map((e: any) => e.message).join("; ") } : { ok: true };
}

// normalization

type Money = { shopMoney: { amount: string; currencyCode?: string } };
export interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  processedAt?: string | null;
  updatedAt: string;
  cancelledAt: string | null;
  test?: boolean;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus?: string | null;
  currencyCode: string;
  totalPriceSet: Money;
  subtotalPriceSet?: Money;
  totalTaxSet: Money;
  totalDiscountsSet?: Money;
  totalShippingPriceSet?: Money;
  totalRefundedSet: Money;
  refunds: { id: string; createdAt: string; totalRefundedSet: Money }[];
  lineItems: {
    nodes: {
      id?: string;
      title?: string;
      sku?: string | null;
      quantity: number;
      currentQuantity?: number;
      originalUnitPriceSet?: Money;
      discountedTotalSet?: Money;
      variant: { id: string; inventoryItem: { unitCost: { amount: string } | null } | null } | null;
    }[];
  };
}

export interface NormalizedTxn {
  external_id: string;
  type: "income" | "refund";
  date: string;
  amount: number;
  currency: string;
  description: string;
  notes: string | null;
  cogs_estimate: number | null;
  cost_missing: boolean;
}

export interface NormalizedOrderRow {
  external_id: string;
  name: string;
  placed_at: string;
  local_date: string;
  updated_at_provider: string;
  cancelled_at: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  currency: string;
  subtotal: number;
  discounts: number;
  shipping: number;
  tax: number;
  total: number;
  refunded: number;
  is_test: boolean;
}
export interface NormalizedLine {
  external_id: string;
  variant_external_id: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  current_quantity: number;
  unit_price: number;
  discounted_total: number;
  unit_cost: number | null;
}

export interface NormalizedOrder {
  order: NormalizedOrderRow;
  lines: NormalizedLine[];
  /* * Ledger records that should exist for this order. */
  txns: NormalizedTxn[];
  /* * Ledger external ids that must not exist (e.g. cancelled orders). */
  remove: string[];
  skipped?: string;
}

const COUNTED = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);

export function normalizeOrder(o: ShopifyOrder, timeZone = "UTC"): NormalizedOrder {
  const cur = o.totalPriceSet.shopMoney.currencyCode ?? o.currencyCode;
  const m = (x?: Money) => (x ? (toMinor(x.shopMoney.amount, cur) ?? 0) : 0);
  const placed = o.processedAt ?? o.createdAt;
  const order: NormalizedOrderRow = {
    external_id: o.id,
    name: o.name,
    placed_at: placed,
    local_date: localDateOf(placed, timeZone),
    updated_at_provider: o.updatedAt,
    cancelled_at: o.cancelledAt,
    financial_status: o.displayFinancialStatus,
    fulfillment_status: o.displayFulfillmentStatus ?? null,
    currency: cur,
    subtotal: m(o.subtotalPriceSet),
    discounts: m(o.totalDiscountsSet),
    shipping: m(o.totalShippingPriceSet),
    tax: m(o.totalTaxSet),
    total: m(o.totalPriceSet),
    refunded: m(o.totalRefundedSet),
    is_test: !!o.test,
  };
  const lines: NormalizedLine[] = o.lineItems.nodes.map((li, i) => {
    const c = li.variant?.inventoryItem?.unitCost?.amount;
    return {
      external_id: li.id ?? `${o.id}#${i}`,
      variant_external_id: li.variant?.id ?? null,
      title: li.title ?? "",
      sku: li.sku ?? null,
      quantity: li.quantity,
      current_quantity: li.currentQuantity ?? li.quantity,
      unit_price: li.originalUnitPriceSet ? (toMinor(li.originalUnitPriceSet.shopMoney.amount, cur) ?? 0) : 0,
      discounted_total: li.discountedTotalSet ? (toMinor(li.discountedTotalSet.shopMoney.amount, cur) ?? 0) : 0,
      unit_cost: c === undefined || c === null ? null : toMinor(c, cur),
    };
  });

  const orderId = `order:${o.id}`;
  if (o.cancelledAt)
    return {
      order,
      lines,
      txns: [],
      remove: [orderId, ...o.refunds.map((r) => `refund:${r.id}`)],
      skipped: "cancelled",
    };
  if (o.test) return { order, lines, txns: [], remove: [orderId], skipped: "test order" };
  if (!o.displayFinancialStatus || !COUNTED.has(o.displayFinancialStatus))
    return {
      order,
      lines,
      txns: [],
      remove: [orderId],
      skipped: `not paid (${o.displayFinancialStatus ?? "unknown"})`,
    };
  const total = toMinor(o.totalPriceSet.shopMoney.amount, cur);
  const tax = m(o.totalTaxSet);
  if (total === null) return { order, lines, txns: [], remove: [], skipped: "unreadable amount" };
  const revenue = total - tax; // tax collected is a liability, not revenue
  const txns: NormalizedTxn[] = [];
  const known = lines.length > 0 && lines.every((l) => l.unit_cost !== null);
  const cogs = known ? lines.reduce((a, l) => a + (l.unit_cost ?? 0) * l.quantity, 0) : null;
  if (revenue > 0) {
    txns.push({
      external_id: orderId,
      type: "income",
      date: order.local_date,
      amount: revenue,
      currency: cur,
      description: `Shopify order ${o.name}`,
      notes: tax > 0 ? `Excludes ${(tax / 100).toFixed(2)} ${cur} sales tax collected` : null,
      cogs_estimate: cogs,
      cost_missing: cogs === null,
    });
  }
  const remove: string[] = revenue > 0 ? [] : [orderId];
  for (const r of o.refunds) {
    const rc = r.totalRefundedSet.shopMoney.currencyCode ?? cur;
    const a = toMinor(r.totalRefundedSet.shopMoney.amount, rc);
    if (a && a > 0)
      txns.push({
        external_id: `refund:${r.id}`,
        type: "refund",
        date: localDateOf(r.createdAt, timeZone),
        amount: a,
        currency: rc,
        description: `Refund — Shopify order ${o.name}`,
        notes: null,
        cogs_estimate: null,
        cost_missing: false,
      });
  }
  return { order, lines, txns, remove };
}

// sync

const ORDERS_QUERY = `
query Orders($cursor: String, $query: String) {
  orders(first: 50, after: $cursor, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt processedAt updatedAt cancelledAt test displayFinancialStatus displayFulfillmentStatus currencyCode
      totalPriceSet { shopMoney { amount currencyCode } }
      subtotalPriceSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      refunds { id createdAt totalRefundedSet { shopMoney { amount currencyCode } } }
      lineItems(first: 100) { nodes { id title sku quantity currentQuantity originalUnitPriceSet { shopMoney { amount } } discountedTotalSet { shopMoney { amount } } variant { id inventoryItem { unitCost { amount } } } } }
    }
  }
}`;

const VARIANTS_QUERY = `
query Variants($cursor: String) {
  productVariants(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id title sku price inventoryQuantity product { title } inventoryItem { unitCost { amount currencyCode } } }
  }
}`;

export interface SyncStats {
  phase: string;
  orders: number;
  imported: number;
  updated: number;
  removed: number;
  unchanged: number;
  skipped: Record<string, number>;
  products: number;
  pages: number;
  watermark: string;
}

/* * Each page commits in its own transaction: progress is visible and a failure resumes idempotently. */
export async function syncShopify(args: {
  tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T>;
  gql: Gql;
  businessId: string;
  businessCurrency: string;
  timeZone: string;
  since?: string | null;
  maxPages?: number;
  onProgress?: (s: SyncStats) => Promise<void> | void;
}): Promise<SyncStats> {
  const { tx, gql, businessId, businessCurrency, timeZone } = args;
  const stats: SyncStats = {
    phase: "orders",
    orders: 0,
    imported: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    skipped: {},
    products: 0,
    pages: 0,
    watermark: new Date().toISOString(),
  };

  const accountFor = async (q: Q, currency: string) => {
    const name = currency === businessCurrency ? "Shopify sales" : `Shopify sales (${currency})`;
    const r = await q.query<{ id: string }>(
      "select id from accounts where business_id=$1 and name=$2 and currency=$3",
      [businessId, name, currency],
    );
    if (r[0]) return r[0].id;
    // Money in Shopify is not spendable until it is paid out to your bank.
    const c = await q.query<{ id: string }>(
      "insert into accounts(business_id,name,type,currency,opening_balance,counts_as_cash) values ($1,$2,'other',$3,0,false) returning id",
      [businessId, name, currency],
    );
    return c[0].id;
  };

  const filter = args.since
    ? `updated_at:>='${new Date(new Date(args.since).getTime() - 5 * 60_000).toISOString()}'`
    : null;
  let cursor: string | null = null;
  for (let page = 0; page < (args.maxPages ?? 200); page++) {
    const data: any = await gql(ORDERS_QUERY, { cursor, query: filter });
    const conn = data.orders;
    await tx(async (q) => {
      const salesCat =
        (
          await q.query<{ id: string }>(
            "select id from categories where business_id=$1 and name='Online store' and kind='income' limit 1",
            [businessId],
          )
        )[0]?.id ?? null;
      for (const o of conn.nodes as ShopifyOrder[]) {
        stats.orders++;
        const hash = crypto
          .createHash("sha256")
          .update(
            JSON.stringify([
              o.updatedAt,
              o.displayFinancialStatus,
              o.cancelledAt,
              o.totalPriceSet,
              o.refunds.length,
              o.lineItems.nodes.length,
            ]),
          )
          .digest("hex");
        const prior = await q.query<{ payload_hash: string }>(
          "select payload_hash from external_records where business_id=$1 and provider='shopify' and kind='order' and external_id=$2",
          [businessId, o.id],
        );
        if (prior[0]?.payload_hash === hash) {
          stats.unchanged++;
          continue;
        }
        const n = normalizeOrder(o, timeZone);
        if (n.skipped) stats.skipped[n.skipped] = (stats.skipped[n.skipped] ?? 0) + 1;

        // 1. normalized order + lines (commerce view)
        const ord = await q.query<{ id: string }>(
          `insert into orders(business_id,provider,external_id,name,placed_at,local_date,updated_at_provider,cancelled_at,financial_status,fulfillment_status,currency,subtotal,discounts,shipping,tax,total,refunded,is_test)
           values ($1,'shopify',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           on conflict (business_id,provider,external_id) do update set name=excluded.name, placed_at=excluded.placed_at, local_date=excluded.local_date, updated_at_provider=excluded.updated_at_provider,
             cancelled_at=excluded.cancelled_at, financial_status=excluded.financial_status, fulfillment_status=excluded.fulfillment_status, subtotal=excluded.subtotal, discounts=excluded.discounts,
             shipping=excluded.shipping, tax=excluded.tax, total=excluded.total, refunded=excluded.refunded, is_test=excluded.is_test
           returning id`,
          [
            businessId,
            n.order.external_id,
            n.order.name,
            n.order.placed_at,
            n.order.local_date,
            n.order.updated_at_provider,
            n.order.cancelled_at,
            n.order.financial_status,
            n.order.fulfillment_status,
            n.order.currency,
            n.order.subtotal,
            n.order.discounts,
            n.order.shipping,
            n.order.tax,
            n.order.total,
            n.order.refunded,
            n.order.is_test,
          ],
        );
        for (const l of n.lines) {
          await q.query(
            `insert into order_lines(business_id,order_id,external_id,variant_external_id,title,sku,quantity,current_quantity,unit_price,discounted_total,unit_cost)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             on conflict (business_id,order_id,external_id) do update set quantity=excluded.quantity, current_quantity=excluded.current_quantity, unit_price=excluded.unit_price,
               discounted_total=excluded.discounted_total, unit_cost=coalesce(order_lines.unit_cost, excluded.unit_cost)`,
            [
              businessId,
              ord[0].id,
              l.external_id,
              l.variant_external_id,
              l.title,
              l.sku,
              l.quantity,
              l.current_quantity,
              l.unit_price,
              l.discounted_total,
              l.unit_cost,
            ],
          );
        }

        // 2. ledger view
        for (const ext of n.remove) {
          const r = await q.query(
            "delete from transactions where business_id=$1 and source='shopify' and external_id=$2 returning id",
            [businessId, ext],
          );
          stats.removed += r.length;
        }
        for (const t of n.txns) {
          const acct = await accountFor(q, t.currency);
          const r = await q.query<{ inserted: boolean }>(
            `insert into transactions(business_id,type,date,amount,currency,account_id,category_id,description,notes,source,external_id,cogs_estimate,cost_missing)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'shopify',$10,$11,$12)
             on conflict (business_id, source, external_id) where external_id is not null
             do update set amount=excluded.amount, date=excluded.date, description=excluded.description, notes=excluded.notes, cogs_estimate=excluded.cogs_estimate, cost_missing=excluded.cost_missing, updated_at=now()
             returning (xmax = 0) as inserted`,
            [
              businessId,
              t.type,
              t.date,
              t.amount,
              t.currency,
              acct,
              salesCat,
              t.description,
              t.notes,
              t.external_id,
              t.cogs_estimate,
              t.cost_missing,
            ],
          );
          if (r[0]?.inserted) stats.imported++;
          else stats.updated++;
        }
        await q.query(
          `insert into external_records(business_id,provider,kind,external_id,payload,payload_hash) values ($1,'shopify','order',$2,$3::text::jsonb,$4)
           on conflict (business_id,provider,kind,external_id) do update set payload=excluded.payload, payload_hash=excluded.payload_hash, received_at=now()`,
          [businessId, o.id, JSON.stringify(slimOrder(o)), hash],
        );
      }
    });
    stats.pages++;
    await args.onProgress?.(stats);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  // Product catalogue and unit costs (needs read_products / read_inventory).
  stats.phase = "products";
  await args.onProgress?.(stats);
  try {
    let vc: string | null = null;
    for (let page = 0; page < 100; page++) {
      const data: any = await gql(VARIANTS_QUERY, { cursor: vc });
      await tx(async (q) => {
        for (const v of data.productVariants.nodes) {
          const cost = v.inventoryItem?.unitCost;
          const costMinor =
            cost && cost.currencyCode === businessCurrency ? toMinor(cost.amount, cost.currencyCode) : null;
          const priceMinor = v.price ? toMinor(v.price, businessCurrency) : null;
          const name = v.title && v.title !== "Default Title" ? `${v.product.title} — ${v.title}` : v.product.title;
          await q.query(
            `insert into products(business_id,name,sku,price,unit_cost,stock,source,external_id) values ($1,$2,$3,$4,$5,$6,'shopify',$7)
             on conflict (business_id,source,external_id) do update set name=excluded.name, sku=excluded.sku, price=excluded.price,
               unit_cost = coalesce(excluded.unit_cost, products.unit_cost), stock=excluded.stock`,
            [businessId, name, v.sku || null, priceMinor, costMinor, v.inventoryQuantity ?? null, v.id],
          );
          stats.products++;
        }
      });
      if (!data.productVariants.pageInfo.hasNextPage) break;
      vc = data.productVariants.pageInfo.endCursor;
    }
  } catch (e) {
    if (e instanceof ProviderAuthError) stats.skipped["products: permission not granted"] = 1;
    else throw e;
  }
  stats.phase = "done";
  await args.onProgress?.(stats);
  return stats;
}

// Persist only what normalisation needs: no customer contact details are requested or stored.
function slimOrder(o: ShopifyOrder) {
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    cancelledAt: o.cancelledAt,
    status: o.displayFinancialStatus,
    total: o.totalPriceSet,
    tax: o.totalTaxSet,
    refunds: o.refunds.map((r) => r.id),
    lines: o.lineItems.nodes.length,
  };
}
