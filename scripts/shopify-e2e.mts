/* Shopify end-to-end through the REAL app routes against a LOCAL FAKE Shopify (scripts/fake-shopify.mts).
   Start the app with:
     SHOPIFY_CLIENT_ID=test_client SHOPIFY_CLIENT_SECRET=test_secret SHOPIFY_DEV_API_ORIGIN=http://127.0.0.1:4020 npm run dev
   Proves: OAuth state/HMAC, expiring-token exchange + refresh rotation, store identity, webhook registration,
   paginated idempotent sync, durable webhook processing (dedupe, cancellations, refunds), diagnostics,
   honest failure + retry, non-cash Shopify balance, disconnect (webhooks deleted) and uninstall (tokens revoked). */
import crypto from "node:crypto";
import { makeOrder, startFakeShopify } from "./fake-shopify.mts";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const SECRET = "test_secret";
let passed = 0;
const failed: string[] = [];
const check = (n: string, ok: unknown, x?: unknown) =>
  ok
    ? (passed++, console.log(`  ✓ ${n}`))
    : (failed.push(n), console.log(`  ✗ ${n}`, x === undefined ? "" : JSON.stringify(x).slice(0, 500)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { server, state } = await startFakeShopify(4020);

class C {
  cookies = new Map<string, string>();
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  }
  async json(m: string, p: string, b?: unknown) {
    const r = await this.req(m, p, b);
    return { status: r.status, json: await r.json().catch(() => null) };
  }
}
const c = new C();
const signCallback = (p: Record<string, string>) => {
  const msg = Object.keys(p)
    .sort()
    .map((k) => `${k}=${p[k]}`)
    .join("&");
  return crypto.createHmac("sha256", SECRET).update(msg).digest("hex");
};
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(700);
  }
  return null;
}
const shopItem = async () =>
  (await c.json("GET", "/api/integrations")).json.items.find((i: any) => i.provider === "shopify");

try {
  const stamp = Date.now();
  await c.json("POST", "/api/auth/register", {
    name: "S",
    email: `shop${stamp}@example.test`,
    password: "correct-horse-battery",
  });
  await c.json("POST", "/api/businesses", {
    name: "Shop Brand",
    currency: "EGP",
    country: "EG",
    setup_mode: "shopify",
    timezone: "Africa/Cairo",
    opening_balance: 100_000,
  });

  console.log("1. Authorization");
  let it = await shopItem();
  check("server reports Shopify as configured", it.configured === true, it);
  let r = await c.json("POST", "/api/integrations/shopify/connect", { shop: "margin-test" });
  const auth = new URL(r.json.url);
  check(
    "authorize URL targets the store with client_id, scopes, state and redirect",
    auth.pathname.endsWith("/admin/oauth/authorize") &&
      auth.searchParams.get("client_id") === "test_client" &&
      !!auth.searchParams.get("state") &&
      auth.searchParams.get("redirect_uri")!.endsWith("/api/integrations/shopify/callback"),
    r.json.url,
  );
  // tampered HMAC is refused
  const bad = {
    code: "CODE_OK",
    shop: "margin-test.myshopify.com",
    state: auth.searchParams.get("state")!,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  let res = await c.req(
    "GET",
    `/api/integrations/shopify/callback?${new URLSearchParams({ ...bad, hmac: "0".repeat(64) })}`,
  );
  check(
    "callback with a forged signature is rejected",
    res.status >= 300 && res.status < 400 && /error=/.test(res.headers.get("location") ?? ""),
    res.headers.get("location"),
  );
  // the state was consumed; start again and approve properly
  r = await c.json("POST", "/api/integrations/shopify/connect", { shop: "margin-test" });
  const st = new URL(r.json.url).searchParams.get("state")!;
  const good: Record<string, string> = {
    code: "CODE_OK",
    shop: "margin-test.myshopify.com",
    state: st,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const stranger = new C();
  await stranger.json("POST", "/api/auth/register", {
    name: "X",
    email: `x${stamp}@example.test`,
    password: "correct-horse-battery",
  });
  res = await stranger.req(
    "GET",
    `/api/integrations/shopify/callback?${new URLSearchParams({ ...good, hmac: signCallback(good) })}`,
  );
  check(
    "a different signed-in user cannot complete someone else's authorization (state bound to user)",
    /error=/.test(res.headers.get("location") ?? ""),
    res.headers.get("location"),
  );
  r = await c.json("POST", "/api/integrations/shopify/connect", { shop: "margin-test" });
  const st2 = new URL(r.json.url).searchParams.get("state")!;
  const good2: Record<string, string> = {
    code: "CODE_OK",
    shop: "margin-test.myshopify.com",
    state: st2,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  res = await c.req(
    "GET",
    `/api/integrations/shopify/callback?${new URLSearchParams({ ...good2, hmac: signCallback(good2) })}`,
  );
  check(
    "valid signed callback completes the connection",
    /connected=shopify/.test(res.headers.get("location") ?? ""),
    res.headers.get("location"),
  );
  check(
    "code was exchanged with expiring=1 (refresh token issued)",
    state.codeExchanges === 1 && state.refreshTokens.size === 1,
  );

  console.log("\n2. Identity, webhooks and initial sync");
  it = await waitFor(async () => {
    const x = await shopItem();
    return x.lastSyncStatus === "success" ? x : null;
  });
  check("initial sync completed through the job queue", !!it, await shopItem());
  check(
    "store identity saved (name, currency, timezone)",
    it?.shop?.name === "Margin Test Store" && it?.shop?.ianaTimezone === "Africa/Cairo",
    it?.shop,
  );
  check(
    "7 webhook topics registered at Shopify",
    state.webhooks.length === 7 && state.webhooks.every((w) => w.uri.endsWith("/api/webhooks/shopify")),
    state.webhooks.map((w) => w.topic),
  );
  check("short-lived access token was refreshed and rotated", state.refreshCount >= 1, state.refreshCount);
  const tx = async () => (await c.json("GET", "/api/transactions?source=shopify&limit=200")).json;
  let t = await tx();
  check("5 paid orders imported to the ledger across paginated pages", t.total === 5, t.total);
  const profit = (await c.json("GET", "/api/profit?period=month")).json;
  check(
    "order lines stored with unit costs (product economics available)",
    profit.report.products[0]?.title === "Linen shirt" && profit.report.products[0]?.units >= 2,
    profit.report.products,
  );
  const home = (await c.json("GET", "/api/home")).json;
  check(
    "Shopify balance is NOT counted as available cash",
    home.cash.pendingNonCash > 0 && home.cash.recorded === 100_000,
    home.cash,
  );

  console.log("\n3. Idempotent re-sync and diagnostics");
  r = await c.json("POST", "/api/integrations/shopify/sync", { wait: true });
  t = await tx();
  check("re-sync creates no duplicates", r.json.ok && t.total === 5, { r: r.json, total: t.total });
  r = await c.json("POST", "/api/integrations/shopify/diagnose", {});
  const checks = Object.fromEntries(r.json.checks.map((x: any) => [x.key, x.status]));
  check(
    "diagnostics: token, identity, counts, pagination, persistence, idempotency, webhooks pass",
    ["token", "identity", "counts", "pagination", "persisted", "idempotent", "webhooks"].every(
      (k) => checks[k] === "pass",
    ),
    r.json.checks,
  );

  console.log("\n4. Webhooks");
  // Shopify-side change: order 2 is cancelled, order 1 gets a refund.
  state.orders = state.orders.map((o) =>
    o.id.endsWith("/2")
      ? { ...o, cancelledAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      : o.id.endsWith("/1")
        ? {
            ...o,
            displayFinancialStatus: "PARTIALLY_REFUNDED",
            updatedAt: new Date().toISOString(),
            refunds: [
              {
                id: "gid://shopify/Refund/9",
                createdAt: new Date().toISOString(),
                totalRefundedSet: { shopMoney: { amount: "200.00", currencyCode: "EGP" } },
              },
            ],
          }
        : o,
  );
  state.orders.push(makeOrder(6, { updatedAt: new Date().toISOString() }));
  const body = JSON.stringify({ id: 2, admin_graphql_api_id: "gid://shopify/Order/2" });
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64");
  const hook = (id: string, s = sig) =>
    fetch(`${BASE}/api/webhooks/shopify`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": s,
        "x-shopify-topic": "orders/updated",
        "x-shopify-shop-domain": "margin-test.myshopify.com",
        "x-shopify-webhook-id": id,
      },
    });
  const WH = `wh-${stamp}`;
  let w = await hook(WH, "bad");
  check("unsigned webhook rejected (401)", w.status === 401);
  w = await hook(WH);
  check("signed webhook acknowledged (200)", w.status === 200);
  w = await hook(WH);
  check("redelivery of the same webhook is recognised as a duplicate", (await w.json()).duplicate === true);
  const after = await waitFor(async () => {
    const x = await tx();
    return x.items.some((i: any) => i.type === "refund") &&
      !x.items.some((i: any) => i.description.includes("#1002")) &&
      x.items.some((i: any) => i.description.includes("#1006"))
      ? x
      : null;
  });
  check(
    "webhook job applied the cancellation, the refund and the new order",
    !!after,
    (await tx()).items.map((i: any) => `${i.type}:${i.description}`),
  );

  console.log("\n5. Honest failure and retry");
  state.failGraphql = true;
  r = await c.json("POST", "/api/integrations/shopify/sync", { wait: true });
  it = await shopItem();
  check(
    "a failing Shopify is reported as a failed sync with the error",
    r.json.ok === false && it.status === "sync_failed" && /HTTP 500/.test(it.lastError ?? ""),
    { r: r.json, status: it.status, err: it.lastError },
  );
  state.failGraphql = false;
  r = await c.json("POST", "/api/integrations/shopify/sync", { wait: true });
  it = await shopItem();
  check("retry succeeds and clears the error", r.json.ok === true && it.status === "connected" && !it.lastError, it);

  console.log("\n6. Disconnect and uninstall");
  r = await c.json("POST", "/api/integrations/shopify/disconnect", {});
  check("disconnect deletes Socio's webhook subscriptions at Shopify", state.webhooks.length === 0, state.webhooks);
  r = await c.json("POST", "/api/integrations/shopify/sync", {});
  check("a disconnected store can no longer be synced", r.status === 409);
  t = await tx();
  check("records already imported are kept", t.total > 0);
  r = await c.json("POST", "/api/integrations/shopify/connect", { shop: "margin-test", mode: "client_credentials" });
  check(
    "client-credentials mode connects stores in the app's own organization",
    r.status === 200 && state.clientCredentialGrants === 1,
    r.json,
  );
  await waitFor(async () => ((await shopItem()).lastSyncStatus === "success" ? true : null));
  r = await c.json("POST", "/api/integrations/shopify/disconnect", { uninstall: true });
  check(
    "uninstall calls appUninstall and the old token stops working",
    state.uninstalled && r.json.report?.uninstall?.ok === true && r.json.report?.tokenStillValid === false,
    r.json,
  );

  console.log("\n7. Shopify-initiated install (App URL)");
  const ip: Record<string, string> = {
    shop: "margin-test.myshopify.com",
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const signedQs = new URLSearchParams({ ...ip, hmac: signCallback(ip) }).toString();
  let ir = await c.req(
    "GET",
    `/api/integrations/shopify/install?${new URLSearchParams({ ...ip, hmac: "0".repeat(64) })}`,
  );
  check("install request with a bad signature is rejected", ir.status === 401, ir.status);
  ir = await new C().req("GET", `/api/integrations/shopify/install?${signedQs}`);
  check(
    "signed install without a session goes to sign-in and comes back",
    ir.status >= 300 &&
      ir.status < 400 &&
      /\/login\?next=.*install%3Dmargin-test/.test(ir.headers.get("location") ?? ""),
    ir.headers.get("location"),
  );
  ir = await c.req("GET", `/api/integrations/shopify/install?${signedQs}`);
  check(
    "signed install for a signed-in owner opens the connect step for that store (no token yet)",
    /\/app\/settings\/integrations\?install=margin-test\.myshopify\.com/.test(ir.headers.get("location") ?? ""),
    ir.headers.get("location"),
  );

  console.log("\n8. Compliance webhooks");
  const gdpr = async (topic: string, payload: unknown) => {
    const b = JSON.stringify(payload);
    return fetch(`${BASE}/api/webhooks/shopify`, {
      method: "POST",
      body: b,
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": crypto.createHmac("sha256", SECRET).update(b).digest("base64"),
        "x-shopify-topic": topic,
        "x-shopify-shop-domain": "margin-test.myshopify.com",
        "x-shopify-webhook-id": `${topic}-${stamp}`,
      },
    });
  };
  w = await gdpr("customers/data_request", { shop_domain: "margin-test.myshopify.com", customer: { id: 1 } });
  check("customers/data_request acknowledged (no customer data is stored)", w.status === 200);
  w = await gdpr("shop/redact", { shop_domain: "margin-test.myshopify.com" });
  r = await c.json("GET", "/api/profit?period=year");
  t = await tx();
  check(
    "shop/redact erases Shopify orders and keeps the owner's ledger",
    w.status === 200 && r.json.report.orders === 0 && t.total > 0,
    { orders: r.json.report?.orders, tx: t.total },
  );
} catch (e) {
  console.error(e);
  failed.push("crashed");
} finally {
  server.close();
}
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) console.log(" - " + failed.join("\n - ")), process.exit(1);
process.exit(0);
