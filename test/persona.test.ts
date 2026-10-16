import { describe, it, expect } from "vitest";
import { PersonaDesk, SAFE_DEFAULTS, PersonaConfig, Outbox, Button, Target, loadPersona } from "../src/persona.js";
import { MemoryStore } from "../src/store.js";
import type { LLM } from "../src/llm.js";

const OWNER = 42;
function setup(llmJson: object | Error | null, cfg: Partial<PersonaConfig> = {}) {
  const sent: { to: "owner" | "contact"; text: string; target?: Target; buttons?: Button[][] }[] = [];
  const out: Outbox = {
    toOwner: async (text, buttons) => { sent.push({ to: "owner", text, buttons }); },
    toContact: async (target, text) => { sent.push({ to: "contact", text, target }); },
  };
  const llm: LLM | null = llmJson === null ? null : {
    async complete() { if (llmJson instanceof Error) throw llmJson; return { content: JSON.stringify(llmJson) }; },
  };
  const desk = new PersonaDesk(new MemoryStore(), OWNER, llm, out, { config: { ...SAFE_DEFAULTS, ageGate: false, ...cfg }, text: "persona" });
  return { desk, sent };
}
const msg = (text: string, businessConnectionId?: string) => ({ contactName: "Budi", chatId: 7, text, businessConnectionId });

describe("PersonaDesk", () => {
  it("defaults are safe", () => {
    const c = loadPersona(process.cwd()).config;
    expect(c.approvalMode).toBe(true);
    expect(c.autoSend).toBe(false);
  });

  it("approval mode: drafts go to owner, nothing to contact until approved", async () => {
    const { desk, sent } = setup({ reply: "Halo Budi! Ada yang bisa dibantu?", escalate: false });
    await desk.onIncoming(msg("halo kak"));
    expect(sent.filter(s => s.to === "contact")).toHaveLength(0);
    const o = sent[0];
    expect(o.text).toContain("Draf balasan");
    expect(o.buttons![0].map(b => b.text)).toEqual(["✅ Kirim", "✏️ Edit", "❌ Tolak"]);
    const approve = o.buttons![0][0].data;
    expect(await desk.onOwnerAction(approve)).toContain("Terkirim");
    const c = sent.filter(s => s.to === "contact");
    expect(c).toHaveLength(1);
    expect(c[0].text).toContain("Halo Budi");
    expect(c[0].text).toContain("admin AI"); // disclosure on by default
    expect(await desk.onOwnerAction(approve)).toContain("Sudah diproses"); // no double send
  });

  it("reject sends nothing", async () => {
    const { desk, sent } = setup({ reply: "Halo", escalate: false });
    await desk.onIncoming(msg("halo"));
    await desk.onOwnerAction(sent[0].buttons![0][2].data);
    expect(sent.filter(s => s.to === "contact")).toHaveLength(0);
  });

  it("edit: owner's typed text is sent verbatim without AI disclosure", async () => {
    const { desk, sent } = setup({ reply: "Halo", escalate: false });
    await desk.onIncoming(msg("halo"));
    await desk.onOwnerAction(sent[0].buttons![0][1].data);
    expect(await desk.onOwnerText("Halo Budi, aku Fajrin langsung.")).toContain("terkirim");
    const c = sent.filter(s => s.to === "contact");
    expect(c.map(x => x.text)).toEqual(["Halo Budi, aku Fajrin langsung."]);
    expect(await desk.onOwnerText("pesan biasa")).toBeNull(); // back to secretary mode
  });

  it("escalates price questions by keyword without calling the LLM", async () => {
    const { desk, sent } = setup(new Error("should not be called"));
    await desk.onIncoming(msg("Kak, berapa harga desain logo?", "bc1"));
    const contact = sent.filter(s => s.to === "contact");
    expect(contact).toHaveLength(1);
    expect(contact[0].target).toEqual({ chatId: 7, businessConnectionId: "bc1" });
    expect(contact[0].text).toContain("nanti saya kabari");
    const owner = sent.find(s => s.to === "owner")!;
    expect(owner.text).toContain("Perlu kamu jawab");
    expect(owner.text).toContain("harga");
    expect(owner.text).toContain("akun pribadimu");
  });

  it("escalates when the model is unsure, errors, or is missing", async () => {
    for (const l of [{ reply: "", escalate: true, reason: "minta jadwal" }, new Error("x"), null]) {
      const { desk, sent } = setup(l as object | Error | null);
      await desk.onIncoming(msg("bisa ketemu minggu depan?"));
      expect(sent.find(s => s.to === "owner")!.text).toContain("Perlu kamu jawab");
    }
  });

  it("escalates if the model's own draft mentions a committal topic", async () => {
    const { desk, sent } = setup({ reply: "Bisa, harga mulai 500rb", escalate: false });
    await desk.onIncoming(msg("bisa bikin poster?"));
    expect(sent.find(s => s.to === "owner")!.text).toContain("Perlu kamu jawab");
    expect(sent.filter(s => s.to === "contact").every(s => !s.text.includes("500rb"))).toBe(true);
  });

  it("anything about Fajrin's creative brand is escalated (brands stay separate)", async () => {
    const { desk, sent } = setup(new Error("not called"), loadPersona(process.cwd()).config);
    await desk.onIncoming(msg("ini adminnya Fajrin yang desainer itu kan?"));
    expect(sent.find(s => s.to === "owner")!.text).toContain("Perlu kamu jawab");
  });

  it("VIP, payment, custom and explicit requests escalate without the LLM", async () => {
    for (const t of ["mau join VIP dong", "transfer kemana kak?", "bisa custom video?", "kirim nudes dong"]) {
      const { desk, sent } = setup(new Error("not called"), { ...loadPersona(process.cwd()).config, ageGate: false });
      await desk.onIncoming(msg(t));
      expect(sent.find(s => s.to === "owner")!.text, t).toContain("Perlu kamu jawab");
    }
  });

  it("possible minors: refuse, alert owner, never draft", async () => {
    for (const t of ["aku masih 16 tahun kak", "umur 15 boleh join?", "aku masih SMP", "ada yang di bawah umur?"]) {
      const { desk, sent } = setup(new Error("not called"), { ...loadPersona(process.cwd()).config, ageGate: false });
      await desk.onIncoming(msg(t));
      const c = sent.filter(s => s.to === "contact");
      expect(c.map(x => x.text), t).toEqual([loadPersona(process.cwd()).config.refusalText]);
      expect(sent.find(s => s.to === "owner")!.text).toContain("DIBLOKIR");
    }
  });

  it("adult ages do not trigger the minor block", async () => {
    const { desk, sent } = setup({ reply: "Halo kak!", escalate: false }, { ...loadPersona(process.cwd()).config, ageGate: false });
    await desk.onIncoming(msg("halo aku 25 tahun"));
    expect(sent.find(s => s.to === "owner")!.text).not.toContain("DIBLOKIR");
  });

  it("age gate is sent once on first contact", async () => {
    const { desk, sent } = setup({ reply: "Halo kak!", escalate: false }, { ageGate: true, ageGateText: "18+ only" });
    await desk.onIncoming(msg("halo"));
    await desk.onIncoming(msg("halo lagi"));
    expect(sent.filter(s => s.to === "contact").map(s => s.text)).toEqual(["18+ only"]);
  });

  it("autoSend only works when approval mode is explicitly off", async () => {
    const a = setup({ reply: "Halo!", escalate: false }, { autoSend: true }); // approvalMode still true
    await a.desk.onIncoming(msg("halo"));
    expect(a.sent.filter(s => s.to === "contact")).toHaveLength(0);
    const b = setup({ reply: "Halo!", escalate: false }, { autoSend: true, approvalMode: false, discloseAI: false });
    await b.desk.onIncoming(msg("halo"));
    expect(b.sent.filter(s => s.to === "contact").map(s => s.text)).toEqual(["Halo!"]);
  });

  it("holding reply can be disabled", async () => {
    const { desk, sent } = setup(null, { holdingReply: false });
    await desk.onIncoming(msg("harga?"));
    expect(sent.filter(s => s.to === "contact")).toHaveLength(0);
  });
});
