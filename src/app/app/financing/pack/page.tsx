"use client";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import useSWR from "swr";
import { LenderPackView } from "@/components/app/lender-pack";
import { ErrorNote, Skeleton } from "@/components/ui";
import type { LenderPack } from "@/lib/finance/lenderpack";

function Inner() {
  const sp = useSearchParams();
  const qs = new URLSearchParams();
  if (sp.get("amount")) qs.set("amount", sp.get("amount")!);
  qs.set("purpose", sp.get("purpose") || "Working capital");
  if (sp.get("offerId")) qs.set("offerId", sp.get("offerId")!);
  const { data, error, mutate } = useSWR<{ pack: LenderPack; fingerprint: string }>(`/api/financing/pack?${qs}`);
  if (error) return <ErrorNote error={error} onRetry={() => mutate()} />;
  if (!data) return <Skeleton className="h-96" />;
  return (
    <div className="space-y-4">
      <Link href="/app/financing" className="inline-flex items-center gap-1.5 text-sm text-accent print:hidden">
        <ArrowLeft className="size-4" aria-hidden /> Back to financing
      </Link>
      <LenderPackView pack={data.pack} fingerprint={data.fingerprint} preview />
    </div>
  );
}

export default function PackPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Inner />
    </Suspense>
  );
}
