/* A stand-in for the Meta Graph / Marketing API (tests only - no real ad is created and nothing is spent).
   Start the app with META_APP_ID=test_meta META_APP_SECRET=test_meta_secret META_API_BASE=http://127.0.0.1:4040
   META_SCOPES=ads_read,ads_management,pages_show_list,pages_manage_ads */
import http from "node:http";

export function startFakeMeta(port = 4040) {
  const state = {
    created: [] as { kind: string; body: any }[],
    objects: new Map<string, any>(),
    insights: { spend: "0", clicks: "0", impressions: "0", actions: undefined as any, action_values: undefined as any },
    seq: 1,
  };
  const TOKEN = "meta_long_token";
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const u = new URL(req.url ?? "/", "http://x");
      const path = u.pathname.replace(/^\/v\d+\.\d+\//, "");
      const send = (code: number, j: unknown) => ((res.statusCode = code), res.end(JSON.stringify(j)));
      if (path === "oauth/access_token") {
        if (u.searchParams.get("client_secret") !== "test_meta_secret")
          return send(400, { error: { message: "bad secret" } });
        return send(200, { access_token: TOKEN, expires_in: 5_184_000 });
      }
      if (u.searchParams.get("access_token") !== TOKEN)
        return send(401, { error: { message: "Invalid OAuth access token.", code: 190 } });
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "GET" && path === "me/adaccounts")
        return send(200, { data: [{ id: "act_123", name: "Test ad account", currency: "EGP" }] });
      if (req.method === "GET" && path === "me/accounts")
        return send(200, { data: [{ id: "page_1", name: "Test page" }] });
      if (req.method === "GET" && path === "search")
        return send(200, { data: [{ id: `600${state.seq++}`, name: u.searchParams.get("q") }] });
      if (req.method === "GET" && path === "act_123/insights") return send(200, { data: [] });
      const make = path.match(/^act_123\/(campaigns|adsets|adcreatives|ads)$/);
      if (req.method === "POST" && make) {
        if (make[1] === "campaigns" && !Array.isArray(body.special_ad_categories))
          return send(400, { error: { message: "special_ad_categories is required" } });
        if ((make[1] === "campaigns" || make[1] === "adsets" || make[1] === "ads") && body.status !== "PAUSED")
          return send(400, { error: { message: "test fake: objects must be created PAUSED" } });
        const id = `${make[1]}_${state.seq++}`;
        state.created.push({ kind: make[1], body });
        state.objects.set(id, { ...body, status: body.status ?? "ACTIVE" });
        return send(200, { id });
      }
      const ins = path.match(/^([\w]+)\/insights$/);
      if (req.method === "GET" && ins) return send(200, { data: [state.insights] });
      const obj = state.objects.get(path);
      if (obj && req.method === "POST") {
        Object.assign(obj, body);
        return send(200, { success: true });
      }
      if (obj && req.method === "GET")
        return send(200, { id: path, status: obj.status, daily_budget: obj.daily_budget });
      send(404, { error: { message: `unknown ${req.method} ${path}` } });
    });
  });
  return new Promise<{ server: http.Server; state: typeof state }>((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ server, state })),
  );
}
