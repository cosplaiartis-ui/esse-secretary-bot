import { describe, it, expect } from "vitest";
import { PersonaDesk, loadPersona, Outbox, Button } from "../src/persona.js";
import { MemoryStore } from "../src/store.js";

const URL = "https://esse-kuning-website.vercel.app/";
function setup(groupMembers: Record<number, number[]> = {}) {
  let now = Date.UTC(2026, 9, 16, 6, 0);
  const sent: { to: string; text: string; photo?: string; buttons?: Button[][] }[] = [];
  const prompts: string[] = [];
  let calls = 0;
  const out: Outbox = {
    toOwner: async (text, buttons) => { sent.push({ to: "owner", text, buttons }); },
    toContact: async (_t, text) => { sent.push({ to: "contact", text }); },
    toContactPhoto: async (_t, photo, text) => { sent.push({ to: "contact", text, photo }); },
    toOwnerPhoto: async (photo, text, buttons) => { sent.push({ to: "owner", text, photo, buttons }); },
    isGroupMember: async (g, u) => { calls++; return (groupMembers[g] ?? []).includes(u); },
  };
  const llm = { async complete(r: any) { prompts.push(r.messages[1].content); return { content: '{"reply":"ya bro?","escalate":false}' }; } };
  const base = loadPersona(process.cwd());
  const desk = new PersonaDesk(new MemoryStore(), 42, llm, out, { config: { ...base.config, ageGate: false, discloseAI: false }, text: base.text }, () => now);
  return { desk, sent, prompts, calls: () => calls, adv: (d: number) => (now += d * 864e5) };
}
const msg = (text: string, chatId = 7, photoFileId?: string) => ({ contactName: "Budi", chatId, text, photoFileId });
const ownerLast = (s: { to: string; text: string }[]) => s.filter(x => x.to === "owner").at(-1)!.text;

describe("member list", () => {
  it("add with expiry, list, expire, remove", async () => {
    const { desk, adv } = setup();
    expect(await desk.addMember(7, 30, "Budi")).toContain("sampai");
    expect((await desk.onOwnerCommand("/daftarmember"))!.text).toContain("Budi · 7 · s/d");
    expect((await desk.onOwnerCommand("/member 8"))!.text).toContain("tanpa batas");
    expect((await desk.onOwnerCommand("/persona"))!.text).toContain("Member manual: 2");
    adv(31);
    expect((await desk.onOwnerCommand("/daftarmember"))!.text).toContain("kedaluwarsa");
    expect((await desk.onOwnerCommand("/hapusmember 8"))!.text).toContain("dihapus");
    expect((await desk.onOwnerCommand("/hapusmember 8"))!.text).toContain("tidak ditemukan");
  });
  it("cards show status; /member via card reply; expired member is not member", async () => {
    const { desk, sent, prompts, adv } = setup();
    await desk.onIncoming(msg("halo"));
    expect(ownerLast(sent)).toContain("Member: ?");
    expect(ownerLast(sent)).toContain("🆔 7");
    expect(await desk.memberFromCard(ownerLast(sent), 1)).toContain("Budi");
    await desk.onIncoming(msg("halo lagi"));
    expect(ownerLast(sent)).toContain("Member ✅");
    expect(prompts.at(-1)).toContain("existing VIP member");
    await desk.onIncoming(msg("halo", 9));
    expect(ownerLast(sent)).toContain("Bukan member");
    expect(prompts.at(-1)).toContain("not a member");
    adv(2);
    await desk.onIncoming(msg("halo", 7));
    expect(ownerLast(sent)).toContain("Bukan member");
  });
  it("payment-proof card has 'Jadikan member' button that works", async () => {
    const { desk, sent } = setup();
    await desk.onIncoming(msg("", 7, "PROOF"));
    const b = sent.find(s => s.to === "owner")!.buttons!.flat().find(x => x.text.includes("Jadikan member"))!;
    expect(b.data).toBe("m:add:7");
    expect(await desk.onOwnerAction(b.data)).toContain("jadi member");
    expect((await desk.onOwnerCommand("/daftarmember"))!.text).toContain("· 7 ·");
  });
});

describe("VIP groups", () => {
  it("group membership counts, cached, listed", async () => {
    const { desk, sent, calls } = setup({ [-100]: [7] });
    expect(await desk.addVipGroup(-100, "VIP Esse")).toContain("terdaftar");
    expect((await desk.onOwnerCommand("/grupvip"))!.text).toContain("VIP Esse · -100");
    await desk.onIncoming(msg("halo"));
    expect(ownerLast(sent)).toContain("Member ✅");
    await desk.onIncoming(msg("halo lagi"));
    expect(calls()).toBe(1);
    await desk.onIncoming(msg("halo", 9));
    expect(ownerLast(sent)).toContain("Bukan member");
    expect((await desk.onOwnerCommand("/hapusgrupvip -100"))!.text).toContain("dihapus");
  });
});

describe("edit orders by membership", () => {
  it("member gets edit pricelist, non-member gets VIP join link", async () => {
    const { desk, sent } = setup();
    await desk.setEditPricelist("EDIT_FILE");
    await desk.addMember(7);
    await desk.onIncoming(msg("mau order edit foto"));
    expect(ownerLast(sent)).toContain("Order edit");
    await desk.onIncoming(msg("mau order edit foto", 9));
    expect(ownerLast(sent)).toContain("Draf balasan");
    expect(ownerLast(sent)).toContain(URL);
  });
});
