// Owner (secretary) mode brain: an LLM (Groq by default) with function calling over the existing Secretary actions.
// Falls back to the rule-based command handler when the LLM is missing or fails.
import type { LLM, ChatMsg, ToolDef } from "./llm.js";
import type { Secretary } from "./service.js";
import { fmt } from "./time.js";

const fn = (name: string, description: string, props: Record<string, object> = {}, required: string[] = []): ToolDef =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties: props, required } } });
const S = { type: "string" }, N = { type: "integer" };

export const SECRETARY_TOOLS: ToolDef[] = [
  fn("add_reminder", "Create a reminder. 'when' is a short Indonesian/English time phrase understood by the parser, e.g. 'besok jam 9', '30 menit lagi', 'setiap senin jam 8', '20/10 14:00'.", { when: S, what: S }, ["when", "what"]),
  fn("list_reminders", "List reminders"),
  fn("delete_reminder", "Delete reminder by id", { id: N }, ["id"]),
  fn("add_event", "Add a calendar event. 'when' as in add_reminder.", { when: S, what: S }, ["when", "what"]),
  fn("agenda", "Show events for today (days=1) or next 7 days (days=7)", { days: N }, ["days"]),
  fn("delete_event", "Delete event by id", { id: N }, ["id"]),
  fn("add_note", "Save a note", { text: S }, ["text"]),
  fn("list_notes", "List recent notes"),
  fn("search_notes", "Search notes by keyword", { query: S }, ["query"]),
  fn("add_task", "Add a task for today", { text: S }, ["text"]),
  fn("list_tasks", "List tasks"),
  fn("complete_task", "Mark task done by id", { id: N }, ["id"]),
  fn("daily_summary", "Show today's summary"),
];

/** Map tool calls to existing slash commands so the rule-based logic stays the single source of truth. */
export function toolToCommand(name: string, a: Record<string, unknown>): string | null {
  switch (name) {
    case "add_reminder": return `/ingat ${a.when} ${a.what}`;
    case "list_reminders": return "/pengingat";
    case "delete_reminder": return `/hapusingat ${a.id}`;
    case "add_event": return `/jadwal ${a.when} ${a.what}`;
    case "agenda": return Number(a.days) > 1 ? "/mingguini" : "/hariini";
    case "delete_event": return `/hapusjadwal ${a.id}`;
    case "add_note": return `/catat ${a.text}`;
    case "list_notes": return "/catatan";
    case "search_notes": return `/cari ${a.query}`;
    case "add_task": return `/tugas ${a.text}`;
    case "list_tasks": return "/tugasku";
    case "complete_task": return `/selesai ${a.id}`;
    case "daily_summary": return "/ringkas";
    default: return null;
  }
}

export class SecretaryBrain {
  constructor(private sec: Secretary, private llm: LLM | null, private now: () => number = Date.now) {}

  async handle(userId: number, chatId: number, text: string): Promise<string> {
    if (!this.llm || text.startsWith("/")) return this.sec.handle(userId, chatId, text);
    try {
      return await this.run(userId, chatId, text);
    } catch {
      return this.sec.handle(userId, chatId, text); // rule-based fallback
    }
  }

  private async run(userId: number, chatId: number, text: string): Promise<string> {
    const st = await this.sec.load(userId, chatId);
    const messages: ChatMsg[] = [
      { role: "system", content:
        `You are Fajrin's personal secretary on Telegram. Reply in casual, concise Indonesian. ` +
        `Now: ${fmt(this.now(), st.tz)} (${st.tz}). Use the tools to act; never claim an action you did not perform. ` +
        `For 'when', pass a short phrase like 'besok jam 9' or '30 menit lagi'. Ask a short question if the time is ambiguous.` },
      { role: "user", content: text },
    ];
    for (let step = 0; step < 4; step++) {
      const r = await this.llm!.complete({ messages, tools: SECRETARY_TOOLS });
      if (!r.tool_calls?.length) return r.content?.trim() || "Oke.";
      messages.push({ role: "assistant", content: r.content ?? null, tool_calls: r.tool_calls });
      for (const c of r.tool_calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* keep empty */ }
        const cmd = toolToCommand(c.function.name, args);
        const out = cmd ? await this.sec.handle(userId, chatId, cmd) : "unknown tool";
        messages.push({ role: "tool", tool_call_id: c.id, content: out });
      }
    }
    return "Maaf, permintaannya terlalu rumit. Coba dipecah ya.";
  }
}
