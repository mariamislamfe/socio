/* Real-browser end-to-end checks. Requires the app running (npm run dev) and `npx playwright install chromium`. */
import { chromium, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
let passed = 0;
const failed: string[] = [];
function check(name: string, ok: unknown, extra?: unknown) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed.push(name);
    console.log(`  ✗ ${name}`, extra ?? "");
  }
}
const T = 60_000;
async function text(page: Page, sel = "main") {
  return (await page.locator(sel).first().innerText()).replace(/\s+/g, " ");
}

const browser = await chromium.launch();
const stamp = Date.now();

console.log("1. Landing → register → onboarding");
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await ctx.addInitScript(() => {
  try {
    if (!sessionStorage.getItem("e2e-mode-set")) {
      localStorage.setItem("margin-mode", "full");
      sessionStorage.setItem("e2e-mode-set", "1");
    }
  } catch {}
});
const page = await ctx.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(BASE + "/", { waitUntil: "load", timeout: 120_000 });
check(
  "landing renders hero and calls to action",
  (await text(page, "body")).includes("what you keep") || (await text(page, "body")).includes("keep"),
);
await page.getByRole("link", { name: "Get started" }).first().click();
await page.waitForURL("**/register", { timeout: T });
await page.getByLabel("Your name").fill("Layla Hassan");
await page.getByLabel("Email").fill(`layla${stamp}@example.test`);
await page.getByLabel("Password").fill("correct-horse-battery");
await page.getByRole("button", { name: "Create account" }).click();
await page.waitForURL("**/onboarding", { timeout: T });
check("registration lands on onboarding", true);
await page.getByLabel("Business name").fill("Layla Linens");
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("button", { name: /Start fresh/ }).click();
await page.waitForURL(/\/app$/, { timeout: T });
await page.waitForSelector("text=First steps", { timeout: T });
const first = (await text(page)).toLowerCase();
check(
  "new workspace shows the first-steps checklist and no fake data",
  first.includes("first steps") && first.includes("add a few records") && !first.includes("demo"),
  first.slice(0, 200),
);

console.log("\n2. Quick-add updates totals");
await page.keyboard.press("n");
await page.getByRole("dialog").waitFor({ timeout: T });
await page.getByRole("radio", { name: "Income" }).click();
await page.getByLabel("Amount").fill("1000");
await page.getByLabel("Description").fill("First sale");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.getByRole("dialog").waitFor({ state: "detached", timeout: T });
await page.getByLabel("Account menu").waitFor();
await page.waitForFunction(() => document.body.innerText.includes("1,000"), null, { timeout: T });
check("revenue appears after saving income", (await text(page)).includes("1,000"));
await page.keyboard.press("n");
await page.getByRole("dialog").waitFor();
await page.getByLabel("Amount").fill("400");
await page.getByLabel("Category").selectOption({ label: "Packaging" });
await page.getByLabel("Description").fill("Packaging");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.getByRole("dialog").waitFor({ state: "detached", timeout: T });
await page.waitForFunction(() => /EGP\s?600/.test(document.body.innerText), null, { timeout: T });
check("profit = 1,000 − 400 = 600 (not cash, not revenue)", /EGP\s?600/.test(await text(page)));

console.log("\n3. Glossary hints work with keyboard and touch");
const hint = page.getByRole("button", { name: /What is profit\?/i }).first();
await hint.focus();
await page.keyboard.press("Enter");
await page.waitForSelector("text=How Socio calculates it", { timeout: T });
check("keyboard: focus + Enter opens the explanation", true);
await page.keyboard.press("Escape");
await page.waitForSelector("text=How Socio calculates it", { state: "detached", timeout: T });
check("Escape closes it", true);
const touchCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await touchCtx.addInitScript(() => {
  try {
    localStorage.setItem("margin-mode", "full");
  } catch {}
});
// share the session cookies so the touch context is signed in
await touchCtx.addCookies(await ctx.cookies());
const mobile = await touchCtx.newPage();
await mobile.goto(BASE + "/app", { waitUntil: "load", timeout: 120_000 });
await mobile
  .getByRole("button", { name: /What is profit\?/i })
  .first()
  .tap({ timeout: T });
await mobile.waitForSelector("text=Why it matters", { timeout: T });
check("touch: tapping the info icon opens the explanation", true);
await mobile.keyboard.press("Escape");
const overflow = await mobile.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check("mobile has no horizontal page overflow", overflow <= 1, overflow);
check("mobile shows bottom navigation", await mobile.getByRole("navigation", { name: "Primary" }).isVisible());
await mobile.getByRole("button", { name: "Add transaction" }).tap();
check("mobile quick-add opens as a sheet", await mobile.getByRole("dialog").isVisible());
await touchCtx.close();

console.log("\n4. Budgets");
await page.goto(BASE + "/app/budgets", { waitUntil: "load" });
await page
  .getByRole("button", { name: /New budget/ })
  .first()
  .click();
await page.getByLabel("Category").selectOption({ label: "Packaging" });
await page.getByLabel("Planned amount").fill("500");
await page.getByRole("button", { name: "Save budget" }).click();
await page.waitForFunction(() => /80% used/.test(document.body.innerText), null, { timeout: T });
check("budget shows 80% used from stored records (400 of 500)", /80% used/.test(await text(page)));

console.log("\n5. Settings persist");
await page.goto(BASE + "/app/settings/business", { waitUntil: "load" });
const name = page.getByLabel("Business name");
await name.fill("Layla Linens & Co");
await page.getByRole("button", { name: "Save changes" }).click();
await page.waitForSelector("text=Saved", { timeout: T });
await page.reload({ waitUntil: "load" });
await page.waitForFunction(
  () => (document.querySelector("#bn") as HTMLInputElement | null)?.value === "Layla Linens & Co",
  null,
  { timeout: T },
);
check("business name persisted after reload", true);

console.log("\n6. Integrations are honest in the UI");
await page.goto(BASE + "/app/settings/integrations", { waitUntil: "load" });
await page.waitForSelector("text=Shopify", { timeout: T });
const t = await text(page);
if (t.includes("SHOPIFY_CLIENT_ID")) {
  check("shows 'Not connected' and what the server is missing", t.includes("Not connected"));
  check(
    "connect button is disabled without server credentials",
    await page
      .getByRole("button", { name: /Shopify/ })
      .last()
      .isDisabled(),
  );
} else {
  // Server has app credentials: still not connected until the merchant installs, and install needs a store address.
  check("shows 'Not connected' before the merchant authorises", t.includes("Not connected"));
  check(
    "install button is disabled until a store address is entered",
    await page.getByRole("button", { name: /Install with Shopify/ }).isDisabled(),
  );
}

console.log("\n6b. Operating-system pages render from real data");
for (const [path, needle] of [
  ["/app/actions", "Action Center"],
  ["/app/profit", "True profit"],
  ["/app/calendar", "Money calendar"],
  ["/app/financing", "Financing"],
  ["/app/ask", "Ask your business"],
  ["/app/plan", "Your money plan"],
  ["/app/media-buyer", "Media buyer"],
] as const) {
  await page.goto(BASE + path, { waitUntil: "load" });
  await page.waitForSelector(`text=${needle}`, { timeout: T });
  await page.waitForFunction(() => !document.querySelector(".skeleton"), null, { timeout: T }).catch(() => {});
  check(`${path} renders`, (await text(page)).includes(needle));
}
await page.goto(BASE + "/app/actions", { waitUntil: "load" });
await page.getByRole("button", { name: /Run all checks now/ }).click();
await page.waitForTimeout(1500);
check(
  "running all checks gives an honest result (no error toast)",
  !(await text(page)).toLowerCase().includes("something went wrong"),
);

await page.goto(BASE + "/app/ask", { waitUntil: "load" });
await page.getByLabel("Your question").fill("What should I focus on today?");
await page.keyboard.press("Enter");
await page.waitForSelector("text=Understood:", { timeout: T });
const askText = await text(page);
check(
  "asking a question shows what was understood, the plan and the steps taken",
  askText.toLowerCase().includes("plan") && askText.toLowerCase().includes("what it did"),
  askText.slice(0, 300),
);

await page.goto(BASE + "/app/settings/notifications", { waitUntil: "load" });
await page.waitForSelector("text=Morning briefing on WhatsApp", { timeout: T });
check(
  "WhatsApp briefing shows a preview of the real message before anything is sent",
  (await text(page)).includes("Good morning") || (await text(page)).includes("صباح الخير"),
);

console.log("\n7. Command palette & theme");
await page.goto(BASE + "/app", { waitUntil: "load" });
await page.getByLabel("Search or jump to").waitFor({ timeout: T });
await page.waitForTimeout(1200); // let the shell hydrate before using the shortcut
await page.keyboard.press("Control+k");
await page.getByPlaceholder(/Jump to a page/).fill("break-even");
await page.keyboard.press("Enter");
await page.waitForURL(/\/app\/learn#break_even/, { timeout: T });
check("palette jumps to a glossary term", true);
await page.getByRole("button", { name: /Dark mode/ }).click();
check("dark theme applies", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");

console.log("\n7b. Company health");
await page.goto(BASE + "/app/health", { waitUntil: "load" });
await page.waitForSelector("text=Ready for questions?", { timeout: T });
const ht = (await text(page)).toLowerCase();
check(
  "health page shows a verdict, readiness and a monthly to-do list",
  ht.includes("readiness") && ht.includes("to-do") && ht.includes("commercial register"),
);
await page.getByRole("button", { name: "Yes" }).click();
await page.waitForSelector("text=Monthly VAT return", { timeout: T });
check("answering the VAT question adds the monthly VAT return", true);
await page.getByText("Commercial register").first().click();
await page.waitForSelector("text=How to do it", { timeout: T });
check(
  "a legal to-do expands to steps, documents and a source to verify",
  (await text(page)).includes("Verify before relying"),
);
await page.getByRole("button", { name: /Mark “Commercial register” as done/ }).click();
await page.waitForFunction(() => /1 of \d+/.test(document.body.innerText), null, { timeout: T });
check("completing a required item updates the progress", true);

console.log("\n7b2. Simple view (default for beginners)");
const simpleCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await simpleCtx.addCookies(await ctx.cookies());
const sp = await simpleCtx.newPage();
await sp.goto(BASE + "/app", { waitUntil: "load", timeout: 120_000 });
await sp.waitForSelector("text=Money you have now", { timeout: T });
const navText = await sp.locator("nav[aria-label=Main]").innerText();
check(
  "simple view: home shows only cash, two big buttons and what is coming",
  (await sp.getByRole("button", { name: /I got money/ }).isVisible()) &&
    (await sp.getByRole("button", { name: /I spent money/ }).isVisible()),
);
check(
  "simple view: core items, a 'Made for Egypt' group (WhatsApp, couriers, media buyer), the rest folded under Advanced tools",
  navText.includes("Advanced tools") &&
    /made for egypt/i.test(navText) &&
    navText.includes("Money with couriers") &&
    !navText.includes("Boardroom"),
  navText,
);
await sp.getByRole("button", { name: /I spent money/ }).click();
await sp.getByRole("dialog").getByRole("textbox").first().fill("250");
await sp.getByRole("dialog").getByText("Every month", { exact: true }).click();
await sp.getByRole("dialog").getByRole("button", { name: "Save" }).click();
await sp.waitForSelector("text=Saved — we will remind you", { timeout: T });
check("adding a monthly cost is three taps and gives a reminder", true);
check(
  "simple view: True profit and Bills & fixed costs are in the main menu",
  navText.includes("True profit") && navText.includes("Bills & fixed costs"),
  navText,
);
await sp.getByRole("button", { name: "Why this number?" }).click();
check(
  "“safe to spend” explains itself: cash − taxes − bills − cushion",
  await sp.getByText("Bills and salaries in the next 30 days").isVisible(),
);
await sp.goto(BASE + "/app/fixed", { waitUntil: "load", timeout: 120_000 });
await sp.getByRole("button", { name: /Add employee/ }).click();
await sp.getByRole("dialog").getByPlaceholder("e.g. Ahmed").fill("Mona UI");
await sp.getByRole("dialog").getByRole("textbox").nth(2).fill("3000");
await sp.getByRole("dialog").getByRole("button", { name: "Save" }).click();
await sp.waitForSelector("text=Mona UI", { timeout: T });
await sp.getByRole("button", { name: "Mark Mona UI as paid" }).click();
await sp.getByRole("dialog").getByRole("button", { name: "Save" }).click();
await sp.waitForSelector("text=Recorded — paid early", { timeout: T });
check("salaries: add a person, then mark them paid early, in the salaries band", true);
await sp.goto(BASE + "/app/calendar", { waitUntil: "load", timeout: 120_000 });
await sp.waitForSelector("text=Money calendar", { timeout: T });
const emptyDays = sp.locator('button[aria-pressed]:not([aria-label*="item"])');
await emptyDays.last().click();
await sp.getByRole("dialog").getByText("Add to this day").first().waitFor({ timeout: T });
check(
  "calendar: tapping an empty day opens “add” right there, with that date",
  await sp.getByRole("dialog").getByText("Money going out").isVisible(),
);
await simpleCtx.close();

console.log("\n7c. English ⇄ Egyptian Arabic");
await page.goto(BASE + "/app/plan", { waitUntil: "load" });
await page.getByRole("button", { name: "التحويل للمصري" }).click();
await page.waitForFunction(
  () => document.documentElement.dir === "rtl" && document.body.innerText.includes("من كل 100 جنيه بتبيعهم"),
  null,
  { timeout: T },
);
const arText = await text(page, "body");
check(
  "switching to Egyptian Arabic turns the page right-to-left and translates it",
  arText.includes("ليك · الشهر ده") && arText.includes("من كل 100 جنيه بتبيعهم"),
  arText.slice(0, 200),
);
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => document.body.innerText.includes("خطة فلوسك"), null, { timeout: T });
check("the language choice is remembered", (await page.evaluate(() => document.documentElement.lang)) === "ar");
await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Switch to English" }).click()]);
await page.waitForFunction(
  () =>
    document.documentElement.dir !== "rtl" && document.body.innerText.toLowerCase().includes("for you · this month"),
  null,
  { timeout: T },
);
check("switching back restores English", (await text(page, "body")).toLowerCase().includes("for you · this month"));

console.log("\n8. Sign out protects the app");
await page.getByLabel("Account menu").click();
await page.getByRole("button", { name: /Sign out/ }).click();
await page.waitForURL("**/login", { timeout: T });
await page.goto(BASE + "/app", { waitUntil: "load" });
check("signed-out users are redirected to login", page.url().includes("/login"));

check("no uncaught page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log(" - " + failed.join("\n - "));
  process.exit(1);
}
