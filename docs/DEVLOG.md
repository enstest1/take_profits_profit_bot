# Dev log

Three lines per session — what changed, what's next, why.

---

## 2026-08-10 — mint scanner port

**Changed:** Added `mintscan/` feature folder (9 modules + tests), wired into `index.js` and `dbStore.js`, flag-gated via `MINT_SCANNER_*` env vars. Deployment profiles documented in `.env.example` (personal / TP4APH / Telegram = separate Railway services + channel IDs).

**Next:** Run locally with `MINT_SCANNER_ENABLED=true`, `MINT_SCANNER_CHANNEL_ID=1536502941924593827`, `MINT_SCANNER_DEBUG=true`; tune warm/hot/moon thresholds after first live Robinhood tick.

**Why:** Chain-radar mint cards on Robinhood L2 without touching live poller/tracker code; personal Discord first before promoting channel ID to main guild.
