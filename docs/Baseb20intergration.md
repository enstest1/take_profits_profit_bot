# Base + B20 Integration Spec — `take_profits_profit_bot`

**Audience:** the Cursor Composer coding agent.
**Author's note to the agent:** Follow this literally. Every file path, function name, and
constant below was read from the actual repo (`enstest1/take_profits_profit_bot`) and from
Base's official `base-std` source. Do not invent APIs. Do not add features that are not
listed here.

---

## 0. Context you MUST internalize before writing any code

This bot is a **read-only monitor / alerter**. It:

- ingests token addresses posted in Discord,
- fetches price / liquidity / market-cap from **Dexscreener**,
- fires alerts on price milestones and take-profit levels.

It does **not** issue, mint, deploy, or manage tokens.

**B20 is a superset of ERC-20.** Native B20 tokens respond to every standard ERC-20 call
and are indexed by Dexscreener exactly like any other Base token. Therefore, for THIS bot,
"supporting B20" means **"support the Base chain"** — the B20-specific protocol surface
(factory, mint/burn, policies, roles) is for *issuers* and is irrelevant here.

### ⛔ DO NOT BUILD (out of scope — will break the design if added)

- ❌ No `B20Factory` / `createB20` / token deployment code.
- ❌ No mint, burn, pause, supply-cap, or role-management code.
- ❌ No Policy Registry / allowlist / blocklist / freeze-and-seize code.
- ❌ No new smart contracts, no Solidity, no signing/permit logic.
- ❌ No new chain-abstraction framework. The existing `chains.js` registry already
  handles everything. Add one entry to it; do not refactor it.

### ✅ IN SCOPE

- **Part 1 (required):** add `base` to the chain registry + enable it via env.
- **Part 2 (optional):** a small read-only `b20.js` module that *labels* native B20 tokens
  in alerts (Asset vs Stablecoin + fiat currency). Purely cosmetic/informational.

---

## PART 1 — Add Base chain support (REQUIRED)

### Why this is tiny (read this trace before editing)

The single source of truth for chains is the `CHAINS` object in **`chains.js`**. Everything
downstream already branches on it generically:

- `enabledChains()` (chains.js) reads `process.env.ENABLED_CHAINS`, splits on commas, and
  keeps only ids that exist as keys in `CHAINS`. → Adding a `base` key makes `base`
  eligible.
- `batchFetch(chainId, addresses)` (**dexBatch.js**) reads
  `CHAINS[chainId].dexScreenerSlug` and hits
  `https://api.dexscreener.com/tokens/v1/<slug>/<addrs>`. It already lowercases EVM
  addresses via `chain?.kind === 'evm'`. → Works for `base` the moment it's registered.
- `resolveEvmToken(address)` (**dexPair.js**) iterates every enabled non-Solana chain in
  parallel and calls `fetchDexPairOnChain(chain, addr)` →
  `https://api.dexscreener.com/token-pairs/v1/<chain>/<addr>`. → Works for `base`
  automatically.
- `extractAddresses(text)` (chains.js) already handles `kind: 'evm'` chains generically
  (the `0x…` regex and the `dexscreener.com/<chain>/0x…` URL form). → Works for `base`.
- `makeStorageKey('base', addr)` (chains.js) returns `base:<lowercased-addr>` because
  `CHAINS['base'].kind === 'evm'`. → Correct, collision-free DB keys.

**Conclusion (REVISED after full-repo conflict review):** the registry, poller batch path,
and embeds are fully generic — but five chain-hardcoded sites elsewhere in the repo
(autotrack dispatch, the robinhood-only DEX resolver, the slash-command CA resolver, the
archive resolver, and the DexScreener URL-context filter) will misroute or break Base
tokens if left as-is. The exact fixes are in **PART 1B** below and MUST ship together
with the Step 1.1 registry entry.

### Step 1.1 — Edit `chains.js`

Find the `CHAINS` object (currently `solana` and `robinhood`). Add a `base` entry that
mirrors the `robinhood` shape exactly (both are EVM / `0x` chains).

**Exact edit — insert the `base` block into the `CHAINS` object:**

```js
export const CHAINS = {
  solana: {
    id: 'solana',
    kind: 'solana',
    emoji: '◎',
    label: 'SOLANA',
    dexScreenerSlug: 'solana',
    addressRegex: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,
  },
  base: {
    id: 'base',
    kind: 'evm',
    emoji: '🔵',
    label: 'BASE',
    dexScreenerSlug: 'base',
    addressRegex: /\b0x[a-fA-F0-9]{40}\b/g,
  },
  robinhood: {
    id: 'robinhood',
    kind: 'evm',
    emoji: '🏹',
    label: 'ROBINHOOD',
    dexScreenerSlug: 'robinhood',
    addressRegex: /\b0x[a-fA-F0-9]{40}\b/g,
  },
};
```

**Do NOT touch** the existing `EVM_CHAINS` array — it already contains `'base'`, so
`isEvmChain('base')` already returns `true`. Three functions in `chains.js` DO need the
compatibility fixes B3, B4, and B5 from PART 1B (they hardcode `'robinhood'` for `0x`
input); apply those in the same commit as this registry entry.

### Step 1.2 — Enable Base via environment

The bot reads `ENABLED_CHAINS` (comma-separated). Default is `solana` only.

In your real `.env` (and update the comment in `.env.example`):

```bash
# Auto-track Solana + Base
ENABLED_CHAINS=solana,base
```

- If you want Base **instead of** Robinhood: use `solana,base` (recommended — no address
  ambiguity; see the gotcha in §1.4).
- If you truly need all three: `solana,robinhood,base` — but read §1.4 first.

**No new dependency and no other file change is required for Part 1.** `package.json` stays
as-is (`node-fetch`, `discord.js`, `dotenv`, `node-cron`).

### Step 1.3 — Verify (smoke test)

> ⚠️ Run this smoke test only AFTER applying PART 1B below. With only Steps 1.1–1.2
> applied, a bare Base address mis-routes into the Solana autotrack path and posts a
> public "not found" error embed (finding B1).

1. Deploy / run with `ENABLED_CHAINS=solana,base`.
2. In the tracked Discord channel, post a Base token. Two accepted forms:
   - a chain-tagged link (unambiguous, preferred):
     `https://dexscreener.com/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
     *(that address is native USDC on Base — good liquid smoke-test target)*, or
   - a bare address: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
3. Expected: the bot resolves the token via Dexscreener, stores it under a `base:0x…` key,
   and begins tracking. Check logs for a line like
   `[dex] parallel chain API → <SYMBOL> on base`.
4. Confirm milestone/TP alerts render with the `🔵 BASE` badge (from `chainLabel('base')`).

### Step 1.4 — ⚠️ The one real gotcha: bare-address ambiguity across EVM chains

`base` and `robinhood` use the **identical** `0x` regex. In `extractAddresses()`, the
dedupe key is `chainId + ':' + addr`, so a **bare** `0x…` posted in chat produces one match
per enabled EVM chain (e.g. both `base:0x…` and `robinhood:0x…`). A bare address is
inherently ambiguous about which EVM chain it's on.

How the bot copes today: `resolveEvmToken()` queries all enabled EVM chains in parallel and
returns the **first chain Dexscreener finds the token on** (array order follows the order in
`ENABLED_CHAINS`). So:

- If a token exists on only one of the enabled EVM chains, it resolves correctly.
- If it somehow trades on both, the earlier entry in `ENABLED_CHAINS` wins.

**Guidance to encode / document:**

- Prefer **chain-tagged Dexscreener links** (`dexscreener.com/base/0x…`). The URL form in
  `extractAddresses()` matches a specific chain and is unambiguous.
- If you don't need Robinhood, run `solana,base` and the ambiguity disappears entirely.
- Do **not** try to "fix" this by guessing chain from address bytes — bare EVM addresses
  carry no chain identity. Dexscreener resolution + tagged links is the correct approach.

### Step 1.5 — Chain display in embeds is automatic (do not touch embed code)

The auto-tracking embed (`autotrackHelpers.js`) already renders the chain generically:
line 58 prefixes the title with `chainBadge(chainKey)` and line 61 sets
`.setFooter({ text: chainLabel(chainKey) })`. Both read from the `CHAINS` registry, so
after the Step 1.1 edit, Base tokens automatically show `🔵` in the title and `🔵 BASE`
in the footer. **No embed changes are needed for any chain, ever.**

### Step 1.6 — Future: adding Ethereum (same pattern, when the user asks for it)

When Ethereum support is wanted, it is the identical one-entry change. Add to `CHAINS`:

```js
ethereum: {
  id: 'ethereum',
  kind: 'evm',
  emoji: 'Ξ',
  label: 'ETHEREUM',
  dexScreenerSlug: 'ethereum',
  addressRegex: /\b0x[a-fA-F0-9]{40}\b/g,
},
```

Then add `ethereum` to `ENABLED_CHAINS`. `EVM_CHAINS` already contains `'ethereum'`, so no
other change. Embeds will automatically show `Ξ ETHEREUM`. Note: each additional enabled
EVM chain widens the bare-`0x` ambiguity from §1.4 (a bare address is checked against every
enabled EVM chain; when a token exists on more than one, the earlier entry in
`ENABLED_CHAINS` wins). Chain-tagged `dexscreener.com/<chain>/0x…` links remain
unambiguous and are the recommended way to post cross-chain tokens.

---

## PART 1B — REQUIRED COMPATIBILITY FIXES (full-repo conflict review)

Every file in the repo was reviewed for chain-hardcoded logic (`grep` for
`robinhood` / `solana` across all modules, plus line-reads of `index.js`, `poller.js`,
`chains.js`, `dexPair.js`, all `warden/checks/*`, `risk/*`, `webhooks/*`, and
`autotrackHelpers.js`). Findings, then exact fixes. **B1–B6 must ship in the same commit
as the Step 1.1 registry entry.** B7–B8 are strongly recommended. B9 is optional.

| ID | File | Severity | Symptom for Base if unfixed |
| -- | ---- | -------- | --------------------------- |
| B1 | `index.js` | **CRITICAL** | `autoTrack()` routes every non-robinhood ref to the Solana path → base `0x` fails `isSolanaAddress`, burns 3 retries (~7.5 s), then posts a public "not found" error embed. |
| B2 | `dexPair.js` | **CRITICAL** | The pool-in/token-out resolver (`resolveRobinhoodToken`) hardcodes the robinhood slug — there is no equivalent for base, so B1's fix has nothing to call. |
| B3 | `chains.js` | **HIGH** | `resolveUserInputToKey` builds only `robinhood:` keys for `0x` input → `/remove` and `/pelpafkedup` (index.js lines 1131 / 1341) report "not tracked" for every Base token. |
| B4 | `chains.js` | **HIGH** | `resolveArchivedKey` same hardcoding → reposting an archived Base token re-tracks it as brand new instead of restoring the OG call (silent OG-data loss). |
| B5 | `chains.js` | **MEDIUM** | `isForeignDexScreenerContext` compares against literal `'robinhood'` → a `dexscreener.com/robinhood/0x…` link ALSO emits a `base` candidate (asymmetric leak → wasted resolution, or double-track if the address trades on both chains). |
| B6 | `index.js` | **MEDIUM** | `buildTrackedEntry` gates Solana-only fields with `isRh` → Base entries get `bondingProgress: 0` / `graduationAlertFired: false` instead of `null` (schema drift vs. robinhood entries; trips warden EVM hygiene if B9 is applied). |
| B7 | `poller.js` | LOW | `processToken`'s EVM short-circuit checks `=== 'robinhood'`. Functionally dead for Base (batch path + `fetchLiveData` guards cover it) — fix for intent. |
| B8 | `risk/rugscan.js`, `webhooks/devSell.js` | LOW | Both skip-guards check `=== 'robinhood'`. Base is currently safe **by accident** (base58 regex gate / always-null `devWallet`) — make the guards explicit. |
| B9 | `warden/checks/*` | OPTIONAL | Base tokens are invisible to `priceTruth`, `canary`, and get no key-hygiene validation (no false alarms either — verified: `keyHygiene` falls through to `CHAINS[chainId]` existence, which passes once Step 1.1 lands). |

### Fix B2 — `dexPair.js`: generalize the EVM resolver (do this first; B1 depends on it)

**(a)** Change line 1 import:

```js
// BEFORE
import { parseEnabledChains } from './chains.js';
// AFTER
import { parseEnabledChains, CHAINS } from './chains.js';
```

**(b)** Replace the entire `resolveRobinhoodToken` function AND the entire
`tokenDataFromRobinhoodPair` function (both at the bottom of the file) with:

```js
/**
 * Resolve 0x on ONE specific EVM chain — pool-in, token-out (prevents v1 bug #1).
 * No cross-chain fallback (prevents v1 bug #2). Generalized from the robinhood-only
 * resolver so base (and future EVM chains) reuse identical logic.
 */
export async function resolveEvmChainToken(chainId, rawAddr) {
  const slug = CHAINS[chainId]?.dexScreenerSlug;
  if (!slug) return null;
  const addr = rawAddr.toLowerCase();

  let res = await rateLimiter.fetch(
    'https://api.dexscreener.com/token-pairs/v1/' + slug + '/' + addr,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (res.ok) {
    const pairs = await res.json();
    if (Array.isArray(pairs) && pairs.length > 0) {
      const best = pairs.reduce((a, b) =>
        ((a.liquidity?.usd || 0) >= (b.liquidity?.usd || 0) ? a : b));
      return { tokenAddress: best.baseToken.address.toLowerCase(), pair: best };
    }
  }

  res = await rateLimiter.fetch(
    'https://api.dexscreener.com/latest/dex/pairs/' + slug + '/' + addr,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (res.ok) {
    const data = await res.json();
    const pair = data?.pairs?.[0] || data?.pair;
    if (pair?.baseToken?.address) {
      console.log(
        '[' + chainId + '] pool address resolved to token ' + pair.baseToken.address +
        ' (input was pair ' + addr.slice(0, 10) + '…)',
      );
      return { tokenAddress: pair.baseToken.address.toLowerCase(), pair };
    }
  }

  return null;
}

/** Build autotrack token object from a resolved EVM DexScreener pair. */
export function tokenDataFromEvmPair(chainId, pair, tokenAddress) {
  const token = pairToToken(pair, tokenAddress);
  return {
    ...token,
    platform: 'dexscreener',
    chain: chainId,
    address: tokenAddress,
  };
}

/** @deprecated back-compat wrappers — robinhood behavior byte-identical to before. */
export const resolveRobinhoodToken = (rawAddr) => resolveEvmChainToken('robinhood', rawAddr);
export const tokenDataFromRobinhoodPair = (pair, addr) => tokenDataFromEvmPair('robinhood', pair, addr);
```

### Fix B1 — `index.js`: chain-generic autotrack dispatch

**(a)** Line 23 import:

```js
// BEFORE
import { fetchDexPair, resolveRobinhoodToken, tokenDataFromRobinhoodPair } from './dexPair.js';
// AFTER
import { fetchDexPair, resolveEvmChainToken, tokenDataFromEvmPair } from './dexPair.js';
```

**(b)** Ensure `CHAINS` is included in the `./chains.js` import list at the top of
`index.js` (add it if missing — the list already imports `chainLabel`, `chainBadge`,
`makeStorageKey`, `extractAddresses`, `resolveUserInputToKey`, `resolveArchivedKey`, …).

**(c)** Replace the entire `autoTrack` function AND the entire `autoTrackRobinhood`
function with:

```js
async function autoTrack(ref, message, seenThisMessage = new Set()) {
  const { chainId, raw } = ref;
  if (CHAINS[chainId]?.kind === 'evm') return autoTrackEvm(chainId, raw, message, seenThisMessage);
  return autoTrackSolana(raw, message, seenThisMessage);
}

async function autoTrackEvm(chainId, raw, message, seenThisMessage) {
  const db = ensureDBSchema(loadDB());
  const resolved = await resolveEvmChainToken(chainId, raw);
  if (!resolved) {
    console.log('[autotrack] 0x ' + raw.slice(0, 10) + '… has no ' + chainId + ' pair — ignored');
    return;
  }

  const storageKey = makeStorageKey(chainId, resolved.tokenAddress);

  // Cross-EVM dedupe: a bare 0x matches every enabled EVM chain, so the same token
  // can arrive here once per chain. If it is already tracked — or was already handled
  // earlier in this same message — on another EVM chain, skip instead of double-tracking.
  for (const otherId of Object.keys(CHAINS)) {
    if (CHAINS[otherId].kind !== 'evm' || otherId === chainId) continue;
    const otherKey = makeStorageKey(otherId, resolved.tokenAddress);
    if (seenThisMessage.has(otherKey) || db.tokens[otherKey]) {
      console.log(
        '[autotrack] ' + resolved.tokenAddress.slice(0, 10) + '… already handled on ' +
        otherId + ' — skipping ' + chainId,
      );
      return;
    }
  }

  if (seenThisMessage.has(storageKey)) {
    console.log('[autotrack] duplicate ' + chainId + ' mint in same message: ' + storageKey.slice(0, 20) + '…');
    return;
  }
  if (db.tokens[storageKey]) {
    console.log('[autotrack] already tracking ' + (db.tokens[storageKey].symbol || storageKey) + ' (OG preserved)');
    await onAlreadyTracking(message.client, db, storageKey, message);
    return;
  }

  const archivedKey = resolveArchivedKey(db, storageKey, raw);
  if (archivedKey) {
    const og = db.archived[archivedKey];
    // chain: chainId override matters when an archived entry is restored under a
    // different EVM chain key — keeps entry.chain consistent with the storage key.
    db.tokens[storageKey] = { ...og, address: resolved.tokenAddress, chain: chainId };
    delete db.archived[archivedKey];
    saveDB(db);
    console.log('[repair] un-archived ' + (og.symbol || storageKey) + ' on repost — OG call preserved');
    return;
  }

  seenThisMessage.add(storageKey);
  const token = tokenDataFromEvmPair(chainId, resolved.pair, resolved.tokenAddress);
  token.xHandle = xHandleFromPair(resolved.pair);
  const ageStr = getTokenAgeFlag(token.pairCreatedAt);
  token.ageStr = ageStr;
  token.liquidity = resolved.pair?.liquidity?.usd || token.liquidity || 0;

  await sendTrackingEmbed(message, token, storageKey, db, () =>
    buildTrackedEntry(token, storageKey, message, ageStr),
  );
}
```

Note on the dedupe: if an address is already tracked on robinhood and someone posts a
base-tagged link for the same address, the base track is skipped (logged). To genuinely
switch chains, `/remove` the old key first.

### Fix B3 — `chains.js`: `resolveUserInputToKey` must try every EVM chain

Replace the `0x` branch:

```js
// BEFORE
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    const key = makeStorageKey('robinhood', raw);
    if (db.tokens[key]) return key;
    return null;
  }
// AFTER
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    for (const chainId of Object.keys(CHAINS)) {
      if (CHAINS[chainId].kind !== 'evm') continue;
      const key = makeStorageKey(chainId, raw);
      if (db.tokens[key]) return key;
    }
    return null;
  }
```

Edge case: if the same `0x` is tracked on two EVM chains, this resolves to whichever
appears first in `CHAINS`. The user can always pass the full prefixed key
(`base:0x…`) to disambiguate — the existing `raw.includes(':')` lookup below this
branch already supports that.

### Fix B4 — `chains.js`: `resolveArchivedKey` same generalization

```js
// BEFORE
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    const key = makeStorageKey('robinhood', raw);
    return db.archived[key] ? key : null;
  }
// AFTER
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    for (const chainId of Object.keys(CHAINS)) {
      if (CHAINS[chainId].kind !== 'evm') continue;
      const key = makeStorageKey(chainId, raw);
      if (db.archived[key]) return key;
    }
    return null;
  }
```

### Fix B5 — `chains.js`: `isForeignDexScreenerContext` must compare the CURRENT chain

```js
// BEFORE
function isForeignDexScreenerContext(body, startIndex, rawLen) {
  const chunk = body.slice(Math.max(0, startIndex - 60), startIndex + rawLen);
  const hit = chunk.match(/dexscreener\.com\/([a-z0-9_-]+)\/0x[a-fA-F0-9]{40}$/i);
  return hit && hit[1].toLowerCase() !== 'robinhood';
}
// AFTER
function isForeignDexScreenerContext(body, startIndex, rawLen, chainId) {
  const chunk = body.slice(Math.max(0, startIndex - 60), startIndex + rawLen);
  const hit = chunk.match(/dexscreener\.com\/([a-z0-9_-]+)\/0x[a-fA-F0-9]{40}$/i);
  return hit && hit[1].toLowerCase() !== chainId;
}
```

And update its single call site inside `extractAddresses`:

```js
// BEFORE
      if (chain.kind === 'evm' && isForeignDexScreenerContext(body, m.index ?? 0, raw.length)) {
// AFTER
      if (chain.kind === 'evm' && isForeignDexScreenerContext(body, m.index ?? 0, raw.length, chainId)) {
```

### Fix B6 — `index.js`: `buildTrackedEntry` gates on EVM kind, not robinhood

Replace the definition line, then rename the five usages (`isRh` → `isEvm`):

```js
// BEFORE
  const isRh = chainId === 'robinhood';
// AFTER
  const isEvm = CHAINS[chainId]?.kind === 'evm';
```

Five one-line usage renames in the returned object (values otherwise unchanged):
`address: isEvm ? token.address : storageKey,` ·
`bondingProgress: isEvm ? null : (token.bondingProgress || 0),` ·
`graduationAlertFired: isEvm ? null : false,` ·
`bondingAlertFired: isEvm ? null : false,` ·
`devWallet: isEvm ? null : (token.creator || null),`

### Fix B7 — `poller.js`: EVM short-circuit by kind (intent fix)

**(a)** Line 11 import — add `isEvmChain`:

```js
import { chainLabel, isBrokenSolKey, parseStorageKey, isLegacyEvmKey, enabledChains, chainBadge, isEvmChain } from './chains.js';
```

**(b)** In `processToken`:

```js
// BEFORE
  if (entry.chain === 'robinhood') {
// AFTER
  if (isEvmChain(entry.chain)) {
```

### Fix B8 — explicit Solana-only guards (currently safe by accident)

`risk/rugscan.js` (`scanOnTrack`, first line):

```js
// BEFORE
  if (!mint || entry.chain === 'robinhood') return;
// AFTER
  if (!mint || (entry.chain || 'solana') !== 'solana') return;
```

`webhooks/devSell.js` (`processOneTx` loop):

```js
// BEFORE
    if (!entry.devWallet || entry.chain === 'robinhood') continue;
// AFTER
    if (!entry.devWallet || (entry.chain || 'solana') !== 'solana') continue;
```

The `|| 'solana'` fallback matters: legacy Solana entries may lack `entry.chain`, and
these two functions must keep treating them as Solana.

### Fix B9 (OPTIONAL) — extend warden coverage to Base

Without this, Base tokens are simply un-audited (verified: NO false alarms occur —
`keyHygiene` falls through to a `CHAINS[chainId]` existence check that passes, and
`schemaBounds`' generic caps apply cleanly). To close the gap:

**(a)** `warden/checks/priceTruth.js`:

```js
// BEFORE
  const chains = ['solana', 'robinhood'];
// AFTER
  const chains = ['solana', 'robinhood', 'base'];
```

**(b)** `warden/checks/canary.js`:

```js
// BEFORE
    if (chainId !== 'solana' && chainId !== 'robinhood') continue;
// AFTER
    if (chainId !== 'solana' && chainId !== 'robinhood' && chainId !== 'base') continue;
```

**(c)** `warden/checks/keyHygiene.js` — replace the whole `if (chainId === 'robinhood') { … continue; }`
block with the EVM-generic version (robinhood behavior unchanged; issue IDs identical, so
`warden/tests/acceptance.mjs` still passes — run `npm run warden:test` to confirm):

```js
    if (CHAINS[chainId]?.kind === 'evm') {
      const suffix = key.slice((chainId + ':').length);
      if (suffix !== suffix.toLowerCase()) {
        raise('C3', 'CRITICAL', key, chainId + ' key suffix must be lowercase hex', { key });
      }
      if ((entry?.address || '') !== suffix) {
        raise('C3', 'CRITICAL', key, chainId + ' entry.address mismatch', { key, address: entry?.address });
      }
      if (entry?.chain && entry.chain !== chainId) {
        raise('C3', 'CRITICAL', key, chainId + ' entry.chain must be ' + chainId, { chain: entry.chain });
      }
      if (entry?.bondingProgress != null || entry?.graduationAlertFired) {
        raise('C5', 'WARN', key, chainId + ' entry has bonding/graduation fields', {
          bondingProgress: entry.bondingProgress,
          graduationAlertFired: entry.graduationAlertFired,
        });
      }
      continue;
    }
```

**(d)** `warden/checks/schemaBounds.js` — widen the robinhood-only field check:

```js
// BEFORE
    if (chainId === 'robinhood') {
      if (entry.rugScan) raise('C5', 'WARN', key, 'Robinhood entry has rugScan (Solana-only)');
      if (entry.devWallet) raise('C5', 'WARN', key, 'Robinhood entry has devWallet');
    }
// AFTER
    if (chainId === 'robinhood' || chainId === 'base') {
      if (entry.rugScan) raise('C5', 'WARN', key, chainId + ' entry has rugScan (Solana-only)');
      if (entry.devWallet) raise('C5', 'WARN', key, chainId + ' entry has devWallet');
    }
```

### Verified SAFE — reviewed, no changes needed

The poller scheduler and batch consumer (`byChain` → `batchFetch(chainId, …)` →
`processTokenWithLive`) are fully chain-generic, as are all six `signals/` modules,
`dexBatch.js`, `autotrackHelpers.js` / `sendTrackingEmbed`, `risk/deployers.js`,
`subscriptions.js`, `positions.js`, `alertGate.js`, `recap.js`, `xCommand.js`,
`xSocial.js`, `metaTags.js`, `httpServer.js`, `cycleStats.js`, `channelAlert.js`,
`dmRouter.js`, and `dbStore.js` — a full-text sweep found zero chain-specific logic in
any of them. `scripts/repair-mint-case.mjs` is guarded by `isBrokenSolKey`, which
explicitly returns `false` for non-Solana keys. Solana and Robinhood behavior is
preserved by construction: the robinhood autotrack path now flows through
`autoTrackEvm('robinhood', …)` with byte-identical logic, and the deprecated wrappers
keep any other import working.

Known cosmetic gap (intentionally not fixed): the poll-cycle stats counters
(`scheduledSol` / `scheduledRh` in `poller.js` and their `recordCycle` fields) do not
count Base tokens — this affects one log line and cycle stats only, never behavior.
Do not refactor `cycleStats.js` for this.

---

## PART 2 — Native B20 badge (OPTIONAL, read-only, B20-specific)

**Goal:** when a tracked **Base** token is a *native B20* token, show a small badge in
alerts, e.g. `⬡ B20 · Stablecoin (USD)` or `⬡ B20 · Asset`. This is the only place a
"B20-aware" behavior makes sense for a monitor. It changes nothing about tracking; it only
annotates.

### 2.0 — Verified facts this module relies on (from `base/base-std`)

Precompile addresses (identical on Mainnet, Base Sepolia, Vibenet, local anvil — from
`StdPrecompiles.sol`):

| Precompile          | Address                                      |
| ------------------- | -------------------------------------------- |
| B20Factory          | `0xB20f000000000000000000000000000000000000` |
| Activation Registry | `0x8453000000000000000000000000000000000001` |
| Policy Registry     | `0x8453000000000000000000000000000000000002` |

Factory read functions (from `IB20Factory.sol`) and variant enum:

- `isB20(address token) view returns (bool)` — authoritative "is this a native B20?" check.
- `enum B20Variant { ASSET, STABLECOIN }` — **encoded in address byte `[10]` (zero-indexed):
  `0x00` = ASSET, `0x01` = STABLECOIN.** Recoverable from the address alone once `isB20` is
  true — no extra RPC call needed for the variant.
- Stablecoin variant adds `currency() view returns (string)` (from `IB20Stablecoin.sol`),
  e.g. `"USD"`.

Verified 4-byte selectors (only needed if you choose the zero-dependency raw-RPC path):

- `isB20(address)` → `0xfa19b927`
- `currency()` → `0xe5a6b10f`

### 2.1 — Prereq: a Base RPC endpoint

Add to `.env` / `.env.example`:

```bash
# Base JSON-RPC for optional native-B20 detection. Public endpoint is rate-limited;
# use an Alchemy/Infura/QuickNode URL for production.
BASE_RPC_URL=https://mainnet.base.org
```

### 2.2 — Add the dependency (recommended path)

Use `viem` — it encodes/decodes calls from the verified ABI, which removes an entire class
of manual-ABI bugs. (A zero-dependency alternative is in §2.5.)

```bash
npm install viem
```

### 2.3 — Create `b20.js` (new file at repo root, ESM to match the project)

```js
// b20.js — read-only native-B20 detection for Base tokens.
// Safe to call on any address; returns { isB20:false } for non-B20 / errors.
import { createPublicClient, http, getAddress } from 'viem';
import { base } from 'viem/chains';

const B20_FACTORY = '0xB20f000000000000000000000000000000000000';

// Minimal ABIs — copied from base-std interface definitions.
const FACTORY_ABI = [
  {
    type: 'function',
    name: 'isB20',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
];

const STABLECOIN_ABI = [
  {
    type: 'function',
    name: 'currency',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
];

let _client = null;
function client() {
  if (_client) return _client;
  _client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org'),
  });
  return _client;
}

/** Variant is encoded in address byte [10] (zero-indexed). 0x00=ASSET, 0x01=STABLECOIN. */
function variantFromAddress(addr) {
  const hex = String(addr).toLowerCase().replace(/^0x/, '');
  const b = hex.slice(20, 22); // byte index 10
  if (b === '01') return 'STABLECOIN';
  if (b === '00') return 'ASSET';
  return 'UNKNOWN';
}

/**
 * Detect whether an EVM address is a native B20 token on Base.
 * @returns {Promise<{isB20:boolean, variant?:string, currency?:string}>}
 */
export async function detectB20(address) {
  let token;
  try {
    token = getAddress(address); // checksums / validates; throws on bad input
  } catch {
    return { isB20: false };
  }

  let is;
  try {
    is = await client().readContract({
      address: B20_FACTORY,
      abi: FACTORY_ABI,
      functionName: 'isB20',
      args: [token],
    });
  } catch {
    return { isB20: false }; // RPC error / not activated → treat as non-B20
  }
  if (!is) return { isB20: false };

  const variant = variantFromAddress(token);

  if (variant === 'STABLECOIN') {
    try {
      const currency = await client().readContract({
        address: token,
        abi: STABLECOIN_ABI,
        functionName: 'currency',
      });
      return { isB20: true, variant, currency };
    } catch {
      return { isB20: true, variant }; // currency read failed; still a B20 stablecoin
    }
  }

  return { isB20: true, variant };
}

/** Render a short badge for alerts. Returns '' when not a B20. */
export function formatB20Badge(b20) {
  if (!b20 || !b20.isB20) return '';
  if (b20.variant === 'STABLECOIN') {
    return b20.currency ? `⬡ B20 · Stablecoin (${b20.currency})` : '⬡ B20 · Stablecoin';
  }
  if (b20.variant === 'ASSET') return '⬡ B20 · Asset';
  return '⬡ B20';
}

/**
 * Convenience: enrich a token object in place (only for Base). Attaches `token.b20`.
 * Call this ONCE when a Base token is first added to tracking — B20 status is immutable,
 * so there is no need to re-detect on every poll.
 */
export async function enrichWithB20(token) {
  if (!token || String(token.chain).toLowerCase() !== 'base') return token;
  token.b20 = await detectB20(token.address);
  return token;
}
```

### 2.4 — Wire it in (two touch points)

**(a) Detect once, at first-track time.** Locate where a newly resolved token is first
persisted to the tracked set (the autotrack path — see `autotrackHelpers.js` and the
add-token logic in `index.js` / `poller.js`). Immediately before persisting, enrich Base
tokens:

```js
import { enrichWithB20 } from './b20.js';

// ...after the token object is resolved and BEFORE it is written to tracked storage:
await enrichWithB20(token); // no-op for non-Base tokens; adds token.b20 for Base
```

Persist `token.b20` alongside the rest of the token record so it survives restarts and
never needs re-fetching.

**(b) Render the badge in alerts.** Wherever alert embeds are built (milestone / TP
messages), append the badge if present:

```js
import { formatB20Badge } from './b20.js';

const b20Badge = formatB20Badge(token.b20); // '' when not a B20
// Example: add to an embed field or the description line:
// if (b20Badge) description += `\n${b20Badge}`;
```

**Rules for the agent:**
- Do **not** call `detectB20` inside the polling hot loop or the Dexscreener batch path —
  that adds an RPC round-trip per token per cycle. Detect once at add-time only.
- `enrichWithB20` is a no-op for Solana/Robinhood, so it is safe to call unconditionally on
  any newly-added token.
- Never let a failed RPC block tracking: `detectB20` already swallows errors and returns
  `{ isB20:false }`. Keep it that way.

### 2.5 — Zero-dependency alternative (only if you refuse to add `viem`)

If a new dependency is unacceptable, replace the two `readContract` calls with raw
`eth_call` POSTs using the bot's existing `node-fetch`, the verified selectors from §2.0
(`isB20` → `0xfa19b927`, left-pad the 20-byte address to 32 bytes; `currency` →
`0xe5a6b10f`), and a standard ABI decode (bool = last byte of the 32-byte return; string =
offset/length/bytes decode). The `viem` path in §2.3 is strongly preferred because it
eliminates manual encode/decode mistakes — which is exactly the failure mode you're trying
to avoid.

---

## Definition of Done

**Part 1 (required):**
- [ ] `chains.js` `CHAINS` object contains a `base` entry with `kind:'evm'`,
      `dexScreenerSlug:'base'`, `label:'BASE'`, and the `0x` `addressRegex`.
- [ ] `EVM_CHAINS` untouched (already includes `'base'`).
- [ ] `.env` sets `ENABLED_CHAINS=solana,base` (and `.env.example` comment updated).
- [ ] Posting a Base token (tagged link and bare address) resolves and begins tracking;
      logs show resolution `on base`; DB key is `base:0x…`.
- [ ] Alerts show the `🔵 BASE` chain badge.
- [ ] Ambiguity note (§1.4) understood: prefer tagged links / run without Robinhood.

**Part 1B (required — ship with Part 1):**
- [ ] B2: `dexPair.js` has `resolveEvmChainToken` / `tokenDataFromEvmPair`, imports
      `CHAINS`, and keeps the deprecated robinhood wrappers.
- [ ] B1: `autoTrack` dispatches on `CHAINS[chainId]?.kind === 'evm'`;
      `autoTrackRobinhood` is replaced by `autoTrackEvm` (with cross-EVM dedupe and the
      `chain: chainId` un-archive override); `index.js` imports updated.
- [ ] B3/B4: `resolveUserInputToKey` and `resolveArchivedKey` loop all EVM chains —
      verify `/remove 0x…` works on a tracked Base token and on a prefixed `base:0x…` key.
- [ ] B5: `isForeignDexScreenerContext` takes `chainId`; a
      `dexscreener.com/robinhood/0x…` link no longer produces a base candidate (check logs).
- [ ] B6: `buildTrackedEntry` uses `isEvm`; a fresh Base entry has
      `bondingProgress: null`, `graduationAlertFired: null`, `devWallet: null`, and
      `address` equal to the bare lowercase `0x` (key suffix).
- [ ] B7/B8 applied (poller kind-guard; explicit Solana-only guards in rugscan + devSell).
- [ ] Regression: Solana and Robinhood autotrack, `/remove`, and repost-unarchive behave
      exactly as before; `npm run warden:test` passes.
- [ ] (Optional) B9 warden coverage applied.

**Part 2 (optional):**
- [ ] `BASE_RPC_URL` added to env.
- [ ] `viem` installed (or the §2.5 raw path implemented).
- [ ] `b20.js` added exactly as in §2.3.
- [ ] `enrichWithB20(token)` called once at first-track, `token.b20` persisted.
- [ ] `formatB20Badge(token.b20)` rendered in alert embeds.
- [ ] Confirmed: detection runs at add-time only, never in the poll loop; RPC failures
      never block tracking.

---

## Appendix — source references (all verified, not from memory)

- B20 spec (ERC-20 superset, variants, precompile addresses):
  `https://docs.base.org/base-chain/specs/upgrades/beryl/b20`
- Interface definitions: `https://github.com/base/base-std/tree/main/src/interfaces`
  (`IB20Factory.sol`, `IB20Stablecoin.sol`), `src/StdPrecompiles.sol`,
  `src/lib/B20Constants.sol`.
- Repo files this spec was written against: `chains.js`, `dexPair.js`, `dexBatch.js`,
  `package.json`, `.env.example`.