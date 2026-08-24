# X lists → Discord channels

Posts/comments come from an **X list**. Follows come from **`/xwatch`** (personal / TP bots only). Do not put Collective channels on the production bot.

| Status | Community | X list | Discord channel | Bot | Features |
|---|---|---|---|---|---|
| **LIVE (test)** | Personal | [`2091751129990541339`](https://x.com/i/lists/2091751129990541339) | `1541180128564875304` | Prod `take_profits_profit_bot` | xfeed + xradar (`/xwatch` syncs onto this list) |
| Ready, wait for creds | Collective | [`2091750809780592842`](https://x.com/i/lists/2091750809780592842) | `1317657485691191376` | **New instance** — [NEW_INSTANCE.md](NEW_INSTANCE.md) appendix C | **xfeed only** (no follow radar) |
| Staged — say "go live" | TP4APH trenches | [`2055706691925381501`](https://x.com/i/lists/2055706691925381501) | `1452152164699869298` | Prod bot, extra `XFEED_ROUTES` row | xfeed (and existing TP features) |
| Staged — say "go live" | Newest Discord | [`2091751648930771381`](https://x.com/i/lists/2091751648930771381) | `1536498340609527922` | Prod bot, extra `XFEED_ROUTES` row | xfeed |

## Personal (now)

On `perpetual-clarity` / `take_profits_profit_bot` only:

```env
XFEED_ENABLED=true
XFEED_WATCH_RADAR_HANDLES=false
XFEED_LIST_IDS=2091751129990541339
XFEED_CHANNEL_ID=1541180128564875304
XFEED_SYNC_LIST_ID=2091751129990541339
XFEED_ROUTES=2091751129990541339:1541180128564875304
XRADAR_ENABLED=true
XRADAR_CHANNEL_ID=1541180128564875304
X_COOKIES_JSON=<required>
```

`/xwatch add` records the handle for follow cards **and** adds them to the personal X list so posts/comments show up without a second manual add.

## TP4APH trenches + newest Discord (go-live later, same prod bot)

Do **not** set this until cards look right in personal. Then replace `XFEED_ROUTES` with all three prod-bot destinations (do not drop personal):

```env
XFEED_ROUTES=2091751129990541339:1541180128564875304,2055706691925381501:1452152164699869298,2091751648930771381:1536498340609527922
```

`/xwatch` on the prod bot still syncs to the **personal** list (`XFEED_SYNC_LIST_ID`). TP and newest lists stay curated on X (or we add per-guild sync later).

## Collective (go-live when bot creds arrive)

**New Discord app + new Railway project.** Never invite the prod bot. Env is in [NEW_INSTANCE.md appendix C](NEW_INSTANCE.md#appendix-c--collective--x-list-feed-only).
