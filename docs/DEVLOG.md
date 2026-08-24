# Dev log

Three lines per session — what changed, what's next, why.

---

## 2026-08-23 — personal X list live; Collective / TP staged

**Changed:** xfeed routes are `listId:channelId`. Personal list `2091751129990541339` → `1541180128564875304`. Collective is documented as a new bot (list-only). TP trenches and newest Discord are staged, not enabled.

**Next:** `X_COOKIES_JSON` + deploy personal. Collective waits on bot creds. TP trenches (`2055706691925381501` → `1452152164699869298`) and newest Discord (`2091751648930771381` → `1536498340609527922`) wait on "go live".

**Why:** Each community has its own X list and channel; Collective must not share the production bot.

---

## 2026-08-23 — /xwatch also updates the X posts list

**Changed:** `/xwatch add` now adds the handle to the cookie account's X list (`XFEED_LIST_IDS` / `XFEED_SYNC_LIST_ID`) so posts/comments don't need a second manual add. `/xwatch remove` drops them off the list. Backfill: `npm run xwatch:sync-list`.

**Next:** Set `XFEED_LIST_IDS` to the list the X cookies own, then `/xwatch add` (or run the backfill for accounts already watched).

**Why:** Follows and posts used two inputs for the same people; Discord users should add a handle once.

---

## 2026-08-23 — X radar + X feed live in personal Discord

**Changed:** Wired the follow-radar monitor (`xradar/` poll + `/xwatch`) and pointed `xfeed/` at the same watched handles for posts/replies. Both default to channel `1541180128564875304`.

**Next:** Flip `XRADAR_ENABLED=true` and `XFEED_ENABLED=true` on the Discord Railway service (needs `X_COOKIES_JSON`), `/xwatch add` a few handles, confirm first-run baselines then live cards.

**Why:** The client layer existed; the follow monitor never landed, and xfeed only watched lists — so neither scanner could actually run against accounts we add.

---

## 2026-08-10 — mint scanner port

**Changed:** Added `mintscan/` feature folder (9 modules + tests), wired into `index.js` and `dbStore.js`, flag-gated via `MINT_SCANNER_*` env vars. Deployment profiles documented in `.env.example` (personal / TP4APH / Telegram = separate Railway services + channel IDs).

**Next:** Run locally with `MINT_SCANNER_ENABLED=true`, `MINT_SCANNER_CHANNEL_ID=1536502941924593827`, `MINT_SCANNER_DEBUG=true`; tune warm/hot/moon thresholds after first live Robinhood tick.

**Why:** Chain-radar mint cards on Robinhood L2 without touching live poller/tracker code; personal Discord first before promoting channel ID to main guild.
