# Sentinel — adaptive Discord moderation

A local-first Discord bot with staff-guided learning, configurable moderation and a mildly sarcastic chat personality. Node.js 22+, PostgreSQL 16, Redis 7 and optional Ollama. Claude is optional and **off by default**.

## What it does

- Detects message floods, repeated text, mass mentions, Discord invites and blocked domains without AI calls.
- Screens unfamiliar links and suspicious scam language using Ollama. Enable `aiAllMessages` for broader text screening.
- Uses Claude only for uncertain/unavailable local results, when explicitly enabled and within a persistent per-server daily request cap.
- Records cases and posts staff review cards. Approvals and corrections become server-specific examples and exact-message decisions. The latest eight reviewed examples guide model prompts.
- Supports edits, per-server settings, role/channel exemptions, private staff commands, and configurable review/delete/timeout modes.
- Chats in a linked channel or when mentioned, with local or cloud Ollama, member cooldowns, and short conversation context. Chat never uses Claude; cloud quotas still apply.
- Provides categorized `/help`, moderation status, case inspection, data-retention controls and mention-safe bot replies.

**Learning means staff-approved examples, not retraining model weights.** Only staff with Manage Messages can teach the bot. Rules for spam, blocked domains and invites run before learned exceptions. Models can make mistakes; start in the default `review` mode and inspect real cases before enabling enforcement.

## Quick start

1. Create a Discord application and bot in the Developer Portal. Enable **Message Content Intent**. Install with the `bot` and `applications.commands` scopes.
2. Grant View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Manage Messages and Moderate Members. Place the bot role above members it should timeout. Administrator permission is unnecessary.
3. Copy `.env.example` to `.env`. Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, a strong `POSTGRES_PASSWORD`, and a matching `DATABASE_URL` (URL-encode special characters in the password). Set `DISCORD_GUILD_ID` for immediate commands in a test server; omit for global registration.
4. Install and prepare:

   ```sh
   npm ci
   docker compose up -d postgres redis
   npm run db:generate
   npm run db:setup
   npm run commands:register
   npm start
   ```

   `db:setup` uses Prisma db push. **Back up an existing database first and inspect proposed schema changes; do not use `--accept-data-loss`.** Legacy tables are retained for compatibility but the new runtime uses guild-scoped tables. Old global settings/warnings are not imported, and old stored history needs a separate retention decision. For managed production deployments, establish and review Prisma migrations against your existing database before changing its schema.

5. In Discord, run `/help`, `/config show` and `/status`. Set `logChannelId` to a **private staff text channel**. Review logs contain message text. The bot does not change channel permissions.
6. Use `/botchat channel:#bot-chat` for open chat. Run `/botchat` without a channel to unlink. Mentions work anywhere chat is enabled and the bot can read.
7. After tuning in review mode, use `/config set key:mode value:delete` or `timeout`.

Commands are registered separately rather than overwritten at every startup. Re-run registration after changing command definitions. Global changes may take time to appear. Using both global and guild registration can leave duplicate command definitions; manage the unused scope in your application deployment.

## Ollama and hardware

Start with `qwen2.5:7b` as a practical baseline, then evaluate on your own staff-reviewed cases. Model choice is configurable with `OLLAMA_MODEL`; neither a model name nor high model confidence guarantees accuracy. A 7B quantized model typically needs several GB of RAM/VRAM; CPU-only operation is possible but latency depends heavily on hardware. Provider requests time out after 45 seconds. Smaller models can reduce latency at an accuracy cost.

Install Ollama on the host, or use the optional CPU container:

```sh
docker compose --profile ai up -d ollama
docker compose exec ollama ollama pull qwen2.5:7b
```

Host defaults: `OLLAMA_URL=http://localhost:11434`. The bot calls `/api/chat` with JSON output for moderation. Local chat keeps the latest three exchanges per member and channel in Redis for 15 minutes. AI operations share a configurable concurrency limit (three locally, one by default when an API key is set); busy chat requests are skipped. AI outages never become a confident safe decision: suspicious messages are queued as review cases when analysis is unavailable. Deterministic rules remain available while Ollama is down. Database or Redis outages are logged and interrupt message processing; monitor process logs and service health.

## Claude costs

Set `ANTHROPIC_API_KEY` and `CLAUDE_MODEL` to an available model in your Anthropic account, then enable `claudeEnabled`. Pick a small current Claude model after measuring it on your server's cases. Paid requests are limited by `claudeDailyRequests` (default 20 **per server**, UTC day), with at most 250 output tokens and bounded input/examples. Reservations are atomic in PostgreSQL, survive restarts and include failed attempts; SDK retries are disabled. There is no guaranteed dollar estimate: input length, model pricing and server count affect spend. Set provider-side spending limits as an additional control.

High-confidence Ollama results, staff exact matches, rules and cached results do not call Claude. Chat never calls Claude; Ollama Cloud usage is still metered. The AI cache is scoped to the message/evidence hash, server, configured models, current settings and current examples, with a one-hour TTL. Media is inspected before cache/learning lookup, so changed files or pages cannot reuse a previous safe verdict. `allowedDomains` suppresses the old link-only text heuristic when inspection is disabled. Enabled destination inspection still checks allowed links; the list never bypasses inspection, suspicious wording, spam, invites or blocked domains.

## Commands

| Command | Permission | Purpose |
| --- | --- | --- |
| `/help [topic]` | Everyone | Overview, moderation, settings and AI guides |
| `/privacy` | Everyone | Current storage and provider policy |
| `/botchat [channel]` | Manage Server | Link or unlink open chat |
| `/config show` | Manage Server | Read all effective server settings |
| `/config set key value` | Manage Server | Change one validated setting |
| `/status` | Manage Messages | Database/Redis reachability, paid budget and recent cases |
| `/case id` | Manage Messages | Inspect evidence, action outcome and latest review |
| `/feedback id label` | Manage Messages | Approve or correct to safe/spam/invite/crypto_scam/phishing/scam/impersonation/malware/dangerous_file |
| `/forget id` | Manage Messages | Remove the matching learned example |
| `/purge count` | Manage Messages | Delete 1–100 recent messages, excluding messages older than 14 days |

Review buttons enforce permissions again at click time. Feedback is server-scoped and recorded in an append-only feedback table; corrections replace the active example. Repeated identical messages from different users may use the same approved label in that server. `/forget` removes a lesson but does not erase the case. Feedback does not restore deleted messages or reverse timeouts. Staff can remove a timeout using Discord's native moderation controls.

## Settings

`/config show` lists all settings. Numbers and booleans use JSON syntax; lists use JSON arrays; strings are plain text.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `review` | `review`, `delete`, or `timeout`; no automatic kicks/bans |
| `blockInvites` | `true` | Block recognized Discord invite links |
| `spamLimit` / `spamWindowSeconds` | `6` / `10` | Allow 6 messages in the fixed counter window; flag subsequent messages |
| `duplicateLimit` | `3` | Flag the third repeated text within the same time window |
| `mentionLimit` | `6` | Flag 6 or more user/role mentions; everyone/here mentions also flag |
| `timeoutSeconds` | `300` | Timeout duration, 0 to disable; maximum 86400 |
| `aiEnabled` / `aiAllMessages` | `true` / `false` | AI screening and optional screening of all text |
| `aiThreshold` | `0.9` | Minimum confidence to enforce a non-safe verdict (0.7–1) |
| `claudeEnabled` / `claudeDailyRequests` | `false` / `20` | Paid fallback and per-server daily request ceiling |
| `chatEnabled` / `chatCooldownSeconds` | `true` / `8` | Chat replies and per-member cooldown |
| `logChannelId` / `botchatChannelId` | empty | Staff logs and open chat destinations |
| `exemptRoleIds` / `exemptChannelIds` | `[]` | Skip moderation in matching roles/channels |
| `allowedDomains` / `blockedDomains` | `[]` | Lowercase domains; subdomains also match |
| `retentionDays` | `30` | Retain cases/feedback and reviewed examples for 1–365 days |
| `personality` | witty and helpful | Local chat style, up to 700 characters |

Staff with Manage Messages are exempt from automatic moderation. Replies suppress all mentions. Timeout enforcement never shortens an existing timeout. Failed deletions/timeouts remain visible in cases. Each message content version is claimed in the database before enforcement to prevent duplicate events from repeating the same action; changed messages can produce a new case. A crash between claim and action leaves a pending case for staff investigation; actions are not blindly replayed.

## Operations and limits

Run one gateway process per bot deployment. Use a process supervisor and monitor logs, pending/failed cases, provider latency and service health. Spam counters run before model requests so slow AI does not serialize rate checks. The bot caps pending work at 500 and logs dropped events under overload. It is not a replacement for Discord AutoMod rate limits or raid protection. Enable Discord's built-in mention/spam rules as an additional layer.

Retention runs on startup and hourly. Cases, feedback and examples are persisted in PostgreSQL; ordinary messages are not stored there. Redis stores temporary spam counters, AI results and chat context. Staff log copies in Discord follow your channel's retention policy and are **not** deleted by database cleanup. Back up PostgreSQL and secure access to both services. Compose binds local ports to loopback; adapt networking/authentication before deploying across hosts. Redis eviction can reset spam/cooldown/cache state under memory pressure.

Media inspection is described below. Obfuscated URLs, cloaked websites and novel scams can still evade detection. There are no automated global raids, appeals, dashboard or model fine-tuning pipelines. Evaluate detection and false-positive rates on real server traffic before enabling destructive modes. Review mode is the default; stronger automatic actions require explicit configuration.

## Verification

```sh
npm test
npm run check
DATABASE_URL=postgresql://localhost/sentinel npx prisma validate
```

Integration tests use an **isolated disposable** PostgreSQL database and Redis namespace:

```sh
DATABASE_URL=postgresql://user:password@localhost:5432/sentinel_test npm run db:setup
DATABASE_URL=postgresql://user:password@localhost:5432/sentinel_test REDIS_URL=redis://localhost:6379 npm run test:integration
```

They exercise real database settings merges, atomic paid budgets, feedback, content-version uniqueness, retention and Redis spam counters. Provider behavior is tested through injected fixtures; a live Discord deployment still needs token/intents/permissions, command registration and real model evaluation.


## Ollama Cloud for testing

Set these values in your private `.env` (never commit your key):

```dotenv
OLLAMA_URL=https://ollama.com
OLLAMA_API_KEY=your-own-key
OLLAMA_MODEL=gemma4:31b
OLLAMA_VISION_MODEL=gemma4:31b
OLLAMA_CONCURRENCY=1
```

The selected cloud model must be available to your account and support images. A synthetic text and image request with this model was verified during implementation. Cloud credits and limits apply to both moderation and chat. The API key is sent only to the configured HTTPS Ollama endpoint; provider redirects are disabled. Media HTTP requests never inherit provider authorization. Claude remains optional and disabled by default; image requests do not fall back to text-only Claude because that would discard image evidence. With a text-only local model, configure a separate vision model or image assessments will require staff review.

The Discord token and application ID are still separate requirements. Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and optionally `DISCORD_GUILD_ID` in `.env`, prepare the database/Redis, run `npm run commands:register`, then `npm start`.

## Attachment and link inspection

Enabled by default for non-exempt members. These checks run after deterministic message rules and before staff lessons/AI caches. Existing staff/channel exemptions apply. Cases contain evidence summaries; raw downloads and image data stay in memory and are discarded after processing. Resized images, extracted text, and up to eight staff examples go to the configured AI provider. With Ollama Cloud, that data leaves your host. `/privacy` explains this to server members. Cases may contain excerpts from files and web pages, so keep the log channel private.

### Links

- Extracts HTTP(S) URLs and `www.` links from message text, supported text attachments and decoded QR codes.
- Fetches the destination with up to three HTTP redirects, rechecking domain policy and public DNS on every hop. Resolves once per hop and pins that address to the socket to prevent DNS rebinding.
- Rejects localhost/private/reserved addresses (IPv4 and IPv6), embedded credentials, non-HTTP protocols and nonstandard ports. Uses fresh connections without cookies, credentials or environment proxies.
- Inspects visible HTML/plain text, form destinations and meta-refresh targets. Scripts are never executed; form/meta targets are evidence, not recursively crawled. No browser automation or login is performed.
- Limits a page to 256 KiB, rejects compressed responses, bounds redirects and request time, and reviews HTTP failures, inaccessible or unreadable destinations. Sites requiring JavaScript or returning challenge pages cannot be fully inspected. A reachable page is not proof of safety.

### Attachments

- Downloads only from validated Discord CDN hosts, with limits on both declared and streamed size. Files are never run or written to disk.
- Blocks configured dangerous extensions (executables, scripts, installers, shortcuts) and executable signatures, including files disguised with harmless names. These are file policy violations, not a claim that every executable is malware. Disable `blockDangerousFiles` if your server intentionally shares these files.
- Decodes JPEG, PNG, GIF and WebP with a 16-million-pixel ceiling; resizes to at most 1200×1200 for vision. Decodes a QR payload locally and inspects its URL. Animated images inspect only the first frame and always require review. Multiple/damaged/tiny QR codes are not guaranteed to decode.
- Extracts TXT, CSV, JSON, Markdown, log and HTML text. AI text limits are explicit: overlong/partial evidence is sent to review rather than accepted as clean.
- Unsupported formats (including PDF, archives, audio and video), scan failures, excessive counts and oversized files create review-only cases. They are never automatically labeled safe or deleted merely because inspection failed.

### Optional antivirus

For signature-based malware detection, enable the provided local ClamAV service:

```sh
docker compose --profile antivirus up -d clamav
```

Set `CLAMAV_HOST=127.0.0.1` and `CLAMAV_PORT=3310` in `.env`. Allow time/RAM for ClamAV to load and update its signature database before testing. The bot streams bounded file bytes using ClamAV INSTREAM; an infected result is a `malware` case. Errors/timeouts require review. Without `CLAMAV_HOST`, image/text/policy checks still work, but **antivirus scanning is disabled**. A clean antivirus result does not clear unsupported document content. The ClamAV protocol tests pass, and a live daemon correctly accepted a harmless fixture and detected the standard EICAR antivirus test fixture during implementation. Keep signatures updated in your deployment.

### Inspection settings

| Setting | Default | Bounds / purpose |
| --- | --- | --- |
| `scanAttachments` | `true` | Enable file inspection |
| `inspectLinks` | `true` | Enable destination inspection |
| `blockDangerousFiles` | `true` | Block executable/script file types |
| `maxAttachments` | `3` | 1–5 per message |
| `maxAttachmentBytes` | `5242880` | 1024–10485760 bytes per attachment |
| `maxLinks` | `3` | 1–5 distinct URLs per message |

Inspection concurrency is limited to three jobs, with a 20-second network-work deadline per message (in-progress image decoding/antivirus may extend total runtime). Overflow goes to review. No URL is fetched just because an AI tells the bot to fetch it. Existing `mode`, confidence threshold and staff feedback controls apply. A staff-safe example cannot bypass an incomplete inspection, executable policy or a newly changed file/page.
