import "server-only";

export class LlmUnavailable extends Error {
  constructor(
    message: string,
    public code: "not_configured" | "failed" = "failed",
  ) {
    super(message);
  }
}

export interface LlmCall {
  system: string;
  user: string;
  maxTokens?: number;
}
export type LlmFn = (c: LlmCall) => Promise<string>;

export function llmConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/* * Thin Claude Messages API client. Swap this function to change provider; the engine only sees `LlmFn`. */
export const claude: LlmFn = async ({ system, user, maxTokens = 700 }) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new LlmUnavailable("ANTHROPIC_API_KEY is not set on the server.", "not_configured");
  const model = process.env.BOARDROOM_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    try {
      const res = await fetch(
        `${(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`,
        {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
        },
      );
      if (res.status === 401 || res.status === 403)
        throw new LlmUnavailable("The AI provider rejected the API key.", "not_configured");
      if (res.status === 429 || res.status >= 500) {
        last = `AI provider returned HTTP ${res.status}`;
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new LlmUnavailable(`AI provider returned HTTP ${res.status}`);
      const j = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = j.content
        ?.filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim();
      if (!text) throw new LlmUnavailable("The AI provider returned an empty answer.");
      return text;
    } catch (e) {
      if (e instanceof LlmUnavailable) throw e;
      last = e instanceof Error ? e.message : "request failed";
    } finally {
      clearTimeout(timer);
    }
  }
  throw new LlmUnavailable(last || "The AI provider is unavailable.");
};

/* * Pull the first balanced JSON object out of model text (models sometimes wrap it in prose or fences). */
export function extractJson<T = unknown>(text: string): T | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
