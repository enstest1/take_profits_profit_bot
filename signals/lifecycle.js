/** Token lifecycle labels — display-only, derived each poll tick. */
import { CFG } from './config.js';

export function deriveLifecycle(entry, currentMult, now = Date.now()) {
  const L = CFG.LIFECYCLE;
  const peak = Number(entry.peakMultiple) || 1;
  const ageH = (now - (entry.postedAt || now)) / 3600000;
  if (currentMult <= L.DEAD_MULT && ageH > L.DEAD_AGE_H) return 'dead';
  if (peak >= L.COOKING_MIN && currentMult <= peak * L.BLEED_FROM_PEAK) return 'bleeding';
  if (currentMult >= L.SENDING_MIN) return 'sending';
  if (currentMult >= L.COOKING_MIN) return 'cooking';
  return 'trenches';
}

export const LIFECYCLE_EMOJI = {
  trenches: '🌱',
  cooking: '🍳',
  sending: '🚀',
  bleeding: '🔻',
  dead: '💀',
};

export function lifecyclePrefix(entry) {
  const lc = entry?.lifecycle;
  const em = lc ? LIFECYCLE_EMOJI[lc] : '';
  return em ? em + ' ' : '';
}
