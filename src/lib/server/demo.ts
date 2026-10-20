import "server-only";
import { addDays, addMonths, startOfMonth, todayISO } from "@/lib/finance/dates";
import { asService, type Q } from "./db";
import { createBusiness } from "./workspace";

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const E = (n: number) => Math.round(n * 100); // EGP → piastres

interface Row {
  type: string;
  date: string;
  amount: number;
  account: string;
  to?: string;
  cat?: string;
  desc: string;
  dir?: string;
  rec?: string;
  payee?: string;
  cogs?: number;
}

/**
 * Creates a clearly labelled demonstration workspace. All records carry source = 'demo' and live in their own
 * business, so they can never be mixed with a real workspace's records.
 */
export async function createDemoWorkspace(userId: string, today = todayISO()): Promise<string> {
  const bizId = await createBusiness(userId, {
    name: "Nile & Co. (demo data)",
    business_type: "fashion",
    country: "EG",
    currency: "EGP",
    stage: "growing",
    channels: ["online_store", "social"],
    has_history: true,
    setup_mode: "demo",
    is_demo: true,
  });
  await asService(async (q) => {
    const r = rng(20260512);
    const cat: Record<string, string> = {};
    for (const c of await q.query<{ id: string; name: string }>("select id,name from categories where business_id=$1", [
      bizId,
    ]))
      cat[c.name] = c.id;

    const acc: Record<string, string> = {};
    for (const [i, a] of (
      [
        ["Bank — CIB", "bank", 60_000],
        ["Cash drawer", "cash", 6_000],
        ["Mobile wallet", "wallet", 9_000],
      ] as const
    ).entries()) {
      const rows = await q.query<{ id: string }>(
        "insert into accounts(business_id,name,type,currency,opening_balance,position) values ($1,$2,$3,'EGP',$4,$5) returning id",
        [bizId, a[0], a[1], E(a[2]), i],
      );
      acc[a[0]] = rows[0].id;
    }
    const BANK = acc["Bank — CIB"],
      CASH = acc["Cash drawer"],
      WALLET = acc["Mobile wallet"];

    const payee: Record<string, string> = {};
    for (const [n, k] of [
      ["Delta Fabrics", "supplier"],
      ["PackPro", "supplier"],
      ["Cairo Concept Store", "customer"],
      ["Boutique Alex", "customer"],
      ["Zamalek Studio (landlord)", "landlord"],
      ["Mona — designer", "contractor"],
      ["Meta Platforms", "platform"],
      ["Shopify", "platform"],
    ] as const) {
      const rows = await q.query<{ id: string }>(
        "insert into payees(business_id,name,kind) values ($1,$2,$3) returning id",
        [bizId, n, k],
      );
      payee[n] = rows[0].id;
    }

    // Recurring schedules: next due is always after today so history and forecast never overlap.
    const nextOn = (day: number) => {
      const here = today.slice(0, 7) + "-" + String(day).padStart(2, "0");
      return here > today ? here : addMonths(here, 1, day);
    };
    const recs: Record<string, string> = {};
    const recDefs = [
      ["Studio rent", "rent", 25_000, "Rent", 1, "Zamalek Studio (landlord)"],
      ["Designer retainer", "freelancer", 12_000, "Freelancers", 15, "Mona — designer"],
      ["Shopify plan", "subscription", 1_900, "Software & subscriptions", 10, "Shopify"],
      ["Email & design tools", "subscription", 2_700, "Software & subscriptions", 20, null],
      ["Utilities", "utilities", 2_300, "Utilities", 12, null],
    ] as const;
    for (const d of recDefs) {
      const rows = await q.query<{ id: string }>(
        `insert into recurring(business_id,name,direction,kind,amount,currency,category_id,account_id,payee_id,frequency,next_due)
         values ($1,$2,'out',$3,$4,'EGP',$5,$6,$7,'monthly',$8) returning id`,
        [bizId, d[0], d[1], E(d[2]), cat[d[3]], BANK, d[5] ? payee[d[5]] : null, nextOn(d[4])],
      );
      recs[d[0]] = rows[0].id;
    }
    // The team: one salary schedule per person, all paid on the 28th.
    const team = [
      ["Ahmed", "Packing & delivery", 9_000],
      ["Yasmin", "Customer service", 8_500],
      ["Karim", "Sewing & production", 10_500],
    ] as const;
    for (const [name, role, pay] of team) {
      const rows = await q.query<{ id: string }>(
        `insert into recurring(business_id,name,direction,kind,amount,currency,category_id,account_id,frequency,next_due,notes)
         values ($1,$2,'out','salary',$3,'EGP',$4,$5,'monthly',$6,$7) returning id`,
        [bizId, name, E(pay), cat["Salaries"], BANK, nextOn(28), role],
      );
      recs[name] = rows[0].id;
    }

    const prods: [string, string, number, number | null, number][] = [
      ["Linen shirt", "NC-101", 1_150, 380, 42],
      ["Wide-leg trousers", "NC-102", 1_350, 470, 31],
      ["Silk scarf", "NC-201", 620, 160, 120],
      ["Leather tote", "NC-301", 2_400, 910, 18],
      ["Canvas bag", "NC-302", 780, null, 64],
      ["Cotton dress", "NC-103", 1_700, 590, 27],
      ["Beaded bracelet", "NC-202", 280, 55, 210],
      ["Gift set", "NC-401", 950, null, 36],
      ["Mini keychain", "NC-501", 120, 70, 300],
    ];
    // Popularity weights for demo order lines (sum need not be 1).
    const weights = [0.22, 0.14, 0.18, 0.06, 0.12, 0.1, 0.12, 0.06, 0];
    const KEYCHAIN = 8;
    const pick = () => {
      let x = r() * weights.reduce((a, w) => a + w, 0);
      for (let k = 0; k < weights.length; k++) if ((x -= weights[k]) <= 0) return k;
      return 0;
    };
    interface DemoOrder {
      ext: string;
      date: string;
      total: number;
      discounts: number;
      refunded: number;
      lines: { k: number; qty: number; total: number }[];
    }
    const demoOrders: DemoOrder[] = [];
    const ORDER_DAYS = 95; // individual orders for the most recent quarter, so True profit and product economics have data

    const rows: Row[] = [];
    const start = addDays(today, -179);
    for (let i = 0; i < 180; i++) {
      const date = addDays(start, i);
      const dow = new Date(date + "T00:00:00Z").getUTCDay();
      const growth = 1 + (i / 180) * 0.18;
      const weekday = [0.95, 0.9, 0.85, 0.9, 1.05, 1.25, 1.2][dow];
      const orders = Math.max(2, Math.round(14.5 * growth * weekday * (0.8 + r() * 0.4)));
      const target = Math.round(orders * (520 + r() * 260));
      let gross = target;
      let placed = orders;
      if (i >= 180 - ORDER_DAYS) {
        // Build the day's orders line by line until the day's sales are reached; the ledger deposit is exactly their sum.
        gross = 0;
        for (placed = 0; gross < target; placed++) {
          const n = placed;
          const lines: DemoOrder["lines"] = [];
          if (r() < 0.12)
            lines.push({ k: KEYCHAIN, qty: 1, total: prods[KEYCHAIN][2] }); // ordered alone
          else {
            const count = r() < 0.7 ? 1 : r() < 0.8 ? 2 : 3;
            for (let l = 0; l < count; l++) {
              const k = pick();
              const qty = r() < 0.85 ? 1 : 2;
              lines.push({ k, qty, total: prods[k][2] * qty });
            }
          }
          const sub = lines.reduce((a, l) => a + l.total, 0);
          const discounts = r() < 0.15 ? Math.round(sub * 0.1) : 0;
          if (discounts) lines[0].total -= discounts;
          demoOrders.push({ ext: `demo-${i}-${n}`, date, total: sub - discounts, discounts, refunded: 0, lines });
          gross += sub - discounts;
        }
      }
      rows.push({
        type: "income",
        date,
        amount: E(gross),
        account: BANK,
        cat: "Online store",
        desc: `Online store — ${placed} orders`,
      });
      if (r() < 0.14)
        rows.push({
          type: "refund",
          date,
          amount: E(350 + Math.round(r() * 900)),
          account: BANK,
          cat: "Online store",
          desc: "Customer refund — returned item",
        });
      if (r() < 0.03)
        rows.push({
          type: "income",
          date,
          amount: E(4_000 + Math.round(r() * 6_000)),
          account: BANK,
          cat: "Wholesale",
          desc: "Wholesale order paid",
        });
      // weekly ad spend, shipping and fees
      if (dow === 1) {
        rows.push({
          type: "expense",
          date,
          amount: E(Math.round((9_500 + Math.round(r() * 3_500) + i * 12) * (i >= 180 - 28 ? 1.8 : 1))),
          account: BANK,
          cat: "Social ads",
          desc: i >= 180 - 28 ? "Meta Ads — weekly spend (new campaign)" : "Meta Ads — weekly spend",
          payee: "Meta Platforms",
        });
        rows.push({
          type: "expense",
          date,
          amount: E(6_000 + Math.round(r() * 2_500)),
          account: BANK,
          cat: "Shipping & delivery",
          desc: "Courier — weekly shipping",
        });
        rows.push({
          type: "expense",
          date,
          amount: E(2_400 + Math.round(r() * 1_100)),
          account: BANK,
          cat: "Payment & platform fees",
          desc: "Payment processor fees",
        });
      }
      if (dow === 3 && r() < 0.5)
        rows.push({
          type: "expense",
          date,
          amount: E(1_200 + Math.round(r() * 2_400)),
          account: CASH,
          cat: "Operations & other",
          desc: "Studio supplies",
        });
    }
    // Monthly items across the six months
    for (let m = -6; m <= 0; m++) {
      const first = startOfMonth(addMonths(today, m));
      const day = (n: number) => addDays(first, n - 1);
      const inRange = (d: string) => d >= start && d <= today;
      const add = (row: Row) => inRange(row.date) && rows.push(row);
      add({
        type: "expense",
        date: day(1),
        amount: E(25_000),
        account: BANK,
        cat: "Rent",
        desc: "Studio rent",
        rec: "Studio rent",
        payee: "Zamalek Studio (landlord)",
      });
      add({
        type: "expense",
        date: day(5),
        amount: E(58_000 + Math.round(r() * 20_000)),
        account: BANK,
        cat: "Inventory & materials",
        desc: "Fabric & materials — Delta Fabrics",
        payee: "Delta Fabrics",
      });
      add({
        type: "expense",
        date: day(6),
        amount: E(4_500 + Math.round(r() * 2_000)),
        account: BANK,
        cat: "Packaging",
        desc: "Boxes & tissue — PackPro",
        payee: "PackPro",
      });
      add({
        type: "expense",
        date: day(10),
        amount: E(1_900),
        account: BANK,
        cat: "Software & subscriptions",
        desc: "Shopify plan",
        rec: "Shopify plan",
        payee: "Shopify",
      });
      add({
        type: "expense",
        date: day(12),
        amount: E(2_150 + Math.round(r() * 300)),
        account: BANK,
        cat: "Utilities",
        desc: "Electricity & internet",
        rec: "Utilities",
      });
      add({
        type: "expense",
        date: day(15),
        amount: E(12_000),
        account: BANK,
        cat: "Freelancers",
        desc: "Designer retainer — Mona",
        rec: "Designer retainer",
        payee: "Mona — designer",
      });
      add({
        type: "expense",
        date: day(20),
        amount: E(2_700),
        account: BANK,
        cat: "Software & subscriptions",
        desc: "Email & design tools",
        rec: "Email & design tools",
      });
      for (const [name, , pay] of team)
        add({
          type: "expense",
          date: day(28),
          amount: E(pay),
          account: BANK,
          cat: "Salaries",
          desc: `Salary — ${name}`,
          rec: name,
        });
      add({ type: "transfer", date: day(3), amount: E(5_000), account: BANK, to: CASH, desc: "Top up cash drawer" });
      add({
        type: "transfer",
        date: day(18),
        amount: E(8_000),
        account: BANK,
        to: WALLET,
        desc: "Move funds to mobile wallet",
      });
    }
    // One deliberately uncategorised expense to demonstrate data-quality prompts
    rows.push({
      type: "expense",
      date: addDays(today, -4),
      amount: E(850),
      account: CASH,
      desc: "Courier tip & parking",
    });

    const valid = rows.filter((x) => x.date <= today);
    for (let i = 0; i < valid.length; i += 150) {
      const chunk = valid.slice(i, i + 150);
      const params: unknown[] = [];
      const vals = chunk.map((x, j) => {
        const b = j * 11;
        params.push(
          bizId,
          x.type,
          x.date,
          x.amount,
          x.account,
          x.to ?? null,
          x.cat ? (cat[x.cat] ?? null) : null,
          x.payee ? (payee[x.payee] ?? null) : null,
          x.desc,
          x.rec ? (recs[x.rec] ?? null) : null,
          x.dir ?? null,
        );
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},'EGP',$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},'demo')`;
      });
      await q.query(
        `insert into transactions(business_id,type,date,amount,currency,account_id,to_account_id,category_id,payee_id,description,recurring_id,direction,source)
         values ${vals.join(",")}`,
        params,
      );
    }

    // Open receivables and payables (drive the cash-flow outlook)
    const inv = async (
      direction: string,
      who: string,
      desc: string,
      number: string,
      amount: number,
      issue: number,
      due: number,
      category: string | null,
      paid = 0,
    ) => {
      const rows2 = await q.query<{ id: string }>(
        `insert into invoices(business_id,direction,payee_id,number,description,amount,currency,issue_date,due_date,category_id)
         values ($1,$2,$3,$4,$5,$6,'EGP',$7,$8,$9) returning id`,
        [
          bizId,
          direction,
          payee[who],
          number,
          desc,
          E(amount),
          addDays(today, issue),
          addDays(today, due),
          category ? cat[category] : null,
        ],
      );
      if (paid > 0)
        await q.query(
          "insert into invoice_payments(business_id,invoice_id,amount,paid_on,account_id) values ($1,$2,$3,$4,$5)",
          [bizId, rows2[0].id, E(paid), addDays(today, due - 14), BANK],
        );
    };
    await inv(
      "receivable",
      "Cairo Concept Store",
      "Wholesale — spring collection",
      "INV-1042",
      64_000,
      -41,
      -9,
      null,
      20_000,
    );
    await inv("receivable", "Boutique Alex", "Wholesale — accessories", "INV-1051", 38_000, -10, 12, null);
    await inv(
      "payable",
      "Delta Fabrics",
      "Fabric order — autumn batch",
      "DF-2208",
      118_000,
      -3,
      15,
      "Inventory & materials",
    );
    await inv("payable", "PackPro", "Packaging restock", "PP-771", 23_500, -6, 5, "Packaging");

    // Cash on delivery still held by couriers: one payout is late, two are on their way.
    const cod = async (
      courier: string,
      orders: number,
      collected: number,
      fees: number,
      delivered: number,
      expected: number,
    ) =>
      q.query(
        `insert into invoices(business_id,direction,description,amount,currency,issue_date,due_date,courier,cod_orders,cod_fees)
         values ($1,'receivable',$2,$3,'EGP',$4,$5,$6,$7,$8)`,
        [
          bizId,
          `COD · ${courier} · ${orders} orders delivered ${addDays(today, delivered)}`,
          E(collected - fees),
          addDays(today, delivered),
          addDays(today, expected),
          courier,
          orders,
          E(fees),
        ],
      );
    await cod("Mylerz", 14, 9_800, 840, -16, -9);
    await cod("Bosta", 9, 6_900, 700, -3, 17);
    await cod("J&T Express", 6, 4_750, 400, -2, 19);

    // Meta Ads metrics (kept apart from transactions to avoid double counting)
    const camps = [
      ["cmp_1", "Spring collection — prospecting", 2.4],
      ["cmp_2", "Retargeting — cart abandoners", 4.1],
      ["cmp_3", "Influencer boost", 1.6],
    ] as const;
    const adRows: unknown[][] = [];
    for (let i = 0; i < 90; i++) {
      const date = addDays(today, -89 + i);
      for (const [id, name, roas] of camps) {
        const spend = E(id === "cmp_2" ? 350 + r() * 250 : id === "cmp_1" ? 900 + r() * 500 : 280 + r() * 260);
        const clicks = Math.round((spend / 100) * (0.9 + r() * 0.5));
        adRows.push([
          bizId,
          "meta_ads",
          "demo_act",
          id,
          name,
          date,
          spend,
          clicks * 38,
          clicks,
          Math.round(clicks * (0.02 + r() * 0.02)),
          Math.round(spend * roas * (0.85 + r() * 0.3)),
        ]);
      }
    }
    for (let i = 0; i < adRows.length; i += 100) {
      const chunk = adRows.slice(i, i + 100);
      const params = chunk.flat();
      const vals = chunk.map(
        (_, j) => `(${Array.from({ length: 11 }, (_, k) => `$${j * 11 + k + 1}`).join(",")},'EGP')`,
      );
      await q.query(
        `insert into ad_metrics(business_id,provider,account_id,campaign_id,campaign_name,date,spend,impressions,clicks,conversions,attributed_revenue,currency) values ${vals.join(",")}`,
        params,
      );
    }

    // Budgets, goals, products
    const bud: [string, number][] = [
      ["Marketing & advertising", 52_000],
      ["Inventory & materials", 85_000],
      ["Salaries", 30_000],
      ["Rent", 25_000],
      ["Shipping & delivery", 30_000],
      ["Software & subscriptions", 6_000],
      ["Utilities", 3_000],
    ];
    for (const [i, [n, a]] of bud.entries())
      await q.query(
        "insert into budgets(business_id,category_id,period,amount,position) values ($1,$2,'monthly',$3,$4)",
        [bizId, cat[n], E(a), i],
      );

    const goal = async (
      type: string,
      name: string,
      target: number,
      mode = "manual",
      cov: number | null = null,
      date: string | null = null,
    ) =>
      (
        await q.query<{ id: string }>(
          "insert into goals(business_id,type,name,target,mode,coverage_months,period,target_date) values ($1,$2,$3,$4,$5,$6,'monthly',$7) returning id",
          [bizId, type, name, E(target), mode, cov, date],
        )
      )[0].id;
    const reserve = await goal("reserve", "Emergency reserve", 0, "essentials", 3, addDays(today, 180));
    await q.query(
      "insert into goal_contributions(business_id,goal_id,amount,made_on,note) values ($1,$2,$3,$4,'Initial buffer'),($1,$2,$5,$6,'Month-end top-up')",
      [bizId, reserve, E(40_000), addDays(today, -90), E(15_000), addDays(today, -30)],
    );
    await goal("revenue", "Monthly revenue", 300_000);
    await goal("profit", "Monthly profit", 45_000);

    for (const p of prods)
      await q.query(
        "insert into products(business_id,name,sku,price,unit_cost,stock,source,external_id) values ($1,$2,$3,$4,$5,$6,'demo',$7)",
        [bizId, p[0], p[1], E(p[2]), p[3] === null ? null : E(p[3]), p[4], `demo-${p[1]}`],
      );

    // Demo orders (provider/source 'demo'); line unit costs come from the product catalogue, so missing costs stay missing.
    for (let i = 0; i < demoOrders.length; i += 200) {
      const chunk = demoOrders.slice(i, i + 200);
      const params: unknown[] = [];
      const vals = chunk.map((o, j) => {
        const b = j * 7;
        params.push(
          bizId,
          o.ext,
          o.ext.replace("demo-", "#D"),
          o.date,
          E(o.total),
          E(o.discounts),
          E(o.total + o.discounts),
        );
        return `($${b + 1},'demo',$${b + 2},$${b + 3},($${b + 4}::date + time '12:00') at time zone 'UTC',$${b + 4}::date,'paid','EGP',$${b + 7},$${b + 6},$${b + 5},'demo')`;
      });
      const ids = await q.query<{ id: string; external_id: string }>(
        `insert into orders(business_id,provider,external_id,name,placed_at,local_date,financial_status,currency,subtotal,discounts,total,source)
         values ${vals.join(",")} returning id, external_id`,
        params,
      );
      const idOf = new Map(ids.map((x) => [x.external_id, x.id]));
      const lp: unknown[] = [];
      const lv: string[] = [];
      for (const o of chunk)
        o.lines.forEach((l, n) => {
          const b = lp.length;
          const p = prods[l.k];
          lp.push(bizId, idOf.get(o.ext), `${o.ext}-${n}`, `demo-${p[1]}`, p[0], p[1], l.qty, E(p[2]), E(l.total));
          lv.push(
            `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 7},$${b + 8},$${b + 9})`,
          );
        });
      await q.query(
        `insert into order_lines(business_id,order_id,external_id,variant_external_id,title,sku,quantity,current_quantity,unit_price,discounted_total) values ${lv.join(",")}`,
        lp,
      );
    }

    await q.query(
      "update businesses set onboarding = $2::text::jsonb, settings = settings || $3::text::jsonb where id = $1",
      [
        bizId,
        JSON.stringify({ done: ["account", "transaction", "budget", "goal"] }),
        JSON.stringify({
          vatRegistered: true,
          safetyReserve: E(570_000),
          taxProfile: {
            commercialRegister: "yes",
            taxCard: "yes",
            etaPortal: "yes",
            vatRegistered: "yes",
            simplifiedRegime: "no",
            eInvoicing: "in_progress",
            updatedAt: new Date().toISOString(),
          },
        }),
      ],
    );

    // Financing offers for the demo (clearly labelled): a fair supplier extension, a bank line, an expensive revenue
    // advance whose "15% fee" hides a very high annual cost, and an offer with the classic signs of a lending scam.
    const offers: [
      string,
      string,
      number,
      number,
      number | null,
      number | null,
      number,
      string,
      number | null,
      Record<string, boolean>,
      string,
    ][] = [
      [
        "Delta Fabrics — pay 30 days later (demo)",
        "supplier_credit",
        118_000,
        0,
        null,
        2_360,
        30,
        "bullet",
        null,
        {},
        "Supplier agrees to defer the autumn fabric order; you lose the 2% early-payment discount.",
      ],
      [
        "Bank overdraft line (demo terms)",
        "overdraft",
        150_000,
        750,
        24,
        null,
        90,
        "bullet",
        null,
        {},
        "Indicative demo terms, not a real quote.",
      ],
      [
        "QuickCash revenue advance (demo)",
        "revenue_advance",
        150_000,
        0,
        null,
        22_500,
        60,
        "daily_sales",
        15,
        { pressureToSignToday: true },
        '"Only 15% fee, money in 24 hours."',
      ],
      [
        "Instant business loan via WhatsApp (demo)",
        "term_loan",
        200_000,
        5_000,
        18,
        null,
        180,
        "monthly",
        null,
        { upfrontPaymentRequested: true, personalAccountPayment: true, guaranteedApproval: true, notLicensed: true },
        'Asked for a 5,000 "insurance fee" to a mobile wallet before releasing the loan.',
      ],
    ];
    for (const o of offers)
      await q.query(
        `insert into financing_offers(business_id,lender,kind,amount,upfront_fee,rate_pct,flat_fee,term_days,repayment,revenue_share_pct,flags,notes,source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12,'demo')`,
        [
          bizId,
          o[0],
          o[1],
          E(o[2]),
          E(o[3]),
          o[4],
          o[5] === null ? null : E(o[5]),
          o[6],
          o[7],
          o[8],
          JSON.stringify(o[9]),
          o[10],
        ],
      );
  });
  return bizId;
}

export async function deleteBusiness(q: Q, id: string) {
  await q.query("delete from businesses where id = $1", [id]);
}
