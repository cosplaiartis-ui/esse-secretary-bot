import { loadSecrets } from "../src/env.js";
loadSecrets();
// Local run mode.
// - With TELEGRAM_BOT_TOKEN: long polling against Telegram plus an in-process tick every 60s.
// - Without a token: interactive console that talks to the same Secretary logic (no network).
import readline from "node:readline";
import { Api } from "grammy";
import { createBot } from "../src/bot.js";
import { Secretary } from "../src/service.js";
import { SecretaryBrain } from "../src/brain.js";
import { llmFromEnv } from "../src/llm.js";
import { storeFromEnv } from "../src/store.js";

const store = storeFromEnv();
const token = process.argv.includes("--console") ? undefined : process.env.TELEGRAM_BOT_TOKEN;

if (token) {
  const bot = createBot(token, store);
  const api = new Api(token);
  const sec = new Secretary(store);
  setInterval(async () => {
    for (const m of await sec.tick()) await api.sendMessage(m.chatId, m.text);
  }, 60e3);
  await bot.api.deleteWebhook(); // polling and webhook are mutually exclusive
  console.log("Long polling started. Ctrl+C to stop.");
  bot.start();
} else {
  const sec = new Secretary(store);
  const UID = 1;
  console.log("Console mode (no TELEGRAM_BOT_TOKEN). Type commands like /help, /ingat 1 menit lagi tes. Ctrl+D to quit.");
  setInterval(async () => { for (const m of await sec.tick()) console.log(`\n[bot] ${m.text}\n> `); }, 15e3);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  const brain = new SecretaryBrain(sec, process.argv.includes("--llm") ? llmFromEnv() : null);
  rl.on("line", async (line: string) => { console.log(await brain.handle(UID, UID, line)); rl.prompt(); });
  rl.on("close", () => process.exit(0));
}
