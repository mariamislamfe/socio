/* Lists English text still visible in Egyptian Arabic mode, page by page (for completing the dictionary).
   Run: E2E_BASE=http://localhost:3100 npx tsx scripts/untranslated.mts [paths…] */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const paths = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => (p.startsWith("/") ? p : "/" + p))
  : [
      "/app",
      "/app/actions",
      "/app/plan",
      "/app/financing",
      "/app/media-buyer",
      "/app/ask",
      "/app/settings/notifications",
      "/app/profit",
      "/app/calendar",
    ];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("margin-locale", "ar");
  } catch {}
});
const h = { origin: BASE, "content-type": "application/json" };
if (!process.env.NOLOGIN)
  await ctx.request.post(`${BASE}/api/auth/register`, {
    headers: h,
    data: { name: "T", email: `tr${Date.now()}@example.test`, password: "correct-horse-battery" },
  });
if (!process.env.NOLOGIN) await ctx.request.post(`${BASE}/api/demo`, { headers: h, data: {} });
if (!process.env.NOLOGIN) await ctx.request.post(`${BASE}/api/checks/run`, { headers: h, data: {} });
if (!process.env.NOLOGIN)
  await ctx.request.post(`${BASE}/api/media-buyer/plan`, {
    headers: h,
    data: { budget: 300000, days: 5, country: "EG", dialect: "egyptian", goal: "sales", link: "https://x.example/p" },
  });
const page = await ctx.newPage();
const all = new Map<string, Set<string>>();
for (const p of paths) {
  await page.goto(BASE + p, { waitUntil: "load", timeout: 240000 });
  await page.waitForTimeout(3500);
  const found: string[] = await page.evaluate(() => {
    const out = new Set<string>();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest("script,style,code,pre,textarea,[data-no-translate]")) continue;
      const t = (n.nodeValue ?? "").replace(/\s+/g, " ").trim();
      if (/[A-Za-z]{3,}/.test(t) && el.offsetParent !== null) out.add(t);
    }
    document.querySelectorAll("[placeholder],[aria-label],[title]").forEach((e) => {
      for (const a of ["placeholder", "aria-label", "title"]) {
        const v = e.getAttribute(a);
        if (v && /[A-Za-z]{3,}/.test(v)) out.add(v);
      }
    });
    return [...out];
  });
  for (const t of found) (all.get(t) ?? all.set(t, new Set()).get(t)!).add(p);
}
console.log(JSON.stringify([...all.keys()].sort(), null, 1));
await browser.close();
