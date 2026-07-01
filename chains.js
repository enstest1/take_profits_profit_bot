export const SUPPORTED_CHAINS = ['solana'];

const CHAIN_LABELS = {
  solana: 'SOLANA',
};

/** Legacy EVM chain ids (kept for stored tokens; not enabled by default). */
export const EVM_CHAINS = ['ethereum', 'base', 'bsc', 'abstract'];

export function parseEnabledChains() {
  const raw = process.env.ENABLED_CHAINS || 'solana';
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((c) => SUPPORTED_CHAINS.includes(c));
  return parsed.length > 0 ? parsed : [...SUPPORTED_CHAINS];
}

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

export function chainLabel(chain) {
  const key = (chain || 'solana').toLowerCase();
  return CHAIN_LABELS[key] || key.toUpperCase();
}

export function enabledChainsFooter() {
  return parseEnabledChains().map(chainLabel).join(' · ');
}

export function evmEnabledChains() {
  return parseEnabledChains().filter((c) => c !== 'solana');
}
