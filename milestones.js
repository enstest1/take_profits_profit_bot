/**
 * Take-profit milestone ladder — tier id N fires at (N+1)× call price; card label is Nx.
 * Tier 1 = 2×, tier 100 = 101× (label "100x").
 */
export const MAX_MILESTONE_TIER = 100;

/** Normalize legacy milestonesFired (stored price gates 2,5,10,20) to tier ids 1–MAX. */
export function normalizeTakeProfitTiers(fired) {
  const max = MAX_MILESTONE_TIER;
  if (!Array.isArray(fired) || fired.length === 0) return [];
  const legacySparse = new Set([2, 5, 10, 20]);
  if (fired.includes(1) || fired.some((x) => x > max)) {
    return [...new Set(fired.filter((x) => x >= 1 && x <= max))].sort((a, b) => a - b);
  }
  if (fired.every((x) => legacySparse.has(x))) {
    return [...new Set(fired.map((x) => x - 1))].filter((t) => t >= 1 && t <= max).sort((a, b) => a - b);
  }
  if (fired.every((x) => x >= 1 && x <= max)) {
    return [...new Set(fired)].sort((a, b) => a - b);
  }
  return [...new Set(fired.map((x) => (x >= 2 ? x - 1 : x)))]
    .filter((t) => t >= 1 && t <= max)
    .sort((a, b) => a - b);
}
