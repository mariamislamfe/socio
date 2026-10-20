import "server-only";
import type { CopilotAnswer } from "@/lib/finance/copilot";

export interface AiExplanation {
  status: "unconfigured" | "ok" | "unavailable";
  text?: string;
  model?: string;
}

/**
 * Optional natural-language explanation of an already-computed answer. The model receives only the
 * deterministic facts and is told not to introduce numbers. The core answer never depends on it.
 */
export async function explainWithAi(a: CopilotAnswer, currency: string): Promise<AiExplanation> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { status: "unconfigured" };
  if (a.intent === "unknown" || a.needs) return { status: "unconfigured" };
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(
      `${(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`,
      {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: 400,
          system:
            "You explain a small-business owner's financial figures in plain, friendly language. Use ONLY the facts provided. Never add, estimate or recalculate numbers. If something is uncertain, say so. Keep it under 90 words.",
          messages: [
            {
              role: "user",
              content: JSON.stringify({
                currency,
                title: a.title,
                answer: a.answer,
                facts: a.facts,
                assumptions: a.assumptions,
              }),
            },
          ],
        }),
      },
    );
    clearTimeout(timer);
    if (!res.ok) return { status: "unavailable" };
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((p) => p.type === "text")?.text?.trim();
    return text ? { status: "ok", text, model } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
