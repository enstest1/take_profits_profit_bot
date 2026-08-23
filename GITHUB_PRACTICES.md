# GitHub Practices — Take Profits Bot

How we ship code for **take_profits_profit_bot**: one production branch, feature flags for everything optional, and two Railway services (Discord + Telegram) running the same code with different env vars.

**Repo:** [enstest1/take_profits_profit_bot](https://github.com/enstest1/take_profits_profit_bot)
**Production branch:** `main` — the only branch that ever deploys
**Persistent data:** `/data/tracked.json` on Railway volume (not in git — code rollbacks never wipe tokens)

---

## The one rule

> **Production changes reach Railway only by merging to `main`.**

`railway up` is break-glass only (Railway outage, GitHub outage, mid-incident hotfix). If you ever use it, merge the exact same code to `main` immediately after — otherwise git and production diverge and there are two versions of the truth. This happened in Jul–Aug 2026 (prod ran `feature/mint-scanner` via `railway up` while GitHub `main` fell as much as ~20 commits behind); see the changelog at the bottom.

---

## Deployment model — one branch, two services

Platform differences are **environment variables, never branches**. There is no Discord-main or Telegram-main. Both services auto-deploy from `main`; a merge deploys to both, and flags decide what each service actually runs.

| Railway service | Platform | Deploys from | Key variables |
|---|---|---|---|
| `take_profits_profit_bot` (project `perpetual-clarity`) | Discord | `main` | `PLATFORM=discord` (default), scanner + alert-card flags **on** |
| Telegram notifier (separate Railway project, e.g. `TG_1_Golden_Pocket_TPB`) | Telegram | `main` | `PLATFORM=telegram`, `ALERT_CARDS_ENABLED=false` **explicitly**, other flags off |

Two things to remember:

- **A merge to `main` redeploys every service tracking `main` at the same time.** If a service isn't ready for that (wrong branch, unverified vars), fix its settings *before* merging.
- `start.mjs` routes `PLATFORM=telegram` to `telegram.js`, so Discord-only modules never boot on the Telegram service. Explicit flags on top of that routing are belt-and-suspenders — keep both.

New feature for one platform? Gate it behind a flag (and a `PLATFORM` check if needed), merge once, flip the flag on that service only.

---

## Feature flags

**Convention: every optional module ships behind an env flag that defaults to off.**

> ⚠️ **Known exception (until the post-consolidation `fix:` lands — see Changelog):** alert cards currently default **on** — `isAlertCardsEnabled()` returns `true` when `ALERT_CARDS_ENABLED` is unset. Until the default is flipped, any service that shouldn't render them must set `ALERT_CARDS_ENABLED=false` explicitly. The flip is a one-line change in `alertCards/index.js` (`return false` when the var is unset/empty), safe because the Discord service already sets `true` explicitly; when it lands, update the "Unset semantics" column above and the Changelog note.

**Lifecycle:** build on a branch → merge to `main` dark (flag off, deploys everywhere, changes nothing) → enable in a personal/test channel → enable for the group → if it becomes permanent core behavior, remove the flag later.

This is what makes single-`main` safe: half-finished work can merge without going live, and "launching" a feature is a variable change, not a deploy.

### Current flags & prod-critical vars (snapshot 2026-08-11 — Railway variables are the source of truth)

**Read the "Unset semantics" column carefully — "off" means two different things here.** For most flags, unset is safe (the module stays off). For alert cards, unset means *on* — so a service that shouldn't render them must set `false` explicitly. Confusing the two is how you either ship cards where you didn't want them or waste time setting a `false` that was never needed.

| Variable | Module | Unset semantics | Discord service | Telegram service |
|---|---|---|---|---|
| `MINT_SCANNER_ENABLED` | `mintscan/` chain-radar NFT mint alerts | **Unset = off** — explicit `false` optional | `true` | unset (off) |
| `MINT_SCANNER_CHAIN` | — | — | `robinhood` | — |
| `MINT_SCANNER_CHANNEL_IDS` | — | — | `1358929055604408465,1536502941924593827` | — |
| `MINT_SCANNER_DEBUG` | — | — | `true` | — |
| `ALERT_CARDS_ENABLED` | `alertCards/` trencher milestone cards | ⚠️ **Unset = ON** — explicit `false` **required** on any non-Discord service | `true` | **`false` (explicit)** |
| `ALERT_CARDS_CHANNEL_ID` | — | — | `1452152164699869298` | — |
| `BLOCKED_CHANNEL_IDS` | global channel mute list (always read, no flag gate) | Default baked in as of `e438ae5` | `1536177376508121088` | n/a |
| `XFEED_ENABLED` | `xfeed/` live X list feed | **Unset = off** — explicit `false` optional | off | off |
| `XRADAR_ENABLED` | `xradar/` X follow-radar stub | **Unset = off** — explicit `false` optional | off | off |

Always-on (no flag): core poller / take-profit milestones, `fib/` retracement alerts on configured channels.

---

## Branch model

| Branch | Purpose | Deploys to prod? |
|---|---|---|
| **`main`** | The only production branch — both services | **Yes** |
| **`feature/*`** | All new work, branched off fresh `main`, one feature per branch | No — via PR merge only |
| **`fix/*`** | Urgent fixes (can merge straight to `main`) | After merge |

**Deleted from the model on purpose:** `develop` (unused staging layer), platform branches, and long-lived post-merge feature branches. **Branches are deleted immediately after merge** — the tag and merge commit preserve everything.

### Two speeds

**Small tweaks** (copy change, tier constant, one-file fix):

1. `git pull origin main`, edit, commit, push
2. Both services redeploy — watch logs ~5 min on the service(s) the change touches

**Big updates** (new module, refactor, dependency major bump):

1. **Tag** current stable (`stable-before-<feature>`)
2. `git checkout -b feature/<name>` off fresh `main`
3. Build it **behind a default-off flag**
4. Push branch, open PR → `main`, review diff, merge (merge commit, not squash)
5. Services redeploy dark; flip the flag on in a test channel, then broaden
6. Tag `stable-after-<feature>` once the group confirms it feels good

---

## Tags (rollback bookmarks)

Tags mark **known-good production** states. Create them often.

```
stable-YYYY-MM-DD          # general stable snapshot
stable-before-<feature>    # before big work starts
stable-after-<feature>     # after merge confirmed good
archive/<branch>           # frozen pointer to abandoned-but-kept work (then delete the branch)
```

```bash
# Create + push
git tag -a stable-2026-08-11-post-alert-cards -m "main = live prod: mintscan, alert cards, GMGN links, blocked channels"
git push origin stable-2026-08-11-post-alert-cards

# List / inspect
git tag -l "stable-*"
git show stable-2026-08-11-post-alert-cards
```

**When to tag:** before starting any `feature/*` branch; after a few good days in prod; immediately before and after large merges; before Railway region changes or dependency major bumps.

---

## Commit messages

Clear and revert-friendly, one logical change per commit:

```
Good:  Fix OG call reset — canonical mint check before save
Good:  Demote no-milestone tokens older than 24h to cold tier
Bad:   fixes / wip / update / stuff
```

---

## Pull requests

Even solo, all `feature/*` work goes through a PR to `main`:

- Readable diff before prod
- **Merge method: "Create a merge commit"** (not squash) — keeps per-commit revert ability, and the merge commit itself is a one-click revert
- Turn on **"Automatically delete head branches"** in repo settings so merged branches clean themselves up

**PR title format:** `feat:` / `fix:` / `docs:` / `refactor:` + short description

---

## How to revert

In order of speed:

### 0. Flip the flag off (fastest — no deploy at all)

If the problem is inside a flagged module, set its `*_ENABLED=false` on the affected service (explicit `false`, which also covers the alert-cards default-on case). Done in seconds, no git involved. This is the main payoff of the flag model.

### 1. Railway dashboard redeploy

Each service has its own deployment history: Railway → service → **Deployments** → last good one → **Redeploy**. Use when prod broke in the last hour. Does not change git history — follow up with a git fix so `main` matches reality again.

### 2. Git revert (recommended for shared history)

```bash
git checkout main && git pull
git log --oneline -5
git revert <bad-commit>
git push origin main        # both services redeploy the fix
```

### 3. Revert a merged PR

GitHub PR → **Revert** button, or `git revert -m 1 <merge-commit> && git push origin main`.

### 4. Roll back to a tag

Prefer reverting the commits since the tag over resets:

```bash
git revert <tag>..HEAD
git push origin main
```

**Never `git push --force` to `main`.** `tracked.json` survives every method above.

---

## Railway + GitHub wiring

| Setting | Discord service (`perpetual-clarity`) | Telegram service (own project) |
|---|---|---|
| Source branch | `main` | `main` |
| Region | US East (`us-east4-eqdc4a`) | — |
| Volume | `/data` → `tracked.json`, milestone state | — |
| Start command | repo default (`railway.toml`) | service-level override → `telegram.js` via `start.mjs` routing |

- `railway redeploy --from-source --yes` — redeploy latest `main` from the linked repo
- `railway up` — **break-glass only** (see The one rule)
- The deploy branch can only be changed in the Railway dashboard, not the CLI
- `railway deployment list --json` — inspect `branch` / `commitHash` per deploy (a `railway up` upload has none — that's how you spot CLI drift)

### Changing a service's source branch is not atomic — and does not fail closed

Settings → Source → branch is config only; it does not redeploy by itself, and a wrong setting ships wrong code rather than erroring. Every branch change follows: **change branch → verify branch in Settings → redeploy → confirm the new deployment row's metadata shows the commit you expect.** "GitHub says merged" or "Settings says `main`" is not confirmation — a SUCCESS row with the right `commitHash` is.

Failure modes to check for, none of which error loudly:

| Mode | Symptom | Catch it by |
|---|---|---|
| Autodeploy disabled | Merge succeeds in git, nothing ships, prod stale | Deployments → **Show Skipped**; then Deploy Latest Commit |
| Wrong branch selected | Service builds wrong lineage | Verify branch in Settings before and after |
| Branch changed, no redeploy | Config says `main`, still running old build | Explicit redeploy after the change; confirm metadata |

**A merge to `main` redeploys every service whose source is `main` — simultaneously and with no CI gate** (`checkSuites: false`). Before merging, know exactly which services that set contains. If a service is on `main` and you *didn't* expect it to be, stop and find out why before proceeding — unexplained source config is the same silent drift this whole model exists to prevent.

---

## Branch & stash hygiene

- Merged branches are deleted immediately (auto-delete on GitHub + `git branch -d` locally)
- Monthly sweep:

```bash
git fetch --prune
git branch --merged main        # anything listed is safe to delete
git branch -r --merged main
```

- Unmerged-but-dormant work: `git tag archive/<branch> <branch>`, push the tag, delete the branch
- Review stashes with `git stash list` / `git stash show -p stash@{N}`; drop stale ones — don't let WIP live in stashes for weeks
- Target: **≤ ~5 open branches** at any time

---

## GitHub repo settings (one-time)

GitHub → **Settings → Branches**, rule for `main`:

- [x] Require a pull request before merging (self-merge allowed)
- [x] Do not allow force pushes
- [x] Do not allow deletions

GitHub → **Settings → General**:

- [x] Automatically delete head branches

Default branch: `main`.

---

## Quick reference — daily commands

```bash
# Small fix on main
git pull origin main
# ... edit ...
git add <files> && git commit -m "fix: describe change"
git push origin main            # both services redeploy — watch logs

# Big feature
git pull origin main
git tag -a stable-before-my-feature -m "Pre my-feature" && git push origin stable-before-my-feature
git checkout -b feature/my-feature
# ... build behind a default-off flag ...
git push -u origin feature/my-feature
# Open PR → main → merge (merge commit) → branch auto-deletes

# Launch the feature (no deploy needed)
# Railway → service → Variables → MY_FEATURE_ENABLED=true

# After a good stretch in prod
git tag -a stable-YYYY-MM-DD -m "Description" && git push origin stable-YYYY-MM-DD
```

---

## Files never committed

| Path | Reason |
|---|---|
| `.env` | Secrets |
| `.tp_comeback_cycles` | Runtime state |
| `/data/*` on Railway | Production DB |

See `.env.example` for required env vars and channel routing docs.

---

## Related docs

- [`docs/BOT_OVERVIEW.md`](docs/BOT_OVERVIEW.md) — architecture, scaling roadmap, reviewer handoff
- [`railway.toml`](railway.toml) — deploy region and start command

---

## Changelog

- **Jul 2026** — initial setup: branches `main` + `develop`, tag `stable-2026-07-04`.
- **Aug 2026 — consolidation** *(this doc is the final commit of that work)*.

  **Problem:** prod ran `feature/mint-scanner` via `railway up` while GitHub `main` lagged — as much as ~20 commits at its worst — so a GitHub-triggered deploy would have rolled back live features. By consolidation day the Discord service's GitHub source was already `main`, but its live deploy (`0761c68b`) was a `railway up` upload with no commit metadata, sitting one commit ahead of the last real GitHub deploy (`b620688`); live tip was `e438ae5` (GMGN card links + `BLOCKED_CHANNEL_IDS` default). Telegram (`Golden_Pocket_TG_Take_Profits_Bot` in project `TG_1_Golden_Pocket_TPB`) was on `feature/telegram`; `warden` had no GitHub source.

  **Fixed by:**
  - Tagged `stable-before-consolidation` @ `e438ae5`; recorded Railway deploy `0761c68b` as rollback bookmark (Phase 0).
  - Merged `feature/mint-scanner` → `main` via PR (merge commit). Discord auto-deployed the merge commit immediately (source already `main`, no CI gate); confirmed via a new SUCCESS deployment row with the expected `commitHash`, not just the GitHub merge (Phase 1). Telegram stayed on `feature/telegram` through Phase 1 and was unaffected.
  - Tagged `stable-2026-08-11-post-alert-cards` after logs verified clean (Phase 2).
  - Switched Telegram to `main` with `PLATFORM=telegram` and explicit `ALERT_CARDS_ENABLED=false`; verified deployment metadata after the branch change (Phase 3).
  - Deleted or archive-tagged all stale branches — only `main` survives; `feature/degen-v3` and `feature/scaling-v2` verified 0 commits ahead of `main` before deletion (Phase 4).
  - Retired `develop`; adopted the feature-flag / env-var model for platform differences; established "merge to `main` is the only deploy path."

  **Learned:** Railway branch config does not fail closed — wrong source ships wrong code, disabled autodeploy leaves prod stale while git advances. Hence the verify-metadata-after-every-branch-change rule now in the Railway section.
- **Aug 2026 — post-consolidation `fix:`** — flipped the alert-cards default from on to off so the "flags default off" convention is literally true; safe because the Discord service sets `ALERT_CARDS_ENABLED=true` explicitly. *(Update the flag table's "Unset semantics" and remove this note's "planned" status once landed.)*