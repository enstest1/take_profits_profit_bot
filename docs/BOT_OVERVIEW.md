# Take Profits Scanner — Engineering Handoff

> **Audience:** Senior engineer / bot reviewer taking over scaling, reliability, and architecture.  
> **Repo:** `enstest1/take_profits_profit_bot` · **Runtime:** Node 18+ ESM · **Host:** Railway US East · **State:** `/data/tracked.json` volume

---

## 1. TL;DR — Product purpose

**Take Profits** is a Discord **degen trench-warrior notification bot** for advanced Solana meme coin traders.

| What it is | What it is NOT |
|------------|----------------|
| Momentum / take-profit alert system tied to **OG call price** | A charting terminal or copy-trading bot |
| Auto-tracks CAs dropped in chat | A wallet tracker (personal `/wallet` exists but is secondary) |
| Fires when **already-called** tokens run (+75%, 2×–21× tiers) | A scanner that finds new tokens proactively |

**Core user loop:** Someone posts a Solana CA → bot locks in **who called it, when, and at what price** → background poller watches price → Discord alerts when momentum hits predefined tiers from that **original call** — so the group knows when a trench call is working without watching charts 24/7.

---

## 2. How it works today

```
Discord message (CA)
       │
       ▼
  extractAddresses() ──► autoTrack()
       │                    │
       │                    ├─ resolveTokenKey() → already tracked? silent return (OG preserved)
       │                    ├─ fetchTokenData() → DexScreener / pump.fun
       │                    ├─ canonical mint check → never overwrite existing entry
       │                    └─ saveDB() → tracked.json
       │
       ▼
  runTokenPollLoop()  (~3 min target interval)
       │
       ▼
  pollTokens()
       ├─ tier schedule (hot / warm / cold)
       ├─ fetchLiveData() per token (6 concurrent, 150ms stagger)
       ├─ evaluateGainAndMilestones()
       └─ saveDB() with merge snapshot (no clobber mid-cycle tracks)
       │
       ▼
  Discord alerts → entry.alertChannelId (first channel that tracked the CA)
```

### Alert types

| Alert | Trigger |
|-------|---------|
| 📡 Auto-tracking | New CA (first time only) |
| 📈 +75% | 1.75×–2× vs `priceAtCall` |
| 🎯 Tier N | Price ≥ (N+1)× call (tier 1 = 2×, … tier 20 = 21×); **highest new tier only** per tick |
| 🎓 Graduation | pump.fun bonding complete → Raydium |
| ⚡ Bonding | ≥85% bonding curve progress |
| Trench reset | Below 0.99× call for 3 polls → milestones clear; recovery can re-alert (24h cooldown) |

### Poll tier logic (`poller.js`)

| Tier | Rule | Cadence |
|------|------|---------|
| **Hot** | Age ≤ 24h OR (milestones > 0 AND age ≤ 7d) | Every cycle |
| **Warm** | Has milestones, older, peak ≥ 1.5× | Every 2nd cycle |
| **Cold** | No milestones and age > 24h, OR inactive (72h no ATH bump) | Every 5th cycle |

Constants: `POLL_CONCURRENCY=6`, `POLL_STAGGER_MS=150`, `TOKEN_POLL_INTERVAL_MS=180_000`.

### Slash commands (high-traffic)

| Command | Notes |
|---------|-------|
| `/calls` | Fetches live price for **every** tracked token — expensive at scale |
| `/remove` | Delete one CA from DB |
| `/pelpafkedup` | Emergency untrack + public confirmation |
| `/rug`, `/x`, `/dev`, etc. | Research commands; hit RugCheck, Moralis, Helius |

---

## 3. Architecture & file map

```
take_profits_scanner/
├── index.js           # Discord client, autoTrack, slash commands, poll loop entry
├── poller.js          # Price polling, milestones, wallet poll, daily summary
├── dexPair.js         # DexScreener fetch + pair selection (legacy EVM helpers unused in prod)
├── chains.js          # Solana-only enabled; EVM_CHAINS legacy for stored rows
├── alertGate.js       # MAINTENANCE_MODE, COMEBACK_SILENCE_CYCLES
├── moralis.js         # Solana swaps / EVM helpers (wallet watcher)
├── walletWatcher.js   # Personal wallet lists (Solscan/Etherscan)
├── railway.toml       # US East region, node index.js
├── scripts/
│   ├── backup-volume.mjs
│   └── inspect-tracked.mjs
└── docs/BOT_OVERVIEW.md
```

**Single process:** Discord gateway + poll loop + message handler share one Node event loop. No Redis, no queue, no worker threads.

**Persistence:** JSON file at `/data/tracked.json` on Railway volume (~1,800 tokens, ~0.2 GB volume usage). Milestone bootstrap marker: `.tp_milestone_bootstrap_v2`. Comeback silence: `.tp_comeback_cycles`.

---

## 4. Token record schema (`db.tokens[mint]`)

```javascript
{
  address,           // Solana mint (canonical key)
  name, symbol, chain, platform,   // 'dexscreener' | 'pumpfun'
  postedBy, postedByUserId, postedAt,   // OG call metadata — MUST NOT reset on repost
  calledInGuild, alertChannelId,        // Alerts always go to alertChannelId
  priceAtCall, mcapAtCall, volumeAtCall,
  lastPrice, lastVolume, lastChecked,
  peakMultiple, peakAt,                 // ATH tracking vs call price
  milestonesFired,                      // tier ids [1..20]
  lowMultStreak, lastMilestoneResetAt,  // trench reset
  takeProfitFired, gainAlertFired,
  bondingProgress, graduationAlertFired, bondingAlertFired,
  dexUrl, imageUrl, devWallet, ...
}
```

**Critical invariant:** `priceAtCall` and `postedAt` are immutable after first track. Milestone math is `livePrice / priceAtCall` (mcap ratio used as max with price ratio when FDV lags).

---

## 5. External dependencies

| Service | Usage | Rate-limit risk |
|---------|-------|-----------------|
| **DexScreener** | Primary price (`/token-pairs/v1/solana/{mint}`, fallback `/latest/dex/tokens/{mint}`) | **High** — HTTP 429 at ~1,800 tokens |
| **pump.fun API** | Bonding curve tokens pre-graduation | Medium |
| **CoinGecko** | SOL/USD for pump.fun price calc | Low |
| **Discord Gateway** | Bot online, messages, embeds | Fixed with US East + `dns.setDefaultResultOrder('ipv4first')` |
| **Moralis** | Wallet swap polling (optional) | Per-key limits |
| **Helius** | Wallet history, research (optional) | Per-key limits |
| **RugCheck** | `/rug` command | Per-key limits |

No paid DexScreener tier configured. No Birdeye/Jupiter/Helius price stream for polling.

---

## 6. Scale history & current bottleneck

| Metric | ~200–300 tokens (healthy) | ~1,800 tokens (degraded) |
|--------|---------------------------|---------------------------|
| Poll cycle duration | 30–45 s | **15–18 min** (pre-fix); improving post cold-tier |
| Scheduled per cycle | ~200–300 | ~1,700 (pre-fix); ~400–800 hot+warm post-fix (estimate) |
| DexScreener 429s | Rare | **Constant** |
| Milestone reliability | High | Spotty — tokens miss price ticks |
| `/calls` response | OK | Slow + adds API load |

**Root cause:** Single-threaded sequential-ish burst polling against a free public API. Previously ~1,696 tokens were **hot** because `milestones === 0` forced hot tier regardless of age.

---

## 7. Fixes already shipped (Jul 2026, commit `9b3a399`)

| Fix | Implementation |
|-----|----------------|
| Solana-only | `ENABLED_CHAINS=solana`; ignore `0x`; skip non-solana DB rows in poller |
| OG call protection | `storageKeyForMint()` + `resolveTokenKey()` after fetch; never assign `db.tokens[key]` if key exists |
| Same-message dedupe | `seenThisMessage` Set per `messageCreate` |
| Cold tier for dead tokens | `pollTierForEntry()` — no milestones + age > 24h → cold |
| Rate-limited fetch | `runPollBatch()` — 6 workers, 150ms stagger; Sol per-chain API first |
| DB merge on poll save | `activePollTrackedKeys` + `mergePollSnapshot()` — mid-cycle autoTrack not wiped |
| Duplicate CA noise | Reposts silent in Discord (console log only) |

---

## 8. Proposed fixes — roadmap for elite review

### Tier A — In-process (lowest effort, stay on Railway)

#### A1. Global DexScreener queue with adaptive throttle
- Single token bucket / leaky bucket for all DexScreener calls (poll + autotrack + `/calls`)
- On 429: exponential backoff **globally**, pause workers 2s → 4s → 8s
- **Target:** ≤5 req/s sustained, burst ≤10
- **Files:** new `rateLimiter.js`; wrap `fetchDexPair*` in `dexPair.js`

#### A2. Smarter in-process parallel poller (current partial implementation)
- Today: 6 concurrent + 150ms stagger inside one cycle
- Upgrade: priority queue — **hot tokens first**, cold tokens fill spare capacity
- Cap cycle wall time (e.g. 120s) then defer remainder to next cycle
- Env tunables: `POLL_CONCURRENCY`, `POLL_STAGGER_MS`, `POLL_CYCLE_BUDGET_MS`

#### A3. Price source fallback chain
```
DexScreener (primary)
  → Jupiter Price API v2 (Solana, free tier)
  → pump.fun (if platform=pumpfun)
  → Helius DAS / Birdeye (if API keys present)
```
Reduces single-point 429 failure.

#### A4. Dead token archival
- Auto-move tokens to `db.archived` when: age > 30d AND peakMultiple < 1.2 AND milestones.length === 0
- `/calls` shows active only; `/archive` for history
- **Expected reduction:** 40–60% of ~1,800 list

#### A5. Fix `/calls` N+1
- Paginate or sample; never fetch 1,800 live prices in one command
- Or show cached `lastPrice` from DB + stale indicator

---

### Tier B — Multi-worker, single DB (medium effort)

#### B1. Sharded in-process workers
- Partition mints: `hash(mint) % N === workerId`
- N async worker loops in same process, shared rate limiter
- Discord alerts serialized through one client (already single process)

#### B2. Railway multi-replica with leader election
- **Not recommended without shared DB** — two replicas would duplicate alerts and corrupt JSON writes
- Requires Tier C first

---

### Tier C — Parallel pollers / distributed (recommended for 3k+ tokens)

#### C1. Supabase Postgres (or SQLite + Litestream) as source of truth
```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│ Discord Bot │────►│  tokens table    │◄────│  Poller #1  │
│ (autoTrack  │     │  (postedAt,      │     │  hot tier   │
│  + alerts)  │     │   priceAtCall,   │     ├─────────────┤
└─────────────┘     │   milestones)    │◄────│  Poller #2  │
                    └──────────────────┘     │  warm tier  │
                              ▲              ├─────────────┤
                              │              │  Poller #3  │
                    ┌─────────┴────────┐     │  cold tier  │
                    │  price_cache     │     └─────────────┘
                    │  (mint, price,   │
                    │   updated_at)    │
                    └──────────────────┘
```
- **Bot service:** Discord only + writes new tracks + reads price_cache for alerts
- **Poller service(s):** 1–3 Railway services, each owns a tier or hash shard
- **Alert dedupe:** `milestones_fired` column with optimistic locking (`UPDATE … WHERE milestones = $old`)
- Migrate from JSON via one-time `scripts/migrate-to-pg.mjs`

#### C2. Redis queue (BullMQ / custom)
- `TRACK_QUEUE` — jobs `{ mint, tier, priority }`
- Worker pool consumes at fixed rate (respect DexScreener limits)
- Bot enqueues on track; workers write results to Redis hash `price:{mint}`
- Poller loop becomes consumer group

#### C3. Dedicated price ingest service
- Single service polls DexScreener/Jupiter on interval, writes to Redis/Postgres
- All other services read cache only — **decouples** Discord from API limits entirely

---

### Tier D — Real-time (high effort, best UX)

#### D1. WebSocket price feeds
- Birdeye / Helius enhanced websockets for subscribed hot mints only (~50–100)
- Cold tokens stay on REST polling
- Subscribe on autoTrack; unsubscribe when archived

#### D2. Event-driven milestones
- Price update event → milestone evaluator (no 3-min batch delay for hot tokens)
- **Target latency:** <30s from move to Discord alert for hot tier

---

### Tier E — Product / ops (parallel track)

| Item | Notes |
|------|-------|
| Group wallet master list | Subscriber model + `GROUP_WALLET_CHANNEL_ID`; personal lists unchanged |
| Multi-chain v2 | If re-added: strict token-CA-only, never pool addresses in extractAddresses |
| Paid DexScreener / Birdeye | Evaluate cost vs building own Jupiter-based pricer |
| Observability | Prometheus counters: `poll_cycle_duration`, `dex_429_total`, `milestones_fired`, `tokens_by_tier` |
| Alert on bot health | If cycle > 5 min or 429 rate > 50%, ping LOG_CHANNEL |

---

## 9. Recommended implementation order

| Phase | Work | Expected outcome |
|-------|------|------------------|
| **1** | A1 global rate limiter + A3 Jupiter fallback | 429s drop 80%+ |
| **2** | A4 dead token archival | ~800 active tokens |
| **3** | A2 priority queue + cycle budget | Cycles < 3 min again |
| **4** | A5 fix `/calls` | Stop self-DDoS from commands |
| **5** | C1 Supabase + 2 poller services | Clean path to 5k+ tokens |
| **6** | D1 WS for hot tier | Sub-minute alert latency |

---

## 10. Current restrictions

- **Solana only** — `0x` ignored; legacy EVM/Robinhood rows in JSON skipped not deleted
- **Single Node process** — one poll loop, one Discord connection
- **JSON file locking** — no atomic transactions; concurrent writers = corruption risk (mitigated by merge snapshot, not eliminated)
- **DexScreener free tier** — primary bottleneck
- **Alert channel immutable** — first track wins; no per-user alert routing
- **~1,800 token soft ceiling** on current architecture without Tier C

---

## 11. Known bugs & status

| Issue | Status | Notes |
|-------|--------|-------|
| OG call reset on repost | **Fixed** | Canonical mint check before save |
| Pool address bypass (EVM) | **Fixed** | Sol-only removed path |
| Lag / missed updates | **Improved** | Needs A1/A4 for full fix |
| 18-min poll cycles | **Improved** | Monitor `scheduled` count in logs |
| Poll save clobbering autoTrack | **Fixed** | mergePollSnapshot |
| Milestone spam on redeploy | **Mitigated** | bootstrap + COMEBACK_SILENCE_CYCLES |
| Trench reset = feels like re-call | **By design** | OG poster in alert footer unchanged |
| `/calls` hammers DexScreener | **Open** | Tier A5 |
| JSON race if multi-replica | **Open** | Don't scale replicas without Tier C |
| Intermediate saveDB during poll | **Mitigated** | All poll saves merge when activePollTrackedKeys set |

---

## 12. Environment variables

| Variable | Purpose |
|----------|---------|
| `DISCORD_TOKEN` | Bot token |
| `CLIENT_ID` | Slash command registration |
| `ENABLED_CHAINS` | Default `solana` |
| `LOG_CHANNEL_ID` / `SUMMARY_CHANNEL_ID` | Startup banner, daily summary |
| `COMEBACK_SILENCE_CYCLES` | Silent N poll cycles after deploy |
| `MAINTENANCE_MODE` | Suppress alerts, keep polling |
| `MORALIS_API_KEY` | Wallet watcher |
| `HELIUS_API_KEY` | Wallet history, research |
| `RUGCHECK_API_KEY` | `/rug` command |

**Railway:** volume mounted at `/data`; region `us-east4-eqdc4a`.

---

## 13. Reviewer checklist

- [ ] Confirm `autoTrack` never writes if `resolveTokenKey(db, storageKey)` hits
- [ ] Load-test poll cycle with 500 / 1000 / 1800 tokens — measure 429 rate and cycle duration
- [ ] Verify `mergePollSnapshot` under concurrent autoTrack + poll (integration test)
- [ ] Audit all `saveDB()` call sites — index.js vs poller.js independence
- [ ] Validate milestone math edge cases: `priceAtCall=0`, pump.fun → dex migration mid-track
- [ ] Confirm trench reset doesn't fire on bad DexScreener ticks (null price skipped?)
- [ ] Review DexScreener ToS for polling frequency at scale
- [ ] Estimate cost: Railway + Supabase + Birdeye vs status quo

---

## 14. Performance targets (post-fix)

| Metric | Target |
|--------|--------|
| Hot token poll interval | ≤ 60 s |
| Full active list cycle | ≤ 3 min |
| DexScreener 429 rate | < 5% of requests |
| Milestone alert latency (hot) | ≤ 90 s from price move |
| OG call preservation | 100% on repost |
| Data loss on deploy | 0 (volume-backed) |

---

## 15. Data safety note

No migration in current fixes **deletes** tokens. Archival (proposed A4) should move, not drop. Before Tier C, take volume backup via `scripts/backup-volume.mjs` or Railway snapshot.

---

*Last updated: Jul 2026 · commit `9b3a399`*
