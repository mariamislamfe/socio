// Authoritative amounts are integers in minor units (e.g. piastres, cents). Never floats.
const digitsCache = new Map<string, number>();
export function currencyDigits(code: string): number {
  let d = digitsCache.get(code);
  if (d === undefined) {
    try {
      d =
        new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      d = 2;
    }
    digitsCache.set(code, d);
  }
  return d;
}

/* * Parse a user-entered decimal string ("1,234.50") into minor units without floating point error. */
export function toMinor(input: string | number, currency: string): number | null {
  const digits = currencyDigits(currency);
  let s = String(input)
    .trim()
    .replace(/[\s,_]/g, "");
  if (s === "") return null;
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (!/^\d*\.?\d*$/.test(s) || s === "." || s === "") return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > digits && /[1-9]/.test(frac.slice(digits))) return null; // would lose precision
  const f = (frac + "0".repeat(digits)).slice(0, digits);
  const v = Number((whole || "0") + f);
  if (!Number.isSafeInteger(v)) return null;
  return neg ? -v : v;
}

export function fromMinor(minor: number, currency: string): number {
  return minor / 10 ** currencyDigits(currency);
}

export function formatMoney(
  minor: number,
  currency: string,
  opts: { compact?: boolean; sign?: boolean; hideCurrency?: boolean; locale?: string } = {},
): string {
  const { compact, sign, hideCurrency, locale = "en" } = opts;
  const digits = currencyDigits(currency);
  const value = minor / 10 ** digits;
  const abs = Math.abs(value);
  const useCompact = compact && abs >= 10_000;
  const num = new Intl.NumberFormat(locale, {
    minimumFractionDigits: useCompact ? 0 : abs >= 1000 ? 0 : digits,
    maximumFractionDigits: useCompact ? 1 : abs >= 1000 ? 0 : digits,
    notation: useCompact ? "compact" : "standard",
  }).format(abs);
  const s = value < 0 ? "−" : sign && value > 0 ? "+" : "";
  return hideCurrency ? `${s}${num}` : `${s}${currency} ${num}`;
}

/* * Round-half-away-from-zero integer multiply by a rational (num/den). */
export function mulDiv(a: number, num: number, den: number): number {
  if (den === 0) return 0;
  const r = (a * num) / den;
  return Math.sign(r) * Math.round(Math.abs(r));
}
/* * Apply a percentage given as a number (e.g. 30 for +30%, -20 for -20%). */
export function pct(a: number, percent: number): number {
  return mulDiv(a, Math.round(percent * 100), 10000);
}
export function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}
