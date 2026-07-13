# SPEC: /x Upgrade MVP — X Account Intelligence
## Implementation instructions for the coding agent

> **Read fully before coding.** This upgrades the `/x` command from a rename yes/no into an X-account risk tool, and — the core feature — ties X accounts to the group's own tracked-token history so recycled scammer accounts get flagged automatically at track time. Where this spec and your instinct disagree, the spec wins.

---

## 0. Context

**Repo:** `enstest1/take_profits_profit_bot` · Node 18+ **ESM** · state `/data/tracked.json` via `dbStore.js` (atomic).

**Current `/x` behavior:** takes an account, queries the existing Twttr API integration + memory.lol, replies with rename status and a footer crediting the data sources. Find the existing handler in `index.js` before writing anything — **reuse its fetch functions**; this spec does not change which APIs are used, only what is stored, cross-referenced, and displayed.

**Existing invariants that bind here:** OG fields immutable · never `.toLowerCase()` a Solana mint (X handles ARE lowercased — they're case-insensitive, that's correct) · storage keys only via `makeStorageKey()`/`resolveUserInputToKey()` from `chains.js` · no new code path may crash autoTrack or the poll loop — every X lookup is wrapped and degradable · reposts stay silent.

**Design principle (same as deployer memory):** the unique value is the group's own call graph. External X data (age, renames, followers) is commodity; **X-handle → tracked-token history** is data nobody else has. Build the index first, the pretty command second.

---

## 1. Schema additions

All fields optional/nullable; existing entries lack them; initialize lazily; never migrate-rewrite.

```javascript
// ADDITION to db.tokens[key]
{
  xHandle: 'pelp333' | null,     // normalized: lowercase, no '@'. Captured at track time from
                                  // DexScreener pair info.socials. null if token has no X link.
}

// NEW top-level index (mirror of db.deployers pattern)
db.xAccounts = {
  'pelp333': {                    // key = normalized handle
    tokens: ['<storageKey>', ...],   // every tracked token this handle was attached to, max 50
    updatedAt: 1720000000000,
  }
};
```

**Handle normalization — one function, one choke point, in new file `xSocial.js`. Nothing else may parse handles:**

```javascript
// xSocial.js
/** Normalize any handle/URL form to bare lowercase handle, or null if unparseable. */
export function normalizeXHandle(input) {
  if (!input) return null;
  let s = String(input).trim();
  // URL forms: https://x.com/pelp333, https://twitter.com/pelp333?s=21, x.com/pelp333/
  const m = /(?:twitter\.com|x\.com)\/(@?[A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(s);
  if (m) s = m[1];
  s = s.replace(/^@/, '');
  if (/^(status|i|home|search|explore|intent|hashtag)$/i.test(s)) return null;  // path words, not handles
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s.toLowerCase() : null;
}

/** Extract the X handle from a DexScreener pair object, or null. */
export function xHandleFromPair(pair) {
  const socials = pair?.info?.socials || [];
  const tw = socials.find(s => /^(twitter|x)$/i.test(s?.type || '') ||
                               /(?:twitter\.com|x\.com)\//i.test(s?.url || ''));
  return tw ? normalizeXHandle(tw.url || tw.handle) : null;
}

/** Incremental index update. Called on every successful autoTrack. */
export function indexXAccount(db, handle, storageKey) {
  if (!handle) return;
  db.xAccounts = db.xAccounts || {};
  const a = db.xAccounts[handle] = db.xAccounts[handle] || { tokens: [], updatedAt: 0 };
  if (!a.tokens.includes(storageKey)) a.tokens.push(storageKey);
  if (a.tokens.length > 50) a.tokens = a.tokens.slice(-50);
  a.updatedAt = Date.now();
}

/** Group-history line for a handle vs OUR tracked tokens (tokens + archived), excluding currentKey.
 *  Returns '' when no prior tokens. */
export function xHistoryLine(db, handle, currentKey) {
  const keys = (db.xAccounts?.[handle]?.tokens || []).filter(k => k !== currentKey);
  if (keys.length === 0) return '';
  const entries = keys.map(k => db.tokens[k] || db.archived?.[k]).filter(Boolean);
  const parts = entries.slice(-4).map(e => {
    const peak = Number(e.peakMultiple) || 1;
    const badge = peak < 0.5 ? '💀' : peak >= 2 ? '🚀' : '➖';
    return `$${e.symbol} ${badge} ${peak.toFixed(1)}x`;
  });
  const rugs = entries.filter(e => (Number(e.peakMultiple) || 1) < 0.5).length;
  const prefix = rugs > 0 && rugs === entries.length ? '☠️' : '📜';
  return `${prefix} X history: ran ${entries.length} tracked token${entries.length > 1 ? 's' : ''} — ${parts.join(', ')}`;
}
```

---

## 2. Phase plan — one commit per phase

| Phase | Work | Files |
|-------|------|-------|
| 1 | Handle capture + index + rebuild script | `xSocial.js`, `index.js` (autoTrack), `scripts/rebuild-x-index.mjs` |
| 2 | Reverse flag in the auto-track embed | `index.js` |
| 3 | `/x` command upgrade (rename chain, age, ratio, group history, verdict; footer removed) | `index.js` (or extract to `xCommand.js`) |

---

## 3. Phase 1 — Capture + index

**autoTrack integration:** at the point where the entry object is built from the resolved pair (both Solana and Robinhood paths):

```javascript
entry.xHandle = xHandleFromPair(resolved.pair);          // null is fine
// after db.tokens[storageKey] = entry:
indexXAccount(db, entry.xHandle, storageKey);            // no-op when null
```

Zero API calls — the socials are already in the pair response you fetched. If the pump.fun path exposes a twitter field on its token object, capture it there too via `normalizeXHandle`; if unclear, leave pump.fun capture out and note it in the commit message.

**`scripts/rebuild-x-index.mjs`:** standalone, walks `db.tokens` + `db.archived`; entries already carrying `xHandle` get indexed directly. For entries WITHOUT `xHandle` (the entire existing DB): do NOT re-fetch 1,800 pairs to backfill — that's an API storm for historical data. Backfill lazily instead: in the poller's `processTokenWithLive`, if `entry.xHandle === undefined` and the live fetch used a full pair object containing socials, set it then (one-time per token, free). The script prints `indexed=N skipped(noHandle)=M`. Run once after deploy; atomic save; no marker file needed (idempotent).

---

## 4. Phase 2 — Reverse flag on auto-track (the killer feature)

In `autoTrack()`, when building the 📡 embed, after the deployer line: call `xHistoryLine(db, entry.xHandle, storageKey)` — pure DB lookup, synchronous, zero API cost — and append when non-empty. Result:

```
📡 Auto-tracking ◎ NEWCOIN
Called by @degen — 63% hit rate · 3.1x avg peak
Price at call: $0.000041 · MCap: $412K
📜 Deployer: 2 prior — 1 rugged · best 3.2x
☠️ X history: ran 2 tracked tokens — $SCAM1 💀 0.2x, $SCAM2 💀 0.3x
```

Rules: the ☠️ variant (all prior tokens rugged) must be visually loud — it is the "do not ape" signal arriving before anyone apes. Never block or delay the embed for this line; it's local data. When `xHandle` is null or history is empty, no line — silence, not "no history found."

---

## 5. Phase 3 — `/x` command upgrade

### 5.1 Input resolution

`/x query:<string>` accepts, in this order: **a CA** (resolve via `resolveUserInputToKey`; if it hits a tracked entry, use `entry.xHandle` — reply `That token has no X account on record.` if null) → **an X URL or @handle** (via `normalizeXHandle`) → else ephemeral `Couldn't parse that as an X account or tracked CA.`

### 5.2 Data assembly — degrade gracefully, never fail whole

Three sources, each independently optional. Wrap each in try/catch with `AbortSignal.timeout(8000)`; a failed source renders as `unavailable`, and the reply ALWAYS sends with whatever succeeded:

1. **Profile** (existing Twttr API fetcher): created date, followers, following, verified/paid status.
2. **Renames** (existing memory.lol fetcher): list of `{ name, dateRange }` prior handles.
3. **Group history** (local, cannot fail): `xHistoryLine` for the queried handle AND every prior handle from source 2 — recycled accounts are caught precisely because you check the old names against your index too.

**Cache:** in-memory `Map` keyed by handle, TTL 10 minutes, caches the assembled result (not the embed). Prevents the group hammering the X APIs re-running `/x` on the same drama account.

### 5.3 Risk verdict — exact rules, evaluated top-down, first DANGER wins; collect ALL matching reasons for display

```javascript
// DANGER if any:
//   D1: any handle in the chain (current or prior) tied to ≥1 tracked token with peak < 0.5x
//   D2: account age < 7 days
// WARN if any (and no DANGER):
//   W1: renamed ≥ 2 times in the last 12 months
//   W2: bought-account heuristic — account age > 2 years AND most recent rename < 6 months ago
//   W3: account age < 30 days
//   W4: following/followers ratio > 3 (follows far more than follow it — engagement-farm shape)
// OK otherwise. Unknown data (source failed) never counts toward a verdict — verdict line
// gains a trailing ' (partial data)' marker when any source was unavailable.
```

### 5.4 Output — exact layout

```
𝕏 @pelp333
Created Mar 2019 · 41.2K followers · following 3.1K (ratio 0.08) · ✔ paid
Renames (2): @SolGemCalls (Mar 2026) ← @NFTWhaleAlerts (Nov 2025)
📜 Your history: @solgemcalls ran $SCAM1 💀 0.2x · @pelp333 ran $WIF 🚀 14.3x
🛡️ X Risk: ⚠️ WARN — renamed 2× in 12 months · prior handle tied to a rugged call
```

Rules: **no footer** — delete the `Twttr API + memory.lol • <time>` line entirely (Discord timestamps messages already). No renames → `Renames: none detected`. No group history on any handle in the chain → omit the history line entirely. Verdict line always last, always present. Number formatting: `41.2K`/`1.3M`, ratio 2 decimals. Prior-handle history entries are prefixed with the handle they belong to (as shown) so it's clear WHICH name ran the dead token. Embed color by verdict: green `0x2ECC71`, yellow `0xF1C40F`, red `0xE74C3C`.

### 5.5 Explicitly out of scope

No tweet scraping, sentiment, AI summaries, or follower-list analysis — expensive, slow, and weaker than the structural signals above. No automatic `/x` API calls during autoTrack (the reverse flag is local-only by design; profile/rename fetches happen only when a human runs `/x`). Do not persist X profile data into `tracked.json` beyond `xHandle` — profiles go stale; fetch fresh on command.

---

## 6. Acceptance tests

| # | Test | Expected |
|---|------|----------|
| 1 | Track a token whose pair has a twitter social | `entry.xHandle` set, normalized (no @, lowercase); `db.xAccounts[handle].tokens` contains the key |
| 2 | Track a token with no socials | `xHandle: null`, no index entry, no embed line, no error |
| 3 | Track a SECOND token with the same X handle, first one rugged (test data) | 📡 embed shows `☠️ X history` line naming the dead token |
| 4 | `normalizeXHandle` on: `@Pelp333`, `https://x.com/pelp333?s=21`, `twitter.com/pelp333/`, `x.com/status`, `x.com/i/spaces/abc` | `pelp333` ×3, then `null` ×2 |
| 5 | `/x pelp333`, `/x @pelp333`, `/x https://x.com/pelp333` | Identical output |
| 6 | `/x <tracked CA with xHandle>` | Resolves to that handle's report |
| 7 | `/x <tracked CA without xHandle>` | "no X account on record" |
| 8 | memory.lol times out | Report renders with `Renames: unavailable` + verdict marked `(partial data)`; no crash |
| 9 | Prior handle (not current) matches a rugged tracked token | D1 fires — verdict DANGER, reason names the prior handle |
| 10 | Old account (2019) renamed last month, no rug history | W2 fires — WARN "possible purchased account" |
| 11 | Run `/x` twice on same handle within 10 min | Second reply served from cache (verify via log line, no API calls) |
| 12 | Footer check | No data-source/timestamp footer anywhere in the reply |
| 13 | Rebuild script on prod-shaped test DB | `indexed=N skipped=M` printed; idempotent on second run (same counts, no dupes) |
| 14 | Grep sweep | All handle parsing goes through `normalizeXHandle`; no `.toLowerCase()` on mint variables introduced; autoTrack path contains zero new external HTTP calls |

## 7. Conventions

Branch `feature/x-intel`, commits `feat(x-p<N>): …`. `xSocial.js` is pure (no I/O) except nothing — keep fetchers where they live today or in `xApi.js` if extracting; pure/index logic must be importable by Warden later (a future check: every `db.xAccounts[h].tokens` key must exist in tokens/archived). Do not modify: key handling, OG fields, rate limiter, existing alert paths. If the existing Twttr/memory.lol fetcher shapes differ from assumptions here, adapt the assembly layer and note the mapping in the commit — do not change what's displayed.