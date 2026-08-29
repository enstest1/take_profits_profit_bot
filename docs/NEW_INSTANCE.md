# New community instance — end-to-end setup

How to stand up Take Profits for **someone else's Discord** (and optionally Telegram) without mixing their data into production.

This is the same model we already use for Discord vs Telegram: **same git `main`, different Railway service, different bot token, different `/data` volume.**

---

## Naming system

One **community** = one Railway **project**. Platforms are **services** inside that project. The database is that service's volume (`/data/tracked.json`), not Postgres.

| Piece | Pattern | Example (this group) |
|---|---|---|
| Community slug | Title_Case, spaces → `_` | `Genny_Run` |
| Railway **project** | `TPB_<Community>` | `TPB_Genny_Run` |
| Discord **service** | `Discord_<Community>` | `Discord_Genny_Run` |
| Telegram **service** | `Telegram_<Community>` | `Telegram_Genny_Run` |
| Volume | `<service>-data`, mount `/data` | `discord_genny_run-data` |
| Discord Developer app | `Take Profits — <Community>` | `Take Profits — Genny Run` |

Do **not** put `OG`, `prod`, or random Railway adjectives (`perpetual-clarity`) on new things. The community name is the label.

### Live inventory (2026-08-23)

| Community | Platform | Railway project | Service | Notes |
|---|---|---|---|---|
| TP4APH (OG Discord) | Discord | `perpetual-clarity` | `take_profits_profit_bot` | Legacy name — do not rename |
| TP4APH | Warden | `perpetual-clarity` | `warden` | Auditor, not a community bot |
| Golden Pocket | Telegram | `TG_1_Golden_Pocket_TPB` | `Golden_Pocket_TG_Take_Profits_Bot` | Legacy name — do not rename |
| **Genny Run** | **Discord** | **`TPB_Genny_Run`** | **`Discord_Genny_Run`** | New — follow the pattern |
| Genny Run | Telegram | `TPB_Genny_Run` | `Telegram_Genny_Run` | Create later in the **same** project |
| **Collective** | **Discord** | **`TPB_Collective`** | **`Discord_Collective`** | Env pre-wired; waiting on dedicated Discord token |
| **Blackjack** | **Discord** | **`TPB_Blackjack`** | **`Discord_Blackjack`** | Env pre-wired; waiting on dedicated Discord token |

Legacy projects stay as-is so deploys and volumes do not move. New communities follow `TPB_*` / `Discord_*` / `Telegram_*`.

---

> **Do not** invite the production bot into their server, and **do not** add their channel IDs to the production Railway env. That shares one `tracked.json`, one OG-call table, and one DexScreener budget.

---

## Isolation rules (read before you start)

| Piece | Production (TP4APH) | This new instance |
|---|---|---|
| Discord application + bot token | Yours | **New** — never reuse `DISCORD_TOKEN` |
| Railway | `perpetual-clarity` | **New project** (preferred) or a clearly named new service |
| Database | `/data/tracked.json` on the prod volume | **New empty volume** at `/data` — do not copy prod tokens |
| Channel / guild IDs | TP4APH snowflakes | **Theirs only** |
| Git | `main` | Same `main` (code is shared; env is not) |

One Discord bot token can only be used by **one running process**. Two Railway services with the same token will kick each other off the gateway.

Token identity in `tracked.json` is the **mint**, not `(guild, mint)`. First caller wins forever; alerts always go to `alertChannelId`. Two communities on one DB will steal each other's OG calls.

---

## What you need from their Discord admin

Ask them to create channels **before** you configure env (or do it yourself if you have access).

Recommended layout:

| Channel | Purpose | Env var |
|---|---|---|
| `#calls` or `#trenches` | People paste CAs; auto-track + take-profit alerts land here | (no dedicated var — alerts follow the channel the CA was posted in) |
| `#bot-logs` (or reuse `#calls`) | Startup banner + daily/weekly recap | `LOG_CHANNEL_ID` and `SUMMARY_CHANNEL_ID` |
| `#general` (optional mute) | Human chat — bot should stay out | `BLOCKED_CHANNEL_IDS` **or** deny the bot View Channel |

They should also enable **Developer Mode** so IDs can be copied:

1. Discord → User Settings → Advanced → **Developer Mode** on
2. Right-click the **server name** → Copy Server ID → that is `GUILD_ID`
3. Right-click each **channel** → Copy Channel ID

You also need **Manage Server** (or they add the bot themselves with the invite URL).

---

## Part 1 — Create the Discord application and bot token

Open [Discord Developer Portal](https://discord.com/developers/applications) while logged into **your** Discord account (the bot owner).

### 1. Create the application

1. **New Application**
2. Name it for the client, e.g. `Take Profits — <group name>` (this is the app name, not the in-server nickname)
3. Agree to the ToS → Create
4. **General Information** → copy **Application ID** — this is `CLIENT_ID`

Optional: upload an icon so it is obvious this is not the TP4APH bot.

### 2. Create the bot user and copy the token

1. Left sidebar → **Bot**
2. **Reset Token** → Yes → copy the token immediately — this is `DISCORD_TOKEN`
3. Store it in a password manager. Discord shows it **once**. If you lose it, reset again and update Railway.
4. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** — required (without this the bot never sees CAs)
   - Server Members Intent — **off** (we do not use it)
   - Presence Intent — **off**
5. Save Changes

Optional but recommended for a private client bot:

- **Public Bot** → off. Then only you can add it to servers (you must be in their Discord with Manage Server). If they need to click the invite themselves, leave Public Bot on, send the URL, then you can turn it off after it is in.

### 3. Bot permissions in the Developer Portal (Installation / OAuth2)

1. **OAuth2 → URL Generator** (or **Installation** → Guild Install)
2. Scopes:
   - `bot`
   - `applications.commands` (slash commands)
3. Bot permissions — check:

   | Permission | Why |
   |---|---|
   | View Channels | Read CAs |
   | Send Messages | Auto-track + alerts |
   | Embed Links | Cards |
   | Attach Files | Fib / trencher charts |
   | Read Message History | Fetch context if needed |

4. Copy the generated URL. It looks like:

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&permissions=117760&scope=bot+applications.commands
```

`permissions=117760` is View + Send + Embed + Attach + History. Do not add Administrator.

### 4. Invite the bot

1. Open the invite URL in a browser
2. Pick **their** server (not TP4APH)
3. Confirm permissions → Authorize
4. In their server: Server Settings → Roles → drag the bot role **above** any role that should not override channel perms, and make sure the bot can see `#calls`

**Lock the bot to the right channels** (recommended):

- Server Settings → Roles → the bot's role → disable View Channel at server level if you want a deny-by-default
- Then on `#calls` (and `#bot-logs`) → Edit Channel → Permissions → allow the bot View / Send / Embed / Attach / History

If the bot can see every channel, **every CA in every channel gets auto-tracked** except IDs in `BLOCKED_CHANNEL_IDS`.

### 5. Confirm the bot is online-capable

The bot will show **offline** until Railway is running. That is expected. Token + intents + invite are enough to finish Part 1.

---

## Part 2 — Railway project, GitHub, and the database volume

The "database" is **not** Postgres. It is a JSON file:

```
/data/tracked.json
```

`dbStore.js` writes it atomically (temp file + rename). Without a volume at `/data`, Railway puts the file in the container and **every redeploy wipes tracked tokens** → catch-up alert spam.

### Path A — new Railway project (preferred)

Keeps billing, volumes, and "pause this client" separate from TP4APH.

1. [railway.app](https://railway.app) → **New Project**
2. **Deploy from GitHub repo** → `enstest1/take_profits_profit_bot` (same repo as prod)
3. Name the project something like `tpb-<client-slug>`
4. Open the generated **service** → Settings:
   - **Source** → repo `enstest1/take_profits_profit_bot`, branch **`main`**
   - Confirm the start command is `node start.mjs` (from `railway.toml`)
   - Region: **US East** (`us-east4-eqdc4a`) — matches `railway.toml` and Discord gateway
5. **Do not** copy variables from the production service

### Path B — new service inside `perpetual-clarity`

Only if you want one dashboard. Name the service `discord-<client-slug>` so it cannot be confused with prod.

1. Project → **New Service** → GitHub repo → same `main`
2. Own volume, own variables (Railway variables are per-service)
3. Remember: **a merge to `main` redeploys every service whose source is `main`**, including this one. Feature flags still default off (except alert cards — see env section).

### Mount the volume (required)

1. Service → **Settings** (or the Variables / Volumes panel) → **Volumes** → **Add Volume**
2. Mount path: **`/data`** (exactly that — `dbStore.js` looks for `/data`)
3. Leave the default size (1 GB is plenty; prod is ~0.2 GB at 1,800 tokens)
4. Redeploy after attaching if the first deploy already ran without it

Confirm in logs after boot:

```
[boot] Using data dir: /data
[inspect] no tracked.json yet at /data/tracked.json
```

If you see a path under `/app` instead of `/data`, the volume is not mounted.

### Networking / health

Railway injects `PORT`. The process serves `GET /health` → `ok`. You do not need a public domain unless you later add Helius webhooks.

Leave **Warden** off for a client instance unless you deliberately add a second Warden service pointed at *this* bot's `/warden/*` routes.

---

## Part 3 — Environment variables

Service → **Variables**. Add these **before** or immediately after the first deploy. Do not paste production channel IDs.

### Required — Discord instance

```env
# Identity (from Part 1)
DISCORD_TOKEN=<new bot token>
CLIENT_ID=<application id>
GUILD_ID=<their server id>

# Their channels (from Developer Mode copy)
LOG_CHANNEL_ID=<bot-logs or calls channel>
SUMMARY_CHANNEL_ID=<same or a recap channel>

# Isolation — never set PLATFORM=telegram on Discord
# PLATFORM  (leave unset)

# Mute list: production defaults to a TP4APH channel snowflake.
# Set none so that default cannot surprise you. Add their #general later if needed.
BLOCKED_CHANNEL_IDS=none

TZ=UTC
ENABLED_CHAINS=solana,base,ink,hype
```

`GUILD_ID` registers slash commands **on their server instantly**. If you omit it, commands go global and can take up to an hour.

### Alert cards (trencher layout)

Trencher cards are the live layout on **every** Discord channel. Leave `ALERT_CARDS_ENABLED` unset (or `true`). Do not set `false` on a client Discord service.

```env
ALERT_CARDS_ENABLED=true
```

Telegram still sets `ALERT_CARDS_ENABLED=false` explicitly (cards are Discord-first). The old EmbedBuilder path stays in the repo as reference only.

### Feature flags — start conservative

Unset = off for these (safe). Do **not** copy prod scanner/X-feed values unless the client should have them.

```env
MINT_SCANNER_ENABLED=false
XFEED_ENABLED=false
XRADAR_ENABLED=false
```

Fib tracking defaults **on**. To disable `/fibtrack` and fib alerts:

```env
FIB_TRACKING_ENABLED=false
```

First-week deploys (optional, reduces catch-up noise after you already have tokens):

```env
COMEBACK_SILENCE_CYCLES=3
```

You can leave this set; it only silences milestone alerts for N poll cycles after each process start.

### Optional API keys (research commands)

Core auto-track + DexScreener polling works **with no extra keys**. Add later if they want `/rug`, `/x`, wallet watcher, Base B20, etc.:

| Variable | Unlocks |
|---|---|
| `RUGCHECK_API_KEY` | `/rug`, `/rugdeep` |
| `HELIUS_API_KEY` | wallet history / research |
| `MORALIS_API_KEY` | wallet swap polling |
| `TWITTERAPI_KEY` | `/x` |
| `BASE_RPC_URL` | nicer Base RPC than the public endpoint |
| `ANTHROPIC_API_KEY` | research helpers that need it |

Do **not** share production `WARDEN_TOKEN`, `WEBHOOK_SECRET`, or TP4APH `MINT_SCANNER_CHANNEL_IDS`.

If you share DexScreener-unrelated paid keys across instances, watch rate limits. Never share `DISCORD_TOKEN`.

### What you must **not** set

| Variable | Why |
|---|---|
| `PLATFORM=telegram` | Would boot `telegram.js` instead of Discord |
| Production `DISCORD_TOKEN` | Gateway fight + mixed posts |
| Production channel IDs | Banner/recap/cards try to post into TP4APH |
| `MINT_SCANNER_CHANNEL_IDS` pointing at TP4APH + client | Same scanner cards in both communities |
| `DATABASE_URL` | Unused for the live token store; the store is `/data/tracked.json` |

---

## Part 4 — Deploy and confirm it is actually this instance

1. Service → **Deploy** (or push is enough if autodeploy from `main` is on)
2. Open **Deployments** → latest row → confirm:
   - Status **SUCCESS**
   - Branch `main`
   - A real `commitHash` (not a `railway up` upload with no git metadata)
3. Open **Logs** and wait for:

```
[boot] connecting to Discord...
Bot online as <bot name>#<discriminator>
[boot] Using data dir: /data
Data directory: /data
[inspect] no tracked.json yet at /data/tracked.json
Slash commands registered (guild — instant)
[startup] banner posted to channel <their LOG_CHANNEL_ID>
[http] listening on :<port> — /health
[poll] cycle ...
```

4. In their Discord, `#bot-logs` / `LOG_CHANNEL_ID` should show **Take Profit Bot — ONLINE**
5. In their server, type `/` — you should see this bot's commands (`/calls`, `/remove`, …)

If the banner failed with `Unknown Channel` or `Missing Access`, the channel ID is wrong or the bot cannot see that channel.

---

## Part 5 — Smoke test

Do this in **their** `#calls` channel, not TP4APH.

1. Paste a live Solana CA (a real mint, not a wallet)
2. Expect a 📡 auto-track embed in that same channel
3. Railway logs: `[detect] Found 1 address(es)` then auto-track save
4. `/calls` — the new token is listed
5. Paste the **same** CA again — **no** second embed (OG preserved)
6. Confirm TP4APH production did **not** get that embed and did **not** gain that token

On the volume, `tracked.json` now exists. From Railway shell (optional):

```bash
node scripts/inspect-tracked.mjs
```

---

## Part 6 — Day-2 operations

| Task | How |
|---|---|
| Ship code to them | Merge to `main` — this instance redeploys if source is `main` |
| Turn on mint scanner / X feed / cards | Set flags **on this service only**, redeploy |
| Mute `#general` | `BLOCKED_CHANNEL_IDS=<channel id>` (comma-separated if several) |
| Backup | `node scripts/backup-volume.mjs` on this service's shell (writes under `/data`) |
| Pause the client | Railway → service → Remove / stop. Prod is untouched |
| Rotate a leaked bot token | Developer Portal → Bot → Reset Token → update `DISCORD_TOKEN` → redeploy |
| They want Telegram too | **Another** service + BotFather token + volume — see appendix. Do not add a chat ID to the existing TG bot |

Code rollbacks never wipe tokens (volume is outside git). Deleting the Railway volume **does**.

---

## Appendix A — Telegram instance (same idea)

Telegram is already a separate Railway project in production. A second Telegram community is another clone, not another chat ID on `TG_1_Golden_Pocket_TPB`.

1. [BotFather](https://t.me/BotFather) → `/newbot` → copy token → `TELEGRAM_BOT_TOKEN`
2. Add the bot to their group, promote to admin (read messages)
3. Get chat ID (negative for supergroups), e.g. forward a group message to `@userinfobot` or inspect bot logs after they send a message
4. New Railway project/service, same repo `main`, volume `/data`
5. Variables:

```env
PLATFORM=telegram
TELEGRAM_BOT_TOKEN=<botfather token>
SUMMARY_CHANNEL_ID=<telegram chat id>
ALERT_CARDS_ENABLED=false
BLOCKED_CHANNEL_IDS=none
ENABLED_CHAINS=solana,base,ink,hype
TZ=UTC
```

6. **Do not** set `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, or Discord channel IDs on this service
7. `start.mjs` boots `telegram.js`. The bot auto-tracks CAs in **any Telegram chat it can read** — restrict which groups it is in

---

## Appendix B — Copy-paste checklists

### Discord client instance

- [ ] New Discord application + bot (not the TP4APH app)
- [ ] Message Content Intent on, token saved
- [ ] Bot invited to **their** server only
- [ ] Bot cannot see channels where CAs should be ignored (or `BLOCKED_CHANNEL_IDS` set)
- [ ] `GUILD_ID`, `LOG_CHANNEL_ID`, `SUMMARY_CHANNEL_ID` are **their** snowflakes
- [ ] New Railway project/service, source `main`
- [ ] Volume mounted at `/data`
- [ ] `DISCORD_TOKEN` / `CLIENT_ID` match the new app
- [ ] `BLOCKED_CHANNEL_IDS=none` (or their mutes)
- [ ] `ALERT_CARDS_ENABLED=true` (or unset) on Discord — trencher cards on every channel
- [ ] Optional scanners/X-feed left off
- [ ] Logs show `Using data dir: /data` and guild command registration
- [ ] Startup banner in their log channel
- [ ] Smoke: first CA tracks; repost silent; prod untouched

### Never

- [ ] Same `DISCORD_TOKEN` on two Railway services
- [ ] Production `tracked.json` copied onto the new volume
- [ ] Their guild added to the production bot
- [ ] Production channel IDs in the new env

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Bot ignores CAs | Message Content Intent off, or bot cannot View that channel, or channel is blocked |
| `TokenInvalid` / login failed | Wrong `DISCORD_TOKEN`, token reset and Railway not updated, extra whitespace/quotes in the variable |
| Slash commands missing | `CLIENT_ID` wrong, `applications.commands` scope missing, or `GUILD_ID` omitted (wait up to 1h for global) |
| Commands registered but "Unknown integration" | Bot not actually in the guild, or you invited a different application |
| Banner/recap missing | `LOG_CHANNEL_ID` / `SUMMARY_CHANNEL_ID` still the TP4APH default, or missing Send/Embed permission |
| Data empty after every deploy | Volume not mounted at `/data` |
| Alerts appear in TP4APH | You reused the production token or production channel IDs |
| Two bots fighting / random offline | Two services sharing one `DISCORD_TOKEN` |
| Trencher cards not showing | `ALERT_CARDS_ENABLED=false` on that service — set `true` or unset |
| Mint scanner cards in the wrong server | `MINT_SCANNER_CHANNEL_IDS` still lists a TP4APH channel |

---

## Related docs

- [`.env.example`](../.env.example) — every flag
- [`GITHUB_PRACTICES.md`](../GITHUB_PRACTICES.md) — `main` deploys to every service tracking `main`
- [`README.md`](../README.md) — local run and intents
- [`docs/BOT_OVERVIEW.md`](BOT_OVERVIEW.md) — token schema and poller
- [`docs/ALERT_CARDS.md`](ALERT_CARDS.md) — trencher card flags
- [`docs/X_LISTS.md`](X_LISTS.md) — which X list posts to which Discord
- [`docs/OPS_MAP.md`](OPS_MAP.md) — which community has which features
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — Mermaid topology (generated)
- [`architecture/`](../architecture/) — **Tecture** (Cursor sidebar: Tecture: Open Architecture)

---

## Appendix C — Collective — memecoin TP + NFT TP + X

Railway project **`TPB_Collective`** / service **`Discord_Collective`** / volume **`discord_collective-volume`** at `/data` is already created: [dashboard](https://railway.com/project/e709cea7-4e52-4efc-939b-ff588accb1d9).

GitHub is **not** connected yet (no `DISCORD_TOKEN` — connecting `main` would crash-loop). Env is pre-wired to Collective channel `1365097408387612782`. Cookies + OpenSea key were copied from prod Discord.

| Piece | Value |
|---|---|
| Discord app name | `Take Profits — Collective` (**new app** — not prod, not Genny Run) |
| Railway project | `TPB_Collective` |
| Service | `Discord_Collective` |
| Volume | `discord_collective-volume` → `/data` |
| X list | [`2091750809780592842`](https://x.com/i/lists/2091750809780592842) |
| Live channel | `1365097408387612782` (X cards, NFT cards, startup banner — split later if you want) |

**Already set on the service** (do not point these at TP4APH):

```env
XFEED_ENABLED=true
XRADAR_ENABLED=true
XFEED_WATCH_RADAR_HANDLES=false
XFEED_LIST_IDS=2091750809780592842
XFEED_SYNC_LIST_ID=2091750809780592842
XFEED_ROUTES=2091750809780592842:1365097408387612782
XFEED_CHANNEL_ID=1365097408387612782
XRADAR_CHANNEL_ID=1365097408387612782
X_SCANNER_CHANNEL_ID=1365097408387612782
LOG_CHANNEL_ID=1365097408387612782
SUMMARY_CHANNEL_ID=1365097408387612782
NFT_TP_ENABLED=true
NFT_TP_MAX_TIER=20
NFT_TP_CHANNEL_ID=1365097408387612782
NFT_TP_CHANNEL_IDS=1365097408387612782
ALERT_CARDS_ENABLED=true
MINT_SCANNER_ENABLED=false
BLOCKED_CHANNEL_IDS=none
ENABLED_CHAINS=solana,robinhood,base,ink,hype,ethereum
```

Memecoin take-profits (+75%, then 1x–100x) are always-on — they fire in **whatever channel the CA was pasted in**. NFT take-profits are +75% then 1x–20x on OpenSea floor.

**Still needed before connecting GitHub:** `DISCORD_TOKEN` + `CLIENT_ID` + `GUILD_ID` on `Discord_Collective` only. Then Settings → Source → `enstest1/take_profits_profit_bot` branch `main`.

Do **not** set Collective's channel on `perpetual-clarity`. Do not reuse the prod bot token.

---

## Appendix D — Blackjack — memecoin TP (50x) + NFT TP + X

Railway project **`TPB_Blackjack`** / service **`Discord_Blackjack`** / volume **`discord_blackjack-volume`** at `/data` is already created: [dashboard](https://railway.com/project/c97da9e7-9c1b-409d-b855-75bfa032913d).

GitHub is connected to `enstest1/take_profits_profit_bot` branch `main`. `DISCORD_TOKEN` is on the service (not in git). First deploy may still be initializing — confirm `SUCCESS` and `Slash commands registered (guild — instant)` in logs. OpenSea key + X cookies are **not** on this service yet (NFT + Wire need them).

| Piece | Value |
|---|---|
| Discord app name | `Take Profits — Blackjack` (**new app** — not prod, not Collective, not Genny Run) |
| Railway project | `TPB_Blackjack` |
| Service | `Discord_Blackjack` |
| Volume | `discord_blackjack-volume` → `/data` |
| Guild / app | `855079121822285864` / `1542749619107405895` |
| X posts list | [`2093191150190399663`](https://x.com/i/lists/2093191150190399663) (curated — you manage members) |
| X /xwatch list | **create an empty list on X and send the URL** — until then `XFEED_SYNC_LIST_ID=none` so `/xwatch` does not write the curated list |
| X feed + follows | `1543083831601528862` |
| Memecoin TP + NFT TP | `1542691157413466172` (paste CAs and OpenSea links in this channel) |

**Already set on the service** (do not point these at TP4APH):

```env
CLIENT_ID=1542749619107405895
GUILD_ID=855079121822285864
XFEED_ENABLED=true
XRADAR_ENABLED=true
XFEED_WATCH_RADAR_HANDLES=true
XFEED_LIST_IDS=2093191150190399663
XFEED_ROUTES=2093191150190399663:1543083831601528862
XFEED_SYNC_LIST_ID=none
XFEED_CHANNEL_ID=1543083831601528862
XRADAR_CHANNEL_ID=1543083831601528862
X_SCANNER_CHANNEL_ID=1543083831601528862
LOG_CHANNEL_ID=1542691157413466172
SUMMARY_CHANNEL_ID=1542691157413466172
NFT_TP_ENABLED=true
NFT_TP_MAX_TIER=20
NFT_TP_CHANNEL_ID=1542691157413466172
NFT_TP_CHANNEL_IDS=1542691157413466172
MILESTONE_MAX_TIER=50
ALERT_CARDS_ENABLED=true
MINT_SCANNER_ENABLED=false
BLOCKED_CHANNEL_IDS=none
ENABLED_CHAINS=solana,robinhood,base,ink,hype,ethereum
```

Memecoin take-profits (+75%, then 1x–50x) fire in **whatever channel the CA was pasted in**. NFT take-profits are +75% then 1x–20x on OpenSea floor.

**Still needed before connecting GitHub:** `DISCORD_TOKEN` on `Discord_Blackjack` only (`CLIENT_ID` + `GUILD_ID` are already set), plus `OPENSEA_API_KEY` and `X_COOKIES_JSON` (same values as Collective/prod — not the Discord token). Then Settings → Source → `enstest1/take_profits_profit_bot` branch `main`.

When the empty `/xwatch` list exists, set `XFEED_SYNC_LIST_ID=<newListId>` and `XFEED_ROUTES=<newListId>:1543083831601528862,2093191150190399663:1543083831601528862` (xwatch list first so `/xwatch` writes there; curated list still polled for posts). Then you can turn `XFEED_WATCH_RADAR_HANDLES` back to `false`.

Do **not** set Blackjack's channel on `perpetual-clarity`. Do not reuse the prod bot token.
