import { describe, it, expect } from "vitest";
import { PersonaDesk, loadPersona, Outbox } from "../src/persona.js";
import { MemoryStore } from "../src/store.js";

const OWNER = 42;
function setup(llmReply: string) {
  const sent: { to: string; text: string }[] = [];
  const prompts: string[] = [];
  const out: Outbox = {
    toOwner: async text => { sent.push({ to: "owner", text }); },
    toContact: async (_t, text) => { sent.push({ to: "contact", text }); },
    toContactPhoto: async (_t, _p, text) => { sent.push({ to: "contact", text }); },
  };
  const llm = { async complete(r: any) { prompts.push(r.messages[0].content); return { content: llmReply }; } };
  const base = loadPersona(process.cwd());
  const desk = new PersonaDesk(new MemoryStore(), OWNER, llm, out, { config: { ...base.config, ageGate: false, discloseAI: false }, text: base.text });
  return { desk, sent, prompts };
}
const msg = (text: string) => ({ contactName: "Budi", chatId: 7, text });
const owner = (s: { to: string; text: string }[]) => s.filter(x => x.to === "owner").at(-1)!.text;

describe("FAQ commands", () => {
  it("add, list, delete, count in /persona", async () => {
    const { desk } = setup("{}");
    expect((await desk.onOwnerCommand("/tambahinfo tanpa jawaban"))!.text).toContain("Format");
    const r = (await desk.onOwnerCommand("/tambahinfo grup vvip kebanned | tenang bro, nanti dikirim link grup baru"))!.text;
    const id = Number(r.match(/#(\d+)/)![1]);
    expect((await desk.onOwnerCommand("/info"))!.text).toContain("grup vvip kebanned");
    expect((await desk.onOwnerCommand("/persona"))!.text).toContain("Info/FAQ: 1");
    expect((await desk.onOwnerCommand(`/hapusinfo ${id}`))!.text).toContain("dihapus");
    expect((await desk.onOwnerCommand("/hapusinfo 999"))!.text).toContain("tidak ditemukan");
    expect((await desk.onOwnerCommand("/info"))!.text).toContain("Belum ada");
  });
});

describe("FAQ drafting", () => {
  it("matching question is drafted from the FAQ (even with soft keywords like vvip/member)", async () => {
    const { desk, sent, prompts } = setup('{"reply":"tenang bro, nanti dikirim link grup baru ya","escalate":false}');
    await desk.onOwnerCommand("/tambahinfo grup vvip kebanned | tenang bro, nanti dikirim link grup baru");
    await desk.onOwnerCommand("/tambahinfo sudah member sebelumnya | aman bro, kirim username lama ya biar dicek");
    await desk.onIncoming(msg("Grup vvip ne kebanned"));
    expect(owner(sent)).toContain("Draf balasan");
    expect(owner(sent)).toContain("link grup baru");
    expect(prompts[0]).toContain("Owner FAQ");
    expect(prompts[0]).toContain("Q: grup vvip kebanned");
  });
  it("'sudah member sebelumnya' uses the owner's answer", async () => {
    const { desk, sent } = setup('{"reply":"aman bro, kirim username lama ya biar dicek","escalate":false}');
    await desk.onOwnerCommand("/tambahinfo sudah member sebelumnya | aman bro, kirim username lama ya biar dicek");
    await desk.onIncoming(msg("Saya sudah member sebelumnya"));
    expect(owner(sent)).toContain("Draf balasan");
  });
  it("without FAQ the same message still escalates; LLM sees no FAQ section", async () => {
    const { desk, sent, prompts } = setup('{"reply":"x","escalate":false}');
    await desk.onIncoming(msg("Saya sudah member sebelumnya"));
    expect(owner(sent)).toContain("Perlu kamu jawab");
    expect(prompts).toHaveLength(0);
    await desk.onIncoming(msg("kontennya update tiap hari?"));
    expect(prompts[0]).not.toContain("Owner FAQ");
  });
  it("diskon/nego, explicit and minors stay escalated or blocked even with FAQ", async () => {
    const { desk, sent } = setup('{"reply":"ok bro","escalate":false}');
    await desk.onOwnerCommand("/tambahinfo grup vvip diskon nego bugil umur | jawaban");
    for (const q of ["grup vvip ada diskon?", "vvip bisa nego?", "vvip bugil", "vvip umur 18?"]) {
      await desk.onIncoming(msg(q));
      expect(owner(sent), q).not.toContain("Draf balasan");
    }
  });
  it("model reply with keywords not in the owner's answer is escalated", async () => {
    const { desk, sent } = setup('{"reply":"bro transfer dulu ke rekening ya","escalate":false}');
    await desk.onOwnerCommand("/tambahinfo grup vvip kebanned | tenang bro, nanti dikirim link baru");
    await desk.onIncoming(msg("grup vvip kebanned"));
    expect(owner(sent)).toContain("Perlu kamu jawab");
  });
});
