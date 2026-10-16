import { describe, it, expect } from "vitest";
import { PersonaDesk, loadPersona, Outbox, Button } from "../src/persona.js";
import { MemoryStore } from "../src/store.js";

const OWNER = 42;
const URL = "https://esse-kuning-website.vercel.app/";
type Sent = { to: string; text: string; photo?: string; chatId?: number; buttons?: Button[][] };
function setup(opts: { auto?: boolean; qr?: boolean; edit?: boolean } = {}) {
  let now = Date.UTC(2026, 9, 16, 6, 0);
  const sent: Sent[] = [];
  const out: Outbox = {
    toOwner: async (text, buttons) => { sent.push({ to: "owner", text, buttons }); },
    toContact: async (t, text) => { sent.push({ to: "contact", text, chatId: t.chatId }); },
    toContactPhoto: async (t, photo, text) => { sent.push({ to: "contact", text, photo, chatId: t.chatId }); },
    toOwnerPhoto: async (photo, text, buttons) => { sent.push({ to: "owner", text, photo, buttons }); },
  };
  const base = loadPersona(process.cwd());
  const store = new MemoryStore();
  const llm = { async complete() { return { content: '{"reply":"ya bro? Join?","escalate":false}' }; } };
  const desk = new PersonaDesk(store, OWNER, llm, out, { config: { ...base.config, ageGate: false, discloseAI: false }, text: base.text }, () => now);
  const init = async () => {
    if (opts.auto) { await desk.onOwnerCommand("/autobalas on"); await desk.onOwnerAction("pa:on"); }
    if (opts.qr) await desk.setQr("QR_FILE");
    if (opts.edit) await desk.setEditPricelist("EDIT_FILE");
  };
  const lastOwnerButton = (i = 0) => [...sent].reverse().find(s => s.to === "owner" && s.buttons)!.buttons![0][i].data;
  return { desk, sent, init, adv: (min: number) => (now += min * 60e3), lastOwnerButton };
}
const msg = (text: string, chatId = 7, photoFileId?: string) => ({ contactName: "Budi", chatId, text, photoFileId });
const toContact = (s: Sent[]) => s.filter(x => x.to === "contact");

describe("pricelist", () => {
  it("plain price questions get the link (draft in approval mode), not escalation", async () => {
    for (const q of ["harga vip berapa bro?", "minta pricelist dong", "paketnya apa aja?", "list harga join"]) {
      const { desk, sent, init } = setup(); await init();
      await desk.onIncoming(msg(q));
      const o = sent.find(s => s.to === "owner")!;
      expect(o.text, q).toContain("Draf balasan");
      expect(o.text).toContain(`cek pricelist di sini ya bro 👉 ${URL}`);
    }
  });
  it("discount/custom still escalate", async () => {
    for (const q of ["ada diskon harga?", "harga custom video berapa?"]) {
      const { desk, sent, init } = setup(); await init();
      await desk.onIncoming(msg(q));
      expect(sent.find(s => s.to === "owner")!.text, q).toContain("Perlu kamu jawab");
    }
  });
});

describe("follow-up after pricelist", () => {
  it("approval mode: draft after 5 min, once, and approve sends it", async () => {
    const { desk, sent, init, adv, lastOwnerButton } = setup(); await init();
    await desk.onIncoming(msg("harga berapa?"));
    await desk.onOwnerAction(lastOwnerButton());               // approve pricelist
    expect(toContact(sent).at(-1)!.text).toContain(URL);
    adv(4); expect(await desk.tickFollowups()).toBe(0);
    adv(2); expect(await desk.tickFollowups()).toBe(1);
    expect(sent.at(-1)!.text).toContain("Follow-up");
    expect(sent.at(-1)!.text).toContain("gimana bro, jadi join?");
    expect(toContact(sent)).toHaveLength(1);                   // nothing sent yet
    await desk.onOwnerAction(lastOwnerButton());
    expect(toContact(sent).at(-1)!.text).toContain("gimana bro");
    // once per conversation
    await desk.onIncoming(msg("pricelist lagi dong"));
    await desk.onOwnerAction(lastOwnerButton());
    adv(10); expect(await desk.tickFollowups()).toBe(0);
  });
  it("cancelled if the customer replies first", async () => {
    const { desk, init, adv } = setup({ auto: true }); await init();
    await desk.onIncoming(msg("harga?"));
    adv(2); await desk.onIncoming(msg("oke bentar aku liat"));
    adv(10); expect(await desk.tickFollowups()).toBe(0);
  });
  it("auto mode: sent directly with a copy to owner", async () => {
    const { desk, sent, init, adv } = setup({ auto: true }); await init();
    await desk.onIncoming(msg("harga?"));
    adv(6); expect(await desk.tickFollowups()).toBe(1);
    expect(toContact(sent).at(-1)!.text).toContain("gimana bro");
    expect(sent.at(-1)!.text).toContain("Follow-up otomatis");
  });
});

describe("payment", () => {
  it("ready to pay with QR: approval draft, then text + QR photo", async () => {
    const { desk, sent, init, lastOwnerButton } = setup({ qr: true }); await init();
    await desk.onIncoming(msg("oke gas mau join, bayar kemana?"));
    expect(toContact(sent)).toHaveLength(0);
    expect(sent.at(-1)!.text).toContain("siap bayar");
    await desk.onOwnerAction(lastOwnerButton());
    const c = toContact(sent);
    expect(c[0].text).toContain("siap bos");
    expect(c[1].photo).toBe("QR_FILE");
    expect(c[1].text).toContain("scan ini ya bos");
  });
  it("auto mode sends QR directly", async () => {
    const { desk, sent, init } = setup({ qr: true, auto: true }); await init();
    await desk.onIncoming(msg("mau join bos, transfer kemana"));
    expect(toContact(sent).map(x => x.photo)).toContain("QR_FILE");
  });
  it("without QR, ready-to-pay escalates with 'siap bos' holding reply", async () => {
    const { desk, sent, init } = setup(); await init();
    await desk.onIncoming(msg("mau join, transfer kemana?"));
    expect(toContact(sent)[0].text).toContain("siap bos");
    expect(sent.find(s => s.to === "owner")!.text).toContain("Perlu kamu jawab");
  });
  it("payment proofs always escalate; bot never confirms", async () => {
    for (const m of [msg("", 7, "PROOF"), msg("udah transfer ya bos"), msg("ini bukti tf")]) {
      const { desk, sent, init } = setup({ qr: true, auto: true }); await init();
      await desk.onIncoming(m);
      const o = sent.find(s => s.to === "owner")!;
      expect(o.text).toContain("Cek pembayaran");
      if (m.photoFileId) expect(o.photo).toBe("PROOF");
      const c = toContact(sent);
      expect(c).toHaveLength(1);
      expect(c[0].text).toContain("admin cek dulu");
      expect(c[0].text).not.toMatch(/lunas|berhasil|aktif|confirmed/i);
    }
  });
  it("/persona shows QR status", async () => {
    const { desk, init } = setup({ qr: true }); await init();
    expect((await desk.onOwnerCommand("/persona"))!.text).toContain("QR pembayaran: ✅");
  });
});

describe("edit pricelist", () => {
  const asks = ["mau order edit foto bro", "harga foto ke video berapa?", "bisa video ke video?", "mau deepfake dong", "face swap berapa bro", "minta pricelist edit"];
  it("edit order/price drafts the edit pricelist image, approve sends photo only", async () => {
    for (const q of asks) {
      const { desk, sent, init, lastOwnerButton } = setup({ edit: true, qr: true }); await init();
      await desk.onIncoming(msg(q));
      const o = sent.find(s => s.to === "owner")!;
      expect(o.text, q).toContain("Order edit");
      expect(toContact(sent), q).toHaveLength(0);
      await desk.onOwnerAction(lastOwnerButton());
      const c = toContact(sent);
      expect(c, q).toHaveLength(1);
      expect(c[0].photo).toBe("EDIT_FILE");
      expect(c[0].text).toContain("pricelist edit nya bro");
      expect(c[0].text).not.toMatch(/\d{3}/);
    }
  });
  it("auto mode sends the image directly", async () => {
    const { desk, sent, init } = setup({ edit: true, auto: true }); await init();
    await desk.onIncoming(msg("mau order edit foto"));
    expect(toContact(sent).at(-1)!.photo).toBe("EDIT_FILE");
  });
  it("custom/complex edit requests escalate", async () => {
    for (const q of ["edit custom durasi panjang bisa?", "deepfake borongan ada diskon?"]) {
      const { desk, sent, init } = setup({ edit: true, qr: true }); await init();
      await desk.onIncoming(msg(q));
      expect(sent.find(s => s.to === "owner")!.text, q).toContain("Perlu kamu jawab");
      expect(toContact(sent).some(s => s.photo), q).toBe(false);
    }
  });
  it("VIP join price still gets the link", async () => {
    const { desk, sent, init } = setup({ edit: true }); await init();
    await desk.onIncoming(msg("harga vip berapa bro?"));
    expect(sent.find(s => s.to === "owner")!.text).toContain(URL);
  });
  it("without an image, falls back to normal flow; /setpricelist and /persona", async () => {
    const { desk, sent, init } = setup(); await init();
    await desk.onIncoming(msg("mau order edit foto"));
    expect(sent.find(s => s.to === "owner")!.text).not.toContain("Order edit");
    expect((await desk.onOwnerCommand("/setpricelist"))!.text).toContain("/setpricelist");
    await desk.setEditPricelist("X");
    expect((await desk.onOwnerCommand("/persona"))!.text).toContain("Pricelist edit: ✅");
  });
});

describe("payment mode", () => {
  const BCA = "transfer ke BCA 6042976624 a.n. MF";
  it("BCA mode drafts transfer text (no QR, no follow-up); /bayarqris switches back", async () => {
    const { desk, sent, init, lastOwnerButton, adv } = setup({ qr: true }); await init();
    expect((await desk.onOwnerCommand("/bayarbca"))!.text).toContain("BCA");
    expect((await desk.onOwnerCommand("/persona"))!.text).toContain("Mode bayar: 🏦 BCA");
    await desk.onIncoming(msg("mau join bayar gimana"));
    expect(sent.at(-1)!.text).toContain(BCA);
    await desk.onOwnerAction(lastOwnerButton());
    const c = toContact(sent);
    expect(c).toHaveLength(1); expect(c[0].photo).toBeUndefined(); expect(c[0].text).toContain(BCA);
    adv(10); expect(await desk.tickFollowups()).toBe(0);
    await desk.onOwnerCommand("/bayarqris");
    expect((await desk.onOwnerCommand("/persona"))!.text).toContain("Mode bayar: 📷 QRIS");
    await desk.onIncoming(msg("mau join bayar gimana", 8));
    await desk.onOwnerAction(lastOwnerButton());
    expect(toContact(sent).at(-1)!.photo).toBe("QR_FILE");
  });
  it("BCA auto mode sends text; proof still escalates", async () => {
    const { desk, sent, init } = setup({ auto: true, qr: true }); await init();
    await desk.onOwnerCommand("/bayarbca");
    await desk.onIncoming(msg("mau transfer"));
    expect(toContact(sent).at(-1)!.text).toContain(BCA);
    await desk.onIncoming(msg("", 7, "PROOF"));
    expect(sent.find(s => s.to === "owner" && s.text.includes("Cek pembayaran"))).toBeTruthy();
  });
});
