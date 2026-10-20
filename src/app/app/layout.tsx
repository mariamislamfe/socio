import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app/shell";
import { currentUser } from "@/lib/server/auth";
import { resolveBusiness } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const biz = await resolveBusiness(user.id, (await cookies()).get("margin_biz")?.value);
  if (!biz) redirect("/onboarding");
  return <AppShell>{children}</AppShell>;
}
