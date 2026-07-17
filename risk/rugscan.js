/** RugCheck scan on auto-track — non-blocking; edits embed after send. */
import { EmbedBuilder } from 'discord.js';
import { rateLimiter } from '../rateLimiter.js';
import { CFG } from '../signals/config.js';
import { saveDB } from '../dbStore.js';

export async function fetchRugCheckRaw(mint) {
  const headers = {};
  if (process.env.RUGCHECK_API_KEY) {
    headers.Authorization = 'Bearer ' + process.env.RUGCHECK_API_KEY;
  }
  const res = await rateLimiter.fetch(
    'https://api.rugcheck.xyz/v1/tokens/' + mint + '/report',
    { headers, signal: AbortSignal.timeout(CFG.RUGSCAN_TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  return res.json();
}

export function parseRugScan(rug) {
  if (!rug) return null;
  const top10 = (rug.topHolders || []).slice(0, 10);
  const top10Pct = top10.reduce((s, h) => s + Number(h?.pct || h?.percentage || 0), 0);
  const mintAuthRevoked = !rug.mintAuthority;
  const freezeAuthRevoked = !rug.freezeAuthority;
  const lpProviders = Number(rug.totalLPProviders || 0);
  const lpLockedOrBurned = lpProviders > 0 && (rug.lockers || []).length > 0;

  let score = 'ok';
  if (!mintAuthRevoked || !freezeAuthRevoked || top10Pct > 60) score = 'danger';
  else if (top10Pct > 40 || !lpLockedOrBurned) score = 'warn';

  return {
    mintAuthRevoked,
    freezeAuthRevoked,
    top10Pct: Math.round(top10Pct * 10) / 10,
    lpLockedOrBurned,
    score,
    scannedAt: Date.now(),
  };
}

export function rugScanLine(scan) {
  if (!scan) return '';
  if (scan.score === 'danger') {
    const parts = [];
    if (!scan.mintAuthRevoked) parts.push('mint authority ACTIVE');
    else if (!scan.freezeAuthRevoked) parts.push('freeze authority ACTIVE');
    else parts.push('top10 ' + scan.top10Pct + '%');
    return '🛡️ Risk: ☠️ DANGER — ' + parts.join(' · ');
  }
  if (scan.score === 'warn') {
    return '🛡️ Risk: ⚠️ WARN — top10 ' + scan.top10Pct + '% · LP ' +
      (scan.lpLockedOrBurned ? 'locked' : 'not locked');
  }
  return '🛡️ Risk: OK — mint/freeze revoked · top10 ' + scan.top10Pct + '% · LP ' +
    (scan.lpLockedOrBurned ? 'locked' : 'unverified');
}

export async function scanOnTrack(_client, db, mint, entry, sentMsg) {
  if (!mint || (entry.chain || 'solana') !== 'solana') return;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) && !mint.includes(':')) {
    const parsed = mint;
    if (parsed.includes(':')) return;
  }
  const scanMint = mint.includes(':') ? entry.address : mint;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(scanMint)) return;

  try {
    const rug = await fetchRugCheckRaw(scanMint);
    if (!rug) {
      entry.rugScan = null;
      return;
    }
    const scan = parseRugScan(rug);
    entry.rugScan = scan;
    saveDB(db);

    if (!sentMsg?.editable) return;
    const line = rugScanLine(scan);
    const prev = sentMsg.embeds?.[0];
    if (!prev) return;
    const desc = (prev.description || '') + '\n' + line;
    const embed = EmbedBuilder.from(prev).setDescription(desc.slice(0, 4096));
    await sentMsg.edit({ embeds: [embed] }).catch((e) =>
      console.error('[rugscan] embed edit:', e.message),
    );
  } catch (e) {
    entry.rugScan = null;
    console.error('[rugscan] non-fatal:', e.message);
  }
}
