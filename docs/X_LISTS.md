# X lists → Discord channels

Posts/comments come from an **X list**. Follows come from **`/xwatch`** (personal / TP bots only). Do not put Collective channels on the production bot.

| Status | Community | X list | Discord channel | Bot | Features |
|---|---|---|---|---|---|
| **LIVE (test)** | Personal | [`2091751129990541339`](https://x.com/i/lists/2091751129990541339) | `1541180128564875304` | Prod `take_profits_profit_bot` | xfeed (existing list); follow cards (shared radar) |
| Env ready, wait on token | Collective | [`2091750809780592842`](https://x.com/i/lists/2091750809780592842) | `1365097408387612782` | **New instance** — [NEW_INSTANCE.md](NEW_INSTANCE.md) appendix C | xfeed + xradar + memecoin TP + NFT TP |
| **LIVE** | TP4APH trenches | [`2055706691925381501`](https://x.com/i/lists/2055706691925381501) | `1452152164699869298` | Prod `take_profits_profit_bot` | xfeed + follow cards; `/xwatch` syncs onto **this** list |
| Staged — say "go live" | Newest Discord | [`2091751648930771381`](https://x.com/i/lists/2091751648930771381) | `1536498340609527922` | Prod bot, extra `XFEED_ROUTES` row | xfeed |

## Personal (now)

On `perpetual-clarity` / `take_profits_profit_bot` only:

```env
XFEED_ENABLED=true
XFEED_WATCH_RADAR_HANDLES=false
XFEED_LIST_IDS=2091751129990541339,2055706691925381501
XFEED_CHANNEL_ID=1541180128564875304
XFEED_SYNC_LIST_ID=2055706691925381501
XFEED_ROUTES=2091751129990541339:1541180128564875304,2055706691925381501:1452152164699869298
XRADAR_ENABLED=true
XRADAR_CHANNEL_ID=1541180128564875304
XRADAR_CHANNEL_IDS=1541180128564875304,1452152164699869298
X_COOKIES_JSON=<required>
```

`/xwatch add` records the handle for follow cards **and** adds them to the **TP trenches** X list (`XFEED_SYNC_LIST_ID=2055706691925381501`) so posts/comments land in Take Profits. The Bitcernals list is not auto-cloned — empty the trenches list on X if you want a blank member slate, then add via `/xwatch`. Follow cards fan out to Bitcernals **and** trenches (`XRADAR_CHANNEL_IDS`).

## TP4APH trenches (live on prod bot)

Same Railway service as Bitcernals (`perpetual-clarity` / `take_profits_profit_bot`) — **not** a second Discord bot. A second service in the same server would double-track CAs.

Trenches list [`2055706691925381501`](https://x.com/i/lists/2055706691925381501) → `#trenches` `1452152164699869298`. Personal Bitcernals route stays on.

```env
XFEED_ROUTES=2091751129990541339:1541180128564875304,2055706691925381501:1452152164699869298
```

`/xwatch` on this bot syncs to the **trenches** list (`XFEED_SYNC_LIST_ID`). Do **not** create a third list — [2055706691925381501](https://x.com/i/lists/2055706691925381501) is the TP one. Bitcernals keeps its own list for posts. Follow cards go to both channels.

Newest Discord (`2091751648930771381` → `1536498340609527922`) is still staged — say go live to add that row.

## Collective (waiting on Discord token)

**New Discord app + `TPB_Collective` / `Discord_Collective`.** Never invite the prod bot. Channel `1365097408387612782`. Env is in [NEW_INSTANCE.md appendix C](NEW_INSTANCE.md#appendix-c--collective--memecoin-tp--nft-tp--x).
