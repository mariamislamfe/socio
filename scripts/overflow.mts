import { chromium } from "playwright";
const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const paths = process.argv.slice(2).map((p) => (p.startsWith("/") ? p : "/" + p));
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const h = { origin: BASE, "content-type": "application/json" };
await ctx.request.post(`${BASE}/api/auth/register`, {
  headers: h,
  data: { name: "O", email: `o${Date.now()}@example.test`, password: "correct-horse-battery" },
});
await ctx.request.post(`${BASE}/api/demo`, { headers: h, data: {} });
const page = await ctx.newPage();
for (const p of paths) {
  await page.goto(BASE + p, { waitUntil: "load", timeout: 240000 });
  await page.waitForTimeout(3500);
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    document.querySelectorAll("body *").forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0)
        out.push(
          `${el.tagName.toLowerCase()}.${(el.className?.toString?.() ?? "").slice(0, 60)} right=${Math.round(r.right)} w=${Math.round(r.width)}`,
        );
    });
    return { vw, sw: document.documentElement.scrollWidth, out: out.slice(0, 12) };
  });
  console.log(p, JSON.stringify(r, null, 1));
}
await b.close();
