# Architecture

Generated from [`ops-map.json`](ops-map.json). Do not hand-edit — run `node scripts/render-ops-map.mjs`.

Bitcernals + TP4APH = ONE Discord bot and ONE /data volume. Collective, Genny, and Blackjack get their own bot. Never put their channels on perpetual-clarity.

## New architecture (`architecture-beta`)

Cloud-style groups: one box per Railway project. Server = bot, database = volume, internet = Discord/TG. Needs Mermaid 11.1+ (GitHub has it; if Cursor preview is a blank box, use the flowchart below).

```mermaid
architecture-beta
  group repo(cloud)[git main]
  group prod(cloud)[perpetual-clarity]
  group coll(cloud)[TPB_Collective]
  group gennyg(cloud)[TPB_Genny_Run]
  group blackjack(cloud)[TPB_Blackjack]
  group gp(cloud)[Golden Pocket TG]

  service git(server)[main] in repo

  service prodBot(server)[prod bot] in prod
  service prodVol(database)[/data volume] in prod
  service bitcernals(internet)[Bitcernals] in prod
  service tp4aph(internet)[TP4APH] in prod
  service newest(internet)[Newest staged] in prod

  service collBot(server)[Collective bot] in coll
  service collVol(database)[/data] in coll
  service collDc(internet)[Collective Discord] in coll

  service gennyBot(server)[Genny bot] in gennyg
  service gennyVol(database)[/data] in gennyg
  service gennyDc(internet)[Genny Discord] in gennyg

  service bjBot(server)[Blackjack bot] in blackjack
  service bjVol(database)[/data] in blackjack
  service bjDc(internet)[Blackjack Discord] in blackjack

  service gpBot(server)[GP bot] in gp
  service gpVol(database)[/data] in gp
  service gpTg(internet)[Golden Pocket] in gp

  git{group}:B --> T:prodBot{group}
  git{group}:B --> T:collBot{group}
  git{group}:B --> T:gennyBot{group}
  git{group}:B --> T:bjBot{group}
  git{group}:B --> T:gpBot{group}

  prodBot:R -- L:prodVol
  prodBot:B --> T:bitcernals
  prodBot:B --> T:tp4aph
  prodBot:B --> T:newest

  collBot:R -- L:collVol
  collBot:B --> T:collDc

  gennyBot:R -- L:gennyVol
  gennyBot:B --> T:gennyDc

  bjBot:R -- L:bjVol
  bjBot:B --> T:bjDc

  gpBot:R -- L:gpVol
  gpBot:B --> T:gpTg
```

## Topology (flowchart)

Feature lists live here. Dashed line = staged.

```mermaid
flowchart TB
  git["main<br/>one repo · flags per service"]
  prod["prod bot<br/>perpetual-clarity"]
  collBot["Collective bot<br/>TPB_Collective"]
  gennyBot["Genny bot<br/>TPB_Genny_Run"]
  bjBot["Blackjack bot<br/>TPB_Blackjack"]
  gpBot["Golden Pocket bot<br/>PLATFORM=telegram"]
  personal["Bitcernals<br/>your Discord · shared prod bot<br/>- volume · any CA chat<br/>- mint mirror<br/>- X posts + follows<br/>- early first-100  · beta"]
  tp4aph["TP4APH<br/>OG Discord · same bot<br/>- volume · #trenches<br/>- NFT volume · #nft-land<br/>- X posts + follows · #trenches<br/>- /ask · waiting"]
  newest["Newest Discord<br/>extra X route on prod bot<br/>- X posts · say go-live  · staged"]
  collective["Collective<br/>own bot · waiting on token<br/>- volume ready  · waiting<br/>- NFT ready  · waiting<br/>- X posts + follows ready  · waiting"]
  genny["Genny Run<br/>own bot · no channels yet<br/>- nothing live yet"]
  blackjack["Blackjack<br/>own bot · /xwatch → Wire list<br/>- volume 75%–50x<br/>- NFT 20x<br/>- X posts · #wire"]
  golden["Golden Pocket<br/>Telegram prize · own bot<br/>- volume LIVE<br/>- X feed list<br/>- fib on · cards off"]
  git --> prod
  git --> collBot
  git --> gennyBot
  git --> bjBot
  git --> gpBot
  subgraph shared["same Discord token + /data volume"]
    personal
    tp4aph
    newest
  end
  prod --> personal
  prod --> tp4aph
  prod -.-> newest
  collBot --> collective
  gennyBot --> genny
  bjBot --> blackjack
  gpBot --> golden
```

## Volume bot

Every instance runs this path. Alerts go to the channel that first tracked the CA.

```mermaid
flowchart LR
  ca["CA / NFT url<br/>pasted in chat"] --> track["autoTrack<br/>first caller wins"]
  track --> db["/data<br/>tracked.json"]
  db --> poll["poller<br/>~3 min"]
  poll --> card["card in that<br/>OG channel"]
```
