/* Dev helper: prints a JSON API response for a fresh demo user. Run: E2E_BASE=http://localhost:3000 npx tsx scripts/peek-api.mts /api/financing */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const browser = await chromium.launch();
const ctx = await browser.newContext();
const h = { origin: BASE, "content-type": "application/json" };
await ctx.request.post(`${BASE}/api/auth/register`, {
  headers: h,
  data: { name: "T", email: `pa${Date.now()}@example.test`, password: "correct-horse-battery" },
});
await ctx.request.post(`${BASE}/api/demo`, { headers: h, data: {} });
for (const p of process.argv.slice(2)) {
  const r = await ctx.request.get(BASE + p, { headers: h });
  console.log(p, r.status(), (await r.text()).slice(0, 6000));
}
await browser.close();
