/**
 * nfttp/parse.js — pull OpenSea collection refs out of Discord messages.
 *
 * Primary trigger is an OpenSea URL (unambiguous). Bare 0x only when
 * NFT_TP_TRACK_CONTRACTS is on, so we never steal token CAs in mixed chats.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

/** OpenSea collection page — optional chain prefix, query string, trailing slash. */
const COLLECTION_URL_RE =
  /(?:https?:\/\/)?(?:www\.|pro\.)?opensea\.io\/(?:[a-z0-9_-]+\/)?collection\/([a-z0-9][a-z0-9-]{0,99})(?:\/[^\s]*)?/gi;

/** Item / asset page → chain + contract (we resolve the parent collection). */
const ITEM_URL_RE =
  /(?:https?:\/\/)?(?:www\.|pro\.)?opensea\.io\/(?:item|assets)\/([a-z0-9_]+)\/(0x[a-fA-F0-9]{40})(?:\/[^\s]*)?/gi;

export function isOpenSeaSlug(value) {
  return SLUG_RE.test(String(value || '').trim().toLowerCase());
}

export function isEvmAddress(value) {
  return ADDR_RE.test(String(value || '').trim());
}

/**
 * Short ticker for the trencher author line.
 * `pudgy-penguins` → PUDGY; `boredapeyachtclub` → BOREDAPE.
 */
export function tickerFromSlug(slug, name) {
  const rawSlug = String(slug || '').trim().toLowerCase();
  if (rawSlug.includes('-')) {
    const first = rawSlug.split('-').find((p) => p.length >= 2) || rawSlug.split('-')[0];
    if (first) return first.slice(0, 8).toUpperCase();
  }
  if (rawSlug.length >= 2 && rawSlug.length <= 8) return rawSlug.toUpperCase();
  const fromName = String(name || '')
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter((w) => w.length >= 2)
    .map((w) => w[0])
    .join('');
  if (fromName.length >= 2 && fromName.length <= 8) return fromName.toUpperCase();
  const compact = (rawSlug || String(name || 'NFT')).replace(/[^a-z0-9]/gi, '').slice(0, 8);
  return compact.toUpperCase() || 'NFT';
}

/**
 * @returns {Array<{ kind: 'slug'|'contract', slug?: string, chain?: string, address?: string, raw: string }>}
 */
export function extractNftRefs(text, { trackContracts = false } = {}) {
  const src = String(text || '');
  const out = [];
  const seen = new Set();

  const push = (ref) => {
    const key =
      ref.kind === 'slug'
        ? 'slug:' + ref.slug
        : 'contract:' + String(ref.chain || '') + ':' + String(ref.address || '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };

  for (const m of src.matchAll(COLLECTION_URL_RE)) {
    const slug = m[1]?.toLowerCase();
    if (slug) push({ kind: 'slug', slug, raw: m[0] });
  }

  for (const m of src.matchAll(ITEM_URL_RE)) {
    const chain = m[1]?.toLowerCase();
    const address = m[2];
    if (chain && address) push({ kind: 'contract', chain, address, raw: m[0] });
  }

  if (trackContracts) {
    const addrs = src.match(/0x[a-fA-F0-9]{40}/g) || [];
    for (const address of addrs) {
      push({ kind: 'contract', address, raw: address });
    }
  }

  return out;
}

/**
 * Resolve `/nfttrack` input: URL, slug, or 0x contract.
 * @returns {{ kind: 'slug'|'contract', slug?: string, chain?: string, address?: string, raw: string }|null}
 */
export function parseNftQuery(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const fromUrl = extractNftRefs(raw, { trackContracts: false });
  if (fromUrl.length) return fromUrl[0];
  if (isEvmAddress(raw)) return { kind: 'contract', address: raw, raw };
  const slug = raw.replace(/^@/, '').toLowerCase();
  if (isOpenSeaSlug(slug)) return { kind: 'slug', slug, raw };
  return null;
}
