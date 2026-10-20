import { chromium } from "playwright";
import path from "node:path";
const BASE = "http://localhost:3000";
const out = process.argv[2];
const b = await chromium.launch();
for (const size of [
  { n: "desktop", w: 1360, h: 900 },
  { n: "mobile", w: 390, h: 844 },
]) {
  const ctx = await b.newContext({ viewport: { width: size.w, height: size.h } });
  const h = { origin: BASE, "content-type": "application/json" };
  await ctx.request.post(`${BASE}/api/auth/register`, {
    headers: h,
    data: { name: "B", email: `bb${size.n}${Date.now()}@example.test`, password: "correct-horse-battery" },
  });
  await ctx.request.post(`${BASE}/api/demo`, { headers: h, data: {} });
  const s = await (
    await ctx.request.post(`${BASE}/api/boardroom/sessions`, {
      headers: h,
      data: { topic: "هل أقدر أعيّن مصمم بـ 5000 جنيه في الشهر؟" },
    })
  ).json();
  await (await ctx.request.post(`${BASE}/api/boardroom/sessions/${s.id}/run`, { headers: h, data: {} })).text();
  const page = await ctx.newPage();
  for (let i = 0; ; i++) {
    try {
      await page.goto(`${BASE}/app/boardroom`, { waitUntil: "load", timeout: 120000 });
      break;
    } catch (e) {
      if (i > 3) throw e;
      await page.waitForTimeout(1500);
    }
  }
  await page.waitForTimeout(2500);
  await page.locator("aside button").filter({ hasText: "هل أقدر أعيّن" }).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `${size.n}-boardroom-meeting.png`), fullPage: true });
  await ctx.close();
}
await b.close();
console.log("ok");
