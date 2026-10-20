// True profit: a profit "ladder" from sales to what the business keeps, plus product-level economics.
// Deterministic; every line states its source and whether it is complete. Missing costs are never assumed to be zero.
import { descendants, summarize, type Cat, type Txn } from "./engine";
import type { Range } from "./dates";
import type { AdDay } from "./snapshot";
import { mulDiv } from "./money";

export interface OrderRow {
  id: string;
  local_date: string;
  currency: string;
  cancelled_at: string | null;
  is_test: boolean;
  total: number;
  tax: number;
  shipping: number;
  discounts: number;
  refunded: number;
}
export interface LineRow {
  order_id: string;
  variant_external_id: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  current_quantity: number;
  discounted_total: number;
  unit_cost: number | null;
}
export interface ProductCost {
  external_id: string | null;
  name: string;
  unit_cost: number | null;
}

/* * Explicit, owner-entered assumptions for costs that are not in the ledger. Absent = not applied. */
export interface VariableCostAssumptions {
  paymentFeeBps?: number | null; // e.g. 290 = 2.9% of order value
  paymentFeeFixed?: number | null; // per order, minor units
  packagingPerOrder?: number | null;
  shippingPerOrder?: number | null;
}

export interface LadderLine {
  key: string;
  label: string;
  amount: number | null;
  sign: 1 | -1 | 0; // 0 = subtotal
  source: string;
  complete: boolean;
  note?: string;
}

export interface ProductEconomics {
  key: string;
  title: string;
  sku: string | null;
  units: number;
  revenue: number;
  cogs: number | null;
  variableCosts: number;
  contribution: number | null;
  margin: number | null;
  costKnown: boolean;
}

export interface ProfitReport {
  range: Range;
  currency: string;
  ladder: LadderLine[];
  netProfit: number | null;
  missing: string[];
  products: ProductEconomics[];
  orders: number;
  hasOrders: boolean;
}

export function profitReport(args: {
  range: Range;
  currency: string;
  txns: Txn[];
  cats: Cat[];
  orders: OrderRow[];
  lines: LineRow[];
  products: ProductCost[];
  ads: AdDay[];
  assumptions: VariableCostAssumptions;
}): ProfitReport {
  const { range, currency, txns, cats, assumptions } = args;
  const s = summarize(txns, cats, currency, range);
  const missing: string[] = [];
  const roleIds = (role: string) =>
    new Set(cats.filter((c) => c.role === role).flatMap((c) => [...descendants(cats, c.id)]));
  const feeCat = new Set(cats.filter((c) => /fee/i.test(c.name)).flatMap((c) => [...descendants(cats, c.id)]));
  const spendIn = (ids: Set<string>) =>
    txns
      .filter(
        (t) =>
          t.type === "expense" &&
          t.currency === currency &&
          t.date >= range.from &&
          t.date <= range.to &&
          t.category_id &&
          ids.has(t.category_id),
      )
      .reduce((a, t) => a + t.amount, 0);
  const adsIds = roleIds("ads");
  const shipIds = roleIds("shipping");
  const ledgerAds = spendIn(adsIds);
  const ledgerShipping = spendIn(shipIds);
  const ledgerFees = spendIn(feeCat);

  const orders = args.orders.filter(
    (o) =>
      o.currency === currency &&
      !o.is_test &&
      !o.cancelled_at &&
      o.local_date >= range.from &&
      o.local_date <= range.to,
  );
  const orderIds = new Set(orders.map((o) => o.id));
  const lines = args.lines.filter((l) => orderIds.has(l.order_id));
  const costByVariant = new Map(args.products.filter((p) => p.external_id).map((p) => [p.external_id!, p.unit_cost]));
  const lineCost = (l: LineRow) =>
    l.unit_cost ?? (l.variant_external_id ? (costByVariant.get(l.variant_external_id) ?? null) : null);

  // Cost of goods: recorded in the ledger wins; otherwise estimate from order lines with known unit costs.
  let cogs: number | null = s.cogs > 0 ? s.cogs : null;
  let cogsSource = "Expenses in cost-of-goods categories";
  if (cogs === null && lines.length) {
    const known = lines.filter((l) => lineCost(l) !== null);
    if (known.length === lines.length) {
      cogs = known.reduce((a, l) => a + (lineCost(l) ?? 0) * l.current_quantity, 0);
      cogsSource = "Estimated from order lines × product unit costs";
    } else {
      missing.push(`${lines.length - known.length} order line(s) have products without a unit cost.`);
    }
  }
  if (cogs === null && s.revenue > 0)
    missing.push("No cost of goods: add product unit costs or record inventory purchases.");

  // Variable costs: ledger first; owner assumptions only where the ledger has nothing (never both).
  const nOrders = orders.length;
  const orderValue = orders.reduce((a, o) => a + o.total, 0);
  let fees = ledgerFees;
  let feeSource = "Payment & platform fee expenses";
  if (!fees && (assumptions.paymentFeeBps || assumptions.paymentFeeFixed) && nOrders) {
    fees = mulDiv(orderValue, assumptions.paymentFeeBps ?? 0, 10_000) + (assumptions.paymentFeeFixed ?? 0) * nOrders;
    feeSource = "Your assumption × orders (no fee expenses recorded)";
  }
  let shipping = ledgerShipping;
  let shipSource = "Shipping expenses";
  if (!shipping && assumptions.shippingPerOrder && nOrders) {
    shipping = assumptions.shippingPerOrder * nOrders;
    shipSource = "Your assumption × orders (no shipping expenses recorded)";
  }
  const packaging =
    assumptions.packagingPerOrder &&
    nOrders &&
    !cats.some((c) => /packag/i.test(c.name) && spendIn(new Set([c.id])) > 0)
      ? assumptions.packagingPerOrder * nOrders
      : 0;
  if (!fees && nOrders) missing.push("Payment fees are not recorded and no fee assumption is set.");

  // Advertising: ledger expenses if recorded; otherwise platform-reported spend. Never both.
  const platformAds = args.ads
    .filter((a) => a.currency === currency && a.date >= range.from && a.date <= range.to)
    .reduce((x, a) => x + a.spend, 0);
  const ads = ledgerAds || platformAds;
  const adSource = ledgerAds
    ? "Advertising expenses in your ledger"
    : platformAds
      ? "Spend reported by the ad platform (not in your ledger)"
      : "None recorded";

  const gross = cogs === null ? null : s.revenue - cogs;
  const variable = fees + shipping + packaging;
  const contribution = gross === null ? null : gross - variable - ads;
  // Remaining operating costs exclude what was already counted above (no double subtraction).
  const otherOpex = Math.max(0, s.opex - (ledgerAds + ledgerShipping + ledgerFees));
  const operating = contribution === null ? null : contribution - otherOpex;
  const netProfit = operating;

  const ladder: LadderLine[] = [
    {
      key: "revenue",
      label: "Sales revenue",
      amount: s.revenue,
      sign: 1,
      source: "Income recorded, minus customer refunds",
      complete: true,
    },
    {
      key: "cogs",
      label: "Cost of goods sold",
      amount: cogs,
      sign: -1,
      source: cogs === null ? "Missing" : cogsSource,
      complete: cogs !== null,
    },
    {
      key: "gross",
      label: "Gross profit",
      amount: gross,
      sign: 0,
      source: "Revenue − cost of goods",
      complete: gross !== null,
    },
    {
      key: "fees",
      label: "Payment fees",
      amount: fees,
      sign: -1,
      source: fees ? feeSource : "None recorded",
      complete: fees > 0 || nOrders === 0,
    },
    {
      key: "shipping",
      label: "Shipping & fulfilment",
      amount: shipping + packaging,
      sign: -1,
      source: shipping || packaging ? `${shipSource}${packaging ? " + packaging assumption" : ""}` : "None recorded",
      complete: true,
    },
    { key: "ads", label: "Advertising", amount: ads, sign: -1, source: adSource, complete: true },
    {
      key: "contribution",
      label: "Contribution profit",
      amount: contribution,
      sign: 0,
      source: "Gross profit − variable costs − advertising",
      complete: contribution !== null,
    },
    {
      key: "opex",
      label: "Other operating costs",
      amount: otherOpex,
      sign: -1,
      source: "Rent, salaries, software and other expenses",
      complete: true,
    },
    {
      key: "operating",
      label: "Operating profit",
      amount: operating,
      sign: 0,
      source: "Contribution − other operating costs",
      complete: operating !== null,
    },
  ];

  // Product economics from order lines.
  const byKey = new Map<string, ProductEconomics & { _orders: Set<string> }>();
  // Units per order: shipping and packaging are paid per parcel, so they are split by items, not by price.
  const orderUnits = new Map<string, number>();
  for (const l of lines) orderUnits.set(l.order_id, (orderUnits.get(l.order_id) ?? 0) + l.current_quantity);
  for (const l of lines) {
    const key = l.variant_external_id ?? l.sku ?? l.title;
    const p = byKey.get(key) ?? {
      key,
      title: l.title,
      sku: l.sku,
      units: 0,
      revenue: 0,
      cogs: 0 as number | null,
      variableCosts: 0,
      contribution: null,
      margin: null,
      costKnown: true,
      _orders: new Set<string>(),
    };
    const qty = l.current_quantity;
    const rev = l.quantity > 0 ? mulDiv(l.discounted_total, qty, l.quantity) : 0;
    p.units += qty;
    p.revenue += rev;
    const uc = lineCost(l);
    if (uc === null) p.costKnown = false;
    else if (p.cogs !== null) p.cogs += uc * qty;
    // Variable costs: payment fees follow the line's share of all order value; shipping and packaging follow its share
    // of the items in its parcel.
    const ou = orderUnits.get(l.order_id) ?? 0;
    if (nOrders) {
      if (orderValue > 0) p.variableCosts += Math.round((fees * rev) / orderValue); // fees are a share of order value
      if (ou > 0) p.variableCosts += Math.round((((shipping + packaging) / nOrders) * qty) / ou);
    }
    p._orders.add(l.order_id);
    byKey.set(key, p);
  }
  const products = [...byKey.values()]
    .map(({ _orders, ...p }) => {
      const cogsP = p.costKnown ? p.cogs : null;
      const contributionP = cogsP === null ? null : p.revenue - cogsP - p.variableCosts;
      return {
        ...p,
        cogs: cogsP,
        contribution: contributionP,
        margin: contributionP === null || p.revenue <= 0 ? null : contributionP / p.revenue,
      };
    })
    .sort((a, b) => (b.contribution ?? -Infinity) - (a.contribution ?? -Infinity) || b.revenue - a.revenue);

  return { range, currency, ladder, netProfit, missing, products, orders: nOrders, hasOrders: args.orders.length > 0 };
}
