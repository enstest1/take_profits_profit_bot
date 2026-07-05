# Take Profits Scanner — Code Review & Fix Plan

> Reviewed: `enstest1/take_profits_profit_bot` @ `main` (Jul 2026) · 3,524 LoC across 9 JS files
> Focus: slow polling at ~1,800 tokens, DexScreener 429s, missed updates, data safety

---

## Executive summary

The slow-polling problem is **not** a "need more pollers" problem. It's three things:

1. **You poll one token per HTTP request.** DexScreener has a **batch endpoint that accepts up to 30 mints per request**. Switching to it turns a 1,800-request cycle into ~60 requests. At DexScreener's documented ~300 req/min limit, a full cycle fits in **~15 seconds**, not 15 minutes. This one change gets you "laser quick" without any new infrastructure.
2. **You have no shared rate limiter**, so the poller, `/calls`, autotrack, and the daily summary all compete blindly. `/calls` and the daily summary each fire **~1,800 concurrent requests instantly** via `Promise.allSettled(entries.map(fetch))` — that alone triggers a 429 storm that then poisons the poll cycle running next to it.
3. **Likely severe bug: Solana mints are being lowercased before storage.** Base58 is case-sensitive; lowercasing is lossy. Any dex-listed token gets stored under a key the API can't look up again, and your OG-preservation logic then *blocks* re-tracking it with the correct case. This is plausibly a major hidden cause of "lag / missed updates" and dead milestone tracking. Details and a self-healing fix in §2.

On your "run multiple pollers" idea: multiple poller processes on the same Railway box **share one public IP and therefore one DexScreener rate limit**. Sharding adds complexity (shared DB, alert dedupe, JSON write races — your handoff doc already flags this) without adding a single extra request of capacity. Batch requests + a global limiter max out the API from one process. Sharded pollers only make sense later, at 5k+ tokens with Postgres (your Tier C) — and even then the win is isolation, not speed.

**Recommended order (each section below has drop-in code):**

| # | Fix | Effort | Impact |
|---|-----|--------|--------|
| 1 | Batch DexScreener fetch (30 mints/req) | Medium | Cycle: minutes → seconds |
| 2 | Fix Solana mint lowercasing + repair legacy keys | Small | Restores polling for affected tokens |
| 3 | Global rate limiter + 429 circuit breaker | Small | 429s → near zero |
| 4 | `/calls` + daily summary read cached prices | Small | Kills the self-DDoS |
| 5 | Atomic DB writes + one save per cycle | Small | No corruption, no event-loop stalls |
| 6 | Dead-token archival | Small | Active list −40–60% |
| 7 | Delete dead CJS files, dedupe helpers | Trivial | Hygiene |

Fixes 1–5 are all "Tier A, same Railway box" and together should put a full active cycle **under 60 seconds** at 1,800 tokens.

---

## 1. THE fix: batch DexScreener requests (30 mints per call)

### Current behavior

`poller.js → fetchLiveData()` makes **1–4+ requests per token per cycle**:

```js
// per token, per cycle:
let dex = await fetchDexPairOnChain('solana', address, { retries: 2, ... });   // up to 2 reqs
if (!dex?.price) {
  dex = await fetchDexPair(address, { retries: 2, ... });                       // up to 2 more
}
```

With 6 workers × 150ms stagger you cap at ~6–7 req/s of *successful* traffic, but every failure retries independently, so under 429 pressure your request count **goes up**, which is exactly backwards.

### The batch endpoint

```
GET https://api.dexscreener.com/tokens/v1/solana/{mintA},{mintB},...   (up to 30 addresses)
```

Returns an array of all pairs across all requested tokens. Rate limit is per **request**, not per token — so 30 tokens cost the same budget as 1.

Napkin math at 1,800 tokens: `1800 / 30 = 60 requests`. Even throttled to a conservative 4 req/s, that's a **15-second full cycle**. Post-archival (~800 active) it's ~7 seconds. Hot tokens can realistically be polled **every 30–60s**.

### Drop-in code — `dexBatch.js` (new file)

```js
// dexBatch.js — batch price fetch for Solana mints via DexScreener
import { rateLimiter } from './rateLimiter.js'; // see §3

const BATCH_SIZE = 30;

function pickBestPairPerToken(pairs, wantedMints) {
  // Map each requested mint (exact case) -> highest-liquidity pair
  const wanted = new Set(wantedMints);
  const best = new Map();
  for (const pair of pairs || []) {
    const base = pair.baseToken?.address;
    const quote = pair.quoteToken?.address;
    const mint = wanted.has(base) ? base : (wanted.has(quote) ? quote : null);
    if (!mint) continue;
    const liq = pair.liquidity?.usd ?? 0;
    const cur = best.get(mint);
    if (!cur || liq > (cur.liquidity?.usd ?? 0)) best.set(mint, pair);
  }
  return best;
}

function pairToLive(pair, mint) {
  const isBase = pair.baseToken?.address === mint;
  const meta = isBase ? pair.baseToken : pair.quoteToken;
  const buys = pair.txns?.h24?.buys || 0;
  const sells = pair.txns?.h24?.sells || 0;
  const total = buys + sells;
  return {
    address: mint,                        // NOTE: exact case preserved (§2)
    name: meta?.name || meta?.symbol || 'Unknown',
    symbol: meta?.symbol || '?',
    price: pair.priceUsd != null ? String(pair.priceUsd) : null,
    marketCap: pair.marketCap ?? null,
    volume24h: pair.volume?.h24 || 0,
    liquidity: pair.liquidity?.usd || 0,
    buyPct: total > 0 ? Math.round((buys / total) * 100) : null,
    priceChange1h: pair.priceChange?.h1 ?? null,
    dexUrl: pair.url || null,
    imageUrl: pair.info?.imageUrl || null,
    source: 'dexscreener',
  };
}

/**
 * Fetch live data for many Solana mints in batches of 30.
 * @returns Map<mint, liveData> — mints with no listed pair are absent.
 */
export async function batchFetchSolana(mints, { timeoutMs = 12_000 } = {}) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += BATCH_SIZE) {
    const chunk = mints.slice(i, i + BATCH_SIZE);
    const url = 'https://api.dexscreener.com/tokens/v1/solana/' + chunk.join(',');
    try {
      const res = await rateLimiter.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res || !res.ok) continue;             // limiter handles 429 backoff globally
      const pairs = await res.json();
      const best = pickBestPairPerToken(Array.isArray(pairs) ? pairs : [], chunk);
      for (const [mint, pair] of best) out.set(mint, pairToLive(pair, mint));
    } catch (e) {
      console.error('[dexBatch] chunk failed (' + chunk.length + ' mints):', e.message);
    }
  }
  return out;
}
```

### Poller rewrite sketch — `poller.js → pollTokens()`

Replace the per-token `runPollBatch(scheduled, ...)` fetching with one batch pass, then evaluate each token against its pre-fetched live data. pump.fun bonding tokens (no dex pair yet) keep the old per-token path — but that's typically a few dozen tokens, not 1,800.

```js
// inside pollTokens(), after building `scheduled`:
const dexMints = [];
const pumpMints = [];
for (const address of scheduled) {
  const entry = db.tokens[address];
  if (entry?.platform === 'pumpfun' && !entry.graduationAlertFired) pumpMints.push(address);
  else dexMints.push(address);
}

// hot tokens first so a mid-cycle abort still covers what matters (§6 of handoff: A2)
dexMints.sort((a, b) => tierRank(db.tokens[a]) - tierRank(db.tokens[b])); // hot=0, warm=1, cold=2

const liveMap = await batchFetchSolana(dexMints);

for (const address of dexMints) {
  let live = liveMap.get(address);
  if (!live) continue;                                   // no pair / API miss — skip this cycle
  try {
    await processTokenWithLive(client, address, db, live, milestoneOptsFor(address));
  } catch (e) {
    console.error('[poll] Error processing ' + address + ':', e.message);
  }
}

// bonding-curve tokens: keep old concurrent per-token path (small list)
await runPollBatch(pumpMints, async (address) => { /* existing processToken() */ });
```

`processTokenWithLive` is `processToken` minus the fetch — pass `live` in. Graduation detection for pump.fun tokens stays on the per-token path; once a token shows up in the batch results with a real pair, flip `platform = 'dexscreener'` so it moves to the batch path next cycle.

**Why this also fixes accuracy:** every scheduled token now gets a price tick every cycle instead of silently timing out behind 429s, so milestones stop being "spotty."

---

## 2. Likely severe bug — Solana mints lowercased in storage keys

### The bug

`dexPair.js → pairToToken()`:

```js
return {
  address: String(address || '').toLowerCase(),   // ← lossy for base58!
  ...
```

Then `chains.js → storageKeyForMint(address, token)` returns `token.address` — i.e. the **lowercased** mint — and `autoTrack()` uses that as the DB key and stores it as `entry.address`. The poller then calls `fetchLiveData(lowercasedKey)`.

Solana base58 addresses are case-sensitive. `7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hp` and its lowercase form are **different strings referring to nothing alike** — the lowercase form is not a valid reference to the mint, and the original case cannot be reconstructed from it.

Consequences, in order of pain:

1. **Dex-listed tokens tracked via this path may be unpollable** — every poll lookup uses a key the API can't resolve → no price ticks → no milestones → after 24h the tier logic classifies them **cold** → the token is effectively dead in your DB while looking "tracked."
2. **The OG-preservation logic makes it unfixable by reposting.** `resolveTokenKey()` matches case-insensitively, so when someone reposts the correct-case CA, the bot finds the broken lowercase entry, logs "already tracking (OG call preserved)," and returns. The broken entry *blocks* the fix.
3. pump.fun-path tokens are unaffected (the pump token object has no `.address` field, so `storageKeyForMint` falls back to the raw message address — correct case). That split would explain why some tokens alert fine and others silently never do.

### Verify it in 2 minutes

Pick a dex-listed entry from `tracked.json` whose key contains uppercase letters (if **none** do, the bug is confirmed — real mints virtually always mix case). Then:

```bash
# correct case — should return pairs
curl -s "https://api.dexscreener.com/token-pairs/v1/solana/<MintExactCase>" | head -c 300
# lowercased — compare
curl -s "https://api.dexscreener.com/token-pairs/v1/solana/<mintlowercase>" | head -c 300
```

If the lowercase call returns empty/no pairs, this is your biggest missed-updates source.

### Fix 1 — stop lowercasing Solana addresses (`dexPair.js`)

```js
function pairToToken(pair, address) {
  const chain = normalizeChainId(pair.chainId);
  const addr = String(address || '');
  const meta = tokenMetaFromPair(pair, address);
  // ...
  return {
    address: chain === 'solana' ? addr : addr.toLowerCase(),  // only EVM is case-insensitive
    chain,
    // ... rest unchanged
  };
}
```

Also audit `fetchDexPairOnChain()` — it compares `pair.baseToken.address.toLowerCase() === target.toLowerCase()`, which is fine for *matching*, but make sure the address it **returns** is the on-chain-cased one from the API response, not your input.

### Fix 2 — self-healing repair for legacy lowercase keys (`index.js → autoTrack`)

You can't restore case from the stored key, but the **repost itself carries the correct case**. Turn the "already tracking" branch into a repair:

```js
const existingCanonical = resolveTokenKey(db, storageKey);   // case-insensitive hit
if (existingCanonical) {
  // Legacy repair: stored key is a broken lowercase mint, message has the real one.
  if (existingCanonical !== storageKey && !isEvmAddress(storageKey)) {
    const og = db.tokens[existingCanonical];
    db.tokens[storageKey] = { ...og, address: storageKey };  // OG call metadata preserved
    delete db.tokens[existingCanonical];
    saveDB(db);
    console.log('[repair] fixed mint case for ' + (og.symbol || storageKey.slice(0, 8)) +
                ' — OG call preserved, polling restored');
  } else {
    console.log('[autotrack] already tracking ' + storageKey.slice(0, 8) + '... (OG preserved)');
  }
  return;  // still no embed, no reset — repost stays silent
}
```

This keeps your "repost never resets the OG call" invariant *and* quietly resurrects broken entries as the group naturally reposts CAs. `priceAtCall`, `postedBy`, `postedAt`, `milestonesFired` all carry over untouched.

**Data safety:** nothing is deleted; the entry is moved key-to-key in one save. Entries that never get reposted stay as-is (cold, harmless) or get swept by archival (§6).

---

## 3. Global rate limiter with 429 circuit breaker (`rateLimiter.js`, new file)

Right now every call site has its own retry/backoff, so a 429 anywhere *increases* total request volume. One limiter, shared by the poller, autotrack, `/calls`, and the summary:

```js
// rateLimiter.js — single token-bucket + global 429 backoff for DexScreener
const MAX_RPS = 4;            // conservative; batch endpoint makes this plenty
const BUCKET_MAX = 8;         // small burst allowance
let tokens = BUCKET_MAX;
let pausedUntil = 0;

setInterval(() => { tokens = Math.min(BUCKET_MAX, tokens + MAX_RPS); }, 1000).unref();

async function acquire() {
  for (;;) {
    const now = Date.now();
    if (now < pausedUntil) {
      await new Promise((r) => setTimeout(r, pausedUntil - now));
      continue;
    }
    if (tokens >= 1) { tokens -= 1; return; }
    await new Promise((r) => setTimeout(r, 120));
  }
}

let consecutive429 = 0;

export const rateLimiter = {
  /** fetch() that respects the global bucket and backs off ALL callers on 429. */
  async fetch(url, opts = {}) {
    await acquire();
    const res = await fetch(url, opts);
    if (res.status === 429) {
      consecutive429 += 1;
      const backoffMs = Math.min(60_000, 2_000 * 2 ** (consecutive429 - 1)); // 2s→4s→8s…60s cap
      pausedUntil = Date.now() + backoffMs;
      console.warn('[rate] 429 — global pause ' + backoffMs + 'ms (streak ' + consecutive429 + ')');
    } else if (res.ok) {
      consecutive429 = 0;
    }
    return res;
  },
  stats() { return { tokens, pausedUntil, consecutive429 }; },
};
```

Then route **every** DexScreener call through it — `dexBatch.js` (already does above), `fetchDexPair`, `fetchDexPairOnChain`, `fetchDexPairFromPool`. Keep `retries: 1` at call sites; the limiter's global pause replaces per-call sleeps. Log `rateLimiter.stats()` in your cycle summary line so you can see 429 pressure in Railway logs (cheap version of your Tier E observability item).

---

## 4. Stop `/calls` and the daily summary from self-DDoSing

### Current behavior

```js
// handleCalls (index.js) AND buildDailySummaryParts (poller.js):
const liveData = await Promise.allSettled(entries.map(e => fetchTokenData(e.address)));
```

At 1,800 entries this launches ~1,800 concurrent HTTP requests in one tick. That is a guaranteed 429 storm, it blows the budget for the poll cycle running beside it, and `/calls` frequently exceeds Discord's 15-minute deferred-reply window anyway.

### Fix — serve from the DB the poller already maintains

The poller writes `lastPrice` / `lastChecked` on every tick. With §1 in place, that data is at most one cycle (~1–3 min) old — more than fresh enough for a list command. **Zero API calls:**

```js
async function handleCalls(interaction) {
  await interaction.deferReply();
  const db = ensureDBSchema(loadDB());
  const entries = Object.values(db.tokens || {})
    .sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));
  if (entries.length === 0) return interaction.editReply('Nothing tracked yet.');

  const STALE_MS = 15 * 60 * 1000;
  const lines = entries.slice(0, 40).map((entry) => {   // paginate; 1,800 lines never fit anyway
    const last = entry.lastPrice ? Number(entry.lastPrice) : null;
    const call = entry.priceAtCall ? Number(entry.priceAtCall) : null;
    let multStr = '—';
    if (last && call && call > 0) {
      const mult = last / call;
      const stale = Date.now() - (entry.lastChecked || 0) > STALE_MS ? ' ⏳' : '';
      multStr = (mult >= 2 ? '🚀 **' : mult >= 1 ? '📈 ' : '📉 ') + mult.toFixed(2) + 'x' +
                (mult >= 2 ? '**' : '') + stale;
    }
    return '**' + entry.name + ' (' + entry.symbol + ')** — ' + multStr +
           '\n└ **' + entry.postedBy + '** · ' + fmtTime(entry.postedAt);
  });
  // ...build embed as before, footer: "showing newest 40 of N · ⏳ = >15m stale"
}
```

Apply the same change to `buildDailySummaryParts()` — rank gainers/losers by `lastPrice / priceAtCall` from the DB. If you want the summary to be spot-fresh, call `batchFetchSolana()` on the active list first (60 rate-limited requests, not 1,800 concurrent ones).

---

## 5. DB write hygiene — atomic saves, once per cycle

Three problems with the current persistence:

**(a) Non-atomic writes.** `fs.writeFileSync(DB_PATH, ...)` truncates then writes. A crash/OOM/redeploy mid-write leaves a corrupt `tracked.json`, and `loadDB()`'s `catch { return { tokens: {} } }` then silently starts from an **empty DB** — that is a total-data-loss failure mode masquerading as a fresh start. Fix with write-temp-then-rename (rename is atomic on the same filesystem):

```js
function saveDB(db) {
  try {
    const payload = activePollTrackedKeys ? mergePollSnapshot(db, activePollTrackedKeys) : db;
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));   // no pretty-print — see (c)
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    console.error('[DB] saveDB failed:', e.message);
  }
}
```

Also make `loadDB()` loud when the file exists but fails to parse — keep the corrupt file as `tracked.json.corrupt-<ts>` instead of silently replacing it.

**(b) Way too many saves per cycle.** `evaluateGainAndMilestones` calls `saveDB` on trench reset, +75%, milestone normalize, silent catch-up, tier alert, and `processToken` adds graduation/bonding saves — and each poller save calls `mergePollSnapshot`, which does a **full loadDB + parse** first. At 1,800 tokens the file is multi-MB; each save is a synchronous multi-MB read+parse+stringify+write **on the event loop**, potentially dozens of times per cycle. Rule of thumb: **save immediately only after a Discord alert actually sent** (so a crash can't replay the alert), and let everything else ride on the single end-of-cycle `saveDB(db)` that already exists. Delete the `saveDB` calls after `milestonesFired` normalization, `lastChecked` updates, bonding-progress updates, etc.

**(c) Drop the pretty-print.** `JSON.stringify(payload, null, 2)` roughly doubles file size and stringify time for zero benefit — use `scripts/inspect-tracked.mjs` when you need to read it.

**(d) Known race to keep on the radar:** if `/remove` deletes a token *during* a poll cycle, `mergePollSnapshot` copies the staged (pre-delete) entry back over the fresh DB — the removed token resurrects. Cheap fix: keep a module-level `removedThisCycle = new Set()` that `/remove` adds to, and have `mergePollSnapshot` skip those keys.

---

## 6. Dead-token archival (your A4 — worth doing right after §1)

Even with batching, a smaller active list means faster cycles, cheaper summaries, and a usable `/calls`. Run inside `pollTokens()` once per day:

```js
const ARCHIVE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function archiveDeadTokens(db) {
  if (!db.archived) db.archived = {};
  let moved = 0;
  for (const [key, e] of Object.entries(db.tokens)) {
    const dead =
      entryAgeMs(e) > ARCHIVE_AGE_MS &&
      (Number(e.peakMultiple) || 1) < 1.2 &&
      (e.milestonesFired || []).length === 0;
    if (dead) {
      db.archived[key] = { ...e, archivedAt: Date.now() };
      delete db.tokens[key];
      moved += 1;
    }
  }
  if (moved) console.log('[archive] moved ' + moved + ' dead tokens (never >1.2x, 30d+) — nothing deleted');
  return moved;
}
```

Moved, never deleted — OG call history stays queryable (add an `/archive <ca>` lookup later). Important interaction with §2: archived lowercase-key entries can't be repaired by repost anymore, so ship the §2 repair **before** turning archival on, and have the repair also check `db.archived` (un-archive + fix key on repost).

---

## 7. Housekeeping — dead files, duplicate code, module mismatch

`package.json` declares `"type": "module"`, but four files are CommonJS (`module.exports` / `require`): **`dexscreener.js`, `pumpfun.js`, `moralis.js`, `walletWatcher.js`**. None of them can be imported by your ESM entrypoints — `walletWatcher.js` would throw `require is not defined` if anything loaded it. They're dead code shadowing live logic (the real wallet poller lives in `poller.js → pollWallets`; the real dex fetch is `dexPair.js`). Delete them, or convert `moralis.js` to ESM if the research commands genuinely import from it (verify — `index.js` line 1179 area references Twttr, not moralis exports).

Related dedup: `fetchPumpFun`, `fetchSolPrice`, and `calcPumpFunPrice` are copy-pasted in **both** `index.js` and `poller.js` (plus `pumpfun.js`). Extract one `pumpfun.mjs`-style ESM module and import it from both — right now a fix to one copy silently misses the other. While you're in there: verify `frontend-api.pump.fun/coins/{mint}` still resolves — pump.fun has rotated frontend API hosts before, and a dead host here fails silently (returns null → token just never prices).

Two smaller things spotted:

**`priceAtCall` can be permanently null.** If a pump.fun token prices as null at track time (CoinGecko hiccup), `priceAtCall: token.price || null` stores null and `evaluateGainAndMilestones` bails forever — the token is tracked but can never alert. Backfill on first good tick:

```js
// in evaluateGainAndMilestones, before the null-guard bails:
if ((callPx == null || callPx <= 0) && livePrice > 0 && !entry.priceAtCallBackfilled) {
  db.tokens[address].priceAtCall = String(livePrice);
  db.tokens[address].priceAtCallBackfilled = true;   // flag it — this is NOT the true call price
  console.log('[backfill] ' + entry.name + ' priceAtCall was null — set from first live tick');
  return; // evaluate from next tick
}
```

**Silent catch-up may eat real pumps once cycles are fast.** The "≥4x with no history → mark all tiers silently" heuristic exists because 15-minute cycles let tokens run multiple tiers between ticks. Once cycles are <60s (§1), a genuine instant 4x is exactly the alert your degens want. Consider gating it on `lastChecked` age: only do the silent catch-up when the last tick was >10 minutes ago (i.e., after a deploy/outage), otherwise alert the highest tier normally.

---

## 8. On sharded pollers — when your idea actually becomes right

Your instinct (partition CAs across N pollers) is the correct **Tier C** architecture — just not the correct next step, because:

The constraint is DexScreener's per-IP request budget, not compute. N workers in one process, or N Railway services on one egress IP, split the same budget N ways — total throughput unchanged. The batch endpoint (§1) already delivers the full budget's worth of tokens (30× multiplier) from a single loop. And with `tracked.json` as the store, N writers means corruption — your own handoff doc flags this ("don't scale replicas without Tier C").

Sharding earns its complexity at roughly **5k+ tokens or multi-guild**, and the shape is the one already in your handoff doc: Postgres (Supabase) as source of truth, a price-ingest service writing a `price_cache` table, the Discord bot reading cache only, and alert dedupe via optimistic locking on `milestones_fired`. When you get there, shard by **tier** (hot/warm/cold services) rather than `hash(mint) % N` — tiers have different cadence needs, so tier-sharding lets the hot service run a 30s loop while cold runs 10 minutes, which is the actual latency win.

Until then: §1 + §3 gets hot tokens on a ~60s tick from one process. That's the "laser quick" you asked for, this week, with no migration.

---

## 9. Suggested rollout

**Deploy 1 (do together):** rate limiter (§3) → batch fetcher (§1) → mint-case fix + repost repair (§2). Take a volume backup first (`scripts/backup-volume.mjs`). Watch one full cycle in logs: `scheduled N`, cycle duration, `rateLimiter.stats()`.

**Deploy 2:** atomic saves + save consolidation (§5) → `/calls` + summary from cache (§4).

**Deploy 3:** archival (§6) → delete dead CJS files, dedupe pump.fun helpers, `priceAtCall` backfill (§7).

**Data-safety statement for the group:** none of these fixes delete or reset anything. OG `postedBy` / `postedAt` / `priceAtCall` / `milestonesFired` are preserved through the key repair (§2) and archival moves entries rather than dropping them (§6). The one behavioral change users will notice: alerts get *faster* and previously-dead tracked tokens start alerting again once their keys are repaired by reposts.

### Post-fix targets (revised from handoff §14)

| Metric | Handoff target | Achievable with §1–§6 |
|--------|----------------|------------------------|
| Full active cycle | ≤ 3 min | **≤ 60 s** at 1,800 tokens |
| Hot token interval | ≤ 60 s | 30–60 s |
| DexScreener 429 rate | < 5% | ~0% (batch + limiter under budget) |
| `/calls` latency | — | < 2 s, zero API calls |
| Data loss on crash mid-write | undefined | 0 (atomic rename) |