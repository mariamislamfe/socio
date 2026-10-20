import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "margin-shop-")) + "/db";
process.env.SHOPIFY_CLIENT_ID = "test-client";
process.env.SHOPIFY_CLIENT_SECRET = "shhh-secret";
process.env.MARGIN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
delete process.env.SUPABASE_DB_URL;

const { asService } = await import("@/lib/server/db");
const shopify = await import("@/lib/server/integrations/shopify");
const manager = await import("@/lib/server/integrations/manager");
const { createBusiness } = await import("@/lib/server/workspace");

const order = (id: number, over: Record<string, any> = {}) => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${1000 + id}`,
  createdAt: "2026-10-05T10:00:00Z",
  updatedAt: "2026-10-05T10:00:00Z",
  cancelledAt: null,
  test: false,
  displayFinancialStatus: "PAID",
  currencyCode: "EGP",
  totalPriceSet: { shopMoney: { amount: "1140.00", currencyCode: "EGP" } },
  totalTaxSet: { shopMoney: { amount: "140.00" } },
  totalRefundedSet: { shopMoney: { amount: "0.00" } },
  refunds: [],
  lineItems: {
    nodes: [
      {
        quantity: 2,
        variant: { id: "gid://shopify/ProductVariant/1", inventoryItem: { unitCost: { amount: "150.00" } } },
      },
    ],
  },
  ...over,
});

describe("Shopify authorization primitives", () => {
  it("validates only well-formed myshopify.com domains", () => {
    expect(shopify.normalizeShop("My-Store")).toBe("my-store.myshopify.com");
    expect(shopify.normalizeShop("https://shop.myshopify.com/admin")).toBe("shop.myshopify.com");
    expect(shopify.normalizeShop("evil.com/shop.myshopify.com")).toBe(null);
    expect(shopify.normalizeShop("shop.myshopify.com.evil.com")).toBe(null);
  });

  it("verifies the OAuth callback HMAC (sorted params, hmac excluded)", () => {
    const p = new URLSearchParams({ code: "abc", shop: "s.myshopify.com", state: "xyz", timestamp: "1700000000" });
    const msg = [...p.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    p.set("hmac", crypto.createHmac("sha256", "shhh-secret").update(msg).digest("hex"));
    expect(shopify.verifyCallbackHmac(p, "shhh-secret")).toBe(true);
    p.set("code", "tampered");
    expect(shopify.verifyCallbackHmac(p, "shhh-secret")).toBe(false);
    expect(shopify.verifyCallbackHmac(new URLSearchParams({ code: "x" }), "shhh-secret")).toBe(false);
  });

  it("verifies webhook signatures over the raw body", () => {
    const body = JSON.stringify({ id: 1 });
    const sig = crypto.createHmac("sha256", "shhh-secret").update(body).digest("base64");
    expect(shopify.verifyWebhookHmac(body, sig, "shhh-secret")).toBe(true);
    expect(shopify.verifyWebhookHmac(body + " ", sig, "shhh-secret")).toBe(false);
    expect(shopify.verifyWebhookHmac(body, null, "shhh-secret")).toBe(false);
  });

  it("builds an authorize URL carrying state, scopes and redirect", () => {
    const u = new URL(shopify.authorizeUrl("s.myshopify.com", "STATE", "https://app.test/cb"));
    expect(u.host).toBe("s.myshopify.com");
    expect(u.pathname).toBe("/admin/oauth/authorize");
    expect(u.searchParams.get("state")).toBe("STATE");
    expect(u.searchParams.get("client_id")).toBe("test-client");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.test/cb");
  });
});

describe("order normalisation", () => {
  it("excludes tax from revenue and estimates cost only when every unit cost is known", () => {
    const n = shopify.normalizeOrder(order(1) as any);
    expect(n.txns).toHaveLength(1);
    expect(n.txns[0]).toMatchObject({
      type: "income",
      amount: 100_000,
      cogs_estimate: 30_000,
      cost_missing: false,
      date: "2026-10-05",
    });
    const missing = shopify.normalizeOrder(
      order(2, {
        lineItems: { nodes: [{ quantity: 1, variant: { id: "v", inventoryItem: { unitCost: null } } }] },
      }) as any,
    );
    expect(missing.txns[0].cogs_estimate).toBeNull();
    expect(missing.txns[0].cost_missing).toBe(true);
  });
  it("drops cancelled, test and unpaid orders and emits refunds as separate records", () => {
    expect(shopify.normalizeOrder(order(3, { cancelledAt: "2026-10-06T00:00:00Z" }) as any).txns).toHaveLength(0);
    expect(shopify.normalizeOrder(order(4, { test: true }) as any).txns).toHaveLength(0);
    expect(shopify.normalizeOrder(order(5, { displayFinancialStatus: "PENDING" }) as any).txns).toHaveLength(0);
    const r = shopify.normalizeOrder(
      order(6, {
        displayFinancialStatus: "PARTIALLY_REFUNDED",
        refunds: [
          {
            id: "gid://shopify/Refund/9",
            createdAt: "2026-10-07T00:00:00Z",
            totalRefundedSet: { shopMoney: { amount: "200.00", currencyCode: "EGP" } },
          },
        ],
      }) as any,
    );
    expect(r.txns.map((t) => [t.type, t.amount])).toEqual([
      ["income", 100_000],
      ["refund", 20_000],
    ]);
  });
});

describe("sync pipeline against Postgres", () => {
  let bizId = "";
  let integrationId = "";
  const state = {
    orders: [order(1), order(2, { createdAt: "2026-10-06T09:00:00Z" })] as any[],
    mode: "ok" as "ok" | "reauth" | "error",
    calls: 0,
  };

  beforeAll(async () => {
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      state.calls++;
      if (state.mode === "reauth") return new Response("{}", { status: 401 });
      if (state.mode === "error")
        return new Response(JSON.stringify({ errors: [{ message: "Internal explosion" }] }), { status: 200 });
      const q: string = JSON.parse(init.body).query;
      const data = q.includes("productVariants")
        ? {
            productVariants: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "gid://shopify/ProductVariant/1",
                  title: "Default Title",
                  sku: "SKU1",
                  price: "570.00",
                  inventoryQuantity: 7,
                  product: { title: "Linen shirt" },
                  inventoryItem: { unitCost: { amount: "150.00", currencyCode: "EGP" } },
                },
              ],
            },
          }
        : { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.orders } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const userId = (
      await asService((q) => q.query<{ id: string }>("insert into auth.users(email) values ('s@x.test') returning id"))
    )[0].id;
    bizId = await createBusiness(userId, {
      name: "Shop Co",
      business_type: "fashion",
      country: "EG",
      currency: "EGP",
      stage: "early",
      channels: [],
      has_history: false,
      setup_mode: "shopify",
    });
    await asService(async (q) => {
      integrationId = (
        await q.query<{ id: string }>(
          "insert into integrations(business_id,provider,status,external_account) values ($1,'shopify','connected','shop-co.myshopify.com') returning id",
          [bizId],
        )
      )[0].id;
    });
    await manager.saveSecret(integrationId, bizId, "shpat_test_token");
  });

  const count = async (sql: string) => (await asService((q) => q.query<{ n: number }>(sql, [bizId])))[0].n;

  it("imports orders and products and marks the integration connected", async () => {
    const r = await manager.runSync(integrationId, "initial");
    expect(r.ok).toBe(true);
    expect(await count("select count(*)::int n from transactions where business_id=$1 and source='shopify'")).toBe(2);
    expect(await count("select count(*)::int n from products where business_id=$1")).toBe(1);
    const i = (
      await asService((q) =>
        q.query<any>("select status,last_sync_status,last_error from integrations where id=$1", [integrationId]),
      )
    )[0];
    expect(i).toMatchObject({ status: "connected", last_sync_status: "success", last_error: null });
    const run = (
      await asService((q) =>
        q.query<any>(
          "select status,records_imported from sync_runs where integration_id=$1 order by started_at desc limit 1",
          [integrationId],
        ),
      )
    )[0];
    expect(run).toMatchObject({ status: "success", records_imported: 2 });
  });

  it("is idempotent: re-syncing creates no duplicates", async () => {
    await manager.runSync(integrationId, "manual");
    expect(await count("select count(*)::int n from transactions where business_id=$1 and source='shopify'")).toBe(2);
    expect(
      await count("select count(*)::int n from external_records where business_id=$1 and provider='shopify'"),
    ).toBe(2);
  });

  it("applies later cancellations and refunds from Shopify", async () => {
    state.orders = [
      order(1, { updatedAt: "2026-10-08T00:00:00Z", cancelledAt: "2026-10-08T00:00:00Z" }),
      order(2, {
        updatedAt: "2026-10-08T00:00:00Z",
        displayFinancialStatus: "PARTIALLY_REFUNDED",
        refunds: [
          {
            id: "gid://shopify/Refund/1",
            createdAt: "2026-10-08T00:00:00Z",
            totalRefundedSet: { shopMoney: { amount: "100.00", currencyCode: "EGP" } },
          },
        ],
      }),
    ];
    await manager.runSync(integrationId, "webhook");
    const rows = await asService((q) =>
      q.query<any>(
        "select type,amount,external_id from transactions where business_id=$1 and source='shopify' order by type",
        [bizId],
      ),
    );
    expect(rows.map((r: any) => r.type)).toEqual(["income", "refund"]);
    expect(rows.every((r: any) => !r.external_id.includes("Order/1"))).toBe(true);
    // Imported refund reduces revenue; transactions use a dedicated Shopify account, never the user's bank.
    const acct = await asService((q) =>
      q.query<any>(
        "select distinct a.name from transactions t join accounts a on a.id=t.account_id where t.business_id=$1 and t.source='shopify'",
        [bizId],
      ),
    );
    expect(acct.map((a: any) => a.name)).toEqual(["Shopify sales"]);
  });

  it("reports an honest failed state and a notification, then recovers on retry", async () => {
    state.mode = "error";
    state.orders = [order(7, { updatedAt: "2026-10-09T00:00:00Z" })];
    const fail = await manager.runSync(integrationId, "manual");
    expect(fail.ok).toBe(false);
    let i = (
      await asService((q) =>
        q.query<any>("select status,last_sync_status,last_error from integrations where id=$1", [integrationId]),
      )
    )[0];
    expect(i.status).toBe("sync_failed");
    expect(i.last_error).toMatch(/Internal explosion/);
    expect(
      await count(
        "select count(*)::int n from notifications where business_id=$1 and dedupe_key='integration:shopify' and resolved_at is null",
      ),
    ).toBe(1);
    // Nothing from the failed run was half-imported.
    expect(await count("select count(*)::int n from transactions where business_id=$1 and source='shopify'")).toBe(2);

    state.mode = "ok";
    const retry = await manager.runSync(integrationId, "retry");
    expect(retry.ok).toBe(true);
    i = (
      await asService((q) =>
        q.query<any>("select status,last_sync_status,last_error from integrations where id=$1", [integrationId]),
      )
    )[0];
    expect(i).toMatchObject({ status: "connected", last_sync_status: "success", last_error: null });
    expect(await count("select count(*)::int n from transactions where business_id=$1 and source='shopify'")).toBe(3);
    expect(
      await count(
        "select count(*)::int n from notifications where business_id=$1 and dedupe_key='integration:shopify' and resolved_at is null",
      ),
    ).toBe(0);
  });

  it("moves to requires_reauth when Shopify rejects the token", async () => {
    state.mode = "reauth";
    const r = await manager.runSync(integrationId, "manual");
    expect(r.ok).toBe(false);
    const i = (await asService((q) => q.query<any>("select status from integrations where id=$1", [integrationId])))[0];
    expect(i.status).toBe("requires_reauth");
    state.mode = "ok";
  });

  it("stores the access token encrypted, never in plain text", async () => {
    const s = (
      await asService((q) =>
        q.query<any>("select access_token_enc from integration_secrets where integration_id=$1", [integrationId]),
      )
    )[0];
    expect(s.access_token_enc).not.toContain("shpat_test_token");
    expect(s.access_token_enc.startsWith("v1.")).toBe(true);
  });
});
