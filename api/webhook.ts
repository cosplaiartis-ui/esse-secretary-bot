import { loadSecrets } from "../src/env.js";
loadSecrets();
import { webhookCallback } from "grammy";
import { createBot } from "../src/bot.js";
import { storeFromEnv } from "../src/store.js";

const bot = createBot(process.env.TELEGRAM_BOT_TOKEN!, storeFromEnv());
// Telegram sends X-Telegram-Bot-Api-Secret-Token when setWebhook was called with secret_token.
export default webhookCallback(bot, "https", { secretToken: process.env.WEBHOOK_SECRET, timeoutMilliseconds: 9500 });
