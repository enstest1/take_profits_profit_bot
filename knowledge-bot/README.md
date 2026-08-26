# Knowledge Bot 📚

A standalone Discord bot that archives your server's full history, curates it
into a searchable knowledge base with an LLM, and serves it back to members
with receipts (jump-link citations to the original messages).

**Keep it separate from any trading/alert bot**: its own Discord application,
its own token, its own process and database. A backfill or extraction job can
never take your other bot down.

> **This repo:** Railway Root Directory **must** be `knowledge-bot/` (see
> `railway.toml` in this folder). Do not set these env vars on
> `take_profits_profit_bot`. Rollback = stop this service. Full playbook:
> `GITHUB_PRACTICES.md` → "Knowledge bot — isolated service".

## What members get

| Command | What it does |
|---|---|
| `/ask question:` | Answers from the knowledge base only, citing original messages (📎 Receipts). 👍/👎 buttons log feedback. |
| `@KnowledgeBot <question>` | Same as /ask, conversational (30s per-user cooldown). |
| `/search query:` | Verbatim archive search with jump links — "who posted that link". |
| `/guide topic:` | Composes a structured beginner guide from archived knowledge; posts a preview + attaches full `.md` (ready for a website). |
| `/faq [topic]` | FAQ built from questions the community actually answered. |
| `/roundup [days]` | "What the server learned" — also auto-posts weekly if `KB_POST_CHANNEL_ID` is set. |
| `/kbstats` | Archive size, knowledge counts by kind, extraction backlog, feedback score. |
| `/backfill` | (Admin) start/resume ingestion (last 72h by default). Also runs on boot. |

## How it works

1. **Backfill** — pages through every configured channel *and its threads*
   for the last **72 hours** (`KB_BACKFILL_MAX_AGE_HOURS`, set `0` later for
   full history), storing raw messages in SQLite (`DATA_DIR/knowledge.db`).
   Quiet channels (no message in that window) are skipped. Resumable: a
   cursor per channel survives restarts.
2. **Live sync** — new messages append; edits update; deletions are honored.
3. **Extraction (hourly cron)** — chronological windows go to Claude with a
   curation prompt that keeps only durable knowledge: Q&A pairs, explanations,
   resources, how-tos, recommendations, decisions, warnings. Each unit stores
   the source message IDs (the model cites short refs like [m12]; code maps
   them back to snowflakes — it never copies 19-digit IDs).
4. **Index** — SQLite FTS5 over both raw messages and knowledge units.
5. **Serve** — retrieval + answer/compose prompts, every answer citing sources.

## Setup

1. **Create the Discord app** — [discord.com/developers/applications](https://discord.com/developers/applications)
   → New Application → Bot. Copy the token. Enable **Message Content Intent**
   (Privileged Gateway Intents).
2. **Invite it** — OAuth2 → URL Generator: scopes `bot`, `applications.commands`;
   permissions: View Channels, Read Message History, Send Messages, Embed Links,
   Attach Files.
3. **Configure** — `cp .env.example .env` and fill in `DISCORD_TOKEN`,
   `CLIENT_ID`, `KB_GUILD_ID`, `OPENROUTER_API_KEY`. Pick channels via
   `KB_CHANNEL_IDS` (`all` or a comma-separated list; `KB_EXCLUDE_CHANNEL_IDS`
   to carve out e.g. mod channels).
4. **Run** — `npm install && npm start`. Backfill starts automatically; watch
   `/kbstats` climb. `npm run smoke` runs the offline pipeline test (no keys needed).
5. **Deploy (Railway)** — second service in your project (or its own repo):
   root directory `knowledge-bot/`, start command `npm start`, **mount a volume
   at `/app/data`** and set `DATA_DIR=/app/data` so the archive survives redeploys.

## Costs (order of magnitude)

- Extraction: Haiku-class by default; a 100k-message history is typically a
  few dollars one-time, then pennies/day. Throttled by `KB_MAX_WINDOWS_PER_RUN`
  per hourly run, so a huge backlog drains gradually and cost is capped.
- Answers: Sonnet-class per /ask–/guide call — cents each.

## Consent & scope (read this)

- The bot only sees channels it's invited to and you configure — that's the
  legitimate version of "scraped the entire discord." No user-account self-bots.
- Get the server owner's blessing before archiving, exclude sensitive channels,
  and if you'll publish guides off-platform, set `KB_ANONYMIZE=1` to mask
  usernames in extracted knowledge (raw archive keeps real names locally).
- Deleted messages are excluded from future extraction; already-extracted
  knowledge is curated content and remains.
