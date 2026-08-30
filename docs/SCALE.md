# Build to scale

How Take Profits grows to more Discords without another silent outage.

Hands-on setup for one new community: [`NEW_INSTANCE.md`](NEW_INSTANCE.md).  
This page is the rule set. Follow it before you copy a channel ID or reuse a token.

---

## The unit of scale

One **community** = one **failure domain**.

| Piece | One per community |
|---|---|
| Discord (or Telegram) app + token | Yes — never share `DISCORD_TOKEN` |
| Railway **project** | `TPB_<Community>` |
| Bot **service** | `Discord_<Community>` (or `Telegram_<Community>`) |
| `/data` volume | Own `tracked.json` — do not copy prod |
| DexScreener / OpenSea / X budget | Own process, own rate limiter |

Same git `main`. Flags and env decide what that instance runs. There is no second branch for “client bots.”

**Bitcernals + TP4APH** are the one exception: they already share `perpetual-clarity` / `take_profits_profit_bot`. Leave them. Do **not** put Collective, Genny, Blackjack, or any new server on that token or that volume.

---

## Why one bot in many Discords does not scale

The volume notifier is one loop in one Node process. Alerts go to `alertChannelId` on the token row. Identity is the **mint**, not `(guild, mint)`.

If two communities share a process:

- A hung poll cycle (Aug 2026) stops cards in **every** guild on that token
- First caller wins forever — their OG table and Dex budget mix
- Two Railway services with the same Discord token kick each other off the gateway

Blackjack stayed up while prod was dark because it is its own service. That is the model.

---

## What we already built so instances can multiply

Every service on `main` now runs the same guarded poll loop (`pollLoop.js`):

| Guard | What it does |
|---|---|
| Cycle timeout (8 min) | Hung `await` → `process.exit(1)` |
| Watchdog (3× poll interval) | No successful cycle → exit |
| `GET /health` | `200 ok` or `503 stale` — Railway healthcheck restarts |
| Rate-limiter acquire cap (15s) | Dex pause cannot sleep forever |
| Discord send timeout (20s) | One stuck `channel.send` cannot wedge the cycle |
| Empty-volume heartbeat | New instance with 0 tokens is not restart-looped |

Railway `restartPolicyType = ON_FAILURE` brings the instance back. The `/data` volume is unchanged.

Warden C9 is the **external** alarm. The watchdog is the **self-heal**. You want both. Do not rely on a human noticing Discord is quiet.

---

## Adding the next Discord

1. New Discord Developer app: `Take Profits — <Name>`
2. New Railway project `TPB_<Name>`, service `Discord_<Name>`, empty volume on `/data`
3. Source = `enstest1/take_profits_profit_bot` branch `main`
4. Their `DISCORD_TOKEN` / `CLIENT_ID` / `GUILD_ID` / channels only
5. Copy flags from a similar live instance (Blackjack for a client Discord; prod for a full stack)
6. Update `docs/ops-map.json` + `docs/instances.json`, then `node scripts/render-ops-map.mjs`

Never: invite the prod bot, paste their channel IDs onto `perpetual-clarity`, or clone the prod volume.

---

## What gets expensive as you add boxes

| Resource | How it scales | Watch |
|---|---|---|
| Discord gateway | 1 session per token | Fine. One process per token. |
| DexScreener | Per process, 4 rps shared | Fat volumes (prod ~4k tokens) are the risk, not guild count. Keep new volumes empty. |
| X cookies / OpenSea | Shared **secrets**, not shared process | Same API keys on each service is OK. Same Discord token is not. |
| Mint scanner RPC | Per process | 429s on prod are a prod problem. Do not turn mintscan on for every client. |
| Warden | One auditor, many `/warden/status` pulls | Each instance needs `WARDEN_TOKEN` if you want C9 on that box. |

Do not “scale” by tracking more dead tokens on one volume. Archive and inactive tiers exist so prod can stay one box for Bitcernals + TP4APH. New communities start at zero tokens.

---

## Ops checklist when something looks down in several Discords

1. Which **Railway service**? Shared prod (`take_profits_profit_bot`) vs an isolated `Discord_*`
2. `railway logs` — last `[poll] Cycle #` vs last `[detect]` / `[autotrack]`
3. If Cycle # is hours old and detect still works: poller hung. Restart that service. The watchdog should have already exited; if it did not, the deploy is old.
4. Isolated bots down at the same time is Discord/API, not this loop.

---

## Do not

- Add a second community to the prod Discord app
- Run two services on one `DISCORD_TOKEN`
- Share `/data` across communities
- Treat `railway up` from a laptop as the path to prod (git `main` is the path; see `GITHUB_PRACTICES.md`)
- Turn every flag on for a new client “to match prod”
