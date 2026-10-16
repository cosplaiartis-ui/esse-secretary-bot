// Registers the owner command menu. Usage: npx tsx scripts/set-commands.ts (reads env / secrets file).
import { loadSecrets } from "../src/env.js";
import { Api } from "grammy";
import { OWNER_COMMANDS } from "../src/commands.js";
import { allowlist } from "../src/bot.js";
loadSecrets();
const owner = Number(process.env.OWNER_USER_ID) || allowlist()[0];
if (!owner) throw new Error("no owner id");
const api = new Api(process.env.TELEGRAM_BOT_TOKEN!);
await api.setMyCommands(OWNER_COMMANDS, { scope: { type: "chat", chat_id: owner } });
const got = await api.getMyCommands({ scope: { type: "chat", chat_id: owner } });
console.log(`registered ${got.length} commands for owner chat`);
for (const c of got) console.log(`/${c.command} - ${c.description}`);
