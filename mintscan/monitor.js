/**
 * mintscan/monitor.js — the scan loop.
 *
 * Ported from take_profi_bot/src/mint-scanner/monitor.ts with the pure parsing
 * split into mintParse.js and state moved into dbStore.
 *
 * Each tick: read new blocks → decode mint logs → fold into per-contract rolling
 * windows → any contract crossing a tier threshold gets metadata resolved, spam
 * filters applied, and a card posted (or its existing card edited on tier-up).
 *
 * Rate discipline: metadata resolution is the expensive part (OpenSea +
 * Alchemy + eth_call), so it only runs for contracts that already cleared a
 * tier threshold, and results are cached.
 */

import { getBlockNumber, getLogs } from './rpc.js';
import { getMintScannerConfig } from './config.js';
import {
  parseMintEvents, tierFor, windowMintCount, pruneWindow, safeQty,
  TOPIC_ERC721_TRANSFER, TOPIC_ERC1155_SINGLE, TOPIC_ERC1155_BATCH, ZERO_TOPIC,
} from './mintParse.js';
import { resolveMintCollectionMeta } from './metadata.js';
import { isBlockedMint, blockReason } from './blocklist.js';
import { getLastScannedBlock, setLastScannedBlock, getCard, setCard, pruneCards } from './store.js';

const TIER_RANK = { WARM: 1, HOT: 2, MOONING: 3 };
const CARD_TTL_MS = 24 * 60 * 60 * 1000;

/** contract → { chunks:[{block,qty}], minters:{addr:block}, sampleTx } */
const windows = Object.create(null);

async function fetchMintLogs(fromHex, toHex) {
  const filters = [
    { fromBlock: fromHex, toBlock: toHex, topics: [TOPIC_ERC721_TRANSFER, ZERO_TOPIC] },
    { fromBlock: fromHex, toBlock: toHex, topics: [TOPIC_ERC1155_SINGLE, null, ZERO_TOPIC] },
    { fromBlock: fromHex, toBlock: toHex, topics: [TOPIC_ERC1155_BATCH, null, ZERO_TOPIC] },
  ];
  const all = [];
  for (const filter of filters) {
    try {
      all.push(...(await getLogs(filter)));
    } catch (e) {
      console.warn('[mintscan] getLogs partial failure:', e.message);
    }
  }
  return all;
}

/**
 * One scan tick. `send(embed, contract, tier)` does the posting/editing and
 * returns a messageId (or null). Injected so the loop stays testable.
 */
export async function mintScanOnce(send) {
  const cfg = getMintScannerConfig();
  const head = await getBlockNumber();

  const last = getLastScannedBlock();
  const startBlock = last > 0 ? last + 1 : Math.max(0, head - cfg.windowBlocks);
  const toBlock = Math.min(head, startBlock + cfg.maxBlocksPerTick);
  if (toBlock < startBlock) return { scanned: 0, alerted: 0 };

  const events = parseMintEvents(
    await fetchMintLogs('0x' + startBlock.toString(16), '0x' + toBlock.toString(16)),
  );

  for (const e of events) {
    if (!windows[e.contract]) windows[e.contract] = { chunks: [], minters: {}, sampleTx: e.tx };
    const w = windows[e.contract];
    w.sampleTx = e.tx;
    w.minters[e.minter] = e.block;
    w.chunks.push({ block: e.block, qty: safeQty(e.qty) });
  }

  const minKeep = Math.max(0, head - cfg.windowBlocks);
  let alerted = 0;
  let blocked = 0;
  let unlisted = 0;

  for (const [contract, w] of Object.entries(windows)) {
    pruneWindow(w, minKeep);
    const mints = windowMintCount(w);
    if (mints === 0) {
      delete windows[contract]; // window emptied — stop tracking, frees memory
      continue;
    }

    const unique = Object.keys(w.minters).length;
    const tier = tierFor(mints, unique, cfg);
    if (!tier) continue;

    // Don't re-post the same tier; only escalate (WARM → HOT → MOONING),
    // and rate-limit edits so a fast climb can't spam the channel.
    const existing = getCard(contract);
    if (existing) {
      const sameOrLower = TIER_RANK[tier] <= TIER_RANK[existing.tier];
      const tooSoon = Date.now() - (existing.lastUpdated || 0) < cfg.cardEditIntervalSec * 1000;
      if (sameOrLower || tooSoon) continue;
    }

    let meta;
    try {
      meta = await resolveMintCollectionMeta(contract, w.sampleTx);
    } catch (e) {
      console.warn('[mintscan] metadata failed for ' + contract.slice(0, 10) + '…:', e.message);
      continue;
    }

    if (cfg.requireOpenSea && !meta.openSeaSlug) {
      unlisted++;
      continue;
    }
    if (isBlockedMint(contract, meta)) {
      blocked++;
      if (cfg.debug) {
        console.log('[mintscan] skip ' + meta.displayName + ': ' + blockReason(contract, meta));
      }
      continue;
    }

    // perMin is derived from the window's real duration, not a fixed "5m"
    // assumption — block times differ wildly between L1 and L2.
    const secondsPerBlock = cfg.chain.id === 'ethereum' ? 12 : 0.25;
    const windowMinutes = Math.max(0.1, (cfg.windowBlocks * secondsPerBlock) / 60);

    const alert = {
      tier,
      contract,
      collectionName: meta.displayName,
      openSeaSlug: meta.openSeaSlug,
      twitterUsername: meta.twitterUsername,
      imageUrl: meta.imageUrl,
      totalSupply: meta.totalSupply,
      maxSupply: meta.maxSupply,
      mintPct: meta.mintPct,
      mintPriceEth: meta.mintPriceEth,
      floorPriceEth: meta.floorPriceEth,
      numOwners: meta.numOwners,
      mints,
      perMin: mints / windowMinutes,
      unique,
      sampleTx: w.sampleTx,
      windowBlocks: cfg.windowBlocks,
    };

    try {
      const messageIds = await send(alert, existing);
      setCard(contract, {
        messageIds,
        tier,
        lastUpdated: Date.now(),
      });
      alerted++;
    } catch (e) {
      console.error('[mintscan] alert failed for ' + contract.slice(0, 10) + '…:', e.message);
    }
  }

  setLastScannedBlock(toBlock);
  pruneCards(CARD_TTL_MS);

  if (cfg.debug && (events.length || alerted)) {
    console.log(
      '[mintscan] blocks ' + startBlock + '-' + toBlock + ': ' + events.length + ' mint logs, ' +
        alerted + ' alert(s), ' + blocked + ' blocked, ' + unlisted + ' unlisted',
    );
  }

  return { scanned: toBlock - startBlock + 1, alerted };
}

let _timer = null;
let _running = false;

export function startMintScanner(send) {
  const cfg = getMintScannerConfig();
  if (_timer) return;

  async function tick() {
    if (_running) {
      console.warn('[mintscan] previous tick still running — skipping');
      return;
    }
    _running = true;
    try {
      await mintScanOnce(send);
    } catch (e) {
      console.error('[mintscan] tick error:', e.message);
    } finally {
      _running = false;
    }
  }

  setTimeout(() => void tick(), 10_000);
  _timer = setInterval(() => void tick(), cfg.intervalSec * 1000);
  _timer.unref?.();
  console.log(
    '[mintscan] started on ' + cfg.chain.label + ' — every ' + cfg.intervalSec + 's · window ' +
      cfg.windowBlocks + ' blocks · warm ' + cfg.warmMints + '/hot ' + cfg.hotMints + '/moon ' +
      cfg.moonMints + ' · min ' + cfg.minUnique + ' unique · requireOpenSea ' + cfg.requireOpenSea +
      ' · channels ' + cfg.channelIds.join(','),
  );
}

export function stopMintScanner() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
