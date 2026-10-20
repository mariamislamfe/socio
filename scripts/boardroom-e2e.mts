/* Boardroom end-to-end against a LOCAL FAKE of the Anthropic API (no real model is called).
   Start the app with:  ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4010 npm run dev
   This verifies streaming, persistence, hand-offs and to-do creation through the real routes. */

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
let passed = 0;
const failed: string[] = [];
const check = (n: string, ok: unknown, x?: unknown) =>
  ok ? (passed++, console.log(`  ✓ ${n}`)) : (failed.push(n), console.log(`  ✗ ${n}`, x ?? ""));

import { startFake } from "./fake-anthropic.mts";
const { server: fake, state } = await startFake(4010);

class C {
  cookies = new Map<string, string>();
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  }
  async json(m: string, p: string, b?: unknown) {
    const r = await this.req(m, p, b);
    return { status: r.status, json: await r.json().catch(() => null) };
  }
}

const c = new C();
const stamp = Date.now();
await c.json("POST", "/api/auth/register", {
  name: "B",
  email: `b${stamp}@example.test`,
  password: "correct-horse-battery",
});
await c.json("POST", "/api/demo");

console.log("Boardroom");
let r = await c.json("GET", "/api/boardroom/status");
check("status reports configured", r.json.configured === true && r.json.agents.length === 5, r.json);
r = await c.json("POST", "/api/boardroom/sessions", { topic: "هل أقدر أعيّن مصمم بـ 5000 جنيه؟" });
const id = r.json.id as string;
check("session created", !!id, r);

const res = await c.req("POST", `/api/boardroom/sessions/${id}/run`, {});
check("run streams as server-sent events", res.headers.get("content-type")?.startsWith("text/event-stream"));
const text = await res.text();
const events = text
  .split("\n\n")
  .filter((l) => l.startsWith("data:"))
  .map((l) => JSON.parse(l.slice(5)));
const types = events.map((e) => e.type);
const speakers = events.filter((e) => e.type === "message").map((e) => e.agent);
check(
  "plan arrives first, decision last",
  types[0] === "typing" && types.includes("plan") && types.at(-2) === "decision" && types.at(-1) === "done",
  types,
);
check(
  "speakers follow the plan and the hand-off (cmo → cfo → legal)",
  JSON.stringify(speakers) === JSON.stringify(["cmo", "cfo", "legal"]),
  speakers,
);
check(
  "typing indicators are real events before each message",
  types.filter((t) => t === "typing").length >= speakers.length,
);
const sc = events.find((e) => e.type === "scenario");
check(
  "numbers come from the finance engine, not the model",
  sc && sc.lines.some((l: any) => l.label === "Cash in 90 days" && l.value.includes("→")),
  sc,
);
const decision = events.find((e) => e.type === "decision").decision;
check("one decision with next steps", decision.decision.includes("Hire") && decision.nextSteps.length === 2);

r = await c.json("GET", `/api/boardroom/sessions/${id}`);
check(
  "meeting is persisted with messages and decision",
  r.json.session.status === "decided" &&
    r.json.messages.filter((m: any) => m.kind === "message").length === 3 &&
    !!r.json.session.decision,
  r.json.session?.status,
);
check("owner's question is saved as the first message", r.json.messages[0].kind === "user");

r = await c.json("POST", `/api/boardroom/sessions/${id}/todos`, {});
check("next steps become to-dos", r.json.created === 2, r);
r = await c.json("POST", `/api/boardroom/sessions/${id}/todos`, {});
check("creating them again is idempotent", r.json.created === 0, r);
r = await c.json("GET", "/api/company-health");
check(
  "they appear in the monthly to-do list",
  r.json.todos.some((t: any) => t.source === "boardroom" && t.title.includes("Re-check cash")),
);

const before = state.calls;
const f = await c.req("POST", `/api/boardroom/sessions/${id}/run`, { message: "ماذا لو الراتب 4000 بس؟" });
const t2 = await f.text();
check(
  "follow-up message reconvenes the board",
  t2.includes('"type":"decision"') && state.calls > before,
  t2.slice(0, 600),
);

// isolation
const other = new C();
await other.json("POST", "/api/auth/register", {
  name: "O",
  email: `o${stamp}@example.test`,
  password: "correct-horse-battery",
});
await other.json("POST", "/api/businesses", { name: "Other", currency: "EGP", setup_mode: "manual" });
r = await other.json("GET", `/api/boardroom/sessions/${id}`);
check("another business cannot read this meeting", r.status === 404, r);
const x = await other.req("POST", `/api/boardroom/sessions/${id}/run`, {});
check("…or run it", x.status === 404);

fake.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) console.log(" - " + failed.join("\n - ")), process.exit(1);
process.exit(0);
