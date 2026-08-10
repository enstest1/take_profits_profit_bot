/**
 * mintscan/blocklist.js — spam filtering for mint alerts.
 *
 * Ported from take_profi_bot/src/mint-scanner/blocklist.ts. Three layers:
 *   1. explicit contract blocklist (MINT_SCANNER_BLOCKLIST_CONTRACTS)
 *   2. explicit slug blocklist + prefix blocklist
 *   3. factory slug heuristic — lazy-mint factories produce slugs like
 *      "something-123456789", which are almost always spam
 *
 * The strongest filter is not here though: cfg.requireOpenSea in the monitor,
 * which drops anything not listed on OpenSea at all.
 */

import { getBlocklistSlugPrefixes, getMintScannerConfig } from './config.js';

function blockedContracts() {
  const raw = process.env.MINT_SCANNER_BLOCKLIST_CONTRACTS || '';
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.startsWith('0x')));
}

function blockedSlugsExact() {
  const raw = process.env.MINT_SCANNER_BLOCKLIST_SLUGS || '';
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function isFactorySlugPattern(slug) {
  if (!getMintScannerConfig().blockFactory) return false;
  return /^[a-z0-9_-]+-\d{7,}$/i.test(slug);
}

export function isBlockedMint(contract, meta) {
  const c = String(contract).toLowerCase();
  if (blockedContracts().has(c)) return true;

  const slug = meta?.openSeaSlug?.toLowerCase();
  if (!slug) return false;

  if (blockedSlugsExact().has(slug)) return true;
  for (const prefix of getBlocklistSlugPrefixes()) {
    if (slug === prefix || slug.startsWith(prefix + '-')) return true;
  }
  return isFactorySlugPattern(slug);
}

export function blockReason(contract, meta) {
  if (!isBlockedMint(contract, meta)) return null;
  if (blockedContracts().has(String(contract).toLowerCase())) return 'blocklisted contract';
  if (meta?.openSeaSlug && isFactorySlugPattern(meta.openSeaSlug)) return 'factory slug pattern';
  return 'blocklisted slug';
}
