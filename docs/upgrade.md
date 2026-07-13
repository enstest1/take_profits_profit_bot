# SPEC: Take Profits v3 — Degen Intelligence MVP
## Implementation instructions for the coding agent

> **Read this entire document before writing any code.** This spec is exhaustive on purpose. Where the spec and your instinct disagree, the spec wins. Where the spec is silent, follow the existing codebase's patterns.

---

## 0. Context you must load first

**Repo:** `enstest1/take_profits_profit_bot` · Node 18+ **ESM** (`"type": "module"` — never use `require`/`module.exports`) · Host: Railway · State: `/data/tracked.json`.

**Before writing code, open and read:** `index.js` (Discord client, `autoTrack()`, slash command registration + handlers), `poller.js` (poll loop, `evaluateGainAndMilestones()`, `processTokenWithLive()`, daily summary), `dbStore.js` (atomic `loadDB`/`saveDB`, `markRemovedThisCycle`), `rateLimiter.js` (global token bucket — ALL external HTTP goes through `rateLimiter.fetch()`), `dexBatch.js` (30-mint batch fetch), `chains.js`, `pumpfunApi.js`.

**Existing invariants you must never break** (a watchdog audits these in production — violating them pages the owner):

1. `postedBy`, `postedByUserId`, `postedAt`, `priceAtCall` on any token entry are **IMMUTABLE** after first write. Never reassign them. (Sole exception that already exists: one-time `priceAtCall` backfill setting `priceAtCallBackfilled: true` — do not add new exceptions.)
2. Solana mint addresses are **case-sensitive base58**. Never call `.toLowerCase()` on a Solana address or use lowercased mints as keys. DB keys are canonical-case mints.
3. Never delete token entries. Archival moves to `db.archived`; that code exists — do not write new deletion paths.
4. All DexScreener / RugCheck / Helius / any external HTTP calls go through `rateLimiter.fetch(url, opts)`. Never call global `fetch()` directly to an external API.
5. One `saveDB(db)` at end of poll cycle. Mid-cycle saves ONLY immediately after a Discord alert successfully sends. Do not add per-token saves.
6. This bot NEVER executes trades, connects wallets for signing, or holds keys. If any part of your implementation drifts toward execution, stop — it is out of scope permanently.
7. All new alert sends must respect `MAINTENANCE_MODE` via the existing `alertGate.js` check, same as current alerts.

---

## 1. Schema additions — single source of truth

Add these fields. **Every field is optional/nullable for backward compatibility** — 1,800 existing entries do NOT have them. Every read must handle `undefined` gracefully. Never run a migration that rewrites all entries; initialize lazily on first touch.

```javascript
// ADDITIONS to db.tokens[mint] — existing fields unchanged
{
  // Phase 1 — lifecycle
  lifecycle: 'trenches' | 'cooking' | 'sending' | 'bleeding' | 'dead',  // derived each poll, cached for embeds

  // Phase 2 — signal-shape alerts
  velocityWindow: [ { t: 1720000000000, mult: 1.42 } ],  // ring buffer, MAX 10 entries, push per successful tick
  velocityAlertAt: 0,          // ts of last velocity alert (cooldown)
  liquidityAtCall: 41200,      // set once at track time; lazily backfilled from first tick if absent
  liqDivergenceAlertAt: 0,     // ts of last divergence alert (cooldown)
  retestAlertFired: false,     // one retest alert per token lifetime, reset when peakMultiple sets new ATH ≥3x

  // Phase 3 — risk
  rugScan: { mintAuthRevoked: true, freezeAuthRevoked: true, top10Pct: 34.2,
             lpLockedOrBurned: true, score: 'ok'|'warn'|'danger', scannedAt: 1720000000000 } | null,
  deployerStats: { wallet: '...', priorLaunches: 3, priorRugs: 3, priorBest: 0.4 } | null,

  // Phase 4 — positions (personal entries; OG call fields untouched)
  positions: { '<discordUserId>': { entry: '0.000041', at: 1720000000000,
               tiersFired: [2,3], deadNotified: false } },

  // Phase 5 — confluence
  callChannels: [ { channelId: '...', at: 1720000000000 } ],  // MAX 10; first element = OG channel
  confluenceAlertFired: false,

  // Phase 6 — meta + ATH ledger
  tags: ['dog'],               // lowercase strings, max 3
  athLedger: { peakMultiple: 14.3, peakAt: 1720000000000, minsToPeak: 372 } | null,  // written when peak updates
}

// NEW top-level DB keys (initialize lazily: db.callers = db.callers || {})
db.callers = {
  '<discordUserId>': {         // rebuilt nightly by rebuildCallerStats(); treat as cache, source of truth is token entries
    name: 'degen#0',           // last-known display name
    totalCalls: 41, hits2x: 26, rugs: 5,
    avgPeak: 3.1, medianMinsTo2x: 84,
    bestCall: { mint: '...', symbol: 'WIF', peak: 14.3, at: 1720000000000 },
    streak2x: 3,
    updatedAt: 1720000000000,
  }
};
db.subscriptions = {
  followCaller: { '<callerUserId>': ['<subscriberUserId>', ...] },   // /follow
  watchToken:   { '<mint>':        ['<subscriberUserId>', ...] },    // /watch
};
db.deployers = {               // deployer memory index; rebuilt by scripts/rebuild-deployer-index.mjs, updated incrementally on track
  '<devWalletAddress>': { launches: ['<mint>', ...], updatedAt: 1720000000000 }
};
```

**Constants module — create `signals/config.js`; every threshold lives here, nothing hardcoded inline:**

```javascript
export const CFG = {
  VELOCITY_WINDOW_MS: 10 * 60 * 1000,
  VELOCITY_MIN_GAIN: 0.5,              // +50% within window triggers
  VELOCITY_COOLDOWN_MS: 30 * 60 * 1000,
  LIQ_DIVERGENCE_MIN_MULT: 2.0,        // only fires when price ≥ 2x call
  LIQ_DIVERGENCE_DROP_PCT: 0.30,       // liquidity −30% vs liquidityAtCall
  LIQ_DIVERGENCE_COOLDOWN_MS: 6 * 60 * 60 * 1000,
  RETEST_PEAK_MIN: 3.0,                // token must have peaked ≥3x for retest to be interesting
  RETEST_BAND: [0.95, 1.10],           // multiple range that counts as "retesting call"
  LIFECYCLE: { COOKING_MIN: 1.5, SENDING_MIN: 3.0, BLEED_FROM_PEAK: 0.5, DEAD_MULT: 0.3, DEAD_AGE_H: 24 },
  CONFLUENCE_WINDOW_MS: 15 * 60 * 1000,
  CONFLUENCE_MIN_CHANNELS: 2,
  RUGSCAN_TIMEOUT_MS: 8000,
  POSITION_TIERS: [2, 3, 5, 10],       // personal DM tiers
  RECAP_DAY_UTC: 0,                    // Sunday
  MAX_TAGS: 3,
};
```

---

## 2. Phase plan — implement in this exact order, one commit per phase

| Phase | Name | New files | Touched files |
|-------|------|-----------|---------------|
| 1 | Caller stats + lifecycle | `callerStats.js`, `signals/lifecycle.js`, `signals/config.js` | `index.js`, `poller.js` |
| 2 | Signal-shape alerts | `signals/velocity.js`, `signals/liquidity.js`, `signals/retest.js` | `poller.js` |
| 3 | Rug-scan + deployer memory | `risk/rugscan.js`, `risk/deployers.js`, `scripts/rebuild-deployer-index.mjs` | `index.js` |
| 4 | Positions + subscriptions + DM router | `positions.js`, `subscriptions.js`, `dmRouter.js` | `index.js`, `poller.js` |
| 5 | Confluence | `signals/confluence.js` | `index.js`, `poller.js` |
| 6 | Meta tags + ATH ledger + weekly recap | `metaTags.js`, `recap.js` | `index.js`, `poller.js` |
| 7 | Helius dev-sell webhooks | `webhooks/heliusServer.js`, `webhooks/devSell.js` | `index.js` |

Each phase must independently pass `node --check` on every file and boot cleanly with the phase's env vars absent (feature silently disabled, never a crash). **Do not start phase N+1 until phase N compiles and its acceptance tests (§10) conceptually pass.**

---

## 3. Phase 1 — Caller stats + lifecycle

### 3.1 `callerStats.js`

```javascript
// callerStats.js — caller reputation computed from token entries. db.callers is a CACHE.
import { CFG } from './signals/config.js';

/** Rebuild db.callers from scratch by scanning db.tokens + db.archived. Pure function, no I/O. */
export function rebuildCallerStats(db) { /* group entries by postedByUserId; compute stats below */ }

/** Stats definitions — implement EXACTLY these semantics: */
// totalCalls: entries where postedByUserId === userId (tokens + archived)
// hits2x:     of those, count where (peakMultiple ?? 1) >= 2
// rugs:       count where (peakMultiple ?? 1) < 0.5 AND entry age > 24h at eval time
//             (age = now - postedAt; do NOT count young tokens as rugs)
// avgPeak:    mean of peakMultiple over calls with peakMultiple != null, 1 decimal
// medianMinsTo2x: median of (firstTierAt - postedAt)/60000 across hits.
//             firstTierAt: use athLedger?.peakAt fallback peakAt if no per-tier timestamps exist —
//             note the approximation in a code comment; do NOT invent new timestamp fields for old data
// bestCall:   entry with max peakMultiple
// streak2x:   walking calls newest→oldest by postedAt, count consecutive with peak >= 2,
//             SKIPPING calls younger than 24h (unresolved)
// hitRate for display = hits2x / max(1, totalCalls - callsYoungerThan24h)

/** One-line stats string for embeds. Returns '' when totalCalls < 3 (no stats spam on new callers). */
export function callerStatLine(db, userId) {
  const c = db.callers?.[userId];
  if (!c || c.totalCalls < 3) return '';
  const hitPct = Math.round((c.hits2x / Math.max(1, c.totalCalls)) * 100);
  return `${hitPct}% hit rate · ${c.avgPeak}x avg peak · ${c.totalCalls} calls`;
}
```

**Integration — nightly rebuild:** in `poller.js`, in the same place the daily summary is scheduled, call `rebuildCallerStats(db)` once per day and persist via the normal end-of-cycle save. Also call it incrementally-cheap: after ANY milestone/tier alert fires for a token, update just that caller's entry (recompute from their calls only — filter is cheap).

**Integration — auto-track embed:** in `index.js` `autoTrack()`, where the 📡 embed is built, append the stat line to the description when non-empty:

```
📡 Auto-tracking WIF (dogwifhat)
Called by @degen — 63% hit rate · 3.1x avg peak · 41 calls
Price at call: $0.000041 · MCap: $412K
```

Exact rule: `Called by @{postedBy}` line always present (it already is); append ` — ${statLine}` only when `statLine !== ''`.

### 3.2 Slash commands `/rank` and `/leaderboard`

Register alongside existing commands, same registration pattern as `/calls`.

**`/rank user:@member`** → single embed, ephemeral FALSE (public flexing is the point):

```
🏆 Rank — @degen
Calls: 41 · Hit rate (2x+): 63% · Rugs: 12%
Avg peak: 3.1x · Median time to 2x: 1h 24m · Streak: 3 🔥
Best call: $WIF — 14.3x (Jun 12)
```

If `totalCalls === 0`: reply `No tracked calls from that user yet.` If `db.callers` missing that user but they have entries, rebuild their stats inline before replying.

**`/leaderboard [period: weekly|alltime]`** (default weekly) → top 10 by hit rate, tiebreak avg peak, **minimum 3 resolved calls in period** (weekly = `postedAt` within last 7 days):

```
🏆 Leaderboard — This Week
1. @degen — 71% hits · 3.4x avg · 7 calls
2. @wallet_god — 60% hits · 5.1x avg · 5 calls
...
Min 3 calls to rank. Full stats: /rank @user
```

Both commands read from `db.callers` cache — zero external API calls. `deferReply()` first, same as `/calls`.

### 3.3 `signals/lifecycle.js`

```javascript
import { CFG } from './config.js';
/** Pure function. Called once per token per poll tick. Returns lifecycle string. */
export function deriveLifecycle(entry, currentMult, now = Date.now()) {
  const L = CFG.LIFECYCLE;
  const peak = Number(entry.peakMultiple) || 1;
  const ageH = (now - (entry.postedAt || now)) / 3600e3;
  if (currentMult <= L.DEAD_MULT && ageH > L.DEAD_AGE_H) return 'dead';
  if (peak >= L.COOKING_MIN && currentMult <= peak * L.BLEED_FROM_PEAK) return 'bleeding';
  if (currentMult >= L.SENDING_MIN) return 'sending';
  if (currentMult >= L.COOKING_MIN) return 'cooking';
  return 'trenches';
}
export const LIFECYCLE_EMOJI = { trenches: '🌱', cooking: '🍳', sending: '🚀', bleeding: '🔻', dead: '💀' };
```

**Integration:** in `poller.js` `processTokenWithLive()`, after computing `currentMult`, set `entry.lifecycle = deriveLifecycle(entry, currentMult)`. **Display:** prefix `LIFECYCLE_EMOJI[entry.lifecycle]` before the token name in `/calls` rows and in every alert embed title. No alerts fire on lifecycle transitions in this MVP — it is display-only.

---

## 4. Phase 2 — Signal-shape alerts (velocity, liquidity divergence, retest)

All three are evaluated inside the poll tick, AFTER milestone evaluation, using the SAME live data object — zero extra API calls. Each module exports one pure-ish function with signature `(client, db, mint, entry, live, now) => Promise<boolean /*alerted*/>`. Call them in `processTokenWithLive()` in this order: velocity → liquidity → retest. Each does its own cooldown check; a `true` return means an alert was sent (triggering the existing post-alert save).

### 4.1 `signals/velocity.js`

```javascript
// Push tick FIRST, then evaluate:
// entry.velocityWindow = (entry.velocityWindow || []).slice(-9);  // keep ≤10 after push
// entry.velocityWindow.push({ t: now, mult: currentMult });
//
// Trigger when ALL true:
//   oldest tick within CFG.VELOCITY_WINDOW_MS exists (call it base)
//   currentMult >= base.mult * (1 + CFG.VELOCITY_MIN_GAIN)
//   now - (entry.velocityAlertAt || 0) > CFG.VELOCITY_COOLDOWN_MS
//   currentMult >= 1.5   // never velocity-alert a token still underwater vs call
// On fire: set entry.velocityAlertAt = now.
```

Embed (send to `entry.alertChannelId`, same channel-resolution helper existing alerts use):

```
🚀 VELOCITY — WIF
+82% in 6 min · now 3.4x from @degen's call
Price $0.00014 · Liq $220K · Vol24h $1.2M
```

Compute the "+82% in 6 min" values from `base` → current: pct = `(currentMult/base.mult − 1) * 100` rounded; minutes = `(now − base.t)/60000` rounded.

### 4.2 `signals/liquidity.js`

```javascript
// Lazy baseline: if entry.liquidityAtCall == null && live.liquidity > 0 → set it, no alert this tick.
// Trigger when ALL true:
//   currentMult >= CFG.LIQ_DIVERGENCE_MIN_MULT
//   live.liquidity > 0 && entry.liquidityAtCall > 0
//   live.liquidity <= entry.liquidityAtCall * (1 - CFG.LIQ_DIVERGENCE_DROP_PCT)
//   cooldown vs entry.liqDivergenceAlertAt
```

```
⚠️ LIQUIDITY DIVERGENCE — WIF
Price 2.8x from call but liquidity down 41% since call ($71K → $42K)
Possible distribution / rug-in-progress. Not financial advice — check the chart.
```

**Edge case you must handle:** DexScreener sometimes returns `liquidity: 0`/missing on a bad tick. NEVER alert on a zero/absent liquidity reading — skip evaluation that tick.

### 4.3 `signals/retest.js`

```javascript
// Trigger when ALL true:
//   (entry.peakMultiple || 1) >= CFG.RETEST_PEAK_MIN
//   currentMult >= CFG.RETEST_BAND[0] && currentMult <= CFG.RETEST_BAND[1]
//   entry.retestAlertFired !== true
// On fire: entry.retestAlertFired = true.
// Reset rule (implement where peakMultiple updates): if a NEW ATH prints while
// retestAlertFired === true and new peak >= CFG.RETEST_PEAK_MIN → set retestAlertFired = false
// (a token can round-trip more than once).
```

```
🎯 CALL RETEST — WIF
Back at OG call price (1.02x) after peaking 5.2x
Called by @degen · Jun 12 · full round trip
```

---

## 5. Phase 3 — Rug-scan on track + deployer memory

### 5.1 `risk/rugscan.js`

Uses the existing RugCheck integration pattern from the `/rug` command handler — find it in `index.js`, extract the fetch+parse into this module, and have `/rug` call the shared function too (do not leave two copies).

```javascript
/** Non-blocking scan. NEVER delays or fails the auto-track embed. */
export async function scanOnTrack(client, db, mint, entry) {
  // 1. rateLimiter.fetch RugCheck with AbortSignal.timeout(CFG.RUGSCAN_TIMEOUT_MS)
  // 2. On ANY failure: entry.rugScan = null, return silently. Auto-track already succeeded.
  // 3. score: 'danger' if mintAuth NOT revoked OR freezeAuth NOT revoked OR top10Pct > 60
  //           'warn'   if top10Pct > 40 OR !lpLockedOrBurned
  //           'ok'     otherwise
  // 4. Write entry.rugScan, then EDIT the already-sent auto-track embed message to append the risk line.
  //    (autoTrack must pass the sent Message object into scanOnTrack for this.)
}
```

**Call pattern in `autoTrack()` — this exact shape, fire-and-forget:**

```javascript
const sentMsg = await channel.send({ embeds: [trackingEmbed] });
scanOnTrack(client, db, storageKey, entry, sentMsg).catch(e =>
  console.error('[rugscan] non-fatal:', e.message));   // NO await — embed latency is sacred
```

Risk line appended to embed description, exact formats:

```
🛡️ Risk: OK — mint/freeze revoked · top10 34% · LP locked
🛡️ Risk: ⚠️ WARN — top10 47% · LP not locked
🛡️ Risk: ☠️ DANGER — mint authority ACTIVE
```

### 5.2 `risk/deployers.js` + rebuild script

```javascript
/** Incremental: called on every successful autoTrack when entry.devWallet exists. */
export function indexDeployer(db, devWallet, mint) {
  db.deployers = db.deployers || {};
  const d = db.deployers[devWallet] = db.deployers[devWallet] || { launches: [], updatedAt: 0 };
  if (!d.launches.includes(mint)) d.launches.push(mint);
  d.updatedAt = Date.now();
}

/** Look up history and compute stats vs OTHER launches (exclude current mint). */
export function deployerHistoryLine(db, devWallet, currentMint) {
  const launches = (db.deployers?.[devWallet]?.launches || []).filter(m => m !== currentMint);
  if (launches.length === 0) return '';
  const entries = launches.map(m => db.tokens[m] || db.archived?.[m]).filter(Boolean);
  const rugs = entries.filter(e => (Number(e.peakMultiple) || 1) < 0.5).length;
  const best = Math.max(1, ...entries.map(e => Number(e.peakMultiple) || 1));
  if (rugs >= 2 && rugs === entries.length)
    return `☠️ Deployer: ${entries.length} prior launches, ALL dead (<0.5x)`;
  return `📜 Deployer: ${entries.length} prior — ${rugs} rugged · best ${best.toFixed(1)}x`;
}
```

`scripts/rebuild-deployer-index.mjs`: standalone script, walks `db.tokens` + `db.archived`, calls `indexDeployer` for every entry with `devWallet`, atomic save, prints count. Run once manually after deploy; incremental indexing keeps it current after that.

**Embed integration:** in `autoTrack()`, if `deployerHistoryLine()` returns non-empty, include it in the initial tracking embed (deployer lookup is local DB — no API, so it CAN be synchronous, unlike rug-scan).

---

## 6. Phase 4 — Positions, subscriptions, DM router

### 6.1 `dmRouter.js` — build this FIRST in the phase, both features depend on it

```javascript
// dmRouter.js — all DM sending goes through here. Handles closed DMs gracefully.
const dmCooldown = new Map();  // `${userId}:${mint}:${kind}` → ts

export async function sendDM(client, userId, embed, dedupeKey, cooldownMs = 60_000) {
  if (dedupeKey && Date.now() - (dmCooldown.get(dedupeKey) || 0) < cooldownMs) return false;
  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [embed] });
    if (dedupeKey) dmCooldown.set(dedupeKey, Date.now());
    return true;
  } catch (e) {
    // 50007 = user has DMs closed. Log once, never retry-spam, never crash the poll loop.
    console.warn(`[dm] cannot DM ${userId}: ${e.code || e.message}`);
    return false;
  }
}
```

### 6.2 `positions.js` — `/ape`, `/mybags`, personal tiers

**`/ape ca:<string> price:<number optional>`** — ephemeral reply.
Resolution rules, in order: token must already be tracked (case-sensitive key lookup; if the raw input misses, try the existing `resolveTokenKey` helper). Not tracked → reply `Not tracking that CA. Post it in the channel first to start tracking.` Entry price = provided `price` arg, else `entry.lastPrice`, else reply `No live price yet — pass price: explicitly.` Write `entry.positions[userId] = { entry: String(px), at: Date.now(), tiersFired: [], deadNotified: false }`. One position per user per token; re-running `/ape` **overwrites their own position** (confirm in the reply: `Updated your entry on $WIF to $0.000038`).

**Poll-tick evaluation** (in `processTokenWithLive()`, after signal alerts): for each `[userId, pos]` in `entry.positions || {}`: `personalMult = livePrice / Number(pos.entry)`. For each tier in `CFG.POSITION_TIERS` not in `pos.tiersFired` where `personalMult >= tier`: push tier, DM via router with `dedupeKey = ${userId}:${mint}:tier${tier}`:

```
💰 Your bag: WIF hit 3x from YOUR entry
Your entry $0.000038 → now $0.000121 (3.2x)
OG call by @degen is at 4.1x · Lifecycle: 🚀 sending
```

Fire only the HIGHEST new tier per tick (mirror the existing milestone highest-only rule).

**`/mybags`** — ephemeral, zero API calls, from cache: every token where `entry.positions[callerId]` exists, sorted by personal multiple desc, ⏳ stale marker reusing the `/calls` staleness rule:

```
💼 Your bags (3)
🚀 WIF — 3.2x from your entry (OG call 4.1x)
🍳 POPCAT — 1.7x from your entry ⏳
💀 RETARDIO — 0.2x from your entry
```

### 6.3 `subscriptions.js` — `/follow`, `/watch`, `/unfollow`, `/unwatch`

Storage per schema §1. `/follow @user` → add caller subscription, reply ephemeral `Following @degen — you'll get a DM whenever they call.` `/watch <ca>` → same for a mint. Un-commands remove; removing a non-existent sub replies `You weren't following that.` — never throws.

**Routing hooks (exactly two):**
1. In `autoTrack()` after the tracking embed sends: DM every user in `db.subscriptions.followCaller[postedByUserId] || []` a compact copy of the tracking embed, dedupeKey `${subId}:${mint}:newcall`.
2. In the alert send path (milestones, velocity, divergence, retest, graduation): after the channel alert sends, DM every user in `db.subscriptions.watchToken[mint] || []` the same embed, dedupeKey `${subId}:${mint}:${alertKind}`.

Never DM a user about their own action (skip when `subscriberId === postedByUserId` on follow-routing).

---

## 7. Phase 5 — Confluence

### 7.1 Channel confluence — `signals/confluence.js`

Integration point: `autoTrack()`'s "already tracking" branch (where reposts currently return silently). Reposts stay silent in the channel — but they now feed the confluence counter:

```javascript
export async function recordChannelSighting(client, db, mint, channelId, now = Date.now()) {
  const entry = db.tokens[mint]; if (!entry) return;
  entry.callChannels = entry.callChannels || [{ channelId: entry.alertChannelId, at: entry.postedAt }];
  if (!entry.callChannels.some(c => c.channelId === channelId)) {
    entry.callChannels.push({ channelId, at: now });
    entry.callChannels = entry.callChannels.slice(0, 10);
  }
  const inWindow = entry.callChannels.filter(c => now - c.at <= CFG.CONFLUENCE_WINDOW_MS);
  if (inWindow.length >= CFG.CONFLUENCE_MIN_CHANNELS && !entry.confluenceAlertFired) {
    entry.confluenceAlertFired = true;
    // send to entry.alertChannelId:
    // 🔥 CONFLUENCE — WIF called in 3 channels within 11 min
    // OG call: @degen · currently 1.3x
  }
}
```

Note: the OG channel counts as sighting #1 only within the window — a repost in a second channel 3 days later is NOT confluence (the window filter handles this naturally).

### 7.2 Wallet confluence

Integration point: `pollWallets()` in `poller.js` already detects buys for watched wallets. Add exactly one check where a buy is processed: if the bought mint (case-sensitive) exists in `db.tokens` and the entry is < 7 days old, send to `entry.alertChannelId`:

```
🐋 SMART MONEY — tracked wallet aped WIF
Wallet: gake.sol (watched) · 2h 14m after @degen's call · token at 1.8x
```

Guard: max ONE wallet-confluence alert per mint per 6h (reuse the cooldown-timestamp pattern: `entry.walletConfluenceAt`). If `pollWallets` doesn't expose the buy's mint cleanly, refactor minimally to surface it — do not duplicate wallet-polling logic.

---

## 8. Phase 6 — Meta tags, ATH ledger, weekly recap

### 8.1 `/tag ca:<string> tags:<string>` (`metaTags.js`)

Parse comma/space-separated, lowercase, max `CFG.MAX_TAGS`, each tag `/^[a-z0-9_-]{2,16}$/` — reject others with an ephemeral error listing the offending tag. Overwrites the token's tags. Reply: `Tagged $WIF: dog, celeb`.

### 8.2 ATH ledger

Where `peakMultiple` updates (find the single place in the evaluator — it exists), also write:

```javascript
entry.athLedger = { peakMultiple: newPeak, peakAt: now,
                    minsToPeak: Math.round((now - entry.postedAt) / 60000) };
```

Surface in `/rank` bestCall line and `/calls` rows for peaked tokens (`peaked 5.2x`).

### 8.3 `recap.js` — weekly recap

Scheduled like the daily summary but weekly (`CFG.RECAP_DAY_UTC`, post to `SUMMARY_CHANNEL_ID`). All data from DB cache — zero API calls. Sections, exact order; omit any empty section entirely:

```
📅 WEEKLY RECAP — Jun 29 – Jul 5
👑 Call of the week: $WIF by @degen — 14.3x, peaked in 6h 12m
⚡ Fastest 2x: $POPCAT by @wallet_god — 2x in 22 min
🎢 Biggest round trip: $RETARDIO — peaked 8.1x, now 0.4x. F.
🏆 Leaderboard movement: @degen 71% (↑2) · @wallet_god 60% (↓1)
🏷️ Meta report: dog — 9 calls, 44% hit, 2.8x avg · ai — 12 calls, 18% hit, 1.4x avg
📊 Week totals: 34 calls · 12 hit 2x+ · 5 rugged
```

Definitions: "week" = `postedAt` within the last 7 days, except round-trip which may include older tokens whose peak OR trough happened this week. Meta report groups this week's calls by tag; untagged grouped as `untagged` and shown only if ≥5 calls.

---

## 9. Phase 7 — Helius dev-sell webhooks

**Env-gated:** if `HELIUS_API_KEY` or `WEBHOOK_PUBLIC_URL` or `WEBHOOK_SECRET` is absent, log `[devsell] disabled (missing env)` once at boot and skip entirely. The bot must run fine without this phase.

`webhooks/heliusServer.js`: HTTP server on `process.env.PORT` (Railway provides it). Single route `POST /helius-webhook`. **Auth:** reject with 401 unless `req.headers.authorization === process.env.WEBHOOK_SECRET` (set the same value as the webhook's authHeader when registering with Helius). Respond `200` immediately, process the payload async — Helius retries on non-200 and slow responses.

`webhooks/devSell.js`:

```javascript
// Subscription lifecycle:
// - subscribeDevWallet(mint, devWallet): called on autoTrack when devWallet exists AND
//   active subscription count < 90 (Helius per-webhook address limits — track count in db.meta)
// - unsubscribeDevWallet: called on archival and on lifecycle === 'dead'
// - Manage ONE Helius webhook (create on first use, store webhookID in db.meta.heliusWebhookId,
//   PATCH the address list on subscribe/unsubscribe). transactionTypes: ['SWAP','TRANSFER']
//
// On incoming event: match tx account → devWallet → mint(s). A SELL = dev wallet is the
// source of the tracked mint in a swap/transfer OUT. Ignore buys. Ignore amounts worth
// < $100 (dust). Cooldown: one alert per dev per mint per 30 min.
```

Alert (to `entry.alertChannelId`, and to `/watch` subscribers via dmRouter):

```
🚨 DEV SELLING — WIF
Dev wallet moved ~$4,200 of supply 38s ago
Token at 2.4x from call · Liq $180K
```

The "38s ago" is `now - tx timestamp` — this alert's entire value is beating the poll cycle, so send it the moment the event processes.

---

## 10. Acceptance tests — the implementation is not done until every row passes

| # | Test | Expected |
|---|------|----------|
| 1 | Fresh CA from a caller with ≥3 prior calls | Embed includes stat line; caller with <3 calls shows no stat line |
| 2 | `/rank` on user with 0 calls | Graceful "no calls" message, no throw |
| 3 | `/leaderboard weekly` with nobody at 3+ calls this week | "Not enough resolved calls this week." — no empty embed |
| 4 | Token ticks 1.0→1.9 in one poll (< 10 min window) | Velocity alert fires once; second qualifying tick within 30 min stays silent (cooldown) |
| 5 | live.liquidity = 0 on a tick | No divergence alert, no crash, baseline unchanged |
| 6 | Token peaked 5x, ticks at 1.03x | Retest alert fires once; ticks at 1.04x next cycle → silent |
| 7 | RugCheck timeout on autoTrack | Tracking embed sent normally, no risk line, `rugScan: null`, no unhandled rejection |
| 8 | New CA from deployer with 3 dead prior launches | ☠️ deployer line present in the initial embed |
| 9 | `/ape` on untracked CA | "Not tracking that CA" — nothing written |
| 10 | `/ape` twice by same user | Second overwrites own position; other users' positions on the token untouched |
| 11 | Position hits 3x with user's DMs closed | Warn logged once, poll loop continues, other DMs still send |
| 12 | Same CA in 2 channels within 15 min | ONE confluence alert in the OG channel; channel #2 gets no embed (repost silence preserved) |
| 13 | Same CA in channel #2 three days later | No confluence alert |
| 14 | `/tag` with 4 tags or an invalid tag | Ephemeral error naming the problem; nothing written |
| 15 | Weekly recap with zero calls this week | Totals-only recap or skip — never an embed with empty/undefined fields |
| 16 | Boot WITHOUT Helius env vars | One "[devsell] disabled" log line, bot fully functional |
| 17 | **OG invariant sweep** | After running ALL tests: `postedBy`, `postedByUserId`, `postedAt`, `priceAtCall` byte-identical to pre-test values on every touched entry |
| 18 | **Case sweep** | `grep -rn "toLowerCase" signals/ risk/ positions.js subscriptions.js` shows zero hits on address/mint variables |
| 19 | Every new external call | `grep` confirms it goes through `rateLimiter.fetch` — zero direct `fetch(` to external hosts outside rateLimiter/dmRouter/Discord lib |
| 20 | `node --check` on every file, per phase commit | Clean |

## 11. Conventions

Commits: one per phase, message `feat(v3-p<N>): <phase name>`, branch `feature/degen-v3`. Every new module: ESM, top-of-file comment stating purpose + integration points. Every threshold via `CFG` — a reviewer must be able to retune the whole system in one file. Errors: no new alert/DM path may ever crash the poll loop — wrap sends in try/catch, log with a `[module]` prefix. Discord embed descriptions ≤ 4096 chars; when listing (e.g., `/mybags`), cap at 25 rows + `…and N more`. Do not modify: `dexBatch.js`, `rateLimiter.js` internals, `dbStore.js` internals, the milestone tier math, or anything under `scripts/repair-*`. If a needed integration point doesn't exist as described (function names may differ), find the equivalent by behavior and note the mapping in the commit message — do not restructure existing code to match this spec's naming.