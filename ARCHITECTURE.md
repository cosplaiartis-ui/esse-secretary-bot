# Telegram Secretary Bot: Architecture

Single-user personal secretary on Telegram: scheduling, reminders, notes, daily tasks.
Constraint: runs entirely on free tiers that require no credit card.

## Components

```
Telegram  --webhook-->  Vercel Function  api/webhook.ts (grammY)  --> Secretary (src/service.ts)
                                                                        |
GitHub Actions cron (*/5) --POST Bearer CRON_SECRET--> api/tick.ts -----+--> Store (Upstash Redis REST)
                                                     sends due reminders + morning summary via Bot API
```

- `src/parser.ts`: rule-based Indonesian/English time parser ("ingatkan besok jam 9 rapat",
  "30 menit lagi", "tiap senin jam 8", "setiap tanggal 1", "every weekday at 8:30", "20/10 14:00").
- `src/time.ts`: timezone math using `Intl` only (no date library). Per-user `tz`, default `Asia/Makassar`.
- `src/service.ts`: all command logic, independent of Telegram, returns reply text. `tick()` fires due
  reminders, reschedules recurring ones, sends the morning summary once per day, prunes old data.
- `src/store.ts`: one JSON document per user. `RedisStore` (Upstash REST over `fetch`) in production,
  `MemoryStore` locally and in tests.
- `src/bot.ts`: grammY wiring plus allowlist middleware (`ALLOWED_USER_IDS`). Anyone else gets a
  refusal that shows their own id (handy for finding Fajrin's id on first contact).
- `scripts/local.ts`: local mode. With a token: long polling plus in-process tick. Without a token:
  interactive console using the same logic, no network.

## Decisions

### Host: Vercel Hobby (serverless webhook)
Free, no card, already used for HT Rahasia / Chat Rahasia, and a Vercel connector exists.
Webhook mode means no always-on process. Function timeout of 10 s is plenty.

### Storage: Upstash Redis (free tier)
| Option | Card needed | Notes |
| --- | --- | --- |
| Upstash Redis (direct or via Vercel Marketplace) | No | 500K commands/month, 256 MB. REST API works from serverless with plain `fetch`. **Chosen.** |
| Neon Postgres (direct or via Vercel Marketplace) | No | 0.5 GB free. Good, but needs SQL schema/driver; overkill for one user. Fallback option. |
| Turso (libSQL) | No | Free tier generous; extra client lib. Viable alternative. |
| Supabase | No | Free projects pause after 1 week of inactivity; riskier for a reminder bot. |
| Vercel Blob/Edge Config | No | Not suited to frequent writes. |

Usage estimate: tick every 5 min = 8,640 ticks/month, roughly 3 to 5 commands each, plus chat traffic:
about 50K commands/month, about 10% of the Upstash free quota.

Sign-up: Fajrin must create the database himself, either at upstash.com (GitHub/Google login, no card)
or through the Vercel dashboard Storage tab (Marketplace, Upstash, Free plan), which injects
`KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically. Both env name styles are supported.
(Free-tier facts above are from vendor pricing pages as known at build time; the local api-hunter
DB has no entries for these storage vendors, so re-check pricing before sign-up.)

### Scheduler: GitHub Actions cron every 5 minutes
Vercel Hobby cron runs at most once per day, too coarse for reminders.
| Option | Card | Notes |
| --- | --- | --- |
| GitHub Actions `schedule` | No | Free for public repos and 2,000 min/month on private (each run is about 10 s, rounded to 1 min: about 8,640 min/month, so the repo **must be public** or interval raised to 15 min). Can be delayed a few minutes under load. **Chosen**, `.github/workflows/tick.yml`. |
| cron-job.org | No | Free, 1-minute interval, needs an account Fajrin creates. Best precision; recommended backup or replacement. |
| Cloudflare Workers Cron Triggers | No | Free, reliable, needs Cloudflare account and a tiny worker. Good alternative since Orchestrator is already registering Cloudflare. |

Reminder precision is therefore about 5 minutes (GitHub) or 1 minute (cron-job.org). The endpoint is
idempotent: reminders are removed or rescheduled when fired, the summary is keyed by local date.
Missed ticks are caught up and marked "terlambat" when over an hour late.

### Parsing: rule-based, no LLM
Groq, Gemini and Cloudflare Workers AI are listed FREE_CONFIRMED in api-hunter, but all need an account
and key, add latency and failure modes, and Gemini's free tier uses content for training (not great for
a private secretary). The rule-based parser covers the required phrases and is fully unit tested.
An LLM fallback for unparsed input can be added later behind an env flag.

## Security
- Allowlist by numeric Telegram user id (`ALLOWED_USER_IDS`); empty list means nobody is served.
- Webhook verified with Telegram `secret_token` header (`WEBHOOK_SECRET`).
- Tick endpoint requires `Authorization: Bearer CRON_SECRET`.
- No secrets in the repo; `.env*` ignored, `.env.example` lists names only.
- Data is stored unencrypted in Upstash (TLS in transit). Do not store passwords in notes.

## Known limits
- Read-modify-write per user without locking; a message arriving during a tick could in rare cases
  overwrite one change. Acceptable for a single user; fix with WATCH/MULTI or Postgres if needed.
- Lists cap to the most recent 20 notes; events auto-pruned after 30 days, done tasks after 7 days.
- Undone tasks carry over and are shown as "tertunda".

## v2: LLM brain and business persona

### Secrets
`src/env.ts` loads `/workspace/secrets/secretary-bot.env` (override with `SECRETS_FILE`) into
`process.env` at startup, never overriding existing env and never logging values. On Vercel the file
does not exist and normal project env vars are used. Errors from OpenAI only expose the HTTP status.

### Secretary brain (owner only), `src/brain.ts`
- Provider abstraction in `src/llm.ts` over any OpenAI-compatible Chat Completions API.
  Default provider: **Groq** (`https://api.groq.com/openai/v1`, key `GROQ_API_KEY`, model `LLM_MODEL`,
  default `openai/gpt-oss-120b`, active on Groq as of 2026-10-16 with tool calling and JSON mode;
  `llama-3.3-70b-versatile` is retired; `qwen/qwen3.8-27b` is an alternative). OpenAI remains optional (`OPENAI_API_KEY`, `LLM_PROVIDER=openai`).
  Selection: `LLM_PROVIDER` (default `groq`); OpenAI only with `LLM_PROVIDER=openai`; no key means rule-based only.
- Tools: add/list/delete reminder, add event, agenda, delete event, add/list/search note,
  add/list/complete task, daily summary. Each tool maps to an existing slash command, so the
  rule-based parser stays the single source of truth for time handling.
- Slash commands skip the LLM. Any LLM error, timeout (8 s) or missing key falls back to the
  rule-based handler. `LLM_DISABLED=1` forces rule-based.
- Cost: Groq has a free plan (no card; FREE_CONFIRMED in api-hunter) with per-model RPM/RPD/TPM limits,
  ample for one user. OpenAI, if used instead, is paid (prepaid credit).

### Persona mode (everyone except the owner), `src/persona.ts`
Config: `persona.md` (tone, business info, limits, chat-style example placeholder) and
`persona.config.json` (flags). The bot (@essesuportbot) speaks only as the **Esse Kuning** support/admin
(@ehseekuning, an 18+ VIP content business). It is fully separate from Fajrin's personal creative brand:
any mention of Fajrin, his creative work or identity is escalated, never answered.

Safety layers, in order:
1. `blockPatterns` (regex): possible minors (ages under 18, school levels, "di bawah umur") and consent
   issues. The bot sends `refusalText`, alerts the owner with 🚫 DIBLOKIR, and never drafts or calls the LLM.
2. Age gate: on first contact the bot sends `ageGateText` (18+ only notice), `ageGate` flag, default on.
3. `escalationKeywords`: Fajrin's brand/identity, prices, payments, VIP access/subscriptions, custom
   requests, promises/deadlines, age/consent words, and sexual/explicit terms. Escalated without the LLM.
4. The LLM is instructed never to write sexual or explicit content (also required by Groq usage policy)
   and to escalate when unsure; its draft is re-checked against the keywords.

Flow for an incoming third-party message:
1. Block patterns, then age gate, then keyword guard (above). A keyword hit escalates without the LLM.
2. Otherwise the LLM drafts JSON `{reply, escalate, reason}`. Model-chosen escalation, missing LLM, errors,
   or a draft that itself contains a guard keyword all escalate.
3. Escalation: optional fixed holding reply to the contact (`holdingReply`, default on, generic text,
   commits to nothing), then the owner gets the message, reason and buttons [✍️ Balas] [🙈 Abaikan].
4. No escalation, approval mode (default): owner gets the draft with [✅ Kirim] [✏️ Edit] [❌ Tolak].
   Nothing is sent to the contact until Kirim, or until Fajrin types his own reply after Edit/Balas
   (sent verbatim, no AI label). `/balas <id> <teks>` and `/batal` also work.
5. Auto-send happens only if `approvalMode: false` AND `autoSend: true` (both non-default); the owner
   still gets a copy of each auto-sent reply.
- `discloseAI` (default true) appends `disclosureText` ("dibalas oleh admin AI Esse Kuning") to AI-written
  messages (drafts and holding reply).
- Pending items live in the owner's stored state; double-approval is a no-op.

### Where persona replies can happen
- Regular bot chats: only people who open the bot and message it first. The bot cannot message
  Fajrin's contacts on its own or appear as his personal account.
- Replying as a personal Telegram account (only if ever wanted for the Esse Kuning admin account): requires **Telegram Business "Chatbots"**, which needs **Telegram Premium**
  on Fajrin's account. Setup: BotFather > bot settings > enable Business Mode; then in Telegram
  Settings > Telegram Business > Chatbots, add the bot and choose which chats it may access, with
  permission to reply. The bot handles `business_connection` and `business_message` updates, verifies
  the connection belongs to the owner, ignores Fajrin's own messages, and replies with
  `business_connection_id` so messages appear as sent by Fajrin. The webhook must be set with
  `allowed_updates` including `business_connection` and `business_message` (plus `message`,
  `callback_query`).

### Limits
- Persona has no conversation memory yet (each message drafted alone).
- No per-contact rate limiting; approval mode bounds the risk, add limits before enabling autoSend.

## v3: Owner income tracking
- `/masuk <jumlah> [keterangan]`, `/keluar`, `/pendapatan` (today), `/hapusmasuk <id>`; owner only
  (`OWNER_USER_ID` or first `ALLOWED_USER_IDS`). Amounts: 50000, 50.000, 50rb, 50k, 1,5jt, Rp 75.000
  (`src/money.ts`). LLM tools `add_income`, `add_expense`, `income_today`, `delete_income` handle phrasing
  like "dapet 50rb dari VIP".
- Records stored in the owner's state with UTC timestamps, grouped by local day in the owner's tz.
- Daily report: the tick sends the previous local day's report (count, total `Rp50.000` format,
  breakdown by keterangan) once the local date has changed, i.e. at 00:00 Asia/Makassar or at the first
  later tick (catch-up). `lastMoneyReportDay` guarantees once per day. Records older than 90 days are pruned.
- Persona mode never reads or exposes this data.

## v4: Sales flow (pricelist, follow-up, payment QR)
- Plain price/paket/list questions (no payment intent, no other escalation topic such as diskon/custom)
  are answered with `pricelistText` + `pricelistUrl` instead of escalation (`isPriceQuestion`).
- Follow-up: when a message containing the pricelist link is actually sent to a customer, a follow-up is
  scheduled `followUpMinutes` (5) later. The tick creates it once per conversation (`followedUp`):
  draft for approval in approval mode, sent directly (copy to owner) in auto mode. Any customer reply
  cancels it. Precision depends on the tick interval (5 min cron, so roughly 5 to 10 minutes).
- Ready to pay (`payIntentPattern`): if a QR is stored, reply `qrReplyText` ("siap bos") + QR photo with
  `qrCaption`; draft in approval mode. Without a QR it escalates with `payHoldingText`.
- Payment proof (any photo from a customer, or `proofPattern` like "udah transfer"): always escalated to
  the owner (photo forwarded). The bot never confirms payment or grants VIP access.
- QR is stored as a Telegram `file_id` in the owner's persona record in Upstash (never in the repo).
  Owner replaces it by sending a photo with caption `/setqr` (or replying `/setqr` to a photo).
