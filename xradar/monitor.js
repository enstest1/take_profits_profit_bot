/**
 * xradar/monitor.js — poll watched accounts and emit new follows.
 *
 * First sweep per handle records the current following page as a baseline
 * (no cards). Later sweeps diff against that snapshot. Per-handle errors
 * never kill the cycle — a private account or a 404 should not stall the rest.
 */

import { getUserByScreenName, getFollowingPage, XRateLimitError, warmClientTransaction } from './xClient.js';
import { getXRadarConfig } from './config.js';
import { listWatched, getSnapshot, writeSnapshot, addWatched } from './store.js';
import { diffFollowing, capNewcomers } from './diff.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _running = false;
let _timer = null;
let _backoffUntil = 0;

async function resolveProfile(handle, cached) {
  if (cached?.id) return cached;
  const profile = await getUserByScreenName(handle);
  addWatched(handle, profile);
  return { ...cached, ...profile, username: profile.username || handle };
}

async function sweepHandle(handle, cached, cfg) {
  const profile = await resolveProfile(handle, cached);
  if (!profile.id) throw new Error('no user id for @' + handle);

  const page = await getFollowingPage(profile.id, undefined, profile.username || handle);
  const users = page?.users || [];
  const prev = getSnapshot(handle);
  const { baseline, newcomers } = diffFollowing(prev?.ids, users);
  const capped = capNewcomers(newcomers, cfg.maxNewPerUser);

  writeSnapshot(handle, users.map((u) => u.id));

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
    watcher: { username: profile.username || handle, name: profile.name, id: profile.id },
    posted: capped,
    baseline: false,
  };
}

/** One poll cycle. → { events, stats } — never throws. */
export async function pollOnce() {
  const cfg = getXRadarConfig();
  const watched = listWatched();
  const handles = Object.keys(watched);
  const events = [];
  const stats = { watched: handles.length, baselines: 0, follows: 0, errors: 0 };

  if (!handles.length) {
    return { events, stats };
  }

  if (Date.now() < _backoffUntil) {
    console.warn('[xradar] backing off until ' + new Date(_backoffUntil).toISOString());
    return { events, stats };
  }

  for (const handle of handles) {
    try {
      const result = await sweepHandle(handle, watched[handle], cfg);
      if (result.baseline) stats.baselines += 1;
      for (const followed of result.posted) {
        events.push({ watcher: result.watcher, followed });
        stats.follows += 1;
      }
    } catch (e) {
      stats.errors += 1;
      if (e instanceof XRateLimitError) {
        const waitSec = e.retryAfterSec || 90;
        _backoffUntil = Date.now() + waitSec * 1000;
        console.warn('[xradar] rate limited — backing off ' + waitSec + 's');
        break;
      }
      console.error('[xradar] @' + handle + ' failed:', e.message);
    }
    await sleep(cfg.userGapMs);
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
