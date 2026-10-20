"use client";
import { Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Card, clsx, Input, PageHeader } from "@/components/ui";
import { GLOSSARY } from "@/lib/glossary";

export default function LearnPage() {
  const [q, setQ] = useState("");
  const [active, setActive] = useState<string>("");
  const entries = useMemo(
    () =>
      Object.entries(GLOSSARY).filter(([, e]) => {
        const s = q.trim().toLowerCase();
        return !s || `${e.term} ${e.question} ${e.definition}`.toLowerCase().includes(s);
      }),
    [q],
  );
  useEffect(() => {
    const apply = () => {
      const h = decodeURIComponent(window.location.hash.slice(1));
      setActive(h);
      if (h) setTimeout(() => document.getElementById(h)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Learn"
        subtitle="Every term in Socio, explained the way a friend who is good with money would explain it. You never need to know these words in advance."
      />
      <div className="relative max-w-md">
        <Search
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink3"
          aria-hidden
        />
        <Input
          aria-label="Search terms"
          placeholder="Search a term or a question"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="ps-9"
        />
      </div>
      <ul className="grid gap-4 lg:grid-cols-2">
        {entries.map(([k, e]) => (
          <li key={k} id={k} className="scroll-mt-28">
            <Card className={clsx("h-full p-6 transition", active === k && "ring-2 ring-accent")}>
              <p className="eyebrow">{e.term}</p>
              <h2 className="display mt-1 text-2xl leading-snug">“{e.question}”</h2>
              <dl className="mt-4 space-y-3 text-[15px] leading-relaxed">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-ink3">The definition</dt>
                  <dd className="text-ink2">{e.definition}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-ink3">Why it matters</dt>
                  <dd className="text-ink2">{e.why}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-ink3">How Socio calculates it</dt>
                  <dd className="text-ink2">{e.how}</dd>
                </div>
                {e.example && (
                  <div className="rounded-xl bg-sunken px-4 py-3">
                    <dt className="text-xs font-semibold uppercase tracking-wider text-ink3">Example</dt>
                    <dd className="text-ink">{e.example}</dd>
                  </div>
                )}
              </dl>
              {e.related && (
                <p className="mt-4 flex flex-wrap items-center gap-2 text-[13px] text-ink3">
                  Related:
                  {e.related
                    .filter((r) => GLOSSARY[r])
                    .map((r) => (
                      <Link
                        key={r}
                        href={`#${r}`}
                        className="rounded-full bg-sunken px-2.5 py-1 text-ink2 hover:text-accent"
                      >
                        {GLOSSARY[r].term}
                      </Link>
                    ))}
                </p>
              )}
            </Card>
          </li>
        ))}
      </ul>
      {entries.length === 0 && <p className="py-12 text-center text-ink3">No term matches “{q}”.</p>}
    </div>
  );
}
