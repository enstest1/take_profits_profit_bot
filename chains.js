/** Chain registry — single source for keys, extraction, and display. Prevents v1 EVM bugs (#2 cross-chain, #3 key collisions). */
export const CHAINS = {
  solana: {
    id: 'solana',
    kind: 'solana',
    emoji: '◎',
    label: 'SOLANA',
    dexScreenerSlug: 'solana',
    addressRegex: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,
  },
  base: {
    id: 'base',
    kind: 'evm',
    emoji: '🔵',
    label: 'BASE',
    dexScreenerSlug: 'base',
    addressRegex: /\b0x[a-fA-F0-9]{40}\b/g,
  },
  robinhood: {
    id: 'robinhood',
    kind: 'evm',
    emoji: '🏹',
    label: 'ROBINHOOD',
    dexScreenerSlug: 'robinhood',
    addressRegex: /\b0x[a-fA-F0-9]{40}\b/g,
  },
};

/** @deprecated use CHAINS keys */
export const SUPPORTED_CHAINS = Object.keys(CHAINS);

/** Legacy EVM chain ids (stored tokens only — not enabled for auto-track). */
export const EVM_CHAINS = ['ethereum', 'base', 'bsc', 'abstract', 'robinhood'];

export function enabledChains() {
  return String(process.env.ENABLED_CHAINS || 'solana')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((id) => CHAINS[id]);
}

/** Alias kept for existing imports. */
export const parseEnabledChains = enabledChains;

export function isEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function isSolanaAddress(address) {
  return (
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) &&
    /\d/.test(address) &&
    !/[0OIl]/.test(address)
  );
}

export function isEvmChain(chain) {
  return EVM_CHAINS.includes(String(chain || '').toLowerCase());
}

/** THE storage-key choke point — prevents v1 key-collision bug (#3). */
export function makeStorageKey(chainId, tokenAddress) {
  const addr = String(tokenAddress || '');
  if (CHAINS[chainId]?.kind === 'evm') return chainId + ':' + addr.toLowerCase();
  return addr;
}

/** Inverse: split any DB key into { chainId, address }. Handles all three key eras. */
export function parseStorageKey(key) {
  const i = key.indexOf(':');
  if (i > 0) return { chainId: key.slice(0, i), address: key.slice(i + 1) };
  if (/^0x/i.test(key)) return { chainId: 'legacy-evm', address: key };
  return { chainId: 'solana', address: key };
}

export function isLegacyEvmKey(key) {
  return parseStorageKey(key).chainId === 'legacy-evm';
}

/** Canonical DB key for a Solana mint (byte-identical to pre-robinhood behavior). */
export function storageKeyForMint(address, token) {
  return makeStorageKey('solana', token?.address || address);
}

export function chainBadge(chainId) {
  const id = String(chainId || 'solana').toLowerCase();
  return CHAINS[id]?.emoji || '';
}

export function chainLabel(chain) {
  const key = String(chain || 'solana').toLowerCase();
  const c = CHAINS[key];
  if (c) return c.emoji + ' ' + c.label;
  return key.toUpperCase();
}

export function enabledChainsFooter() {
  return enabledChains().map((id) => chainLabel(id)).join(' · ');
}

export function evmEnabledChains() {
  return enabledChains().filter((c) => c !== 'solana');
}

/** Base58 in dexUrl matching key case-insensitively but not literally = mangled mint key. */
function mixedCaseEvidenceInDexUrl(key, dexUrl) {
  if (!dexUrl || !key) return false;
  const re = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  let m;
  while ((m = re.exec(dexUrl)) !== null) {
    const s = m[0];
    if (s.toLowerCase() === key.toLowerCase() && s !== key) return true;
  }
  return false;
}

/**
 * Solana key mangled by the old lowercase bug — NOT merely "all lowercase".
 * pump.fun mints are often legitimately all-lowercase base58; only flag when
 * entry.address or dexUrl proves a mixed-case canonical exists for this mint.
 */
export function isBrokenSolKey(key, entry) {
  const { chainId, address } = parseStorageKey(key);
  if (chainId !== 'solana') return false;
  if ((entry?.chain || 'solana').toLowerCase() !== 'solana') return false;
  if (/^0x/i.test(address)) return false;
  if (!/[a-z]/.test(address) || /[A-Z]/.test(address)) return false;

  const addr = entry?.address || key;
  if (addr !== key && addr.toLowerCase() === key.toLowerCase() && /[A-Z]/.test(addr)) return true;
  if (mixedCaseEvidenceInDexUrl(key, entry?.dexUrl)) return true;

  return false;
}

/**
 * Shared CA resolver for slash commands — robinhood 0x → prefixed key; Solana → existing case logic.
 * Prevents v1 bug #3 (bare 0x vs prefixed key mismatch on /remove).
 */
export function resolveUserInputToKey(db, rawInput) {
  const raw = String(rawInput || '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    for (const chainId of Object.keys(CHAINS)) {
      if (CHAINS[chainId].kind !== 'evm') continue;
      const key = makeStorageKey(chainId, raw);
      if (db.tokens[key]) return key;
    }
    return null;
  }
  if (raw.includes(':') && db.tokens[raw]) return raw;
  if (db.tokens[raw]) return raw;
  const lower = raw.toLowerCase();
  if (db.tokens[lower]) return lower;
  return (
    Object.keys(db.tokens).find((k) => {
      const p = parseStorageKey(k);
      return p.chainId === 'solana' && k.toLowerCase() === lower;
    }) || null
  );
}

/** Resolve archived key for repost un-archive (Solana case-insensitive + robinhood prefixed). */
export function resolveArchivedKey(db, storageKey, rawInput) {
  if (!db.archived) return null;
  if (db.archived[storageKey]) return storageKey;
  const raw = String(rawInput || storageKey || '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    for (const chainId of Object.keys(CHAINS)) {
      if (CHAINS[chainId].kind !== 'evm') continue;
      const key = makeStorageKey(chainId, raw);
      if (db.archived[key]) return key;
    }
    return null;
  }
  const lower = raw.toLowerCase();
  if (db.archived[lower]) return lower;
  return (
    Object.keys(db.archived).find((k) => {
      const p = parseStorageKey(k);
      return p.chainId === 'solana' && k.toLowerCase() === lower;
    }) || null
  );
}

/** Skip 0x matches embedded in dexscreener.com/<other-chain>/ URLs (spec test #7). */
function isForeignDexScreenerContext(body, startIndex, rawLen, chainId) {
  const chunk = body.slice(Math.max(0, startIndex - 60), startIndex + rawLen);
  const hit = chunk.match(/dexscreener\.com\/([a-z0-9_-]+)\/0x[a-fA-F0-9]{40}$/i);
  return hit && hit[1].toLowerCase() !== chainId;
}

/**
 * Chain-tagged address extraction from chat text.
 * With ENABLED_CHAINS=solana only, 0x strings produce zero matches (unchanged behavior).
 */
export function extractAddresses(text) {
  const found = [];
  const seen = new Set();
  const body = String(text || '');

  for (const chainId of enabledChains()) {
    const chain = CHAINS[chainId];

    if (chain.kind === 'evm') {
      const urlRe = new RegExp('dexscreener\\.com\\/' + chainId + '\\/(0x[a-fA-F0-9]{40})', 'gi');
      let um;
      while ((um = urlRe.exec(body)) !== null) {
        const raw = um[1];
        const dedupeKey = chainId + ':' + raw.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        found.push({ chainId, raw });
      }
    }

    for (const m of body.matchAll(chain.addressRegex)) {
      let raw = m[0];
      if (chainId === 'solana') {
        if (!/\d/.test(raw) || /[0OIl]/.test(raw)) continue;
      }
      if (chain.kind === 'evm' && isForeignDexScreenerContext(body, m.index ?? 0, raw.length, chainId)) {
        continue;
      }
      const dedupeKey = chainId + ':' + (chain.kind === 'evm' ? raw.toLowerCase() : raw);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      found.push({ chainId, raw });
    }
  }

  return found;
}
