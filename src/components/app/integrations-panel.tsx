"use client";
import { AlertTriangle } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { useUi } from "../providers";
import { Badge, Button, Card, ConfirmDialog, Field, Input, Skeleton } from "../ui";
import { api, ApiError } from "@/lib/client/api";
import { refreshAll } from "@/lib/client/hooks";

interface Integ {
  provider: string;
  name: string;
  description: string;
  data: string[];
  scopes: string;
  needsShop: boolean;
  canWrite: boolean;
  configured: boolean;
  missingEnv: string[];
  callbackUrl: string;
  webhookUrl: string | null;
  webhookReady: boolean | null;
  webhookBlocker: string | null;
  hasRow: boolean;
  status: string;
  account: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastError: string | null;
  id: string | null;
  mode: string | null;
  shop: { name: string; myshopifyDomain: string; currencyCode: string; ianaTimezone: string } | null;
  webhooks: { uri: string | null; skipped?: string; results?: { topic: string; ok: boolean; error?: string }[] } | null;
  diagnostics: {
    at: string;
    checks: { key: string; label: string; status: "pass" | "fail" | "warn"; detail: string }[];
  } | null;
  runs: {
    id: string;
    status: string;
    trigger: string;
    started_at: string;
    finished_at: string | null;
    records_imported: number;
    error: string | null;
    stats: any;
  }[];
}

const STATUS_UI: Record<string, { label: string; tone: "neutral" | "pos" | "neg" | "warn" | "info" }> = {
  disconnected: { label: "Disconnected", tone: "neutral" },
  none: { label: "Not connected", tone: "neutral" },
  connecting: { label: "Connecting…", tone: "info" },
  connected: { label: "Connected", tone: "pos" },
  syncing: { label: "Syncing…", tone: "info" },
  sync_failed: { label: "Needs attention", tone: "neg" },
  requires_reauth: { label: "Needs attention · reconnect", tone: "warn" },
};

export function IntegrationsPanel() {
  const sp = useSearchParams();
  const { toast } = useUi();
  const { data, mutate } = useSWR<{ items: Integ[] }>("/api/integrations", {
    refreshInterval: (d) => (d?.items.some((i) => i.status === "syncing" || i.status === "connecting") ? 1500 : 0),
  });
  const [shop, setShop] = useState("");
  const [sameOrg, setSameOrg] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ p: string; kind: "disconnect" | "purge" | "uninstall" } | null>(null);

  useEffect(() => {
    const install = sp.get("install");
    if (install) {
      setShop(install);
      toast({
        title: `Finish connecting ${install}`,
        description: "Check the store address, then select “Install with Shopify” to authorise read-only access.",
      });
    }
    if (sp.get("connected"))
      toast({ title: "Connected", description: "The first sync has started. Progress is shown below." });
    if (sp.get("error"))
      toast({ title: "Connection was not completed", description: sp.get("error") ?? undefined, tone: "error" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (p: string, fn: () => Promise<unknown>) => {
    setBusy(p);
    setErr((e) => ({ ...e, [p]: "" }));
    try {
      return await fn();
    } catch (x) {
      setErr((e) => ({ ...e, [p]: x instanceof ApiError ? x.message : "Request failed." }));
    } finally {
      setBusy(null);
      mutate();
    }
  };

  if (!data) return <Skeleton className="h-96" />;
  return (
    <>
      <p className="max-w-2xl text-sm leading-relaxed text-ink2">
        Connections import data automatically. Every status below is real: nothing says “Connected” until the provider
        has authorised Socio, and sync results come from actual runs. Socio works fully without any of them.
      </p>
      {data.items.map((i) => {
        const st = STATUS_UI[i.hasRow ? i.status : "none"] ?? STATUS_UI.none;
        const live = i.hasRow && i.status !== "disconnected";
        const running = i.runs.find((r) => r.status === "running");
        return (
          <Card key={i.provider} className="p-5 sm:p-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="display text-xl">{i.name}</h3>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  {!i.configured && <Badge tone="warn">Server setup required</Badge>}
                  {!i.canWrite && <Badge>Read-only</Badge>}
                </div>
                <p className="mt-1 max-w-xl text-sm text-ink2">{i.description}</p>
              </div>
              {live && i.shop && (
                <div className="text-end text-sm">
                  <p className="font-medium text-ink">{i.shop.name}</p>
                  <p className="text-xs text-ink3">
                    {i.shop.myshopifyDomain} · {i.shop.currencyCode} · {i.shop.ianaTimezone}
                  </p>
                  {i.mode && (
                    <p className="text-xs text-ink3">
                      {i.mode === "client_credentials"
                        ? "Same-organization app (client credentials)"
                        : "Installed with Shopify OAuth"}
                    </p>
                  )}
                </div>
              )}
              {live && !i.shop && i.account && (
                <p className="text-sm text-ink2">
                  Account: <strong className="text-ink">{i.account}</strong>
                </p>
              )}
            </div>

            <div className="mt-4 grid gap-4 text-[13px] sm:grid-cols-2">
              <div>
                <p className="eyebrow">Data imported</p>
                <ul className="mt-1.5 space-y-1 text-ink2">
                  {i.data.map((d) => (
                    <li key={d}>• {d}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="eyebrow">Permissions requested</p>
                <p className="mt-1.5 break-words text-ink2">
                  {i.scopes} <span className="text-ink3">(read-only)</span>
                </p>
                <p className="mt-2 text-ink3">
                  Last successful sync: {i.lastSyncAt ? new Date(i.lastSyncAt).toLocaleString() : "never"}
                </p>
              </div>
            </div>

            {running && (
              <div className="mt-4 rounded-xl bg-infosoft px-4 py-3 text-sm text-info" role="status">
                Syncing — {running.stats?.phase ?? "starting"}: {running.stats?.orders ?? 0} orders checked (
                {running.stats?.imported ?? 0} new), {running.stats?.products ?? 0} products,{" "}
                {running.stats?.pages ?? 0} page(s).
              </div>
            )}
            {i.lastError && (
              <p
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-xl bg-negsoft px-3.5 py-3 text-sm text-neg"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  <strong>{i.status === "requires_reauth" ? "Reconnect needed:" : "Last error:"}</strong> {i.lastError}
                </span>
              </p>
            )}
            {err[i.provider] && (
              <p role="alert" className="mt-3 rounded-xl bg-negsoft px-3.5 py-2.5 text-sm text-neg">
                {err[i.provider]}
              </p>
            )}

            {live && i.provider === "shopify" && i.webhooks && (
              <div className="mt-4 rounded-xl border border-line p-4 text-[13px]">
                <p className="font-medium text-ink">Live updates (webhooks)</p>
                {i.webhooks.uri ? (
                  <>
                    <p className="mt-1 text-ink2">
                      Registered to <span className="break-all font-mono text-xs">{i.webhooks.uri}</span>
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {(i.webhooks.results ?? []).map((w) => (
                        <li key={w.topic}>
                          <Badge tone={w.ok ? "pos" : "warn"}>{w.topic.toLowerCase()}</Badge>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="mt-1 text-warn">{i.webhooks.skipped}</p>
                )}
                <p className="mt-2 text-ink3">
                  Socio also re-checks the store every 6 hours to recover anything a missed webhook would have carried.
                </p>
              </div>
            )}

            {i.diagnostics && live && (
              <div className="mt-4 rounded-xl border border-line p-4">
                <p className="text-sm font-medium text-ink">
                  Diagnostics · {new Date(i.diagnostics.at).toLocaleString()}
                </p>
                <ul className="mt-2 space-y-1.5 text-[13px]">
                  {i.diagnostics.checks.map((c) => (
                    <li key={c.key} className="flex gap-2">
                      <Badge tone={c.status === "pass" ? "pos" : c.status === "warn" ? "warn" : "neg"}>
                        {c.status}
                      </Badge>
                      <span>
                        <span className="font-medium text-ink">{c.label}.</span>{" "}
                        <span className="text-ink2">{c.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!i.configured && (
              <div className="mt-4 rounded-xl border border-dashed border-line2 bg-sunken/60 p-4 text-[13px] text-ink2">
                <p className="font-medium text-ink">This server is missing provider credentials</p>
                <p className="mt-1">
                  Set{" "}
                  <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs">{i.missingEnv.join(", ")}</code>{" "}
                  in the server environment, then register this redirect URL in the provider&rsquo;s developer settings:
                </p>
                <p className="mt-2 break-all rounded-lg bg-raised px-2.5 py-1.5 font-mono text-xs">{i.callbackUrl}</p>
              </div>
            )}
            {i.provider === "shopify" && i.configured && i.webhookBlocker && (
              <p className="mt-3 text-[13px] text-warn">{i.webhookBlocker}</p>
            )}

            <div className="mt-5 flex flex-wrap items-end gap-2 border-t border-line pt-5">
              {!live || i.status === "requires_reauth" ? (
                <>
                  {i.needsShop && (
                    <>
                      <Field
                        label="Store address"
                        htmlFor={`shop-${i.provider}`}
                        className="min-w-[14rem] flex-1 sm:max-w-xs"
                      >
                        <Input
                          id={`shop-${i.provider}`}
                          placeholder="your-store.myshopify.com"
                          value={shop}
                          onChange={(e) => setShop(e.target.value)}
                          disabled={!i.configured}
                        />
                      </Field>
                      <label className="mb-3 flex items-center gap-2 text-[13px] text-ink2">
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--accent)]"
                          checked={sameOrg}
                          onChange={(e) => setSameOrg(e.target.checked)}
                          disabled={!i.configured}
                        />
                        Store is in the same Shopify organization as the app
                      </label>
                    </>
                  )}
                  <Button
                    variant="primary"
                    disabled={!i.configured || (i.needsShop && !shop.trim())}
                    loading={busy === i.provider}
                    onClick={() =>
                      act(i.provider, async () => {
                        const r = await api.post<{ url?: string; connected?: boolean }>(
                          `/api/integrations/${i.provider}/connect`,
                          {
                            shop: i.needsShop ? shop : undefined,
                            mode: i.needsShop && sameOrg ? "client_credentials" : "oauth",
                          },
                        );
                        if (r.url) window.location.href = r.url;
                        else toast({ title: "Connected", description: "The first sync has started." });
                      })
                    }
                  >
                    {i.status === "requires_reauth"
                      ? "Reconnect"
                      : i.needsShop && !sameOrg
                        ? "Install with Shopify"
                        : `Connect ${i.name}`}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="primary"
                    loading={busy === i.provider || i.status === "syncing"}
                    disabled={i.status === "syncing" || i.status === "connecting"}
                    onClick={() => act(i.provider, () => api.post(`/api/integrations/${i.provider}/sync`, {}))}
                  >
                    {i.status === "sync_failed" ? "Retry sync" : "Sync now"}
                  </Button>
                  {i.provider === "shopify" && (
                    <Button
                      loading={busy === "diag"}
                      onClick={async () => {
                        setBusy("diag");
                        try {
                          await api.post("/api/integrations/shopify/diagnose", {});
                          toast({ title: "Diagnostics finished" });
                        } catch (x) {
                          toast({
                            title: "Diagnostics failed",
                            description: x instanceof ApiError ? x.message : undefined,
                            tone: "error",
                          });
                        } finally {
                          setBusy(null);
                          mutate();
                        }
                      }}
                    >
                      Run diagnostics
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => setConfirm({ p: i.provider, kind: "disconnect" })}>
                    Disconnect
                  </Button>
                  {i.provider === "shopify" && (
                    <Button variant="ghost" onClick={() => setConfirm({ p: i.provider, kind: "uninstall" })}>
                      Uninstall from store…
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="text-neg"
                    onClick={() => setConfirm({ p: i.provider, kind: "purge" })}
                  >
                    Remove imported data…
                  </Button>
                </>
              )}
            </div>

            {i.runs.length > 0 && (
              <details className="mt-4 text-[13px]">
                <summary className="cursor-pointer font-medium text-ink">Sync history</summary>
                <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                  {i.runs.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                      <span className="text-ink2">
                        {new Date(r.started_at).toLocaleString()} · {r.trigger}
                      </span>
                      <span className="flex items-center gap-2">
                        {r.status === "success" && (
                          <span className="text-ink3">
                            {r.stats?.orders ?? 0} orders checked, {r.records_imported} records written
                          </span>
                        )}
                        {r.error && (
                          <span className="max-w-[14rem] truncate text-neg" title={r.error}>
                            {r.error}
                          </span>
                        )}
                        <Badge tone={r.status === "success" ? "pos" : r.status === "failed" ? "neg" : "info"}>
                          {r.status}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>
        );
      })}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirm?.kind === "purge"
            ? "Remove imported data?"
            : confirm?.kind === "uninstall"
              ? "Uninstall the app from your store?"
              : "Disconnect?"
        }
        body={
          confirm?.kind === "purge"
            ? "This deletes every record Socio imported from this provider (orders, refunds, products or ad metrics). Records you entered yourself are not touched. This cannot be undone."
            : confirm?.kind === "uninstall"
              ? "Socio asks Shopify to uninstall the app. Shopify removes its webhooks and invalidates its access. You would need to install it again to reconnect. Imported records stay."
              : "Socio deletes its access token and its webhook subscriptions, and stops syncing. Records already imported stay in your ledger."
        }
        confirmLabel={
          confirm?.kind === "purge"
            ? "Remove imported data"
            : confirm?.kind === "uninstall"
              ? "Uninstall"
              : "Disconnect"
        }
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm.kind === "purge") await api.post(`/api/integrations/${confirm.p}/purge`, { confirm: "DELETE" });
          else {
            const r = await api.post<any>(`/api/integrations/${confirm.p}/disconnect`, {
              uninstall: confirm.kind === "uninstall",
            });
            if (confirm.kind === "uninstall")
              toast({
                title:
                  r.report?.tokenStillValid === false
                    ? "Uninstalled — access confirmed revoked"
                    : "Uninstall requested",
                description: r.report?.remoteCleanupError ?? undefined,
              });
          }
          await refreshAll();
          mutate();
          if (confirm.kind !== "uninstall")
            toast({ title: confirm.kind === "purge" ? "Imported data removed" : "Disconnected" });
        }}
      />
    </>
  );
}
