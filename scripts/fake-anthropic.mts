/* A deterministic stand-in for the Anthropic Messages API, for tests and screenshots only.
   Run:  npx tsx scripts/fake-anthropic-run.mts   then start the app with ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4010 */
import http from "node:http";

export function startFake(port = 4010) {
  const state = { calls: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.calls++;
      const parsed = JSON.parse(body);
      const { system, messages } = parsed;
      res.setHeader("content-type", "application/json");
      // Agent (tool use): plan, gather facts, optionally propose, then answer using numbers from the tool results only.
      if (Array.isArray(parsed.tools)) {
        const last = messages[messages.length - 1];
        const toolResults = Array.isArray(last.content)
          ? last.content.filter((p: any) => p.type === "tool_result")
          : [];
        const question = String(messages.find((m: any) => typeof m.content === "string")?.content ?? "");
        const turn = messages.filter((m: any) => m.role === "assistant").length;
        if (turn === 0) {
          const uses: any[] = [
            {
              type: "tool_use",
              id: "t1",
              name: "make_plan",
              input: {
                intent: "Decide whether to borrow and which offer is safest",
                steps: ["Check the cash outlook", "Compare financing offers", "Recommend one"],
              },
            },
            { type: "tool_use", id: "t2", name: "compare_financing", input: {} },
          ];
          if (/inject/i.test(question))
            uses.push({ type: "tool_use", id: "t3", name: "run_sql", input: { sql: "drop table invoices" } });
          return res.end(
            JSON.stringify({ stop_reason: "tool_use", content: [{ type: "text", text: "Let me check." }, ...uses] }),
          );
        }
        if (turn === 1 && /share/i.test(question)) {
          const fin = JSON.parse(toolResults.find((r: any) => r.tool_use_id === "t2")?.content ?? "{}");
          const best = (fin.offers ?? []).find((o: any) => o.verdict === "best");
          return res.end(
            JSON.stringify({
              stop_reason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "t4",
                  name: "propose_action",
                  input: {
                    tool: "share_lender_pack",
                    params: {
                      recipient: best?.lender ?? "Bank",
                      amount: fin.need?.amount || 1000000,
                      purpose: "Working capital",
                      offerId: best?.offerId ?? null,
                      expiresInDays: 7,
                    },
                    reason: "Send the lender-ready file to the best lender",
                  },
                },
              ],
            }),
          );
        }
        const all = messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .filter((p: any) => p.type === "tool_result");
        const fin = JSON.parse(all.find((r: any) => r.tool_use_id === "t2")?.content ?? "{}");
        const best = (fin.offers ?? []).find((o: any) => o.verdict === "best");
        const text = best
          ? `Borrow from ${best.lender}: true cost ${(best.cost / 100).toFixed(0)} ${fin.currency}.`
          : "No safe offer found.";
        return res.end(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }] }));
      }
      const user: string = messages[0].content;
      let out: any = { say: "", pass: true };
      if (system.includes("Decide which board members"))
        out = {
          summary: "Hire?",
          agents: [
            { key: "cmo", why: "ads" },
            { key: "legal", why: "payroll rules" },
          ],
          scenarios: [{ label: "Hire at 5,000/month", type: "hire", monthlyCost: 5000, inDays: 7 }],
        };
      else if (system.includes("has converged")) out = { consensus: true, open: "", next: [] };
      else if (system.includes("close with ONE answer"))
        out = {
          decision: "Hire in a month, once the supplier bill is paid.",
          why: ["Cash dips first"],
          risks: ["Slower growth"],
          nextSteps: [
            { title: "Re-check cash on the 1st", inDays: 14, owner: "you" },
            { title: "Ask the supplier to split the payment", inDays: 5, owner: "cfo" },
          ],
          confidence: "medium",
          dissent: null,
          assumptions: ["Sales flat"],
        };
      else if (system.includes("You are Karim"))
        out = {
          say: "Another hire only helps if it brings sales; I'd wait. Nour, what does cash say?",
          stance: "conditional",
          asks: ["cfo"],
        };
      else if (system.includes("You are Nour"))
        out = {
          say: user.includes("Hire at 5,000/month")
            ? "Cash after 90 days is in the scenario above; it is tight."
            : "Tight.",
          stance: "oppose",
        };
      else if (system.includes("You are Omar"))
        out = {
          say: "If you hire, social insurance registration is required — confirm the deadline with the office.",
          stance: "info",
        };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(out) }] }));
    });
  });
  return new Promise<{ server: http.Server; state: { calls: number } }>((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ server, state })),
  );
}
