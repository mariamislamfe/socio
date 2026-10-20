import "server-only";
import { asService } from "../db";
import { decrypt, encrypt } from "../crypto";
import { emitEvent } from "../jobs";
import { googleRefresh, syncGoogle, syncMeta, metaAdAccounts } from "./ads";
import {
  clientCredentialsToken,
  fetchShopIdentity,
  makeGql,
  normalizeShop,
  ProviderAuthError,
  refreshAccessToken,
  syncShopify,
  SHOPIFY_SCOPES,
  type Gql,
} from "./shopify";

export type Provider = "shopify" | "meta_ads" | "google_ads";
export const PROVIDERS: Provider[] = ["shopify", "meta_ads", "google_ads"];

/*
 * Adapter contract (every provider): connect (OAuth or grant) → token acquisition/refresh → sync (paginated, retried,
 * idempotent) → normalize → status + freshness → webhooks where supported → disconnect/revoke.
 * Meta and Google adapters are read-only: Socio cannot change ad budgets, by design, until a write adapter exists.
 */
export const PROVIDER_INFO: Record<
  Provider,
  {
    name: string;
    description: string;
    data: string[];
    scopes: string;
    env: string[];
    needsShop?: boolean;
    canWrite: boolean;
  }
> = {
  shopify: {
    name: "Shopify",
    description:
      "Imports orders, order lines, refunds, cancellations, products and unit costs. Keeps itself up to date with webhooks.",
    data: [
      "Store name, currency and timezone",
      "Orders, line items, discounts, shipping, tax",
      "Refunds and cancellations",
      "Products, variants, stock and unit costs",
    ],
    scopes: SHOPIFY_SCOPES(),
    env: ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"],
    needsShop: true,
    canWrite: false,
  },
  meta_ads: {
    name: "Meta Ads",
    description:
      "Imports daily campaign spend, clicks and purchase conversions. Kept separate from your ledger. Read-only.",
    data: ["Campaign spend", "Impressions and clicks", "Purchases and purchase value"],
    scopes: "ads_read",
    env: ["META_APP_ID", "META_APP_SECRET"],
    canWrite: false,
  },
  google_ads: {
    name: "Google Ads",
    description: "Imports daily campaign cost, clicks and conversion value. Kept separate from your ledger. Read-only.",
    data: ["Campaign cost", "Impressions and clicks", "Conversions and conversion value"],
    scopes: "https://www.googleapis.com/auth/adwords",
    env: ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN"],
    canWrite: false,
  },
};

export function missingEnv(p: Provider): string[] {
  return PROVIDER_INFO[p].env.filter((k) => !process.env[k]);
}

export async function saveSecret(
  integrationId: string,
  businessId: string,
  access: string,
  refresh?: string | null,
  expiresIn?: number,
) {
  await asService((q) =>
    q.query(
      `insert into integration_secrets(integration_id,business_id,access_token_enc,refresh_token_enc,expires_at) values ($1,$2,$3,$4, $5)
       on conflict (integration_id) do update set access_token_enc=excluded.access_token_enc, refresh_token_enc=coalesce(excluded.refresh_token_enc, integration_secrets.refresh_token_enc),
         expires_at=excluded.expires_at, updated_at=now()`,
      [
        integrationId,
        businessId,
        encrypt(access),
        refresh ? encrypt(refresh) : null,
        expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      ],
    ),
  );
}

interface IntegrationRow {
  id: string;
  business_id: string;
  provider: Provider;
  status: string;
  external_account: string | null;
  meta: any;
  last_sync_at: string | null;
  last_sync_status: string | null;
  base_currency: string;
  timezone: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: string | null;
}

export async function loadIntegration(integrationId: string): Promise<IntegrationRow | null> {
  const r = await asService((q) =>
    q.query<IntegrationRow>(
      `select i.id,i.business_id,i.provider,i.status,i.external_account,i.meta,i.last_sync_at,i.last_sync_status, b.currency as base_currency, b.timezone,
              s.access_token_enc, s.refresh_token_enc, s.expires_at
       from integrations i join businesses b on b.id=i.business_id left join integration_secrets s on s.integration_id=i.id where i.id=$1`,
      [integrationId],
    ),
  );
  return r[0] ?? null;
}

const refreshing = new Map<string, Promise<string>>();

/* * Returns a usable Shopify access token, refreshing/rotating or re-requesting it when needed. */
export async function shopifyToken(info: IntegrationRow): Promise<string> {
  // One refresh per integration at a time in this process; concurrent callers share the result.
  const inflight = refreshing.get(info.id);
  if (inflight) return inflight;
  const p = acquireToken(info).finally(() => refreshing.delete(info.id));
  refreshing.set(info.id, p);
  return p;
}

async function acquireToken(info: IntegrationRow): Promise<string> {
  if (!info.access_token_enc) throw new ProviderAuthError("Not connected.");
  const shop = normalizeShop(info.external_account ?? "");
  if (!shop) throw new Error("Stored shop domain is invalid.");
  const expiresAt = info.expires_at ? new Date(info.expires_at).getTime() : null;
  const fresh = expiresAt === null || expiresAt > Date.now() + 5 * 60_000;
  if (fresh) return decrypt(info.access_token_enc);
  if (info.meta?.mode === "client_credentials") {
    const t = await clientCredentialsToken(shop);
    await saveSecret(info.id, info.business_id, t.access_token, null, t.expires_in);
    return t.access_token;
  }
  if (!info.refresh_token_enc)
    throw new ProviderAuthError("The access token expired and there is no refresh token. Reconnect the store.");
  const t = await refreshAccessToken(shop, decrypt(info.refresh_token_enc));
  // Store the rotated pair immediately; the old refresh token stays valid until the new one is used.
  await saveSecret(info.id, info.business_id, t.access_token, t.refresh_token ?? null, t.expires_in);
  return t.access_token;
}

export async function shopifyClient(integrationId: string): Promise<{ gql: Gql; shop: string; info: IntegrationRow }> {
  const info = await loadIntegration(integrationId);
  if (!info) throw new Error("Integration not found.");
  let token = await shopifyToken(info);
  const shop = normalizeShop(info.external_account ?? "")!;
  let inner = makeGql(shop, token);
  // Shopify: refresh proactively AND when a request returns 401. Retry once with a fresh token;
  // a second 401 means access was really revoked and the owner must reconnect.
  const gql: Gql = async (query, variables) => {
    try {
      return await inner(query, variables);
    } catch (e) {
      if (!(e instanceof ProviderAuthError)) throw e;
      const latest = await loadIntegration(integrationId);
      if (!latest) throw e;
      const forced = { ...latest, expires_at: new Date(0).toISOString() };
      if (latest.meta?.mode !== "client_credentials" && !latest.refresh_token_enc) throw e;
      token = await shopifyToken(forced);
      inner = makeGql(shop, token);
      return inner(query, variables);
    }
  };
  return { gql, shop, info };
}

const running = new Set<string>();

async function notify(
  businessId: string,
  provider: Provider,
  severity: "critical" | "success",
  title: string,
  body: string,
) {
  await asService((q) =>
    q.query(
      `insert into notifications(business_id,dedupe_key,severity,title,body,href) values ($1,$2,$3,$4,$5,'/app/settings/integrations')
       on conflict (business_id,dedupe_key) do update set severity=excluded.severity,title=excluded.title,body=excluded.body,resolved_at=null,read_at=null,created_at=now()`,
      [businessId, `integration:${provider}`, severity, title, body],
    ),
  );
}

/* * Runs one synchronisation and records an honest status. Never throws. */
export async function runSync(
  integrationId: string,
  trigger: "manual" | "initial" | "webhook" | "retry" | "schedule" = "manual",
): Promise<{ ok: boolean; error?: string; stats?: unknown }> {
  if (running.has(integrationId)) return { ok: false, error: "A sync is already running." };
  running.add(integrationId);
  let runId: string | null = null;
  let businessId = "";
  let provider: Provider = "shopify";
  try {
    const info = await loadIntegration(integrationId);
    if (!info) return { ok: false, error: "Integration not found." };
    businessId = info.business_id;
    provider = info.provider;
    if (!info.access_token_enc) return { ok: false, error: "Not connected." };
    if (info.status === "disconnected") return { ok: false, error: "Disconnected." };
    runId = await asService(async (q) => {
      await q.query("update integrations set status='syncing', last_error=null where id=$1", [integrationId]);
      const r = await q.query<{ id: string }>(
        "insert into sync_runs(business_id,integration_id,provider,trigger) values ($1,$2,$3,$4) returning id",
        [businessId, integrationId, provider, trigger],
      );
      return r[0].id;
    });
    const progress = async (s: unknown) => {
      await asService((q) =>
        q.query("update sync_runs set stats=$2::text::jsonb where id=$1", [runId, JSON.stringify(s)]),
      );
    };

    let stats: any;
    if (provider === "shopify") {
      const { gql } = await shopifyClient(integrationId);
      const identity = await fetchShopIdentity(gql).catch(() => null);
      if (identity) {
        await asService((q) =>
          q.query("update integrations set display_name=$2, meta = meta || $3::text::jsonb where id=$1", [
            integrationId,
            identity.name,
            JSON.stringify({ shop: identity }),
          ]),
        );
      }
      stats = await syncShopify({
        tx: asService,
        gql,
        businessId,
        businessCurrency: info.base_currency.trim(),
        timeZone: info.timezone || "UTC",
        since: info.last_sync_status === "success" ? info.last_sync_at : null,
        onProgress: progress,
      });
      if (identity && identity.currencyCode !== info.base_currency.trim())
        stats.currencyNote = `Store currency ${identity.currencyCode} differs from your base currency ${info.base_currency.trim()}; its sales are kept in a separate account and excluded from totals.`;
    } else {
      let token = info.access_token_enc ? decrypt(info.access_token_enc) : "";
      if (provider === "google_ads") {
        const expired = !info.expires_at || new Date(info.expires_at).getTime() < Date.now() + 60_000;
        if (expired) {
          if (!info.refresh_token_enc) throw new ProviderAuthError("Google access expired. Reconnect your account.");
          const t = await googleRefresh(decrypt(info.refresh_token_enc));
          token = t.access_token;
          await saveSecret(integrationId, businessId, t.access_token, null, t.expires_in);
        }
      } else if (info.expires_at && new Date(info.expires_at).getTime() < Date.now()) {
        throw new ProviderAuthError("The access token has expired. Reconnect your account.");
      }
      stats = await asService(async (q) => {
        if (provider === "meta_ads") {
          let acct = info.external_account;
          let cur = info.meta?.currency as string | undefined;
          if (!acct) {
            const accts = await metaAdAccounts(token);
            if (!accts[0]) throw new Error("No ad account is accessible with this login.");
            acct = accts[0].id;
            cur = accts[0].currency;
            await q.query(
              "update integrations set external_account=$2, display_name=$3, meta = meta || $4::text::jsonb where id=$1",
              [integrationId, acct, accts[0].name, JSON.stringify({ currency: cur })],
            );
          }
          return syncMeta(q, businessId, token, acct!, cur ?? info.base_currency.trim());
        }
        return syncGoogle(q, businessId, token, info.external_account!);
      });
    }

    const imported = (stats.imported ?? 0) + (stats.updated ?? 0) + (stats.rows ?? 0);
    await asService(async (q) => {
      await q.query(
        "update integrations set status='connected', last_sync_at=now(), last_sync_status='success', last_error=null where id=$1",
        [integrationId],
      );
      await q.query(
        "update sync_runs set status='success', finished_at=now(), records_imported=$2, stats=$3::text::jsonb where id=$1",
        [runId, imported, JSON.stringify(stats)],
      );
      await q.query("update notifications set resolved_at=now() where business_id=$1 and dedupe_key=$2", [
        businessId,
        `integration:${provider}`,
      ]);
    });
    await emitEvent({
      businessId,
      source: provider,
      type: "integration.synced",
      entityId: integrationId,
      payload: { runId, imported },
      idempotencyKey: `synced:${runId}`,
    }).catch(() => {});
    return { ok: true, stats };
  } catch (e) {
    const auth = e instanceof ProviderAuthError;
    const msg = e instanceof Error ? e.message : "Sync failed.";
    if (businessId) {
      await asService(async (q) => {
        await q.query("update integrations set status=$2, last_sync_status='failed', last_error=$3 where id=$1", [
          integrationId,
          auth ? "requires_reauth" : "sync_failed",
          msg,
        ]);
        if (runId)
          await q.query("update sync_runs set status='failed', finished_at=now(), error=$2 where id=$1", [runId, msg]);
      }).catch(() => {});
      await notify(
        businessId,
        provider,
        "critical",
        `${PROVIDER_INFO[provider].name} ${auth ? "needs to be reconnected" : "sync failed"}`,
        msg,
      ).catch(() => {});
    }
    return { ok: false, error: msg };
  } finally {
    running.delete(integrationId);
  }
}
