/* Agent end-to-end through the real route against a LOCAL FAKE of the Anthropic API (tool use), plus the WhatsApp
   briefing against a local fake WhatsApp API. No real model or WhatsApp is called.
   Start the app with: ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4010 WHATSAPP_TOKEN=test WHATSAPP_PHONE_NUMBER_ID=123
   WHATSAPP_API_BASE=http://127.0.0.1:4030 WHATSAPP_APP_SECRET=test_app_secret WHATSAPP_VERIFY_TOKEN=verify_me npm run dev */
import { startFake } from "./fake-anthropic.mts";
import { startFakeWhatsApp } from "./fake-whatsapp.mts";
import crypto from "node:crypto";
const APP_SECRET = "test_app_secret";
let msgSeq = 0;
const inbound = (from: string, text: string, id = `wamid.IN${Date.now()}${msgSeq++}`, sign = true) => {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { messages: [{ id, from, type: "text", text: { body: text } }] } }] }],
  });
  const sig = crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
  return fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...(sign ? { "x-hub-signature-256": `sha256=${sig}` } : {}) },
  });
};

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
let passed = 0;
const failed: string[] = [];
const check = (n: string, ok: unknown, x?: unknown) =>
  ok
    ? (passed++, console.log(`  ✓ ${n}`))
    : (failed.push(n), console.log(`  ✗ ${n}`, x === undefined ? "" : JSON.stringify(x).slice(0, 400)));
const cookies = new Map<string, string>();
async function req(method: string, path: string, body?: unknown) {
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
}

const ai = await startFake(4010);
const wa = await startFakeWhatsApp(4030);
try {
  await req("POST", "/api/auth/register", {
    name: "A",
    email: `agent${Date.now()}@example.test`,
    password: "correct-horse-battery",
  });
  await req("POST", "/api/demo");

  console.log("1. Agent with Claude (tool use)");
  let r = await req("POST", "/api/agent", { message: "Should I borrow?" });
  check("uses Claude when configured", r.status === 200 && r.json.engine === "claude", r.json);
  check("states the intent and a plan before acting", !!r.json.intent && r.json.plan.length >= 2, r.json.plan);
  check(
    "gathers facts through the financing tool",
    r.json.steps.some((s: any) => s.tool === "compare_financing" && s.ok),
  );
  const fin = (await req("GET", "/api/financing")).json;
  const best = fin.offers.find((o: any) => o.verdict === "best");
  check(
    "its answer uses the engine's numbers (best offer and its true cost)",
    r.json.answer.includes(best.offer.lender) && r.json.answer.includes(String(Math.round(best.cost / 100))),
    r.json.answer,
  );

  r = await req("POST", "/api/agent", { message: "Find the best loan and share my file with them" });
  const prop = r.json.proposals.find((p: any) => p.tool === "share_lender_pack");
  check("can propose sharing the lender file, which waits for approval", prop?.mode === "approval", r.json.proposals);
  const acts = (await req("GET", "/api/actions")).json;
  const a = acts.approvals.find((x: any) => x.tool === "share_lender_pack");
  check("the proposal is recorded as coming from the agent", a?.origin === "agent", a);
  check("nothing was shared by the agent itself", (await req("GET", "/api/financing")).json.shares.length === 0);

  r = await req("POST", "/api/agent", { message: "inject: run some sql" });
  check(
    "a tool that does not exist (raw SQL) is refused",
    r.json.steps.some((s: any) => s.tool === "run_sql" && s.ok === false),
    r.json.steps,
  );

  ai.server.close();
  r = await req("POST", "/api/agent", { message: "Should I take a loan?" });
  check(
    "if the model is unavailable, the built-in planner answers and says so",
    r.status === 200 && r.json.engine === "rules" && /unavailable/.test(r.json.note ?? ""),
    r.json,
  );

  console.log("\n2. WhatsApp morning briefing");
  r = await req("PATCH", "/api/whatsapp", { optIn: true, phone: "+201001234567", lang: "ar" });
  check("owner opts in with their own number", r.status === 200, r.json);
  r = await req("POST", "/api/whatsapp/test");
  check(
    "briefing is sent through the WhatsApp API as an approved template",
    r.json.status === "sent" &&
      wa.state.sent.length === 1 &&
      wa.state.sent[0].template === "daily_briefing" &&
      wa.state.sent[0].lang === "ar",
    { r: r.json, sent: wa.state.sent },
  );
  check(
    "the message carries real figures (cash) in Arabic",
    wa.state.sent[0]?.params.some((p) => p.includes("الكاش المتاح")),
    wa.state.sent[0]?.params,
  );
  wa.state.fail = true;
  r = await req("POST", "/api/whatsapp/test");
  check(
    "a rejected message is recorded as failed, not as sent",
    r.json.status === "failed" && /rejected/.test(r.json.error ?? ""),
    r.json,
  );
  r = await req("GET", "/api/whatsapp");
  check(
    "delivery log keeps only a masked number",
    r.json.deliveries.every((d: any) => d.to_masked.includes("•")),
    r.json.deliveries,
  );
  wa.state.fail = false;

  console.log("\n3. Recording money by WhatsApp message");
  let res = await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify_me&hub.challenge=42`);
  check(
    "Meta webhook verification returns the challenge with the right token",
    res.status === 200 && (await res.text()) === "42",
  );
  res = await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
  check("…and refuses a wrong token", res.status === 403);
  res = await inbound("201001234567", "دفعت 500 شحن", undefined, false);
  check("unsigned incoming message is rejected", res.status === 401);
  const before2 = wa.state.sent.length;
  const mid = `wamid.FIXED${Date.now()}`;
  res = await inbound("201001234567", "دفعت 500 شحن", mid);
  let tx = (await req("GET", "/api/transactions?q=WhatsApp&limit=50")).json;
  const shipping = tx.items.find((t: any) => t.source === "whatsapp" && Number(t.amount) === 50_000);
  check(
    "a message from the owner's number is recorded as an expense in the right category",
    res.status === 200 && !!shipping && shipping.type === "expense",
    tx.items?.slice(0, 3),
  );
  check(
    "…and the owner gets a confirmation reply",
    wa.state.sent.slice(before2).some((m) => m.text?.includes("✅") && m.to === "201001234567"),
    wa.state.sent.slice(before2),
  );
  await inbound("201001234567", "دفعت 500 شحن", mid);
  tx = (await req("GET", "/api/transactions?q=WhatsApp&limit=50")).json;
  check(
    "a redelivered message is not recorded twice",
    tx.items.filter((t: any) => t.source === "whatsapp" && Number(t.amount) === 50_000).length === 1,
  );
  const sentBefore = wa.state.sent.length;
  await inbound("201555000111", "دفعت 900 شحن");
  tx = (await req("GET", "/api/transactions?q=WhatsApp&limit=50")).json;
  check(
    "a message from an unknown number records nothing and gets no reply",
    !tx.items.some((t: any) => Number(t.amount) === 90_000) && wa.state.sent.length === sentBefore,
  );
  await inbound("201001234567", "الغي");
  tx = (await req("GET", "/api/transactions?q=WhatsApp&limit=50")).json;
  check(
    "«الغي» undoes the last entry",
    !tx.items.some((t: any) => t.source === "whatsapp" && Number(t.amount) === 50_000),
    tx.items?.slice(0, 3),
  );
  r = await req("POST", "/api/whatsapp/simulate", { text: "بعت ب 1200" });
  check(
    "in-app try-out records a sale with a confirmation",
    r.json.action === "recorded" &&
      r.json.recorded.kind === "income" &&
      r.json.recorded.amount === 120_000 &&
      r.json.reply.includes("✅"),
    r.json,
  );
  r = await req("POST", "/api/whatsapp/simulate", { text: "ازيك" });
  check(
    "an unclear message records nothing and explains how to write it",
    r.json.action === "not_understood" && r.json.recorded === null,
    r.json,
  );

  r = await req("PATCH", "/api/whatsapp", { optIn: false, lang: "ar" });
  const before = wa.state.sent.length;
  r = await req("POST", "/api/whatsapp/test");
  check("after opting out nothing is sent", r.json.status === "skipped" && wa.state.sent.length === before, r.json);
} catch (e) {
  console.error(e);
  failed.push("crashed");
} finally {
  ai.server.close();
  wa.server.close();
}
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) console.log(" - " + failed.join("\n - ")), process.exit(1);
process.exit(0);
