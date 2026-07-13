# Warden — Auditor / Overlord Design v2
## Implementation-ready spec (supersedes v1 + review notes — this is the single current document)

> Read-only watchdog that continuously verifies the Take Profits bot's invariants and alerts a dedicated Discord channel when anything drifts. **v2 changes:** Robinhood-era key rules, v3 schema awareness, single shared HTTP server (PORT conflict fix), same-repo layout, deploy-window alert logic, hardened security, revised C6 tolerance, and an updated build order. If you have read v1 or the review of v1: discard both; conflicts resolve in favor of this document.

---

## 0. Non-negotiable design rules

1. **Warden never writes to `tracked.json`, the volume, or any main-bot state.** It reads, compares, alerts. Worst case for a Warden bug is a false alert — never corruption. No auto-remediation, ever. Restore is a human-operated script with a mandatory preview (§8).
2. **Warden lives in the same repo** at `warden/`, deployed as a separate Railway service (`railway.warden.toml` or service root config pointing at `warden/index.js`). Reason: Warden MUST import the bot's real `chains.js` (`parseStorageKey`, `makeStorageKey`, `isBrokenSolKey`, `CHAINS`) rather than carry copies. Duplicated key logic drifts, and a watchdog whose definition of "valid key" drifts from the bot's manufactures false alarms about correct data. Warden may import ONLY pure helper modules — never `dbStore.js`, never anything that touches `/data`.
3. **Alerts go out via a Discord webhook** (`WARDEN_WEBHOOK_URL`), not a bot client — so audit pings land even when the main bot's gateway is dead.
4. All Warden→bot communication is pull-based over HTTP with a bearer token. Prefer Railway **private networking** for these pulls if available; the endpoints must be safe on the public URL regardless (§2).

---

## 1. Architecture

```
┌───────────────────────────────┐          ┌──────────────────────────────┐
│  Take Profits bot (existing)  │   HTTPS  │  Warden (separate Railway    │
│                               │◄─────────│  service, same repo /warden) │
│  ONE http server on PORT:     │  bearer  │                              │
│   POST /helius-webhook        │  token   │  · snapshot pull + hash 304  │
│   GET  /warden/status         │          │  · shadow store (48 rolling  │
│   GET  /warden/snapshot       │          │    + 30 daily snapshots)     │
│   GET  /health         (open) │          │  · check catalog (§4–6)      │
└───────────────────────────────┘          │  · alert engine (§7)         │
                                           └──────────────┬───────────────┘
                                                          │ webhook
                                                          ▼
                                                  #bot-audit channel
```

### 1.1 Shared HTTP server — the PORT fix

The v3 dev-sell feature already binds Railway's `PORT` for Helius webhooks. Do NOT start a second HTTP server. Extend the existing one with path routing — one server, three secured routes plus an open health route:

```js
// httpServer.js — main bot (replaces/extends webhooks/heliusServer.js routing)
import { loadDB } from './dbStore.js';
import crypto from 'crypto';

const WARDEN_TOKEN = process.env.WARDEN_TOKEN;      // 32+ char random string; endpoint disabled if unset
export const cycleStats = {                          // poller.js mutates this in memory each cycle
  lastCycleAt: 0, lastCycleMs: 0, scheduledSol: 0, scheduledRh: 0,
  broken: 0, rate429Streak: 0, alertsSentToday: 0,
  gitSha: process.env.GIT_SHA || 'unknown',
  lastSummaryAt: 0,
};

export function routeRequest(req, res) {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }        // open, for pingers
  if (req.method === 'POST' && req.url === '/helius-webhook') return handleHelius(req, res);  // own secret, unchanged

  if (req.url.startsWith('/warden/')) {
    if (!WARDEN_TOKEN || req.headers.authorization !== 'Bearer ' + WARDEN_TOKEN) {
      res.writeHead(401); return res.end();
    }
    if (req.url === '/warden/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...cycleStats, now: Date.now() }));
    }
    if (req.url === '/warden/snapshot') {
      const body = JSON.stringify(loadDB());                       // atomic read via dbStore
      const hash = crypto.createHash('sha256').update(body).digest('hex');
      if (req.headers['if-none-match'] === hash) { res.writeHead(304); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', etag: hash });
      return res.end(body);
    }
  }
  res.writeHead(404); res.end();
}
```

The ETag/304 mechanic means most snapshot pulls transfer nothing (the DB only changes when something happened), which defers the snapshot-size question indefinitely. If the DB ever grows past ~10 MB, add `GET /warden/snapshot/og-only` returning just `{ key: { postedBy, postedByUserId, postedAt, priceAtCall, priceAtCallBackfilled } }` for C1/C2 at high frequency, with full pulls hourly — but do not build that now.

### 1.2 Security — the snapshot is user data now

Post-v3 the snapshot contains `positions` (who aped what, at what price), `subscriptions`, and Discord user IDs — not just token prices. Treat it accordingly: bearer token mandatory (server refuses `/warden/*` entirely when `WARDEN_TOKEN` is unset — fail closed, never open); use Railway private networking for Warden's pulls when available so snapshots never transit the public URL; Warden's own storage holds these snapshots, so its service is in-scope too — no public endpoints on Warden except an optional open `/health` for an external pinger; never include position/subscription contents in alert embeds — alerts reference keys and field names, not user financial data.

### 1.3 Cadence

`/warden/status` every 60s. `/warden/snapshot` every 5 min (mostly 304s). Full check pass runs on every snapshot that actually changed; liveness checks run on every status pull.

---

## 2. Key model — Warden must understand all three key eras

This is the most important v2 correction. The v1 rule "`key === entry.address` for every entry" is **wrong** post-Robinhood and would fire false CRITICALs on every valid Robinhood entry. Warden classifies every DB key via the bot's own `parseStorageKey()`:

| Era | Key shape | Rules Warden enforces |
|-----|-----------|----------------------|
| Solana | bare base58, mixed case | `key === entry.address` exactly (case-sensitive); key must contain ≥1 uppercase char if it contains letters (all-lowercase = mangled-mint regression); `entry.chain` absent or `'solana'` |
| Legacy EVM (frozen) | bare `0x…` | Set is FROZEN at Warden's first snapshot: Warden persists that key list once (`legacyEvmKeys.json` in its own storage). Any bare `0x` key NOT in the frozen set = **CRITICAL** (v1 pool-bypass bug returned). Entries must remain unpolled: `lastChecked` on a legacy row must never advance |
| Robinhood | `robinhood:0x…` | Suffix after the prefix must be fully lowercase 40-hex; `entry.address === key.slice('robinhood:'.length)`; `entry.chain === 'robinhood'`; `bondingProgress`/graduation fields must be null/absent |

Additional cross-era rules: no two keys case-insensitively equal within the same era (duplicates); an unknown prefix (`somechain:…` where `CHAINS[somechain]` doesn't exist in the imported registry) = **WARN** (future chain added without updating anything — the imported `chains.js` makes this self-updating when done in the same repo).

---

## 3. What is immutable, what is bounded, what is free

v3 added fields that change legitimately and constantly. Warden must be precise about which bucket each field is in, or it becomes a noise machine:

| Bucket | Fields | Check |
|--------|--------|-------|
| **Immutable** (C1, CRITICAL on change) | `postedBy`, `postedByUserId`, `postedAt`, `priceAtCall` (backfill exception), `calledInGuild` | Byte-identical across snapshots |
| **Monotonic / rule-bound** (C4) | `milestonesFired` (grow-only outside trench reset), `peakMultiple` (never decreases outside reset), `athLedger.peakMultiple` (grow-only), `drawdown`-class fields n/a | Rule per field |
| **Bounded** (C5b, WARN) | `velocityWindow ≤ 10`, `callChannels ≤ 10`, `tags ≤ 3`, `positions ≤ 200` per token, `milestonesFired ≤ 20` | Length caps — a ring buffer that stops being a ring buffer silently bloats every snapshot and save; exactly the slow rot Warden exists for |
| **Free** (C5 shape-only) | `positions` contents (users re-run `/ape` legitimately — Warden can't see Discord actions, so mutation here is normal), `lastPrice`, `lastChecked`, `lifecycle`, `rugScan`, cooldown timestamps, `subscriptions` | Type/shape valid, nothing else |

**Do not put `positions` in the immutability set.** It belongs to the user, not the OG call.

---

## 4. Check catalog — Layer 1: invariants (every changed snapshot, zero API)

**C1. OG immutability.** Per §3 immutable bucket, across `db.tokens` AND `db.archived` (an entry may move between them; follow it by key). Legal exceptions: (a) `priceAtCall` null→value exactly once with `priceAtCallBackfilled: true` appearing in the same transition; (b) key repair migration — an entry disappearing at a broken all-lowercase Solana key and reappearing at a mixed-case key that lowercases to it, with all OG fields identical, is the known mint-case repair, not a violation (match these pairs before flagging either side). Anything else = **CRITICAL** with field-level before/after diff.

```js
// warden/checks/ogImmutability.js
import { parseStorageKey } from '../../chains.js';
const IMMUTABLE = ['postedBy', 'postedByUserId', 'postedAt', 'priceAtCall', 'calledInGuild'];

export function checkOgImmutability(prevSnap, currSnap, raise) {
  const findCurr = (key) => currSnap.tokens?.[key] ?? currSnap.archived?.[key];
  for (const [key, prev] of allEntries(prevSnap)) {            // tokens + archived
    const curr = findCurr(key) ?? findRepairedTwin(currSnap, key, prev);  // §4 exception (b)
    if (!curr) continue;                                        // disappearance → C2's job
    for (const field of IMMUTABLE) {
      if (String(prev[field]) === String(curr[field])) continue;
      if (field === 'priceAtCall' && prev[field] == null &&
          curr.priceAtCallBackfilled === true && prev.priceAtCallBackfilled !== true) continue;
      raise('C1_OG_MUTATION', 'CRITICAL', key,
        `${curr.symbol || key.slice(0, 12)} — immutable \`${field}\` changed`,
        { field, before: prev[field], after: curr[field] });
    }
  }
}
```

**C2. Mass-deletion tripwire.** Active count drops >10% between snapshots without a matching rise in `db.archived` (and not explained by repair-twin rekeys) = **CRITICAL**. Catches the corrupt-file/empty-DB boot class. Warden's retained snapshot is also the recovery copy.

**C3. Key hygiene — per §2 era table.** All era rules, the frozen legacy set diff, the duplicate scan, and: `broken` (from `/warden/status`) increasing over its 24h floor after the mint-case repair era = case-regression tripwire → **CRITICAL**.

**C4. Milestone & peak consistency.** Per §3 monotonic bucket. `milestonesFired` shrank without `lastMilestoneResetAt` changing in the same window = **CRITICAL**; highest fired tier > `floor(peakMultiple) + 1` = **WARN** (math drift); `peakMultiple < lastPrice/priceAtCall` (stale peak) = **WARN**. Skip entries with `priceAtCall` null/0.

**C5. Schema shape + C5b bounds.** Required fields typed correctly, `alertChannelId` non-empty, `postedAt` not in the future, `lastChecked` advancing on healthy active tokens — plus every §3 bound. Robinhood entries additionally: no bonding/graduation fields set, no `rugScan` (Solana-only service), no `devWallet`-derived deployer stats.

**C-REG. Named regression tripwires — one per historical bug, permanent:** REG-1 repost OG reset (covered by C1, named for reporting); REG-2 lowercase Solana mint (C3); REG-3 pool/pair address tracked as token (a Robinhood entry whose bare address returns pairs only as a PAIR address, checked lazily in Layer 2); REG-4 new bare `0x` key (C3 frozen-set diff); REG-5 legacy row resurrected (`lastChecked` advanced on a frozen-set key); REG-6 duplicate 📡 embed for one key (needs Layer-2 channel read — defer); REG-7 mid-cycle save wipe (C2). Alert titles use the REG name so history is legible: "REG-2 · lowercase mint regression."

---

## 5. Layer 2: spot checks (sampled, API-verified, Warden's own rate budget ≤ 1 req/s)

**C6. Price truth sample.** Every 10 min: 30 random active tokens per chain era with pairs (1 batch request each via the same DexScreener batch endpoint shape the bot uses). **Default comparison is coarse on purpose:** direction + order of magnitude, not a percent band — thin Uniswap v3 pairs and fresh pumps will blow any tight tolerance and train you to ignore Warden. Escalation requires ALL of: `lastChecked` fresh (< 2 poll intervals), disagreement beyond 10× or sign-of-move contradiction, AND persistence across **2+ consecutive Warden passes** on the same token. Then **CRITICAL** ("poller is lying about prices"). Single-pass disagreements are recorded, never alerted.

**C7. Canary tokens.** Bot permanently tracks one deep-liquidity Solana pair and (post-Robinhood-launch) one deep-liquidity Robinhood pair, `canary: true`, alerts suppressed by the bot. Warden asserts each canary's `lastChecked` advances every cycle and its price tracks reality loosely. Canary stale while `/warden/status` looks healthy = the pipeline is wedged in a way heartbeats can't see = **CRITICAL**. One canary per chain also proves each chain's batch path independently.

**C8. Summary/recap audit — DEFERRED.** Independent recompute of daily summary + weekly recap rankings and diff against posted output. Do not build until the v3 recap format has been stable for 2+ weeks — auditing a moving target produces diff noise, and diff noise gets Warden muted. When built: main bot includes the last posted summary payload in `/warden/status` (`lastSummaryPayload`) so Warden diffs data against data, not against parsed Discord messages.

---

## 6. Layer 3: liveness & ops (every status pull)

**C9. Heartbeat.** `/warden/status` unreachable 3 consecutive minutes, OR `lastCycleAt` older than 3× poll interval = **CRITICAL** ("bot down or poll loop stuck"). The check a same-process design fundamentally cannot do.

**C10. Performance regression.** `lastCycleMs > 120s` (post-batch, cycles are seconds — 2 minutes means something broke), `rate429Streak > 3`, or `scheduledSol/scheduledRh` deviating >30% from Warden's rolling 24h median = **WARN**, escalate to CRITICAL after 3 consecutive failing checks.

**C11. Alert-volume anomaly + deploy-window logic.** Warden keeps a rolling 7-day baseline of `alertsSentToday`. Zero alerts by 20:00 UTC on a normal day = WARN (pipeline silently dead). Volume > 4× baseline = WARN (spam regression) — **except inside a deploy window.** Deploy detection is free: `gitSha` in `/warden/status` changed between pulls = deploy event. Open a 10-minute window; inside it, alert spikes downgrade to WARN-with-context ("spike within deploy window of `abc123` — likely replay; verify COMEBACK_SILENCE_CYCLES") and every other alert raised in the window carries the sha. This turns the redeploy-replay scar tissue (the 427-token bootstrap incident) into a check that knows a deploy burp from a real regression.

**Deploy correlation everywhere:** every alert embed footer = `sha abc123 · snapshot 14:32:07Z`. "C4 started failing at `abc123`" ends the which-PR-broke-it debate before it starts, and makes phased rollouts self-verifying: merge, watch Warden stay green, proceed.

---

## 7. Alert engine

**Severity split.** CRITICAL pings `<@OWNER_ID>` immediately: C1/REG-1, C2, C3 regressions/REG-4/REG-5, C6 confirmed price lying, C9, escalated C10. Everything else accumulates into **one daily digest embed** — never individual WARN pings. Every alert: check/REG id, key(s), before→after, sha footer. Never include position amounts, user IDs beyond the key context, or subscription data in embeds.

**Dedupe + cooldown.** `checkId:key` alerts once, then cooldown (CRITICAL 6h "still broken" reminder, WARN 24h into digest only). Implementation as v1 sketch, unchanged, plus: cooldown map persists to Warden's disk so Warden's own restarts don't replay alerts.

**Warden audits itself.** Daily "✅ Warden alive — N snapshots (M changed), 0 criticals, sha `abc123`" post. Absence of that message IS the alert that Warden died. Optional: free external pinger on Warden's `/health`.

---

## 8. Snapshots, forensics, restore

Retention: last 48 changed snapshots rolling + 1/day for 30 days, on Warden's own small volume. Each stored with `{ hash, pulledAt, gitSha }`. This is forensic history ("field X changed between 14:32 and 14:37, sha `abc123` was live") and an off-volume disaster copy of every OG call.

Restore is **human-only**: `node warden/scripts/restore-preview.mjs <snapshotId>` prints exactly what would change (adds/removes/field diffs) and writes a restore file to a staging path — a human copies it into place via the main bot's existing backup tooling. Warden has no write path to the bot; the preview script's output lands only in Warden's own storage. No flag, no env var, no "just this once" auto-restore.

---

## 9. `/audit` on the main bot — build early, it's nearly free

Slash command running Layer-1 checks (C1 needs no shadow copy in-process — it degrades to schema/key/bounds checks C3/C4/C5, which are pure functions over the live DB) and replying with a green/red table, ephemeral. Ship it in the same PR as the status endpoints: it reuses the exact check functions from `warden/checks/` (same repo pays off again), costs nothing, and answers "is the DB sane RIGHT NOW?" mid-incident without waiting for a Warden pass.

---

## 10. Build order (revised per review)

| Phase | Work | Gate to next phase |
|-------|------|--------------------|
| 1 | Path-routed endpoints on the existing HTTP server + `cycleStats` in poller + `warden/` skeleton + webhook + **C9** | Heartbeat alert fires when you stop the bot on purpose; 401 without token; Helius route unaffected |
| 2 | Snapshot pull w/ ETag + shadow store + **C1 + C2** (incl. repair-twin and archival-move exceptions) | Manually flip a `postedAt` in a test copy → C1 fires with correct diff; delete 20% of a test snapshot → C2 fires |
| 3 | **C3 (three key eras, frozen legacy set) + C4 + C5/C5b bounds** + daily digest + `/audit` command | One week green on prod with < 3 WARNs/day — alert-volume proof before adding more checks |
| 4 | **C6 (coarse default) + C7 canaries (per chain) + C10 + C11 w/ deploy windows** + sha footers | Deliberate test: kill poll loop → C7+C9 both fire; deploy a no-op commit → deploy window logged, no spike alert |
| 5 | C-REG named tripwires not already covered + retention/restore-preview + external pinger | — |
| later | C8 summary/recap audit (after recap format stable 2+ wks) + synthetic Discord probe | — |

Phases 1–3 ≈ 2–3 days and would have caught essentially every historical incident this bot has had. Runtime cost: one small Railway service, no main-bot perf impact (endpoints serve from the same atomic `loadDB` read path), ~2 batch requests per 10 minutes of Layer-2 budget.

---

## 11. Acceptance tests

| # | Test | Expected |
|---|------|----------|
| 1 | `GET /warden/status` without token / with token | 401 / 200 with cycleStats incl. gitSha |
| 2 | `WARDEN_TOKEN` unset | `/warden/*` routes 401 always (fail closed); bot boots normally |
| 3 | Two snapshot pulls, no DB change between | Second returns 304, Warden runs no checks |
| 4 | Mutate `postedAt` on one entry (test env) | C1/REG-1 CRITICAL, correct key, before→after, sha footer |
| 5 | Simulate mint-case repair (entry moves lowercase key → mixed-case twin, OG identical) | NO C1, NO C2 — repair-twin exception holds |
| 6 | Entry moves tokens → archived unchanged | No alert (archival is legal movement) |
| 7 | Add a new bare `0x` key post-freeze | REG-4 CRITICAL |
| 8 | Valid `robinhood:0x…` entry | Zero alerts — the v1 `key===address` rule is confirmed dead |
| 9 | `robinhood:0xABC…` (uppercase after prefix) | C3 CRITICAL |
| 10 | `velocityWindow` grown to 40 entries | C5b WARN in daily digest, not an immediate ping |
| 11 | User re-runs `/ape` (positions mutate) | Zero alerts |
| 12 | Stop the bot 5 minutes | C9 CRITICAL within ~3 min; recovers with an all-clear note on next healthy pull |
| 13 | Deploy new sha, milestone burst in next 10 min | WARN-with-deploy-context, not raw C11 anomaly |
| 14 | Same violation persists 3 snapshots | One CRITICAL + one 6h reminder — not three pings |
| 15 | Warden restarted mid-cooldown | No alert replay (cooldown map persisted) |
| 16 | Kill poll loop but keep process alive (wedge simulation) | C7 canary-stale fires even while process responds |

---

## 12. Env & repo layout

```
warden/
├── index.js            # pull loop, scheduler
├── shadowStore.js      # snapshot retention + hashes
├── alerts.js           # webhook, severity, dedupe (persisted)
├── checks/
│   ├── ogImmutability.js   c1
│   ├── massDeletion.js     c2
│   ├── keyHygiene.js       c3 + REG-2/4/5   (imports ../../chains.js)
│   ├── milestones.js       c4
│   ├── schemaBounds.js     c5 + c5b         (shared with /audit)
│   ├── priceTruth.js       c6
│   ├── canary.js           c7
│   └── ops.js              c9/c10/c11 + deploy windows
└── scripts/restore-preview.mjs
```

| Env (main bot) | Purpose |
|----------------|---------|
| `WARDEN_TOKEN` | Bearer for `/warden/*`; routes fail closed when unset |
| `GIT_SHA` | Set by Railway build (or deploy hook) for correlation |

| Env (Warden) | Purpose |
|--------------|---------|
| `BOT_STATUS_URL` | Main bot base URL (prefer Railway private networking hostname) |
| `WARDEN_TOKEN` | Same value as main bot |
| `WARDEN_WEBHOOK_URL` | #bot-audit Discord webhook |
| `OWNER_ID` | Discord ID pinged on CRITICAL |

Do not modify from Warden's side: anything under the main bot's write paths. Warden imports only pure helpers (`chains.js`); if a check needs bot logic that isn't pure, extract the pure part into a shared module first — never re-implement it in `warden/`.