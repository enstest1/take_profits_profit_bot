/**
 * nfttp/poller.js — poll OpenSea floors and fire trencher take-profit cards.
 */

import { getNftTpConfig } from './config.js';
import { fetchCollectionStats, resolveNftWindows } from './opensea.js';
import { listCollections, patchCollection } from './store.js';
import { evaluateNftMilestones } from './evaluate.js';
import { buildNftMilestoneAlert } from './cards.js';
import { buildNftFloorChart } from './chart.js';
import { sendChannelAlert } from '../channelAlert.js';

function pollTier(entry, now) {
  const age = now - (Number(entry.postedAt) || now);
  const hasHits = (entry.milestonesFired || []).length > 0 || entry.gainAlertFired;
  if (age <= 24 * 60 * 60 * 1000 || (hasHits && age <= 7 * 24 * 60 * 60 * 1000)) return 'hot';
  if (hasHits && Number(entry.peakMultiple) >= 1.5) return 'warm';
  return 'cold';
}

async function pollOne(client, slug, entry, cfg) {
  const { stats, error } = await fetchCollectionStats(slug);
  if (!stats || stats.floor == null || stats.floor <= 0) {
    if (cfg.debug) console.log('[nfttp] skip ' + slug + ': ' + (error || 'no floor'));
    patchCollection(slug, { lastChecked: Date.now() });
    return;
  }

  const supply = Number(entry.totalSupply) || null;
  const live = {
    floor: stats.floor,
    floorSymbol: stats.floorSymbol || entry.floorSymbol || 'ETH',
    numOwners: stats.numOwners,
    mcap: supply && stats.floor > 0 ? stats.floor * supply : entry.lastMcap,
    stats,
  };

  const lastCheckedAgeMs = Date.now() - (Number(entry.lastChecked) || 0);
  const { patch, alerts } = evaluateNftMilestones(entry, live, {
    maxTier: cfg.maxTier,
    lastCheckedAgeMs,
  });
  const updated = patchCollection(slug, patch) || { ...entry, ...patch };

  for (const alert of alerts) {
    let chartFile = null;
    let candles = [];
    try {
      const chart = await buildNftFloorChart({
        slug,
        ticker: updated.ticker,
        callFloor: updated.floorAtCall,
        currentFloor: live.floor,
        floorSymbol: live.floorSymbol,
      });
      chartFile = chart.chartFile;
      candles = chart.candles;
    } catch (e) {
      console.warn('[nfttp] chart failed for ' + slug + ':', e.message);
    }

    const windows = resolveNftWindows({ candles, stats: live.stats });
    const { embed, files } = buildNftMilestoneAlert({
      entry: updated,
      live,
      alertKind: alert.kind,
      tier: alert.tier,
      chartFile,
      windows,
    });
    await sendChannelAlert(
      client,
      updated.alertChannelId,
      embed,
      'nft-' + alert.label,
      files.length ? files : null,
    );
    console.log('[nfttp] ' + alert.label + ' ' + updated.name + ' (' + slug + ')');
  }
}

export async function pollNftCollections(client) {
  const cfg = getNftTpConfig();
  const all = Object.entries(listCollections());
  if (!all.length) return { scheduled: 0, fired: 0 };

  const now = Date.now();
  const cycle = Math.floor(now / (cfg.intervalSec * 1000));
  const scheduled = all.filter(([, entry]) => {
    const tier = pollTier(entry, now);
    if (tier === 'hot') return true;
    if (tier === 'warm') return cycle % 2 === 0;
    return cycle % 5 === 0;
  });

  console.log('[nfttp] poll ' + scheduled.length + '/' + all.length + ' collections');
  for (const [slug, entry] of scheduled) {
    try {
      await pollOne(client, slug, entry, cfg);
    } catch (e) {
      console.error('[nfttp] poll ' + slug + ':', e.message);
    }
  }
  return { scheduled: scheduled.length, fired: scheduled.length };
}

let _timer = null;
let _running = false;

export function startNftTpPoller(client) {
  const cfg = getNftTpConfig();
  if (_timer) return;

  async function tick() {
    if (_running) {
      console.warn('[nfttp] previous tick still running — skipping');
      return;
    }
    _running = true;
    try {
      await pollNftCollections(client);
    } catch (e) {
      console.error('[nfttp] tick error:', e.message);
    } finally {
      _running = false;
    }
  }

  setTimeout(() => void tick(), 15_000);
  _timer = setInterval(() => void tick(), cfg.intervalSec * 1000);
  _timer.unref?.();
  console.log(
    '[nfttp] poller every ' + cfg.intervalSec + 's · max tier ' + cfg.maxTier +
      'x · chains ' + cfg.chains.join(','),
  );
}
