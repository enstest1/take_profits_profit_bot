/**
 * nfttp/autotrack.js — first OpenSea URL in chat locks OG floor.
 */

import { getNftTpConfig, isNftTpChannel, nftTpAlertChannel } from './config.js';
import { extractNftRefs, tickerFromSlug } from './parse.js';
import { resolveNftSnapshot } from './opensea.js';
import { getCollection, trackCollection } from './store.js';
import { buildNftAutotrackPayload } from './cards.js';
import { sendChannelAlert } from '../channelAlert.js';

/**
 * Scan a Discord message for OpenSea collection URLs and lock the first call.
 * Reposts are silent — same OG invariant as token autoTrack.
 */
export async function handleNftMessage(message) {
  const cfg = getNftTpConfig();
  if (!cfg.enabled) return;
  if (!isNftTpChannel(message.channelId)) return;

  const refs = extractNftRefs(message.content, { trackContracts: cfg.trackContracts });
  if (!refs.length) return;

  console.log('[nfttp] found ' + refs.length + ' collection ref(s) from ' + message.author.username);
  const seen = new Set();
  for (const ref of refs) {
    const key = ref.slug || String(ref.address || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    await autoTrackNft(ref, message).catch((e) =>
      console.error('[nfttp] autotrack failed for ' + (ref.raw || key) + ':', e.message),
    );
  }
}

/**
 * Manual /nfttrack path — same lock, same card.
 * @returns {Promise<{ added: boolean, entry: object|null, error: string|null }>}
 */
export async function autoTrackNft(ref, message) {
  const { snapshot, error } = await resolveNftSnapshot(ref);
  if (!snapshot) {
    console.warn('[nfttp] resolve failed: ' + error + ' (' + (ref.raw || ref.slug) + ')');
    return { added: false, entry: null, error };
  }

  const existing = getCollection(snapshot.slug);
  if (existing) {
    console.log('[nfttp] already tracking ' + snapshot.slug + ' — OG preserved');
    return { added: false, entry: existing, error: null };
  }

  const ticker = tickerFromSlug(snapshot.slug, snapshot.name);
  const { added, entry } = trackCollection(snapshot.slug, {
    name: snapshot.name,
    ticker,
    chain: snapshot.chain || 'ethereum',
    address: snapshot.address,
    postedBy: message.author.username,
    postedByUserId: message.author.id,
    postedAt: Date.now(),
    alertChannelId: nftTpAlertChannel(message.channelId),
    totalSupply: snapshot.totalSupply,
    floorAtCall: snapshot.floor,
    mcapAtCall: snapshot.mcap,
    ownersAtCall: snapshot.numOwners,
    floorSymbol: snapshot.floorSymbol,
    lastFloor: snapshot.floor,
    lastMcap: snapshot.mcap,
    lastOwners: snapshot.numOwners,
    lastChecked: Date.now(),
    peakMultiple: 1,
    peakAt: Date.now(),
    milestonesFired: [],
    gainAlertFired: false,
    takeProfitFired: false,
    lowMultStreak: 0,
    imageUrl: snapshot.imageUrl,
    openseaUrl: snapshot.openseaUrl,
    createdAt: snapshot.createdAt,
    twitterUsername: snapshot.twitterUsername,
  });

  if (!added) return { added: false, entry, error: null };

  console.log(
    '[nfttp] tracking ' + entry.name + ' (' + entry.slug + ') floor=' +
      (entry.floorAtCall != null ? entry.floorAtCall + ' ' + entry.floorSymbol : 'pending'),
  );

  const { embed, files } = buildNftAutotrackPayload(message, entry);
  await sendChannelAlert(message.client, entry.alertChannelId, embed, 'nft-autotrack', files.length ? files : null);
  return { added: true, entry, error: null };
}
