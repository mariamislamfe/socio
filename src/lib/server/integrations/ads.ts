import "server-only";
import { addDays, todayISO } from "@/lib/finance/dates";
import { currencyDigits, toMinor } from "@/lib/finance/money";
import type { Q } from "../db";
import { ProviderAuthError, ProviderError } from "./shopify";

// Meta Ads (Marketing API)

export const META_VERSION = () => process.env.META_API_VERSION || "v21.0";
/* * Graph API base. META_API_BASE (a local fake) is honoured only outside production. */
export const metaGraph = () =>
  `${(process.env.NODE_ENV !== "production" && process.env.META_API_BASE) || "https://graph.facebook.com"}/${META_VERSION()}`;
// Read-only by default. The media buyer needs: ads_read,ads_management,pages_show_list,pages_manage_ads (set META_SCOPES).
export const META_SCOPES = () => process.env.META_SCOPES || "ads_read";

export function metaAuthorizeUrl(state: string, redirectUri: string) {
  const p = new URLSearchParams({
    client_id: process.env.META_APP_ID!,
    redirect_uri: redirectUri,
    state,
    scope: META_SCOPES(),
    response_type: "code",
  });
  return `https://www.facebook.com/${META_VERSION()}/dialog/oauth?${p}`;
}

export async function metaExchange(
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; expires_in?: number }> {
  const p = new URLSearchParams({
    client_id: process.env.META_APP_ID!,
    client_secret: process.env.META_APP_SECRET!,
    redirect_uri: redirectUri,
    code,
  });
  const r = await fetch(`${metaGraph()}/oauth/access_token?${p}`);
  if (!r.ok) throw new ProviderError(`Meta rejected the authorization code (HTTP ${r.status}).`);
  const short = (await r.json()) as { access_token: string };
  // Upgrade to a long-lived token so syncs keep working for ~60 days.
  const p2 = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: process.env.META_APP_ID!,
    client_secret: process.env.META_APP_SECRET!,
    fb_exchange_token: short.access_token,
  });
  const r2 = await fetch(`${metaGraph()}/oauth/access_token?${p2}`);
  if (!r2.ok) return short;
  return (await r2.json()) as { access_token: string; expires_in?: number };
}

async function metaGet(url: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return json;
    const code = json?.error?.code;
    if (res.status === 401 || code === 190 || code === 102)
      throw new ProviderAuthError(json?.error?.message ?? "Meta access token is no longer valid.");
    if (code === 4 || code === 17 || code === 32 || code === 613 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new ProviderError(json?.error?.message ?? `Meta returned HTTP ${res.status}`);
  }
  throw new ProviderError("Meta is rate limiting requests. Try again shortly.", true);
}

export async function metaAdAccounts(token: string): Promise<{ id: string; name: string; currency: string }[]> {
  const j = await metaGet(
    `${metaGraph()}/me/adaccounts?fields=id,name,currency&limit=50&access_token=${encodeURIComponent(token)}`,
  );
  return (j.data ?? []) as { id: string; name: string; currency: string }[];
}

export interface AdRow {
  campaign_id: string;
  campaign_name: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  attributed_revenue: number;
  currency: string;
}

export async function syncMeta(
  q: Q,
  businessId: string,
  token: string,
  accountId: string,
  currency: string,
  sinceDays = 90,
): Promise<{ rows: number }> {
  const until = todayISO();
  const since = addDays(until, -sinceDays);
  const fields = "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,date_start";
  let url: string | null =
    `${metaGraph()}/${accountId}/insights?level=campaign&time_increment=1&limit=500&fields=${fields}` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&access_token=${encodeURIComponent(token)}`;
  let n = 0;
  const purchase = (arr?: { action_type: string; value: string }[]) =>
    Number((arr ?? []).find((a) => a.action_type === "omni_purchase" || a.action_type === "purchase")?.value ?? 0);
  while (url) {
    const j: any = await metaGet(url);
    for (const r of j.data ?? []) {
      const spend = toMinor(r.spend ?? "0", currency) ?? 0;
      const revenue = Math.round(purchase(r.action_values) * 10 ** currencyDigits(currency));
      await q.query(
        `insert into ad_metrics(business_id,provider,account_id,campaign_id,campaign_name,date,spend,impressions,clicks,conversions,attributed_revenue,currency)
         values ($1,'meta_ads',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (business_id,provider,campaign_id,date) do update set campaign_name=excluded.campaign_name, spend=excluded.spend, impressions=excluded.impressions,
           clicks=excluded.clicks, conversions=excluded.conversions, attributed_revenue=excluded.attributed_revenue, currency=excluded.currency`,
        [
          businessId,
          accountId,
          r.campaign_id,
          r.campaign_name ?? "",
          r.date_start,
          spend,
          Number(r.impressions ?? 0),
          Number(r.clicks ?? 0),
          purchase(r.actions),
          revenue,
          currency,
        ],
      );
      n++;
    }
    url = j.paging?.next ?? null;
  }
  return { rows: n };
}

// Google Ads

export const GOOGLE_ADS_VERSION = () => process.env.GOOGLE_ADS_API_VERSION || "v21";
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/adwords";

export function googleAuthorizeUrl(state: string, redirectUri: string) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function googleExchange(
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_ADS_CLIENT_ID!,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!r.ok) throw new ProviderError(`Google rejected the authorization code (HTTP ${r.status}).`);
  return r.json();
}

export async function googleRefresh(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_ADS_CLIENT_ID!,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  if (r.status === 400 || r.status === 401)
    throw new ProviderAuthError("Google access was revoked or expired. Reconnect your Google Ads account.");
  if (!r.ok) throw new ProviderError(`Google token refresh failed (HTTP ${r.status}).`);
  return r.json();
}

function gHeaders(token: string) {
  const h: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
    "content-type": "application/json",
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) h["login-customer-id"] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  return h;
}

export async function googleCustomers(token: string): Promise<string[]> {
  const r = await fetch(`https://googleads.googleapis.com/${GOOGLE_ADS_VERSION()}/customers:listAccessibleCustomers`, {
    headers: gHeaders(token),
  });
  if (r.status === 401 || r.status === 403)
    throw new ProviderAuthError("Google Ads rejected access. Check the developer token and permissions.");
  if (!r.ok) throw new ProviderError(`Google Ads returned HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.resourceNames ?? []).map((n: string) => n.replace("customers/", ""));
}

async function gaql(token: string, customerId: string, query: string): Promise<any[]> {
  const r = await fetch(
    `https://googleads.googleapis.com/${GOOGLE_ADS_VERSION()}/customers/${customerId}/googleAds:search`,
    {
      method: "POST",
      headers: gHeaders(token),
      body: JSON.stringify({ query, pageSize: 10000 }),
    },
  );
  if (r.status === 401 || r.status === 403)
    throw new ProviderAuthError("Google Ads rejected access. Reconnect your account.");
  if (!r.ok) throw new ProviderError(`Google Ads returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return j.results ?? [];
}

export async function syncGoogle(
  q: Q,
  businessId: string,
  token: string,
  customerId: string,
  sinceDays = 90,
): Promise<{ rows: number; currency: string }> {
  const cur = (await gaql(token, customerId, "SELECT customer.currency_code FROM customer LIMIT 1"))[0]?.customer
    ?.currencyCode as string | undefined;
  if (!cur) throw new ProviderError("Could not read the Google Ads account currency.");
  const digits = currencyDigits(cur);
  const until = todayISO();
  const since = addDays(until, -sinceDays);
  const rows = await gaql(
    token,
    customerId,
    `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
     FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`,
  );
  let n = 0;
  for (const r of rows) {
    const spend = Math.round(Number(r.metrics.costMicros ?? 0) / 10 ** (6 - digits));
    const revenue = Math.round(Number(r.metrics.conversionsValue ?? 0) * 10 ** digits);
    await q.query(
      `insert into ad_metrics(business_id,provider,account_id,campaign_id,campaign_name,date,spend,impressions,clicks,conversions,attributed_revenue,currency)
       values ($1,'google_ads',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (business_id,provider,campaign_id,date) do update set campaign_name=excluded.campaign_name, spend=excluded.spend, impressions=excluded.impressions,
         clicks=excluded.clicks, conversions=excluded.conversions, attributed_revenue=excluded.attributed_revenue, currency=excluded.currency`,
      [
        businessId,
        customerId,
        String(r.campaign.id),
        r.campaign.name ?? "",
        r.segments.date,
        spend,
        Number(r.metrics.impressions ?? 0),
        Number(r.metrics.clicks ?? 0),
        Number(r.metrics.conversions ?? 0),
        revenue,
        cur,
      ],
    );
    n++;
  }
  return { rows: n, currency: cur };
}
