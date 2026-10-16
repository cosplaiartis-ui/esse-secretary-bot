import { Api, Bot, InlineKeyboard } from "grammy";
import { Secretary } from "./service.js";
import { SecretaryBrain } from "./brain.js";
import { PersonaDesk, loadPersona, Outbox, Button } from "./persona.js";
import { Store } from "./store.js";
import { LLM, llmFromEnv } from "./llm.js";

/** Comma-separated Telegram numeric user ids allowed secretary access. The first one is the owner. */
export function allowlist(): number[] {
  return (process.env.ALLOWED_USER_IDS || "").split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
}

const kb = (rows?: Button[][]) => {
  if (!rows) return undefined;
  const k = new InlineKeyboard();
  rows.forEach((r, i) => { r.forEach(b => k.text(b.text, b.data)); if (i < rows.length - 1) k.row(); });
  return k;
};

export function ownerId(): number { return Number(process.env.OWNER_USER_ID) || allowlist()[0]; }

export function makeOutbox(api: Api, ownerId: number): Outbox {
  return {
    toOwner: async (text, buttons) => { if (ownerId) await api.sendMessage(ownerId, text, { reply_markup: kb(buttons) }); },
    toContact: async (t, text) => { await api.sendMessage(t.chatId, text, t.businessConnectionId ? { business_connection_id: t.businessConnectionId } : {}); },
    toContactPhoto: async (t, fileId, caption) => {
      await api.sendPhoto(t.chatId, fileId, { caption, ...(t.businessConnectionId ? { business_connection_id: t.businessConnectionId } : {}) });
    },
    toOwnerPhoto: async (fileId, caption, buttons) => { if (ownerId) await api.sendPhoto(ownerId, fileId, { caption, reply_markup: kb(buttons) }); },
    isGroupMember: async (groupId, userId) => {
      const m = await api.getChatMember(groupId, userId);
      return ["member", "administrator", "creator", "restricted"].includes(m.status) && !(m.status === "restricted" && m.is_member === false);
    },
  };
}

export function createBot(token: string, store: Store, llm: LLM | null = llmFromEnv()): Bot {
  const bot = new Bot(token);
  const allowed = allowlist();
  const ownerId = Number(process.env.OWNER_USER_ID) || allowed[0];
  const sec = new Secretary(store, Date.now, ownerId);
  const brain = new SecretaryBrain(sec, llm);
  const out = makeOutbox(bot.api, ownerId);
  const persona = new PersonaDesk(store, ownerId, llm, out, loadPersona());
  const verifiedConnections = new Map<string, boolean>();

  // Secretary (owner) and persona (everyone else) in private chats with the bot.
  bot.chatType("private").on("message:text", async ctx => {
    const uid = ctx.from.id;
    if (allowed.includes(uid)) {
      if (uid === ownerId) {
        const rp = ctx.message.reply_to_message?.photo;
        if (/^\/setqr\b/i.test(ctx.message.text) && rp?.length) { await ctx.reply(await persona.setQr(rp[rp.length - 1].file_id)); return; }
        if (/^\/setpricelist\b/i.test(ctx.message.text) && rp?.length) { await ctx.reply(await persona.setEditPricelist(rp[rp.length - 1].file_id)); return; }
        const rt = ctx.message.reply_to_message;
        const mr = ctx.message.text.match(/^\/member(?:@\w+)?(?:\s+(\d+))?\s*$/i);
        if (mr && rt && (rt.text || rt.caption)) { await ctx.reply(await persona.memberFromCard(rt.text || rt.caption || "", mr[1] ? Number(mr[1]) : undefined)); return; }
        const pc = await persona.onOwnerCommand(ctx.message.text);
        if (pc) { await ctx.reply(pc.text, { reply_markup: kb(pc.buttons) }); return; }
      }
      const consumed = uid === ownerId ? await persona.onOwnerText(ctx.message.text) : null;
      await ctx.reply(consumed ?? (await brain.handle(uid, ctx.chat.id, ctx.message.text)));
      return;
    }
    if (!ownerId || !loadPersona().config.enabled) {
      await ctx.reply(`Maaf, bot ini pribadi. (id kamu: ${uid})`);
      return;
    }
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") + (ctx.from.username ? ` @${ctx.from.username}` : "");
    await persona.onIncoming({ contactName: `${name} (id ${uid})`, chatId: ctx.chat.id, text: ctx.message.text });
  });

  // Photos: owner /setqr, customers' payment proofs.
  bot.chatType("private").on("message:photo", async ctx => {
    const uid = ctx.from.id;
    const ph = ctx.message.photo, fileId = ph[ph.length - 1].file_id, cap = ctx.message.caption ?? "";
    if (uid === ownerId) {
      await ctx.reply(/^\/setqr\b/i.test(cap) ? await persona.setQr(fileId)
        : /^\/setpricelist\b/i.test(cap) ? await persona.setEditPricelist(fileId)
        : "Foto diterima. Caption /setqr untuk QR pembayaran, atau /setpricelist untuk pricelist edit.");
      return;
    }
    if (allowed.includes(uid) || !ownerId) return;
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") + (ctx.from.username ? ` @${ctx.from.username}` : "");
    await persona.onIncoming({ contactName: `${name} (id ${uid})`, chatId: ctx.chat.id, text: cap, photoFileId: fileId });
  });

  // VIP groups: owner runs /setgrupvip inside the group (bot must be admin), or promotes the bot to admin.
  const registerGroup = async (chatId: number, title: string): Promise<string> => {
    const me = await bot.api.getMe();
    const cm = await bot.api.getChatMember(chatId, me.id);
    if (cm.status !== "administrator") return "Jadikan bot admin di grup ini dulu, lalu kirim /setgrupvip lagi.";
    const r = await persona.addVipGroup(chatId, title);
    await out.toOwner(r);
    return "✅ Grup ini terdaftar sebagai grup VIP.";
  };
  bot.chatType(["group", "supergroup"]).command("setgrupvip", async ctx => {
    if (ctx.from?.id !== ownerId) return;
    await ctx.reply(await registerGroup(ctx.chat.id, ctx.chat.title ?? String(ctx.chat.id)));
  });
  bot.on("my_chat_member", async ctx => {
    const u = ctx.myChatMember, c = u.chat;
    if (c.type !== "group" && c.type !== "supergroup") return;
    if (u.from.id !== ownerId || u.new_chat_member.status !== "administrator") return;
    const t = (c as { title?: string }).title ?? String(c.id);
    await persona.addVipGroup(c.id, t).then(r => out.toOwner(r));
  });

  // Owner quick actions (Approve / Edit / Reject).
  bot.on("callback_query:data", async ctx => {
    if (ctx.from.id !== ownerId) { await ctx.answerCallbackQuery(); return; }
    const msg = await persona.onOwnerAction(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery({ text: msg.slice(0, 190) });
    await ctx.reply(msg);
  });

  // Telegram Business: bot connected to Fajrin's personal account (requires Telegram Premium).
  bot.on("business_connection", ctx => {
    const c = ctx.businessConnection;
    verifiedConnections.set(c.id, c.user.id === ownerId && c.is_enabled);
  });
  bot.on(["business_message:text", "business_message:photo"], async ctx => {
    const m = ctx.businessMessage;
    const cid = m.business_connection_id;
    if (!cid) return;
    if (!verifiedConnections.has(cid)) {
      const c = await ctx.api.getBusinessConnection(cid);
      verifiedConnections.set(cid, c.user.id === ownerId && c.is_enabled);
    }
    if (!verifiedConnections.get(cid)) return;      // connection not owned by Fajrin
    if (!m.from || m.from.id === ownerId) return;   // Fajrin typing himself
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") + (m.from.username ? ` @${m.from.username}` : "");
    await persona.onIncoming({ contactName: `${name} (id ${m.from.id})`, chatId: m.chat.id, businessConnectionId: cid, text: m.text ?? m.caption ?? "",
      photoFileId: m.photo ? m.photo[m.photo.length - 1].file_id : undefined });
  });

  return bot;
}
