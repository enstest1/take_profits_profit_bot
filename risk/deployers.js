/** Deployer launch memory — local DB index, no external API. */
export function ensureDeployersDb(db) {
  db.deployers = db.deployers || {};
  return db.deployers;
}

export function indexDeployer(db, devWallet, mint) {
  if (!devWallet || !mint) return;
  const d = ensureDeployersDb(db);
  const rec = d[devWallet] = d[devWallet] || { launches: [], updatedAt: 0 };
  if (!rec.launches.includes(mint)) rec.launches.push(mint);
  rec.updatedAt = Date.now();
}

export function deployerHistoryLine(db, devWallet, currentMint) {
  const launches = (db.deployers?.[devWallet]?.launches || []).filter((m) => m !== currentMint);
  if (launches.length === 0) return '';
  const entries = launches.map((m) => db.tokens[m] || db.archived?.[m]).filter(Boolean);
  if (!entries.length) return '';
  const rugs = entries.filter((e) => (Number(e.peakMultiple) || 1) < 0.5).length;
  const best = Math.max(1, ...entries.map((e) => Number(e.peakMultiple) || 1));
  if (rugs >= 2 && rugs === entries.length) {
    return '☠️ Deployer: ' + entries.length + ' prior launches, ALL dead (<0.5x)';
  }
  return '📜 Deployer: ' + entries.length + ' prior — ' + rugs + ' rugged · best ' + best.toFixed(1) + 'x';
}
