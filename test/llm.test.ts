import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveProvider, llmFromEnv } from "../src/llm.js";

afterEach(() => vi.unstubAllGlobals());

describe("provider selection", () => {
  it("prefers Groq when its key exists", () => {
    const r = resolveProvider({ GROQ_API_KEY: "g", OPENAI_API_KEY: "o" });
    expect(r).toMatchObject({ provider: "groq", model: "openai/gpt-oss-120b", baseUrl: "https://api.groq.com/openai/v1" });
  });
  it("LLM_MODEL and LLM_PROVIDER override", () => {
    expect(resolveProvider({ GROQ_API_KEY: "g", LLM_MODEL: "qwen/qwen3.8-27b" })!.model).toBe("qwen/qwen3.8-27b");
    expect(resolveProvider({ GROQ_API_KEY: "g", OPENAI_API_KEY: "o", LLM_PROVIDER: "openai" })!.provider).toBe("openai");
  });
  it("OpenAI stays optional; none or disabled gives null", () => {
    expect(resolveProvider({ OPENAI_API_KEY: "o" })).toBeNull(); // groq is default, no silent switch
    expect(resolveProvider({ OPENAI_API_KEY: "o", LLM_PROVIDER: "openai" })!.provider).toBe("openai");
    expect(resolveProvider({})).toBeNull();
    expect(resolveProvider({ GROQ_API_KEY: "g", LLM_DISABLED: "1" })).toBeNull();
  });
  it("calls the Groq endpoint with bearer key and tools, errors expose status only", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
    vi.stubGlobal("fetch", fetchMock);
    const llm = llmFromEnv({ GROQ_API_KEY: "secret-g" })!;
    expect((await llm.complete({ messages: [{ role: "user", content: "hi" }] })).content).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-g");
    expect(JSON.parse(init.body as string).model).toBe("openai/gpt-oss-120b");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(llm.complete({ messages: [] })).rejects.toThrow(/^groq http 401$/);
  });
});
