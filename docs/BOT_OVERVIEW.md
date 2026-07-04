# Take Profits Scanner — Bot Overview & Status

## TL;DR — What this bot is

**Take Profits** is a Discord **degen trench-warrior alert bot** for advanced Solana meme coin traders.

Drop a contract address (CA) in chat → the bot auto-tracks it, polls price in the background, and fires **momentum / take-profit alerts** when a token runs from the **original call price** — +75%, then 🎯 tier milestones from **2× through 21×** (tiers 1–20).

Built for groups that scan hundreds of calls and need to know **when something they already called is ripping** — not another generic price bot.

---

## How it works today

1. **Auto-track** — Any Solana CA in chat is detected (base58 mint). Bot confirms with a blue **📡 Auto-tracking** embed (name, symbol, mcap, poster).
2. **Stored call** — Saves `postedBy`, `postedAt`, `priceAtCall`, `mcapAtCall`, channel, milestone history on Railway volume (`/data/tracked.json`).
3. **Poll loop** — Every ~3 minutes (target), cycles through tracked tokens and fetches live price (DexScreener → pump.fun fallback for bonding curve).
4. **Alerts** (to the channel where the CA was first posted):
   - 📈 **+75%** between 1.75× and 2×
   - 🎯 **Tier milestones** — highest new tier only per tick (2×, 3×, … 21× vs call price)
   - 🎓 **Graduation** — pump.fun → Raydium
   - ⚡ **Bonding curve** — 85%+ to Raydium
5. **Trench reset** — If price sits below ~0.99× call for 3 polls, milestones clear so recovery can alert again (max once per 24h).
6. **Poll tiers** — Hot / warm / cold cadence so dead tokens aren't all polled every cycle.
7. **Silence modes** — Maintenance / comeback silence on deploy to avoid catch-up spam.

### Slash commands (subset)

| Command | Purpose |
|---------|---------|
| `/calls` | All tracked tokens + live multiples |
| `/remove` | Stop tracking a CA |
| `/pelpafkedup` | Emergency untrack when alerts spam |

---

## Scale — why we had to slow things down

| Era | Tokens | Behavior |
|-----|--------|----------|
| Early | 200–300 | ~30–45s poll cycles, reliable alerts |
| Now | ~1,800 | DexScreener **HTTP 429** rate limits, cycles ballooned to **15–18 min**, many tokens missed updates |

**Root cause:** ~1,700 tokens marked **hot** (never hit a milestone → poll every cycle). That was ~40+ API requests/second — far above DexScreener free-tier tolerance.

### Fixes applied (Jul 2026)

| Fix | What it does |
|-----|----------------|
| **Solana-only** | Removed Robinhood / all EVM auto-track to avoid pool-vs-token conflicts and extra API load |
| **OG call protection** | Reposting a CA never overwrites `postedAt` / `priceAtCall` / milestones — checks canonical mint before save |
| **Same-message dedupe** | Multiple addresses resolving to one mint in a single message only track once |
| **Smarter hot tier** | Tokens >24h old with **zero milestones** → **cold** (every 5th cycle), not hot every cycle |
| **Rate-limited polling** | 6 concurrent fetches, 150ms stagger, per-chain Sol DexScreener API first |
| **DB merge on poll save** | Long poll cycles no longer wipe tokens added mid-cycle via autoTrack |

### Theoretical next steps (not yet built)

- Parallel worker pool with global 429 backoff queue
- Archive / auto-remove dead tokens (>30d, never hit 1.5×)
- Supabase or sharded pollers for 5k+ tokens
- Group wallet master list (discussed, deferred)

---

## Current restrictions

- **Solana only** — `0x` addresses ignored; legacy EVM/Robinhood entries in DB are skipped for polling
- **DexScreener rate limits** — Free API; heavy lists still hit 429s under load
- **Single poller** — One Railway instance, one in-process loop
- **~1,800 token ceiling** — Works but degraded vs 200–300 era without further infra
- **Call channel locked** — Alerts go to the channel where the CA was **first** tracked
- **No multi-tenant isolation** — One `tracked.json` per bot instance

---

## Known problems & bugs (historical + status)

| Issue | Status |
|-------|--------|
| **OG call reset on repost** | **Fixed** — canonical mint check before save; never overwrite existing entry |
| **Pool address in message bypassing duplicate check** | **Fixed** — sol-only + canonical key; EVM pool path removed |
| **Lag / missed updates at scale** | **Improved** — cold tier + rate limiting; not fully solved until queue/sharding |
| **18-min poll cycles** | **Improved** — fewer hot tokens scheduled; monitor after deploy |
| **Poll cycle clobbering new autoTrack** | **Fixed** — merge snapshot on poll saves |
| **Milestone spam on redeploy** | Mitigated — bootstrap + comeback silence |
| **Trench reset feels like re-call** | By design — milestones refire on recovery; OG poster/time unchanged in alert text |
| **Duplicate CA notification noise** | Silenced — reposts log only, no Discord embed |
| **US West Discord gateway hang** | Fixed — US East + IPv4-first DNS |

---

## Data safety

These changes **do not delete** `tracked.json`. Existing Solana tokens, milestone history, and call metadata are preserved. Legacy EVM/Robinhood rows remain in the file but are **not polled** until manually removed.
