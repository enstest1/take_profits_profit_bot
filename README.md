# 💰 Take Profits Bot

A Discord bot that automatically detects contract addresses in chat and delivers real-time price alerts, milestone Take Profit notifications, wallet monitoring, and daily performance recaps.

---

## Features

| Feature | Detail |
|---------|--------|
| **Auto CA detection** | Scans every message for EVM (`0x…`) and Solana (base58) contract addresses |
| **Multi-source lookup** | pump.fun → DexScreener → Moralis fallback chain |
| **% Price alerts** | +15%, +50%, +75% from call price (each fires once, resets below call) |
| **Milestone Take Profits** | 1x–20x from entry — gold 💰 Take Profits card at each milestone |
| **Token age flag** | 🔥 < 1h old · ⚡ < 24h old |
| **Buy/sell pressure** | Last 100 txns ratio via Moralis + DexScreener fallback |
| **Duplicate CA detection** | Warns if same address is already tracked in another channel |
| **Dev wallet monitoring** | Alerts if dev sells 20%+ of their position |
| **Wallet watchlist** | `/watch` any wallet, get pinged on new buys |
| **pump.fun support** | Pre-graduation bonding curve tracking + 85% alert + graduation alert |
| **Daily summary** | 9 AM UTC recap — top 5 gainers + 3 biggest losers |
| **Auto-expiry** | Tokens auto-removed after 28 days with a final summary embed |
| **Slash commands** | `/calls`, `/remove`, `/watch`, `/unwatch`, `/watchlist` |

---

## Alert Sequence

When a token is posted, the bot fires alerts in this order:

| # | Trigger | Embed |
|---|---------|-------|
| 1 | Token first detected | 📡 **Confirmation** — MCap, links, copyable address |
| 2 | +15% from call | ↗ **Price Alert** (green) |
| 3 | +50% from call | ↗ **Price Alert** (green) |
| 4 | +75% from call | ↗ **Price Alert** (green) |
| 5 | 1x (100% gain) | 🎯 **Take Profits** (gold) |
| 6 | 2x (200% gain) | 🎯 **Take Profits** (gold) |
| … | … | … |
| 24 | 20x (2000% gain) | 🎯 **Take Profits** (gold) |

**Reset logic:** If price drops below the original call price, all alerts reset and will fire again on the next pump.

---

## Prerequisites

- Node.js 18+
- A Discord bot with **Message Content Intent** enabled
- Moralis API key (free tier works)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/enstest1/take_profits_profit_bot.git
cd take_profits_profit_bot
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
SUMMARY_CHANNEL_ID=channel_id_for_daily_summaries
MORALIS_API_KEY=your_moralis_api_key
```

| Variable | Where to find it |
|----------|-----------------|
| `DISCORD_TOKEN` | [Discord Developer Portal](https://discord.com/developers/applications) → Your App → Bot → Token |
| `CLIENT_ID` | Discord Developer Portal → Your App → General Information → Application ID |
| `SUMMARY_CHANNEL_ID` | Right-click a channel in Discord → Copy Channel ID (enable Developer Mode first) |
| `MORALIS_API_KEY` | [Moralis Dashboard](https://admin.moralis.io/) → API Keys |

### 3. Enable Message Content Intent

In the [Discord Developer Portal](https://discord.com/developers/applications):
1. Select your application → **Bot**
2. Enable **Message Content Intent** under Privileged Gateway Intents
3. Save changes

### 4. Invite the bot

In Developer Portal → OAuth2 → URL Generator:
- Scopes: `bot`, `applications.commands`
- Bot permissions: `Read Messages/View Channels`, `Send Messages`, `Embed Links`, `Read Message History`

### 5. Run

```bash
npm start
```

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/calls` | List all tracked tokens with current multiple and buy pressure |
| `/remove <address>` | Stop tracking a token |
| `/watch <wallet> [label]` | Add a wallet to the watchlist |
| `/unwatch <wallet>` | Remove a wallet from the watchlist |
| `/watchlist` | Show all watched wallets |

---

## File Structure

```
├── index.js           ← Bot entry, Discord events, slash commands, DB persistence
├── poller.js          ← 15-sec polling loop, alert logic, daily summary, expiry sweep
├── moralis.js         ← Moralis API (Solana gateway + EVM deep-index)
├── dexscreener.js     ← DexScreener API wrapper
├── pumpfun.js         ← pump.fun API + SOL price + price calculation
├── walletWatcher.js   ← Wallet watchlist poller (5-min interval)
├── package.json
├── railway.toml       ← Railway deployment config
├── .env.example       ← Environment variable template
├── .gitignore
└── tracked.json       ← Auto-created at runtime (gitignored)
```

---

## Deploy on Railway

1. Push to GitHub
2. Create a new Railway project → **Deploy from GitHub**
3. Add environment variables in Railway dashboard (same four as `.env`)
4. Optionally add `TZ=UTC` to Railway env vars
5. Railway auto-detects `railway.toml` and starts with `node index.js`

The `railway.toml` is configured to restart on failure (up to 10 retries).

> **Note:** `tracked.json` lives in the container filesystem. Data persists across normal restarts but is lost on full redeploys. For true persistence, mount a Railway volume at `/app` or migrate to a database.

---

## Rate Limit Protection

| API | Strategy |
|-----|----------|
| **DexScreener** | Free, no key needed. 8s timeout. |
| **pump.fun** | Unofficial API. Wrapped in try/catch. |
| **CoinGecko** | SOL price cached 60s. |
| **Moralis** | Buy/sell pressure cached 2 min. Dev wallet checks throttled to every 5 min. 200ms delay between batch calls. |

Poll mutex prevents overlapping cycles when a poll takes longer than the 15-second interval.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Bot doesn't respond to contract addresses | Enable **Message Content Intent** in Developer Portal. Check bot has Read/Send Messages permissions. |
| `TokenInvalid` error on startup | `DISCORD_TOKEN` in `.env` is missing or incorrect. |
| Slash commands not appearing | Commands register globally on startup — can take up to 1 hour to propagate. |
| pump.fun prices show as null | CoinGecko SOL price fetch failed — retries next poll cycle. |
| Dev wallet always null | Moralis holder endpoint returned no data — dev monitoring is skipped. |
