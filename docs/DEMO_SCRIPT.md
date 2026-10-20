# Demo video: Socio (4 min 45 s)

The video (submitted separately) is H.264, 1920×1080, with English captions burned in. The voice-over is recorded by our team.
It was recorded from the running app by `scripts/demo-video.mts`, in a fresh demo workspace with labelled demo data. Nothing external was touched.
To re-record:
1. Start the app.
2. Run `E2E_BASE=http://localhost:3000 npx tsx scripts/demo-video.mts <out-dir>`. With `VOICE=<manifest.json>`, each scene lasts as long as its spoken line, and the start time of each line is logged to `events.json`.
3. Add the voice track with ffmpeg.

Each caption below matches one scene. The spoken narration follows the captions but isn't word for word.

| # | Scene | Caption / narration |
|---|---|---|
| 1 | Title | Socio — an AI finance partner for small businesses. It sees the money, decides with the owner, and acts only with permission. |
| 2 | Home | Meet Nadia, who runs a small clothing shop in Cairo. This is her real Socio home (demo data). |
| 3 | Home | One honest number: how much she can safely spend today. |
| 4 | “Why this number?” | Today it is 0 — and Socio shows why: cash minus taxes, the next 30 days of bills and salaries, and her safety cushion. |
| 5 | “I spent money” | Recording money takes three taps. 850 for shipping, today. Saved — her cash and forecast update at once. |
| 6 | Coming up | “Coming up” lists every bill, salary and expected payment with its date. Salaries are one line. |
| 7 | Bills & fixed costs | Each employee, their salary, and one pay day for the whole team. |
| 8 | Paid early | Yasmin asked to be paid early. One tap records it — her next salary moves to next month. |
| 9 | Money calendar | What is due each day, and the cash left after it. Red dots = below the safety line. |
| 10 | Tap a day | Tap any day to add what is due — right here, no other page. |
| 11 | Action Center | Socio checks her books every time they change, and finds problems before they cost money. |
| 12 | Tax finding | Part of her cash is VAT that belongs to the tax office. Verified facts, unknowns, and calculated options. |
| 13 | Approvals | Nothing that moves money, shares data or spends on ads happens without her approval. |
| 14 | Financing | Does she need a loan? Socio says how much, by when — and her lender-readiness score. |
| 15 | Offers | Every offer at its true yearly cost. The “only 15% fee” advance is flagged: avoid. |
| 16 | Ask your business | She can simply ask her business. A visible plan, tool calls for real numbers, and an answer. Actions are only proposed. |
| 17 | WhatsApp | A message like “دفعت 500 شحن” (I paid 500 shipping) is recorded instantly. No AI guessing: the same message always records the same thing, only from her own number. |
| 18 | Media buyer | An ad she can afford, written in Egyptian dialect. She approves the exact words before anything is created. It starts paused, needs a second approval to spend, and stops itself if it spends without sales. |
| 19 | Egyptian Arabic | One tap to Egyptian Arabic. Right to left, everyday Egyptian, same numbers. Ask in Arabic, get the answer in Egyptian Arabic. |
| 20 | Money with couriers | NEW: Money with couriers: cash on delivery held by Bosta or Mylerz, counted in her forecast. Late payouts are flagged. |
| 21 | Safety screen | NEW: A safety screen: a request to move money is refused before the AI sees it. 31 of 31 attacks blocked. |
| 22 | Close | Built and tested: 630 automated checks, sandboxed integrations, row-level security, approvals bound to the exact action. |
