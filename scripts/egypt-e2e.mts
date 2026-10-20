/* End-to-end checks for the Egypt-specific helpers through the real routes:
   Taxes & papers (no estimate until the owner answers, then a checklist) and money held by couriers (COD).
   Run against a running app: E2E_BASE=http://localhost:3000 npx tsx scripts/egypt-e2e.mts */

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
let passed = 0;
const failed: string[] = [];
const check = (n: string, ok: unknown, x?: unknown) =>
  ok
    ? (passed++, console.log(`  ✓ ${n}`))
    : (failed.push(n), console.log(`  ✗ ${n}`, x === undefined ? "" : JSON.stringify(x).slice(0, 300)));

function client() {
  const cookies = new Map<string, string>();
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return {
    req,
    register: async (tag: string) =>
      req("POST", "/api/auth/register", {
        name: tag,
        email: `${tag}${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`,
        password: "correct-horse-battery",
      }),
  };
}
const today = new Date().toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

try {
  console.log("1. Taxes & papers: nothing is estimated until the owner answers");
  const a = client();
  await a.register("tax");
  let r = await a.req("POST", "/api/businesses", {
    name: "New shop",
    currency: "EGP",
    country: "EG",
    setup_mode: "manual",
    opening_balance: 1_000_000,
  });
  check("a new business is created", r.status === 200, r.json);
  r = await a.req("GET", "/api/tax-setup");
  check(
    "a new business has no tax profile and the checklist is marked unknown",
    r.status === 200 && r.json.profile === null && r.json.checklist.known === false,
    r.json,
  );
  check(
    "six questions are asked, in English and Egyptian Arabic",
    r.json.questions?.length === 6 && r.json.questions.every((q: any) => q.en && q.ar),
  );
  r = await a.req("POST", "/api/agent", { message: "How much tax do I owe?" });
  check(
    "the agent does not estimate tax yet and points to Taxes & papers",
    r.status === 200 && /not estimating any tax/i.test(r.json.answer) && /Taxes & papers/.test(r.json.answer),
    r.json?.answer,
  );
  r = await a.req("POST", "/api/agent", { message: "عليا ضرايب قد إيه؟", lang: "ar" });
  check("…and in Egyptian Arabic", /مش بحسب أي ضرايب/.test(r.json.answer), r.json?.answer);

  r = await a.req("POST", "/api/tax-setup", {
    commercialRegister: "yes",
    taxCard: "in_progress",
    etaPortal: "no",
    vatRegistered: "no",
    simplifiedRegime: "not_sure",
    eInvoicing: "no",
  });
  check("the owner saves their answers", r.status === 200, r.json);
  r = await a.req("GET", "/api/tax-setup");
  check(
    "the checklist continues from where they stopped (tax card in progress is next)",
    r.json.checklist.known && r.json.checklist.next?.id === "tax_card",
    r.json.checklist?.next,
  );
  check(
    "the commercial register is marked done",
    r.json.checklist.steps.find((s: any) => s.id === "commercial_register")?.status === "done",
  );
  check(
    "each open step says what to do, in both languages",
    r.json.checklist.steps
      .filter((s: any) => s.status !== "done")
      .every((s: any) => s.how.en.length && s.how.ar.length),
  );
  r = await a.req("POST", "/api/agent", { message: "What should I do about taxes?" });
  check(
    "the agent now gives the next step instead of a number",
    /Next: Get a tax card/.test(r.json.answer),
    r.json?.answer,
  );
  r = await a.req("POST", "/api/tax-setup", { commercialRegister: "maybe" });
  check("invalid answers are rejected", r.status === 422, r.json);

  console.log("\n2. Money with couriers (demo workspace)");
  const d = client();
  await d.register("cod");
  await d.req("POST", "/api/demo");
  r = await d.req("GET", "/api/cod");
  const s = r.json?.summary;
  check("couriers' money is listed with a total held", r.status === 200 && s.held > 0 && s.couriers.length === 3, s);
  check(
    "the late payout is flagged (Mylerz, 9 days)",
    s.worst?.courier === "Mylerz" && s.worst.oldestLateDays === 9 && s.late > 0,
    s.worst,
  );
  check("the next payout is known", !!s.nextPayout?.date, s.nextPayout);
  const fin = (await d.req("GET", "/api/financing")).json;
  check("the financing story still shows a dip in the future", fin.need.atRisk && fin.need.neededBy > today, fin.need);

  r = await d.req("POST", "/api/cod", {
    courier: "Bosta",
    collected: 500_000,
    fees: 40_000,
    orders: 7,
    delivered_on: today,
    expected_on: plus(6),
  });
  check("a new delivery batch is added (net of courier fees)", r.status === 200 && r.json.net === 460_000, r.json);
  r = await d.req("POST", "/api/cod", {
    courier: "Bosta",
    collected: 10_000,
    fees: 20_000,
    orders: 1,
    delivered_on: today,
    expected_on: plus(6),
  });
  check("fees larger than the collection are refused", r.status === 422, r.json);
  r = await d.req("POST", "/api/cod", {
    courier: "Bosta",
    collected: 10_000,
    fees: 0,
    orders: 1,
    delivered_on: today,
    expected_on: plus(-30),
  });
  check("a payout date before delivery is refused", r.status === 422, r.json);
  const after = (await d.req("GET", "/api/cod")).json.summary;
  check("the total held grows by the net amount", after.held === s.held + 460_000, {
    before: s.held,
    after: after.held,
  });
  const cal = (await d.req("GET", "/api/simple")).json;
  check(
    "COD money appears in the owner's 'coming up' list",
    JSON.stringify(cal).includes("COD · Bosta"),
    Object.keys(cal ?? {}),
  );

  const late = after.open.find((b: any) => b.courier === "Mylerz");
  const acc = (await d.req("GET", "/api/cod")).json.accounts[0];
  r = await d.req("POST", `/api/invoices/${late.id}/payments`, {
    amount: late.outstanding,
    paid_on: today,
    account_id: acc.id,
  });
  check("marking a payout received records the money", r.status === 200, r.json);
  const cleared = (await d.req("GET", "/api/cod")).json.summary;
  check("…and the late warning clears", cleared.late === 0 && !cleared.worst, cleared.worst);

  r = await d.req("POST", "/api/agent", { message: "How much money is with the couriers?" });
  check(
    "the agent answers about couriers from the same numbers",
    /Couriers are holding/.test(r.json.answer) && r.json.steps.some((x: any) => x.tool === "get_cod_status"),
    r.json?.answer,
  );
  r = await d.req("POST", "/api/agent", { message: "فلوسي اللي عند شركات الشحن كام؟" });
  check("…and in Egyptian Arabic", /شركات الشحن ماسكة/.test(r.json.answer), r.json?.answer);

  console.log("\n3. Isolation");
  const b = client();
  await b.register("other");
  await b.req("POST", "/api/demo");
  r = await b.req("POST", `/api/invoices/${late.id}/payments`, { amount: 100, paid_on: today, account_id: acc.id });
  check("another business cannot touch these COD batches", r.status === 404 || r.status === 422, r);
  const bs = (await b.req("GET", "/api/cod")).json.summary;
  check("another business sees only its own couriers' money", !bs.open.some((x: any) => x.id === late.id));
} catch (e) {
  failed.push(String(e));
  console.error(e);
}
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
