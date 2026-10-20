import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "margin-brain-")) + "/db";
process.env.MARGIN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
delete process.env.SUPABASE_DB_URL;
delete process.env.RESEND_API_KEY;

const { asService } = await import("@/lib/server/db");
const jobs = await import("@/lib/server/jobs");
const { decide, paramsHash, DEFAULT_AUTOMATION } = await import("@/lib/server/brain/policy");
const actions = await import("@/lib/server/brain/actions");
const wf = await import("@/lib/server/brain/workflows");
const { createBusiness } = await import("@/lib/server/workspace");
const { localDateOf, todayIn, addDays } = await import("@/lib/finance/dates");
const { normalizeOrder } = await import("@/lib/server/integrations/shopify");
const { profitReport } = await import("@/lib/finance/profit");

const today = todayIn("Africa/Cairo");
let biz = "";
let user = "";
let bank = "";

describe("time zones and date boundaries", () => {
  it("assigns an order to the business's local day, not UTC", () => {
    // 22:30 UTC on Oct 5 is already Oct 6 in Cairo (UTC+3 in summer) and still Oct 5 in New York.
    expect(localDateOf("2026-10-05T22:30:00Z", "Africa/Cairo")).toBe("2026-10-06");
    expect(localDateOf("2026-10-05T22:30:00Z", "America/New_York")).toBe("2026-10-05");
    expect(localDateOf("2026-10-05T22:30:00Z", "Not/AZone")).toBe("2026-10-05");
  });
  it("normalizes Shopify orders into local dates", () => {
    const o: any = {
      id: "gid://shopify/Order/1",
      name: "#1",
      createdAt: "2026-10-05T22:30:00Z",
      processedAt: "2026-10-05T22:30:00Z",
      updatedAt: "2026-10-05T22:30:00Z",
      cancelledAt: null,
      displayFinancialStatus: "PAID",
      currencyCode: "EGP",
      totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "EGP" } },
      totalTaxSet: { shopMoney: { amount: "0" } },
      totalRefundedSet: { shopMoney: { amount: "0" } },
      refunds: [],
      lineItems: {
        nodes: [
          {
            id: "l1",
            title: "Shirt",
            quantity: 2,
            currentQuantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: "50.00" } },
            discountedTotalSet: { shopMoney: { amount: "100.00" } },
            variant: { id: "v1", inventoryItem: { unitCost: { amount: "20.00" } } },
          },
        ],
      },
    };
    const n = normalizeOrder(o, "Africa/Cairo");
    expect(n.order.local_date).toBe("2026-10-06");
    expect(n.txns[0].date).toBe("2026-10-06");
    expect(n.lines[0]).toMatchObject({ quantity: 2, current_quantity: 1, unit_cost: 2000, discounted_total: 10000 });
  });
});

describe("policy engine", () => {
  const base = { automation: DEFAULT_AUTOMATION, role: "owner" as const };
  it("runs level-1 internal actions automatically, and never runs level-3 without approval", () => {
    expect(decide({ ...base, tool: "create_task", risk: 1 }).mode).toBe("auto");
    expect(decide({ ...base, tool: "reschedule_payable", risk: 3 }).mode).toBe("approval");
  });
  it("the global pause stops everything automatic", () => {
    expect(
      decide({ ...base, automation: { ...DEFAULT_AUTOMATION, paused: true }, tool: "create_task", risk: 1 }).mode,
    ).toBe("approval");
  });
  it("level-2 limits are enforced on the server", () => {
    const auto = { ...DEFAULT_AUTOMATION, paymentReminders: { enabled: true, maxAmount: 100_000, minDaysBetween: 7 } };
    expect(
      decide({
        ...base,
        automation: auto,
        tool: "send_payment_reminder",
        risk: 2,
        bounded: { amount: 50_000, daysSinceLast: null },
      }).mode,
    ).toBe("auto");
    expect(
      decide({
        ...base,
        automation: auto,
        tool: "send_payment_reminder",
        risk: 2,
        bounded: { amount: 150_000, daysSinceLast: null },
      }).mode,
    ).toBe("approval");
    expect(
      decide({
        ...base,
        automation: auto,
        tool: "send_payment_reminder",
        risk: 2,
        bounded: { amount: 50_000, daysSinceLast: 2 },
      }).mode,
    ).toBe("approval");
    expect(
      decide({ ...base, tool: "send_payment_reminder", risk: 2, bounded: { amount: 1, daysSinceLast: null } }).mode,
    ).toBe("approval");
  });
  it("viewers cannot trigger anything", () => {
    expect(decide({ ...base, role: "viewer", tool: "create_task", risk: 1 }).mode).toBe("prohibited");
  });
  it("approval hashes bind the exact parameters (key order does not matter, values do)", () => {
    expect(paramsHash("t", { a: 1, b: 2 })).toBe(paramsHash("t", { b: 2, a: 1 }));
    expect(paramsHash("t", { a: 1 })).not.toBe(paramsHash("t", { a: 2 }));
    expect(paramsHash("t", { a: 1 })).not.toBe(paramsHash("u", { a: 1 }));
  });
});

describe("durable jobs", () => {
  beforeAll(async () => {
    await asService(async (q) => {
      user = (await q.query<{ id: string }>("insert into auth.users(email) values ('brain@x.test') returning id"))[0]
        .id;
    });
    biz = await createBusiness(user, {
      name: "Brain Co",
      business_type: "fashion",
      country: "EG",
      currency: "EGP",
      stage: "early",
      channels: [],
      has_history: false,
      setup_mode: "manual",
    });
    bank = (
      await asService((q) =>
        q.query<{ id: string }>(
          "insert into accounts(business_id,name,type,currency,opening_balance) values ($1,'Bank','bank','EGP',1000000) returning id",
          [biz],
        ),
      )
    )[0].id;
  });

  it("enqueue is idempotent", async () => {
    const a = await jobs.enqueue({ businessId: biz, kind: "test.ok", idempotencyKey: "k1" });
    const b = await jobs.enqueue({ businessId: biz, kind: "test.ok", idempotencyKey: "k1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });

  it("succeeds, retries with backoff, then dead-letters and notifies", async () => {
    let calls = 0;
    jobs.registerHandler("test.ok", async () => "fine");
    jobs.registerHandler("test.flaky", async () => {
      calls++;
      throw new Error("boom access_token=shpat_secret123");
    });
    await jobs.runDue({ kinds: ["test.ok"] });
    const ok = await asService((q) => q.query<any>("select status from jobs where idempotency_key='k1'"));
    expect(ok[0].status).toBe("succeeded");

    await jobs.enqueue({ businessId: biz, kind: "test.flaky", idempotencyKey: "f1", maxAttempts: 2 });
    await jobs.runDue({ kinds: ["test.flaky"] });
    let j = (
      await asService((q) =>
        q.query<any>("select status,attempts,last_error,run_after from jobs where idempotency_key='f1'"),
      )
    )[0];
    expect(j.status).toBe("queued");
    expect(j.attempts).toBe(1);
    expect(new Date(j.run_after).getTime()).toBeGreaterThan(Date.now() + 10_000); // backoff
    expect(j.last_error).not.toContain("shpat_secret123"); // secrets redacted
    await asService((q) => q.query("update jobs set run_after=now() where idempotency_key='f1'"));
    await jobs.runDue({ kinds: ["test.flaky"] });
    j = (await asService((q) => q.query<any>("select status,attempts from jobs where idempotency_key='f1'")))[0];
    expect(j.status).toBe("dead");
    expect(calls).toBe(2);
    const n = await asService((q) =>
      q.query("select 1 from notifications where business_id=$1 and dedupe_key='job:dead:test.flaky'", [biz]),
    );
    expect(n).toHaveLength(1);
    expect(
      await jobs.retryJob(
        biz,
        (await asService((q) => q.query<any>("select id from jobs where idempotency_key='f1'")))[0].id,
      ),
    ).toBe(true);
  });

  it("recovers a job whose worker died (expired lease) and never runs one job twice concurrently", async () => {
    let runs = 0;
    jobs.registerHandler("test.once", async () => {
      runs++;
      return runs;
    });
    await jobs.enqueue({ businessId: biz, kind: "test.once", idempotencyKey: "once1" });
    const [a, b] = await Promise.all([jobs.claim("w1", 5, ["test.once"]), jobs.claim("w2", 5, ["test.once"])]);
    expect(a.length + b.length).toBe(1);
    // Simulate a crashed worker: lease expires, another worker picks it up.
    await asService((q) =>
      q.query("update jobs set locked_until = now() - interval '1 second' where idempotency_key='once1'"),
    );
    const again = await jobs.claim("w3", 5, ["test.once"]);
    expect(again).toHaveLength(1);
    await jobs.runJob(again[0]);
    expect(runs).toBe(1);
  });

  it("events are stored once and fan out to the right job", async () => {
    const e1 = await jobs.emitEvent({
      businessId: biz,
      source: "test",
      type: "ledger.changed",
      idempotencyKey: "ev-1",
    });
    const e2 = await jobs.emitEvent({
      businessId: biz,
      source: "test",
      type: "ledger.changed",
      idempotencyKey: "ev-1",
    });
    expect(e1.duplicate).toBe(false);
    expect(e2.duplicate).toBe(true);
    const q = await asService((qq) =>
      qq.query<any>("select count(*)::int n from jobs where business_id=$1 and kind='cash_risk.evaluate'", [biz]),
    );
    expect(q[0].n).toBe(1);
  });
});

describe("cash-risk response workflow", () => {
  let payable = "";
  let receivable = "";
  beforeAll(async () => {
    await asService(async (q) => {
      const sup = (
        await q.query<{ id: string }>(
          "insert into payees(business_id,name,kind) values ($1,'Fabric Co','supplier') returning id",
          [biz],
        )
      )[0].id;
      const cust = (
        await q.query<{ id: string }>(
          "insert into payees(business_id,name,kind) values ($1,'Shop A','customer') returning id",
          [biz],
        )
      )[0].id;
      payable = (
        await q.query<{ id: string }>(
          "insert into invoices(business_id,direction,payee_id,description,amount,currency,issue_date,due_date) values ($1,'payable',$2,'Fabric batch',1200000,'EGP',$3,$4) returning id",
          [biz, sup, today, addDays(today, 10)],
        )
      )[0].id;
      receivable = (
        await q.query<{ id: string }>(
          "insert into invoices(business_id,direction,payee_id,description,amount,currency,issue_date,due_date) values ($1,'receivable',$2,'Wholesale order',400000,'EGP',$3,$4) returning id",
          [biz, cust, today, addDays(today, 25)],
        )
      )[0].id;
      await q.query("update businesses set settings = settings || '{\"safetyReserve\": 200000}'::jsonb where id=$1", [
        biz,
      ]);
      await q.query(
        "insert into transactions(business_id,type,date,amount,currency,account_id) values ($1,'income',$2,50000,'EGP',$3)",
        [biz, addDays(today, -3), bank],
      );
    });
  });

  it("detects the risk, explains it, computes options and acts within policy", async () => {
    const r: any = await wf.evaluateCashRisk(biz, "test");
    expect(r.atRisk).toBe(true);
    expect(r.breachDate).toBe(addDays(today, 10));
    const rec = (
      await asService((q) => q.query<any>("select * from recommendations where id=$1", [r.recommendationId]))
    )[0];
    expect(rec.evidence.facts.join(" ")).toMatch(/Fabric batch/);
    expect(rec.evidence.unknowns.join(" ")).toMatch(/no bank connection/i);
    const keys = rec.options.map((o: any) => o.key);
    expect(keys).toEqual(expect.arrayContaining(["collect", "delay_payable"]));
    const delay = rec.options.find((o: any) => o.key === "delay_payable");
    expect(delay.resolves).toBe(true);
    expect(delay.newLowest).toBeGreaterThan(rec.evidence.lowest);
    // Level 1 ran automatically and was verified.
    const acts = await asService((q) =>
      q.query<any>("select tool,status,verification from actions where recommendation_id=$1", [rec.id]),
    );
    const byTool = Object.fromEntries(acts.map((a: any) => [a.tool, a]));
    expect(byTool.send_internal_alert.status).toBe("succeeded");
    expect(byTool.create_task.status).toBe("succeeded");
    expect(byTool.create_task.verification.ok).toBe(true);
    // No email provider: the reminder becomes a draft, never a fake "sent".
    expect(byTool.send_payment_reminder).toBeUndefined();
    expect(byTool.draft_email.status).toBe("succeeded");
    // Level 3 waits for approval.
    expect(byTool.reschedule_payable.status).toBe("awaiting_approval");
    // A prediction was recorded for later comparison.
    const p = await asService((q) =>
      q.query<any>("select predicted, target_date::text from predictions where recommendation_id=$1", [rec.id]),
    );
    expect(p).toHaveLength(1);
  });

  it("re-running is idempotent (no duplicate recommendations or actions)", async () => {
    const before = await asService((q) =>
      q.query<any>(
        "select (select count(*)::int from recommendations where business_id=$1) r, (select count(*)::int from actions where business_id=$1) a",
        [biz],
      ),
    );
    await wf.evaluateCashRisk(biz, "test-again");
    const after = await asService((q) =>
      q.query<any>(
        "select (select count(*)::int from recommendations where business_id=$1) r, (select count(*)::int from actions where business_id=$1) a",
        [biz],
      ),
    );
    expect(after[0]).toEqual(before[0]);
  });

  it("approval must match the exact parameters; a correct approval executes and is verified", async () => {
    const act = (
      await asService((q) =>
        q.query<any>("select id, params_hash, params from actions where business_id=$1 and tool='reschedule_payable'", [
          biz,
        ]),
      )
    )[0];
    const wrong = await actions.approveAction({
      businessId: biz,
      actionId: act.id,
      userId: user,
      hash: paramsHash("reschedule_payable", { ...act.params, newDueDate: "2099-01-01" }),
      role: "owner",
    });
    expect(wrong.ok).toBe(false);
    const member = await actions.approveAction({
      businessId: biz,
      actionId: act.id,
      userId: user,
      hash: act.params_hash,
      role: "member",
    });
    expect(member.ok).toBe(false);
    const good = await actions.approveAction({
      businessId: biz,
      actionId: act.id,
      userId: user,
      hash: act.params_hash,
      role: "owner",
    });
    expect(good.ok).toBe(true);
    wf; // workflow module loaded
    const { registerHandlers } = await import("@/lib/server/worker");
    registerHandlers();
    await jobs.runDue({ kinds: ["action.execute"] });
    const done = (
      await asService((q) => q.query<any>("select status, verification, result from actions where id=$1", [act.id]))
    )[0];
    expect(done.status).toBe("succeeded");
    expect(done.verification.ok).toBe(true);
    const inv = (await asService((q) => q.query<any>("select due_date::text from invoices where id=$1", [payable])))[0];
    expect(inv.due_date).toBe(act.params.newDueDate);
    // Executing twice does nothing.
    expect((await actions.executeAction(act.id)).status).toBe("succeeded");
    // Approving again is refused.
    expect(
      (
        await actions.approveAction({
          businessId: biz,
          actionId: act.id,
          userId: user,
          hash: act.params_hash,
          role: "owner",
        })
      ).ok,
    ).toBe(false);
    // Audit trail exists.
    const audit = await asService((q) =>
      q.query<any>("select action from audit_log where target=$1 order by created_at", [act.id]),
    );
    expect(audit.map((a: any) => a.action)).toEqual(
      expect.arrayContaining(["action.proposed", "action.approved", "action.succeeded"]),
    );
  });

  it("after the bill moved, the next check clears the risk", async () => {
    const r: any = await wf.evaluateCashRisk(biz, "after-approval");
    expect(r.atRisk).toBe(false);
    const open = await asService((q) =>
      q.query("select 1 from recommendations where business_id=$1 and status='open'", [biz]),
    );
    expect(open).toHaveLength(0);
  });

  it("measures predictions against recorded reality once their date passes", async () => {
    await asService((q) =>
      q.query(
        "insert into predictions(business_id,metric,made_on,target_date,predicted) values ($1,'cash_balance',$2,$3,123)",
        [biz, addDays(today, -5), addDays(today, -1)],
      ),
    );
    const r = await wf.measureOutcomes(biz);
    expect(r.measured).toBeGreaterThanOrEqual(1);
    const p = (
      await asService((q) =>
        q.query<any>("select actual from predictions where business_id=$1 and target_date=$2", [
          biz,
          addDays(today, -1),
        ]),
      )
    )[0];
    expect(Number(p.actual)).toBe(1_000_000 + 50_000);
  });

  it("the daily briefing is built from real records", async () => {
    const b = await wf.buildBriefing(biz);
    expect(b.cash).toBe(1_050_000);
    expect(b.upcoming.length).toBeGreaterThanOrEqual(0);
    void receivable;
  });
});

describe("true profit", () => {
  const cats: any[] = [
    { id: "sales", name: "Sales", kind: "income", cost_type: null, parent_id: null },
    { id: "ads", name: "Ads", kind: "expense", cost_type: "opex", parent_id: null, role: "ads" },
    { id: "rent", name: "Rent", kind: "expense", cost_type: "opex", parent_id: null },
  ];
  const t = (p: any) => ({
    id: Math.random().toString(),
    currency: "EGP",
    account_id: "a",
    to_account_id: null,
    direction: null,
    category_id: null,
    ...p,
  });
  const range = { from: "2026-10-01", to: "2026-10-31" };
  const orders = [
    {
      id: "o1",
      local_date: "2026-10-03",
      currency: "EGP",
      cancelled_at: null,
      is_test: false,
      total: 20000,
      tax: 0,
      shipping: 0,
      discounts: 0,
      refunded: 0,
    },
  ];
  const lines = [
    {
      order_id: "o1",
      variant_external_id: "v1",
      title: "Shirt",
      sku: "S",
      quantity: 2,
      current_quantity: 2,
      discounted_total: 20000,
      unit_cost: null,
    },
  ];

  it("never treats unknown costs as zero", () => {
    const r = profitReport({
      range,
      currency: "EGP",
      txns: [t({ type: "income", amount: 20000, date: "2026-10-03", category_id: "sales" })],
      cats,
      orders,
      lines,
      products: [],
      ads: [],
      assumptions: {},
    });
    expect(r.netProfit).toBeNull();
    expect(r.ladder.find((l) => l.key === "cogs")!.amount).toBeNull();
    expect(r.missing.join(" ")).toMatch(/unit cost/i);
    expect(r.products[0].contribution).toBeNull();
  });

  it("estimates cost of goods from product costs and does not double-count advertising", () => {
    const txns = [
      t({ type: "income", amount: 20000, date: "2026-10-03", category_id: "sales" }),
      t({ type: "expense", amount: 3000, date: "2026-10-04", category_id: "ads" }),
      t({ type: "expense", amount: 5000, date: "2026-10-05", category_id: "rent" }),
    ];
    const ads = [
      {
        provider: "meta_ads",
        date: "2026-10-04",
        campaign_id: "c",
        campaign_name: "c",
        spend: 3000,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        attributed_revenue: 0,
        currency: "EGP",
      },
    ];
    const r = profitReport({
      range,
      currency: "EGP",
      txns,
      cats,
      orders,
      lines,
      products: [{ external_id: "v1", name: "Shirt", unit_cost: 4000 }],
      ads,
      assumptions: { paymentFeeBps: 300 },
    });
    const get = (k: string) => r.ladder.find((l) => l.key === k)!.amount;
    expect(get("cogs")).toBe(8000);
    expect(get("gross")).toBe(12000);
    expect(get("fees")).toBe(600); // 3% assumption, because no fee expenses are recorded
    expect(get("ads")).toBe(3000); // ledger ads used; platform spend NOT added again
    expect(get("contribution")).toBe(12000 - 600 - 3000);
    expect(get("opex")).toBe(5000); // ads not subtracted twice
    expect(r.netProfit).toBe(12000 - 600 - 3000 - 5000);
    expect(r.products[0]).toMatchObject({ units: 2, revenue: 20000, cogs: 8000 });
  });

  it("refunded units do not count as kept revenue", () => {
    const l2 = [{ ...lines[0], current_quantity: 1 }];
    const r = profitReport({
      range,
      currency: "EGP",
      txns: [],
      cats,
      orders,
      lines: l2,
      products: [{ external_id: "v1", name: "Shirt", unit_cost: 4000 }],
      ads: [],
      assumptions: {},
    });
    expect(r.products[0]).toMatchObject({ units: 1, revenue: 10000, cogs: 4000 });
  });
});
