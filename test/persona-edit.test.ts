import { describe, it, expect } from "vitest";
import { PersonaDesk, SAFE_DEFAULTS, Outbox, Button } from "../src/persona.js";
import { MemoryStore } from "../src/store.js";
import type { LLM, ChatMsg } from "../src/llm.js";

const OWNER = 42;
function setup() {
  const sent: { to: string; text: string; buttons?: Button[][] }[] = [];
  const prompts: string[] = [];
  const out: Outbox = {
    toOwner: async (text, buttons) => { sent.push({ to: "owner", text, buttons }); },
    toContact: async (_t, text) => { sent.push({ to: "contact", text }); },
  };
  const llm: LLM = { async complete(r: { messages: ChatMsg[] }) { prompts.push((r.messages[0] as { content: string }).content); return { content: '{"reply":"Halo kak!","escalate":false}' }; } };
  const store = new MemoryStore();
  const desk = new PersonaDesk(store, OWNER, llm, out, { config: { ...SAFE_DEFAULTS, ageGate: true, ageGateText: "18+ default" }, text: "BASE" });
  return { desk, sent, prompts, store };
}
const msg = (text: string) => ({ contactName: "Budi", chatId: 7, text });

describe("owner persona editing", () => {
  it("ignores non-persona commands", async () => {
    expect(await setup().desk.onOwnerCommand("/ingat besok jam 9 x")).toBeNull();
  });

  it("set fields feed the LLM prompt and /persona shows them", async () => {
    const { desk, prompts } = setup();
    await desk.onOwnerCommand("/setgaya santai, panggil kak");
    await desk.onOwnerCommand("/setlayanan foto & video eksklusif");
    expect((await desk.onOwnerCommand("/setvip VIP grup bulanan"))!.text).toContain("tetap selalu dieskalasi");
    await desk.onOwnerCommand("/setinfo admin online 10.00-22.00 WITA");
    expect((await desk.onOwnerCommand("/contoh Them: halo\nAdmin: halo kak 🙏"))!.text).toContain("Contoh #");
    const view = (await desk.onOwnerCommand("/persona"))!.text;
    for (const s of ["santai, panggil kak", "foto & video", "VIP grup bulanan", "10.00-22.00", "Contoh chat: 1", "Persetujuan"]) expect(view).toContain(s);
    await desk.onIncoming(msg("halo"));
    expect(prompts[0]).toContain("BASE");
    expect(prompts[0]).toContain("santai, panggil kak");
    expect(prompts[0]).toContain("halo kak 🙏");
  });

  it("refuses text mentioning Fajrin", async () => {
    const { desk } = setup();
    expect((await desk.onOwnerCommand("/setinfo dikelola Fajrin"))!.text).toContain("tidak boleh");
    expect((await desk.onOwnerCommand("/persona"))!.text).not.toContain("dikelola");
  });

  it("examples list and delete", async () => {
    const { desk } = setup();
    const id = (await desk.onOwnerCommand("/contoh A"))!.text.match(/#(\d+)/)![1];
    expect((await desk.onOwnerCommand("/contohku"))!.text).toContain("A");
    expect((await desk.onOwnerCommand(`/hapuscontoh ${id}`))!.text).toContain("dihapus");
    expect((await desk.onOwnerCommand("/contohku"))!.text).toContain("Belum ada");
  });

  it("salam replaces the age gate but always keeps an 18+ line", async () => {
    const { desk, sent } = setup();
    await desk.onOwnerCommand("/salam Halo kak, selamat datang!");
    await desk.onIncoming(msg("hai"));
    const gate = sent.find(s => s.to === "contact")!.text;
    expect(gate).toContain("selamat datang");
    expect(gate).toContain("18+");
  });

  it("autobalas on needs button confirmation; off restores approval; hard rules still apply", async () => {
    const { desk, sent } = setup();
    const r = (await desk.onOwnerCommand("/autobalas on"))!;
    expect(r.text).toContain("Yakin");
    expect(r.buttons![0][0].data).toBe("pa:on");
    await desk.onIncoming(msg("halo"));                       // still approval mode before confirming
    expect(sent.filter(s => s.to === "contact" && s.text.includes("Halo kak!"))).toHaveLength(0);
    await desk.onOwnerAction("pa:on");
    await desk.onIncoming({ ...msg("halo lagi"), chatId: 7 });
    expect(sent.some(s => s.to === "contact" && s.text.startsWith("Halo kak!"))).toBe(true);
    const before = sent.length;
    await desk.onIncoming(msg("berapa harga VIP?"));          // escalated even in auto mode
    expect(sent.slice(before).some(s => s.to === "owner" && s.text.includes("Perlu kamu jawab"))).toBe(true);
    await desk.onIncoming(msg("aku masih di bawah umur"));    // minors block unaffected
    expect(sent.some(s => s.text.includes("DIBLOKIR"))).toBe(true);
    expect((await desk.onOwnerCommand("/autobalas off"))!.text).toContain("MATI");
    expect((await desk.onOwnerCommand("/persona"))!.text).toContain("Persetujuan");
  });

  it("reset requires confirmation and clears overrides", async () => {
    const { desk } = setup();
    await desk.onOwnerCommand("/setgaya formal");
    expect((await desk.onOwnerCommand("/resetpersona"))!.buttons![0][0].data).toBe("pa:reset");
    expect(await desk.onOwnerAction("pa:cancel")).toContain("Dibatalkan");
    expect((await desk.onOwnerCommand("/persona"))!.text).toContain("formal");
    await desk.onOwnerAction("pa:reset");
    expect((await desk.onOwnerCommand("/persona"))!.text).not.toContain("formal");
  });
});
