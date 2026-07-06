import { runLiveAudit } from './checks/runChecks.js';
import { loadLegacyEvmKeys, loadFrozenBrokenKeys } from './shadowStore.js';

/**
 * Run Layer-1 checks on live DB for /audit slash command.
 * @returns {{ issues: Array, ok: boolean }}
 */
export function auditDatabase(db, statusBroken = 0) {
  const issues = [];
  const legacyFrozen = loadLegacyEvmKeys();
  const frozenBroken = loadFrozenBrokenKeys();

  const raise = (checkId, severity, mint, message, diff) => {
    issues.push({ checkId, severity, mint: mint || 'global', message, diff });
  };

  runLiveAudit(db, raise, { legacyFrozen, frozenBroken, statusBroken, prevBroken: statusBroken });

  const critical = issues.filter((i) => i.severity === 'CRITICAL');
  return { issues, ok: critical.length === 0, criticalCount: critical.length, warnCount: issues.length - critical.length };
}

export function formatAuditTable(result) {
  if (!result.issues.length) return '✅ **Audit green** — no issues found.';
  const lines = result.issues.slice(0, 25).map((i) => {
    const icon = i.severity === 'CRITICAL' ? '🔴' : '🟡';
    return icon + ' `' + i.checkId + '` **' + i.mint + '** — ' + i.message;
  });
  let header = (result.ok ? '🟡' : '🔴') + ' **Audit** — ' + result.criticalCount + ' critical, ' + result.warnCount + ' warn\n';
  if (result.issues.length > 25) header += '_(' + (result.issues.length - 25) + ' more omitted)_\n';
  return header + lines.join('\n');
}
