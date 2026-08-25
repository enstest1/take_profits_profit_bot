# NFT Take Profits (`nfttp/`)

Same product as token Take Profits — **OG call lock → +75% → 1x–20x trencher cards** — with **OpenSea floor** instead of DexScreener price.

Mint-scanner (`mintscan/`) is a different product: it watches *mint velocity*. This module watches *floor multiple vs the first call*.

## Why OpenSea

You already have `OPENSEA_API_KEY` (mintscan / `/early`). That key covers:

| Job | Endpoint |
|---|---|
| Collection identity | `GET /api/v2/collections/{slug}` |
| Live floor + 24h/7d volume | `GET /api/v2/collections/{slug}/stats` |
| 1h floor chart | `GET /api/v2/collections/{slug}/floor_prices?timeframe=one_hour` |
| `0x` → slug | `GET /api/v2/chain/{chain}/contract/{address}` |

No extra vendor. Floors are native (ETH/SOL), not USD, so ETH/USD noise cannot fake a 2×.

## Card mapping

| Token TP | NFT TP |
|---|---|
| CA in chat | OpenSea collection URL (or `/nfttrack`) |
| `priceAtCall` | `floorAtCall` |
| MCap | floor × supply |
| 💧 liquidity | unique owners |
| DEX / GMGN / BasedBot / FOMO | OpenSea / Blur / Magic Eden |
| Gecko 1h chart | OpenSea floor history |

Same skeleton:

```
[chain] Ethereum · PUDGY · 5x 🚀
Pudgy Penguins · `0.84 ETH`
💎 `0.42` → `0.84 ETH` · 💧 `1.2K`
1h … · 30m … · 15m …
OpenSea · Blur · Magic Eden

💰💰💰 Take Profit 💰💰💰
[900×400 floor chart]
📞 caller · 4h 18m
```

Ladder is identical to tokens: **+75%** in `[1.75×, 2×)`, then **1x card at 2× floor** … **20x card at 21×**. Trench reset (3 polls below 0.99×) still applies.

## Enable (dark on `main` until you flip it)

TP4APH home is **#nft-land** (`1358929055604408465`). Auto-track and milestone cards stay in that channel.

```env
NFT_TP_ENABLED=true
OPENSEA_API_KEY=...                 # same key as mintscan
NFT_TP_CHANNEL_IDS=1358929055604408465   # #nft-land (code default if unset)
# NFT_TP_INTERVAL_SEC=120
# NFT_TP_MAX_TIER=20
# NFT_TP_CHAINS=ethereum,base,robinhood
# NFT_TP_TRACK_CONTRACTS=false      # keep off in mixed token chats
```

**Do not** turn `NFT_TP_TRACK_CONTRACTS` on in a token trench — bare `0x` stays DexScreener auto-track. Collection **URLs** never collide with CAs.

Dedicated NFT Discord (own token, own `/data`, own channels) is the same pattern as [NEW_INSTANCE.md](NEW_INSTANCE.md): new `TPB_<Community>` service, `NFT_TP_ENABLED=true`. Token auto-track still runs on that process unless you keep CAs out of those channels.

## Commands

| Command | |
|---|---|
| *(auto)* paste `opensea.io/collection/...` | 📡 auto-track, OG floor locked |
| `/nfttrack <url\|slug\|0x>` | manual track |
| `/nftcalls` | cached multiples vs call |
| `/nftremove <slug>` | untrack |

Reposts are silent. First caller wins forever.

## Persistence

`db.nftTp.collections[slug]` inside `/data/tracked.json`, written via `patchNftTp` so a token poll merge cannot clobber an OG floor.
