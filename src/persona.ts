// Persona mode: replies to third parties as the brand admin (Esse Kuning), with approval-first safety.
import fs from "node:fs";
import path from "node:path";
import type { LLM } from "./llm.js";
import type { Store, UserState, Pending, PersonaOverrides } from "./store.js";
import { newUser } from "./store.js";
import { DEFAULT_TZ } from "./service.js";

export interface PersonaConfig {
  enabled: boolean;
  brand: string;
  ageGate: boolean;         // send ageGateText on first contact
  ageGateText: string;
  refusalText: string;      // sent when a blockPattern matches (minors, consent)
  blockPatterns: string[];  // regexes (case-insensitive): refuse + alert owner, no draft
  approvalMode: boolean;   // draft and ask owner first (default true)
  autoSend: boolean;       // send drafts directly; only honoured when approvalMode is false
  discloseAI: boolean;
  disclosureText: string;
  holdingReply: boolean;
  holdingText: string;
  escalationKeywords: string[];
  maxReplyChars: number;
  pricelistUrl?: string;        // if set, plain price questions get this link instead of escalation
  pricelistText?: string;       // "{url}" is replaced
  priceWords?: string[];        // escalation keywords that are OK in a plain price question
  payIntentPattern?: string;    // regex: customer ready to pay -> escalate with payHoldingText
  payHoldingText?: string;
  followUpMinutes?: number;     // after sending the pricelist, follow up if no reply (0 = off)
  followUpText?: string;
  proofPattern?: string;        // regex: customer says they paid -> escalate (bot never confirms payment)
  proofHoldingText?: string;
  qrReplyText?: string;         // text before the QR photo, e.g. "siap bos"
  qrCaption?: string;
  bcaText?: string;             // ready-to-pay reply when payment mode is BCA
  editPattern?: string;         // regex: member asks to order / price an edit service
  editCustomPattern?: string;   // regex: custom/complex edit request -> escalate
  editPricelistCaption?: string;
}

export const SAFE_DEFAULTS: PersonaConfig = {
  enabled: true, brand: "Esse Kuning", ageGate: true,
  ageGateText: "Layanan ini khusus 18+.", refusalText: "Maaf, layanan ini hanya untuk 18+.",
  blockPatterns: ["di ?bawah ?umur", "underage", "minor", "bocil"], approvalMode: true, autoSend: false, discloseAI: true,
  disclosureText: "(dibalas oleh admin AI)", holdingReply: true,
  holdingText: "Halo, terima kasih sudah menghubungi. Pesannya sudah saya terima, nanti saya kabari lagi ya.",
  escalationKeywords: ["fajrin", "harga", "price", "bayar", "payment", "vip", "custom", "deadline", "sex", "nude"], maxReplyChars: 600,
};

export function loadPersona(dir = process.cwd()): { config: PersonaConfig; text: string } {
  let config = SAFE_DEFAULTS, text = "";
  try { config = { ...SAFE_DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(dir, "persona.config.json"), "utf8")) }; } catch { /* defaults */ }
  try { text = fs.readFileSync(path.join(dir, "persona.md"), "utf8"); } catch { /* empty */ }
  return { config, text };
}

export interface Button { text: string; data: string }
export interface Target { chatId: number; businessConnectionId?: string }
export interface Outbox {
  toOwner(text: string, buttons?: Button[][]): Promise<void>;
  toContact(target: Target, text: string): Promise<void>;
  toContactPhoto?(target: Target, fileId: string, caption: string): Promise<void>;
  toOwnerPhoto?(fileId: string, caption: string, buttons?: Button[][]): Promise<void>;
}

export type FaqEntry = { id: number; q: string; a: string };
export interface Incoming { contactName: string; chatId: number; businessConnectionId?: string; text: string; photoFileId?: string }

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export class PersonaDesk {
  constructor(
    private store: Store, private ownerId: number, private llm: LLM | null, private out: Outbox,
    private persona: { config: PersonaConfig; text: string }, private now: () => number = Date.now,
  ) {}

  private cur?: { config: PersonaConfig; text: string; faq?: FaqEntry[] };
  private get faq(): FaqEntry[] { return this.cur?.faq ?? []; }
  private get cfg() { return this.cur?.config ?? this.persona.config; }
  private get text() { return this.cur?.text ?? this.persona.text; }

  /** Merge owner overrides (soft fields only). Hard rules (blockPatterns, escalationKeywords, refusal, brand) stay fixed. */
  effective(o?: PersonaOverrides): { config: PersonaConfig; text: string; faq: FaqEntry[] } {
    const base = this.persona;
    if (!o) return { ...base, faq: [] };
    const config = { ...base.config };
    if (o.autoSend !== undefined) { config.autoSend = o.autoSend; config.approvalMode = !o.autoSend; }
    if (o.salam) config.ageGateText = /18/.test(o.salam) ? o.salam : `${o.salam}\n\nLayanan ini khusus 18+ (dewasa).`;
    const parts: string[] = [];
    if (o.gaya) parts.push(`## Tone and style (owner override)\n${o.gaya}`);
    if (o.layanan) parts.push(`## Offerings (owner override, non-binding, no prices)\n${o.layanan}`);
    if (o.vip) parts.push(`## VIP info (context only; prices, payments, access always escalated)\n${o.vip}`);
    if (o.info) parts.push(`## Other business info (owner override)\n${o.info}`);
    if (o.contoh?.length) parts.push(`## Chat-style examples (owner)\n${o.contoh.map(c => c.text).join("\n---\n")}`);
    const text = parts.length ? `${base.text}\n\n# Owner overrides (take precedence over TODO placeholders above; hard rules still apply)\n\n${parts.join("\n\n")}` : base.text;
    return { config, text, faq: o.faq ?? [] };
  }
  private withDisclosure(t: string) { return this.cfg.discloseAI ? `${t}\n\n${this.cfg.disclosureText}` : t; }

  private async owner(): Promise<UserState> {
    return (await this.store.get(this.ownerId)) ?? newUser(this.ownerId, this.ownerId, DEFAULT_TZ);
  }

  keywordHit(text: string): string | null {
    const t = text.toLowerCase();
    return this.cfg.escalationKeywords.find(k => new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(t)) ?? null;
  }

  /** Plain price/pricelist question (no payment intent, no other escalation topic). */
  isPriceQuestion(text: string): boolean {
    const c = this.cfg;
    if (!c.pricelistUrl) return false;
    if (!/(harga|price|pricelist|price ?list|paket|berapa|biaya|tarif|rate ?card|list)/i.test(text)) return false;
    if (this.isPayIntent(text)) return false;
    const allowed = new Set((c.priceWords ?? []).map(w => w.toLowerCase()));
    const t = text.toLowerCase();
    return !c.escalationKeywords.some(k => !allowed.has(k.toLowerCase()) &&
      new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(t));
  }
  private matches(p: string | undefined, text: string): boolean {
    try { return !!p && new RegExp(p, "i").test(text); } catch { return false; }
  }
  /** Member asks about ordering an edit service (not custom/complex). */
  isEditRequest(text: string): boolean {
    return this.matches(this.cfg.editPattern, text) && !this.matches(this.cfg.editCustomPattern, text);
  }
  isEditCustom(text: string): boolean {
    return this.matches(this.cfg.editPattern, text) && this.matches(this.cfg.editCustomPattern, text);
  }
  isPayIntent(text: string): boolean {
    const p = this.cfg.payIntentPattern;
    try { return !!p && new RegExp(p, "i").test(text); } catch { return false; }
  }

  /** Send to a contact; if the message carries the pricelist link, schedule a one-time follow-up. */
  private async sendContact(st: UserState, t: Target, contactName: string, text: string) {
    await this.out.toContact(t, text);
    const url = this.cfg.pricelistUrl, mins = this.cfg.followUpMinutes ?? 0;
    const key = String(t.chatId);
    if (url && mins > 0 && text.includes(url) && !(st.followedUp ?? {})[key] && !(st.followups ?? []).some(f => f.chatId === t.chatId)) {
      (st.followups ??= []).push({ chatId: t.chatId, businessConnectionId: t.businessConnectionId, contactName, dueAt: this.now() + mins * 60e3 });
    }
  }

  /** Called from the tick: create due pricelist follow-ups (draft in approval mode, direct in auto mode). */
  async tickFollowups(): Promise<number> {
    const st = await this.owner();
    this.cur = this.effective(st.persona);
    const due = (st.followups ?? []).filter(f => f.dueAt <= this.now());
    if (!due.length) return 0;
    st.followups = st.followups!.filter(f => f.dueAt > this.now());
    st.followedUp ??= {};
    const text = this.cfg.followUpText || "gimana bro, jadi join? kabarin ya";
    for (const f of due) {
      st.followedUp[String(f.chatId)] = this.now();
      const t: Target = { chatId: f.chatId, businessConnectionId: f.businessConnectionId };
      if (!this.cfg.approvalMode && this.cfg.autoSend) {
        await this.out.toContact(t, this.withDisclosure(text));
        await this.out.toOwner(`🤖 Follow-up otomatis terkirim ke ${f.contactName}:\n"${text}"`);
      } else {
        const id = ++st.seq;
        (st.pending ??= []).push({ id, kind: "approval", contactName: f.contactName, contactChatId: f.chatId,
          businessConnectionId: f.businessConnectionId, incoming: "(belum membalas setelah dikirim pricelist)", draft: text, followup: true, created: this.now() });
        await this.out.toOwner(`⏳ Follow-up #${id} untuk ${f.contactName} (belum balas setelah pricelist):\n"${text}"`,
          [[{ text: "✅ Kirim", data: `p:approve:${id}` }, { text: "✏️ Edit", data: `p:edit:${id}` }, { text: "❌ Tolak", data: `p:reject:${id}` }]]);
      }
    }
    await this.store.put(st);
    return due.length;
  }

  blockHit(text: string): string | null {
    return this.cfg.blockPatterns.find(p => { try { return new RegExp(p, "i").test(text); } catch { return false; } }) ?? null;
  }

  /** FAQ entries whose question shares a meaningful word with the message. */
  faqMatches(text: string): FaqEntry[] {
    const stop = new Set(["yang", "ada", "apa", "dan", "itu", "ini", "bro", "kak", "gan", "dong", "sih", "nya", "bisa", "gak", "ga", "nggak", "ngga", "saya", "aku", "kalau", "kalo", "mau", "udah", "sudah"]);
    const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !stop.has(w));
    const m = new Set(words(text));
    return this.faq.filter(f => words(f.q).some(w => m.has(w)));
  }
  /** Escalation keywords that a FAQ answer can never override (money talk, nego, refunds, age, explicit, identity). */
  private hardKeywordHit(text: string): string | null {
    const soft = new Set([...(this.cfg.priceWords ?? []), "order", "pesanan", "request", "req", "link grup"].map(w => w.toLowerCase()));
    const t = text.toLowerCase();
    return this.cfg.escalationKeywords.find(k => !soft.has(k.toLowerCase()) &&
      new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(t)) ?? null;
  }

  async draft(msg: Incoming): Promise<{ reply: string; escalate: boolean; reason: string }> {
    const faq = this.faqMatches(msg.text);
    const kw = faq.length ? this.hardKeywordHit(msg.text) : this.keywordHit(msg.text);
    if (kw) return { reply: "", escalate: true, reason: `topik sensitif/komitmen: "${kw}"` };
    if (!this.llm) return { reply: "", escalate: true, reason: "LLM tidak tersedia" };
    try {
      const r = await this.llm.complete({
        json: true,
        messages: [
          { role: "system", content:
            `You draft Telegram support replies as the ${this.cfg.brand} admin, following this persona:\n\n${this.text}\n\n` +
            `Rules: never write sexual or explicit content; never state prices, payments, VIP access, subscriptions, ` +
            `custom requests, deadlines, promises or commitments; never mention any other brand or the owner's identity; ` +
            `if unsure or the message touches any of those, or age/consent, set escalate=true with reply "". ` +
            `Return JSON {"reply": string, "escalate": boolean, "reason": string}. Reply in the sender's language.` +
            (this.faq.length ? `\n\n## Owner FAQ (authoritative)\nIf the message asks one of these, answer using ONLY the owner's answer, rephrased short and casual in his style ("bro"), and do not escalate. ` +
              `Never add facts, numbers or promises that are not in the answer. If no entry fits, follow the rules above.\n` +
              this.faq.map(f => `Q: ${f.q}\nA: ${f.a}`).join("\n\n") : "") },
          { role: "user", content: `Message from ${msg.contactName}:\n${msg.text}` },
        ],
      });
      const j = JSON.parse(r.content || "{}");
      const reply = typeof j.reply === "string" ? j.reply.trim() : "";
      if (j.escalate === true || !reply) return { reply, escalate: true, reason: String(j.reason || "model tidak yakin") };
      // Also guard the model's own output; words taken from the owner's matched FAQ answers are allowed.
      const fromFaq = faq.map(f => f.a.toLowerCase()).join(" ");
      const kw2 = faq.length ? (this.hardKeywordHit(reply) ?? this.cfg.escalationKeywords.find(k => !fromFaq.includes(k.toLowerCase()) &&
        new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(reply)) ?? null)
        : this.keywordHit(reply);
      if (kw2 && faq.length && fromFaq.includes(kw2.toLowerCase())) { /* owner's own wording */ } else
      if (kw2) return { reply, escalate: true, reason: `draf menyebut "${kw2}"` };
      return { reply: clip(reply, this.cfg.maxReplyChars), escalate: false, reason: "" };
    } catch {
      return { reply: "", escalate: true, reason: "LLM error" };
    }
  }

  async onIncoming(msg: Incoming): Promise<void> {
    const st = await this.owner();
    this.cur = this.effective(st.persona);
    if (!this.cfg.enabled) return;
    st.pending ??= [];
    const head = `👤 ${msg.contactName}${msg.businessConnectionId ? " (akun pribadimu)" : ""}:\n"${clip(msg.text, 800)}"`;
    const target0: Target = { chatId: msg.chatId, businessConnectionId: msg.businessConnectionId };

    // Hard block: possible minors / consent issues. Refuse, alert owner, no draft, no LLM.
    const blocked = this.blockHit(msg.text);
    if (blocked) {
      await this.out.toContact(target0, this.cfg.refusalText);
      await this.out.toOwner(`🚫 DIBLOKIR (indikasi di bawah umur / consent)\n${head}\n\nPola: ${blocked}\nBot sudah menolak. Pertimbangkan blokir pengguna ini.`);
      return;
    }
    const target = target0;
    // Customer replied: cancel any pending pricelist follow-up for this chat.
    if (st.followups?.some(f => f.chatId === msg.chatId)) st.followups = st.followups.filter(f => f.chatId !== msg.chatId);
    st.pending = st.pending.filter(p => !(p.followup && p.contactChatId === msg.chatId));
    // Age gate on first contact.
    st.seenContacts ??= [];
    if (this.cfg.ageGate && !st.seenContacts.includes(msg.chatId)) {
      st.seenContacts.push(msg.chatId);
      await this.store.put(st);
      await this.out.toContact(target0, this.cfg.ageGateText);
    }
    // Payment proof (photo or "udah transfer"): always escalate; the bot never confirms payment or grants VIP.
    const proof = !!msg.photoFileId || this.matches(this.cfg.proofPattern, msg.text);
    if (proof) {
      const id = ++st.seq;
      st.pending.push({ id, kind: "escalation", contactName: msg.contactName, contactChatId: msg.chatId,
        businessConnectionId: msg.businessConnectionId, incoming: msg.text || "(foto)", reason: "bukti pembayaran", created: this.now() });
      await this.store.put(st);
      await this.out.toContact(target, this.withDisclosure(this.cfg.proofHoldingText || "siap bos, admin cek dulu ya 🙏"));
      const cap = `💸 Cek pembayaran #${id}\n${head}\n\nBot TIDAK mengonfirmasi pembayaran/akses VIP. Cek sendiri lalu balas.`;
      const btns = [[{ text: "✍️ Balas", data: `p:edit:${id}` }, { text: "🙈 Abaikan", data: `p:reject:${id}` }]];
      if (msg.photoFileId && this.out.toOwnerPhoto) await this.out.toOwnerPhoto(msg.photoFileId, cap, btns);
      else await this.out.toOwner(cap, btns);
      return;
    }

    // Edit-service order or price: draft the edit pricelist image (prices live only in the image).
    const editImg = st.persona?.editPricelistFileId;
    if (this.isEditRequest(msg.text) && editImg && this.out.toContactPhoto) {
      const caption = this.cfg.editPricelistCaption || "ini pricelist edit nya bro, kirim materi & brief kalau mau order ya 🙏";
      if (!this.cfg.approvalMode && this.cfg.autoSend) {
        await this.out.toContactPhoto(target, editImg, this.withDisclosure(caption));
        await this.out.toOwner(`🤖 Pricelist edit terkirim otomatis ke ${msg.contactName}.\n${head}`);
        return;
      }
      const id = ++st.seq;
      st.pending.push({ id, kind: "approval", contactName: msg.contactName, contactChatId: msg.chatId, businessConnectionId: msg.businessConnectionId,
        incoming: msg.text, draft: caption, photoFileId: editImg, photoCaption: caption, photoOnly: true, created: this.now() });
      await this.store.put(st);
      await this.out.toOwner(`🎬 Order edit #${id}\n${head}\n\nDraf:\n📷 foto pricelist edit: "${caption}"`,
        [[{ text: "✅ Kirim", data: `p:approve:${id}` }, { text: "✏️ Edit", data: `p:edit:${id}` }, { text: "❌ Tolak", data: `p:reject:${id}` }]]);
      return;
    }
    const editCustom = this.isEditCustom(msg.text);
    const payIntent = !editCustom && this.isPayIntent(msg.text);
    if (payIntent && st.persona?.payMode === "bca") {
      const reply = this.cfg.bcaText || "siap bos 🙏 transfer ke BCA 6042976624 a.n. MF ya, no rek juga ada di link https://esse-kuning-website.vercel.app/ . kirim bukti transfer kalau udah";
      if (!this.cfg.approvalMode && this.cfg.autoSend) {
        await this.out.toContact(target, this.withDisclosure(reply));
        await this.out.toOwner(`🤖 Info transfer BCA terkirim otomatis ke ${msg.contactName}.\n${head}`);
        return;
      }
      const id = ++st.seq;
      st.pending.push({ id, kind: "approval", contactName: msg.contactName, contactChatId: msg.chatId, businessConnectionId: msg.businessConnectionId,
        incoming: msg.text, draft: reply, noFollowup: true, created: this.now() });
      await this.store.put(st);
      await this.out.toOwner(`💳 Pelanggan siap bayar #${id} (mode BCA)\n${head}\n\nDraf:\n"${reply}"`,
        [[{ text: "✅ Kirim", data: `p:approve:${id}` }, { text: "✏️ Edit", data: `p:edit:${id}` }, { text: "❌ Tolak", data: `p:reject:${id}` }]]);
      return;
    }
    const qr = st.persona?.qrFileId;
    if (payIntent && qr && this.out.toContactPhoto) {
      const reply = this.cfg.qrReplyText || "siap bos 🙏";
      const caption = this.cfg.qrCaption || "scan ini ya bos, kirim bukti transfer kalau udah";
      if (!this.cfg.approvalMode && this.cfg.autoSend) {
        await this.out.toContact(target, reply);
        await this.out.toContactPhoto(target, qr, this.withDisclosure(caption));
        await this.out.toOwner(`🤖 QR pembayaran terkirim otomatis ke ${msg.contactName}.\n${head}`);
        return;
      }
      const id = ++st.seq;
      st.pending.push({ id, kind: "approval", contactName: msg.contactName, contactChatId: msg.chatId, businessConnectionId: msg.businessConnectionId,
        incoming: msg.text, draft: reply, photoFileId: qr, photoCaption: caption, created: this.now() });
      await this.store.put(st);
      await this.out.toOwner(`💳 Pelanggan siap bayar #${id}\n${head}\n\nDraf:\n"${reply}"\n+ 📷 foto QR: "${caption}"`,
        [[{ text: "✅ Kirim", data: `p:approve:${id}` }, { text: "✏️ Edit", data: `p:edit:${id}` }, { text: "❌ Tolak", data: `p:reject:${id}` }]]);
      return;
    }
    const d = editCustom
      ? { reply: "", escalate: true, reason: "permintaan edit custom/kompleks" }
      : this.isPriceQuestion(msg.text)
      ? { reply: (this.cfg.pricelistText || "cek pricelist di sini ya bro 👉 {url}").replace("{url}", this.cfg.pricelistUrl!), escalate: false, reason: "" }
      : await this.draft(msg);
    if (payIntent && !d.escalate) { d.escalate = true; d.reason = "pelanggan siap bayar"; }

    if (d.escalate) {
      const id = ++st.seq;
      st.pending.push({ id, kind: "escalation", contactName: msg.contactName, contactChatId: msg.chatId,
        businessConnectionId: msg.businessConnectionId, incoming: msg.text, reason: d.reason, created: this.now() });
      await this.store.put(st);
      if (this.cfg.holdingReply) await this.out.toContact(target, this.withDisclosure(payIntent && this.cfg.payHoldingText ? this.cfg.payHoldingText : this.cfg.holdingText));
      await this.out.toOwner(`⚠️ Perlu kamu jawab #${id}\n${head}\n\nAlasan: ${d.reason}` +
        (this.cfg.holdingReply ? "\n(Balasan penahan sudah dikirim.)" : ""),
        [[{ text: "✍️ Balas", data: `p:edit:${id}` }, { text: "🙈 Abaikan", data: `p:reject:${id}` }]]);
      return;
    }

    if (!this.cfg.approvalMode && this.cfg.autoSend) {
      await this.sendContact(st, target, msg.contactName, this.withDisclosure(d.reply));
      await this.store.put(st);
      await this.out.toOwner(`🤖 Terkirim otomatis ke ${msg.contactName}:\n"${d.reply}"\n\n${head}`);
      return;
    }

    const id = ++st.seq;
    st.pending.push({ id, kind: "approval", contactName: msg.contactName, contactChatId: msg.chatId,
      businessConnectionId: msg.businessConnectionId, incoming: msg.text, draft: d.reply, created: this.now() });
    await this.store.put(st);
    await this.out.toOwner(`📝 Draf balasan #${id}\n${head}\n\nDraf:\n"${d.reply}"`,
      [[{ text: "✅ Kirim", data: `p:approve:${id}` }, { text: "✏️ Edit", data: `p:edit:${id}` }, { text: "❌ Tolak", data: `p:reject:${id}` }]]);
  }

  /** Owner sets the payment QR (file_id of a photo). */
  async setQr(fileId: string): Promise<string> {
    const st = await this.owner();
    (st.persona ??= {}).qrFileId = fileId;
    await this.store.put(st);
    return "✅ QR pembayaran disimpan. Dipakai saat pelanggan siap bayar.";
  }

  /** Owner sets the edit-service pricelist image (file_id of a photo). */
  async setEditPricelist(fileId: string): Promise<string> {
    const st = await this.owner();
    (st.persona ??= {}).editPricelistFileId = fileId;
    await this.store.put(st);
    return "✅ Pricelist edit disimpan. Dikirim (sebagai draf) saat member mau order edit.";
  }

  /** Owner persona-editing commands. Returns null if the text is not one of them. */
  async onOwnerCommand(text: string): Promise<{ text: string; buttons?: Button[][] } | null> {
    const m = text.match(/^\/(persona|setgaya|setlayanan|setvip|setinfo|contoh|contohku|hapuscontoh|autobalas|salam|resetpersona|setqr|setpricelist|bayarbca|bayarqris|tambahinfo|info|hapusinfo)(?:@\w+)?(?!\w)\s*([\s\S]*)$/i);
    if (!m) return null;
    const cmd = m[1].toLowerCase(), arg = m[2].trim();
    const st = await this.owner();
    const o: PersonaOverrides = (st.persona ??= {});
    const save = async (t: string) => { await this.store.put(st); return { text: t }; };
    const fields: Record<string, keyof PersonaOverrides> = { setgaya: "gaya", setlayanan: "layanan", setvip: "vip", setinfo: "info", salam: "salam" };
    if (fields[cmd]) {
      const f = fields[cmd];
      if (!arg) return { text: `Isi teksnya. Contoh: /${cmd} ${cmd === "salam" ? "Halo kak, selamat datang di Esse Kuning!" : "..."}\nSekarang: ${(o[f] as string) || "(default)"}` };
      if (/fajrin/i.test(arg)) return { text: "❌ Persona Esse Kuning tidak boleh menyebut Fajrin. Teks tidak disimpan." };
      if (arg.length > 1500) return { text: "❌ Terlalu panjang (maks 1500 karakter)." };
      (o as Record<string, unknown>)[f] = arg;
      const note = cmd === "setvip" ? "\nCatatan: harga, pembayaran & akses VIP tetap selalu dieskalasi ke kamu."
        : cmd === "salam" && !/18/.test(arg) ? "\nCatatan: kalimat 18+ otomatis ditambahkan." : "";
      return save(`✅ ${cmd === "salam" ? "Salam pembuka" : f} disimpan.${note}`);
    }
    switch (cmd) {
      case "persona": return { text: this.describe(st) };
      case "tambahinfo": {
        const i = arg.indexOf("|");
        const q = i < 0 ? "" : arg.slice(0, i).trim(), a = i < 0 ? "" : arg.slice(i + 1).trim();
        if (!q || !a) return { text: "Format: /tambahinfo <pertanyaan> | <jawaban>\nContoh: /tambahinfo grup vvip kebanned | tenang bro, nanti admin kirim link grup baru 🙏" };
        const id = ++st.seq; (o.faq ??= []).push({ id, q: q.slice(0, 300), a: a.slice(0, 800) });
        return save(`✅ Info #${id} ditambahkan (${o.faq.length} total). Lihat /info`);
      }
      case "info":
        return { text: o.faq?.length ? "📚 Info / FAQ:\n\n" + o.faq.map(f => `#${f.id} ❓ ${f.q}\n💬 ${f.a}`).join("\n\n") + "\n\nHapus: /hapusinfo <nomor>" : "Belum ada info. Tambah: /tambahinfo <pertanyaan> | <jawaban>" };
      case "hapusinfo": {
        const id = Number(arg.replace(/^#/, ""));
        const before = o.faq?.length ?? 0;
        o.faq = (o.faq ?? []).filter(f => f.id !== id);
        return before === o.faq.length ? { text: `Info #${arg || "?"} tidak ditemukan. Lihat /info` } : save(`🗑️ Info #${id} dihapus.`);
      }
      case "bayarbca": o.payMode = "bca"; return save("🏦 Mode bayar: BCA. Pelanggan siap bayar dapat draf info transfer BCA (bukan QR). Balik ke QR: /bayarqris");
      case "bayarqris": o.payMode = "qris"; return save(`📷 Mode bayar: QRIS. ${o.qrFileId ? "QR dikirim saat pelanggan siap bayar." : "QR belum ada, kirim foto dengan caption /setqr."}`);
      case "setpricelist": return { text: "Kirim foto pricelist edit dengan caption /setpricelist, atau balas (reply) fotonya dengan /setpricelist." };
      case "setqr": return { text: "Kirim foto QR dengan caption /setqr, atau balas (reply) foto QR dengan /setqr." };
      case "contoh": {
        if (!arg) return { text: "Contoh: /contoh Them: kak ada promo?\nAdmin: halo kak, cek pin channel ya 🙏" };
        if (/fajrin/i.test(arg)) return { text: "❌ Contoh tidak boleh menyebut Fajrin." };
        const id = ++st.seq; (o.contoh ??= []).push({ id, text: arg.slice(0, 800) });
        return save(`✅ Contoh #${id} ditambahkan (${o.contoh.length} total).`);
      }
      case "contohku":
        return { text: o.contoh?.length ? "💬 Contoh gaya chat:\n\n" + o.contoh.map(c => `#${c.id}\n${c.text}`).join("\n\n") : "Belum ada contoh. Tambah dengan /contoh <teks>" };
      case "hapuscontoh": {
        const id = parseInt(arg.replace("#", ""));
        const before = o.contoh?.length ?? 0;
        o.contoh = (o.contoh ?? []).filter(c => c.id !== id);
        return before === o.contoh.length ? { text: `Contoh #${arg || "?"} tidak ditemukan.` } : save(`🗑️ Contoh #${id} dihapus.`);
      }
      case "autobalas": {
        if (/^off$/i.test(arg)) { o.autoSend = false; return save("✅ Auto-balas MATI. Semua balasan AI menunggu persetujuanmu (mode aman)."); }
        if (/^on$/i.test(arg)) return {
          text: "⚠️ Yakin nyalakan auto-balas?\nBalasan AI akan langsung terkirim ke pelanggan TANPA persetujuanmu. " +
            "Topik harga, pembayaran, VIP, custom, umur & konten eksplisit tetap dieskalasi, tapi AI bisa saja salah ucap.",
          buttons: [[{ text: "⚠️ Ya, nyalakan", data: "pa:on" }, { text: "Batal", data: "pa:cancel" }]],
        };
        return { text: `Auto-balas: ${this.effective(o).config.autoSend && !this.effective(o).config.approvalMode ? "ON" : "OFF (mode persetujuan)"}. Pakai /autobalas on atau /autobalas off` };
      }
      case "resetpersona": return {
        text: "Reset semua pengaturan persona ke default (gaya, layanan, VIP, info, salam, contoh, auto-balas OFF)?",
        buttons: [[{ text: "🔄 Ya, reset", data: "pa:reset" }, { text: "Batal", data: "pa:cancel" }]],
      };
    }
    return null;
  }

  describe(st: UserState): string {
    const o = st.persona ?? {};
    const eff = this.effective(o).config;
    const show = (v?: string) => (v ? v : "(default dari persona.md)");
    return [
      `🎭 Persona ${eff.brand}`,
      `Mode: ${eff.autoSend && !eff.approvalMode ? "⚠️ AUTO-BALAS ON" : "✅ Persetujuan (aman)"}`,
      `\nGaya:\n${show(o.gaya)}`,
      `\nLayanan:\n${show(o.layanan)}`,
      `\nVIP (konteks saja):\n${show(o.vip)}`,
      `\nInfo lain:\n${show(o.info)}`,
      `\nSalam pembuka (18+):\n${eff.ageGateText}`,
      `\nContoh chat: ${o.contoh?.length ?? 0} (lihat /contohku)`,
      `Info/FAQ: ${o.faq?.length ?? 0} (lihat /info)`,
      `QR pembayaran: ${o.qrFileId ? "✅ tersimpan" : "❌ belum (kirim foto dengan caption /setqr)"}`,
      `Mode bayar: ${o.payMode === "bca" ? "🏦 BCA (transfer)" : "📷 QRIS"} (ganti: /bayarbca, /bayarqris)`,
      `Pricelist edit: ${o.editPricelistFileId ? "✅ tersimpan" : "❌ belum (kirim foto dengan caption /setpricelist)"}`,
      `Pricelist: ${eff.pricelistUrl ?? "-"} | follow-up ${eff.followUpMinutes ?? 0} menit`,
      `\n🔒 Aturan tetap (tidak bisa diubah): tanpa konten eksplisit, blokir di bawah umur, eskalasi harga/bayar/VIP/custom/janji, tidak menyebut Fajrin.`,
    ].join("\n");
  }

  /** Handle owner button presses. Returns text to show the owner. */
  async onOwnerAction(data: string): Promise<string> {
    const st = await this.owner();
    if (data === "pa:on") { (st.persona ??= {}).autoSend = true; await this.store.put(st); return "⚠️ Auto-balas ON. Matikan kapan saja dengan /autobalas off"; }
    if (data === "pa:reset") { st.persona = { qrFileId: st.persona?.qrFileId, editPricelistFileId: st.persona?.editPricelistFileId, payMode: st.persona?.payMode, faq: st.persona?.faq }; await this.store.put(st); return "🔄 Persona direset ke default. Auto-balas OFF."; }
    if (data === "pa:cancel") return "Dibatalkan, tidak ada yang berubah.";
    const m = data.match(/^p:(approve|edit|reject):(\d+)$/);
    if (!m) return "Aksi tidak dikenal.";
    const p = st.pending?.find(x => x.id === +m[2]);
    if (!p) return "Sudah diproses atau tidak ditemukan.";
    if (m[1] === "approve") {
      if (!p.draft) return "Tidak ada draf. Pakai ✍️ Balas.";
      this.cur = this.effective(st.persona);
      if (p.photoFileId && this.out.toContactPhoto) {
        if (!p.photoOnly) await this.out.toContact(this.target(p), p.draft);
        await this.out.toContactPhoto(this.target(p), p.photoFileId, this.withDisclosure(p.photoCaption || ""));
      } else if (p.noFollowup) await this.out.toContact(this.target(p), this.withDisclosure(p.draft));
      else await this.sendContact(st, this.target(p), p.contactName, this.withDisclosure(p.draft));
      this.drop(st, p.id); await this.store.put(st);
      return `✅ Terkirim ke ${p.contactName}.`;
    }
    if (m[1] === "reject") {
      this.drop(st, p.id); await this.store.put(st);
      return `❌ #${p.id} diabaikan, tidak ada yang dikirim.`;
    }
    st.awaitingReplyFor = p.id; await this.store.put(st);
    return `✏️ Ketik balasan untuk ${p.contactName} (#${p.id}). Kirim /batal untuk membatalkan.`;
  }

  /** If the owner is typing a reply for a pending item, consume the message. Returns null when not applicable. */
  async onOwnerText(text: string): Promise<string | null> {
    const st = await this.owner();
    if (!st.awaitingReplyFor) {
      const m = text.match(/^\/balas\s+#?(\d+)\s+([\s\S]+)/);
      if (!m) return null;
      st.awaitingReplyFor = +m[1]; text = m[2];
    }
    const id = st.awaitingReplyFor;
    st.awaitingReplyFor = undefined;
    if (/^\/batal\b/.test(text)) { await this.store.put(st); return "Dibatalkan."; }
    const p = st.pending?.find(x => x.id === id);
    if (!p) { await this.store.put(st); return "Item sudah tidak ada."; }
    this.cur = this.effective(st.persona);
    await this.sendContact(st, this.target(p), p.contactName, text); // written by Fajrin himself: no AI disclosure
    this.drop(st, p.id); await this.store.put(st);
    return `✅ Balasanmu terkirim ke ${p.contactName}.`;
  }

  private target(p: Pending): Target { return { chatId: p.contactChatId, businessConnectionId: p.businessConnectionId }; }
  private drop(st: UserState, id: number) { st.pending = (st.pending ?? []).filter(x => x.id !== id); }
}
