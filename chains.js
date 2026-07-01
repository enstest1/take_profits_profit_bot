export const SUPPORTED_CHAINS = ['solana', 'ethereum', 'base'];

const CHAIN_LABELS = {
  solana: 'SOLANA',
  ethereum: 'ETHEREUM',
  base: 'BASE',
};

export function parseEnabledChains() {
  const raw = process.env.ENABLED_CHAINS || 'solana,ethereum,base';
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

export function chainLabel(chain) {
  const key = (chain || 'solana').toLowerCase();
  return CHAIN_LABELS[key] || key.toUpperCase();
}

export function enabledChainsFooter() {
  return parseEnabledChains().map(chainLabel).join(' · ');
}

export function evmEnabledChains() {
  return parseEnabledChains().filter((c) => c === 'ethereum' || c === 'base');
}
