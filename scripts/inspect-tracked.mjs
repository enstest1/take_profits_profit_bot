/**
 * Read-only health report for tracked.json (local /data or project root).
 * Usage: node scripts/inspect-tracked.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAlertSilenceStatus, COMEBACK_STATE_FILE } from '../alertGate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '..');
const DB_PATH = path.join(DATA_DIR, 'tracked.json');
const BOOTSTRAP_FILE = path.join(DATA_DIR, '.tp_milestone_bootstrap_v2');

function normalizeMilestones(fired) {
  if (!Array.isArray(fired) || fired.length === 0) return [];
  if (fired.every((x) => x >= 1 && x <= 20)) return fired;
  return fired.filter((x) => x >= 1 && x <= 20);
}

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('No tracked.json at ' + DB_PATH);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function fmtMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

export function inspectTrackedJson(dbPath = DB_PATH) {
  const raw = fs.readFileSync(dbPath, 'utf8');
  const db = JSON.parse(raw);
  const tokens = Object.values(db.tokens || {});
  const now = Date.now();

  let emptyMilestones = 0;
  let emptyMilestonesPeak2Plus = 0;
  let peak2PlusAny = 0;
  let staleLastChecked7d = 0;
  let inactive72h = 0;
  const riskSamples = [];

  for (const entry of tokens) {
    const ms = normalizeMilestones(entry.milestonesFired);
    const peak = Number(entry.peakMultiple) || 1;
    const postedAt = Number(entry.postedAt) || 0;
    const peakAt = Number(entry.peakAt) || postedAt || 0;
    const lastChecked = Number(entry.lastChecked) || 0;

    if (ms.length === 0) emptyMilestones += 1;
    if (peak >= 2) peak2PlusAny += 1;
    if (ms.length === 0 && peak >= 2) {
      emptyMilestonesPeak2Plus += 1;
      if (riskSamples.length < 8) {
        riskSamples.push({
          symbol: entry.symbol || '?',
          peak: peak.toFixed(2),
          milestones: ms.length,
        });
      }
    }
    if (lastChecked && now - lastChecked > 7 * 24 * 60 * 60 * 1000) staleLastChecked7d += 1;
    if (postedAt && now - postedAt > 72 * 60 * 60 * 1000 && now - peakAt > 72 * 60 * 60 * 1000) {
      inactive72h += 1;
    }
  }

  const fileStat = fs.statSync(dbPath);
  const silence = getAlertSilenceStatus();

  return {
    dataDir: path.dirname(dbPath),
    dbPath,
    dbSize: fmtMb(fileStat.size),
    tokenCount: tokens.length,
    walletCount: Object.keys(db.wallets || {}).length,
    emptyMilestones,
    emptyMilestonesPeak2Plus,
    peak2PlusAny,
    staleLastChecked7d,
    inactive72h,
    riskSamples,
    bootstrapMarkerExists: fs.existsSync(BOOTSTRAP_FILE),
    comebackFileExists: fs.existsSync(COMEBACK_STATE_FILE),
    silence,
    redeployRisk:
      emptyMilestonesPeak2Plus === 0
        ? 'LOW — milestone state looks mostly intact'
        : emptyMilestonesPeak2Plus <= 20
          ? 'MEDIUM — up to ' + emptyMilestonesPeak2Plus + ' tokens may ping once on wake'
          : 'HIGH — ' + emptyMilestonesPeak2Plus + ' tokens may each fire one 🎯 alert without silence',
  };
}

export function printInspectReport(report) {
  console.log('');
  console.log('=== Take Profits — tracked.json inspect ===');
  console.log('Data dir:     ' + report.dataDir);
  console.log('DB path:      ' + report.dbPath);
  console.log('DB size:      ' + report.dbSize);
  console.log('Tokens:       ' + report.tokenCount);
  console.log('Wallets:      ' + report.walletCount);
  console.log('');
  console.log('--- Redeploy risk ---');
  console.log('Risk level:   ' + report.redeployRisk);
  console.log('Empty milestonesFired:              ' + report.emptyMilestones);
  console.log('Empty milestones + peak >= 2x:      ' + report.emptyMilestonesPeak2Plus + '  (max 🎯 pings if alerts on)');
  console.log('Any peak >= 2x:                     ' + report.peak2PlusAny);
  console.log('Last checked > 7d ago:              ' + report.staleLastChecked7d);
  console.log('Inactive 72h (no ATH, old call):    ' + report.inactive72h);
  if (report.riskSamples.length) {
    console.log('Sample at-risk: ' + report.riskSamples.map((s) => s.symbol + '@' + s.peak + 'x').join(', '));
  }
  console.log('');
  console.log('--- Volume markers ---');
  console.log('Bootstrap file (.tp_milestone_bootstrap_v2): ' + (report.bootstrapMarkerExists ? 'exists' : 'missing'));
  console.log('Comeback file (.tp_comeback_cycles):        ' + (report.comebackFileExists ? 'exists' : 'missing'));
  console.log('');
  console.log('--- Alert gate ---');
  if (report.silence.silenced) {
    console.log('Alerts:       SILENCED (' + report.silence.reason + ')');
    if (report.silence.remaining != null) {
      console.log('Remaining silent poll cycles: ' + report.silence.remaining);
    }
  } else {
    console.log('Alerts:       LIVE');
  }
  console.log('');
  console.log('Recommendation:');
  if (report.emptyMilestonesPeak2Plus > 0 || report.staleLastChecked7d > report.tokenCount * 0.5) {
    console.log('  Set COMEBACK_SILENCE_CYCLES=3 (or MAINTENANCE_MODE=1) on deploy, then remove after logs look clean.');
  } else {
    console.log('  Safe to deploy; optional COMEBACK_SILENCE_CYCLES=1 as extra safety.');
  }
  console.log('==========================================');
  console.log('');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  printInspectReport(inspectTrackedJson());
}
