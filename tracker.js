/** Platform-neutral auto-track path — shared by Discord and Telegram shells. */
import { shouldSilenceAlerts } from './alertGate.js';
import { fetchDexPair, resolveEvmChainToken, tokenDataFromEvmPair } from './dexPair.js';
import { fetchPumpFun, fetchSolPrice, calcPumpFunPrice } from './pumpfunApi.js';
import {
  loadDB,
  saveDB,
  ensureDBSchema,
} from './dbStore.js';
import {
  CHAINS,
  enabledChainsFooter,
  isSolanaAddress,
  isEvmAddress,
  storageKeyForMint,
  makeStorageKey,
  resolveArchivedKey,
  parseStorageKey,
} from './chains.js';
import { enrichWithB20 } from './b20.js';
import { onAlreadyTracking, sendTrackingEmbed } from './autotrackHelpers.js';
import { xHandleFromPair } from './xSocial.js';
import { isBlockedChannel } from './blockedChannels.js';
import { isCaMutedChannel } from './caMuteChannels.js';

export function fmtUsd(n) {
  if (!n || isNaN(Number(n))) return '—';
  const num = Number(n);
  if (num >= 1000000000) return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1000000) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1000) return '$' + (num / 1e3).toFixed(1) + 'K';
  return '$' + num.toFixed(4);
}

export function fmtTime(ms) {
  if (!ms) return '—';
  const diff = Date.now() - Number(ms);
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return d + 'd ago';
  if (h > 0) return h + 'h ago';
  if (m > 0) return m + 'm ago';
  return 'just now';
}

export function getTokenAgeFlag(createdAtMs) {
  if (!createdAtMs) return null;
  const ageHours = (Date.now() - createdAtMs) / 3600000;
  if (ageHours < 1) return '🔥 < 1h old';
  if (ageHours < 24) return '⚡ ' + Math.floor(ageHours) + 'h old';
  return Math.floor(ageHours / 24) + 'd old';
}

export function buildTrackedEntry(token, storageKey, message, ageStr) {
  const { chainId } = parseStorageKey(storageKey);
  const isEvm = CHAINS[chainId]?.kind === 'evm';
  const totalTxns = (token.buys24h || 0) + (token.sells24h || 0);
  let buyPressurePct = null;
  if (totalTxns > 0) buyPressurePct = Math.round((token.buys24h / totalTxns) * 100);

  return {
    address: isEvm ? token.address : storageKey,
    name: token.name,
    symbol: token.symbol,
    chain: token.chain || chainId,
    platform: token.platform,
    postedBy: message.author.username,
    postedByUserId: message.author.id,
    postedAt: Date.now(),
    calledInGuild: message.guildId,
    alertChannelId: message.channelId,
    priceAtCall: token.price || null,
    mcapAtCall: token.marketCap || null,
    volumeAtCall: token.volume24h || 0,
    lastPrice: token.price || null,
    lastVolume: token.volume24h || 0,
    lastChecked: Date.now(),
    peakMultiple: 1.0,
    peakAt: Date.now(),
    milestonesFired: [],
    lowMultStreak: 0,
    takeProfitFired: false,
    gainAlertFired: false,
    bondingProgress: isEvm ? null : (token.bondingProgress || 0),
    graduationAlertFired: isEvm ? null : false,
    bondingAlertFired: isEvm ? null : false,
    tokenAge: ageStr || 'unknown',
    dexUrl: token.dexUrl,
    imageUrl: token.imageUrl || null,
    devWallet: isEvm ? null : (token.creator || null),
    devHoldingAtCall: 0,
    devLastKnownHolding: 0,
    devDumpAlertFired: false,
    buyPressure: buyPressurePct || 0,
    sellPressure: buyPressurePct !== null ? 100 - buyPressurePct : 0,
    xHandle: token.xHandle || null,
    ...(token.b20 ? { b20: token.b20 } : {}),
  };
}

export async function autoTrack(ref, message, seenThisMessage = new Set()) {
  if (isBlockedChannel(message.channelId)) return;
  // NFT-land style channels keep the floor bot; token CAs stay untracked.
  if (isCaMutedChannel(message.channelId)) {
    console.log('[ca-mute] autoTrack skipped in ' + message.channelId);
    return;
  }
  const { chainId, raw } = ref;
  if (CHAINS[chainId]?.kind === 'evm') return autoTrackEvm(chainId, raw, message, seenThisMessage);
  return autoTrackSolana(raw, message, seenThisMessage);
}

export async function autoTrackEvm(chainId, raw, message, seenThisMessage) {
  const db = ensureDBSchema(loadDB());
  const resolved = await resolveEvmChainToken(chainId, raw);
  if (!resolved) {
    console.log('[autotrack] 0x ' + raw.slice(0, 10) + '… has no ' + chainId + ' pair — ignored');
    return;
  }

  const storageKey = makeStorageKey(chainId, resolved.tokenAddress);

  // Cross-EVM dedupe: a bare 0x matches every enabled EVM chain, so the same token
  // can arrive here once per chain. If it is already tracked — or was already handled
  // earlier in this same message — on another EVM chain, skip instead of double-tracking.
  for (const otherId of Object.keys(CHAINS)) {
    if (CHAINS[otherId].kind !== 'evm' || otherId === chainId) continue;
    const otherKey = makeStorageKey(otherId, resolved.tokenAddress);
    if (seenThisMessage.has(otherKey) || db.tokens[otherKey]) {
      console.log(
        '[autotrack] ' + resolved.tokenAddress.slice(0, 10) + '… already handled on ' +
        otherId + ' — skipping ' + chainId,
      );
      return;
    }
  }

  if (seenThisMessage.has(storageKey)) {
    console.log('[autotrack] duplicate ' + chainId + ' mint in same message: ' + storageKey.slice(0, 20) + '…');
    return;
  }
  if (db.tokens[storageKey]) {
    console.log('[autotrack] already tracking ' + (db.tokens[storageKey].symbol || storageKey) + ' (OG preserved)');
    await onAlreadyTracking(message.client, db, storageKey, message);
    return;
  }

  const archivedKey = resolveArchivedKey(db, storageKey, raw);
  if (archivedKey) {
    const og = db.archived[archivedKey];
    // chain: chainId override matters when an archived entry is restored under a
    // different EVM chain key — keeps entry.chain consistent with the storage key.
    db.tokens[storageKey] = { ...og, address: resolved.tokenAddress, chain: chainId };
    delete db.archived[archivedKey];
    saveDB(db);
    console.log('[repair] un-archived ' + (og.symbol || storageKey) + ' on repost — OG call preserved');
    return;
  }

  seenThisMessage.add(storageKey);
  const token = tokenDataFromEvmPair(chainId, resolved.pair, resolved.tokenAddress);
  token.xHandle = xHandleFromPair(resolved.pair);
  const ageStr = getTokenAgeFlag(token.pairCreatedAt);
  token.ageStr = ageStr;
  token.liquidity = resolved.pair?.liquidity?.usd || token.liquidity || 0;
  await enrichWithB20(token);

  await sendTrackingEmbed(message, token, storageKey, db, () =>
    buildTrackedEntry(token, storageKey, message, ageStr),
  );
}

export async function fetchTokenData(address, messageText = '', { autotrack = false } = {}) {
  if (!isSolanaAddress(address)) return null;

  const dexOpts = autotrack ? { retries: 5, timeoutMs: 25_000 } : { retries: 2, timeoutMs: 12_000 };

  const dex = await fetchDexPair(address, {
    enabledChains: ['solana'],
    chainHint: 'solana',
    ...dexOpts,
  });
  if (dex?.name) return { ...dex, platform: 'dexscreener' };

  const pump = await fetchPumpFun(address);
  if (pump) {
    const solPrice = await fetchSolPrice();
    const pumpPrice = solPrice ? calcPumpFunPrice(pump, solPrice) : null;
    return {
      platform: 'pumpfun',
      chain: 'solana',
      name: pump.name,
      symbol: pump.symbol,
      price: pumpPrice ? String(pumpPrice) : null,
      marketCap: pump.usd_market_cap || 0,
      volume24h: 0,
      liquidity: 0,
      buys24h: 0,
      sells24h: 0,
      dexUrl: 'https://pump.fun/' + address,
      imageUrl: pump.image_uri || null,
      pairCreatedAt: pump.created_timestamp || null,
      bondingProgress: pump.bonding_curve_progress || 0,
      complete: pump.complete || false,
      creator: pump.creator || null,
      virtualSolReserves: pump.virtual_sol_reserves,
      virtualTokenReserves: pump.virtual_token_reserves,
    };
  }

  return null;
}

/** Solana-only case-insensitive key lookup (mint-case repair). */
function resolveTokenKey(db, rawAddress) {
  const trimmed = rawAddress.trim();
  if (db.tokens[trimmed]) return trimmed;
  const lower = trimmed.toLowerCase();
  if (db.tokens[lower]) return lower;
  return (
    Object.keys(db.tokens).find((k) => {
      const p = parseStorageKey(k);
      return p.chainId === 'solana' && k.toLowerCase() === lower;
    }) || null
  );
}

export async function autoTrackSolana(address, message, seenThisMessage = new Set()) {
  const db = ensureDBSchema(loadDB());

  if (db.tokens[address]) {
    console.log('[autotrack] already tracking (exact key) ' + address.slice(0, 8) + '...');
    await onAlreadyTracking(message.client, db, address, message);
    return;
  }

  let token = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    token = await fetchTokenData(address, message.content, { autotrack: true });
    if (token) break;
    if (attempt < 2) {
      console.log('[autotrack] retry ' + (attempt + 2) + '/3 for ' + address.slice(0, 10) + '...');
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
    }
  }
  if (!token) {
    console.log('[skip] ' + address.slice(0, 8) + '... — not found');
    if (!shouldSilenceAlerts() && !isBlockedChannel(message.channelId) && !isCaMutedChannel(message.channelId)) {
      await message.channel.send({
        embeds: [{
          color: 0xff4444,
          description:
            '⚠️ Could not find token data for `' + address + '` — not added to tracking\n\n' +
            'No DexScreener/pump.fun listing yet, or temporary API timeout — **try again in a moment.**',
          footer: { text: enabledChainsFooter() },
        }],
      }).catch(() => null);
    }
    return;
  }

  const storageKey = storageKeyForMint(address, token);

  if (seenThisMessage.has(storageKey)) {
    console.log('[autotrack] duplicate mint in same message: ' + storageKey.slice(0, 8) + '...');
    return;
  }

  const existingCanonical = resolveTokenKey(db, storageKey);
  if (existingCanonical || db.tokens[storageKey]) {
    const key = existingCanonical || storageKey;
    if (key !== storageKey && !isEvmAddress(storageKey)) {
      const og = db.tokens[key];
      db.tokens[storageKey] = { ...og, address: storageKey };
      delete db.tokens[key];
      saveDB(db);
      console.log(
        '[repair] fixed mint case for ' + (og.symbol || storageKey.slice(0, 8)) +
        ' — OG call preserved, polling restored',
      );
    } else {
      const sym = db.tokens[key]?.symbol || storageKey.slice(0, 8);
      console.log('[autotrack] already tracking ' + sym + ' (canonical mint — OG call preserved)');
      await onAlreadyTracking(message.client, db, key, message);
    }
    return;
  }

  const archivedKey = resolveArchivedKey(db, storageKey, address);
  if (archivedKey) {
    const og = db.archived[archivedKey];
    const newKey = archivedKey !== storageKey && !isEvmAddress(storageKey) ? storageKey : archivedKey;
    db.tokens[newKey] = { ...og, address: newKey };
    delete db.archived[archivedKey];
    saveDB(db);
    console.log('[repair] un-archived ' + (og.symbol || newKey.slice(0, 8)) + ' on repost — OG call preserved');
    return;
  }

  seenThisMessage.add(storageKey);

  const ageStr = getTokenAgeFlag(token.pairCreatedAt);
  token.ageStr = ageStr;
  token.liquidity = token.liquidity || 0;
  if (token.creator) token.creator = token.creator;

  await sendTrackingEmbed(message, token, storageKey, db, () =>
    buildTrackedEntry(token, storageKey, message, ageStr),
  );
}
