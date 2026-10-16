// Minimal OpenAI Chat Completions client (fetch based) behind an interface so tests can mock it.

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export type ChatMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export interface ToolDef { type: "function"; function: { name: string; description: string; parameters: object } }
export interface LLMReply { content: string | null; tool_calls?: ToolCall[] }

export interface LLM {
  complete(req: { messages: ChatMsg[]; tools?: ToolDef[]; json?: boolean }): Promise<LLMReply>;
}

/** Any OpenAI-compatible Chat Completions endpoint (Groq, OpenAI). */
export class OpenAICompatChat implements LLM {
  constructor(private apiKey: string, readonly model: string, private baseUrl: string, private label = "llm") {}
  async complete(req: { messages: ChatMsg[]; tools?: ToolDef[]; json?: boolean }): Promise<LLMReply> {
    const body: Record<string, unknown> = { model: this.model, messages: req.messages, temperature: 0.3 };
    if (req.tools?.length) body.tools = req.tools;
    if (req.json) body.response_format = { type: "json_object" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000); // keep under the 10 s function limit
    try {
      const r = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST", signal: ctrl.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${this.label} http ${r.status}`); // status only, never the key or body
      const j = (await r.json()) as { choices: { message: LLMReply }[] };
      return j.choices[0].message;
    } finally { clearTimeout(timer); }
  }
}

export const PROVIDERS = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", defaultModel: "openai/gpt-oss-120b" },
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", defaultModel: "gpt-4o-mini" },
} as const;
export type Provider = keyof typeof PROVIDERS;

/** Provider is LLM_PROVIDER (default "groq"). OpenAI is used only with LLM_PROVIDER=openai. Model via LLM_MODEL. */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): { provider: Provider; key: string; model: string; baseUrl: string } | null {
  if (env.LLM_DISABLED === "1") return null;
  const want = (env.LLM_PROVIDER || "groq").toLowerCase();
  if (!(want in PROVIDERS)) return null;
  const order: Provider[] = [want as Provider];
  for (const p of order) {
    const cfg = PROVIDERS[p];
    const key = env[cfg.keyEnv];
    if (!key) continue;
    const model = env.LLM_MODEL || (p === "openai" ? env.OPENAI_MODEL : undefined) || cfg.defaultModel;
    return { provider: p, key, model, baseUrl: env.LLM_BASE_URL || cfg.baseUrl };
  }
  return null;
}

export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LLM | null {
  const r = resolveProvider(env);
  return r ? new OpenAICompatChat(r.key, r.model, r.baseUrl, r.provider) : null;
}
