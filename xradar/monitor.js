/**
 * xradar/monitor.js — poll watched accounts and emit new follows.
 *
 * First sweep per handle records the current following page as a baseline
 * (no cards). Later sweeps diff against that snapshot. Per-handle errors
 * never kill the cycle — a private account or a 404 should not stall the rest.
 */

import { getUserByScreenName, getFollowingPage, XRateLimitError, warmClientTransaction } from './xClient.js';
import { getXRadarConfig, getRadarDestinations } from './config.js';
import { listWatched, getSnapshot, writeSnapshot, addWatched } from './store.js';
import { diffFollowing, capNewcomers } from './diff.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _running = false;
let _timer = null;
let _backoffUntil = 0;
/** In-process dedupe so a lost snapshot cannot re-card the same follow this boot. */
const _alerted = new Map(); // dest:watcherId:followedId → ts
const ALERT_TTL_MS = 12 * 60 * 60 * 1000;

function alreadyAlerted(dest, watcherId, followedId) {
  const key = String(dest || '') + ':' + String(watcherId || '') + ':' + String(followedId || '');
  if (!watcherId || !followedId) return false;
  const now = Date.now();
  for (const [k, ts] of _alerted) {
    if (now - ts > ALERT_TTL_MS) _alerted.delete(k);
  }
  if (_alerted.has(key)) return true;
  _alerted.set(key, now);
  return false;
}

async function resolveProfile(handle, cached, dest) {
  if (cached?.id) return cached;
  const profile = await getUserByScreenName(handle);
  addWatched(handle, profile, dest);
  return { ...cached, ...profile, username: profile.username || handle };
}

async function sweepHandle(handle, cached, cfg, dest) {
  const profile = await resolveProfile(handle, cached, dest);
  if (!profile.id) throw new Error('no user id for @' + handle);

  const page = await getFollowingPage(profile.id, undefined, profile.username || handle);
  const users = page?.users || [];
  const prev = getSnapshot(handle, dest);
  const { baseline, newcomers } = diffFollowing(prev?.ids, users);
  const capped = capNewcomers(newcomers, cfg.maxNewPerUser);

  writeSnapshot(handle, users.map((u) => u.id), dest);

  if (baseline) {
    console.log('[xradar] baseline @' + handle + ' — ' + users.length + ' following id(s), posting none');
    return { handle, posted: [], baseline: true };
  }

  if (cfg.debug) {
    console.log(
      '[xradar] @' + handle + ' page=' + users.length + ' new=' + newcomers.length +
        (capped.length !== newcomers.length ? ' capped=' + capped.length : ''),
    );
  }

  return {
    handle,
    watcher: {
      username: profile.username || handle,
      name: profile.name,
      id: profile.id,
      avatarUrl: profile.avatarUrl,
    },
    posted: capped.filter((u) => !alreadyAlerted(dest, profile.id, u.id)),
    baseline: false,
  };
}

/** One poll cycle. → { events, stats } — never throws. */
export async function pollOnce() {
  const cfg = getXRadarConfig();
  const dests = getRadarDestinations();
  const events = [];
  const stats = { watched: 0, baselines: 0, follows: 0, errors: 0 };

  if (Date.now() < _backoffUntil) {
    console.warn('[xradar] backing off until ' + new Date(_backoffUntil).toISOString());
    return { events, stats };
  }

  // Each dest has its own users + snapshots. Personal watches never emit TP cards.
  for (const dest of dests) {
    const watched = listWatched(dest.id);
    const handles = Object.keys(watched);
    stats.watched += handles.length;
    if (!handles.length) continue;

    for (const handle of handles) {
      try {
        const result = await sweepHandle(handle, watched[handle], cfg, dest.id);
        if (result.baseline) stats.baselines += 1;
        for (const followed of result.posted) {
          events.push({
            destId: dest.id,
            channelId: dest.channelId,
            watcher: result.watcher,
            followed,
          });
          stats.follows += 1;
        }
      } catch (e) {
        stats.errors += 1;
        if (e instanceof XRateLimitError) {
          const waitSec = e.retryAfterSec || 90;
          _backoffUntil = Date.now() + waitSec * 1000;
          console.warn('[xradar] rate limited — backing off ' + waitSec + 's');
          return { events, stats };
        }
        console.error('[xradar] @' + handle + ' dest=' + dest.id + ' failed:', e.message);
      }
      await sleep(cfg.userGapMs);
    }
  }

  return { events, stats };
}

export function startXRadarPoller(onFollows) {
  const cfg = getXRadarConfig();
  if (_timer) return;

  async function tick() {
    if (_running) {
      console.warn('[xradar] previous poll still running — skipping');
      return;
    }
    _running = true;
    try {
      const { events, stats } = await pollOnce();
      if (events.length) await onFollows(events);
      if (cfg.debug || events.length || stats.baselines || stats.errors) {
        console.log(
          '[xradar] watched ' + stats.watched +
            ', new follows ' + stats.follows +
            ', baselines ' + stats.baselines +
            ', errors ' + stats.errors,
        );
      }
    } catch (e) {
      console.error('[xradar] poll failed:', e.message);
    } finally {
      _running = false;
    }
  }

  void warmClientTransaction().catch((e) => {
    console.warn('[xradar] signer warm failed (will retry on first poll):', e.message);
  });

  setTimeout(() => void tick(), 25_000);
  _timer = setInterval(() => void tick(), cfg.pollSec * 1000);
  _timer.unref?.();
  console.log('[xradar] poller started — every ' + cfg.pollSec + 's');
}

export function stopXRadarPoller() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
