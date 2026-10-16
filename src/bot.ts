import { Bot, InlineKeyboard } from "grammy";
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

export function createBot(token: string, store: Store, llm: LLM | null = llmFromEnv()): Bot {
  const bot = new Bot(token);
  const sec = new Secretary(store);
  const brain = new SecretaryBrain(sec, llm);
  const allowed = allowlist();
  const ownerId = Number(process.env.OWNER_USER_ID) || allowed[0];
  const out: Outbox = {
    toOwner: async (text, buttons) => { if (ownerId) await bot.api.sendMessage(ownerId, text, { reply_markup: kb(buttons) }); },
    toContact: async (t, text) => { await bot.api.sendMessage(t.chatId, text, t.businessConnectionId ? { business_connection_id: t.businessConnectionId } : {}); },
  };
  const persona = new PersonaDesk(store, ownerId, llm, out, loadPersona());
  const verifiedConnections = new Map<string, boolean>();

  // Secretary (owner) and persona (everyone else) in private chats with the bot.
  bot.chatType("private").on("message:text", async ctx => {
    const uid = ctx.from.id;
    if (allowed.includes(uid)) {
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
  bot.on("business_message:text", async ctx => {
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
    await persona.onIncoming({ contactName: `${name} (id ${m.from.id})`, chatId: m.chat.id, businessConnectionId: cid, text: m.text });
  });

  return bot;
}
