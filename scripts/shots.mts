/* Screenshot helper: node/tsx scripts/shots.mts <outDir> [path ...]. Registers a throw-away user with a demo workspace. */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const out = process.argv[2] ?? "shots";
const paths = process.argv.slice(3);
const pages = (paths.length ? paths : ["app"]).map((p) => (p.startsWith("/") ? p : "/" + p));
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const email = `shot${Date.now()}@example.test`;

for (const size of sizes) {
  const ctx = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    hasTouch: size.name === "mobile",
  });
  const req = ctx.request;
  const h = { origin: BASE, "content-type": "application/json" };
  const reg = await req.post(`${BASE}/api/auth/register`, {
    headers: h,
    data: { name: "Shot User", email: size.name + email, password: "correct-horse-battery" },
  });
  if (!reg.ok()) throw new Error("register failed " + (await reg.text()));
  const demo = await req.post(`${BASE}/api/demo`, { headers: h, data: {} });
  if (!demo.ok()) throw new Error("demo failed " + (await demo.text()));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${size.name}] pageerror`, e.message));
  page.on("console", (m) => m.type() === "error" && console.log(`[${size.name}] console`, m.text().slice(0, 200)));
  for (const p of pages) {
    for (let i = 0; ; i++) {
      try {
        await page.goto(BASE + p, { waitUntil: "load", timeout: 240000 });
        break;
      } catch (e) {
        if (i >= 3) throw e; // dev-server hot reloads can abort a navigation; retry
        await page.waitForTimeout(1500);
      }
    }
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => !document.querySelector(".skeleton"), null, { timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const name = `${size.name}-${p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home"}.png`;
    await page.screenshot({ path: path.join(out, name), fullPage: true });
    console.log("saved", name);
  }
  await ctx.close();
}
await browser.close();
