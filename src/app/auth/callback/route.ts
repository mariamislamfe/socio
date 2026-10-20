import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/server/auth";

// Supabase email links (confirm / recovery) land here with ?code=…; the code is exchanged for a session cookie.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/app";
  const safe = next.startsWith("/") && !next.startsWith("//") ? next : "/app";
  if (code && (await exchangeCode(code))) return NextResponse.redirect(new URL(safe, url.origin));
  return NextResponse.redirect(new URL("/login?error=link", url.origin));
}
