# SPEC: Robinhood Chain Re-Integration MVP
## Implementation instructions for the coding agent

> **Read fully before coding.** This adds ONE new chain (Robinhood Chain, an EVM L2) to a currently Solana-only bot, using a design that structurally prevents every bug that got EVM removed the first time. Where this spec and your instinct disagree, the spec wins.

---

## 0. Context & why EVM was removed before

**Repo:** `enstest1/take_profits_profit_bot` · Node 18+ **ESM** · Railway · State `/data/tracked.json` (atomic writes via `dbStore.js`).

**Chain facts (verified Jul 2026):** Robinhood Chain is an Ethereum-compatible L2 (Arbitrum Orbit). Addresses are standard EVM `0x` + 40 hex. DexScreener supports it with chainId slug **`robinhood`** — all existing DexScreener endpoints work: `token-pairs/v1/robinhood/{addr}`, `tokens/v1/robinhood/{a,b,c}` (30-address batch), `latest/dex/pairs/robinhood/{pairAddr}`. There is NO pump.fun equivalent — no bonding curve, no graduation. Pairs are mostly Uniswap v3 vs WETH.

**The three bugs that killed EVM v1 — and the structural fix for each. Internalize these; they drive every design decision below:**

| v1 bug | v1 cause | v2 structural fix |
|--------|----------|--------------------|
| Pool/pair addresses tracked as tokens | `0x` from chat/links stored raw | Every `0x` input is resolved to the pair's `baseToken.address` BEFORE storage. Pool in → token out, or nothing. |
| Cross-chain ambiguity / wrong-chain data | `0x` resolved against ALL EVM chains | `0x` resolves against EXACTLY ONE chain: `robinhood`. No pair on robinhood → not tracked. Never query eth/base/bsc/etc. |
| Key collisions with legacy rows | DB keyed by bare address | New EVM entries use chain-qualified keys: `robinhood:0x<lowercase>`. Cannot collide with legacy bare-`0x` rows or Solana mints. |

**Case rules — get this exactly right, a production watchdog audits it:**
- Solana mints: case-SENSITIVE base58. NEVER `.toLowerCase()` a Solana address. (Existing rule, unchanged.)
- EVM addresses: case-INSENSITIVE (checksum casing is display-only). ALWAYS lowercase the `0x` part before keying/comparing. `robinhood:0xAbC…` and `robinhood:0xabc…` must be the same key — normalize at one choke point (§2), nowhere else.

**Existing invariants that still bind:** OG fields (`postedBy`, `postedByUserId`, `postedAt`, `priceAtCall`) immutable after first write · all external HTTP via `rateLimiter.fetch()` · one `saveDB` per poll cycle (+ post-alert saves only) · never delete entries · reposts stay silent in Discord · respect `MAINTENANCE_MODE`.

**Legacy EVM rows:** `tracked.json` contains old rows with `chain: 'eth' | 'base' | ...` and bare `0x` keys from v1. They are skipped by the poller today. **Do not touch them.** They keep their bare keys, stay skipped, and are invisible to everything in this spec. Only `chain === 'robinhood'` entries with prefixed keys are live EVM.

---

## 1. Phase plan — one commit per phase, in order

| Phase | Work | Files |
|-------|------|-------|
| 1 | Chain registry + key normalization | `chains.js` |
| 2 | Address extraction + autoTrack path for `0x` | `index.js`, `chains.js` |
| 3 | Multi-chain batch poller | `dexBatch.js`, `poller.js` |
| 4 | Command & display awareness | `index.js` (`/calls`, `/remove`, embeds) |
| 5 | Feature gating + config | env, `signals/*` touch points |

Each phase: `node --check` clean, boots with `ENABLED_CHAINS=solana` (robinhood OFF = zero behavior change — this is the safety net for the whole feature).

---

## 2. Phase 1 — Chain registry and the ONE key normalization choke point

All chain logic and ALL key construction goes through `chains.js`. No other file may build a storage key or lowercase an address. Add/replace:

```javascript
// chains.js — additions

export const CHAINS = {
  solana: {
    id: 'solana',
    kind: 'solana',
    emoji: '◎',
    dexScreenerSlug: 'solana',
    addressRegex: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,   // existing pattern, unchanged
  },
  robinhood: {
    id: 'robinhood',
    kind: 'evm',
    emoji: '🏹',
    dexScreenerSlug: 'robinhood',
    addressRegex: /\b0x[a-fA-F0-9]{40}\b/g,             // exactly 40 hex — rejects tx hashes (64 hex)
  },
};

export function enabledChains() {
  return String(process.env.ENABLED_CHAINS || 'solana')
    .split(',').map(s => s.trim().toLowerCase()).filter(id => CHAINS[id]);
}

/** THE key choke point. Every storage key in the entire codebase comes from here. */
export function makeStorageKey(chainId, tokenAddress) {
  const addr = String(tokenAddress || '');
  if (CHAINS[chainId]?.kind === 'evm') return chainId + ':' + addr.toLowerCase();
  return addr;                                          // solana: bare, case-sensitive (backward compat)
}

/** Inverse: split any DB key into { chainId, address }. Handles all three key eras. */
export function parseStorageKey(key) {
  const i = key.indexOf(':');
  if (i > 0) return { chainId: key.slice(0, i), address: key.slice(i + 1) };  // 'robinhood:0x...'
  if (/^0x/i.test(key)) return { chainId: 'legacy-evm', address: key };       // v1 leftover — always skipped
  return { chainId: 'solana', address: key };                                  // bare Solana mint
}

export function isLegacyEvmKey(key) { return parseStorageKey(key).chainId === 'legacy-evm'; }
```

**Refactor rule for this phase:** find every existing call to `storageKeyForMint()` / raw key construction and route it through `makeStorageKey('solana', addr)` — behavior must be byte-identical for Solana (verify: same key strings before/after). Do not change poller skip-logic yet; legacy rows must remain skipped exactly as today.

---

## 3. Phase 2 — Extraction + autoTrack for `0x`

### 3.1 `extractAddresses()` becomes chain-tagged

Return shape changes from `string[]` to `Array<{ chainId, raw }>`:

```javascript
export function extractAddresses(text) {
  const found = [];
  const seen = new Set();
  for (const chainId of enabledChains()) {
    const chain = CHAINS[chainId];
    for (const m of String(text || '').matchAll(chain.addressRegex)) {
      const raw = m[0];
      const dedupeKey = chainId + ':' + (chain.kind === 'evm' ? raw.toLowerCase() : raw);
      if (seen.has(dedupeKey)) continue;                 // same-message dedupe, case-normalized for EVM
      seen.add(dedupeKey);
      found.push({ chainId, raw });
    }
  }
  return found;
}
```

Update the single `messageCreate` call site to iterate `{ chainId, raw }` objects. With `ENABLED_CHAINS=solana`, `0x` strings produce zero matches — same as today.

**DexScreener URL handling:** if the message contains `dexscreener.com/robinhood/<0xPairAddr>`, extract that address and tag it `robinhood` — it flows through the same resolver below, which converts pair→token automatically. Do NOT special-case URLs from other chains (`dexscreener.com/base/...` etc.) — those stay ignored.

### 3.2 The resolver — pool-in, token-out (this kills v1 bug #1 and #2)

New function in `dexPair.js`. EVERY `0x` goes through it; nothing `0x` reaches the DB without it:

```javascript
/**
 * Resolve a 0x address on Robinhood Chain to canonical token data.
 * Handles BOTH cases: input is a token address, or input is a pair/pool address.
 * Returns { tokenAddress, pair } or null (null = do not track, stay silent-ish).
 */
export async function resolveRobinhoodToken(rawAddr) {
  const addr = rawAddr.toLowerCase();

  // Attempt 1: treat as TOKEN address
  let res = await rateLimiter.fetch(
    'https://api.dexscreener.com/token-pairs/v1/robinhood/' + addr,
    { signal: AbortSignal.timeout(10_000) });
  if (res.ok) {
    const pairs = await res.json();
    if (Array.isArray(pairs) && pairs.length > 0) {
      const best = pairs.reduce((a, b) => ((a.liquidity?.usd || 0) >= (b.liquidity?.usd || 0) ? a : b));
      return { tokenAddress: best.baseToken.address.toLowerCase(), pair: best };
    }
  }

  // Attempt 2: treat as PAIR/POOL address → resolve to its baseToken
  res = await rateLimiter.fetch(
    'https://api.dexscreener.com/latest/dex/pairs/robinhood/' + addr,
    { signal: AbortSignal.timeout(10_000) });
  if (res.ok) {
    const data = await res.json();
    const pair = data?.pairs?.[0] || data?.pair;
    if (pair?.baseToken?.address) {
      console.log('[robinhood] pool address resolved to token ' + pair.baseToken.address +
                  ' (input was pair ' + addr.slice(0, 10) + '…)');
      return { tokenAddress: pair.baseToken.address.toLowerCase(), pair };
    }
  }

  return null;   // no pair on robinhood → NOT tracked. Never fall through to other chains.
}
```

**Hard rule:** there is no attempt 3. If robinhood has no data for the address, the answer is null — never query ethereum/base/arbitrum/any other slug. This single rule is what makes re-adding EVM safe.

### 3.3 autoTrack integration

In `autoTrack()`, branch on `chainId` from extraction:

```javascript
if (chainId === 'robinhood') {
  const resolved = await resolveRobinhoodToken(raw);
  if (!resolved) {
    console.log('[autotrack] 0x ' + raw.slice(0, 10) + '… has no robinhood pair — ignored');
    return;                                          // silent in Discord, log only (matches repost-silence philosophy)
  }
  const storageKey = makeStorageKey('robinhood', resolved.tokenAddress);
  // dedupe: EXISTING resolveTokenKey logic, but for prefixed keys use exact match
  // (keys are already normalized lowercase — case-insensitive scan unnecessary and must
  //  NOT be applied across the chain prefix boundary)
  if (db.tokens[storageKey]) { console.log('[autotrack] already tracking (OG preserved)'); return; }

  const entry = buildEntryFromPair(resolved.pair, {   // reuse/extend existing entry builder
    chain: 'robinhood',
    platform: 'dexscreener',
    address: resolved.tokenAddress,                    // lowercase token addr, NOT the raw input
    // OG fields (postedBy, postedAt, priceAtCall, alertChannelId) set exactly like Solana path
  });
  db.tokens[storageKey] = entry;
  saveDB(db);
  // send 📡 embed — see §5 for chain badge
}
```

**Fields that differ from Solana entries:** `bondingProgress`, `graduationAlertFired`, `bondingAlertFired` must be `null`/absent and never evaluated for robinhood entries (no pump.fun). `devWallet` stays null (no source in MVP — deployer memory and rug-scan are Solana-only for now; do not call RugCheck for robinhood entries, it's a Solana service).

---

## 4. Phase 3 — Multi-chain batch poller

### 4.1 `dexBatch.js` gains a chain parameter

```javascript
// signature change: batchFetchSolana(mints) → batchFetch(chainId, addresses)
export async function batchFetch(chainId, addresses, { timeoutMs = 12_000 } = {}) {
  const slug = CHAINS[chainId].dexScreenerSlug;
  // identical logic, URL becomes:
  // 'https://api.dexscreener.com/tokens/v1/' + slug + '/' + chunk.join(',')
  // Matching rule per chain kind:
  //   solana: exact case-sensitive match of pair.baseToken.address to requested mint (existing)
  //   evm:    lowercase both sides before matching; returned map is keyed by the
  //           REQUESTED lowercase address so poller lookups always hit
}
export const batchFetchSolana = (mints, o) => batchFetch('solana', mints, o);  // keep old callers compiling
```

### 4.2 Poller groups by chain

In `pollTokens()`, after building `scheduled` (which contains storage KEYS):

```javascript
const byChain = new Map();   // chainId → [{ key, address }]
for (const key of scheduled) {
  const { chainId, address } = parseStorageKey(key);
  if (chainId === 'legacy-evm') continue;                       // v1 rows: skipped forever (unchanged)
  if (!enabledChains().includes(chainId)) continue;             // chain toggled off → skip, don't delete
  if (chainId === 'solana' && isBrokenSolKey(key, db.tokens[key])) continue;  // existing rule
  const arr = byChain.get(chainId) || [];
  arr.push({ key, address });
  byChain.set(chainId, arr);
}

for (const [chainId, items] of byChain) {
  const liveMap = await batchFetch(chainId, items.map(i => i.address));
  for (const { key, address } of items) {
    const live = liveMap.get(chainId === 'solana' ? address : address.toLowerCase());
    if (!live) continue;
    await processTokenWithLive(client, key, db, live, milestoneOptsFor(key));
  }
}
// pump.fun per-token path: unchanged, Solana-only by nature
```

**Everything downstream is already chain-agnostic:** milestone math is `livePrice/priceAtCall`, tiers, velocity, liquidity divergence, retest, lifecycle, trench reset — all operate on numbers. Verify no downstream function re-derives a key from `entry.address` without `makeStorageKey` (grep for direct `db.tokens[entry.address]` — replace any hit with the passed `key`). Skip graduation/bonding evaluation when `entry.chain === 'robinhood'` (one early-return guard in that code path).

**Budget note:** robinhood adds its own batch chunks against the SAME global rate limiter — no new limits needed. 100 robinhood tokens = 4 extra requests per cycle. Cycle log line gains per-chain counts: `scheduled sol=780 rh=42 broken=3`.

---

## 5. Phase 4 — Commands & display

**Chain badge everywhere a token is named.** Prefix `CHAINS[chain].emoji` in: auto-track embed title, all alert embed titles, `/calls` rows, `/mybags`, weekly recap, `/rank` bestCall. Example rows:

```
🚀 ◎ WIF — 3.2x        (solana)
🍳 🏹 LAWBHOOD — 1.7x   (robinhood)
```

**`/calls`:** no logic change (reads cache) beyond the badge. Optional arg `chain: solana|robinhood` filters.

**`/remove ca:<string>`** must accept: bare Solana mint (existing), `0x` address (normalize: lowercase → try key `robinhood:0x…`), or a full prefixed key. If a bare `0x` matches a LEGACY key too, prefer the `robinhood:` entry and say which one was removed. Remember `markRemovedThisCycle(key)` — the existing anti-resurrection hook — fires with the RESOLVED key.

**`/ape`, `/watch`:** accept `0x` input, resolve to `robinhood:0x…` key via the same normalization helper. Add one shared helper `resolveUserInputToKey(db, rawInput)` in `chains.js` used by ALL commands that take a CA — one implementation, zero drift:

```javascript
export function resolveUserInputToKey(db, rawInput) {
  const raw = String(rawInput || '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    const key = makeStorageKey('robinhood', raw);
    return db.tokens[key] ? key : null;
  }
  if (raw.includes(':')) return db.tokens[raw] ? raw : null;      // already a full key
  return db.tokens[raw] ? raw : (resolveTokenKey?.(db, raw) ?? null);  // solana path, existing helper
}
```

---

## 6. Phase 5 — Gating, config, watchdog

**Env:** ship with `ENABLED_CHAINS=solana` in the PR; flipping to `solana,robinhood` in Railway is the launch switch. Toggling robinhood OFF later must be non-destructive: robinhood entries stay in the DB, get skipped by the poller (the `enabledChains()` check in §4.2 already does this), and resume when re-enabled. Never delete on toggle.

**Warden/auditor updates (if the watchdog is deployed):** key-hygiene check (C3) gets three new rules — (a) any NEW bare `0x` key appearing after this deploy = CRITICAL (legacy set is frozen; snapshot the legacy key list once and diff against it), (b) `robinhood:` keys must be fully lowercase after the prefix, (c) a `robinhood:` entry whose `chain !== 'robinhood'` = WARN. OG-immutability and mass-deletion checks apply to prefixed keys with zero changes.

**Out of scope for this MVP (do not build):** rug-scan for robinhood (RugCheck is Solana-only; GoPlus/EVM scanning is a later phase), deployer memory for robinhood, Helius dev-sell for robinhood (Helius is Solana-only), any second EVM chain. If tempted to generalize "for later," don't — one chain, structurally sound, is the MVP.

---

## 7. Acceptance tests — done means all pass

| # | Test | Expected |
|---|------|----------|
| 1 | Boot with `ENABLED_CHAINS=solana` | Zero behavior change: `0x` in chat ignored, Solana keys byte-identical to pre-deploy, cycle log unchanged except format |
| 2 | Enable `solana,robinhood`, post a robinhood TOKEN address | 📡 embed with 🏹 badge; DB key is `robinhood:0x<lowercase>`; `priceAtCall` set; OG fields set |
| 3 | Post the same address in UPPERCASE hex | Silent — dedupes to the same key (case normalization works) |
| 4 | Post a robinhood PAIR/pool address (grab one from a dexscreener.com/robinhood URL) | Tracks the pair's baseToken, NOT the pool; log line shows pool→token resolution |
| 5 | Post a `0x` with no robinhood pair (e.g., a mainnet-ETH-only token) | No embed, no DB entry, one log line. Confirms no cross-chain fallback |
| 6 | Post a dexscreener.com/robinhood/<pair> URL | Same result as test 4 |
| 7 | Post a dexscreener.com/base/<pair> URL | Ignored entirely |
| 8 | Legacy bare-`0x` row in DB + track the SAME address on robinhood | Both coexist: legacy key untouched & skipped, new `robinhood:` key polled. No overwrite |
| 9 | Poll cycle with mixed tokens | Per-chain batch calls in logs (`sol=… rh=…`); robinhood entries get `lastPrice`/milestones; no graduation/bonding evaluation on robinhood entries |
| 10 | Robinhood token crosses 2x | 🎯 tier alert with 🏹 badge to `alertChannelId`; OG fields unchanged |
| 11 | `/remove 0x<addr>` | Removes `robinhood:` entry; `markRemovedThisCycle` fired with resolved key; survives the cycle (no resurrection) |
| 12 | `/ape 0x<addr>` on a tracked robinhood token | Position stored under the prefixed key; personal DM tiers fire |
| 13 | Toggle back to `ENABLED_CHAINS=solana`, restart | Robinhood entries remain in DB, skipped by poller, no errors; re-enable → polling resumes with OG data intact |
| 14 | Repost a tracked robinhood CA | Silent, OG preserved (repost invariant holds cross-chain) |
| 15 | Grep sweep | No `.toLowerCase()` on any Solana-path address variable; no storage-key construction outside `makeStorageKey`; every new fetch goes through `rateLimiter.fetch` |
| 16 | `node --check` every touched file, per phase | Clean |

## 8. Conventions

Branch `feature/robinhood-chain`, one commit per phase, messages `feat(rh-p<N>): …`. Every new/changed function gets a top comment naming which v1 bug its design prevents (forces the next reader to keep the guarantees). Do not modify: `rateLimiter.js` internals, `dbStore.js` internals, milestone tier math, repair scripts, legacy-row skip behavior. If an integration point's real name differs from this spec, match by behavior and note the mapping in the commit message — do not restructure existing code to fit the spec's naming.
