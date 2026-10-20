/* A stand-in for the WhatsApp Cloud API (tests and screenshots only; nothing reaches WhatsApp).
   Start the app with WHATSAPP_TOKEN=test WHATSAPP_PHONE_NUMBER_ID=123 WHATSAPP_API_BASE=http://127.0.0.1:4030 */
import http from "node:http";

export interface SentMessage {
  to: string;
  template: string;
  lang: string;
  params: string[];
  text?: string;
  auth: string | undefined;
}

export function startFakeWhatsApp(port = 4030) {
  const state = { sent: [] as SentMessage[], fail: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (!/\/v\d+\.\d+\/\d+\/messages$/.test(req.url ?? "") || req.method !== "POST") {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: { message: "Unknown path" } }));
      }
      if (req.headers.authorization !== "Bearer test") {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: "Invalid OAuth access token." } }));
      }
      if (state.fail) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: "Template not approved" } }));
      }
      const j = JSON.parse(body);
      state.sent.push({
        to: j.to,
        template: j.template?.name,
        lang: j.template?.language?.code,
        params: (j.template?.components?.[0]?.parameters ?? []).map((p: any) => p.text),
        text: j.text?.body,
        auth: req.headers.authorization,
      });
      res.end(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: j.to, wa_id: j.to }],
          messages: [{ id: `wamid.FAKE${state.sent.length}` }],
        }),
      );
    });
  });
  return new Promise<{ server: http.Server; state: typeof state }>((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ server, state })),
  );
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("fake-whatsapp.mts")
) {
  const { state } = await startFakeWhatsApp(Number(process.env.PORT ?? 4030));
  console.log("fake WhatsApp API on http://127.0.0.1:4030");
  setInterval(() => state.sent.length && console.log(`sent: ${state.sent.length}`), 10_000).unref();
}
