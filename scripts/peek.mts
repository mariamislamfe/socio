/* Dev helper: opens pages as a fresh demo user and saves screenshots. Run: E2E_BASE=http://localhost:3000 npx tsx scripts/peek.mts <outdir> [lang] [paths…] */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const [out, lang = "en", ...rest] = process.argv.slice(2);
const paths = rest.length ? rest : ["/app"];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await ctx.addInitScript((l) => {
  try {
    localStorage.setItem("margin-locale", l);
  } catch {}
}, lang);
const h = { origin: BASE, "content-type": "application/json" };
const reg = await ctx.request.post(`${BASE}/api/auth/register`, {
  headers: h,
  data: { name: "T", email: `pk${Date.now()}@example.test`, password: "correct-horse-battery" },
});
console.log("register", reg.status());
const demo = await ctx.request.post(`${BASE}/api/demo`, { headers: h, data: {} });
console.log("demo", demo.status());
await ctx.request.post(`${BASE}/api/checks/run`, { headers: h, data: {} });
const page = await ctx.newPage();
for (const p of paths) {
  await page.goto(BASE + p, { waitUntil: "load", timeout: 240000 });
  await page.waitForTimeout(4000);
  const name = p.replace(/\W+/g, "_") || "root";
  await page.screenshot({ path: `${out}/${lang}${name}.png`, fullPage: !process.env.VIEWPORT });
  console.log(p, "→", page.url());
}
await browser.close();
