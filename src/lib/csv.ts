// Minimal RFC 4180 CSV parsing/serialising, shared by client preview and server import.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  // Detect delimiter from the first line.
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? "" : String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s) && typeof v === "string" && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

export interface CsvMapping {
  date: number;
  description: number;
  amount?: number;
  debit?: number;
  credit?: number;
  category?: number;
}

export function detectMapping(header: string[]): Partial<CsvMapping> {
  const norm = header.map((h) => h.trim().toLowerCase());
  const find = (...names: string[]) => {
    const i = norm.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    return i >= 0 ? i : undefined;
  };
  return {
    date: find("date", "تاريخ", "posted"),
    description: find("description", "memo", "details", "narration", "payee", "name", "بيان"),
    amount: find("amount", "value", "المبلغ"),
    debit: find("debit", "withdrawal", "money out", "paid out"),
    credit: find("credit", "deposit", "money in", "paid in"),
    category: find("category", "فئة"),
  };
}

/* * Parse a date cell to YYYY-MM-DD. Accepts ISO, D/M/Y (default) or M/D/Y. Returns null if unparseable. */
export function parseDateCell(s: string, dayFirst = true): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))) {
    const a = Number(m[1]),
      b = Number(m[2]);
    y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    [d, mo] = dayFirst ? [a, b] : [b, a];
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}
