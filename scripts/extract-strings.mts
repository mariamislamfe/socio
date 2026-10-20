/* Collects user-visible English strings from the UI source, for the Egyptian Arabic dictionary.
   Run: npx tsx scripts/extract-strings.mts > strings.json */
import fs from "node:fs";
import path from "node:path";

const roots = ["src/app", "src/components"];
const files: string[] = [];
const walk = (d: string) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".tsx")) files.push(p);
  }
};
roots.forEach(walk);

const out = new Set<string>();
const looksEnglish = (s: string) =>
  /[A-Za-z]{2,}/.test(s) &&
  !/^[a-z0-9_.:/#@-]+$/.test(s) &&
  !/(^|\s)(text|bg|px|py|mt|mb|flex|grid|rounded|border|size|gap|items|justify|font|w|h|min|max|space|divide|ring|shadow|hover|focus|sm|md|lg|dark|tracking|leading|truncate|inline|block|hidden|absolute|relative|overflow|opacity|transition|z|top|left|right|bottom|inset|ms|me|ps|pe|start|end|shrink|grow|basis|col|row|order|place|self|content|object|aspect|select|cursor|pointer|fill|stroke|underline|uppercase|italic|num|fig|display|eyebrow|sr)-/.test(
    s,
  ) &&
  !/^(use client|server-only|next\/|@\/|\.\/|https?:)/.test(s) &&
  !/^[A-Z_]+$/.test(s) &&
  !/[{}<>]|=>|\(\)|\.tsx?$/.test(s);
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  // JSX text: >Some text< (no braces)
  for (const m of src.matchAll(/>\s*([^<>{}\n][^<>{}]*?)\s*</g)) {
    const t = m[1].replace(/\s+/g, " ").trim();
    if (t.length > 1 && looksEnglish(t)) out.add(t);
  }
  // String literals in quotes
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.){2,300})"/g)) {
    const t = m[1].trim();
    if (looksEnglish(t) && /\s|^[A-Z]/.test(t)) out.add(t);
  }
  // Template literals without expressions
  for (const m of src.matchAll(/`([^`$\n]{3,300})`/g)) {
    const t = m[1].trim();
    if (looksEnglish(t) && /\s/.test(t)) out.add(t);
  }
}
console.log(JSON.stringify([...out].sort(), null, 0));
