/* Media buyer end-to-end through the real routes against a LOCAL FAKE Meta API (scripts/fake-meta.mts).
   No real ad is created and nothing is spent. Start the app with:
   META_APP_ID=test_meta META_APP_SECRET=test_meta_secret META_API_BASE=http://127.0.0.1:4040 \
   META_SCOPES=ads_read,ads_management,pages_show_list,pages_manage_ads npm run dev */
import { startFakeMeta } from "./fake-meta.mts";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
let passed = 0;
const failed: string[] = [];
const check = (n: string, ok: unknown, x?: unknown) =>
  ok
    ? (passed++, console.log(`  ✓ ${n}`))
    : (failed.push(n), console.log(`  ✗ ${n}`, x === undefined ? "" : JSON.stringify(x).slice(0, 500)));
class C {
  cookies = new Map<string, string>();
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  }
  async json(method: string, path: string, body?: unknown) {
    const r = await this.req(method, path, body);
    return { status: r.status, json: await r.json().catch(() => null) };
  }
}

const meta = await startFakeMeta(4040);
const a = new C();
const other = new C();
try {
  const stamp = Date.now();
  await a.json("POST", "/api/auth/register", {
    name: "M",
    email: `mb${stamp}@example.test`,
    password: "correct-horse-battery",
  });
  await a.json("POST", "/api/demo");
  await other.json("POST", "/api/auth/register", {
    name: "O",
    email: `mbo${stamp}@example.test`,
    password: "correct-horse-battery",
  });
  await other.json("POST", "/api/businesses", { name: "Other", currency: "EGP", setup_mode: "manual" });

  console.log("1. Planning with the owner");
  let r = await a.json("GET", "/api/media-buyer");
  check(
    "before connecting Meta, planning works and says what is missing",
    r.status === 200 && r.json.connection.ready === false && /Connect your Meta/.test(r.json.connection.reason ?? ""),
    r.json.connection,
  );
  const keychain = r.json.products.find((p: any) => /keychain/i.test(p.title));
  r = await a.json("POST", "/api/media-buyer/plan", {
    budget: 100_000,
    days: 5,
    country: "SA",
    dialect: "gulf",
    goal: "sales",
    link: "https://shop.example/linen-shirt",
  });
  const p1 = r.json;
  check(
    "the plan picks a product that earns money (not the losing keychain)",
    r.status === 200 &&
      p1.plan.product &&
      !/keychain/i.test(p1.plan.product.title) &&
      p1.plan.product.contributionPerUnit > 0,
    p1.plan?.product,
  );
  check(
    "it sets the most a sale may cost from the product's real margin",
    p1.plan.maxCostPerSale === p1.plan.product.contributionPerUnit &&
      p1.plan.targetCostPerSale < p1.plan.maxCostPerSale,
    p1.plan,
  );
  check(
    "it checks affordability against free cash and the cash forecast",
    ["ok", "tight", "no"].includes(p1.plan.affordable.level) && p1.plan.affordable.text.length > 20,
    p1.plan.affordable,
  );
  check(
    "targeting Saudi Arabia: prices are not converted silently (owner types the SAR price)",
    p1.plan.warnings.some((w: string) => /SAR/.test(w)) && p1.creative.priceText === "",
    p1.plan.warnings,
  );
  check(
    "the ad is written in the chosen dialect (Gulf)",
    /الحين|لين/.test(p1.creative.primaryText + p1.creative.headline),
    p1.creative,
  );
  check(
    "the co-pilot handles the audience details itself",
    p1.plan.audience.countries[0] === "SA" && p1.plan.audience.interests.length > 0,
    p1.plan.audience,
  );
  if (keychain) {
    r = await a.json("POST", "/api/media-buyer/plan", {
      budget: 50_000,
      days: 3,
      country: "EG",
      dialect: "egyptian",
      link: "https://shop.example/k",
      productKey: keychain.key,
    });
    check(
      "choosing a product that loses money brings a clear warning",
      r.json.plan.warnings.some((w: string) => /loses money/.test(w)),
      r.json.plan.warnings,
    );
  }
  const edited = "قميص كتان خفيف يناسب صيف الرياض ☀️\nبـ 199 ريال والتوصيل لين باب بيتك.\nاطلبه الحين!";
  r = await a.json("PATCH", `/api/media-buyer/${p1.id}`, { primaryText: edited });
  check("the owner can rewrite the ad in their own words", r.status === 200, r.json);

  console.log("\n2. Connecting Meta (read + ad management)");
  r = await a.json("POST", "/api/integrations/meta_ads/connect", {});
  const state = new URL(r.json.url).searchParams.get("state")!;
  check(
    "Meta authorisation asks for ad-management permission",
    new URL(r.json.url).searchParams.get("scope")?.includes("ads_management"),
    r.json.url,
  );
  const cb = await a.req("GET", `/api/integrations/meta_ads/callback?code=abc&state=${state}`);
  check(
    "Meta callback completes the connection",
    cb.status >= 300 && cb.status < 400 && /connected=meta_ads/.test(cb.headers.get("location") ?? ""),
    cb.headers.get("location"),
  );
  r = await a.json("GET", "/api/media-buyer");
  check("media buyer is now ready to create ads", r.json.connection.ready === true, r.json.connection);

  console.log("\n3. Approve → created on Meta, paused");
  r = await a.json("POST", `/api/media-buyer/${p1.id}/approve`);
  check(
    "approving the ad creates a level-3 approval (nothing is created yet)",
    r.status === 200 && r.json.mode === "approval" && meta.state.created.length === 0,
    r.json,
  );
  let acts = (await a.json("GET", "/api/actions")).json;
  const create = acts.approvals.find((x: any) => x.tool === "create_meta_campaign");
  check(
    "the approval shows the exact wording, budget, days and country",
    create?.params.primaryText === edited && create.params.budget === 100_000 && create.params.country === "SA",
    create?.params,
  );
  r = await other.json("POST", `/api/actions/${create.id}/approve`, { hash: create.params_hash });
  check("another workspace cannot approve it", r.status === 409 || r.status === 404, r.status);
  r = await a.json("POST", `/api/actions/${create.id}/approve`, { hash: create.params_hash });
  check(
    "owner approval creates campaign, ad set, creative and ad on Meta — all paused",
    r.json.status === "succeeded" &&
      meta.state.created.map((x) => x.kind).join(",") === "campaigns,adsets,adcreatives,ads" &&
      meta.state.created.filter((x) => x.kind !== "adcreatives").every((x) => x.body.status === "PAUSED"),
    { r: r.json, created: meta.state.created.map((x) => x.kind) },
  );
  const adset = meta.state.created.find((x) => x.kind === "adsets")!.body;
  const creative = meta.state.created.find((x) => x.kind === "adcreatives")!.body;
  check(
    "targeting, daily budget and dates come from the plan",
    adset.targeting.geo_locations.countries[0] === "SA" &&
      adset.daily_budget === 20_000 &&
      !!adset.end_time &&
      adset.targeting.flexible_spec?.[0]?.interests?.length > 0,
    adset,
  );
  check(
    "the ad on Meta carries the owner's approved wording",
    creative.object_story_spec.link_data.message === edited &&
      creative.object_story_spec.link_data.link === "https://shop.example/linen-shirt",
    creative.object_story_spec,
  );
  r = await a.json("PATCH", `/api/media-buyer/${p1.id}`, { primaryText: "changed" });
  check("once on Meta, what people see can no longer be changed silently", r.status === 409, r.json);

  console.log("\n4. Start (second approval) and daily follow-up");
  r = await a.json("POST", `/api/media-buyer/${p1.id}/activate`);
  check("starting the ad needs its own approval", r.json.mode === "approval", r.json);
  acts = (await a.json("GET", "/api/actions")).json;
  const act = acts.approvals.find((x: any) => x.tool === "activate_meta_campaign");
  r = await a.json("POST", `/api/actions/${act.id}/approve`, { hash: act.params_hash });
  const campaignId = [...meta.state.objects.keys()].find((k) => k.startsWith("campaigns_"))!;
  check(
    "after approval Meta reports the campaign as active",
    r.json.status === "succeeded" && meta.state.objects.get(campaignId).status === "ACTIVE",
    r.json,
  );
  meta.state.insights = {
    spend: "120.00",
    clicks: "300",
    impressions: "9000",
    actions: [{ action_type: "purchase", value: "6" }],
    action_values: [{ action_type: "purchase", value: "1500" }],
  };
  r = await a.json("POST", `/api/media-buyer/${p1.id}/check`);
  check(
    "results are measured: spend, sales and cost per sale",
    r.status === 200 && r.json.metrics.spend === 12_000 && r.json.metrics.sales === 6 && r.json.costPerSale === 2_000,
    r.json,
  );
  meta.state.insights = {
    spend: "900.00",
    clicks: "800",
    impressions: "40000",
    actions: [{ action_type: "purchase", value: "0" }],
    action_values: undefined,
  };
  r = await a.json("POST", `/api/media-buyer/${p1.id}/check`);
  check(
    "an ad that keeps spending without sales is paused automatically",
    r.json.verdict === "pause" && meta.state.objects.get(campaignId).status === "PAUSED",
    { r: r.json, status: meta.state.objects.get(campaignId).status },
  );
  r = await a.json("GET", "/api/media-buyer");
  const row = r.json.campaigns.find((x: any) => x.id === p1.id);
  check(
    "…and the campaign shows as paused with the reason",
    row.status === "paused" && /single sale|more than it earns/.test(row.metrics.reason),
    row?.metrics,
  );

  console.log("\n5. Safety");
  r = await a.json("POST", "/api/media-buyer/plan", {
    budget: 60_000,
    days: 3,
    country: "EG",
    dialect: "egyptian",
    link: "https://shop.example/x",
  });
  const p2 = r.json.id;
  r = await a.json("POST", `/api/media-buyer/${p2}/approve`);
  await a.json("PATCH", `/api/media-buyer/${p2}`, { primaryText: "نص جديد بعد الموافقة" });
  acts = (await a.json("GET", "/api/actions")).json;
  check(
    "editing after asking for approval cancels the old approval",
    !acts.approvals.some((x: any) => x.tool === "create_meta_campaign" && x.params.campaignId === p2),
    acts.approvals.map((x: any) => x.tool),
  );
  r = await other.json("GET", "/api/media-buyer");
  check("another workspace sees none of these ads", r.json.campaigns.length === 0);
} catch (e) {
  console.error(e);
  failed.push("crashed");
} finally {
  meta.server.close();
}
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) console.log(" - " + failed.join("\n - ")), process.exit(1);
process.exit(0);
