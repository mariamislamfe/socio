/* A local stand-in for Shopify's OAuth + Admin GraphQL endpoints, for end-to-end tests only.
   It implements the documented protocol shapes (authorization code with expiring tokens, refresh rotation,
   client credentials, paginated GraphQL, webhook subscriptions, appUninstall). It is NOT Shopify. */
import http from "node:http";

export interface FakeState {
  shop: string;
  clientId: string;
  clientSecret: string;
  tokens: Map<string, { expiresAt: number }>;
  refreshTokens: Set<string>;
  /* * Shopify semantics: a presented refresh token stays usable until the token issued in its place is used. */
  replacedBy: Map<string, string>;
  refreshCount: number;
  codeExchanges: number;
  clientCredentialGrants: number;
  orders: any[];
  variants: any[];
  webhooks: { id: string; topic: string; uri: string }[];
  uninstalled: boolean;
  failGraphql: boolean;
  accessTokenTtl: number;
  graphqlCalls: number;
}

const money = (amount: string, currencyCode = "EGP") => ({ shopMoney: { amount, currencyCode } });

export function makeOrder(n: number, over: Record<string, any> = {}) {
  const date = new Date(Date.now() - (10 - n) * 86_400_000).toISOString();
  return {
    id: `gid://shopify/Order/${n}`,
    name: `#${1000 + n}`,
    createdAt: date,
    processedAt: date,
    updatedAt: date,
    cancelledAt: null,
    test: false,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    currencyCode: "EGP",
    totalPriceSet: money("1140.00"),
    subtotalPriceSet: money("1000.00"),
    totalTaxSet: money("140.00"),
    totalDiscountsSet: money("0.00"),
    totalShippingPriceSet: money("0.00"),
    totalRefundedSet: money("0.00"),
    refunds: [],
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${n}1`,
          title: "Linen shirt",
          sku: "LS-1",
          quantity: 2,
          currentQuantity: 2,
          originalUnitPriceSet: money("500.00"),
          discountedTotalSet: money("1000.00"),
          variant: { id: "gid://shopify/ProductVariant/1", inventoryItem: { unitCost: { amount: "180.00" } } },
        },
      ],
    },
    ...over,
  };
}

export function startFakeShopify(port = 4020, shop = "margin-test.myshopify.com") {
  const state: FakeState = {
    shop,
    clientId: "test_client",
    clientSecret: "test_secret",
    tokens: new Map(),
    refreshTokens: new Set(),
    replacedBy: new Map(),
    refreshCount: 0,
    codeExchanges: 0,
    clientCredentialGrants: 0,
    orders: [1, 2, 3, 4, 5].map((n) => makeOrder(n)),
    variants: [
      {
        id: "gid://shopify/ProductVariant/1",
        title: "Default Title",
        sku: "LS-1",
        price: "500.00",
        inventoryQuantity: 12,
        product: { title: "Linen shirt" },
        inventoryItem: { unitCost: { amount: "180.00", currencyCode: "EGP" } },
      },
    ],
    webhooks: [],
    uninstalled: false,
    failGraphql: false,
    accessTokenTtl: 30,
    graphqlCalls: 0,
  };
  let seq = 0;
  const issue = (ttl: number) => {
    const t = `shpat_fake_${++seq}`;
    state.tokens.set(t, { expiresAt: Date.now() + ttl * 1000 });
    return t;
  };
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const page = <T,>(arr: T[], size: number, cursor: string | null) => {
    const start = cursor ? Number(cursor) : 0;
    const nodes = arr.slice(start, start + size);
    return { nodes, pageInfo: { hasNextPage: start + size < arr.length, endCursor: String(start + size) } };
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const [, shopInPath, ...rest] = url.pathname.split("/");
      const path = "/" + rest.join("/");
      if (shopInPath !== state.shop) return json(res, 404, { errors: "Not Found" });

      if (path === "/admin/oauth/authorize")
        return json(res, 200, { note: "merchant approval page (simulated by the test)" });

      if (path === "/admin/oauth/access_token" && req.method === "POST") {
        const p = new URLSearchParams(body);
        if (p.get("client_id") !== state.clientId || p.get("client_secret") !== state.clientSecret)
          return json(res, 401, { error: "invalid_client" });
        if (state.uninstalled && p.get("grant_type") !== "client_credentials")
          return json(res, 401, { error: "invalid_request" });
        if (p.get("grant_type") === "refresh_token") {
          const rt = p.get("refresh_token")!;
          if (!state.refreshTokens.has(rt)) return json(res, 401, { error: "invalid_request" });
          // Using a refresh token retires the one it replaced.
          for (const [old, next] of state.replacedBy) if (next === rt) state.refreshTokens.delete(old);
          state.refreshCount++;
          const nrt = `shprt_fake_${++seq}`;
          state.refreshTokens.add(nrt);
          state.replacedBy.set(rt, nrt);
          return json(res, 200, {
            access_token: issue(state.accessTokenTtl),
            expires_in: state.accessTokenTtl,
            refresh_token: nrt,
            refresh_token_expires_in: 7776000,
            scope: "read_orders,read_products,read_inventory",
          });
        }
        if (p.get("grant_type") === "client_credentials") {
          if (state.uninstalled) return json(res, 400, { error: "shop_not_permitted" });
          state.clientCredentialGrants++;
          return json(res, 200, {
            access_token: issue(86399),
            expires_in: 86399,
            scope: "read_orders,read_products,read_inventory",
          });
        }
        if (p.get("code") !== "CODE_OK") return json(res, 400, { error: "invalid_grant" });
        state.codeExchanges++;
        state.uninstalled = false;
        const rt = `shprt_fake_${++seq}`;
        state.refreshTokens.add(rt);
        const expiring = p.get("expiring") === "1";
        return json(res, 200, {
          access_token: issue(expiring ? state.accessTokenTtl : 10 ** 9),
          scope: "read_orders,read_products,read_inventory",
          ...(expiring
            ? { expires_in: state.accessTokenTtl, refresh_token: rt, refresh_token_expires_in: 7776000 }
            : {}),
        });
      }

      if (/^\/admin\/api\/[^/]+\/graphql\.json$/.test(path) && req.method === "POST") {
        state.graphqlCalls++;
        const tok = req.headers["x-shopify-access-token"] as string;
        const t = state.tokens.get(tok);
        if (!t || t.expiresAt < Date.now() || state.uninstalled)
          return json(res, 401, {
            errors: "[API] Invalid API key or access token (unrecognized login or wrong password)",
          });
        if (state.failGraphql) return json(res, 500, { errors: "Internal error" });
        const { query, variables } = JSON.parse(body);
        const v = variables ?? {};
        let data: any = {};
        if (query.includes("ShopIdentity"))
          data = {
            shop: {
              id: "gid://shopify/Shop/1",
              name: "Margin Test Store",
              myshopifyDomain: state.shop,
              currencyCode: "EGP",
              ianaTimezone: "Africa/Cairo",
            },
          };
        else if (query.includes("ordersCount"))
          data = {
            ordersCount: { count: state.orders.length, precision: "EXACT" },
            productsCount: { count: 1, precision: "EXACT" },
          };
        else if (query.includes("orders(first: 2"))
          data = {
            orders: page(
              state.orders.map((o) => ({ id: o.id })),
              2,
              v.c ?? null,
            ),
          };
        else if (query.includes("orders(")) {
          let list = [...state.orders];
          const m = /updated_at:>='([^']+)'/.exec(v.query ?? "");
          if (m) list = list.filter((o) => o.updatedAt >= m[1]);
          data = { orders: page(list, 3, v.cursor ?? null) };
        } else if (query.includes("productVariants"))
          data = { productVariants: page(state.variants, 100, v.cursor ?? null) };
        else if (query.includes("webhookSubscriptionCreate")) {
          const sub = {
            id: `gid://shopify/WebhookSubscription/${++seq}`,
            topic: v.topic,
            uri: v.webhookSubscription.uri,
          };
          state.webhooks.push(sub);
          data = { webhookSubscriptionCreate: { webhookSubscription: sub, userErrors: [] } };
        } else if (query.includes("webhookSubscriptionDelete")) {
          const before = state.webhooks.length;
          state.webhooks = state.webhooks.filter((w) => w.id !== v.id);
          data = {
            webhookSubscriptionDelete: {
              deletedWebhookSubscriptionId: before !== state.webhooks.length ? v.id : null,
              userErrors: before !== state.webhooks.length ? [] : [{ field: ["id"], message: "not found" }],
            },
          };
        } else if (query.includes("webhookSubscriptions(")) data = { webhookSubscriptions: { nodes: state.webhooks } };
        else if (query.includes("appUninstall")) {
          state.uninstalled = true;
          state.webhooks = [];
          state.tokens.clear();
          state.refreshTokens.clear();
          data = { appUninstall: { app: { id: "gid://shopify/App/1" }, userErrors: [] } };
        } else return json(res, 200, { errors: [{ message: "Unknown query in fake" }] });
        return json(res, 200, {
          data,
          extensions: {
            cost: { throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1900, restoreRate: 100 } },
          },
        });
      }
      json(res, 404, { errors: "Not Found" });
    });
  });
  return new Promise<{ server: http.Server; state: FakeState }>((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ server, state })),
  );
}
