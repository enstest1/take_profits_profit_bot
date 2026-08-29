# X lists → Discord channels

Posts/comments come from an **X list**. Follows come from **`/xwatch`**, isolated per Discord (personal store vs empty Take Profits store). Do not put Collective or Blackjack channels on the production bot.

| Status | Community | X list | Discord channel | Bot | Features |
|---|---|---|---|---|---|
| **LIVE (test)** | Personal | [`2091751129990541339`](https://x.com/i/lists/2091751129990541339) | `1541180128564875304` | Prod `take_profits_profit_bot` | xfeed + follow cards (`db.xRadar`) |
| Env ready, wait on token | Collective | [`2091750809780592842`](https://x.com/i/lists/2091750809780592842) | `1365097408387612782` | **New instance** — [NEW_INSTANCE.md](NEW_INSTANCE.md) appendix C | xfeed + xradar + memecoin TP + NFT TP |
| Env ready, wait on token | Blackjack | [`2093191150190399663`](https://x.com/i/lists/2093191150190399663) posts; `/xwatch` list pending | `1543083831601528862` | **New instance** — [NEW_INSTANCE.md](NEW_INSTANCE.md) appendix D | xfeed + follows in X channel; memecoin/NFT TP in `1542691157413466172` |
| **LIVE** | TP4APH trenches | [`2055706691925381501`](https://x.com/i/lists/2055706691925381501) | `1452152164699869298` | Prod `take_profits_profit_bot` | xfeed from this list; follow cards from empty `db.xRadarTp` until `/xwatch` **in tp4aph** |
| Staged — say "go live" | Newest Discord | [`2091751648930771381`](https://x.com/i/lists/2091751648930771381) | `1536498340609527922` | Prod bot, extra `XFEED_ROUTES` row | xfeed |

## Personal (now)

On `perpetual-clarity` / `take_profits_profit_bot` only:

```env
XFEED_ENABLED=true
XFEED_WATCH_RADAR_HANDLES=false
XFEED_LIST_IDS=2091751129990541339,2055706691925381501
XFEED_CHANNEL_ID=1541180128564875304
XFEED_SYNC_LIST_ID=2091751129990541339
XFEED_ROUTES=2091751129990541339:1541180128564875304,2055706691925381501:1452152164699869298
XRADAR_ENABLED=true
XRADAR_CHANNEL_ID=1541180128564875304
XRADAR_TP_CHANNEL_ID=1452152164699869298
X_COOKIES_JSON=<required>
```

`/xwatch` is guild-scoped. In Bitcernals it watches the **personal** store and syncs the **personal** X list. In tp4aph (`KB_GUILD_ID`) it watches the **empty TP** store and syncs [the TP list](https://x.com/i/lists/2055706691925381501). Personal follows (including `@BIL_818`) never post into trenches.

## TP4APH trenches (live on prod bot)

Same Railway service as Bitcernals (`perpetual-clarity` / `take_profits_profit_bot`) — **not** a second Discord bot. A second service in the same server would double-track CAs.

Trenches list [`2055706691925381501`](https://x.com/i/lists/2055706691925381501) → `#trenches` `1452152164699869298`. Personal Bitcernals route stays on.

```env
XFEED_ROUTES=2091751129990541339:1541180128564875304,2055706691925381501:1452152164699869298
XRADAR_TP_CHANNEL_ID=1452152164699869298
```

Do **not** create a third list — [2055706691925381501](https://x.com/i/lists/2055706691925381501) is the TP one. Add TP accounts with `/xwatch` **inside the Take Profits Discord**. Empty that list on X first if you want a blank member slate.

Newest Discord (`2091751648930771381` → `1536498340609527922`) is still staged — say go live to add that row.

## Collective (waiting on Discord token)

**New Discord app + `TPB_Collective` / `Discord_Collective`.** Never invite the prod bot. Channel `1365097408387612782`. Env is in [NEW_INSTANCE.md appendix C](NEW_INSTANCE.md#appendix-c--collective--memecoin-tp--nft-tp--x).

## Blackjack (waiting on Discord token)

**New Discord app + `TPB_Blackjack` / `Discord_Blackjack`.** Never invite the prod bot. Guild `855079121822285864`. App `1542749619107405895`.

- Posts/comments + follows: `1543083831601528862` ← list [`2093191150190399663`](https://x.com/i/lists/2093191150190399663)
- Memecoin TP + NFT TP: `1542691157413466172` (paste CAs and OpenSea links here)
- `/xwatch` adds: **not** the curated list (`XFEED_SYNC_LIST_ID=none`). Create a second empty list on X and send the URL.

Env is in [NEW_INSTANCE.md appendix D](NEW_INSTANCE.md#appendix-d--blackjack--memecoin-tp-50x--nft-tp--x). Inventory: [`instances.json`](instances.json).
