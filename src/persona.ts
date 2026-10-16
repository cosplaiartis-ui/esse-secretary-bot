// Persona mode: replies to third parties as the brand admin (Esse Kuning), with approval-first safety.
import fs from "node:fs";
import path from "node:path";
import type { LLM } from "./llm.js";
import type { Store, UserState, Pending } from "./store.js";
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
}

export interface Incoming { contactName: string; chatId: number; businessConnectionId?: string; text: string }

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export class PersonaDesk {
  constructor(
    private store: Store, private ownerId: number, private llm: LLM | null, private out: Outbox,
    private persona: { config: PersonaConfig; text: string }, private now: () => number = Date.now,
  ) {}

  private get cfg() { return this.persona.config; }
  private withDisclosure(t: string) { return this.cfg.discloseAI ? `${t}\n\n${this.cfg.disclosureText}` : t; }

  private async owner(): Promise<UserState> {
    return (await this.store.get(this.ownerId)) ?? newUser(this.ownerId, this.ownerId, DEFAULT_TZ);
  }

  keywordHit(text: string): string | null {
    const t = text.toLowerCase();
    return this.cfg.escalationKeywords.find(k => new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(t)) ?? null;
  }

  blockHit(text: string): string | null {
    return this.cfg.blockPatterns.find(p => { try { return new RegExp(p, "i").test(text); } catch { return false; } }) ?? null;
  }

  async draft(msg: Incoming): Promise<{ reply: string; escalate: boolean; reason: string }> {
    const kw = this.keywordHit(msg.text);
    if (kw) return { reply: "", escalate: true, reason: `topik sensitif/komitmen: "${kw}"` };
    if (!this.llm) return { reply: "", escalate: true, reason: "LLM tidak tersedia" };
    try {
      const r = await this.llm.complete({
        json: true,
        messages: [
          { role: "system", content:
            `You draft Telegram support replies as the ${this.cfg.brand} admin, following this persona:\n\n${this.persona.text}\n\n` +
            `Rules: never write sexual or explicit content; never state prices, payments, VIP access, subscriptions, ` +
            `custom requests, deadlines, promises or commitments; never mention any other brand or the owner's identity; ` +
            `if unsure or the message touches any of those, or age/consent, set escalate=true with reply "". ` +
            `Return JSON {"reply": string, "escalate": boolean, "reason": string}. Reply in the sender's language.` },
          { role: "user", content: `Message from ${msg.contactName}:\n${msg.text}` },
        ],
      });
      const j = JSON.parse(r.content || "{}");
      const reply = typeof j.reply === "string" ? j.reply.trim() : "";
      if (j.escalate === true || !reply) return { reply, escalate: true, reason: String(j.reason || "model tidak yakin") };
      const kw2 = this.keywordHit(reply); // also guard the model's own output
      if (kw2) return { reply, escalate: true, reason: `draf menyebut "${kw2}"` };
      return { reply: clip(reply, this.cfg.maxReplyChars), escalate: false, reason: "" };
    } catch {
      return { reply: "", escalate: true, reason: "LLM error" };
    }
  }

  async onIncoming(msg: Incoming): Promise<void> {
    if (!this.cfg.enabled) return;
    const st = await this.owner();
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
    // Age gate on first contact.
    st.seenContacts ??= [];
    if (this.cfg.ageGate && !st.seenContacts.includes(msg.chatId)) {
      st.seenContacts.push(msg.chatId);
      await this.store.put(st);
      await this.out.toContact(target0, this.cfg.ageGateText);
    }
    const d = await this.draft(msg);

    if (d.escalate) {
      const id = ++st.seq;
      st.pending.push({ id, kind: "escalation", contactName: msg.contactName, contactChatId: msg.chatId,
        businessConnectionId: msg.businessConnectionId, incoming: msg.text, reason: d.reason, created: this.now() });
      await this.store.put(st);
      if (this.cfg.holdingReply) await this.out.toContact(target, this.withDisclosure(this.cfg.holdingText));
      await this.out.toOwner(`⚠️ Perlu kamu jawab #${id}\n${head}\n\nAlasan: ${d.reason}` +
        (this.cfg.holdingReply ? "\n(Balasan penahan sudah dikirim.)" : ""),
        [[{ text: "✍️ Balas", data: `p:edit:${id}` }, { text: "🙈 Abaikan", data: `p:reject:${id}` }]]);
      return;
    }

    if (!this.cfg.approvalMode && this.cfg.autoSend) {
      await this.out.toContact(target, this.withDisclosure(d.reply));
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

  /** Handle owner button presses. Returns text to show the owner. */
  async onOwnerAction(data: string): Promise<string> {
    const m = data.match(/^p:(approve|edit|reject):(\d+)$/);
    if (!m) return "Aksi tidak dikenal.";
    const st = await this.owner();
    const p = st.pending?.find(x => x.id === +m[2]);
    if (!p) return "Sudah diproses atau tidak ditemukan.";
    if (m[1] === "approve") {
      if (!p.draft) return "Tidak ada draf. Pakai ✍️ Balas.";
      await this.out.toContact(this.target(p), this.withDisclosure(p.draft));
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
    await this.out.toContact(this.target(p), text); // written by Fajrin himself: no AI disclosure
    this.drop(st, p.id); await this.store.put(st);
    return `✅ Balasanmu terkirim ke ${p.contactName}.`;
  }

  private target(p: Pending): Target { return { chatId: p.contactChatId, businessConnectionId: p.businessConnectionId }; }
  private drop(st: UserState, id: number) { st.pending = (st.pending ?? []).filter(x => x.id !== id); }
}
