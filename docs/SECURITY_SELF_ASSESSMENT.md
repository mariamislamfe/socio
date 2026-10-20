# Security and compliance self-assessment: Socio (SME Finance Copilot)

Scope: the web app, API, database, background jobs, the AI agent and the external integrations (Shopify, Meta/Google Ads, WhatsApp Cloud API, Resend, Anthropic).
Method: threat modelling of each trust boundary, with controls verified by automated tests where possible (test names are given in brackets).

## 1. Assets and trust boundaries

| Asset | Where | Boundary |
|---|---|---|
| Business financial records | Postgres (per-tenant rows) | Browser ↔ API, tenant ↔ tenant |
| Provider tokens (Shopify, ads) | `integration_secrets`, AES-256-GCM encrypted | Server ↔ provider |
| Ability to change obligations or share data | Tool registry and actions | AI ↔ owner |
| Lender file shared outside | `share_links` (frozen payload) | Owner ↔ lender |
| Owner's phone number | `businesses.settings.whatsapp` | Server ↔ WhatsApp |

## 2. Controls

### Tenant isolation
- **Database-enforced.** Every tenant table has Row Level Security. Each request runs as the `authenticated` role with the verified user in `request.jwt.claims`. Composite foreign keys `(business_id, id)` prevent cross-tenant references.
- **Server-side scoping.** Privileged paths (jobs, webhooks, tools) always filter by `business_id`. A forged workspace cookie is ignored.
- Tests: *B cannot read/edit/delete A's records*, *forged workspace cookie is ignored*, *another tenant cannot approve this action*, *another tenant sees none of these actions or jobs*, *another tenant cannot delete the offer / revoke the link*, plus the RLS unit tests.

### Authentication and sessions
- Supabase Auth in production; local sessions use scrypt password hashes.
- Cookies are HttpOnly and SameSite.
- Cross-site writes are blocked with an Origin check (*cross-origin write blocked*).
- Roles: owner, admin, member, viewer. Viewers can never trigger actions.

### AI as a financial participant: bounded autonomy
| Risk | Control | Test |
|---|---|---|
| Hallucinated numbers | The model never computes money. Facts come only from deterministic read-only tools, and the answer is built from tool results. | *its answer uses the engine's numbers* |
| Arbitrary actions (SQL, shell, HTTP) | Fixed tool registry with zod schemas. Unknown tools are refused. | *a tool that does not exist (raw SQL) is refused*, *unknown tools are refused* |
| Self-approval / privilege escalation | The agent can only *propose*. Approval requires an owner or admin through a separate endpoint. The agent acts with the user's role, never more, and is audited as `origin='agent'`. It cannot change automation limits. The trust ladder only *suggests*. | *the proposal is recorded as coming from the agent*, *nothing was shared by the agent itself* |
| Approving something different from what was reviewed | The approval is bound to `sha256(tool + canonical params)`, and the stored hash is re-checked before execution. | *approval with a different parameter hash is refused* |
| Runaway automation | Global kill switch. Level-2 limits are enforced on the server. At most 3 proposals per agent request. Rate limits apply. | *kill switch: with automation paused even level-1 waits for approval* |
| Attacks typed into the chat (transfer money, leak data, OTP, injection, escalation, impersonation) | A deterministic safety screen answers before any tool or model runs, in English and Egyptian Arabic. | `agent-redteam.mts`: 31/31 attacks blocked, 0 actions created |
| Prompt injection via imported data | The system prompt says tool data is data, not instructions. Tool outputs carry no permissions. Proposals still pass the policy. | refused-tool test |
| Model outage | A deterministic planner gives the same output shape and says that the model was unavailable. | *if the model is unavailable, the built-in planner answers and says so* |

### Financial-harm prevention (protecting beginners)
- **Financing offers:**
  - The true effective annual rate is shown even when an offer is advertised as a "flat fee".
  - Scam patterns are flagged: upfront fees, payments to personal wallets, unlicensed lenders, guaranteed approval, pressure to sign.
  - These offers are never recommended.
  - Tests: *scam signs make an offer 'avoid'*, *a '15% fee' advance shows its true annual cost*.
- **No fake numbers.** Missing costs show as missing; unknowns are listed; demo data is labelled and kept in a separate workspace.
- **Taxes and dates.** Amounts are estimates with stated assumptions. Dates are planning dates, not legal deadlines. No government fees are invented.

### External sharing (lender file)
- Level-3 action that always needs approval.
- The payload is frozen at approval time and fingerprinted (SHA-256 over canonical JSON).
- Only a hash of the 24-byte random token is stored; the owner's copy is encrypted.
- Links expire (1–14 days), can be revoked instantly, are view-counted and audited.
- Guessed or expired tokens reveal nothing, and the endpoint is rate-limited.
- Tests: *nothing is shared before approval*, *the lender can open the read-only file…; fingerprint verifies*, *a guessed token reveals nothing*, *after revoking, the link stops working*.

### Integrations
- **Shopify:**
  - authorization-code grant with `state` bound to the user, plus HMAC verification
  - least-privilege read scopes; tokens expire, refresh and rotate, and are encrypted at rest
  - webhooks are HMAC-verified and de-duplicated
  - compliance webhooks: `shop/redact` erases stored orders, payloads and tokens; no customer personal data is requested
  - uninstall is verified
  - 31 e2e checks
- **Ads:** read-only scopes; the app cannot change budgets.
- **WhatsApp:**
  - only to the owner's own number, after explicit opt-in
  - approved template only
  - the number is validated (E.164) and never logged or shown in full
  - failures are recorded, never retried in a loop
  - opting out stops sending
  - Tests: *the stored number is never shown in full*, *after opting out nothing is sent*.
- **Email:** sent only through an approved or bounded reminder tool; otherwise drafts only.

### Spending money (media buyer)
| Risk | Control | Test |
|---|---|---|
| The AI spends without consent | Creating the ad and starting it are two separate level-3 approvals. Objects are created PAUSED. | *approving the ad creates a level-3 approval (nothing is created yet)*, *starting the ad needs its own approval* |
| The ad changes after approval | The approval is bound to the exact wording, budget, days, country and link, and re-checked at execution. Editing cancels any pending approval. Once the ad is on Meta, its wording is locked. | *editing after asking for approval cancels the old approval*, *once on Meta, what people see can no longer be changed silently* |
| Runaway spend | Fixed total and end date. Automatic pause when there are no sales or the cost per sale exceeds break-even. Scaling needs approval and is capped at 2× the daily budget. | *an ad that keeps spending without sales is paused automatically* |
| Advertising a loss-maker / unaffordable spend | The plan checks free cash and the cash forecast, warns against loss-making products, and sets the most a sale may cost from real margins. | *the plan picks a product that earns money*, *choosing a product that loses money brings a clear warning* |
| Misleading prices abroad | Prices are never converted automatically; the owner types the local price. | *prices are not converted silently* |

### Inbound messages (record by WhatsApp)
- Signed webhooks only (HMAC-SHA256 with the app secret) and de-duplicated by message id. Only the owner's opted-in number is accepted; unknown senders get no reply and nothing is recorded.
- The parser is deterministic, so a message cannot invoke tools beyond "record one entry", "undo" or "balance".
- Undo is limited to the last WhatsApp entry made within 30 minutes. Everything is audited.
- Tests: *unsigned incoming message is rejected*, *a redelivered message is not recorded twice*, *a message from an unknown number records nothing and gets no reply*.

### Secrets and configuration
- Secrets live only in server environment variables. The service-role key is not used.
- `MARGIN_ENCRYPTION_KEY` is required in production.
- No secrets in the repository; `.env*` files are git-ignored.
- Tokens and secrets are redacted in job errors and logs.

### Reliability and integrity
- Integer minor units everywhere; timezone-correct local dates.
- Durable jobs with leases, retries, dead-letter and idempotency keys.
- Re-running checks never duplicates recommendations or actions (*re-running is idempotent*).
- Every action records its verification result.
- Audit log covers proposals, approvals, executions, agent runs, sharing, revocation, WhatsApp opt-in/out and deliveries.

## 3. Residual risks and next steps

The safety screen matches words and phrases, so a new wording can slip past it. Even then the model has no tool that
moves money or shares data, and every proposal still goes through the policy. We plan to grow the red-team list from
real conversations during the pilot.

| Risk | Status / mitigation |
|---|---|
| Live providers untested | Verified only against local fakes. A read-only smoke test on a dev store, a WhatsApp test number and a Claude key is the first post-deploy step. |
| Rate limits are in-memory | Per-instance. Use a shared store (Redis or Postgres) for multi-instance deployments. |
| Prompt injection through free text (e.g. invoice descriptions) | Mitigated by design (no privileged tools, approvals bound to parameters). Content filtering is not implemented. |
| Tax estimates | Conservative (purchase VAT is not netted). Shown as estimates for an accountant to confirm. |
| WhatsApp template approval | Required by Meta. Until approved, nothing is sent and the UI says so. |
| Regulatory | The app is a decision-support tool. It does not lend, hold funds or move money. Financing data is shared only with the owner's approval. |
