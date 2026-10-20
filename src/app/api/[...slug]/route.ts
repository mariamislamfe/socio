import { NextResponse } from "next/server";
import { coreRoutes } from "@/lib/server/routes/core";
import { ledgerRoutes } from "@/lib/server/routes/ledger";
import { planningRoutes } from "@/lib/server/routes/planning";
import { analyticsRoutes } from "@/lib/server/routes/analytics";
import { integrationRoutes } from "@/lib/server/routes/integrations";
import { healthRoutes } from "@/lib/server/routes/health";
import { brainRoutes } from "@/lib/server/routes/brain";
import { financingRoutes } from "@/lib/server/routes/financing";
import { mediaBuyerRoutes } from "@/lib/server/routes/mediabuyer";
import { simpleRoutes } from "@/lib/server/routes/simple";
import { specialRoutes } from "@/lib/server/routes/specials";
import { fixedRoutes } from "@/lib/server/routes/fixed";
import type { Route } from "@/lib/server/routes/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const routes: Route[] = [
  ...coreRoutes,
  ...ledgerRoutes,
  ...planningRoutes,
  ...analyticsRoutes,
  ...integrationRoutes,
  ...healthRoutes,
  ...brainRoutes,
  ...financingRoutes,
  ...mediaBuyerRoutes,
  ...simpleRoutes,
  ...fixedRoutes,
  ...specialRoutes,
];

function match(method: string, path: string) {
  const segs = path.split("/").filter(Boolean);
  // Static patterns win over parameterised ones (e.g. transactions/bulk vs transactions/:id).
  const candidates = routes
    .filter(([m]) => m === method)
    .map(([, pattern, handler]) => ({ pattern, handler, parts: pattern.split("/") }))
    .filter((r) => r.parts.length === segs.length)
    .sort((a, b) => a.parts.filter((p) => p.startsWith(":")).length - b.parts.filter((p) => p.startsWith(":")).length);
  for (const r of candidates) {
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i++) {
      if (r.parts[i].startsWith(":")) params[r.parts[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (r.parts[i] !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

async function dispatch(req: Request, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params;
  const m = match(req.method, slug.join("/"));
  if (!m) return NextResponse.json({ error: { code: "not_found", message: "Unknown endpoint." } }, { status: 404 });
  return m.handler(req, { params: Promise.resolve(m.params) });
}

export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
export const PUT = dispatch;
export const DELETE = dispatch;
