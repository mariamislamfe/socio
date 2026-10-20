"use client";
import useSWR, { mutate as globalMutate } from "swr";

export interface Biz {
  id: string;
  name: string;
  currency: string;
  is_demo: boolean;
  country: string;
  setup_mode: string;
  role: "owner" | "admin" | "member" | "viewer";
}
export interface Me {
  user: { id: string; email: string };
  profile: { name: string; email: string; locale: string; theme: string };
  businesses: Biz[];
  active: string | null;
  environment: { auth: string; database: string };
}

export function useMe() {
  const r = useSWR<Me>("/api/me", { revalidateOnFocus: false });
  const biz = r.data?.businesses.find((b) => b.id === r.data?.active) ?? null;
  return { ...r, me: r.data, biz };
}

/* * Re-fetch every active query after a write so every screen reflects the same stored records. */
export function refreshAll() {
  return globalMutate(() => true);
}

export function useAccounts() {
  return useSWR<{
    items: { id: string; name: string; type: string; currency: string; opening_balance: number; archived: boolean }[];
  }>("/api/accounts");
}
export function useCategories() {
  return useSWR<{
    items: {
      id: string;
      name: string;
      kind: "income" | "expense";
      cost_type: string | null;
      parent_id: string | null;
      color: string;
      essential: boolean;
      role: string | null;
      is_system: boolean;
      archived: boolean;
    }[];
  }>("/api/categories");
}
export function usePayees() {
  return useSWR<{ items: { id: string; name: string; kind: string }[] }>("/api/payees");
}
