# Fib Retracement Tracker — Integration Guide

This adds Fibonacci retracement tracking to the Take Profits bot:

- **Alert ladder (per cycle):** golden-zone entry (text) → 0.382 break (text) → **0.236 entry touch (instant on the wick, WITH a rendered chart PNG showing the fib pull)** → entry held → reclaim of the high → TP1 (1.618 ext) → TP2 (re-pull off the entry). Invalidation alert if a 1m close breaks the swing low.
- **Two ways in:** rides the existing poller for tracked tokens (opt-in via `AUTO_FIB_TRACKING`), plus an independent `/fibtrack` watchlist with its own 15s loop for anything else.
- **Candles:** GeckoTerminal public API (keyless). Charts: rendered server-side with `@napi-rs/canvas`, Rick-style — no screenshots.
- Everything is **new files** except **13 tiny, anchored edits** across 5 existing files. Nothing else in the bot changes.

---

## RULES FOR THE EDITING AGENT (Cursor: read this first)

1. **Copy the new files exactly as provided. Do not reformat, rename, "improve", or add imports to them.**
2. For existing files, apply **only** the FIND → REPLACE edits below. Every FIND block appears **exactly once** in its file (verified against the current repo). Match it byte-for-byte, including leading spaces (2-space indent, single quotes).
3. If any FIND block is not found verbatim, **STOP and report it** — do not approximate or apply a "similar" change.
4. Make **no other changes** to any file. Do not run formatters. Do not touch `warden/`.

---

## STEP 1 — Copy in the new files (no edits needed)

Place these at the repo root, preserving paths:

```
fib/config.js
fib/engine.js
fib/swingDetector.js
fib/minuteBars.js
fib/geckoTerminal.js
fib/store.js
fib/resolve.js
fib/chartRender.js
fib/embeds.js
fib/evaluate.js
fib/watchLoop.js
fibCommands.js
fib/tests/engine.test.mjs
fib/tests/swingDetector.test.mjs
fib/tests/minuteBars.test.mjs
scripts/fib-simulate.mjs
```

(`sample-chart.png` in this folder is a reference render only — do not commit it.)

---

## STEP 2 — `package.json` (2 edits)

**Edit 2a — add the canvas dependency.**

FIND:
```json
  "dependencies": {
    "discord.js": "^14.16.3",
```
REPLACE WITH:
```json
  "dependencies": {
    "@napi-rs/canvas": "^1.0.0",
    "discord.js": "^14.16.3",
```

**Edit 2b — add the fib scripts.**

FIND:
```json
    "tp:sample": "node scripts/send-tp-sample-embeds.mjs"
  },
```
REPLACE WITH:
```json
    "tp:sample": "node scripts/send-tp-sample-embeds.mjs",
    "test:fib": "node --test 'fib/tests/*.test.mjs'",
    "fib:simulate": "node scripts/fib-simulate.mjs"
  },
```

Then run `npm install` (pulls a prebuilt canvas binary — no system packages needed).

---

## STEP 3 — `dbStore.js` (1 edit)

Registers the `fibWatch` collection in the schema.

FIND:
```js
  if (!db.xAccounts) db.xAccounts = {};
```
REPLACE WITH:
```js
  if (!db.xAccounts) db.xAccounts = {};
  if (!db.fibWatch) db.fibWatch = {};
```

---

## STEP 4 — `channelAlert.js` (4 edits)

Adds an optional `files` parameter so the entry alert can attach the chart PNG. Backward compatible — every existing caller is untouched.

**Edit 4a.** FIND:
```js
export async function sendChannelAlert(client, channelId, embed, label = 'alert') {
```
REPLACE WITH:
```js
export async function sendChannelAlert(client, channelId, embed, label = 'alert', files = null) {
```

**Edit 4b.** FIND:
```js
    await channel.send({ embeds: [embed] });
```
REPLACE WITH:
```js
    await channel.send(files && files.length ? { embeds: [embed], files } : { embeds: [embed] });
```

**Edit 4c.** FIND:
```js
export async function sendTokenAlert(client, db, mint, embed, alertKind, label = 'alert') {
```
REPLACE WITH:
```js
export async function sendTokenAlert(client, db, mint, embed, alertKind, label = 'alert', files = null) {
```

**Edit 4d.** FIND:
```js
  const sent = entry?.alertChannelId
    ? await sendChannelAlert(client, entry.alertChannelId, embed, label)
    : false;
```
REPLACE WITH:
```js
  const sent = entry?.alertChannelId
    ? await sendChannelAlert(client, entry.alertChannelId, embed, label, files)
    : false;
```

---

## STEP 5 — `poller.js` (2 edits)

**Edit 5a — import.** FIND:
```js
import { evaluateRetest, maybeResetRetestOnAth } from './signals/retest.js';
```
REPLACE WITH:
```js
import { evaluateRetest, maybeResetRetestOnAth } from './signals/retest.js';
import { evaluateFib } from './fib/evaluate.js';
```

**Edit 5b — hook into `processTokenWithLive`.** The fib evaluator runs for every token with live data, in its own try/catch, OUTSIDE the `currentMult` block (fib does not need a call price — it works from market structure alone).

FIND:
```js
      await evaluatePersonalPositions(client, db, address, entry, live, currentMult);
    } catch (e) {
      console.error('[signals] ' + address + ':', e.message);
    }
  }
}
```
REPLACE WITH:
```js
      await evaluatePersonalPositions(client, db, address, entry, live, currentMult);
    } catch (e) {
      console.error('[signals] ' + address + ':', e.message);
    }
  }

  try {
    await evaluateFib(client, db, address, entry, live);
  } catch (e) {
    console.error('[fib] ' + address + ':', e.message);
  }
}
```

---

## STEP 6 — `index.js` (4 edits)

**Edit 6a — imports.** FIND:
```js
import { initAlertGate, shouldSilenceAlerts } from './alertGate.js';
```
REPLACE WITH:
```js
import { initAlertGate, shouldSilenceAlerts } from './alertGate.js';
import { fibtrackCommand, handleFibtrack } from './fibCommands.js';
import { startFibWatchLoop } from './fib/watchLoop.js';
```

**Edit 6b — register the slash command.** FIND:
```js
const commands = [
```
REPLACE WITH:
```js
const commands = [
  fibtrackCommand,
```

**Edit 6c — route the interaction.** FIND:
```js
    if (interaction.commandName === 'audit') return handleAudit(interaction);
```
REPLACE WITH:
```js
    if (interaction.commandName === 'audit') return handleAudit(interaction);
    if (interaction.commandName === 'fibtrack') return handleFibtrack(interaction, client);
```

**Edit 6d — start the watch loop on ready.** FIND:
```js
  void runTokenPollLoop(client);
  startHttpServer(client, () => ensureDBSchema(loadDB()));
```
REPLACE WITH:
```js
  void runTokenPollLoop(client);
  startFibWatchLoop(client);
  startHttpServer(client, () => ensureDBSchema(loadDB()));
```

---

## STEP 7 — `.env.example` (append at the end)

```bash
# ── Fibonacci retracement tracker (fib/config.js documents every knob) ──
# FIB_TRACKING_ENABLED=true       # master switch
# AUTO_FIB_TRACKING=false         # auto-fib every tracked token once it clears the floor
# FIB_MIN_MCAP=300000             # eligibility floor (auto waits; /fibtrack add rejects)
# FIB_DEFAULT_TIMEFRAME=1h        # anchor timeframe (standard mode)
# FIB_FAST_TIMEFRAME=5m           # anchor timeframe (fast mode, launch fallback on)
# FIB_ALERT_LEVELS=0.382,0.236    # lowest ratio = ENTRY (chart alert)
# FIB_MIN_IMPULSE_PCT=1.0         # low→high must be ≥ 2x to anchor
# FIB_REANCHOR_THRESHOLD=0.25     # post-alert high break > 25% ⇒ new cycle
# FIB_CONFIRM_CLOSES=2            # standard-mode confirmation (consecutive 1m closes)
# FIB_CHART_ENABLED=true          # kill-switch: false ⇒ text-only entry alerts
# FIB_COMMAND_ALLOWED_ROLES=      # role IDs allowed to mutate; empty = everyone
# FIB_GT_NETWORK_ROBINHOOD=robinhood  # GeckoTerminal slug override if needed
```

No new secrets. GeckoTerminal is keyless.

---

## STEP 8 — Verify (in order)

1. `npm install`
2. `node --check poller.js && node --check index.js && node --check channelAlert.js && node --check dbStore.js && node --check fibCommands.js` — all silent.
3. `npm run test:fib` → **25 tests, 25 pass** (engine crossings/sweeps/re-anchoring, detector, minute bars).
4. `npm run warden:test` → still green (fib adds no top-level fields Warden guards; state nests under `tokens[key].fib` + the new `fibWatch` collection).
5. Live dry run (needs network):
   `npm run fib:simulate -- 0x45242320dbb855eea8fd36804c6487e10e97fcf9 robinhood 1h`
   (TENDIES). Expect: token resolves, pool + candles fetched, an impulse in the neighborhood of low ≈ $98K → high ≈ $8M (it moves with the market), the level ladder, TP1/TP2, a replay of which alerts would have fired, and `fib-sim-TENDIES.png` written. If it prints a GeckoTerminal network hint, set `FIB_GT_NETWORK_ROBINHOOD` to the slug it suggests.
6. Deploy. Boot log should show `[fib/watch] loop started (15000ms)` and the usual command-registration line.
7. In Discord: `/fibtrack add ca:<address>` in the channel where you want alerts → confirmation embed → `/fibtrack status ca:<address>` shows `detecting` then `armed` with anchors. `/fibtrack simulate` posts the dry-run report + chart without tracking anything.

## Deploy notes

- **Charts on Railway:** `@napi-rs/canvas` ships prebuilt Linux binaries (no apt packages). If label text ever renders blank (missing system fonts), alerts still work — set `FIB_CHART_ENABLED=false` for text-only entry alerts, zero other impact. The renderer also degrades to text automatically if canvas fails to load.
- **API budget:** GeckoTerminal free tier ≈ 30 req/min. Detection costs 1–2 calls per token per attempt (retries every 10 min until an impulse confirms), the entry chart 0–1 calls (10-min cache). The 15s watch loop uses the existing DexScreener batch endpoint — one call per chain per tick, shared rate limiter.
- **Persistence & Warden:** all fib state lives inside `tracked.json` (`tokens[key].fib` and `fibWatch`), survives restarts (alerts are once-per-cycle and resume from `lastValue`), and `/fibtrack` commands never mutate `db.tokens` mid-poll — they steer the poller via small flags on `fibWatch` (see the header comment in `fibCommands.js`).

## Command cheat-sheet

`/fibtrack add ca [chain] [timeframe] [mode]` · `remove ca` · `status ca` · `list` · `recalculate ca [timeframe] [mode]` · `pause ca` · `resume ca` · `simulate ca [timeframe]`

Modes: **standard** = downward crossings need 2 consecutive 1m closes (built from poll samples, zero API cost); **fast** = instant on touch + launch fallback for fresh tokens. **Entry touch and all upward alerts (reclaim/TP1/TP2) are instant in both modes.**

## Rollback

Set `FIB_TRACKING_ENABLED=false` (kills evaluation, watch loop, and alerts without a deploy of code changes), or revert the 13 edits above — the new files are inert once nothing imports them.
