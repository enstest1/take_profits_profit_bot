# GitHub Practices — Take Profits Bot

How we ship code for **take_profits_profit_bot**: fast tweaks on `main`, safe branches for big updates, and easy rollback on Railway.

**Repo:** [enstest1/take_profits_profit_bot](https://github.com/enstest1/take_profits_profit_bot)  
**Production deploy:** Railway service `take_profits_profit_bot` — auto-deploys **`main` only**  
**Persistent data:** `/data/tracked.json` on Railway volume (not in git — code rollback does not wipe tokens)

---

## Branch model

| Branch | Purpose | Deploys to prod? |
|--------|---------|------------------|
| **`main`** | Production-ready code only | **Yes** (Railway) |
| **`develop`** | Optional integration / staging merges | No (unless you add a staging service) |
| **`feature/*`** | Big or risky work (poller refactor, Supabase, etc.) | No |
| **`fix/*`** | Urgent prod fixes (can merge straight to `main`) | After merge to `main` |

### Two speeds

**Small tweaks** (copy change, tier constant, silence notification, one-file fix):

1. Optional: ensure a recent `stable-*` tag exists
2. Commit on `main` (or `fix/*` → quick merge)
3. Push → Railway redeploys
4. Watch Railway logs ~5 minutes

**Big updates** (parallel poller, new DB, multi-file refactor):

1. **Tag** current stable (see below)
2. Branch: `git checkout -b feature/your-feature-name`
3. Work and commit on the branch
4. Push branch, open a **Pull Request** → `main`
5. Review diff (solo or with Fable), merge when ready
6. Tag again after prod looks good

---

## Tags (rollback bookmarks)

Tags mark **known-good production** states. Create them often.

### Naming

```
stable-YYYY-MM-DD          # general stable snapshot
stable-before-<feature>    # before a big refactor
stable-after-<feature>     # after merge confirmed good
```

### Commands

```bash
# Create tag on current commit
git tag -a stable-2026-07-04 -m "Sol-only, OG call fix, cold tier polling"
git push origin stable-2026-07-04

# List tags
git tag -l "stable-*"

# See what's in a tag
git show stable-2026-07-04

# Restore code from a tag (emergency local checkout)
git checkout stable-2026-07-04 -- .
```

### When to tag

- Before starting any **feature/** branch for big work
- After the group confirms the bot feels good for a few days
- Immediately **before** and **after** large merges to `main`
- Before Railway region changes or dependency major bumps

---

## Commit messages

Use clear, revert-friendly messages:

```
Good:  Fix OG call reset — canonical mint check before save
Good:  Demote no-milestone tokens older than 24h to cold tier
Bad:   fixes / wip / update / stuff
```

One logical change per commit when possible. Big features = one PR = one feature.

---

## Pull requests

Even for solo work, PRs to `main` are worth it for:

- Readable diff before prod
- Link to `docs/BOT_OVERVIEW.md` / review notes
- Clean revert (revert the merge commit)

**PR title format:** `feat:`, `fix:`, `docs:`, `refactor:` + short description

---

## How to revert

Pick the method that matches the situation.

### 1. Fastest — Railway dashboard

1. Railway → `take_profits_profit_bot` → **Deployments**
2. Find last good deployment → **Redeploy**

Use when prod broke in the last hour and you need instant rollback. Does not change git history.

### 2. Git revert (recommended for shared history)

```bash
git checkout main
git pull origin main
git log --oneline -5                    # find bad commit
git revert <commit-hash>                # creates undo commit
git push origin main
```

Railway redeploys the reverted code. **`tracked.json` unchanged.**

### 3. Revert a merged PR

On GitHub: Pull Request → **Revert** button, or:

```bash
git revert -m 1 <merge-commit-hash>
git push origin main
```

### 4. Roll back to a tag

```bash
git checkout main
git pull
git revert HEAD~N..HEAD   # or revert specific commits since tag
# OR cherry-pick / reset only with team agreement — prefer revert
```

**Never `git push --force` to `main`** unless explicitly agreed for an emergency.

---

## Railway + GitHub wiring

| Setting | Value |
|---------|--------|
| Production branch | `main` |
| Region | US East (`us-east4-eqdc4a`) |
| Volume | `/data` → `tracked.json`, milestone state files |
| Redeploy latest | `railway redeploy --from-source --yes` (from linked repo) |

Optional later: second Railway service on `develop` or PR previews for testing without touching prod.

---

## GitHub repo settings (one-time)

Do these in GitHub → **Settings → Branches**:

1. **Add branch protection rule** for `main`:
   - [ ] Require a pull request before merging (recommended for big-team; can allow self-merge)
   - [ ] Do not allow force pushes
   - [ ] Do not allow deletions

2. **Default branch:** `main`

3. **Tags:** visible under Releases / Tags — use for changelog notes if desired

---

## Quick reference — daily commands

```bash
# Start small fix on main
git pull origin main
# ... edit ...
git add <files>
git commit -m "fix: describe change"
git push origin main

# Start big feature
git pull origin main
git tag -a stable-before-my-feature -m "Pre my-feature"
git push origin stable-before-my-feature
git checkout -b feature/my-feature
# ... work ...
git push -u origin feature/my-feature
# Open PR on GitHub → merge when ready

# After good deploy
git tag -a stable-2026-07-04 -m "Description"
git push origin stable-2026-07-04
```

---

## Files never committed

These stay local or on Railway only:

| Path | Reason |
|------|--------|
| `.env` | Secrets |
| `.tp_comeback_cycles` | Runtime state |
| `/data/*` on Railway | Production DB |

See `.env.example` for required env vars.

---

## Related docs

- [`docs/BOT_OVERVIEW.md`](docs/BOT_OVERVIEW.md) — architecture, scaling roadmap, reviewer handoff
- [`railway.toml`](railway.toml) — deploy region and start command

---

*Initial setup: Jul 2026 — branches `main` + `develop`, tag `stable-2026-07-04` on first practices commit.*
