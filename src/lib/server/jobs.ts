import "server-only";
import crypto from "node:crypto";
import { asService, type Q } from "./db";

/*
 * Durable jobs stored in Postgres.
 *  - enqueue() is idempotent by idempotency_key.
 *  - claim() uses FOR UPDATE SKIP LOCKED so two workers never run the same job, and a lease (locked_until)
 *    so a job whose worker died is picked up again after the lease expires.
 *  - failures retry with exponential backoff; after max_attempts the job is dead-lettered and the owner notified.
 * The worker runs inside the Node server (src/instrumentation.ts) and/or via POST /api/cron/tick for serverless hosts.
 */

export interface Job {
  id: string;
  business_id: string | null;
  kind: string;
  payload: any;
  status: string;
  attempts: number;
  max_attempts: number;
  correlation_id: string | null;
  idempotency_key: string | null;
}

export interface JobContext {
  job: Job;
  /* * Re-schedule this job's next attempt without counting it as a failure (e.g. waiting for data). */
  log: (msg: string) => void;
}

type Handler = (ctx: JobContext) => Promise<unknown>;
const g = globalThis as unknown as {
  __marginHandlers?: Map<string, Handler>;
  __marginWorker?: { timer: NodeJS.Timeout | null; busy: boolean; id: string };
};
const handlers: Map<string, Handler> = (g.__marginHandlers ??= new Map<string, Handler>());

export function registerHandler(kind: string, fn: Handler) {
  handlers.set(kind, fn);
}

export interface EnqueueArgs {
  businessId: string | null;
  kind: string;
  payload?: unknown;
  idempotencyKey?: string;
  runAfter?: Date;
  maxAttempts?: number;
  correlationId?: string;
}

export async function enqueue(a: EnqueueArgs, q?: Q): Promise<{ id: string | null; created: boolean }> {
  const run = async (qq: Q) => {
    const r = await qq.query<{ id: string }>(
      `insert into jobs(business_id,kind,payload,idempotency_key,run_after,max_attempts,correlation_id)
       values ($1,$2,$3::text::jsonb,$4,coalesce($5::timestamptz, now()),$6,$7)
       on conflict (idempotency_key) where idempotency_key is not null do nothing returning id`,
      [
        a.businessId,
        a.kind,
        JSON.stringify(a.payload ?? {}),
        a.idempotencyKey ?? null,
        a.runAfter?.toISOString() ?? null,
        a.maxAttempts ?? 5,
        a.correlationId ?? null,
      ],
    );
    return { id: r[0]?.id ?? null, created: !!r[0] };
  };
  return q ? run(q) : asService(run);
}

export const backoffMs = (attempt: number) => Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1));

/* * Strip anything that looks like a credential before storing an error. */
export function redact(s: string): string {
  return s
    .replace(/shp(at|rt|ca|pa)_[A-Za-z0-9]+/g, "shp$1_[redacted]")
    .replace(
      /(access_token|refresh_token|client_secret|api[_-]?key|authorization)["'=:\s]+[^\s"',&]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 800);
}

export async function claim(workerId: string, limit = 5, kinds?: string[]): Promise<Job[]> {
  return asService((q) =>
    q.query<Job>(
      `update jobs set status='running', attempts=attempts+1, locked_by=$1, locked_until=now() + interval '3 minutes', updated_at=now()
       where id in (
         select id from jobs
         where ((status='queued' and run_after <= now()) or (status='running' and locked_until < now()))
           and ($3::text[] is null or kind = any($3::text[]))
         order by run_after asc limit $2 for update skip locked)
       returning id,business_id,kind,payload,status,attempts,max_attempts,correlation_id,idempotency_key`,
      [workerId, limit, kinds ?? null],
    ),
  );
}

async function finish(job: Job, ok: boolean, result: unknown, error?: string) {
  await asService(async (q) => {
    if (ok) {
      await q.query(
        "update jobs set status='succeeded', result=$2::text::jsonb, last_error=null, locked_until=null, finished_at=now(), updated_at=now() where id=$1",
        [job.id, JSON.stringify(result ?? null)],
      );
      return;
    }
    const dead = job.attempts >= job.max_attempts;
    await q.query(
      `update jobs set status=$2, last_error=$3, locked_until=null, updated_at=now(), finished_at = case when $2='dead' then now() else null end,
         run_after = case when $2='queued' then now() + ($4::int * interval '1 millisecond') else run_after end
       where id=$1`,
      [job.id, dead ? "dead" : "queued", redact(error ?? "failed"), backoffMs(job.attempts)],
    );
    if (dead && job.business_id) {
      await q.query(
        `insert into notifications(business_id,dedupe_key,severity,title,body,href) values ($1,$2,'critical',$3,$4,'/app/actions?tab=workflows')
         on conflict (business_id,dedupe_key) do update set body=excluded.body, resolved_at=null, read_at=null, created_at=now()`,
        [
          job.business_id,
          `job:dead:${job.kind}`,
          "A background task stopped after several attempts",
          `“${job.kind}” failed ${job.attempts} times: ${redact(error ?? "")}. You can retry it from the Action Center.`,
        ],
      );
    }
  });
}

export async function runJob(job: Job): Promise<{ ok: boolean; error?: string; result?: unknown }> {
  const fn = handlers.get(job.kind);
  if (!fn) {
    await finish({ ...job, attempts: job.max_attempts }, false, null, `No handler registered for ${job.kind}`);
    return { ok: false, error: "no handler" };
  }
  const logs: string[] = [];
  try {
    const result = await fn({ job, log: (m) => logs.push(m) });
    await finish(job, true, { result, logs });
    return { ok: true, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finish(job, false, null, msg);
    return { ok: false, error: msg };
  }
}

/* * Processes due jobs until none are left (bounded). Safe to call concurrently from several processes. */
export async function runDue(opts: { workerId?: string; max?: number; kinds?: string[] } = {}) {
  const workerId = opts.workerId ?? `w-${process.pid}-${crypto.randomUUID().slice(0, 6)}`;
  let processed = 0;
  let failed = 0;
  const max = opts.max ?? 50;
  while (processed < max) {
    const batch = await claim(workerId, Math.min(5, max - processed), opts.kinds);
    if (!batch.length) break;
    for (const j of batch) {
      const r = await runJob(j);
      processed++;
      if (!r.ok) failed++;
    }
  }
  return { processed, failed };
}

export async function retryJob(businessId: string, jobId: string): Promise<boolean> {
  const r = await asService((q) =>
    q.query(
      "update jobs set status='queued', attempts=0, run_after=now(), last_error=null, finished_at=null, updated_at=now() where id=$1 and business_id=$2 and status in ('dead','succeeded') returning id",
      [jobId, businessId],
    ),
  );
  return r.length > 0;
}

// events

export interface EmitArgs {
  businessId: string | null;
  source: string;
  type: string;
  entityId?: string;
  payload?: unknown;
  idempotencyKey: string;
  occurredAt?: string;
  correlationId?: string;
}

/* * Persists an event once (by idempotency key) and fans it out to the jobs that react to it. */
export async function emitEvent(e: EmitArgs): Promise<{ id: string | null; duplicate: boolean }> {
  return asService(async (q) => {
    const r = await q.query<{ id: string; correlation_id: string }>(
      `insert into events(business_id,source,type,entity_id,payload,idempotency_key,occurred_at,correlation_id)
       values ($1,$2,$3,$4,$5::text::jsonb,$6,coalesce($7::timestamptz, now()),coalesce($8::uuid, gen_random_uuid()))
       on conflict (idempotency_key) do nothing returning id, correlation_id`,
      [
        e.businessId,
        e.source,
        e.type,
        e.entityId ?? null,
        JSON.stringify(e.payload ?? {}),
        e.idempotencyKey,
        e.occurredAt ?? null,
        e.correlationId ?? null,
      ],
    );
    if (!r[0]) return { id: null, duplicate: true };
    for (const route of ROUTES[e.type] ?? []) {
      const job = route(e, r[0].correlation_id);
      if (job) await enqueue({ ...job, correlationId: r[0].correlation_id }, q);
    }
    return { id: r[0].id, duplicate: false };
  });
}

// Deterministic fan-out: which jobs an event triggers. LLMs are never invoked from here.
const bucket = (minutes: number) => Math.floor(Date.now() / (minutes * 60_000));
const ROUTES: Record<string, ((e: EmitArgs, corr: string) => EnqueueArgs | null)[]> = {
  "shopify.webhook.received": [
    (e) => ({
      businessId: e.businessId,
      kind: "shopify.process_webhook",
      payload: e.payload,
      idempotencyKey: `job:${e.idempotencyKey}`,
    }),
  ],
  "ledger.changed": [
    // Debounced: at most one cash check per business every 2 minutes.
    (e) =>
      e.businessId
        ? {
            businessId: e.businessId,
            kind: "cash_risk.evaluate",
            payload: { trigger: e.source },
            idempotencyKey: `cash_risk:${e.businessId}:${bucket(2)}`,
            runAfter: new Date(Date.now() + 5_000),
          }
        : null,
    (e) =>
      e.businessId
        ? {
            businessId: e.businessId,
            kind: "findings.evaluate",
            payload: { trigger: e.source },
            idempotencyKey: `findings:${e.businessId}:${bucket(2)}`,
            runAfter: new Date(Date.now() + 8_000),
          }
        : null,
  ],
  "integration.synced": [
    (e) =>
      e.businessId
        ? {
            businessId: e.businessId,
            kind: "cash_risk.evaluate",
            payload: { trigger: "sync" },
            idempotencyKey: `cash_risk:${e.businessId}:${bucket(2)}`,
          }
        : null,
    (e) =>
      e.businessId
        ? {
            businessId: e.businessId,
            kind: "findings.evaluate",
            payload: { trigger: "sync" },
            idempotencyKey: `findings:${e.businessId}:${bucket(2)}`,
          }
        : null,
  ],
};

export async function auditLog(
  q: Q,
  a: {
    businessId: string | null;
    actorType: "user" | "system" | "agent";
    actorId?: string | null;
    action: string;
    target?: string;
    detail?: unknown;
  },
) {
  await q.query(
    "insert into audit_log(business_id,actor_type,actor_id,action,target,detail) values ($1,$2,$3,$4,$5,$6::text::jsonb)",
    [a.businessId, a.actorType, a.actorId ?? null, a.action, a.target ?? null, JSON.stringify(a.detail ?? {})],
  );
}
