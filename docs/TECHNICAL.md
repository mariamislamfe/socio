# Socio: technical documentation

FinTechathon 2026, Topic E (SME Finance Copilot), theme "AI as a Financial Participant".

## 1. What it is

Socio is a finance copilot for small-business owners, many of them beginners. New accounts start in a simple view: cash now,
what is safe to spend, two buttons to record money in and out, and a list of what is coming up. A full view holds the
detailed tools. Underneath, it does five things:

1. **Watches the money.** It keeps a deterministic picture of cash, true profit, obligations and taxes, built from the ledger, invoices, schedules and (optionally) Shopify.
2. **Notices problems early.** Daily, and after every change, it checks four things:
   - a cash dip below the owner's safety reserve
   - a product that loses money on every sale
   - ad spend that does not pay for itself
   - cash that actually belongs to the tax office
3. **Proposes calculated options.** Each problem gets a diagnosis (facts, plausible explanations and unknowns kept separate) and options whose effect has been re-forecast.
4. **Matches financing.** When a gap appears, it works out how much is needed and by when. It compares each offer by true annual cost, checks that repayments do not create a new dip, and flags offers that look like scams. It can also build a lender-ready file with a fingerprint.
5. **Acts within policy.**
   - Internal, reversible work (alerts, tasks, drafts, tax reserves) is done automatically.
   - Bounded work (payment reminders) happens only within the owner's limits.
   - Anything sensitive or external (changing a bill's date, sharing financial data) always waits for an approval tied to the exact parameters.
   - Its autonomy grows only when the owner accepts, based on its own measured track record.

The owner talks to it in plain Arabic or English (**Ask your business**). Every morning a briefing can also arrive on WhatsApp.

## 2. Architecture

```
Browser (Next.js App Router, React 19, Tailwind v4, Motion)
   │  same-origin JSON API (/api/*), CSRF origin check, session cookie
   ▼
API dispatcher (src/app/api/[...slug]) ── route modules (src/lib/server/routes/*)
   │
   ├── Deterministic engines (pure, unit-tested; src/lib/finance/*)
   │     engine.ts · planning.ts · cashrisk.ts · detectors.ts · profit.ts · financing.ts · lenderpack.ts · scenarios.ts
   │
   ├── Operating loop (src/lib/server/brain/*)
   │     policy.ts (levels, approvals, trust ladder) · tools.ts (registry) · actions.ts (propose/approve/execute) · workflows.ts
   │
   ├── Agent (src/lib/server/agent.ts): intent → plan → read-only tools → proposals (policy-checked)
   │     Claude tool use when configured; deterministic planner otherwise (same tools, same policy)
   │
   ├── Durable jobs & events (src/lib/server/jobs.ts, worker.ts): Postgres queue, leases, retries, dead-letter, idempotency
   │
   ├── Integrations: Shopify (OAuth, webhooks, reconciliation), Meta/Google Ads (read-only), CSV, WhatsApp Cloud API
   │
   ▼
Postgres (Supabase in production; PGlite locally) with Row Level Security on every tenant table
```

**Key design choice: the model never computes money.** Every figure comes from a deterministic engine, in integer minor units. The language model only does three things:
- it understands the question
- it chooses which read-only tools to call
- it explains the result

So the model has no way to make up a figure, and the agent keeps working if no model is configured.

## 3. The operating loop

| Stage | Where | What happens |
|---|---|---|
| Observe | `jobs.emitEvent` | Ledger writes, syncs and webhooks emit durable events. Fan-out is deterministic and debounced (2 min) into `cash_risk.evaluate` and `findings.evaluate`. |
| Diagnose | `cashrisk.ts`, `detectors.ts` | Cautious forecast: scheduled items, plus typical sales at 80% and typical spending. Findings split into facts, plausible explanations and unknowns, plus a data-quality score. |
| Plan | same | Each option is re-forecast. An option is offered only if it raises the lowest balance or delays the first dip. |
| Decide | `policy.decide` | Level 1 runs automatically. Level 2 runs only within server-enforced limits. Level 3 always needs approval. A global pause turns everything into approvals. Viewers are prohibited. |
| Act | `tools.ts`, `actions.ts` | A fixed registry, each tool with a zod schema, availability check, timeout and post-execution verification. An approval is bound to `sha256(tool + canonical params)`. |
| Learn | `measureOutcomes`, `trustLadder` | Predictions are stored and later compared with recorded cash. Accuracy and approval history feed the trust ladder. |

### Checks (detectors)
- **Cash risk.** First breach of the safety reserve within 60 days, its contributors, and options: collect receivables, move a bill (approval), trim ads, pause a recurring cost.
- **Product loss.** Per-product contribution from order lines.
  - Payment fees are allocated by share of order value; shipping and packaging by share of items in the parcel.
  - Advertising is allocated by share of sales and labelled as an allocation.
  - Options include an exact break-even price.
- **Ad spend.** Marginal return on extra spend (Δrevenue / Δspend) compared with break-even (1 / gross margin) over 28-day windows. Options are quantified in monthly profit and 60-day cash.
- **Tax set-aside.** VAT inside VAT-inclusive sales (14/114 for Egypt), with last month treated as owed until a tax payment is recorded, plus an optional income-tax reserve.
  - The reserve is created automatically (bookkeeping only; no money moves).
  - Warns if cash after taxes and 30 days of bills falls below the reserve.

### Financing (`financing.ts`)
- **Need:** how much is required to stay above the reserve over 120 days, and by when.
- **Offers:**
  - Cash flows per repayment type: one payment at the end, monthly, weekly, or a share of daily sales.
  - The effective annual rate is the internal rate of return, solved by bisection with daily compounding.
  - The cash forecast is re-run with the offer's flows to test whether repayments create a new dip.
- **Warning signs:**
  - money asked for before any money is received
  - fees to a personal account or wallet
  - lender not licensed
  - guaranteed approval
  - pressure to sign
  - a flat fee that hides an annual rate above 100%
- **Ranking:** no danger signs first, then keeps cash safe, then lowest total cost.
- **Lender file:** six months of results, a 13-week forecast with and without the loan, aging of what customers owe and what the business owes, and data-quality sources.
  - Its SHA-256 fingerprint is computed over canonical JSON.
  - Sharing is the level-3 tool `share_lender_pack`. Only the token's hash is stored; links expire (1–14 days), can be revoked, and are view-counted.

### Safety screen (`agentguard.ts`)
Every question is screened before the agent runs, deterministically, in English and Egyptian Arabic (Arabic is normalised:
alef forms, ة/ه, ى/ي, Arabic-Indic digits). Requests to transfer or pay money, share records outside the account, reveal
passwords or OTP codes, rewrite the rules, grant permissions or skip approvals, and impersonation ("I'm from the bank")
get a fixed answer with a safe alternative; no tool or model runs and the run is audited with its guard kind. Greetings,
off-topic questions, investment tips and very vague questions get examples or a clarifying question. Questions *about*
paying ("Can I afford to pay salaries?", "اقدر ادفع 5000 للمورد؟") go through. A short follow-up is read with the
previous question; a correction ("no, I meant cash") is answered as corrected, and is still screened.

### Agent ("Ask your business")
- **Tools:**
  - `make_plan` (always called first)
  - read-only facts: `get_cash_outlook`, `get_profit`, `simulate`, `compare_financing`, `get_findings`, `get_tax_position`
  - `propose_action`, limited to a fixed list of tools and routed through `proposeAction` with the user's role and `origin='agent'`
- **Guards:**
  - unknown tools are refused
  - inputs are validated with zod
  - at most 3 proposals per request
  - tool output is treated as data (prompt-injection rule)
  - the model has no approve capability
  - runs are audited
- **Fallback:** a deterministic planner (financing, tax, collections, moving a bill, daily focus, and general questions through the copilot engine) produces the same output shape.
- **Language:** the client sends its locale. If it is Arabic, or the question contains Arabic script, Claude is told to answer in simple Egyptian Arabic, and the rules planner and copilot engine use their own Egyptian Arabic sentence templates. The numbers come from the same engines in both languages (covered by a unit test).

### Money plan (`moneyplan.ts`)
- *Safe to spend* = cash − money owed to the tax office − bills and salaries due in 30 days − safety reserve. Income that has not arrived is not counted, so the number is cautious. The simple home shows this subtraction line by line ("Why this number?") so a 0 is never a mystery.
- *Owner's pay* = the owner's share (default 50%) of average monthly profit after VAT, capped by what is free right now. It is recorded under the `owner_draw` category: it reduces cash, never profit.
- *From every 100 of sales*: product costs, taxes, advertising, shipping, people, rent, other running costs, then the owner's pay and what stays in the business (or a loss), from the last 30 days.

### Financing readiness
A 0–100 score in seven parts, each with a "how to improve" line:
- track record
- profitable on average
- steady results
- data completeness
- customers paying on time
- cash cushion
- legal basics

Offers repaid in installments are also checked against average monthly profit:
- more than 50% → warning
- more than 100% → danger ("could sink the business")

### Simple view, salaries and fixed costs (`routes/simple.ts`, `routes/fixed.ts`)
- `POST /api/simple/entry` is one entry point for "I got money" / "I spent money":
  - today or a past date: a transaction
  - a future date: an open invoice (bill to pay or money to receive)
  - monthly or yearly: a recurring schedule, recorded now as well if the first date is today or earlier
- `POST /api/simple/paid` marks a scheduled item paid: it records the transaction (and the invoice payment) and moves a recurring item to its next date.
- **Salaries.** Each employee is a monthly `recurring` row with `kind='salary'` (name, job in `notes`, salary, next pay date). No new table was needed, and the forecast, calendar, reminders and "safe to spend" include salaries automatically.
  - Status per person: *late* if the pay date has passed, *paid* if a salary was recorded this calendar month, otherwise *due*.
  - "Paid" can be recorded today or on a past day (never the future). It moves that person's next pay date by one month; paying before the date covered is shown as *paid early*.
  - The team shares a pay day (1–28), which can be changed for everyone at once. Someone who leaves is stopped (`active=false`); past salaries stay in the books.
  - On the simple home, salaries due on the same day appear as one line ("Salaries · 3 people").
- **Calendar quick add.** Tapping an empty day opens the same entry form with that date already set, so a payment or expected income is added without leaving the calendar.

### Recording by message (`messageparse.ts`, `whatsapp.ts`)
- A deterministic Arabic/English parser: Arabic-Indic digits, thousands separators, "k"/"ألف", sale vs expense verbs, and category keywords. Unclear messages record nothing and get instructions.
- `POST /api/webhooks/whatsapp`:
  - verified with `X-Hub-Signature-256` (HMAC-SHA256 with the app secret)
  - de-duplicated by message id
  - accepted only from an owner number that has opted in; unknown numbers are ignored without a reply
  - each entry is recorded with `source='whatsapp'`, emits `ledger.changed`, and is confirmed by reply
- "الغي" deletes the last WhatsApp entry made within 30 minutes.
- The same recorder is exposed in-app (`/api/whatsapp/simulate`) for trying it out.

### Money with couriers (`cod.ts`, `routes/specials.ts`)
A cash-on-delivery batch is a receivable invoice with `courier`, `cod_orders` and `cod_fees` (migration 0008), so the
forecast, calendar and "coming up" include it with no special case. `codSummary` totals what each courier holds, flags
payouts past their expected date (oldest first) and finds the next payout. "Received" records an invoice payment.
The agent has a read-only `get_cod_status` tool.

### Taxes & papers (`taxsetup.ts`)
No tax is estimated until the owner answers six questions (commercial register, tax card, ETA portal, VAT, simplified
regime, e-invoicing). `taxChecklist` turns the answers and the last 12 months of sales into seven steps (done, in
progress, to do, check, not needed yet) with what to bring and where to go; the first open step is "start here".
VAT is set aside only when the owner says they are registered. Thresholds used for guidance: VAT about EGP 500,000 a
year, simplified regime up to EGP 20 million (Law No. 6 of 2025); the page says to confirm with the ETA.

### Media buyer (`adplan.ts`, `mediabuyer.ts`)
- **Plan:**
  - Affordability: the money plan's free cash, plus any cash-risk breach.
  - Product: the best positive earner per unit. Losing products are warned against.
  - Most a sale may cost = product contribution per unit. Target = 70% of that.
  - Realistic expectations, including the business's own past platform ROAS when available.
  - The audience (country, ages, interests, placements) is decided by the co-pilot.
- **Copy:** written in the chosen dialect (Egyptian, Gulf, MSA, English) by Claude when configured, otherwise from templates.
  - The owner's edits are stored as style examples.
  - Prices are never converted between currencies: the owner types the local price.
- **Tools:**
  - `create_meta_campaign` (L3): campaign, ad set, creative and ad, all created PAUSED. Bound to the exact wording, budget, days, country and link, and re-checked at execution.
  - `activate_meta_campaign` (L3).
  - `pause_meta_campaign` (L1: stopping spend is always allowed).
  - `scale_meta_campaign` (L3, at most double the original daily budget).
- **Follow-up** (`ads.monitor`, every 6 h; `judgeCampaign`):
  - *learning* until it has spent the cost of about 1.5 sales (or 60% of the budget)
  - *pause* on no sales or a cost per sale above 1.2× break-even
  - *scale* when the cost per sale is at or below target
  - *unknown* without pixel data

### Language
English or Egyptian Arabic, switchable from the top bar and remembered per device and profile. Arabic mode flips the layout to right-to-left and translates the interface with a reviewed Egyptian dictionary of about 1,600 phrases, plus patterns for sentences that carry numbers and dates (`src/lib/i18n/eg.ts`, `eg-dict.ts`, applied by `components/auto-translate.tsx`). User-typed values are never touched, and anything not in the dictionary stays in English rather than being machine-guessed. Ad copy and the WhatsApp briefing are written natively in the chosen dialect.

### Trust ladder
Advisor → Proven → Trusted assistant.

To reach *Proven*, it needs three things:
- at least 3 forecasts checked against reality
- an average error of 10% or less
- at least 3 of its proposals approved, with few rejections

It then *asks* for a bounded permission: automatic reminders for invoices up to the median receivable. Only the owner can accept, through the automation endpoint, which requires an owner or admin.

## 4. Data model (main tables)

| Area | Tables |
|---|---|
| Tenancy & auth | businesses, members, profiles (Supabase Auth or local sessions) |
| Ledger | accounts, categories, transactions, payees, invoices, invoice_payments, recurring, budgets, goals, goal_contributions |
| Commerce | orders, order_lines, products, external_records, integrations, integration_secrets (encrypted), sync_runs, webhook_events |
| Operating loop | events, jobs, recommendations, actions, predictions, audit_log, briefings, email_drafts, notifications |
| Financing & sharing | financing_offers, share_links (token hash, frozen payload, fingerprint, expiry, revocation, views) |
| Messaging | message_deliveries (channel, masked recipient, status, provider id, error, preview, dedupe key) |
| Media buyer | ad_campaigns (brief, plan, approved creative, Meta ids, metrics), ad_copy_examples (owner's wording per dialect) |

All migrations are additive (`supabase/migrations/0001…0007`). RLS is enabled on every tenant table:
- members can read
- writers can write user-owned tables
- system-owned tables are written only by the server, explicitly scoped by `business_id`

## 5. Running it

```bash
npm install
npm run dev            # embedded Postgres + Next.js on :3000 (PORT=3100 to change)
# Explore demo data: a labelled workspace with a cash dip, a losing product, an ad-spend spike, VAT, 4 financing offers
```

For production setup (Supabase, Shopify app, WhatsApp template, Claude key, cron), see `README.md` and `.env.example`.

## 6. Tests (all run locally against the real routes)

| Suite | Command | Covers |
|---|---|---|
| Unit + DB | `npm test` | 243 tests: safety screen (73 cases), Arabic question parsing, tax checklist, couriers, engines, RLS and tenant isolation, jobs, policy, approvals, cash risk, detectors, financing (annual rate, ranking, scams, readiness), lender file, money plan, message parser, Arabic answers, media-buyer plan and follow-up rules, Shopify pipeline |
| API e2e | `E2E_BASE=… npm run test:e2e` | 164 checks, including checks, financing, share-with-approval, public link and revoke, agent, WhatsApp, trust, simple view entries, salaries (add, pay early, pay everyone, pay day, cross-tenant) |
| Browser e2e | `E2E_BASE=… npm run test:ui` | 43 checks (Playwright), including the simple view, the "why" breakdown, salaries and calendar quick add |
| Media buyer e2e | `npx tsx scripts/mediabuyer-e2e.mts` | 26 checks against a local fake Meta API (plan, dialect, approval, paused creation, activation, auto-pause, tenant isolation) |
| Shopify e2e | `npx tsx scripts/shopify-e2e.mts` | 31 checks against a local fake Shopify (OAuth, refresh rotation, webhooks, compliance, uninstall) |
| Agent + WhatsApp e2e | `npx tsx scripts/agent-e2e.mts` | 25 checks against local fakes of the Anthropic and WhatsApp APIs (briefing, record-by-message webhook, undo) |
| Boardroom e2e | `npx tsx scripts/boardroom-e2e.mts` | 16 checks |
| Agent red-team | `npx tsx scripts/agent-redteam.mts` | 56 checks: 31 attacks (transfer, injection, escalation, impersonation, data, credentials) all blocked with no tool run, plus 8 off-topic, vague or record-a-payment messages handled; normal questions, follow-ups and corrections still work; injection inside an invoice note creates no proposal |
| Couriers and taxes e2e | `npx tsx scripts/egypt-e2e.mts` | 26 checks: no tax estimate before answers, checklist continues from where the owner stopped, COD totals and late payouts, received payouts, agent answers, tenant isolation |

External services were tested **only against local fakes**: no live Shopify store, Claude API key, WhatsApp number or Supabase project was available during development.

The demo video (submitted separately) was recorded from the running app with `scripts/demo-video.mts`, using a fresh demo workspace.
