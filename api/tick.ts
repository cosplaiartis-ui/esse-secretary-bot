import { loadSecrets } from "../src/env.js";
loadSecrets();
import type { IncomingMessage, ServerResponse } from "node:http";
import { Api } from "grammy";
import { Secretary } from "../src/service.js";
import { storeFromEnv } from "../src/store.js";
import { makeOutbox, ownerId } from "../src/bot.js";
import { PersonaDesk, loadPersona } from "../src/persona.js";

// Hit every 5 minutes by GitHub Actions (or cron-job.org) with Authorization: Bearer <CRON_SECRET>.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.statusCode = 401; return res.end("unauthorized");
  }
  const api = new Api(process.env.TELEGRAM_BOT_TOKEN!);
  const store = storeFromEnv();
  const owner = ownerId();
  const msgs = await new Secretary(store, Date.now, owner).tick();
  for (const m of msgs) await api.sendMessage(m.chatId, m.text);
  const followups = owner ? await new PersonaDesk(store, owner, null, makeOutbox(api, owner), loadPersona()).tickFollowups() : 0;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ sent: msgs.length, followups }));
}
