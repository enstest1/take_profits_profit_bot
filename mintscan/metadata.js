/**
 * mintscan/metadata.js — collection identity, supply, price, floor.
 *
 * Ported from take_profi_bot/src/mint-scanner/metadata.ts, with the hardcoded
 * `chain/ethereum/` OpenSea path made chain-aware (OpenSea added Robinhood
 * Chain support on 2026-07-11, so slugs/floors/stats work there).
 *
 * Resolution order for a contract:
 *   1. Alchemy getContractMetadata → name + openSeaSlug   (needs ALCHEMY_API_KEY)
 *   2. OpenSea contract endpoint  → slug + name           (needs OPENSEA_API_KEY)
 *   3. OpenSea collection/stats/drops → image, twitter, supply, price, floor
 *   4. On-chain name()/symbol()/totalSupply()/maxSupply()  (always available)
 *   5. Mint price fallback: the value of a sample mint tx
 *
 * Every lookup fails soft to null — a card with missing fields is fine, a
 * thrown error in the scan loop is not.
 */

import { rpcCall } from './rpc.js';
import { getChain } from './config.js';

const SEL_NAME = '0x06fdde03';
const SEL_SYMBOL = '0x95d89b41';
const SEL_TOTAL_SUPPLY = '0x18160ddd';
const SEL_MAX_SUPPLY = '0xd5abeb01';

const staticCache = new Map();   // contract → { displayName, openSeaSlug, twitterUsername, imageUrl, totalSupply }
const statsCache = new Map();    // slug → { at, floorPriceEth, numOwners }
const STATS_TTL_MS = 90_000;

function openSeaHeaders() {
  const key = process.env.OPENSEA_API_KEY?.trim();
  if (!key) return null;
  return { accept: 'application/json', 'x-api-key': key };
}

async function ethCallUint(contract, selector) {
  try {
    const res = await rpcCall('eth_call', [{ to: contract, data: selector }, 'latest']);
    if (!res || res === '0x') return null;
    const n = Number(BigInt(res));
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

async function ethCallString(contract, selector) {
  try {
    const res = await rpcCall('eth_call', [{ to: contract, data: selector }, 'latest']);
    if (!res || res === '0x') return null;
    const hex = res.replace(/^0x/, '');
    if (hex.length < 128) return null;
    const len = Number(BigInt('0x' + hex.slice(64, 128)));
    const bytesHex = hex.slice(128, 128 + len * 2);
    const s = Buffer.from(bytesHex, 'hex').toString('utf8').replace(/\0/g, '').trim();
    return s || null;
  } catch {
    return null;
  }
}

const parseSupplyStr = (raw) => {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw).replace(/,/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function weiToEth(wei) {
  try {
    const v = typeof wei === 'bigint' ? wei : BigInt(wei);
    if (v <= 0n) return null;
    return Number(v) / 1e18;
  } catch {
    return null;
  }
}

export function mintPct(total, max) {
  if (total == null || max == null || max <= 0) return null;
  return Math.min(100, (total / max) * 100);
}

function isAddressLike(name, contract) {
  const n = String(name).toLowerCase();
  const c = contract.toLowerCase();
  return n === c || n.includes(c.slice(2, 10)) || /^0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/i.test(name);
}

async function osJson(url) {
  const headers = openSeaHeaders();
  if (!headers) return null;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function openSeaCollectionDetails(slug) {
  const data = await osJson('https://api.opensea.io/api/v2/collections/' + slug);
  if (!data) return { name: null, twitterUsername: null, imageUrl: null, totalSupply: null };
  return {
    name: data.name?.trim() || data.collection?.trim() || null,
    twitterUsername: data.twitter_username?.trim()?.replace(/^@/, '') || null,
    imageUrl: data.image_url?.trim() || data.banner_image_url?.trim() || null,
    totalSupply: parseSupplyStr(data.total_supply),
  };
}

async function openSeaCollectionStats(slug) {
  const hit = statsCache.get(slug);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) {
    return { floorPriceEth: hit.floorPriceEth, numOwners: hit.numOwners };
  }
  const data = await osJson('https://api.opensea.io/api/v2/collections/' + slug + '/stats');
  if (!data) return { floorPriceEth: null, numOwners: null };
  const floor = data.total?.floor_price;
  const owners = data.total?.num_owners;
  const result = {
    floorPriceEth: floor != null && floor > 0 ? floor : null,
    numOwners: owners != null && owners > 0 ? owners : null,
  };
  statsCache.set(slug, { at: Date.now(), ...result });
  return result;
}

async function openSeaDrop(slug) {
  const data = await osJson('https://api.opensea.io/api/v2/drops/' + slug);
  if (!data) return { totalSupply: null, maxSupply: null, mintPriceEth: null };
  const stages = data.stages || [];
  const stage =
    stages.find((s) => s.stage_type === 'public_sale' && s.price) || stages.find((s) => s.price) || stages[0];
  return {
    totalSupply: parseSupplyStr(data.total_supply),
    maxSupply: parseSupplyStr(data.max_supply),
    mintPriceEth: stage?.price ? weiToEth(stage.price) : null,
  };
}

/** Alchemy NFT metadata — gives us the OpenSea slug without an OpenSea call. */
async function alchemyContractMeta(contract) {
  const key = process.env.ALCHEMY_API_KEY?.trim();
  const chain = getChain();
  if (!key || !chain.alchemyHost) return { name: null, openSeaSlug: null };
  try {
    const res = await fetch(
      'https://' + chain.alchemyHost + '.g.alchemy.com/nft/v3/' + key +
        '/getContractMetadata?contractAddress=' + contract,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return { name: null, openSeaSlug: null };
    const data = await res.json();
    return {
      name: data?.openSeaMetadata?.collectionName || data?.name || null,
      openSeaSlug: data?.openSeaMetadata?.collectionSlug ?? null,
    };
  } catch {
    return { name: null, openSeaSlug: null };
  }
}

async function resolveStatic(contract) {
  const key = contract.toLowerCase();
  const hit = staticCache.get(key);
  if (hit?.displayName) return hit;

  let displayName = null;
  let openSeaSlug = null;
  let twitterUsername = null;
  let imageUrl = null;

  const alchemy = await alchemyContractMeta(key);
  openSeaSlug = alchemy.openSeaSlug;
  if (alchemy.name && !isAddressLike(alchemy.name, key)) displayName = alchemy.name;

  // Chain-aware OpenSea contract lookup (was hardcoded to ethereum).
  const chain = getChain();
  const data = await osJson(
    'https://api.opensea.io/api/v2/chain/' + chain.openSeaChain + '/contract/' + key,
  );
  if (data) {
    if (!openSeaSlug) openSeaSlug = data.collection?.trim() || null;
    if (!displayName) displayName = data.name?.trim() || null;
  }

  let totalSupply = null;
  if (openSeaSlug) {
    const details = await openSeaCollectionDetails(openSeaSlug);
    if (!displayName) displayName = details.name;
    if (!twitterUsername) twitterUsername = details.twitterUsername;
    if (!imageUrl) imageUrl = details.imageUrl;
    totalSupply = details.totalSupply;
  }

  if (!displayName) displayName = await ethCallString(key, SEL_NAME);
  if (!displayName) displayName = await ethCallString(key, SEL_SYMBOL);

  const result = {
    displayName: displayName || 'Unknown Collection',
    openSeaSlug,
    twitterUsername,
    imageUrl,
    totalSupply,
  };
  if (result.displayName !== 'Unknown Collection' || result.openSeaSlug || result.imageUrl) {
    staticCache.set(key, result);
  }
  return result;
}

async function mintPriceFromTx(txHash) {
  try {
    const tx = await rpcCall('eth_getTransactionByHash', [txHash]);
    if (!tx?.value) return null;
    return weiToEth(tx.value);
  } catch {
    return null;
  }
}

/** Full metadata for a mint card. Never throws. */
export async function resolveMintCollectionMeta(contract, sampleTx) {
  const key = contract.toLowerCase();
  const base = await resolveStatic(key);

  let totalSupply = base.totalSupply ?? null;
  let maxSupply = null;
  let mintPriceEth = null;
  let floorPriceEth = null;
  let numOwners = null;

  if (base.openSeaSlug) {
    const [drop, stats] = await Promise.all([
      openSeaDrop(base.openSeaSlug),
      openSeaCollectionStats(base.openSeaSlug),
    ]);
    if (drop.totalSupply != null) totalSupply = drop.totalSupply;
    if (drop.maxSupply != null) maxSupply = drop.maxSupply;
    if (drop.mintPriceEth != null) mintPriceEth = drop.mintPriceEth;
    floorPriceEth = stats.floorPriceEth;
    numOwners = stats.numOwners;
  }

  const [onTotal, onMax] = await Promise.all([
    ethCallUint(key, SEL_TOTAL_SUPPLY),
    ethCallUint(key, SEL_MAX_SUPPLY),
  ]);
  if (totalSupply == null && onTotal != null) totalSupply = onTotal;
  if (maxSupply == null && onMax != null) maxSupply = onMax;

  if (mintPriceEth == null && sampleTx) mintPriceEth = await mintPriceFromTx(sampleTx);

  return {
    displayName: base.displayName,
    openSeaSlug: base.openSeaSlug,
    twitterUsername: base.twitterUsername,
    imageUrl: base.imageUrl,
    totalSupply,
    maxSupply,
    mintPct: mintPct(totalSupply, maxSupply),
    mintPriceEth,
    floorPriceEth,
    numOwners,
  };
}
