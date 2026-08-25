![Take Profits Bot — Top Floor](docs/banner.png)

# 💰 Take Profits Bot

A Discord bot for Solana degen groups — auto-tracks contract addresses dropped in chat, locks in the **OG call** (who posted, when, at what price), and fires take-profit alerts when tokens run from that original entry.

> **Git workflow:** [GITHUB_PRACTICES.md](GITHUB_PRACTICES.md) · **Engineering handoff:** [docs/BOT_OVERVIEW.md](docs/BOT_OVERVIEW.md) · **New Discord/Telegram instance:** [docs/NEW_INSTANCE.md](docs/NEW_INSTANCE.md) · **NFT take-profits:** [docs/NFT_TP.md](docs/NFT_TP.md)

---

## What it does

| | |
|---|---|
| **Auto-track** | Detects Solana mints in chat → 📡 confirmation embed on first call |
| **OG call locked** | Reposts are silent — `postedBy`, `postedAt`, and `priceAtCall` never reset |
| **Take-profit tiers** | 🎯 alerts at 2× through 21× vs the original call price (20 tiers) |
| **Momentum ping** | 📈 +75% alert between 1.75× and 2× |
| **pump.fun** | Bonding-curve tracking, 85% Raydium alert, graduation alert |
| **Smart wallets** | `/wallet add` — ping when a watched wallet buys or sells |
| **Daily recap** | Top 5 gainers + 3 losers, ranked from cached poll data |
| **Research** | `/rug`, `/rugdeep`, `/x`, `/devs random` for due diligence |
| **NFT take-profits** | OpenSea collection URLs → same +75% / 1x–20x cards vs **floor at call** (flag off by default) |

Built for trench groups who want to know when a call is working — without staring at charts.

---

## Alert flow

When someone posts a CA **for the first time**:

| # | Trigger | Alert |
|---|---------|-------|
| 1 | First detection | 📡 **Auto-tracking** — MCap, caller, token age |
| 2 | +75% from call (1.75×–2×) | 📈 **Up 75%** |
| 3 | 2× from call | 🎯 **1x** Take Profit |
| 4 | 3× from call | 🎯 **2x** Take Profit |
| … | … | … |
| 22 | 21× from call | 🎯 **20x** Take Profit |

**Reposts:** same CA again → no embed, no reset. OG metadata preserved.

**Trench reset:** price below ~0.99× call for 3 polls → milestones clear; recovery can re-alert (24h cooldown).

**pump.fun extras:** ⚡ 85% bonding · 🎓 graduation to Raydium

---

## Scaling (production today)

The bot runs on Railway (US East) with a `/data` volume and handles **1,000+ tracked tokens** without drowning in API limits.

| Component | What it does |
|-----------|--------------|
| **Batch poller** | DexScreener — up to 30 mints per request (~60 req for full active set) |
| **Rate limiter** | Global token bucket + 429 circuit breaker across all DexScreener traffic |
| **Tier schedule** | Hot / warm / cold cadence — fresh calls polled every cycle |
| **Cached `/calls`** | Newest 40 tokens from DB — zero live API calls, sub-2s response |
| **Atomic writes** | `tracked.json` written via temp-file rename — no silent corruption on crash |
| **Archival** | Dead tokens (30d+, never >1.2×, no milestones) moved to `db.archived` — not deleted |
| **Mint-case repair** | Boot-time fix for legacy lowercased Solana keys via preserved `dexUrl` |

Typical full poll cycle: **under 60 seconds** (often ~1s for scheduled batch).

---

## Slash commands

| Command | Description |
|---------|-------------|
| `/calls` | Newest 40 tracked tokens with multiple vs call (cached · ⏳ = stale >15m) |
| `/remove <address>` | Stop tracking a token |
| `/pelpafkedup <address>` | Emergency untrack (public confirmation) |
| `/wallet add` | Watch a Solana wallet for buy/sell alerts |
| `/wallet remove` | Stop watching a wallet |
| `/wallet list` | Show watched wallets |
| `/rug <mint>` | RugCheck + bundle risk scan |
| `/rugdeep <mint>` | Deep forensics scan (slower) |
| `/x <handle>` | X profile + history signals |
| `/devs random` | Random creator wallet from tracked tokens |
| `/nfttrack` | Track an NFT collection (OpenSea URL, slug, or 0x) — `NFT_TP_ENABLED` |
| `/nftcalls` | Tracked NFT collections vs OG floor |
| `/nftremove` | Stop tracking an NFT collection |

---

## Prerequisites

- Node.js 18+
- Discord bot with **Message Content Intent** enabled
- Railway volume mounted at `/data` (recommended for production)

Optional API keys unlock research commands and wallet polling — see `.env.example`.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/enstest1/take_profits_profit_bot.git
cd take_profits_profit_bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Required:

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
```

| Variable | Where to find it |
|----------|-----------------|
| `DISCORD_TOKEN` | [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Token |
| `CLIENT_ID` | Developer Portal → General Information → Application ID |
| `SUMMARY_CHANNEL_ID` | Channel for daily summary (optional) |
| `MORALIS_API_KEY` | Wallet swap polling (optional) |

See [`.env.example`](.env.example) for research keys (`RUGCHECK`, `HELIUS`, `RAPIDAPI`, etc.) and deploy flags (`COMEBACK_SILENCE_CYCLES`, `MAINTENANCE_MODE`).

### 3. Enable Message Content Intent

Developer Portal → Bot → Privileged Gateway Intents → **Message Content Intent** → Save.

### 4. Invite the bot

OAuth2 URL Generator — Scopes: `bot`, `applications.commands` · Permissions: Read/Send Messages, Embed Links, Read Message History.

### 5. Run locally

```bash
npm start
```

Without a `/data` volume, state is stored in the project root as `tracked.json`.

---

## Deploy on Railway

For a **new Discord or Telegram community** (own bot token, own volume, own env), follow **[docs/NEW_INSTANCE.md](docs/NEW_INSTANCE.md)** — do not add their server to the production service.

1. Connect repo → **Deploy from GitHub**
2. Add env vars (same as `.env`)
3. **Mount a volume at `/data`** — `tracked.json`, repair markers, and backups live here
4. Region: **US East** (configured in `railway.toml`)

```bash
# One-shot volume backup (run on Railway shell)
node scripts/backup-volume.mjs

# Human-readable DB inspect
node scripts/inspect-tracked.mjs
```

`railway.toml` starts with `node index.js` and restarts on failure (up to 10 retries).

---

## File structure

```
├── index.js              # Discord client, autoTrack, slash commands
├── poller.js             # Batch poll loop, milestones, daily summary, archival
├── dexBatch.js           # DexScreener batch fetch (30 mints/request)
├── dexPair.js            # DexScreener pair resolution
├── rateLimiter.js        # Global API rate limit + 429 backoff
├── dbStore.js            # Atomic tracked.json load/save
├── pumpfunApi.js         # pump.fun + SOL price helpers
├── chains.js             # Solana-only chain config
├── alertGate.js          # Maintenance / comeback silence
├── scripts/
│   ├── repair-mint-case.mjs   # One-time lowercase-key repair
│   ├── inspect-tracked.mjs    # Human-readable DB report
│   └── backup-volume.mjs      # Volume backup before deploys
├── docs/
│   ├── banner.png
│   └── BOT_OVERVIEW.md
└── railway.toml
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Bot ignores CAs | Enable **Message Content Intent**. Check channel permissions. |
| `TokenInvalid` on boot | Wrong or missing `DISCORD_TOKEN`. |
| Slash commands missing | Register on startup — can take up to 1 hour globally. |
| `/calls` shows ⏳ | Token hasn't been polled in 15+ min (cold tier or API miss). |
| Milestone flood after deploy | Set `COMEBACK_SILENCE_CYCLES=3` for one deploy; remove after. |
| Fresh pump.fun CA fails | Verify `frontend-api.pump.fun` from Railway — host rotates occasionally. |
| Data lost on redeploy | Mount Railway volume at `/data`. |

---

## Tags & rollback

| Tag | When |
|-----|------|
| `stable-before-fablereview` | Pre–scaling-v2 baseline |
| `stable-after-fablereview` | After group confirms prod post–scaling-v2 |

See [GITHUB_PRACTICES.md](GITHUB_PRACTICES.md) for branch workflow and revert procedure.
