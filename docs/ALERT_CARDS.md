# Alert cards (trencher templates)

Discord milestone and auto-track cards for channel **1452152164699869298** (and any future Discord servers). Telegram will reuse the same templates in a later phase.

## Enable / disable

| Variable | Default | Effect |
|----------|---------|--------|
| `ALERT_CARDS_ENABLED` | `true` | `false` → legacy cards everywhere |
| `ALERT_CARDS_CHANNEL_ID` | `1452152164699869298` | Trencher cards only post to this channel (unless `ALERT_CARDS_ALL_CHANNELS=true`) |

**Turn on:** set `ALERT_CARDS_ENABLED=true` and redeploy.

**Turn off:** `npm run alert-cards:revert` **or** leave new code but set `ALERT_CARDS_ENABLED=false`.

## Layouts

### Milestone / +75% (v26)

```
[chain logo] Robinhood · CASHBIRD · 5x 🚀
Cash Delivery Bird · 158K
💎 26K → 158K · 💧 31K
1h 673K +58.4% · 30m 412K +31.2% · 15m 89K +12.1%
DEX · BasedBot · FOMO

💰💰💰 Take Profit 💰💰💰
[900×400 chart]
📞 trench_king · 4h 18m
[thumbnail]
```

- No CA on card
- Links before Take Profit banner
- Chart: `fib/chartRender.renderPriceChart()` via GeckoTerminal 1h OHLCV

### Auto-track (v29)

```
[Robinhood logo] Robinhood · Auto-Tracking 📡
**Fomo Inu**  — **THEO**
  ☎️ **rolzs** · ⚡ 1h old
  💎 `711K` · ⌚ 10:08pm
[thumbnail]
```

## Link templates

Built in `alertCards/links.js`:

| Service | URL pattern |
|---------|-------------|
| DEX | `https://dexscreener.com/{dexScreenerSlug}/{address}` |
| BasedBot | `https://basedbot.app/token/{chainId}/{address}` |
| FOMO | `https://fomo.family/tokens/{chainId}/{address}` |

Examples (Robinhood / CASHBIRD):

- DEX: https://dexscreener.com/robinhood/0x91554e79a17c18990034d1ec3c4f492086d7b2cc
- BasedBot: https://basedbot.app/token/robinhood/0x91554e79a17c18990034d1ec3c4f492086d7b2cc
- FOMO: https://fomo.family/tokens/robinhood/0x020bfc650a365f8bb26819deaabf3e21291018b4

## Volume windows (1h / 30m / 15m)

DexScreener pair API exposes **`volume` / `priceChange` for `m5`, `h1`, `h6`, `h24` only** — not native 30m or 15m.

Implementation (`alertCards/windows.js`):

1. **Preferred:** when a milestone chart is built, fetch **5m** OHLCV from GeckoTerminal and aggregate:
   - 1h = last 12 bars
   - 30m = last 6 bars
   - 15m = last 3 bars
2. **Fallback** (poll live object, no candles): DexScreener proxies on `dexPair.js` / `dexBatch.js`:
   - 1h → `h1`
   - 30m → `m5 × 6` (vol) / `m5 × 6` (pct), else `h1 / 2`
   - 15m → `m5 × 3` (vol) / `m5 × 3` (pct), else `h1 / 4`

Live poll path attaches `volumeWindows` on every DexScreener refresh.

## Code map

| Path | Role |
|------|------|
| `alertCards/index.js` | Flag + exports |
| `alertCards/milestone.js` | +75% / tier embeds |
| `alertCards/autotrack.js` | Auto-track embed |
| `alertCards/windows.js` | Window extraction |
| `alertCards/chart.js` | Chart PNG attachment |
| `poller.js` | Branches milestone sends on `ALERT_CARDS_ENABLED` |
| `autotrackHelpers.js` | Branches auto-track on same flag |
| `backups/pre-alert-cards/` | Frozen origin/main copies |
| `scripts/revert-alert-cards.mjs` | One-command restore |

## Preview without poller

```bash
npm run trencher:chart   # optional — regenerate mock chart PNG
npm run trencher:mock      # posts to TRENCHER_MOCK_CHANNEL_ID (default test channel)
```

## Revert (production emergency)

See [backups/pre-alert-cards/RESTORE.md](../backups/pre-alert-cards/RESTORE.md).

```bash
npm run alert-cards:revert
```

Then `ALERT_CARDS_ENABLED=false` and redeploy.
