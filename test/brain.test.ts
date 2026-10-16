import { describe, it, expect } from "vitest";
import { SecretaryBrain } from "../src/brain.js";
import { Secretary } from "../src/service.js";
import { MemoryStore } from "../src/store.js";
import type { LLM, LLMReply } from "../src/llm.js";
import { toUtc } from "../src/time.js";

const NOW = toUtc({ y: 2026, mo: 10, d: 16, h: 13, mi: 12 }, "Asia/Makassar");
const script = (replies: (LLMReply | Error)[]): LLM & { calls: number } => {
  const m = { calls: 0, async complete() { const r = replies[m.calls++]; if (r instanceof Error) throw r; return r; } };
  return m;
};
const call = (name: string, args: object, id = "c1") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

describe("SecretaryBrain", () => {
  it("executes tool calls against the real secretary", async () => {
    const sec = new Secretary(new MemoryStore(), () => NOW);
    const llm = script([
      { content: null, tool_calls: [call("add_reminder", { when: "besok jam 9", what: "rapat tim" }), call("add_task", { text: "siapkan slide" }, "c2")] },
      { content: "Siap, pengingat dan tugas sudah dicatat." },
    ]);
    const brain = new SecretaryBrain(sec, llm, () => NOW);
    expect(await brain.handle(1, 1, "tolong ingatkan rapat tim besok pagi jam 9 dan catat tugas siapkan slide")).toContain("Siap");
    expect(await sec.handle(1, 1, "/pengingat")).toContain("Sabtu, 17 Okt 2026 09:00: rapat tim");
    expect(await sec.handle(1, 1, "/tugasku")).toContain("siapkan slide");
  });

  it("falls back to rule-based parser when the LLM fails", async () => {
    const sec = new Secretary(new MemoryStore(), () => NOW);
    const brain = new SecretaryBrain(sec, script([new Error("down")]), () => NOW);
    expect(await brain.handle(1, 1, "ingatkan besok jam 9 rapat")).toContain("Pengingat #1");
  });

  it("slash commands bypass the LLM", async () => {
    const llm = script([]);
    const brain = new SecretaryBrain(new Secretary(new MemoryStore(), () => NOW), llm, () => NOW);
    await brain.handle(1, 1, "/catat halo");
    expect(llm.calls).toBe(0);
  });

  it("works with no LLM configured", async () => {
    const brain = new SecretaryBrain(new Secretary(new MemoryStore(), () => NOW), null, () => NOW);
    expect(await brain.handle(1, 1, "/tugas x")).toContain("Tugas #1");
  });
});
