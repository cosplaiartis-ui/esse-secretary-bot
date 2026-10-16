import { loadSecrets } from "../src/env.js";
loadSecrets();
import type { IncomingMessage, ServerResponse } from "node:http";
import { Api } from "grammy";
import { Secretary } from "../src/service.js";
import { storeFromEnv } from "../src/store.js";

// Hit every 5 minutes by GitHub Actions (or cron-job.org) with Authorization: Bearer <CRON_SECRET>.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.statusCode = 401; return res.end("unauthorized");
  }
  const api = new Api(process.env.TELEGRAM_BOT_TOKEN!);
  const msgs = await new Secretary(storeFromEnv()).tick();
  for (const m of msgs) await api.sendMessage(m.chatId, m.text);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ sent: msgs.length }));
}
