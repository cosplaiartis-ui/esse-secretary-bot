// Uploads an image to the owner chat and stores its file_id as the edit pricelist.
// Usage: npx tsx scripts/seed-pricelist.ts <path-to-image>
import { loadSecrets } from "../src/env.js";
import { Api, InputFile } from "grammy";
import { storeFromEnv } from "../src/store.js";
import { PersonaDesk, loadPersona } from "../src/persona.js";
import { ownerId, makeOutbox } from "../src/bot.js";
loadSecrets();
const path = process.argv[2];
if (!path) throw new Error("usage: seed-pricelist.ts <image>");
const owner = ownerId();
const api = new Api(process.env.TELEGRAM_BOT_TOKEN!);
const m = await api.sendPhoto(owner, new InputFile(path), { caption: "Pricelist edit tersimpan. Ganti kapan saja: kirim foto baru dengan caption /setpricelist" });
const fileId = m.photo![m.photo!.length - 1].file_id;
const desk = new PersonaDesk(storeFromEnv(), owner, null as any, makeOutbox(api, owner), loadPersona());
console.log(await desk.setEditPricelist(fileId));
