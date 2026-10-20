import "server-only";
import { z } from "zod";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { asService } from "../db";
import { currentUser } from "../auth";
import { randomToken } from "../crypto";
import { api, apiCallback, ApiError, badRequest, notFound, params, rateLimit } from "../http";
import { auditLog, emitEvent, enqueue, runDue } from "../jobs";
import {
  PROVIDERS,
  PROVIDER_INFO,
  loadIntegration,
  missingEnv,
  runSync,
  saveSecret,
  shopifyClient,
  shopifyToken,
  type Provider,
} from "../integrations/manager";
import {
  authorizeUrl,
  clientCredentialsToken,
  deleteWebhooks,
  exchangeCode,
  fetchShopIdentity,
  listWebhooks,
  makeGql,
  normalizeShop,
  registerWebhooks,
  uninstallApp,
  verifyCallbackHmac,
  verifyWebhookHmac,
  WEBHOOK_TOPICS,
} from "../integrations/shopify";
import {
  googleAuthorizeUrl,
  googleCustomers,
  googleExchange,
  META_SCOPES,
  metaAuthorizeUrl,
  metaExchange,
} from "../integrations/ads";
import type { Route } from "./types";

async function appOrigin() {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  return `${h.get("x-forwarded-proto") ?? "http"}://${host}`;
}

/* * Shopify only delivers webhooks to public HTTPS endpoints. Locally (against a fake Shopify) plain HTTP is allowed. */
async function webhookUri(): Promise<{ uri: string | null; reason?: string }> {
  const origin = await appOrigin();
  const uri = `${origin}/api/webhooks/shopify`;
  if (origin.startsWith("https://")) return { uri };
  if (process.env.NODE_ENV !== "production" && process.env.SHOPIFY_DEV_API_ORIGIN) return { uri };
  return {
    uri: null,
    reason: `Webhooks need a public HTTPS address; this app is running at ${origin}. Set NEXT_PUBLIC_APP_URL to your deployed https:// URL (or a tunnel) and reconnect.`,
  };
}

function assertProvider(p: string): Provider {
  if (!PROVIDERS.includes(p as Provider)) throw notFound("Integration");
  return p as Provider;
}

const back = async (qs: string) => NextResponse.redirect(`${await appOrigin()}/app/settings/integrations?${qs}`);

/* * After a Shopify token is obtained: identity, webhooks, then a durable initial sync job. */
async function finishShopifyConnect(integrationId: string, businessId: string, shop: string, token: string) {
  const gql = makeGql(shop, token);
  const identity = await fetchShopIdentity(gql);
  if (!identity) throw new Error("Shopify did not return the store identity.");
  if (identity.myshopifyDomain.toLowerCase() !== shop)
    throw new Error(`Connected store (${identity.myshopifyDomain}) does not match the requested store (${shop}).`);
  const wh = await webhookUri();
  const webhooks = wh.uri
    ? { uri: wh.uri, registeredAt: new Date().toISOString(), results: await registerWebhooks(gql, wh.uri) }
    : { uri: null, skipped: wh.reason };
  await asService((q) =>
    q.query("update integrations set display_name=$2, meta = meta || $3::text::jsonb where id=$1", [
      integrationId,
      identity.name,
      JSON.stringify({ shop: identity, webhooks }),
    ]),
  );
  await enqueue({
    businessId,
    kind: "integration.sync",
    payload: { integrationId, trigger: "initial" },
    idempotencyKey: `initial-sync:${integrationId}:${Date.now()}`,
  });
  void runDue({ kinds: ["integration.sync"], max: 1 }).catch(() => {});
}

export const integrationRoutes: Route[] = [
  [
    "GET",
    "integrations",
    api(async (c) => {
      const rows = await c.db((q) =>
        q.query<any>(
          "select id,provider,status,external_account,display_name,scopes,connected_at,last_sync_at,last_sync_status,last_error,meta from integrations where business_id=$1",
          [c.biz.id],
        ),
      );
      const runs = await c.db((q) =>
        q.query<any>(
          "select id,provider,status,trigger,started_at,finished_at,records_imported,error,stats from sync_runs where business_id=$1 order by started_at desc limit 20",
          [c.biz.id],
        ),
      );
      const origin = await appOrigin();
      const wh = await webhookUri();
      return {
        items: PROVIDERS.map((p) => {
          const row = rows.find((r: any) => r.provider === p);
          const missing = missingEnv(p);
          const info = PROVIDER_INFO[p];
          return {
            provider: p,
            name: info.name,
            description: info.description,
            data: info.data,
            scopes: info.scopes,
            needsShop: !!info.needsShop,
            canWrite: info.canWrite,
            configured: missing.length === 0,
            missingEnv: missing,
            callbackUrl: `${origin}/api/integrations/${p}/callback`,
            webhookUrl: p === "shopify" ? `${origin}/api/webhooks/shopify` : null,
            webhookReady: p === "shopify" ? !!wh.uri : null,
            webhookBlocker: p === "shopify" ? (wh.reason ?? null) : null,
            status: row?.status ?? "disconnected",
            hasRow: !!row,
            account: row?.display_name ?? row?.external_account ?? null,
            connectedAt: row?.connected_at ?? null,
            lastSyncAt: row?.last_sync_at ?? null,
            lastSyncStatus: row?.last_sync_status ?? null,
            lastError: row?.last_error ?? null,
            id: row?.id ?? null,
            mode: row?.meta?.mode ?? null,
            shop: row?.meta?.shop ?? null,
            webhooks: row?.meta?.webhooks ?? null,
            diagnostics: row?.meta?.diagnostics ?? null,
            runs: runs.filter((r: any) => r.provider === p).slice(0, 5),
          };
        }),
      };
    }),
  ],

  [
    "POST",
    "integrations/:provider/connect",
    api(async (c) => {
      c.requireAdmin();
      rateLimit(`connect:${c.biz.id}`, 10, 60_000);
      const provider = assertProvider(params<{ provider: string }>(c).provider);
      const missing = missingEnv(provider);
      if (missing.length)
        throw new ApiError(
          409,
          "not_configured",
          `${PROVIDER_INFO[provider].name} is not configured on this server. Missing: ${missing.join(", ")}.`,
        );
      const origin = await appOrigin();
      const redirectUri = `${origin}/api/integrations/${provider}/callback`;
      const b = await c.body(
        z.object({
          shop: z.string().max(200).optional(),
          mode: z.enum(["oauth", "client_credentials"]).default("oauth"),
        }),
      );

      if (provider === "shopify" && b.mode === "client_credentials") {
        // Only works for stores in the same Shopify organization as the app (e.g. dev stores created in the Dev Dashboard).
        const shop = normalizeShop(b.shop ?? "");
        if (!shop)
          throw badRequest("Enter your store's .myshopify.com address.", {
            shop: "Enter a valid myshopify.com domain",
          });
        let tok;
        try {
          tok = await clientCredentialsToken(shop);
        } catch (e) {
          throw new ApiError(
            400,
            "shopify_refused",
            `${(e as Error).message} The client credentials grant only works for stores in the same Shopify organization as the app; use “Install with Shopify” for other stores.`,
          );
        }
        const row = await asService((q) =>
          q.query<{ id: string }>(
            `insert into integrations(business_id,provider,status,external_account,scopes,connected_at,meta) values ($1,'shopify','connected',$2,$3,now(),$4::text::jsonb)
           on conflict (business_id,provider) do update set status='connected', external_account=excluded.external_account, scopes=excluded.scopes, connected_at=now(), last_error=null, last_sync_status=null, meta = integrations.meta || excluded.meta
           returning id`,
            [c.biz.id, shop, tok.scope ?? null, JSON.stringify({ mode: "client_credentials" })],
          ),
        );
        await saveSecret(row[0].id, c.biz.id, tok.access_token, null, tok.expires_in);
        await asService((q) =>
          auditLog(q, {
            businessId: c.biz.id,
            actorType: "user",
            actorId: c.user.id,
            action: "integration.connected",
            target: `shopify:${shop}`,
            detail: { mode: "client_credentials" },
          }),
        );
        await finishShopifyConnect(row[0].id, c.biz.id, shop, tok.access_token);
        return { connected: true };
      }

      const state = randomToken(24);
      let meta: Record<string, unknown> = {};
      let url: string;
      if (provider === "shopify") {
        const shop = normalizeShop(b.shop ?? "");
        if (!shop)
          throw badRequest("Enter your store's .myshopify.com address.", {
            shop: "Enter a valid myshopify.com domain",
          });
        meta = { shop };
        url = authorizeUrl(shop, state, redirectUri);
      } else if (provider === "meta_ads") url = metaAuthorizeUrl(state, redirectUri);
      else url = googleAuthorizeUrl(state, redirectUri);
      await asService(async (q) => {
        await q.query("delete from oauth_states where created_at < now() - interval '1 hour'");
        await q.query(
          "insert into oauth_states(state,business_id,user_id,provider,meta) values ($1,$2,$3,$4,$5::text::jsonb)",
          [state, c.biz.id, c.user.id, provider, JSON.stringify(meta)],
        );
        await q.query(
          `insert into integrations(business_id,provider,status,external_account) values ($1,$2,'connecting',$3)
         on conflict (business_id,provider) do update set status = case when integrations.status in ('disconnected','sync_failed','requires_reauth') then 'connecting' else integrations.status end`,
          [c.biz.id, provider, (meta.shop as string) ?? null],
        );
      });
      return { url };
    }),
  ],

  // Shopify-initiated install (the app's "App URL" in the Dev Dashboard, or a custom-distribution install link).
  // Only verifies Shopify's signature and hands over to the signed-in owner; the token is obtained through the normal
  // connect → callback flow, so the authorization state is always bound to a signed-in user and workspace.
  [
    "GET",
    "integrations/shopify/install",
    async (req) => {
      const url = new URL(req.url);
      const secret = process.env.SHOPIFY_CLIENT_SECRET;
      const origin = await appOrigin();
      if (!secret)
        return NextResponse.redirect(
          `${origin}/app/settings/integrations?error=${encodeURIComponent("Shopify is not configured on this server.")}`,
        );
      const ts = Number(url.searchParams.get("timestamp") ?? 0);
      const fresh = Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) < 24 * 3600;
      const shop = normalizeShop(url.searchParams.get("shop") ?? "");
      if (!shop || !fresh || !verifyCallbackHmac(url.searchParams, secret))
        return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
      const target = `/app/settings/integrations?install=${encodeURIComponent(shop)}`;
      if (!(await currentUser())) return NextResponse.redirect(`${origin}/login?next=${encodeURIComponent(target)}`);
      return NextResponse.redirect(origin + target);
    },
  ],

  // Browser redirect from the provider. Needs the user's session cookie; the state binds it to this user and workspace.
  [
    "GET",
    "integrations/:provider/callback",
    apiCallback(async (c) => {
      const provider = assertProvider(params<{ provider: string }>(c).provider);
      const sp = c.url.searchParams;
      const state = sp.get("state") ?? "";
      const row = await asService(async (q) => {
        const r = await q.query<any>(
          "delete from oauth_states where state=$1 and provider=$2 and created_at > now() - interval '15 minutes' returning *",
          [state, provider],
        );
        return r[0];
      });
      if (!row || row.user_id !== c.user.id)
        return back(
          `error=${encodeURIComponent("The authorization request expired or did not match your session. Please try again.")}`,
        );
      if (sp.get("error"))
        return back(`error=${encodeURIComponent(sp.get("error_description") ?? "Authorization was declined.")}`);
      const code = sp.get("code");
      if (!code) return back("error=Missing%20authorization%20code");
      const origin = await appOrigin();
      const redirectUri = `${origin}/api/integrations/${provider}/callback`;
      try {
        let integrationId: string;
        if (provider === "shopify") {
          const shop = normalizeShop(sp.get("shop") ?? "");
          if (!shop || shop !== row.meta.shop)
            throw new Error("The shop in the callback does not match the one you started with.");
          if (!verifyCallbackHmac(sp, process.env.SHOPIFY_CLIENT_SECRET!))
            throw new Error("Shopify's signature on the callback could not be verified.");
          const tok = await exchangeCode(shop, code);
          const id = await asService((q) =>
            q.query<{ id: string }>(
              `update integrations set status='connected', external_account=$3, display_name=$3, scopes=$4, connected_at=now(), last_error=null, last_sync_status=null,
               meta = meta || '{"mode":"oauth"}'::jsonb where business_id=$1 and provider=$2 returning id`,
              [row.business_id, provider, shop, tok.scope ?? null],
            ),
          );
          integrationId = id[0].id;
          await saveSecret(integrationId, row.business_id, tok.access_token, tok.refresh_token ?? null, tok.expires_in);
          await asService((q) =>
            auditLog(q, {
              businessId: row.business_id,
              actorType: "user",
              actorId: c.user.id,
              action: "integration.connected",
              target: `shopify:${shop}`,
              detail: { mode: "oauth", scope: tok.scope, expiring: !!tok.refresh_token },
            }),
          );
          await finishShopifyConnect(integrationId, row.business_id, shop, tok.access_token);
          return back(`connected=${provider}`);
        } else if (provider === "meta_ads") {
          const tok = await metaExchange(code, redirectUri);
          const id = await asService((q) =>
            q.query<{ id: string }>(
              "update integrations set status='connected', scopes=$3, connected_at=now(), last_error=null, last_sync_status=null where business_id=$1 and provider=$2 returning id",
              [row.business_id, provider, META_SCOPES()],
            ),
          );
          integrationId = id[0].id;
          await saveSecret(integrationId, row.business_id, tok.access_token, null, tok.expires_in);
        } else {
          const tok = await googleExchange(code, redirectUri);
          const customers = await googleCustomers(tok.access_token);
          if (!customers[0]) throw new Error("No Google Ads account is accessible with this login.");
          const id = await asService((q) =>
            q.query<{ id: string }>(
              "update integrations set status='connected', external_account=$3, display_name=$4, scopes=$5, connected_at=now(), last_error=null, last_sync_status=null where business_id=$1 and provider=$2 returning id",
              [row.business_id, provider, customers[0], `Account ${customers[0]}`, "adwords"],
            ),
          );
          integrationId = id[0].id;
          await saveSecret(integrationId, row.business_id, tok.access_token, tok.refresh_token ?? null, tok.expires_in);
        }
        await enqueue({
          businessId: row.business_id,
          kind: "integration.sync",
          payload: { integrationId, trigger: "initial" },
          idempotencyKey: `initial-sync:${integrationId}:${Date.now()}`,
        });
        void runDue({ kinds: ["integration.sync"], max: 1 }).catch(() => {});
        return back(`connected=${provider}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Connection failed.";
        await asService((q) =>
          q.query("update integrations set status='disconnected', last_error=$3 where business_id=$1 and provider=$2", [
            row.business_id,
            provider,
            msg,
          ]),
        );
        return back(`error=${encodeURIComponent(msg)}`);
      }
    }),
  ],

  [
    "POST",
    "integrations/:provider/sync",
    api(async (c) => {
      c.requireWrite();
      rateLimit(`sync:${c.biz.id}`, 6, 60_000);
      const provider = assertProvider(params<{ provider: string }>(c).provider);
      const b = await c.body(z.object({ wait: z.boolean().default(false) }).default({ wait: false }));
      const r = await c.db((q) =>
        q.query<{ id: string; status: string }>(
          "select id,status from integrations where business_id=$1 and provider=$2",
          [c.biz.id, provider],
        ),
      );
      if (!r[0] || r[0].status === "disconnected" || r[0].status === "connecting")
        throw new ApiError(409, "not_connected", "Connect this integration first.");
      if (r[0].status === "requires_reauth")
        throw new ApiError(409, "requires_reauth", "This connection needs to be re-authorised before it can sync.");
      if (b.wait) {
        const res = await runSync(r[0].id, "retry");
        return { started: true, ...res };
      }
      const job = await enqueue({
        businessId: c.biz.id,
        kind: "integration.sync",
        payload: { integrationId: r[0].id, trigger: "retry" },
        idempotencyKey: `manual-sync:${r[0].id}:${Math.floor(Date.now() / 10_000)}`,
      });
      void runDue({ kinds: ["integration.sync"], max: 2 }).catch(() => {});
      return { started: true, jobId: job.id };
    }),
  ],

  // Read-only live checks against the connected store. Results are stored so the UI can show them.
  [
    "POST",
    "integrations/shopify/diagnose",
    api(async (c) => {
      c.requireWrite();
      rateLimit(`diagnose:${c.biz.id}`, 4, 60_000);
      const r = await c.db((q) =>
        q.query<{ id: string; status: string; meta: any }>(
          "select id,status,meta from integrations where business_id=$1 and provider='shopify'",
          [c.biz.id],
        ),
      );
      if (!r[0] || r[0].status === "disconnected") throw new ApiError(409, "not_connected", "Connect Shopify first.");
      const id = r[0].id;
      const checks: { key: string; label: string; status: "pass" | "fail" | "warn"; detail: string }[] = [];
      const add = (key: string, label: string, status: "pass" | "fail" | "warn", detail: string) =>
        checks.push({ key, label, status, detail });
      let gql;
      try {
        ({ gql } = await shopifyClient(id));
        add(
          "token",
          "Access token is valid",
          "pass",
          r[0].meta?.mode === "client_credentials" ? "Client credentials token" : "OAuth offline token",
        );
      } catch (e) {
        add("token", "Access token is valid", "fail", (e as Error).message);
        await asService((q) =>
          q.query("update integrations set meta = meta || $2::text::jsonb where id=$1", [
            id,
            JSON.stringify({ diagnostics: { at: new Date().toISOString(), checks } }),
          ]),
        );
        return { checks };
      }
      const info = await loadIntegration(id);
      try {
        const shop = await fetchShopIdentity(gql);
        add(
          "identity",
          "Store identity matches",
          shop && shop.myshopifyDomain.toLowerCase() === info?.external_account ? "pass" : "fail",
          shop
            ? `${shop.name} (${shop.myshopifyDomain}), ${shop.currencyCode}, ${shop.ianaTimezone}`
            : "No shop returned",
        );
      } catch (e) {
        add("identity", "Store identity matches", "fail", (e as Error).message);
      }
      try {
        const d: any = await gql("query Counts { ordersCount { count precision } productsCount { count precision } }");
        add(
          "counts",
          "Orders and products are readable",
          "pass",
          `Shopify reports ${d.ordersCount?.count ?? "?"} orders (${d.ordersCount?.precision ?? ""}) and ${d.productsCount?.count ?? "?"} products. Without the read_all_orders scope Shopify only exposes the last 60 days of orders.`,
        );
      } catch (e) {
        add("counts", "Orders and products are readable", "fail", (e as Error).message);
      }
      try {
        const p1: any = await gql(
          "query P($c: String) { orders(first: 2, after: $c, sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { id } } }",
          { c: null },
        );
        if (!p1.orders.pageInfo.hasNextPage)
          add("pagination", "Pagination works", "warn", "Fewer than 3 orders, so a second page could not be tested.");
        else {
          const p2: any = await gql(
            "query P($c: String) { orders(first: 2, after: $c, sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { id } } }",
            { c: p1.orders.pageInfo.endCursor },
          );
          const overlap = p2.orders.nodes.some((n: any) => p1.orders.nodes.some((m: any) => m.id === n.id));
          add(
            "pagination",
            "Pagination works",
            overlap ? "fail" : "pass",
            overlap ? "Second page repeated records from the first." : "Two pages returned distinct orders.",
          );
        }
      } catch (e) {
        add("pagination", "Pagination works", "fail", (e as Error).message);
      }
      const before = await asService((q) =>
        q.query<{ o: number; t: number; l: number }>(
          "select (select count(*)::int from orders where business_id=$1) o, (select count(*)::int from transactions where business_id=$1 and source='shopify') t, (select count(*)::int from order_lines where business_id=$1) l",
          [c.biz.id],
        ),
      );
      add(
        "persisted",
        "Imported records are stored",
        before[0].o > 0 ? "pass" : "warn",
        `${before[0].o} orders, ${before[0].l} order lines, ${before[0].t} ledger records stored.`,
      );
      const res = await runSync(id, "manual");
      const after = await asService((q) =>
        q.query<{ o: number; t: number; l: number }>(
          "select (select count(*)::int from orders where business_id=$1) o, (select count(*)::int from transactions where business_id=$1 and source='shopify') t, (select count(*)::int from order_lines where business_id=$1) l",
          [c.biz.id],
        ),
      );
      if (!res.ok) add("idempotent", "Re-sync creates no duplicates", "fail", res.error ?? "sync failed");
      else {
        const s: any = res.stats;
        const grew = after[0].o - before[0].o;
        add(
          "idempotent",
          "Re-sync creates no duplicates",
          grew <= (s.imported ?? 0) ? "pass" : "fail",
          `Re-sync saw ${s.orders} orders (${s.unchanged} unchanged, ${s.imported} new). Stored orders ${before[0].o} → ${after[0].o}.`,
        );
      }
      try {
        const subs = await listWebhooks(gql);
        const wanted = r[0].meta?.webhooks?.uri as string | undefined;
        const mine = subs.filter((s) => s.uri === wanted);
        const missing = WEBHOOK_TOPICS.filter((t) => !mine.some((s) => s.topic === t));
        if (!wanted)
          add(
            "webhooks",
            "Webhooks are registered",
            "warn",
            r[0].meta?.webhooks?.skipped ?? "Webhooks were not registered.",
          );
        else
          add(
            "webhooks",
            "Webhooks are registered",
            missing.length ? "warn" : "pass",
            missing.length
              ? `Missing: ${missing.join(", ")} (often a missing scope).`
              : `${mine.length} subscriptions point to ${wanted}.`,
          );
      } catch (e) {
        add("webhooks", "Webhooks are registered", "fail", (e as Error).message);
      }
      const ev = await asService((q) =>
        q.query<{ n: number; last: string | null }>(
          "select count(*)::int n, max(received_at)::text last from events where business_id=$1 and type='shopify.webhook.received'",
          [c.biz.id],
        ),
      );
      add(
        "deliveries",
        "Webhook deliveries received",
        ev[0].n > 0 ? "pass" : "warn",
        ev[0].n
          ? `${ev[0].n} verified deliveries; last at ${ev[0].last}.`
          : "No deliveries yet. They arrive when orders or products change in Shopify.",
      );
      await asService((q) =>
        q.query("update integrations set meta = meta || $2::text::jsonb where id=$1", [
          id,
          JSON.stringify({ diagnostics: { at: new Date().toISOString(), checks } }),
        ]),
      );
      return { checks };
    }),
  ],

  [
    "POST",
    "integrations/:provider/disconnect",
    api(async (c) => {
      c.requireAdmin();
      const provider = assertProvider(params<{ provider: string }>(c).provider);
      const b = await c.body(z.object({ uninstall: z.boolean().default(false) }).default({ uninstall: false }));
      const r = await c.db((q) =>
        q.query<{ id: string; meta: any; external_account: string | null }>(
          "select id,meta,external_account from integrations where business_id=$1 and provider=$2",
          [c.biz.id, provider],
        ),
      );
      if (!r[0]) return { ok: true };
      const report: Record<string, unknown> = {};
      if (provider === "shopify") {
        try {
          const info = await loadIntegration(r[0].id);
          const shopDomain = normalizeShop(info?.external_account ?? "");
          if (!info || !shopDomain) throw new Error("No stored store to disconnect.");
          // Use the exact token we hold (no silent refresh), so the post-uninstall check is meaningful.
          const gql = makeGql(shopDomain, await shopifyToken(info));
          if (b.uninstall) {
            report.uninstall = await uninstallApp(gql);
            // Verify: the old token must no longer work.
            try {
              await fetchShopIdentity(gql);
              report.tokenStillValid = true;
            } catch {
              report.tokenStillValid = false;
            }
          } else {
            const ids = (r[0].meta?.webhooks?.results ?? []).filter((x: any) => x.ok && x.id).map((x: any) => x.id);
            report.webhooksDeleted = ids.length ? await deleteWebhooks(gql, ids) : [];
          }
        } catch (e) {
          report.remoteCleanupError = (e as Error).message;
        }
      }
      await asService(async (q) => {
        await q.query("delete from integration_secrets where integration_id=$1", [r[0].id]);
        await q.query(
          "update integrations set status='disconnected', last_error=null, last_sync_status=null, connected_at=null, meta = meta - 'webhooks' where id=$1",
          [r[0].id],
        );
        await q.query("update notifications set resolved_at=now() where business_id=$1 and dedupe_key=$2", [
          c.biz.id,
          `integration:${provider}`,
        ]);
        await auditLog(q, {
          businessId: c.biz.id,
          actorType: "user",
          actorId: c.user.id,
          action: b.uninstall ? "integration.uninstalled" : "integration.disconnected",
          target: `${provider}:${r[0].external_account ?? ""}`,
          detail: report,
        });
      });
      // Imported records stay in the ledger. Removing them is a separate, explicit action.
      return { ok: true, report, note: "Tokens were deleted. Records already imported were kept." };
    }),
  ],

  [
    "POST",
    "integrations/:provider/purge",
    api(async (c) => {
      c.requireAdmin();
      const provider = assertProvider(params<{ provider: string }>(c).provider);
      await c.body(z.object({ confirm: z.literal("DELETE") }));
      const out = await asService(async (q) => {
        let tx = 0;
        if (provider === "shopify") {
          tx = (
            await q.query("delete from transactions where business_id=$1 and source='shopify' returning id", [c.biz.id])
          ).length;
          await q.query("delete from external_records where business_id=$1 and provider='shopify'", [c.biz.id]);
          await q.query("delete from orders where business_id=$1 and provider='shopify'", [c.biz.id]);
          await q.query("delete from products where business_id=$1 and source='shopify'", [c.biz.id]);
        } else await q.query("delete from ad_metrics where business_id=$1 and provider=$2", [c.biz.id, provider]);
        await auditLog(q, {
          businessId: c.biz.id,
          actorType: "user",
          actorId: c.user.id,
          action: "integration.purged",
          target: provider,
          detail: { transactions: tx },
        });
        return tx;
      });
      return { removedTransactions: out };
    }),
  ],

  // Shopify webhooks: verify, persist durably, acknowledge fast, process in a job
  [
    "POST",
    "webhooks/shopify",
    async (req) => {
      const raw = await req.text();
      const secret = process.env.SHOPIFY_CLIENT_SECRET;
      if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
      if (!verifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256"), secret))
        return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
      const shop = (req.headers.get("x-shopify-shop-domain") ?? "").toLowerCase();
      const topic = req.headers.get("x-shopify-topic") ?? "";
      const webhookId = req.headers.get("x-shopify-webhook-id") ?? "";
      if (!webhookId) return NextResponse.json({ error: "missing_id" }, { status: 400 });
      const fresh = await asService((q) =>
        q.query(
          "insert into webhook_events(provider,event_id,topic) values ('shopify',$1,$2) on conflict do nothing returning id",
          [webhookId, topic],
        ),
      );
      if (!fresh.length) return NextResponse.json({ ok: true, duplicate: true });
      const integ = await asService((q) =>
        q.query<{ id: string; business_id: string }>(
          "select id,business_id from integrations where provider='shopify' and external_account=$1 and status <> 'disconnected'",
          [shop],
        ),
      );
      // shop/redact arrives 48h after uninstall: erase what Socio holds from Shopify for this store (raw payloads, orders,
      // tokens). The owner's own ledger entries stay; they can remove them with "Remove imported data".
      if (topic === "shop/redact") {
        const all = await asService((q) =>
          q.query<{ id: string; business_id: string }>(
            "select id,business_id from integrations where provider='shopify' and external_account=$1",
            [shop],
          ),
        );
        for (const i of all)
          await asService(async (q) => {
            await q.query("delete from external_records where business_id=$1 and provider='shopify'", [i.business_id]);
            await q.query("delete from orders where business_id=$1 and provider='shopify'", [i.business_id]);
            await q.query("delete from integration_secrets where integration_id=$1", [i.id]);
            await q.query("update integrations set status='disconnected', last_error=null where id=$1", [i.id]);
            await auditLog(q, {
              businessId: i.business_id,
              actorType: "system",
              action: "integration.shop_redacted",
              target: `shopify:${shop}`,
            });
          });
        return NextResponse.json({ ok: true });
      }
      // customers/data_request and customers/redact: Socio requests and stores no customer personal data from Shopify.
      if (!integ.length || topic.startsWith("customers/")) return NextResponse.json({ ok: true });
      for (const i of integ) {
        if (topic === "app/uninstalled") {
          await asService(async (q) => {
            await q.query("delete from integration_secrets where integration_id=$1", [i.id]);
            await q.query(
              "update integrations set status='requires_reauth', last_error='The app was uninstalled from the store.' where id=$1",
              [i.id],
            );
            await auditLog(q, {
              businessId: i.business_id,
              actorType: "system",
              action: "integration.uninstalled_by_store",
              target: `shopify:${shop}`,
            });
          });
          continue;
        }
        let resourceId: string | undefined;
        try {
          resourceId = String(JSON.parse(raw)?.admin_graphql_api_id ?? JSON.parse(raw)?.id ?? "");
        } catch {
          resourceId = undefined;
        }
        await emitEvent({
          businessId: i.business_id,
          source: "shopify",
          type: "shopify.webhook.received",
          entityId: resourceId,
          payload: { topic, integrationId: i.id, webhookId, triggeredAt: req.headers.get("x-shopify-triggered-at") },
          idempotencyKey: `shopify:${webhookId}:${i.id}`,
        });
      }
      // Processing happens in a durable job; kick the worker without delaying the acknowledgement.
      void runDue({ kinds: ["shopify.process_webhook", "integration.sync"], max: 3 }).catch(() => {});
      return NextResponse.json({ ok: true });
    },
  ],
];
