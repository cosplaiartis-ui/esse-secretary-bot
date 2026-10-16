import { describe, it, expect } from "vitest";
import { PersonaDesk, loadPersona, Outbox, Button } from "../src/persona.js";
import { MemoryStore } from "../src/store.js";

function setup(over: Record<string, unknown> = {}) {
  const sent: { to: string; text: string; photo?: string; buttons?: Button[][] }[] = [];
  const out: Outbox = {
    toOwner: async (text, buttons) => { sent.push({ to: "owner", text, buttons }); },
    toContact: async (_t, text) => { sent.push({ to: "contact", text }); },
    toContactPhoto: async (_t, photo, text) => { sent.push({ to: "contact", text, photo }); },
    toOwnerPhoto: async (photo, text, buttons) => { sent.push({ to: "owner", text, photo, buttons }); },
  };
  const llm = { async complete() { return { content: '{"reply":"ya bro?","escalate":false}' }; } };
  const base = loadPersona(process.cwd());
  const desk = new PersonaDesk(new MemoryStore(), 42, llm, out, { config: { ...base.config, ageGate: false, discloseAI: false, ...over }, text: base.text });
  const approve = async () => desk.onOwnerAction([...sent].reverse().find(s => s.to === "owner" && s.buttons)!.buttons![0][0].data);
  return { desk, sent, approve, base };
}
const msg = (text: string, photoFileId?: string) => ({ contactName: "Budi", chatId: 7, text, photoFileId });
const contact = (s: { to: string; text: string; photo?: string }[]) => s.filter(x => x.to === "contact");

describe("group migration", () => {
  const asks = ["Grup vvip ne kebanned", "grup kena banned ya?", "grupnya hilang bro", "grup ga bisa dibuka", "pindah grup kemana?", "ada grup baru?"];
  it("drafts the migration image with the exact caption, before FAQ/member escalation", async () => {
    for (const q of asks) {
      const { desk, sent, approve, base } = setup(); await desk.setMigrasi("MIG");
      await desk.onOwnerCommand("/tambahinfo grup vvip kebanned | faq answer");
      await desk.onIncoming(msg(q));
      expect(sent.at(-1)!.text, q).toContain("Info migrasi grup");
      expect(contact(sent), q).toHaveLength(0);
      await approve();
      const c = contact(sent);
      expect(c, q).toHaveLength(1);
      expect(c[0].photo).toBe("MIG");
      expect(c[0].text).toBe(base.config.migrasiCaption);
      expect(c[0].text).toContain("Rp10.000/member");
    }
  });
  it("BCA mode appends the BCA line", async () => {
    const { desk, sent, approve } = setup(); await desk.setMigrasi("MIG");
    await desk.onOwnerCommand("/bayarbca");
    await desk.onIncoming(msg("grup kebanned"));
    await approve();
    expect(contact(sent)[0].text.endsWith("Hari ini pembayaran via BCA 6042976624 a.n. MF ya 🙏")).toBe(true);
  });
  it("long caption: image first, then text", async () => {
    const { desk, sent, approve } = setup({ migrasiCaption: "x".repeat(1100) }); await desk.setMigrasi("MIG");
    await desk.onIncoming(msg("grup kebanned"));
    await approve();
    const c = contact(sent);
    expect(c).toHaveLength(2);
    expect(c[0].photo).toBe("MIG"); expect(c[0].text).toBe("");
    expect(c[1].text).toHaveLength(1100);
  });
  it("proof still escalates; no image falls back; /persona and /setmigrasi", async () => {
    const { desk, sent } = setup();
    await desk.onIncoming(msg("grup kebanned"));
    expect(sent.at(-1)!.text).not.toContain("Info migrasi");
    expect((await desk.onOwnerCommand("/persona"))!.text).toContain("Gambar migrasi grup: ❌");
    expect((await desk.onOwnerCommand("/setmigrasi"))!.text).toContain("/setmigrasi");
    await desk.setMigrasi("MIG");
    expect((await desk.onOwnerCommand("/persona"))!.text).toContain("Gambar migrasi grup: ✅");
    await desk.onIncoming(msg("udah transfer migrasi grup baru", "PROOF"));
    expect(sent.find(s => s.text.includes("Cek pembayaran"))).toBeTruthy();
  });
});

describe("join / premium questions", () => {
  const URL = "https://esse-kuning-website.vercel.app/";
  it("draft the VIP pricelist link instead of escalating", async () => {
    for (const q of ["mau join bro", "grup premium gimana?", "ini berbayar?", "grup vvip apa aja isinya", "cara gabung", "mau masuk grup", "premium ada?"]) {
      const { desk, sent } = setup(); await desk.setMigrasi("MIG");
      await desk.onIncoming(msg(q));
      expect(sent.at(-1)!.text, q).toContain("Draf balasan");
      expect(sent.at(-1)!.text, q).toContain(`cek pricelist di sini ya bro 👉 ${URL}`);
    }
  });
  it("migration wins; payment and discount still handled as before", async () => {
    const { desk, sent } = setup(); await desk.setMigrasi("MIG");
    await desk.onIncoming(msg("grup vvip kebanned, join grup baru dimana"));
    expect(sent.at(-1)!.text).toContain("Info migrasi grup");
    await desk.onIncoming(msg("join vip ada diskon?"));
    expect(sent.at(-1)!.text).toContain("Perlu kamu jawab");
    await desk.onIncoming(msg("mau join, bayar kemana"));
    expect(sent.at(-1)!.text).not.toContain("cek pricelist");
  });
});
