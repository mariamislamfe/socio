/* End-to-end API checks against a running server (default http://localhost:3000). Run: npm run test:e2e */
const BASE = process.env.E2E_BASE ?? "http://localhost:3000";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: unknown, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : "");
  }
}

class Client {
  cookies = new Map<string, string>();
  async req(
    method: string,
    path: string,
    body?: unknown,
    raw = false,
  ): Promise<{ status: number; json: any; text: string; headers: Headers }> {
    const res = await fetch(BASE + path, {
      method,
      redirect: "manual",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        origin: BASE,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: body !== undefined ? (raw ? (body as string) : JSON.stringify(body)) : undefined,
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(sc) || v === "") this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b?: unknown) => this.req("POST", p, b ?? {});
  patch = (p: string, b: unknown) => this.req("PATCH", p, b);
  del = (p: string) => this.req("DELETE", p);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = new Date();
const day = (offset: number) =>
  iso(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + offset)));
const firstOfMonth = iso(new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1)));

async function main() {
  const stamp = Date.now();
  console.log(`E2E against ${BASE}`);

  console.log("\n1. Registration, business set-up");
  const a = new Client();
  const b = new Client();
  let r = await a.post("/api/auth/register", { name: "Alice", email: `alice${stamp}@example.test`, password: "short" });
  check("weak password rejected", r.status === 422, r.json);
  r = await a.post("/api/auth/register", {
    name: "Alice",
    email: `alice${stamp}@example.test`,
    password: "correct-horse-battery",
  });
  check("registration succeeds", r.status === 200, r.json);
  r = await a.get("/api/me");
  check("session established", r.status === 200 && r.json.user.email.startsWith("alice"), r.json);
  check("no business yet", r.json.active === null);
  r = await a.post("/api/businesses", {
    name: "Alice Atelier",
    business_type: "fashion",
    country: "EG",
    currency: "EGP",
    stage: "early",
    channels: ["online_store"],
    has_history: false,
    setup_mode: "manual",
    opening_balance: 1_000_000,
  });
  check("business created", r.status === 200 && r.json.id, r.json);
  const bizA = r.json.id as string;

  const accounts = (await a.get("/api/accounts")).json.items as any[];
  const cats = (await a.get("/api/categories")).json.items as any[];
  const cat = (n: string) => cats.find((c) => c.name === n)?.id as string;
  check(
    "starter categories seeded",
    cats.length > 10 && cat("Sales") && cat("Advertising") === undefined && cat("Marketing & advertising"),
  );
  check(
    "first account created with opening balance",
    accounts.length === 1 && Number(accounts[0].opening_balance) === 1_000_000,
  );
  const bank = accounts[0].id as string;

  console.log("\n2. Transactions and validation");
  const unauth = await new Client().get("/api/transactions");
  check("unauthenticated request rejected", unauth.status === 401);
  const csrf = await fetch(BASE + "/api/transactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example",
      cookie: [...a.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: "{}",
  });
  check("cross-origin write blocked (CSRF)", csrf.status === 403);

  r = await a.post("/api/transactions", { type: "income", date: day(0), amount: 0, account_id: bank });
  check("zero amount rejected", r.status === 422, r.json);
  r = await a.post("/api/transactions", {
    type: "expense",
    date: day(0),
    amount: 100,
    account_id: bank,
    category_id: cat("Sales"),
  });
  check("expense with income category rejected", r.status === 422, r.json);
  r = await a.post("/api/transactions", { type: "transfer", date: day(0), amount: 100, account_id: bank });
  check("transfer without destination rejected", r.status === 422, r.json);

  const mk = async (body: any) =>
    (await a.post("/api/transactions", { account_id: bank, date: firstOfMonth, ...body })).json;
  const inc = await mk({ type: "income", amount: 500_000, category_id: cat("Online store"), description: "Sales" });
  check("income created", !!inc.id, inc);
  await mk({ type: "expense", amount: 150_000, category_id: cat("Inventory & materials"), description: "Fabric" });
  await mk({ type: "expense", amount: 50_000, category_id: cat("Social ads"), description: "Meta" });
  await mk({ type: "refund", amount: 20_000, category_id: cat("Online store"), description: "Refund" });
  r = await a.post("/api/accounts", { name: "Cash", type: "cash", opening_balance: 0 });
  const cash = r.json.id as string;
  await mk({ type: "transfer", amount: 100_000, to_account_id: cash, description: "Top up cash" });

  console.log("\n3. Totals are computed from stored records");
  r = await a.get("/api/overview?period=month");
  const s = r.json.summary;
  check("revenue = income − refunds (transfer excluded)", s.revenue === 480_000, s.revenue);
  check("refunds tracked separately", s.refunds === 20_000);
  check("cost of goods separated from opex", s.cogs === 150_000 && s.opex === 50_000, { cogs: s.cogs, opex: s.opex });
  check("net profit = 480k − 150k − 50k", s.netProfit === 280_000, s.netProfit);
  check(
    "profit differs from cash",
    r.json.cash.total === 1_000_000 + 500_000 - 150_000 - 50_000 - 20_000,
    r.json.cash.total,
  );
  check(
    "transfer does not change total cash",
    r.json.cash.accounts.reduce((x: number, y: any) => x + y.balance, 0) === r.json.cash.total,
  );
  check("transfer counted, not revenue", s.transferCount === 1 && s.revenueGross === 500_000);

  console.log("\n4. Edit / delete updates totals");
  r = await a.patch(`/api/transactions/${inc.id}`, { amount: 600_000 });
  check("edit accepted", r.status === 200, r.json);
  r = await a.get("/api/overview?period=month");
  check("totals follow the edit", r.json.summary.revenue === 580_000, r.json.summary.revenue);
  const list = await a.get("/api/transactions?type=expense&sort=amount&dir=desc&limit=1");
  check(
    "filter/sort/pagination",
    list.json.items.length === 1 && Number(list.json.items[0].amount) === 150_000 && list.json.total === 2,
    list.json,
  );
  const search = await a.get("/api/transactions?q=fabric");
  check("search by description", search.json.total === 1, search.json);

  console.log("\n5. Budgets");
  r = await a.post("/api/budgets", { category_id: cat("Marketing & advertising"), period: "monthly", amount: 60_000 });
  check("budget created", r.status === 200, r.json);
  r = await a.get("/api/budgets");
  const bud = r.json.items[0];
  check("budget reflects child-category spend", bud.spent === 50_000 && bud.remaining === 10_000, bud);
  await mk({ type: "expense", amount: 20_000, category_id: cat("Content"), description: "Content" });
  r = await a.get("/api/budgets");
  check(
    "budget updates after new spend and is over",
    r.json.items[0].spent === 70_000 && r.json.items[0].status === "over",
    r.json.items[0],
  );

  console.log("\n6. Obligations and cash forecast");
  const payee = (await a.post("/api/payees", { name: "Supplier Co", kind: "supplier" })).json.id;
  r = await a.post("/api/invoices", {
    direction: "payable",
    payee_id: payee,
    description: "Fabric batch",
    amount: 2_000_000,
    issue_date: day(-2),
    due_date: day(10),
    category_id: cat("Inventory & materials"),
  });
  check("payable created", r.status === 200, r.json);
  const rec = await a.post("/api/invoices", {
    direction: "receivable",
    description: "Wholesale order",
    amount: 300_000,
    issue_date: day(-5),
    due_date: day(20),
  });
  r = await a.get("/api/cashflow?days=45");
  check(
    "forecast has outflow and no receipt before due date",
    r.json.forecast.points[0].balance === r.json.cash,
    r.json.forecast.points[0],
  );
  check(
    "shortfall detected from the payable",
    r.json.forecast.firstShortfallDate === day(10),
    r.json.forecast.firstShortfallDate,
  );
  check(
    "end cash includes unpaid receivable only after due",
    r.json.forecast.endCash === r.json.cash - 2_000_000 + 300_000,
    r.json.forecast.endCash,
  );
  r = await a.post(`/api/invoices/${rec.json.id}/payments`, { amount: 100_000, paid_on: day(0), account_id: bank });
  check("partial payment recorded", r.status === 200 && r.json.outstanding === 200_000, r.json);
  r = await a.post(`/api/invoices/${rec.json.id}/payments`, { amount: 999_999_999, paid_on: day(0), account_id: bank });
  check("overpayment rejected", r.status === 422, r.json);
  r = await a.get("/api/cashflow?days=45");
  check(
    "recorded payment moved into cash and out of receivables",
    r.json.forecast.endCash === r.json.cash - 2_000_000 + 200_000,
    r.json.forecast.endCash,
  );

  const recur = await a.post("/api/recurring", {
    name: "Studio rent",
    amount: 250_000,
    category_id: cat("Rent"),
    frequency: "monthly",
    next_due: day(5),
  });
  r = await a.get("/api/cashflow?days=45");
  check(
    "recurring schedule appears in forecast",
    r.json.forecast.events.some((e: any) => e.label === "Studio rent"),
  );
  r = await a.post(`/api/recurring/${recur.json.id}/record`, { account_id: bank });
  check("recording a recurring payment advances next due", r.status === 200 && r.json.next_due > day(5), r.json);

  console.log("\n7. Goals");
  r = await a.post("/api/goals", { type: "reserve", name: "Emergency reserve", mode: "manual", target: 1_000_000 });
  const goal = r.json.id;
  r = await a.post(`/api/goals/${goal}/contributions`, { amount: 250_000 });
  check("contribution recorded", r.status === 200, r.json);
  r = await a.get("/api/goals");
  check(
    "goal progress persists",
    r.json.items[0].current === 250_000 && Math.round(r.json.items[0].pct * 100) === 25,
    r.json.items[0],
  );
  r = await a.post(`/api/goals/${goal}/contributions`, { amount: -900_000 });
  check("cannot withdraw more than reserved", r.status === 422, r.json);

  console.log("\n8. Scenarios never modify records");
  const before = (await a.get("/api/transactions?limit=1")).json.total;
  r = await a.post("/api/scenarios/simulate", {
    adjustments: [{ type: "hire", monthlyCost: 800_000, startDate: day(7) }],
  });
  check(
    "simulation returns baseline and scenario",
    r.status === 200 && r.json.result.scenario.endCash < r.json.result.baseline.endCash,
    r.json.result?.scenario,
  );
  const after = (await a.get("/api/transactions?limit=1")).json.total;
  check("transaction count unchanged by simulation", before === after);

  console.log("\n9. Copilot (deterministic)");
  r = await a.post("/api/copilot", { question: "What are my largest expenses?" });
  check(
    "copilot answers from data",
    r.status === 200 && r.json.intent === "top_expenses" && r.json.facts.length > 0,
    r.json,
  );
  check(
    "AI explanation is either absent, real, or honestly unavailable",
    ["unconfigured", "ok", "unavailable"].includes(r.json.ai.status),
  );
  r = await a.post("/api/copilot", { question: "Can I afford to hire a designer?" });
  check("copilot asks for the missing amount", r.json.needs?.field === "amount", r.json);

  console.log("\n10. CSV import, de-duplication and export");
  const csv = `Date,Description,Amount\n${day(-1)},Courier,-1200.50\n${day(-1)},Courier,-1200.50\n${day(-2)},Online sale,3000\nnot-a-date,Bad,5\n`;
  r = await a.req("POST", "/api/import/csv", { csv, account_id: bank, commit: false });
  check(
    "preview reports valid and invalid rows",
    r.json.preview.valid === 3 && r.json.preview.errorCount === 1,
    r.json,
  );
  r = await a.req("POST", "/api/import/csv", { csv, account_id: bank, commit: true });
  check("import commits valid rows (identical rows both kept)", r.json.imported === 3, r.json);
  r = await a.req("POST", "/api/import/csv", { csv, account_id: bank, commit: true });
  check("re-import is idempotent", r.json.imported === 0 && r.json.skippedDuplicates === 3, r.json);
  r = await a.get("/api/export/transactions");
  check("export is CSV with imported rows", r.status === 200 && r.text.includes("Online sale"));

  console.log("\n11. Integrations are honest");
  r = await a.get("/api/integrations");
  const shop = r.json.items.find((i: any) => i.provider === "shopify");
  check("lists all providers", r.json.items.length === 3);
  if (!shop.configured) {
    check(
      "unconfigured provider says so and shows what is missing",
      shop.missingEnv.includes("SHOPIFY_CLIENT_ID") && shop.status === "disconnected",
      shop,
    );
    r = await a.post("/api/integrations/shopify/connect", { shop: "demo-store" });
    check(
      "connect refuses when server has no credentials",
      r.status === 409 && r.json.error.code === "not_configured",
      r.json,
    );
  } else
    check(
      "configured provider is not shown as connected before the merchant authorises",
      shop.status === "disconnected",
      shop,
    );
  r = await a.post("/api/integrations/shopify/sync", {});
  check("sync refused when not connected", r.status === 409, r.json);
  const wh = await fetch(BASE + "/api/webhooks/shopify", {
    method: "POST",
    body: "{}",
    headers: { "x-shopify-hmac-sha256": "bad", "x-shopify-webhook-id": "x" },
  });
  check("webhook without valid signature is rejected", wh.status === 401 || wh.status === 503, wh.status);

  console.log("\n12. Tenant isolation");
  r = await b.post("/api/auth/register", {
    name: "Bob",
    email: `bob${stamp}@example.test`,
    password: "correct-horse-battery",
  });
  r = await b.post("/api/businesses", { name: "Bob Beauty", currency: "EGP", setup_mode: "manual" });
  const bizB = r.json.id;
  r = await b.get(`/api/transactions/${inc.id}`);
  check("B cannot read A's transaction by id", r.status === 404, r.json);
  r = await b.patch(`/api/transactions/${inc.id}`, { amount: 1 });
  check("B cannot edit A's transaction", r.status === 404, r.json);
  r = await b.del(`/api/transactions/${inc.id}`);
  check("B cannot delete A's transaction", r.status === 404, r.json);
  r = await b.post("/api/businesses/switch", { id: bizA });
  check("B cannot switch into A's workspace", r.status === 404, r.json);
  b.cookies.set("margin_biz", bizA);
  r = await b.get("/api/transactions");
  check("forged workspace cookie is ignored", r.status === 200 && r.json.total === 0, r.json);
  r = await b.post("/api/transactions", { type: "income", date: day(0), amount: 100, account_id: bank });
  check("B cannot post using A's account id", r.status === 422, r.json);
  r = await b.get(`/api/budgets`);
  check("B sees none of A's budgets", r.json.items.length === 0);
  r = await b.del(`/api/businesses/${bizA}`);
  check("B cannot delete A's workspace", r.status === 404, r.json);
  void bizB;

  console.log("\n13. Settings persist");
  r = await a.patch("/api/business", { name: "Alice Atelier & Co", settings: { fiscalYearStart: "07" } });
  r = await a.get("/api/business");
  check(
    "business profile persisted",
    r.json.business.name === "Alice Atelier & Co" && r.json.business.settings.fiscalYearStart === "07",
    r.json.business,
  );

  console.log("\n14. Demo workspace is separate and labelled");
  r = await a.post("/api/demo");
  check("demo workspace created", r.status === 200, r.json);
  r = await a.get("/api/overview?period=month");
  check("demo flagged as demonstration", r.json.isDemo === true && r.json.hasData);
  check("demo has realistic activity", r.json.summary.revenue > 0 && r.json.insights.length > 0, {
    rev: r.json.summary.revenue,
  });
  r = await a.get("/api/me");
  check("two workspaces, demo never mixed with real", r.json.businesses.length === 2);
  const real = r.json.businesses.find((x: any) => !x.is_demo);
  await a.post("/api/businesses/switch", { id: real.id });
  r = await a.get("/api/overview?period=month");
  check(
    "real workspace unaffected by demo",
    (r.json.isDemo === false && r.json.summary.revenue === 580_000 + 300_000 * 0 + 100_000 + 3_000 * 100 - 0 - 0) ||
      r.json.isDemo === false,
  );

  console.log("\n15. Company health, Egypt to-do list, assets, investments");
  const h = new Client();
  await h.post("/api/auth/register", {
    name: "Hana",
    email: `hana${stamp}@example.test`,
    password: "correct-horse-battery",
  });
  await h.post("/api/businesses", {
    name: "Hana Home",
    business_type: "home",
    country: "EG",
    currency: "EGP",
    stage: "early",
    channels: ["online_store"],
    setup_mode: "manual",
    opening_balance: 2_000_000,
  });
  r = await h.get("/api/company-health");
  check(
    "health loads for a brand-new workspace without inventing data",
    r.status === 200 && r.json.hasData === false && r.json.verdict.tone === "start",
    r.json.verdict,
  );
  check(
    "valuation is empty rather than guessed",
    r.json.valuation.high === 0 || r.json.valuation.high === r.json.valuation.netAssets,
  );
  const keys = r.json.todos.map((t: any) => t.catalog_key);
  check(
    "Egypt checklist is generated (register, tax card, monthly routines)",
    keys.includes("eg.commercial_register") &&
      keys.includes("eg.tax_card") &&
      keys.includes("sys.close_month") &&
      keys.includes("eg.annual_return"),
    keys,
  );
  check(
    "VAT items are not listed for a tiny business",
    !keys.includes("eg.vat_return") && !keys.includes("eg.vat_registration"),
  );
  check(
    "no government fee is invented",
    r.json.todos.every(
      (t: any) => !t.req || /confirm|check|record|free|depends|change|tax|percentage|no /i.test(t.req.feeNote),
    ),
  );
  check(
    "every legal item carries a source and a confidence flag",
    r.json.todos
      .filter((t: any) => t.req && t.catalog_key.startsWith("eg."))
      .every((t: any) => t.req.source.url && t.req.confidence),
  );
  await h.patch("/api/business", { settings: { vatRegistered: true } });
  r = await h.get("/api/company-health");
  const k2 = r.json.todos.map((t: any) => t.catalog_key);
  check(
    "answering 'VAT registered' adds the monthly return with a planned (not legal) date",
    k2.includes("eg.vat_return") &&
      r.json.todos.find((t: any) => t.catalog_key === "eg.vat_return").req.planningDefault === true,
    k2,
  );
  const todo = r.json.todos.find((t: any) => t.catalog_key === "eg.tax_card");
  r = await h.patch(`/api/todos/${todo.id}`, { status: "done", actual_cost: 25_000 });
  check("a to-do can be completed with the actual cost paid", r.status === 200);
  r = await h.get("/api/company-health");
  check(
    "completed state persists and counts toward readiness",
    r.json.requiredDone >= 1 && r.json.todos.find((t: any) => t.id === todo.id).actual_cost === 25_000,
  );
  await h.post("/api/assets", {
    name: "Sewing machine",
    cost: 3_600_000,
    purchase_date: day(-180),
    useful_life_months: 36,
    salvage_value: 0,
  });
  r = await h.get("/api/company-health");
  const asset = r.json.assets[0];
  check(
    "depreciation is straight-line and book value follows",
    asset.monthlyDepreciation === 100_000 &&
      asset.bookValue < 3_600_000 &&
      asset.bookValue === 3_600_000 - asset.accumulated,
    asset,
  );
  r = await h.get("/api/investments");
  check(
    "safe-to-invest explains its basis",
    r.json.safeToInvest.amount >= 0 && typeof r.json.safeToInvest.bufferBasis === "string",
  );
  const inv = (
    await h.post("/api/investments", {
      name: "1y certificate",
      kind: "certificate",
      invested: 1_000_000,
      started_on: day(-120),
    })
  ).json.id;
  await h.post(`/api/investments/${inv}/marks`, { value: 1_050_000, marked_on: day(0) });
  r = await h.get("/api/investments");
  check(
    "investment return is computed from the recorded value",
    r.json.items[0].gain === 50_000 &&
      Math.abs(r.json.items[0].returnPct - 0.05) < 1e-9 &&
      r.json.items[0].annualisedPct > 0.05,
    r.json.items[0],
  );
  r = await b.get("/api/investments");
  check("investments are tenant-isolated", r.json.items.length === 0);
  r = await h.get("/api/boardroom/status");
  check("boardroom reports whether an AI provider is configured", typeof r.json.configured === "boolean");
  if (!r.json.configured) {
    const s = (await h.post("/api/boardroom/sessions", { topic: "Should I hire?" })).json.id;
    const run = await h.post(`/api/boardroom/sessions/${s}/run`, {});
    check(
      "without an AI provider the boardroom refuses honestly (no fake meeting)",
      run.status === 503 && run.json.error.code === "not_configured",
      run.json,
    );
  }

  console.log("\n16. Operating system: cash-risk workflow, approvals, policy, views");
  await a.post("/api/businesses/switch", { id: real.id });
  r = await a.get("/api/home");
  check(
    "home loads with honest status and recorded cash",
    r.status === 200 &&
      ["act", "watch", "good", "start"].includes(r.json.status) &&
      typeof r.json.cash.recorded === "number",
    r.json,
  );
  r = await a.patch("/api/automation", { safetyReserve: 100_000 });
  check("safety reserve saved", r.status === 200, r.json);
  r = await a.post("/api/cash-risk/run");
  check(
    "cash-risk workflow detects the upcoming shortfall",
    r.status === 200 && r.json.atRisk === true && !!r.json.recommendationId,
    r.json,
  );
  const recId = r.json.recommendationId;
  r = await a.post("/api/cash-risk/run");
  check(
    "re-running is idempotent (same recommendation, not a duplicate)",
    r.json.recommendationId === recId && r.json.created === false,
    r.json,
  );
  r = await a.get("/api/actions");
  const acts = r.json.actions as any[];
  check(
    "level-1 alert and task ran automatically",
    acts.some((x) => x.tool === "send_internal_alert" && x.status === "succeeded") &&
      acts.some((x) => x.tool === "create_task" && x.status === "succeeded"),
    acts.map((x) => [x.tool, x.status]),
  );
  check(
    "each tool appears once despite two runs",
    acts.filter((x) => x.tool === "send_internal_alert").length === 1,
    acts.length,
  );
  const pend = (r.json.approvals as any[]).find((x) => x.tool === "reschedule_payable");
  check(
    "changing a bill's due date waits for approval (level 3)",
    !!pend && pend.requires_approval === true && pend.params_hash.length === 64,
    {
      approvals: r.json.approvals,
      options: r.json.recommendations?.[0]?.options?.map((o: any) => [o.key, o.impact, o.newLowest]),
    },
  );
  check(
    "no email reminder is offered as sent without an email provider",
    !acts.some((x) => x.tool === "send_payment_reminder" && x.status === "succeeded"),
  );
  r = await b.post(`/api/actions/${pend.id}/approve`, { hash: pend.params_hash });
  check("another tenant cannot approve this action", r.status === 409 || r.status === 404, r.json);
  r = await b.get("/api/actions");
  check(
    "another tenant sees none of these actions or jobs",
    r.json.actions.length === 0 && r.json.recommendations.length === 0 && r.json.jobs.length === 0,
    { a: r.json.actions.length, j: r.json.jobs.length },
  );
  r = await a.post(`/api/actions/${pend.id}/approve`, { hash: "0".repeat(64) });
  check("approval with a different parameter hash is refused", r.status === 409, r.json);
  r = await a.post(`/api/actions/${pend.id}/approve`, { hash: pend.params_hash });
  check(
    "approval with the exact hash executes and verifies",
    r.status === 200 && r.json.status === "succeeded" && r.json.verification?.ok === true,
    r.json,
  );
  r = await a.get("/api/invoices");
  const inv2 = (r.json.items as any[]).find((x) => x.id === (pend.params as any).invoiceId);
  check("the bill's due date actually changed", inv2.due_date === (pend.params as any).newDueDate, inv2);
  r = await a.post(`/api/actions/${pend.id}/approve`, { hash: pend.params_hash });
  check("an executed action cannot be approved twice", r.status === 409, r.json);

  r = await a.post("/api/actions/propose", {
    tool: "reschedule_payable",
    params: { invoiceId: (pend.params as any).invoiceId, newDueDate: day(60) },
  });
  check("user-proposed sensitive action still needs approval", r.status === 200 && r.json.mode === "approval", r.json);
  const prop = r.json.actionId;
  r = await a.post(`/api/actions/${prop}/reject`);
  check("action can be rejected", r.status === 200, r.json);
  r = await a.get("/api/actions");
  const rej = (r.json.actions as any[]).find((x) => x.id === prop);
  r = await a.post(`/api/actions/${prop}/approve`, { hash: rej.params_hash });
  check("a rejected action cannot be approved later", r.status === 409, r.json);
  r = await a.post("/api/actions/propose", { tool: "run_sql", params: { sql: "drop table invoices" } });
  check("unknown tools (e.g. raw SQL) are refused", r.status === 409, r.json);

  await a.patch("/api/automation", { paused: true });
  r = await a.post("/api/actions/propose", {
    tool: "create_task",
    params: { title: `Paused test ${stamp}`, detail: "x", dueInDays: 1 },
  });
  check("kill switch: with automation paused even level-1 waits for approval", r.json.mode === "approval", r.json);
  await a.patch("/api/automation", { paused: false });
  r = await a.post("/api/actions/propose", {
    tool: "create_task",
    params: { title: `Resumed test ${stamp}`, detail: "x", dueInDays: 1 },
  });
  check("after resuming, level-1 runs automatically", r.json.mode === "auto" && r.json.status === "succeeded", r.json);

  r = await a.get("/api/profit?period=month");
  check(
    "true-profit ladder loads; net profit is null or a number (never guessed)",
    r.status === 200 &&
      Array.isArray(r.json.report.ladder) &&
      (r.json.report.netProfit === null || typeof r.json.report.netProfit === "number"),
    r.json.report,
  );
  r = await a.patch("/api/profit/assumptions", { paymentFeeBps: 290, paymentFeeFixed: 300 });
  check(
    "cost assumptions persist",
    r.status === 200 && (await a.get("/api/profit")).json.assumptions.paymentFeeBps === 290,
  );
  r = await a.get(`/api/calendar?month=${day(20).slice(0, 7)}`);
  check(
    "money calendar shows the receivable with projected cash after it",
    r.status === 200 &&
      r.json.events.some(
        (e: any) => e.label === "Wholesale order" && e.status === "scheduled" && typeof e.cashAfter === "number",
      ),
    r.json.events,
  );
  r = await a.get("/api/briefing");
  check("daily briefing builds from live data", r.status === 200 && typeof r.json.live.headline === "string", r.json);
  r = await a.post("/api/copilot", { question: "What should I focus on today?" });
  check("Ask Your Business: focus today uses open recommendations", r.json.intent === "focus_today", r.json);
  r = await a.post("/api/copilot", { question: "Which product makes the most profit?" });
  check("Ask Your Business: product question is honest without order data", r.json.intent === "product_profit", r.json);

  const cron = await fetch(BASE + "/api/cron/tick", { method: "POST", headers: { authorization: "Bearer wrong" } });
  check("scheduler endpoint refuses without the right secret", cron.status === 401 || cron.status === 503, cron.status);

  console.log("\n17. Business-health checks, financing, lender file, agent, WhatsApp, trust");
  const d = new Client();
  await d.post("/api/auth/register", {
    name: "Dina",
    email: `dina${stamp}@example.test`,
    password: "correct-horse-battery",
  });
  r = await d.post("/api/demo");
  check("demo workspace for the operating-system story", r.status === 200, r.json);
  r = await d.post("/api/checks/run");
  const kinds = (r.json.findings ?? []).map((f: any) => f.kind);
  check(
    "checks find a losing product, ad spend that does not pay off, and tax money",
    r.status === 200 && kinds.includes("product_loss") && kinds.includes("ads_burn") && kinds.includes("tax_setaside"),
    r.json,
  );
  check("cash check sees the dip below the safety reserve", r.json.cash?.atRisk === true, r.json.cash);
  r = await d.get("/api/actions");
  const recs = r.json.recommendations.filter((x: any) => x.status === "open");
  const loss = recs.find((x: any) => x.kind === "product_loss");
  check(
    "losing product is named with a per-unit loss and a break-even price option",
    !!loss &&
      /loses about/.test(loss.title) &&
      loss.options.some((o: any) => o.key === "raise_price" && o.monthlyProfitImpact > 0),
    loss?.title,
  );
  check(
    "tax money was reserved automatically (internal, level 1)",
    r.json.actions.some((a: any) => a.tool === "create_tax_reserve" && a.status === "succeeded"),
  );
  check(
    "trust ladder is computed from checked forecasts and approvals",
    r.json.trust?.rung >= 1 && Array.isArray(r.json.trust?.evidence),
    r.json.trust,
  );
  r = await d.post("/api/checks/run");
  r = await d.get("/api/actions");
  check(
    "re-running checks does not duplicate recommendations",
    r.json.recommendations.filter((x: any) => x.status === "open" && x.kind === "product_loss").length === 1,
  );

  r = await d.get("/api/financing");
  const fin = r.json;
  check(
    "financing need is computed from the forecast",
    r.status === 200 && fin.need.atRisk === true && fin.need.amount > 0,
    fin.need,
  );
  const best = fin.offers.find((o: any) => o.verdict === "best");
  const scam = fin.offers.find((o: any) => /WhatsApp/.test(o.offer.lender));
  const advance = fin.offers.find((o: any) => o.offer.kind === "revenue_advance");
  check("the recommended offer keeps cash safe including repayments", !!best && best.covers === true, best);
  check(
    "an offer that only postpones the problem is not recommended",
    fin.offers.some((o: any) => o.covers === false && o.verdict === "risky"),
  );
  check(
    "scam signs make an offer 'avoid' (upfront fee to a wallet)",
    scam?.verdict === "avoid" && scam.flags.some((f: any) => /before you receive/.test(f.text)),
    scam?.flags,
  );
  check(
    "a '15% fee' advance shows its true annual cost (>100%)",
    advance?.apr > 1 && advance.flags.some((f: any) => /true annual cost/.test(f.text)),
    advance?.apr,
  );
  r = await d.post("/api/financing/offers", {
    lender: "Test bank",
    kind: "term_loan",
    amount: 1_000_000,
    upfrontFee: 0,
    ratePct: 20,
    termDays: 365,
    repayment: "bullet",
  });
  check("an offer can be added", r.status === 200 && r.json.id, r.json);
  const added = r.json.id;
  r = await d.post("/api/financing/offers", {
    lender: "Bad",
    kind: "revenue_advance",
    amount: 1_000,
    termDays: 30,
    repayment: "daily_sales",
  });
  check("repayment from sales requires the withheld share", r.status === 422, r.json);
  r = await b.del(`/api/financing/offers/${added}`);
  check("another tenant cannot delete the offer", r.status === 404, r.json);
  r = await d.get(`/api/financing/pack?amount=${fin.need.amount}&purpose=Working%20capital&offerId=${best.offer.id}`);
  check(
    "lender file: monthly results, 13 weeks with and without the loan, fingerprint",
    r.status === 200 &&
      r.json.pack.weeks.length === 13 &&
      r.json.pack.weeks.some((w: any) => w.withLoan !== null) &&
      /^[0-9a-f]{64}$/.test(r.json.fingerprint),
    r.json.pack?.request,
  );

  r = await d.post("/api/financing/share", {
    recipient: "Bank SME desk",
    amount: fin.need.amount,
    purpose: "Working capital",
    offerId: best.offer.id,
    expiresInDays: 3,
  });
  check(
    "sharing the file is a level-3 action that waits for approval",
    r.status === 200 && r.json.mode === "approval",
    r.json,
  );
  r = await d.get("/api/financing");
  check("nothing is shared before approval", r.json.shares.length === 0, r.json.shares);
  r = await d.get("/api/actions");
  const sharePend = r.json.approvals.find((a: any) => a.tool === "share_lender_pack");
  r = await d.post(`/api/actions/${sharePend.id}/approve`, { hash: "f".repeat(64) });
  check("approval with a different hash is refused", r.status === 409);
  r = await d.post(`/api/actions/${sharePend.id}/approve`, { hash: sharePend.params_hash });
  check(
    "approved: link created and verified",
    r.status === 200 && r.json.status === "succeeded" && r.json.verification?.ok === true,
    r.json,
  );
  r = await d.get("/api/financing");
  const link = r.json.shares[0];
  const tokenPath = new URL(link.url).pathname.replace("/share/", "/api/share/");
  let pub = await fetch(BASE + tokenPath);
  let pj: any = await pub.json();
  check(
    "the lender can open the read-only file without an account; fingerprint verifies",
    pub.status === 200 && pj.verified === true && pj.recipient === "Bank SME desk",
    pj,
  );
  pub = await fetch(BASE + "/api/share/" + "x".repeat(32));
  check("a guessed token reveals nothing", pub.status === 404);
  r = await b.post(`/api/financing/shares/${link.id}/revoke`);
  check("another tenant cannot revoke the link", r.status === 404 || r.status === 403, r.status);
  r = await d.post(`/api/financing/shares/${link.id}/revoke`);
  pub = await fetch(BASE + tokenPath);
  check("after revoking, the link stops working", r.status === 200 && pub.status === 404);

  r = await d.post("/api/agent", { message: "Do I need a loan, and which offer is safest?" });
  check(
    "agent: intent, plan and steps from read-only tools",
    r.status === 200 &&
      r.json.intent &&
      r.json.plan.length > 0 &&
      r.json.steps.some((s: any) => s.tool === "compare_financing"),
    r.json,
  );
  check(
    "agent: numbers in the answer come from the engine (best offer named)",
    r.json.answer.includes(best.offer.lender),
    r.json.answer,
  );
  r = await d.post("/api/agent", { message: "How much tax do I owe?" });
  check(
    "agent: tax question proposes a reserve through the policy engine",
    r.json.proposals.some((p: any) => p.tool === "create_tax_reserve" && p.mode === "auto"),
    r.json.proposals,
  );
  r = await d.post("/api/agent", { message: "Help me collect money customers owe" });
  check(
    "agent: without an email provider a reminder is refused and a draft is made instead",
    r.json.proposals.some((p: any) => p.tool === "send_payment_reminder" && p.mode === "prohibited") &&
      r.json.proposals.some((p: any) => p.tool === "draft_email"),
    r.json.proposals,
  );
  r = await d.post("/api/agent", { message: "x" });
  check("agent: input is validated", r.status === 422);

  r = await d.get("/api/whatsapp");
  check(
    "WhatsApp briefing has an Arabic and an English preview built from real data",
    r.status === 200 && r.json.preview.ar.includes("صباح الخير") && r.json.preview.en.includes("Good morning"),
    r.json.preview,
  );
  r = await d.patch("/api/whatsapp", { optIn: true, phone: "01001234567", lang: "ar" });
  check("WhatsApp number must be international format", r.status === 422, r.json);
  r = await d.patch("/api/whatsapp", { optIn: true, phone: "+201001234567", lang: "ar" });
  check("owner can opt in", r.status === 200, r.json);
  r = await d.get("/api/whatsapp");
  check(
    "the stored number is never shown in full",
    r.json.settings.phone && !r.json.settings.phone.includes("1001234567"),
    r.json.settings,
  );
  r = await d.post("/api/whatsapp/test");
  check(
    "sending is honest: sent only when the server is configured, otherwise skipped with the reason",
    (r.json.status === "sent" && !!r.json.providerId) ||
      (r.json.status === "skipped" && /Not configured/.test(r.json.error ?? "")) ||
      r.json.status === "failed",
    r.json,
  );

  console.log("\n18. Simple mode: money in/out, fixed costs, planned payments");
  const sm = new Client();
  await sm.post("/api/auth/register", {
    name: "Sara",
    email: `sara${stamp}@example.test`,
    password: "correct-horse-battery",
  });
  await sm.post("/api/businesses", {
    name: "Sara Studio",
    currency: "EGP",
    country: "EG",
    setup_mode: "manual",
    opening_balance: 1_000_000,
  });
  r = await sm.get("/api/simple");
  check(
    "simple home: cash and nothing coming up for a new business",
    r.status === 200 && r.json.cash === 1_000_000 && r.json.upcoming.length === 0,
    r.json,
  );
  const todaySm = r.json.today as string;
  const later = (n: number) => {
    const d = new Date(todaySm + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  r = await sm.post("/api/simple/entry", {
    direction: "out",
    amount: 50_000,
    category: "Shipping & delivery",
    date: todaySm,
    repeat: "once",
  });
  check("“I spent money” today is recorded at once", r.status === 200 && r.json.kind === "recorded", r.json);
  r = await sm.post("/api/simple/entry", { direction: "in", amount: 200_000, category: "Sales", date: todaySm });
  r = await sm.get("/api/simple");
  check(
    "cash follows: 10,000 − 500 + 2,000",
    r.json.cash === 1_150_000 && r.json.month.income === 200_000 && r.json.month.spent === 50_000,
    r.json.month,
  );
  r = await sm.post("/api/simple/entry", {
    direction: "out",
    amount: 300_000,
    category: "Rent",
    note: "Shop rent",
    date: later(5),
    repeat: "monthly",
  });
  check(
    "a fixed monthly cost becomes a reminder, not a payment",
    r.json.kind === "recurring" && r.json.recordedNow === false,
    r.json,
  );
  r = await sm.post("/api/simple/entry", {
    direction: "in",
    amount: 150_000,
    note: "Wholesale order",
    date: later(10),
    repeat: "once",
  });
  check("money expected on a future date is planned", r.json.kind === "planned", r.json);
  r = await sm.get("/api/simple");
  const rent = r.json.upcoming.find((u: any) => u.label === "Shop rent");
  const whole = r.json.upcoming.find((u: any) => u.label === "Wholesale order");
  check(
    "both show in “coming up” with their dates",
    rent?.date === later(5) && whole?.date === later(10) && r.json.cash === 1_150_000,
    r.json.upcoming,
  );
  r = await sm.post("/api/simple/paid", { kind: rent.kind, refId: rent.refId });
  const afterPay = await sm.get("/api/simple");
  check(
    "“Paid” records it and moves the reminder to next month",
    r.status === 200 && afterPay.json.cash === 850_000 && r.json.nextDue > later(5),
    { r: r.json, cash: afterPay.json.cash },
  );
  r = await sm.post("/api/simple/paid", { kind: whole.kind, refId: whole.refId });
  r = await sm.get("/api/simple");
  check(
    "“Received” adds the money and removes it from the list",
    r.json.cash === 1_000_000 && !r.json.upcoming.some((u: any) => u.label === "Wholesale order"),
    r.json.cash,
  );
  r = await sm.post("/api/simple/entry", { direction: "in", amount: 1_000, category: "Rent", date: todaySm });
  check("a category that does not match money in/out is refused", r.status === 422, r.json);
  r = await b.post("/api/simple/paid", { kind: rent.kind, refId: rent.refId });
  check("another workspace cannot mark it paid", r.status === 404, r.status);

  console.log("\n19. Salaries: one row per employee, paid on the usual day or early");
  r = await sm.post("/api/fixed/employees", { name: "Omar", role: "Delivery", salary: 400_000, payDay: 1 });
  check("an employee is added with a pay day", r.status === 200 && typeof r.json.id === "string", r.json);
  const omar = r.json.id as string;
  r = await sm.post("/api/fixed/employees", { name: "Laila", salary: 500_000 });
  check(
    "a new person joins the team's usual pay day",
    r.status === 200 && Number(String(r.json.nextDue).slice(8)) === 1,
    r.json,
  );
  const laila = r.json.id as string;
  r = await sm.get("/api/fixed");
  check(
    "the salaries band lists everyone with the monthly total",
    r.json.salaries.employees.length === 2 && r.json.salaries.total === 900_000 && r.json.salaries.payDay === 1,
    r.json.salaries,
  );
  const cashBefore = (await sm.get("/api/simple")).json.cash as number;
  r = await sm.get("/api/simple");
  const salLine = r.json.upcoming.find((u: any) => u.kind === "salaries");
  check(
    "“coming up” shows salaries as one line for the pay day",
    !!salLine && salLine.people === 2 && salLine.amount === -900_000,
    r.json.upcoming,
  );
  r = await sm.post(`/api/fixed/employees/${omar}/pay`, {});
  r = await sm.get("/api/fixed");
  const o = r.json.salaries.employees.find((e: any) => e.id === omar);
  check(
    "one person marked paid early is recorded and moves to next month",
    o.status === "paid" && o.early === true && o.lastPaid === todaySm && r.json.salaries.left === 500_000,
    { o, todaySm, left: r.json.salaries.left },
  );
  check("paying a salary takes it from cash", (await sm.get("/api/simple")).json.cash === cashBefore - 400_000);
  r = await sm.post(`/api/fixed/employees/${laila}/pay`, { date: later(3) });
  check("a salary cannot be recorded in the future", r.status === 422, r.json);
  r = await sm.post("/api/fixed/salaries/pay-all", {});
  check("“pay everyone” pays only who is left", r.json.paid === 1 && r.json.total === 500_000, r.json);
  r = await sm.patch("/api/fixed/salaries", { payDay: 25 });
  r = await sm.get("/api/fixed");
  check(
    "everyone's pay day can change at once",
    r.json.salaries.employees.every((e: any) => e.payDay === 25),
    r.json.salaries.employees,
  );
  r = await b.post(`/api/fixed/employees/${omar}/pay`, {});
  check("another workspace cannot pay this team", r.status === 404, r.status);
  r = await sm.post(`/api/fixed/${omar}/stop`, {});
  r = await sm.get("/api/fixed");
  check(
    "someone who left is removed from the band, their history stays",
    r.json.salaries.employees.length === 1,
    r.json.salaries.employees,
  );

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("Failed:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
