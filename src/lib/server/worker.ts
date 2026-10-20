import "server-only";
import { todayIn } from "@/lib/finance/dates";
import { asService } from "./db";
import { enqueue, registerHandler, runDue } from "./jobs";
import { executeAction } from "./brain/actions";
import { createDailyBriefing, evaluateCashRisk, evaluateFindings, measureOutcomes } from "./brain/workflows";
import { loadIntegration, runSync } from "./integrations/manager";
import { monitorActiveCampaigns } from "./routes/mediabuyer";

let registered = false;
export function registerHandlers() {
  if (registered) return;
  registered = true;

  registerHandler("integration.sync", async ({ job }) => {
    const r = await runSync(job.payload.integrationId, job.payload.trigger ?? "schedule");
    if (!r.ok) {
      const info = await loadIntegration(job.payload.integrationId);
      // Auth problems need the owner, not retries. Transient failures retry with backoff.
      if (info?.status === "sync_failed" && r.error !== "A sync is already running.")
        throw new Error(r.error ?? "sync failed");
    }
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });

  // Webhooks are treated as "something changed": we reconcile through the API (incremental sync) rather than
  // trusting the payload, so missed or out-of-order deliveries cannot corrupt data.
  registerHandler("shopify.process_webhook", async ({ job }) => {
    const r = await runSync(job.payload.integrationId, "webhook");
    if (!r.ok && r.error === "A sync is already running.") {
      await enqueue({
        businessId: job.business_id,
        kind: "integration.sync",
        payload: { integrationId: job.payload.integrationId, trigger: "webhook" },
        idempotencyKey: `webhook-followup:${job.payload.integrationId}:${Math.floor(Date.now() / 60_000)}`,
        runAfter: new Date(Date.now() + 30_000),
      });
      return { deferred: true };
    }
    if (!r.ok) throw new Error(r.error ?? "webhook processing failed");
    return { ok: true };
  });

  registerHandler("cash_risk.evaluate", async ({ job }) =>
    evaluateCashRisk(job.business_id!, job.payload.trigger ?? "event"),
  );
  registerHandler("findings.evaluate", async ({ job }) =>
    evaluateFindings(job.business_id!, job.payload.trigger ?? "event"),
  );
  registerHandler("ads.monitor", async ({ job }) => monitorActiveCampaigns(job.business_id!));
  registerHandler("action.execute", async ({ job }) => {
    const r = await executeAction(job.payload.actionId);
    return r;
  });
  registerHandler("briefing.daily", async ({ job }) => createDailyBriefing(job.business_id!));
  registerHandler("outcomes.measure", async ({ job }) => measureOutcomes(job.business_id!));
}

/* * Enqueues scheduled work. Idempotency keys make repeated ticks harmless. */
export async function scheduleTick(now = new Date()) {
  registerHandlers();
  const businesses = await asService((q) =>
    q.query<{ id: string; timezone: string }>(
      "select id, timezone from businesses where is_demo = false or is_demo = true",
    ),
  );
  let queued = 0;
  for (const b of businesses) {
    const local = todayIn(b.timezone || "UTC", now);
    let hour = 0;
    try {
      hour = Number(
        new Intl.DateTimeFormat("en-GB", { timeZone: b.timezone || "UTC", hour: "2-digit", hourCycle: "h23" }).format(
          now,
        ),
      );
    } catch {
      hour = now.getUTCHours();
    }
    if (hour >= 7) {
      if (
        (await enqueue({ businessId: b.id, kind: "briefing.daily", idempotencyKey: `briefing:${b.id}:${local}` }))
          .created
      )
        queued++;
    }
    if (
      (
        await enqueue({
          businessId: b.id,
          kind: "cash_risk.evaluate",
          payload: { trigger: "daily" },
          idempotencyKey: `cash_risk_daily:${b.id}:${local}`,
        })
      ).created
    )
      queued++;
    if (
      (
        await enqueue({
          businessId: b.id,
          kind: "findings.evaluate",
          payload: { trigger: "daily" },
          idempotencyKey: `findings_daily:${b.id}:${local}`,
        })
      ).created
    )
      queued++;
    if (
      (await enqueue({ businessId: b.id, kind: "outcomes.measure", idempotencyKey: `outcomes:${b.id}:${local}` }))
        .created
    )
      queued++;
  }
  // Follow up on running ads every 6 hours (pause losers, suggest scaling winners).
  const ads = await asService((q) =>
    q.query<{ business_id: string }>("select distinct business_id from ad_campaigns where status='active'"),
  );
  const adSlot = Math.floor(now.getTime() / (6 * 3600_000));
  for (const a of ads)
    if (
      (
        await enqueue({
          businessId: a.business_id,
          kind: "ads.monitor",
          idempotencyKey: `ads:${a.business_id}:${adSlot}`,
        })
      ).created
    )
      queued++;
  // Reconcile connected stores every 6 hours to recover anything a missed webhook would have carried.
  const integ = await asService((q) =>
    q.query<{ id: string; business_id: string }>(
      "select id,business_id from integrations where status in ('connected','sync_failed')",
    ),
  );
  const slot = Math.floor(now.getTime() / (6 * 3600_000));
  for (const i of integ) {
    if (
      (
        await enqueue({
          businessId: i.business_id,
          kind: "integration.sync",
          payload: { integrationId: i.id, trigger: "schedule" },
          idempotencyKey: `recon:${i.id}:${slot}`,
          maxAttempts: 3,
        })
      ).created
    )
      queued++;
  }
  return { businesses: businesses.length, queued };
}

const g = globalThis as unknown as { __marginWorkerStarted?: boolean };

/* * In-process worker for long-running Node servers (`next start` / `next dev`). */
export function startWorker() {
  if (g.__marginWorkerStarted) return;
  g.__marginWorkerStarted = true;
  registerHandlers();
  let busy = false;
  const loop = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDue({ max: 25 });
    } catch (e) {
      console.error("[worker]", e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  };
  setInterval(loop, 4_000).unref?.();
  const tick = () => scheduleTick().catch((e) => console.error("[scheduler]", e instanceof Error ? e.message : e));
  setTimeout(tick, 15_000).unref?.();
  setInterval(tick, 5 * 60_000).unref?.();
  console.log("[worker] started: jobs every 4s, schedule every 5 min");
}
