# Telegram Secretary Bot (@essesuportbot)

Owner gets secretary mode; everyone else gets the Esse Kuning support/admin persona (18+, approval-first).

Personal Telegram secretary (Indonesian UI). See ARCHITECTURE.md for design.

## Develop
```
npm install
npm test            # parser + reminder/summary logic
npm run typecheck
npm run dev         # console mode without a token; long polling if TELEGRAM_BOT_TOKEN is set
```
For long polling: `TELEGRAM_BOT_TOKEN=... ALLOWED_USER_IDS=<id> npm run dev` (in-memory store unless Upstash env vars are set).

## Commands
/ingat, /pengingat, /hapusingat, /jadwal, /hariini, /mingguini, /hapusjadwal, /catat, /catatan, /cari,
/hapuscatat, /tugas, /tugasku, /selesai, /hapustugas, /zona, /ringkasan, /ringkas, /help.
Plain text starting with "ingatkan ..." or "remind ..." also works.

## Deploy (only after approval)
1. Fajrin: create bot in @BotFather, get token. Create Upstash Redis (free, no card).
2. Vercel project from this repo; env: TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, WEBHOOK_SECRET, CRON_SECRET,
   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN.
3. Set webhook (include allowed_updates for business mode):
   `curl "https://api.telegram.org/bot$TOKEN/setWebhook" -d url=https://<app>.vercel.app/api/webhook -d secret_token=$WEBHOOK_SECRET -d allowed_updates='["message","callback_query","business_connection","business_message"]'`
4. GitHub repo secrets: CRON_SECRET, TICK_URL=https://<app>.vercel.app/api/tick (repo public, or use cron-job.org).
5. Send /start to the bot and test /ingat 6 menit lagi tes.

## LLM and persona
- LLM: Groq by default (GROQ_API_KEY, LLM_MODEL), OpenAI optional. Secrets load automatically from /workspace/secrets/secretary-bot.env (or SECRETS_FILE). Never commit them.
- `npm run console` = offline console (rule-based); `npx tsx scripts/local.ts --console --llm` adds the LLM.
- Edit persona.md and persona.config.json. Defaults: approvalMode on, autoSend off, discloseAI on.
