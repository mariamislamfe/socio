"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { LenderPackView } from "@/components/app/lender-pack";
import { Skeleton } from "@/components/ui";
import type { LenderPack } from "@/lib/finance/lenderpack";

interface Shared {
  pack: LenderPack;
  fingerprint: string;
  verified: boolean;
  recipient: string | null;
  expiresAt: string;
}

export default function SharedPack() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error?.message ?? "This link is not available.");
        setData(j);
      })
      .catch((e) => setError(e.message));
  }, [token]);
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
      {error ? (
        <div className="rounded-2xl border border-line bg-surface p-8 text-center">
          <h1 className="display text-2xl">Link not available</h1>
          <p className="mt-2 text-sm text-ink2">{error}</p>
        </div>
      ) : !data ? (
        <Skeleton className="h-96" />
      ) : (
        <LenderPackView
          pack={data.pack}
          fingerprint={data.fingerprint}
          verified={data.verified}
          recipient={data.recipient}
          expiresAt={data.expiresAt}
        />
      )}
      <p className="mt-6 text-center text-xs text-ink3">
        Read-only financing file shared by the business owner. It cannot be edited from this link.
      </p>
    </main>
  );
}
