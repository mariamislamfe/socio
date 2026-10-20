/* Records the demo video: the real app, driven by a script, with captions. Uses a fresh demo workspace; nothing external is touched.
   Run: E2E_BASE=http://localhost:3000 npx tsx scripts/demo-video.mts <out-dir>   (writes a .webm; convert to .mp4 with ffmpeg) */
import { chromium, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const OUT = process.argv[2] ?? ".";
const W = 1280,
  H = 800;
const browser = await chromium.launch();
// Warm up every page first (dev servers compile on first visit), outside the recording.
{
  const warm = await browser.newContext();
  const wp = await warm.newPage();
  const wh = { origin: BASE, "content-type": "application/json" };
  await wp.request.post(BASE + "/api/auth/register", {
    headers: wh,
    data: { name: "W", email: "warm" + Date.now() + "@example.test", password: "correct-horse-battery" },
  });
  await wp.request.post(BASE + "/api/demo", { headers: wh, data: {} });
  for (const p of [
    "/app",
    "/app/fixed",
    "/app/calendar",
    "/app/actions",
    "/app/financing",
    "/app/ask",
    "/app/settings/notifications",
    "/app/media-buyer",
  ])
    await wp.goto(BASE + p, { waitUntil: "load", timeout: 240_000 }).catch(() => {});
  await warm.close();
}
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT, size: { width: W, height: H } },
  deviceScaleFactor: 1,
});

// Captions survive navigation: the text lives in sessionStorage and is drawn on every page load (never translated).
await ctx.addInitScript({
  content:
    "window.__drawCap=function(){var el=document.getElementById('demo-cap');var t=sessionStorage.getItem('demo-cap')||'';if(!el){if(!document.body)return;el=document.createElement('div');el.id='demo-cap';el.setAttribute('data-no-translate','');el.setAttribute('dir','ltr');el.style.cssText='position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:1000px;width:max-content;z-index:2147483647;background:rgba(15,61,49,.95);color:#F4F1EA;font:500 21px/1.35 system-ui,Segoe UI,Arial,sans-serif;padding:14px 22px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);text-align:center;pointer-events:none';document.body.appendChild(el);}if(el.textContent!==t)el.textContent=t;el.style.display=t?'block':'none';};setInterval(window.__drawCap,300);var st=document.createElement('style');st.textContent='nextjs-portal{display:none!important}';document.addEventListener('DOMContentLoaded',function(){document.head.appendChild(st);});",
});

const h = { origin: BASE, "content-type": "application/json" };
const page = await ctx.newPage();
const t0 = Date.now();
// Optional narration: VOICE=<manifest.json> makes each caption last at least as long as its spoken line, and logs when each line starts.
const voice: Record<string, { wav: string; ms: number }> = process.env.VOICE
  ? JSON.parse((await import("node:fs")).readFileSync(process.env.VOICE, "utf8"))
  : {};
const events: { wav: string; t: number }[] = [];
const say = (text: string, hold: number) => {
  const v = voice[text];
  if (!v) return hold;
  events.push({ wav: v.wav, t: Date.now() - t0 });
  return Math.max(hold, v.ms + 500);
};
const pause = (ms: number) => page.waitForTimeout(ms);
const cap = async (p: Page, text: string, hold = 4500) => {
  await p.evaluate((t) => {
    sessionStorage.setItem("demo-cap", t);
    (window as any).__drawCap?.();
  }, text);
  await p.waitForTimeout(say(text, hold));
};
const card = async (p: Page, title: string, sub: string, hold = 5000) => {
  await p.evaluate(
    ([t, s]) => {
      const d = document.createElement("div");
      d.id = "demo-card";
      d.setAttribute("data-no-translate", "");
      d.setAttribute("dir", "ltr");
      d.style.cssText =
        "position:fixed;inset:0;z-index:2147483646;background:#0F3D31;color:#F4F1EA;display:flex;flex-direction:column;justify-content:center;padding:0 110px;gap:22px;font-family:Georgia,serif";
      d.innerHTML = `<div style="font:500 22px system-ui,Arial;letter-spacing:4px;text-transform:uppercase;color:#D8F25A">FinTechathon 2026 · Topic E</div><div style="font-size:88px;line-height:1">${t}</div><div style="font:400 30px/1.4 system-ui,Arial;color:#D4E2DA;max-width:900px">${s}</div>`;
      document.documentElement.appendChild(d);
    },
    [title, sub],
  );
  if (!events.length) events.push({ wav: "START", t: Date.now() - t0 });
  await p.waitForTimeout(say(sub, hold));
  await p.evaluate(() => document.getElementById("demo-card")?.remove());
};
const step = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (e) {
    console.log("step failed:", name, (e as Error).message.split("\n")[0]);
  }
};
const go = async (path: string) => {
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 120_000 }).catch(() => {});
  await pause(1200);
};
const scroll = async (y: number, ms = 1200) => {
  await page.mouse.wheel(0, y);
  await pause(ms);
};

// A fresh demo workspace (labelled demo data), simple view, English.
await page.request.post(`${BASE}/api/auth/register`, {
  headers: h,
  data: { name: "Nadia", email: `video${Date.now()}@example.test`, password: "correct-horse-battery" },
});
await page.request.post(`${BASE}/api/demo`, { headers: h, data: {} });
await page.request.post(`${BASE}/api/checks/run`, { headers: h, data: {} });
await page.request.post(`${BASE}/api/media-buyer/plan`, {
  headers: h,
  data: {
    budget: 100_000,
    days: 5,
    country: "EG",
    dialect: "egyptian",
    goal: "sales",
    link: "https://nile.example/products/linen-shirt",
  },
});
await page.goto(BASE + "/app", { waitUntil: "load", timeout: 120_000 });
await page.evaluate(() => {
  localStorage.setItem("margin-mode", "simple");
  localStorage.setItem("margin-locale", "en");
});
await go("/app");
await page.waitForSelector("text=Money you have now", { timeout: 60_000 });

await card(
  page,
  "socio",
  "An AI finance partner for small businesses. It sees the money, decides with the owner, and acts only with permission.",
  6000,
);

await step("home", async () => {
  await cap(
    page,
    "Meet Nadia, who runs a small clothing shop in Cairo. This is her real Socio home (demo data).",
    5000,
  );
  await cap(page, "One honest number: how much she can safely spend today.", 3500);
  await page.getByRole("button", { name: "Why this number?" }).click();
  await cap(
    page,
    "Today it is 0 — and Socio shows why: cash minus taxes, the next 30 days of bills and salaries, and her safety cushion.",
    6500,
  );
  await page.getByRole("button", { name: "Hide" }).click();
});

await step("spend", async () => {
  await cap(page, "Recording money takes three taps.", 2000);
  await page.getByRole("button", { name: /I spent money/ }).click();
  await pause(800);
  await page.getByRole("dialog").getByRole("textbox").first().pressSequentially("850", { delay: 120 });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Shipping & delivery/ })
    .click();
  await cap(page, "850 for shipping, today. Saved — her cash and forecast update at once.", 2500);
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await pause(1500);
  await scroll(500, 600);
  await cap(
    page,
    "“Coming up” lists every bill, salary and expected payment with its date. Salaries are one line.",
    5000,
  );
  await scroll(-500, 400);
});

await step("salaries", async () => {
  await go("/app/fixed");
  await cap(page, "Bills & fixed costs: each employee, their salary, and one pay day for the whole team.", 5000);
  await page.getByRole("button", { name: "Mark Yasmin as paid" }).click();
  await cap(page, "Yasmin asked to be paid early. One tap records it — her next salary moves to next month.", 3500);
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await cap(page, "", 2500);
});

await step("calendar", async () => {
  await go("/app/calendar");
  await cap(
    page,
    "The money calendar: what is due each day, and the cash left after it. Red dots = below the safety line.",
    5000,
  );
  const empty = page.locator('button[aria-pressed]:not([aria-label*="item"])');
  await empty.nth(Math.max(0, (await empty.count()) - 3)).click();
  await pause(800);
  await page.getByRole("dialog").getByRole("textbox").first().pressSequentially("1200", { delay: 120 });
  await cap(page, "Tap any day to add what is due — right here, no other page.", 3000);
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await pause(1500);
});

await step("actions", async () => {
  await go("/app/actions");
  await cap(page, "Socio checks her books every time they change, and finds problems before they cost money.", 4500);
  await cap(
    page,
    "Here: part of her cash is VAT that belongs to the tax office. Verified facts, unknowns, and calculated options.",
    5500,
  );
  await scroll(700);
  await cap(page, "Nothing that moves money, shares data or spends on ads happens without her approval.", 4500);
});

await step("financing", async () => {
  await go("/app/financing");
  await cap(page, "Does she need a loan? Socio says how much, by when — and her lender-readiness score.", 5500);
  await scroll(1300, 1500);
  await scroll(900, 1500);
  await cap(page, "Every offer at its true yearly cost. The “only 15% fee” advance is flagged: avoid.", 6000);
});

await step("ask", async () => {
  await go("/app/ask");
  await cap(page, "She can simply ask her business.", 2500);
  await page
    .getByRole("textbox", { name: "Your question" })
    .pressSequentially("What should I focus on today?", { delay: 45 });
  await page.getByRole("button", { name: "Ask" }).click();
  await cap(page, "A visible plan, tool calls for real numbers, and an answer. Actions are only proposed.", 7000);
});

await step("whatsapp", async () => {
  await go("/app/settings/notifications");
  await scroll(900, 800);
  await cap(
    page,
    "She lives on WhatsApp. A message like “دفعت 500 شحن” (I paid 500 shipping) is recorded instantly.",
    3500,
  );
  await page.getByRole("button", { name: "دفعت 500 شحن" }).click();
  await cap(page, "No AI guessing: the same message always records the same thing, only from her own number.", 5000);
});

await step("ads", async () => {
  await go("/app/media-buyer");
  await cap(
    page,
    "Media buyer: an ad she can afford, written in Egyptian dialect. She approves the exact words before anything is created.",
    6000,
  );
  await scroll(800, 1500);
  await cap(
    page,
    "It starts paused, needs a second approval to spend, and stops itself if it spends without sales.",
    5000,
  );
});

await step("arabic", async () => {
  await go("/app");
  await cap(page, "And the whole app speaks her language: one tap to Egyptian Arabic.", 2500);
  await page.getByRole("button", { name: "التحويل للمصري" }).click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await pause(2500);
  await cap(page, "Right to left, everyday Egyptian, same numbers.", 4500);
  await go("/app/ask");
  await page.locator("main input").last().pressSequentially("اركز على إيه النهارده؟", { delay: 60 });
  await page.keyboard.press("Enter");
  await cap(page, "Ask in Arabic, get the answer in Egyptian Arabic.", 9000);
});

await cap(page, "", 300);
await card(
  page,
  "socio",
  "Built and tested: 450 automated checks, sandboxed integrations, row-level security, approvals bound to the exact action.",
  6500,
);

await page.close();
const path = await page.video()?.path();
await ctx.close();
await browser.close();
console.log("video:", path);
(await import("node:fs")).writeFileSync(OUT + "/events.json", JSON.stringify(events, null, 1));
